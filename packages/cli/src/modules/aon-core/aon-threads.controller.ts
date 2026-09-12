import type { AonThreadDetail, AonThreadSummary } from '@n8n/api-types';
import type { AuthenticatedRequest } from '@n8n/db';
import { Delete, Get, Param, Patch, Post, RestController } from '@n8n/decorators';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';

import { AonThreadRepository } from './database/repositories/aon-thread.repository';

const renameBody = z.object({
	title: z.string().trim().min(1).max(120),
});

/**
 * The assistant's saved conversations: list, open, rename, forget. Every
 * route is scoped to the caller; there is no way to reach another user's
 * thread through this controller. `AonTalkService` is what writes the turns.
 */
@RestController('/aon/threads')
export class AonThreadsController {
	constructor(private readonly threads: AonThreadRepository) {}

	@Get('/')
	async list(req: AuthenticatedRequest): Promise<AonThreadSummary[]> {
		return await this.threads.listForUser(req.user.id);
	}

	@Post('/')
	async create(req: AuthenticatedRequest): Promise<AonThreadSummary> {
		const thread = await this.threads.ensure(randomUUID(), req.user.id);
		return {
			id: thread.id,
			title: thread.title,
			createdAt: thread.createdAt.toISOString(),
			lastTurnAt: thread.lastTurnAt ? thread.lastTurnAt.toISOString() : null,
			turnCount: 0,
			preview: null,
		};
	}

	@Get('/:id')
	async get(
		req: AuthenticatedRequest,
		_res: unknown,
		@Param('id') id: string,
	): Promise<AonThreadDetail> {
		const detail = await this.threads.findDetail(id, req.user.id);
		if (!detail) throw new NotFoundError('There is no conversation with that id.');
		return detail;
	}

	@Patch('/:id')
	async rename(
		req: AuthenticatedRequest,
		_res: unknown,
		@Param('id') id: string,
	): Promise<AonThreadSummary> {
		const parsed = renameBody.safeParse(req.body);
		if (!parsed.success) {
			throw new BadRequestError(parsed.error.issues.map((i) => i.message).join('; '));
		}
		const summary = await this.threads.rename(id, req.user.id, parsed.data.title);
		if (!summary) throw new NotFoundError('There is no conversation with that id.');
		return summary;
	}

	@Delete('/:id')
	async remove(
		req: AuthenticatedRequest,
		_res: unknown,
		@Param('id') id: string,
	): Promise<{ ok: true }> {
		const removed = await this.threads.deleteForUser(id, req.user.id);
		if (!removed) throw new NotFoundError('There is no conversation with that id.');
		return { ok: true };
	}
}
