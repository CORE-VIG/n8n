import { AuthenticatedRequest } from '@n8n/db';
import { Body, Get, Post, RestController } from '@n8n/decorators';
import type { Response } from 'express';
import { z } from 'zod';

import { AonTalkService } from './aon-talk.service';

type FlushableResponse = Response & { flush?: () => void };

const talkBody = z.object({
	sessionId: z.string().min(1).max(80),
	text: z.string().min(1).max(20_000),
	reset: z.boolean().optional(),
});

/**
 * One turn with the assistant, streamed as newline-delimited JSON frames so
 * the window can show the first words and every tool call as it happens.
 */
@RestController('/aon')
export class AonTalkController {
	constructor(private readonly talk: AonTalkService) {}

	@Get('/health')
	health() {
		return { ok: true, sessions: this.talk.sessionCount() };
	}

	@Post('/talk', { ipRateLimit: { limit: 60 } })
	async talkTurn(req: AuthenticatedRequest, res: FlushableResponse, @Body payload: unknown) {
		const parsed = talkBody.safeParse(payload);
		if (!parsed.success) {
			res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join('; ') });
			return;
		}
		const abort = new AbortController();
		const onClose = () => abort.abort();
		res.on('close', onClose);
		res.header('Content-Type', 'application/x-ndjson; charset=utf-8');
		res.header('Cache-Control', 'no-cache');
		res.flush?.();

		const write = (frame: Record<string, unknown>) => {
			if (res.writableEnded) return;
			res.write(JSON.stringify(frame) + '\n');
			res.flush?.();
		};

		try {
			await this.talk.turn(
				{ user: req.user, sessionId: parsed.data.sessionId, text: parsed.data.text, reset: parsed.data.reset === true },
				write,
				abort.signal,
			);
		} catch (e) {
			write({ type: 'error', message: e instanceof Error ? e.message : String(e) });
		} finally {
			res.off('close', onClose);
			if (!res.writableEnded) res.end();
		}
	}
}
