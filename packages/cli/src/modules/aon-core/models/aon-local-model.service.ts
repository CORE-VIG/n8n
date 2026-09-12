import { Logger } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import { Service } from '@n8n/di';

/** No local generation runs concurrently with another: the host has 8 CPUs and no GPU. */
const CHAT_TIMEOUT_MS = 120_000;
const TAGS_TIMEOUT_MS = 5_000;
/** How long a tags probe (used by both `available()` and `listModels()`) is trusted before it is asked again. */
const TAGS_CACHE_MS = 60_000;
/** A prompt longer than this leaves the model no room to answer, on an 8-CPU box with no GPU. */
const MAX_USER_CHARS = 6_000;

/** The model background jobs use when nothing in settings says otherwise. */
export const DEFAULT_LOCAL_MODEL = 'qwen3:4b';

export interface AonLocalChatInput {
	system: string;
	user: string;
	/** Ask the model to answer as JSON: sets Ollama's `format: "json"`, on top of `think: false`. */
	json?: boolean;
	/** Defaults to {@link DEFAULT_LOCAL_MODEL}. Callers that want the owner's pick read `aon.localModel` from settings and pass it in. */
	model?: string;
	maxTokens?: number;
}

export interface AonLocalChatResult {
	text: string;
	ms: number;
	model: string;
}

/** Ollama did not answer, or refused: never a reason to fall back to a paid model on its own. */
export class LocalModelUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'LocalModelUnavailable';
	}
}

function isString(value: unknown): value is string {
	return typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/** `catch` hands us `unknown`; this narrows without a cast. */
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Background jobs' model until a paid budget above zero says otherwise: one
 * chat turn against the Ollama server named by `AON_OLLAMA_URL`. The host
 * has no GPU, so at most one generation runs at a time, queued rather than
 * run in parallel — the embed server (`AonEmbedService`, same host) must
 * never be starved by a pile of background turns.
 */
@Service()
export class AonLocalModelService {
	/** The tail of the queue: every call awaits this, then becomes the new tail. Never rejects, so a failed call never wedges the next one. */
	private tail: Promise<void> = Promise.resolve();
	private tagsCache: { at: number; names: string[] } | null = null;

	constructor(
		private readonly globalConfig: GlobalConfig,
		private readonly logger: Logger,
	) {}

	private get baseUrl(): string {
		return this.globalConfig.aon.ollamaUrl.replace(/\/+$/, '');
	}

	get enabled(): boolean {
		return this.globalConfig.aon.ollamaUrl.trim() !== '';
	}

	/** Whether Ollama answers at all right now. Cached with `listModels()`, so the two never disagree within the same minute. */
	async available(): Promise<boolean> {
		return (await this.listModels()).length > 0;
	}

	/** Every chat model Ollama reports, embedding models (`bge-*`) excluded. Cached for a minute. */
	async listModels(): Promise<string[]> {
		if (!this.enabled) return [];
		const now = Date.now();
		if (this.tagsCache && now - this.tagsCache.at < TAGS_CACHE_MS) return this.tagsCache.names;
		let names: string[] = [];
		try {
			const response = await fetch(`${this.baseUrl}/api/tags`, {
				signal: AbortSignal.timeout(TAGS_TIMEOUT_MS),
			});
			if (response.ok) {
				const data: unknown = await response.json();
				const models = isRecord(data) && Array.isArray(data.models) ? data.models : [];
				names = models
					.map((m) => (isRecord(m) ? m.name : undefined))
					.filter(isString)
					.filter((name) => !name.startsWith('bge-'));
			}
		} catch (error) {
			this.logger.debug(`Aon local model: could not list Ollama models: ${errorMessage(error)}`);
			names = [];
		}
		this.tagsCache = { at: now, names };
		return names;
	}

	/**
	 * One chat turn, queued behind whatever local generation is already
	 * running. Throws {@link LocalModelUnavailableError} rather than ever
	 * returning something that looks like a model's answer.
	 */
	async chat(input: AonLocalChatInput): Promise<AonLocalChatResult> {
		const runPromise = this.tail.then(async () => await this.runChat(input));
		this.tail = runPromise.then(
			() => undefined,
			() => undefined,
		);
		return await runPromise;
	}

	private async runChat(input: AonLocalChatInput): Promise<AonLocalChatResult> {
		if (!this.enabled) throw new LocalModelUnavailableError('AON_OLLAMA_URL is not set');
		const model = input.model?.trim() || DEFAULT_LOCAL_MODEL;
		const user = input.user.length > MAX_USER_CHARS ? input.user.slice(0, MAX_USER_CHARS) : input.user;
		const started = Date.now();
		let response: Response;
		try {
			response = await fetch(`${this.baseUrl}/api/chat`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					model,
					messages: [
						{ role: 'system', content: input.system },
						{ role: 'user', content: user },
					],
					stream: false,
					think: false,
					...(input.json ? { format: 'json' } : {}),
					options: { num_predict: input.maxTokens ?? 800, temperature: 0.2 },
				}),
				signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
			});
		} catch (error) {
			throw new LocalModelUnavailableError(`could not reach ${model}: ${errorMessage(error)}`);
		}
		if (!response.ok) {
			throw new LocalModelUnavailableError(`${model} answered ${response.status}`);
		}
		const data: unknown = await response.json();
		const message = isRecord(data) ? data.message : undefined;
		const content = isRecord(message) ? message.content : undefined;
		const text = isString(content) ? content : '';
		const ms = Date.now() - started;
		this.logger.debug(`Aon local model: ${model} answered in ${ms}ms (${text.length} chars)`);
		return { text, ms, model };
	}
}
