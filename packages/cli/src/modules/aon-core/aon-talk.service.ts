import { Logger } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import type { User } from '@n8n/db';
import { Service } from '@n8n/di';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { McpServerApiKeyService } from '@/modules/mcp/mcp-api-key.service';
import { McpSettingsService } from '@/modules/mcp/mcp.settings.service';

export type Frame = Record<string, unknown>;
export type Write = (frame: Frame) => void;

type Session = { claudeSessionId: string | null; busy: boolean; userId: string };

/** The assistant's standing instructions. Short, because every turn carries them. */
const SYSTEM_PROMPT = `You are Aon, the assistant inside this n8n instance, which belongs to the person talking to you. Speak as a colleague: short sentences, plain words, no bullet lists unless asked, never a menu of things you could do.

FINISH WHAT HE ASKS FOR. If he asks for a workflow, build it: call get_workflow_sdk_reference first, write the workflow code, validate_workflow_code, then create_workflow_from_code. What you create is a DRAFT until he says publish; never say it is running when it is a draft. When he asks to test it, call prepare_workflow_pin_data, fill in realistic sample data, run test_workflow, and read back what each node produced. Call publish_workflow only when he says publish. Call execute_workflow with executionMode "production" only when he explicitly asks to run it for real; "manual" is for trying it. When he asks to change a workflow, read it with get_workflow_details, then update_workflow.

When you have created or changed a workflow, say its name and that it is open beside this chat. Ask at most one question, and only when the request is genuinely ambiguous; otherwise pick a sensible default, do it, and say what you chose. Never invent what a tool returned; read it back from the tool. If something failed, say what and why in one sentence.

Aon's own agents, memory and Guard are being moved into this instance and are not here yet; if he asks for an Aon agent, say so in one clause and offer a workflow that does the job, or n8n's own Agents page for a native agent.`;

/**
 * The assistant: one Claude Code session per chat, on the owner's subscription,
 * holding this instance's own MCP tools and nothing else.
 *
 * One process per turn, resumed by session id, rather than a warm child: a
 * cold start costs two seconds and buys a runner with no state to corrupt.
 * The daemon that came before kept a warm child and paid for it in restart
 * logic; here n8n restarts are the norm, so the session lives in the CLI's
 * own store on a volume and every turn simply resumes it.
 */
@Service()
export class AonTalkService {
	private readonly sessions = new Map<string, Session>();

	constructor(
		private readonly config: GlobalConfig,
		private readonly logger: Logger,
		private readonly mcpApiKeys: McpServerApiKeyService,
		private readonly mcpSettings: McpSettingsService,
	) {}

	async init() {
		const { claudeHome } = this.config.aon;
		await mkdir(claudeHome, { recursive: true });
		// The assistant is only useful with the instance's tools, and those
		// only exist when MCP access is on. Turn it on rather than document it.
		if (!(await this.mcpSettings.getEnabled())) {
			await this.mcpSettings.setEnabled(true);
			this.logger.info('[aon] enabled MCP access for the assistant');
		}
	}

	sessionCount() {
		return this.sessions.size;
	}

	private key(user: User, sessionId: string) {
		return `${user.id}:${sessionId}`;
	}

	/** The MCP config the child reads: this instance, the owner's own key. */
	private async writeMcpConfig(user: User): Promise<string> {
		const key = await this.mcpApiKeys.getOrCreateApiKey(user);
		const file = path.join(this.config.aon.claudeHome, `aon-mcp-${user.id}.json`);
		const body = {
			mcpServers: {
				n8n: { type: 'http', url: this.config.aon.mcpUrl, headers: { Authorization: `Bearer ${key.apiKey}` } },
			},
		};
		await writeFile(file, JSON.stringify(body), { mode: 0o600 });
		await chmod(file, 0o600);
		return file;
	}

	private argv(text: string, mcpConfig: string, resume: string | null): string[] {
		const args = [
			'-p', text,
			'--output-format', 'stream-json', '--verbose', '--include-partial-messages',
			'--model', this.config.aon.talkModel,
			'--mcp-config', mcpConfig, '--strict-mcp-config',
			'--allowedTools', 'mcp__n8n__*',
			'--append-system-prompt', SYSTEM_PROMPT,
			'--permission-mode', 'default',
			'--setting-sources', '',
			'--tools', '',
			'--disable-slash-commands',
		];
		if (resume) args.push('--resume', resume);
		return args;
	}

	private childEnv(): NodeJS.ProcessEnv {
		// No API key reaches the child on purpose: it authenticates as the
		// subscription seat from its own home, exactly as the old daemon did.
		return {
			// claudeHome is the `.claude` directory; the CLI wants HOME to be its
			// parent and finds `.claude/` and `.claude.json` under it itself.
			HOME: path.dirname(this.config.aon.claudeHome),
			PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
			LANG: process.env.LANG ?? 'C.UTF-8',
			DISABLE_AUTOUPDATER: '1',
		};
	}

	async turn(
		input: { user: User; sessionId: string; text: string; reset: boolean },
		write: Write,
		signal: AbortSignal,
	): Promise<void> {
		const k = this.key(input.user, input.sessionId);
		let session = this.sessions.get(k);
		if (!session) {
			session = { claudeSessionId: null, busy: false, userId: input.user.id };
			this.sessions.set(k, session);
		}
		if (input.reset) session.claudeSessionId = null;
		if (session.busy) {
			write({ type: 'error', message: 'Still answering the last message. Wait for it, or stop it.' });
			return;
		}
		session.busy = true;
		const started = Date.now();
		try {
			const mcpConfig = await this.writeMcpConfig(input.user);
			await this.run(session, input.text, mcpConfig, write, signal);
		} finally {
			session.busy = false;
			write({ type: 'done', ms: Date.now() - started });
		}
	}

	private run(session: Session, text: string, mcpConfig: string, write: Write, signal: AbortSignal): Promise<void> {
		const { claudeBin, claudeHome, talkTimeoutMs } = this.config.aon;
		return new Promise((resolve) => {
			let child: ChildProcess;
			try {
				child = spawn(claudeBin, this.argv(text, mcpConfig, session.claudeSessionId), {
					cwd: path.dirname(claudeHome),
					env: this.childEnv(),
					stdio: ['ignore', 'pipe', 'pipe'],
				});
			} catch (e) {
				write({ type: 'error', message: `could not start the assistant: ${e instanceof Error ? e.message : String(e)}` });
				resolve();
				return;
			}

			const toolNames = new Map<string, string>();
			let stderr = '';
			let sawText = false;
			let finished = false;

			const finish = () => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				signal.removeEventListener('abort', onAbort);
				resolve();
			};
			const onAbort = () => {
				child.kill('SIGTERM');
				finish();
			};
			const timer = setTimeout(() => {
				write({ type: 'error', message: `the assistant took longer than ${Math.round(talkTimeoutMs / 60_000)} minutes and was stopped` });
				child.kill('SIGTERM');
			}, talkTimeoutMs);
			signal.addEventListener('abort', onAbort, { once: true });

			child.stderr?.on('data', (d: Buffer) => {
				stderr = (stderr + d.toString('utf8')).slice(-2000);
			});

			const rl = createInterface({ input: child.stdout! });
			rl.on('line', (line) => {
				if (!line.trim()) return;
				let ev: Record<string, unknown>;
				try {
					ev = JSON.parse(line) as Record<string, unknown>;
				} catch {
					return;
				}
				this.dispatch(ev, session, toolNames, write, () => {
					sawText = true;
				});
			});

			child.on('error', (e) => {
				write({ type: 'error', message: `the assistant could not run: ${e.message}` });
				finish();
			});
			child.on('close', (code) => {
				if (code !== 0 && !signal.aborted) {
					const tail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400);
					write({ type: 'error', message: `the assistant exited with code ${code}${tail ? `: ${tail}` : ''}` });
				} else if (!sawText && !signal.aborted) {
					write({ type: 'error', message: 'the assistant returned nothing' });
				}
				finish();
			});
		});
	}

	/** One stream-json event from the CLI, turned into what the window shows. */
	private dispatch(
		ev: Record<string, unknown>,
		session: Session,
		toolNames: Map<string, string>,
		write: Write,
		onText: () => void,
	) {
		const kind = ev.type;
		if (kind === 'system' && ev.subtype === 'init') {
			if (typeof ev.session_id === 'string') session.claudeSessionId = ev.session_id;
			write({ type: 'session', id: session.claudeSessionId });
			return;
		}
		if (kind === 'stream_event') {
			const e = ev.event as Record<string, unknown> | undefined;
			const delta = e?.delta as Record<string, unknown> | undefined;
			if (e?.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
				onText();
				write({ type: 'text', delta: delta.text });
			}
			return;
		}
		if (kind === 'assistant') {
			const msg = ev.message as { content?: unknown[] } | undefined;
			for (const block of msg?.content ?? []) {
				const b = block as Record<string, unknown>;
				if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
					toolNames.set(b.id, b.name);
					write({ type: 'tool', id: b.id, name: b.name, status: 'start' });
				}
			}
			return;
		}
		if (kind === 'user') {
			const msg = ev.message as { content?: unknown[] } | undefined;
			for (const block of msg?.content ?? []) {
				const b = block as Record<string, unknown>;
				if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
				const name = toolNames.get(b.tool_use_id) ?? 'tool';
				const text = resultText(b.content);
				write({ type: 'tool', id: b.tool_use_id, name, status: b.is_error ? 'error' : 'ok' });
				// The thing it made, so the window can open it.
				if (/create_workflow_from_code|update_workflow$/.test(name) && !b.is_error) {
					const m = /"(?:workflowId|id)"\s*:\s*"([A-Za-z0-9_-]{6,})"/.exec(text);
					if (m) write({ type: 'workflow', id: m[1] });
				}
			}
			return;
		}
		if (kind === 'result') {
			if (ev.is_error) write({ type: 'error', message: String(ev.result ?? ev.subtype ?? 'the assistant failed').slice(0, 500) });
			if (typeof ev.total_cost_usd === 'number') write({ type: 'cost', usd: ev.total_cost_usd, notional: true });
		}
	}
}

function resultText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content
			.map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
			.join('\n');
	}
	return '';
}
