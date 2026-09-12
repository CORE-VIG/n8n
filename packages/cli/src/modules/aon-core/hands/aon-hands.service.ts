import type {
	AonHandsRunRequest,
	AonHandsRunResult,
	AonWorkspaceFile,
	AonWorkspaceFileEntry,
	AonWorkspaceSummary,
} from '@n8n/api-types';
import { createFilesystem, createSandbox } from '@n8n/agents/sandbox';
import type { SandboxInfo } from '@n8n/agents/sandbox';
import { GlobalConfig } from '@n8n/config';
import type { User } from '@n8n/db';
import { Service } from '@n8n/di';
import { UnexpectedError, UserError } from 'n8n-workflow';
import { createHash } from 'node:crypto';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { SandboxSettingsService } from '@/services/sandbox-settings.service';

import {
	AonWorkspaceRepository,
	type AonWorkspaceRow,
} from '../database/repositories/aon-workspace.repository';

type HandsSandbox = NonNullable<Awaited<ReturnType<typeof createSandbox>>> & {
	/**
	 * Not part of `WorkspaceSandbox`, but every provider `createSandbox` can
	 * return (Daytona, the n8n sandbox service) implements it.
	 */
	getInfo?: () => Promise<SandboxInfo>;
};
type HandsFiles = NonNullable<ReturnType<typeof createFilesystem>>;

export interface HandsWorkspace {
	id: string;
	slug: string;
	sandbox: HandsSandbox;
	files: HandsFiles;
}

/** Where the sandbox keeps a workspace's files, as the sandbox sees it. */
export const HANDS_WORKSPACE_DIR = '/home/user/workspace';

const ID_NAMESPACE = 'aon-hands';
const CONFIG_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_S = 300;
const MAX_READ_BYTES = 256 * 1024;

/** The `remoteStatus`/`lastActiveAt` pair a workspace summary shows, when known. */
function sandboxStatusFields(info: SandboxInfo | undefined): {
	remoteStatus: string | null;
	lastActiveAt: string | null;
} {
	const metadata = info?.metadata;
	return {
		remoteStatus: typeof metadata?.remoteStatus === 'string' ? metadata.remoteStatus : null,
		lastActiveAt: typeof metadata?.lastActiveAt === 'string' ? metadata.lastActiveAt : null,
	};
}

/** A workspace name as typed by the model, made safe and stable. */
export function normalizeWorkspaceSlug(raw: string | undefined): string {
	const slug = (raw ?? '')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 64);
	return slug || 'main';
}

/**
 * The assistant's hands: sandboxes reached through n8n's own sandbox client, so
 * the same service (Aon Hands, a bubblewrap fence on the host) serves the Aon
 * assistant, n8n's native agents and n8n's AI Assistant alike. Nothing here runs
 * on the n8n host itself.
 *
 * A workspace is a named, persistent sandbox per user: "main" unless the task
 * deserves its own. Its id is derived from the name, so the same name opens the
 * same files after a restart, on another main, or in a new conversation.
 */
@Service()
export class AonHandsService {
	private readonly workspaces = new Map<string, Promise<HandsWorkspace>>();

	private configCache: { at: number; serviceUrl?: string; apiKey?: string } | null = null;

	constructor(
		private readonly sandboxSettings: SandboxSettingsService,
		private readonly globalConfig: GlobalConfig,
		private readonly workspaceRepo: AonWorkspaceRepository,
	) {}

	/** A lowercase UUID for a user's named workspace; the sandbox service accepts no other shape. */
	static workspaceId(userId: string, slug: string): string {
		const h = createHash('sha256').update(`${ID_NAMESPACE}:${userId}:${slug}`).digest('hex');
		const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
		return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
	}

	private async config() {
		if (this.configCache && Date.now() - this.configCache.at < CONFIG_TTL_MS) return this.configCache;
		const resolved = await this.sandboxSettings.resolveN8nSandboxConfig();
		const fresh = { at: Date.now(), ...resolved };
		this.configCache = fresh;
		return fresh;
	}

	async isConfigured(): Promise<boolean> {
		return Boolean((await this.config()).serviceUrl);
	}

	async workspace(user: User, rawSlug: string | undefined): Promise<HandsWorkspace> {
		const slug = normalizeWorkspaceSlug(rawSlug);
		const id = AonHandsService.workspaceId(user.id, slug);
		let pending = this.workspaces.get(id);
		if (!pending) {
			pending = this.open(id, slug)
				.then(async (opened) => {
					await this.workspaceRepo.touch({ id, userId: user.id, slug });
					return opened;
				})
				.catch((error: unknown) => {
					this.workspaces.delete(id);
					throw error;
				});
			this.workspaces.set(id, pending);
		}
		return await pending;
	}

	private async open(id: string, slug: string): Promise<HandsWorkspace> {
		const { serviceUrl, apiKey } = await this.config();
		if (!serviceUrl) {
			throw new UserError('No sandbox service is configured: set N8N_SANDBOX_SERVICE_URL.');
		}
		const sandbox = await createSandbox({
			enabled: true,
			provider: 'n8n-sandbox',
			serviceUrl,
			apiKey,
			id,
			timeout: this.globalConfig.instanceAi.sandboxTimeout,
		});
		if (!sandbox) throw new UnexpectedError('The sandbox provider returned no sandbox');
		await sandbox.start?.();
		return { id, slug, sandbox, files: createFilesystem(sandbox) };
	}

	/** Opens (creating on first use) a workspace and returns its summary. */
	async createWorkspace(user: User, rawSlug: string): Promise<AonWorkspaceSummary> {
		const ws = await this.workspace(user, rawSlug);
		return await this.describeOpened(user, ws);
	}

	/**
	 * Every workspace a user has, most recently used first. Only asks a
	 * sandbox for its live status when this process already has it open;
	 * listing must never itself open every workspace a user ever made.
	 */
	async listWorkspaces(user: User): Promise<AonWorkspaceSummary[]> {
		const rows = await this.workspaceRepo.listForUser(user.id);
		return await Promise.all(rows.map(async (row) => await this.toSummary(row)));
	}

	/** Destroys the remote sandbox and forgets the workspace ever existed. */
	async deleteWorkspace(user: User, slug: string): Promise<void> {
		const ws = await this.requireExisting(user, slug);
		await ws.sandbox.destroy?.();
		this.workspaces.delete(ws.id);
		await this.workspaceRepo.deleteById(ws.id);
	}

	/** Directories first, then files, both alphabetically. */
	async listFiles(user: User, slug: string, path?: string): Promise<AonWorkspaceFileEntry[]> {
		const ws = await this.requireExisting(user, slug);
		const entries = await ws.files.readdir(path ?? HANDS_WORKSPACE_DIR, { recursive: false });
		return entries
			.map((entry) => ({ name: entry.name, type: entry.type, size: entry.size ?? null }))
			.sort((a, b) => {
				if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
				return a.name.localeCompare(b.name);
			});
	}

	/** A text file's content, capped so a huge file cannot flood the response. */
	async readFile(user: User, slug: string, path: string): Promise<AonWorkspaceFile> {
		const ws = await this.requireExisting(user, slug);
		const raw = await ws.files.readFile(path, { encoding: 'utf8' });
		const text = typeof raw === 'string' ? raw : raw.toString('utf8');
		if (text.includes('\0')) {
			throw new BadRequestError(`"${path}" does not look like a text file.`);
		}
		const bytes = Buffer.from(text, 'utf8');
		const truncated = bytes.byteLength > MAX_READ_BYTES;
		return {
			path,
			text: truncated ? bytes.subarray(0, MAX_READ_BYTES).toString('utf8') : text,
			size: bytes.byteLength,
			truncated,
		};
	}

	/** Runs a command in the workspace, the same way the assistant's `hands_run` tool does. */
	async run(user: User, slug: string, req: AonHandsRunRequest): Promise<AonHandsRunResult> {
		const ws = await this.requireExisting(user, slug);
		if (!ws.sandbox.executeCommand) {
			throw new UnexpectedError('This sandbox cannot run commands');
		}
		const result = await ws.sandbox.executeCommand(req.command, [], {
			timeout: (req.timeoutSeconds ?? DEFAULT_TIMEOUT_S) * 1000,
			env: req.network ? { HANDS_NETWORK: '1' } : undefined,
		});
		return {
			exitCode: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr,
			executionTimeMs: result.executionTimeMs,
			timedOut: result.timedOut ?? false,
			killed: result.killed ?? false,
			success: result.success,
		};
	}

	/**
	 * Only the REST API's workspace-scoped calls go through here: a slug that
	 * was never opened (so never touched into `aon_workspaces`) is not a
	 * workspace to browse, run in or delete, even though `workspace()` itself
	 * would happily create one. Hands tools and agents keep using
	 * `workspace()` directly, since they are the ones allowed to create.
	 */
	private async requireExisting(user: User, rawSlug: string): Promise<HandsWorkspace> {
		const slug = normalizeWorkspaceSlug(rawSlug);
		const record = await this.workspaceRepo.findForUser(user.id, slug);
		if (!record) throw new NotFoundError(`There is no workspace called ${slug}.`);
		return await this.workspace(user, slug);
	}

	private async describeOpened(user: User, ws: HandsWorkspace): Promise<AonWorkspaceSummary> {
		const record = await this.workspaceRepo.findForUser(user.id, ws.slug);
		const info = await ws.sandbox.getInfo?.().catch(() => undefined);
		const now = new Date().toISOString();
		return {
			id: ws.id,
			slug: ws.slug,
			createdAt: record?.createdAt ?? now,
			lastUsedAt: record?.lastUsedAt ?? now,
			...sandboxStatusFields(info),
		};
	}

	/** A row's summary, enriched with live status only if its sandbox is already open. */
	private async toSummary(row: AonWorkspaceRow): Promise<AonWorkspaceSummary> {
		const base = { id: row.id, slug: row.slug, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt };
		const opened = this.workspaces.get(row.id);
		if (!opened) return { ...base, ...sandboxStatusFields(undefined) };
		try {
			const ws = await opened;
			const info = await ws.sandbox.getInfo?.();
			return { ...base, ...sandboxStatusFields(info) };
		} catch {
			return { ...base, ...sandboxStatusFields(undefined) };
		}
	}
}
