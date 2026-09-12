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

const telegramBody = z.object({
	chatId: z.union([z.string(), z.number()]).transform((v) => String(v)),
	text: z.string().min(1).max(20_000),
	from: z.object({ id: z.union([z.string(), z.number()]).optional(), username: z.string().optional() }).optional(),
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
 * Two locks, both required: the caller holds the owner's MCP API key (the
 * workflow's Header Auth credential), and the chat id is one the owner listed
 * in AON_TELEGRAM_CHAT_IDS. A stranger who finds the bot gets nothing, and a
 * scheduled or third-party message never passes as the owner speaking.
 */
@RestController('/aon/bridge')
export class AonBridgeController {
	constructor(
		private readonly config: GlobalConfig,
		private readonly mcpApiKeys: McpServerApiKeyService,
		private readonly talk: AonTalkService,
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
		const { chatId, text } = parsed.data;

		const allowed = this.config.aon.telegramChatIds
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		if (!allowed.includes(chatId)) {
			throw new ForbiddenError(
				`Chat ${chatId} is not listed as the owner. Add it to AON_TELEGRAM_CHAT_IDS to open the bridge for it.`,
			);
		}

		const threadId = stableUuid('aon-telegram', `${owner.id}:${chatId}`);
		let reply = '';
		let costUsd = 0;
		let error: string | null = null;
		const controller = new AbortController();
		res.on('close', () => controller.abort());
		await this.talk.turn(
			{ user: owner, sessionId: threadId, text, reset: false },
			(frame) => {
				if (frame.type === 'text' && typeof frame.delta === 'string') reply += frame.delta;
				else if (frame.type === 'cost' && typeof frame.usd === 'number') costUsd = frame.usd;
				else if (frame.type === 'error' && typeof frame.message === 'string') error = frame.message;
			},
			controller.signal,
		);
		const text_ = reply.trim() || error || 'I have nothing to say to that.';
		return { threadId, text: text_, chunks: chunkForTelegram(text_), costUsd, error };
	}
}
