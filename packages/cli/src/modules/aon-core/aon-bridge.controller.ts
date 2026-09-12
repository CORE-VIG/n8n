import { GlobalConfig } from '@n8n/config';
import type { User } from '@n8n/db';
import { Post, RestController } from '@n8n/decorators';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { ForbiddenError } from '@/errors/response-errors/forbidden.error';
import { UnauthenticatedError } from '@/errors/response-errors/unauthenticated.error';
import { McpServerApiKeyService } from '@/modules/mcp/mcp-api-key.service';

import { isAonOwner } from './aon-owner';
import { AonTalkService } from './aon-talk.service';
import { stableUuid } from './stable-id';
import { AonVoiceService, VoiceOffline } from './voice/aon-voice.service';

/** A voice note is short; this is generous headroom, not an expected size. */
const MAX_BRIDGE_AUDIO_BYTES = 20 * 1024 * 1024;

const telegramAudio = z.object({
	base64: z.string().min(1),
	mime: z.string().trim().min(1).max(100),
	fileName: z.string().trim().max(200).optional(),
});

const telegramBody = z
	.object({
		chatId: z.union([z.string(), z.number()]).transform((v) => String(v)),
		text: z.string().max(20_000).optional().default(''),
		from: z.object({ id: z.union([z.string(), z.number()]), username: z.string().optional() }),
		/** A Telegram voice note, already downloaded and base64'd by the bridge workflow. */
		audio: telegramAudio.optional(),
		/** Speak the first chunk of the reply back, when the sidecar is up. */
		wantAudio: z.boolean().optional(),
	})
	.refine((body) => body.text.trim().length > 0 || body.audio !== undefined, {
		message: 'text or audio is required',
	});

/** Telegram shows 4096 characters per message; cut a little under, at paragraph ends when possible. */
const TELEGRAM_CHUNK = 3900;

export function chunkForTelegram(text: string, size = TELEGRAM_CHUNK): string[] {
	const out: string[] = [];
	let rest = text.trim();
	while (rest.length > size) {
		let cut = rest.lastIndexOf('\n\n', size);
		if (cut < size / 2) cut = rest.lastIndexOf('\n', size);
		if (cut < size / 2) cut = rest.lastIndexOf(' ', size);
		if (cut < size / 2) cut = size;
		out.push(rest.slice(0, cut).trim());
		rest = rest.slice(cut).trim();
	}
	if (rest) out.push(rest);
	return out;
}

/**
 * The channel bridge: one owner message from Telegram becomes one assistant
 * turn, and the reply goes back. A workflow (Telegram Trigger → HTTP Request →
 * Telegram) carries the messages; this endpoint decides who is the owner.
 *
 * Three locks, all required: the caller holds the owner's MCP API key (the
 * workflow's Header Auth credential), the chat id is one the owner listed in
 * AON_TELEGRAM_CHAT_IDS, and the *sender* (`from.id`) is one the owner listed
 * in AON_TELEGRAM_USER_IDS (or, when that is empty, one of the same chat ids
 * — a private chat's id equals its owner's user id). The chat id alone is not
 * enough: anyone who can post into an allowed chat — a group the owner is
 * merely a member of, for instance — would otherwise speak as him. A stranger
 * who finds the bot gets nothing, and a scheduled or third-party message
 * never passes as the owner speaking.
 */
@RestController('/aon/bridge')
export class AonBridgeController {
	constructor(
		private readonly config: GlobalConfig,
		private readonly mcpApiKeys: McpServerApiKeyService,
		private readonly talk: AonTalkService,
		private readonly voice: AonVoiceService,
	) {}

	@Post('/telegram', { skipAuth: true, ipRateLimit: { limit: 60 } })
	async telegram(req: Request, res: Response) {
		const header = req.header('authorization') ?? '';
		const match = /^Bearer\s+(.+)$/i.exec(header);
		if (!match) throw new UnauthenticatedError('The bridge needs the owner\'s MCP key as a Bearer token');
		let user: User | null = null;
		try {
			user = (await this.mcpApiKeys.verifyApiKey(match[1].trim())).user;
		} catch {
			throw new UnauthenticatedError('That key does not open the bridge');
		}
		if (!user) throw new UnauthenticatedError('That key does not open the bridge');
		if (!isAonOwner(user)) throw new ForbiddenError('The bridge answers only to the instance owner');
		const owner: User = user;

		const parsed = telegramBody.safeParse(req.body);
		if (!parsed.success) throw new BadRequestError(parsed.error.errors[0]?.message ?? 'bad body');
		const { chatId, text, from, audio, wantAudio } = parsed.data;

		const allowed = this.config.aon.telegramChatIds
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		if (!allowed.includes(chatId)) {
			throw new ForbiddenError(
				`Chat ${chatId} is not listed as the owner. Add it to AON_TELEGRAM_CHAT_IDS to open the bridge for it.`,
			);
		}

		const userAllowList = this.config.aon.telegramUserIds.trim()
			? this.config.aon.telegramUserIds
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean)
			: allowed;
		if (!userAllowList.includes(String(from.id))) {
			throw new ForbiddenError('This bot answers its owner only.');
		}

		const threadId = stableUuid('aon-telegram', `${owner.id}:${chatId}`);

		// Voice in: a voice note is transcribed before the turn runs at all. The
		// sidecar being down is a normal state, not a failure of the bridge — he
		// still gets a reply on Telegram, just one that asks him to type instead.
		let transcript: string | null = null;
		let spokenText = text.trim();
		if (audio) {
			if (Buffer.byteLength(audio.base64, 'base64') > MAX_BRIDGE_AUDIO_BYTES) {
				throw new BadRequestError(`audio exceeds the ${MAX_BRIDGE_AUDIO_BYTES} byte cap`);
			}
			try {
				const result = await this.voice.transcribe(
					Buffer.from(audio.base64, 'base64'),
					audio.mime,
					audio.fileName ?? 'voice.ogg',
				);
				transcript = result.text.trim();
				spokenText = transcript;
			} catch (err) {
				// Offline, or the sidecar rejected this clip: either way, hearing
				// failed and the turn never runs. He can always fall back to typing.
				const message =
					"I can't hear right now — the voice service is offline; type it and I'll answer.";
				return {
					threadId,
					text: message,
					chunks: chunkForTelegram(message),
					costUsd: 0,
					error: err instanceof VoiceOffline ? 'voice_offline' : 'voice_error',
					transcript: null,
				};
			}
		}

		let reply = '';
		let costUsd = 0;
		let error: string | null = null;
		const controller = new AbortController();
		res.on('close', () => controller.abort());
		const tag = audio ? '[From Telegram, spoken]' : '[From Telegram]';
		await this.talk.turn(
			{ user: owner, sessionId: threadId, text: `${tag} ${spokenText}`, reset: false },
			(frame) => {
				if (frame.type === 'text' && typeof frame.delta === 'string') reply += frame.delta;
				else if (frame.type === 'cost' && typeof frame.usd === 'number') costUsd = frame.usd;
				else if (frame.type === 'error' && typeof frame.message === 'string') error = frame.message;
			},
			controller.signal,
		);
		const text_ = reply.trim() || error || 'I have nothing to say to that.';
		const chunks = chunkForTelegram(text_);

		// Voice out: best-effort. The text reply above is never held up by this,
		// and a sidecar that is down or slow just means no voice note this time.
		let audioOut: { base64: string; mime: string } | undefined;
		if (wantAudio) {
			try {
				const spoken = await this.voice.speak(chunks[0] ?? text_);
				audioOut = { base64: spoken.buffer.toString('base64'), mime: spoken.mime };
			} catch {
				// no audio this time; the text chunks below still carry the reply
			}
		}

		return {
			threadId,
			text: text_,
			chunks,
			costUsd,
			error,
			...(audio ? { transcript } : {}),
			...(audioOut ? { audio: audioOut } : {}),
		};
	}
}
