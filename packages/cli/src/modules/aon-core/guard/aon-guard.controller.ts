import type { AonGuardApproval, AonGuardOverview, AonGuardPolicy } from '@n8n/api-types';
import type { AuthenticatedRequest } from '@n8n/db';
import type { NextFunction, Response } from 'express';
import { Delete, Get, Middleware, Param, Post, Put, RestController } from '@n8n/decorators';
import { z } from 'zod';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { aonOwnerOnly } from '@/modules/aon-core/aon-owner';

import { AonGuardPolicyRepository } from '../database/repositories/aon-guard-policy.repository';

import { AonGuardService } from './aon-guard.service';
import { AON_OP_CLASSES } from './op-classes';

const IDENTITY_RE = /^(\*|owner|agent:[a-z0-9._-]+)$/;

const putPolicyBody = z.object({
	identity: z.string().regex(IDENTITY_RE, 'identity must be "*", "owner", or "agent:<slug>"'),
	opClass: z.string().min(1).max(200),
	verdict: z.enum(['allow', 'ask', 'deny']),
	note: z.string().trim().max(500).optional(),
});

/**
 * Guard's own page: the cards waiting for the owner, every standing policy,
 * and the audit trail. Owner only, like the rest of Aon's own state.
 */
@RestController('/aon/guard')
export class AonGuardController {
	constructor(
		private readonly guard: AonGuardService,
		private readonly policies: AonGuardPolicyRepository,
	) {}

	@Middleware()
	ownerOnly(req: AuthenticatedRequest, res: Response, next: NextFunction) {
		aonOwnerOnly(req, res, next);
	}

	@Get('/overview')
	async overview(): Promise<AonGuardOverview> {
		return await this.guard.overview();
	}

	@Post('/approvals/:id/approve')
	async approve(
		req: AuthenticatedRequest,
		_res: unknown,
		@Param('id') id: string,
	): Promise<AonGuardApproval> {
		return await this.guard.decideApproval(id, 'approved', req.user.email);
	}

	@Post('/approvals/:id/deny')
	async deny(
		req: AuthenticatedRequest,
		_res: unknown,
		@Param('id') id: string,
	): Promise<AonGuardApproval> {
		return await this.guard.decideApproval(id, 'denied', req.user.email);
	}

	@Put('/policies')
	async putPolicy(req: AuthenticatedRequest): Promise<AonGuardPolicy> {
		const parsed = putPolicyBody.safeParse(req.body);
		if (!parsed.success) {
			throw new BadRequestError(parsed.error.issues.map((issue) => issue.message).join('; '));
		}
		const { identity, opClass, verdict, note } = parsed.data;
		if (!AON_OP_CLASSES.some((c) => c.opClass === opClass)) {
			throw new BadRequestError(`Guard does not know the op class "${opClass}".`);
		}
		return await this.policies.upsertPolicy({ identity, opClass, verdict, note: note ?? null });
	}

	@Delete('/policies/:id')
	async deletePolicy(
		_req: AuthenticatedRequest,
		_res: unknown,
		@Param('id') id: string,
	): Promise<{ ok: true }> {
		await this.policies.deleteById(id);
		return { ok: true };
	}
}
