import { GlobalConfig } from '@n8n/config';
import { Service } from '@n8n/di';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';

/** One line of what happened, for the caller to log to the run's live event feed. */
export interface AonRunnerEvent {
	type: 'text' | 'tool' | 'cost';
	name?: string;
	status?: string;
	text?: string;
}

export interface AonRunnerOptions {
	prompt: string;
	systemPrompt: string;
	model: string;
	/** Bare tool names, e.g. "hands_run"; sent to the CLI as "mcp__n8n__hands_run". */
	allowedTools: string[];
	/** Omit `--mcp-config` (and MCP entirely) when null. */
	mcpConfigPath: string | null;
	resumeSessionId?: string;
	maxTurns?: number;
	timeoutMs: number;
	signal: AbortSignal;
	onEvent: (ev: AonRunnerEvent) => void;
}

export interface AonRunnerResult {
	text: string;
	sessionId: string | null;
	costUsd: number;
	usage: { inputTokens: number; outputTokens: number };
	isError: boolean;
	error: string | null;
	/** Every tool this turn called, bare names, in the order first seen. */
	toolNames: string[];
}

const KILL_GRACE_MS = 5_000;
const TEXT_FLUSH_CHARS = 400;

function bareToolName(name: string): string {
	return name.replace(/^mcp__n8n__/, '');
}

/**
 * Runs one Aon agent's maker or judge turn through `claude -p`, the same
 * shape of child the assistant spawns in `AonTalkService`, but for a run
 * rather than a chat turn: no session store, no thread, just one prompt in
 * and one verdict out (or resumed once, when the owner approves a card).
 */
@Service()
export class AonRunnerService {
	constructor(private readonly config: GlobalConfig) {}

	private argv(opts: AonRunnerOptions): string[] {
		const args = [
			'-p',
			opts.prompt,
			'--output-format',
			'stream-json',
			'--verbose',
			'--include-partial-messages',
			'--model',
			opts.model,
		];
		if (opts.mcpConfigPath) {
			args.push('--mcp-config', opts.mcpConfigPath, '--strict-mcp-config');
		}
		if (opts.allowedTools.length > 0) {
			const mcpNames = opts.allowedTools.map((name) => `mcp__n8n__${name}`);
			args.push('--allowedTools', [...mcpNames, 'Skill'].join(','));
		}
		args.push(
			'--append-system-prompt',
			opts.systemPrompt,
			'--permission-mode',
			'default',
			'--setting-sources',
			'user',
			'--tools',
			'Skill',
			'--disable-slash-commands',
		);
		if (opts.maxTurns) args.push('--max-turns', String(opts.maxTurns));
		if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
		return args;
	}

	/** No API key reaches the child: it authenticates as the owner's subscription seat. */
	private childEnv(): NodeJS.ProcessEnv {
		const token = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
		return {
			HOME: path.dirname(this.config.aon.claudeHome),
			PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
			LANG: process.env.LANG ?? 'C.UTF-8',
			DISABLE_AUTOUPDATER: '1',
			...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}),
		};
	}

	run(opts: AonRunnerOptions): Promise<AonRunnerResult> {
		const { claudeBin, claudeHome } = this.config.aon;
		return new Promise((resolve) => {
			let child: ChildProcess;
			try {
				child = spawn(claudeBin, this.argv(opts), {
					cwd: path.dirname(claudeHome),
					env: this.childEnv(),
					stdio: ['ignore', 'pipe', 'pipe'],
				});
			} catch (e) {
				resolve({
					text: '',
					sessionId: null,
					costUsd: 0,
					usage: { inputTokens: 0, outputTokens: 0 },
					isError: true,
					error: `could not start claude: ${e instanceof Error ? e.message : String(e)}`,
					toolNames: [],
				});
				return;
			}

			let sessionId: string | null = null;
			let costUsd = 0;
			let usage = { inputTokens: 0, outputTokens: 0 };
			let resultText = '';
			let textBuffer = '';
			let isError = false;
			let error: string | null = null;
			let stderr = '';
			let finished = false;
			let killed = false;
			let killTimer: NodeJS.Timeout | undefined;
			const toolCallNames = new Map<string, string>();
			const toolNamesSeen = new Set<string>();
			const toolNames: string[] = [];

			const flushText = () => {
				if (!textBuffer) return;
				opts.onEvent({ type: 'text', text: textBuffer });
				textBuffer = '';
			};

			const finish = () => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				clearTimeout(killTimer);
				opts.signal.removeEventListener('abort', onAbort);
				flushText();
				resolve({ text: resultText, sessionId, costUsd, usage, isError, error, toolNames });
			};

			const kill = () => {
				if (killed) return;
				killed = true;
				try {
					child.kill('SIGTERM');
				} catch {
					// Already dead.
				}
				killTimer = setTimeout(() => {
					try {
						child.kill('SIGKILL');
					} catch {
						// Already dead.
					}
				}, KILL_GRACE_MS);
			};

			const onAbort = () => kill();
			const timer = setTimeout(() => {
				isError = true;
				error = `claude took longer than ${Math.round(opts.timeoutMs / 60_000)} minutes and was stopped`;
				kill();
			}, opts.timeoutMs);
			opts.signal.addEventListener('abort', onAbort, { once: true });

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
				const kind = ev.type;

				if (kind === 'system' && ev.subtype === 'init') {
					if (typeof ev.session_id === 'string') sessionId = ev.session_id;
					return;
				}

				if (kind === 'stream_event') {
					const e = ev.event as Record<string, unknown> | undefined;
					const delta = e?.delta as Record<string, unknown> | undefined;
					if (e?.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
						resultText += delta.text;
						textBuffer += delta.text;
						if (textBuffer.length >= TEXT_FLUSH_CHARS) flushText();
					}
					return;
				}

				if (kind === 'assistant') {
					const msg = ev.message as { content?: unknown[] } | undefined;
					for (const block of msg?.content ?? []) {
						const b = block as Record<string, unknown>;
						if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
							const bare = bareToolName(b.name);
							toolCallNames.set(b.id, bare);
							if (!toolNamesSeen.has(bare)) {
								toolNamesSeen.add(bare);
								toolNames.push(bare);
							}
							opts.onEvent({ type: 'tool', name: bare, status: 'start' });
						}
					}
					return;
				}

				if (kind === 'user') {
					const msg = ev.message as { content?: unknown[] } | undefined;
					for (const block of msg?.content ?? []) {
						const b = block as Record<string, unknown>;
						if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
						const name = toolCallNames.get(b.tool_use_id) ?? 'tool';
						opts.onEvent({ type: 'tool', name, status: b.is_error ? 'error' : 'ok' });
					}
					return;
				}

				if (kind === 'result') {
					if (typeof ev.total_cost_usd === 'number') {
						costUsd = ev.total_cost_usd;
						opts.onEvent({ type: 'cost', text: String(costUsd) });
					}
					const u = ev.usage as Record<string, unknown> | undefined;
					if (u) {
						usage = {
							inputTokens: typeof u.input_tokens === 'number' ? u.input_tokens : 0,
							outputTokens: typeof u.output_tokens === 'number' ? u.output_tokens : 0,
						};
					}
					if (ev.is_error) {
						isError = true;
						error = String(ev.result ?? ev.subtype ?? 'claude failed').slice(0, 500);
					}
				}
			});

			child.on('error', (e) => {
				isError = true;
				error = `claude could not run: ${e.message}`;
				finish();
			});
			child.on('close', (code) => {
				if (!isError && code !== 0 && !opts.signal.aborted) {
					const tail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400);
					isError = true;
					error = `claude exited with code ${code}${tail ? `: ${tail}` : ''}`;
				} else if (killed && !isError) {
					isError = true;
					error = 'claude was stopped';
				}
				finish();
			});
		});
	}
}
