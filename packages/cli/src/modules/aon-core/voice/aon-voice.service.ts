import { Logger } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import { Service } from '@n8n/di';

const STT_TIMEOUT_MS = 60_000;
const TTS_TIMEOUT_MS = 60_000;
const MAX_TTS_TEXT_CHARS = 1500;
const MAX_TTS_AUDIO_BYTES = 8 * 1024 * 1024;
const HEALTH_TIMEOUT_MS = 5_000;

export interface VoiceHealth {
	ok: boolean;
	[key: string]: unknown;
}

export interface TranscribeResult {
	text: string;
}

export interface SpeakResult {
	buffer: Buffer;
	mime: string;
}

/**
 * The sidecar cannot be reached: unset config, a refused connection, DNS,
 * or a timeout. A normal state, not a bug — every caller answers "can't
 * hear/speak right now", never a stack trace.
 */
export class VoiceOffline extends Error {
	constructor(reason: string) {
		super(`voice sidecar offline: ${reason}`);
		this.name = 'VoiceOffline';
	}
}

/** The sidecar IS up and answered with an error for this one request. */
export class VoiceRequestError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = 'VoiceRequestError';
	}
}

/**
 * Take the first sentences of `text` up to `maxChars`. Cuts at the last
 * sentence end (". ", "! ", "? ", or a newline) inside the budget, so a
 * spoken reply never stops mid-word; falls back to a hard cut only when no
 * sentence end is found in a reasonable stretch of the budget.
 */
export function capToSentences(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const slice = text.slice(0, maxChars);
	const boundary = Math.max(
		slice.lastIndexOf('. '),
		slice.lastIndexOf('! '),
		slice.lastIndexOf('? '),
		slice.lastIndexOf('\n'),
	);
	if (boundary > maxChars * 0.4) return slice.slice(0, boundary + 1).trim();
	return slice.trim();
}

/**
 * Client for the voice sidecar (`aon-voice`, host-side, 10.0.1.1:9030): the
 * ears and the mouth. Everything here is a thin, guarded call; nothing in
 * this service reasons, and it never runs Whisper or edge-tts itself.
 */
@Service()
export class AonVoiceService {
	constructor(
		private readonly config: GlobalConfig,
		private readonly logger: Logger,
	) {}

	configured(): boolean {
		const { voiceUrl, voiceToken } = this.config.aon;
		return Boolean(voiceUrl && voiceToken);
	}

	async health(): Promise<VoiceHealth> {
		if (!this.configured()) throw new VoiceOffline('AON_VOICE_URL or AON_VOICE_TOKEN unset');
		const res = await this.request('health', { method: 'GET' }, HEALTH_TIMEOUT_MS);
		if (!res.ok) throw new VoiceOffline(`sidecar /health returned ${res.status}`);
		return (await res.json()) as VoiceHealth;
	}

	/** One spoken clip in. `filename` and `mime` travel with it only as hints for the sidecar. */
	async transcribe(buffer: Buffer, mime: string, filename: string): Promise<TranscribeResult> {
		if (!this.configured()) throw new VoiceOffline('AON_VOICE_URL or AON_VOICE_TOKEN unset');
		const form = new FormData();
		form.append(
			'audio',
			new Blob([new Uint8Array(buffer)], { type: mime || 'application/octet-stream' }),
			filename || 'audio',
		);
		const res = await this.request('stt', { method: 'POST', body: form }, STT_TIMEOUT_MS);
		if (!res.ok) throw new VoiceRequestError(res.status, await this.errorDetail(res));
		const body = (await res.json()) as { text?: unknown };
		return { text: typeof body.text === 'string' ? body.text : '' };
	}

	/** Text out. Caps the text first — the sidecar has its own, tighter cap and would 413 past it. */
	async speak(text: string, voice?: string): Promise<SpeakResult> {
		if (!this.configured()) throw new VoiceOffline('AON_VOICE_URL or AON_VOICE_TOKEN unset');
		const capped = capToSentences(text.trim(), MAX_TTS_TEXT_CHARS);
		if (!capped) throw new VoiceRequestError(400, 'text required');
		const res = await this.request(
			'tts',
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(voice ? { text: capped, voice } : { text: capped }),
			},
			TTS_TIMEOUT_MS,
		);
		if (!res.ok) throw new VoiceRequestError(res.status, await this.errorDetail(res));
		const mime = res.headers.get('content-type') || 'audio/mpeg';
		if (!res.body) throw new VoiceRequestError(502, 'speech produced no audio');

		const reader = res.body.getReader();
		const chunks: Buffer[] = [];
		let total = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				total += value.byteLength;
				if (total > MAX_TTS_AUDIO_BYTES) {
					throw new VoiceRequestError(502, `speech exceeded the ${MAX_TTS_AUDIO_BYTES} byte cap`);
				}
				chunks.push(Buffer.from(value));
			}
		} finally {
			reader.releaseLock();
		}
		return { buffer: Buffer.concat(chunks), mime };
	}

	private async request(
		path: string,
		init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: BodyInit },
		timeoutMs: number,
	): Promise<Response> {
		const base = this.config.aon.voiceUrl;
		const url = new URL(path, base.endsWith('/') ? base : `${base}/`).toString();
		const headers: Record<string, string> = {
			...init.headers,
			authorization: `Bearer ${this.config.aon.voiceToken}`,
		};
		try {
			return await fetch(url, {
				method: init.method,
				headers,
				body: init.body,
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (err) {
			this.logger.debug('[aon-voice] sidecar request failed', {
				path,
				error: err instanceof Error ? err.message : String(err),
			});
			throw new VoiceOffline(err instanceof Error ? err.message : String(err));
		}
	}

	private async errorDetail(res: Response): Promise<string> {
		try {
			const body = (await res.json()) as { error?: unknown };
			if (typeof body.error === 'string') return body.error;
		} catch {
			// not JSON; fall through to a plain status line
		}
		return `sidecar returned ${res.status}`;
	}
}
