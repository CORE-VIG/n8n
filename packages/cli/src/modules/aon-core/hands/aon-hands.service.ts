import { createFilesystem, createSandbox } from '@n8n/agents/sandbox';
import { GlobalConfig } from '@n8n/config';
import type { User } from '@n8n/db';
import { Service } from '@n8n/di';
import { UnexpectedError, UserError } from 'n8n-workflow';
import { createHash } from 'node:crypto';

import { SandboxSettingsService } from '@/services/sandbox-settings.service';

type HandsSandbox = NonNullable<Awaited<ReturnType<typeof createSandbox>>>;
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
		this.configCache = { at: Date.now(), ...resolved };
		return this.configCache;
	}

	async isConfigured(): Promise<boolean> {
		return Boolean((await this.config()).serviceUrl);
	}

	async workspace(user: User, rawSlug: string | undefined): Promise<HandsWorkspace> {
		const slug = normalizeWorkspaceSlug(rawSlug);
		const id = AonHandsService.workspaceId(user.id, slug);
		let pending = this.workspaces.get(id);
		if (!pending) {
			pending = this.open(id, slug).catch((error: unknown) => {
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
}
