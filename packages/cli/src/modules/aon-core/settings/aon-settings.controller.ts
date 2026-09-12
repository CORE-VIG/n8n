import type { AonSettingsView, AonSkillInfo } from '@n8n/api-types';
import type { AuthenticatedRequest } from '@n8n/db';
import type { NextFunction, Response } from 'express';
import { Get, Middleware, Param, Put, RestController } from '@n8n/decorators';
import { z } from 'zod';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { aonOwnerOnly } from '@/modules/aon-core/aon-owner';

import { AonSettingsService } from './aon-settings.service';

const putSettingsBody = z
	.object({
		persona: z.string().trim().max(4000).optional(),
		talkModel: z.string().min(1).max(200).optional(),
		budgetEurMonth: z.number().min(0).max(1000).optional(),
		localModel: z.string().min(1).max(200).optional(),
		backgroundPaidEurMonth: z.number().min(0).max(100).optional(),
		backgroundJobsPaused: z.boolean().optional(),
	})
	.strict();

const putSkillBody = z.object({ enabled: z.boolean() }).strict();

/**
 * Settings › Aon: the owner's own page for shaping the assistant. Owner
 * only, like the rest of Aon's own state.
 */
@RestController('/aon/settings')
export class AonSettingsController {
	constructor(private readonly settings: AonSettingsService) {}

	@Middleware()
	ownerOnly(req: AuthenticatedRequest, res: Response, next: NextFunction) {
		aonOwnerOnly(req, res, next);
	}

	@Get('/')
	async get(req: AuthenticatedRequest): Promise<AonSettingsView> {
		return await this.settings.view(req.user);
	}

	@Put('/')
	async put(req: AuthenticatedRequest): Promise<AonSettingsView> {
		const parsed = putSettingsBody.safeParse(req.body);
		if (!parsed.success) {
			throw new BadRequestError(parsed.error.issues.map((issue) => issue.message).join('; '));
		}
		const { talkModel, localModel } = parsed.data;
		if (talkModel !== undefined && !this.settings.isAllowedModel(talkModel)) {
			throw new BadRequestError(`"${talkModel}" is not one of the models Aon offers.`);
		}
		if (localModel !== undefined && !(await this.settings.isAllowedLocalModel(localModel))) {
			throw new BadRequestError(`"${localModel}" is not one of the models Ollama reports.`);
		}
		await this.settings.update(parsed.data);
		return await this.settings.view(req.user);
	}

	@Put('/skills/:name')
	async putSkill(
		req: AuthenticatedRequest,
		_res: unknown,
		@Param('name') name: string,
	): Promise<AonSkillInfo> {
		const parsed = putSkillBody.safeParse(req.body);
		if (!parsed.success) {
			throw new BadRequestError(parsed.error.issues.map((issue) => issue.message).join('; '));
		}
		return await this.settings.setSkillEnabled(name, parsed.data.enabled);
	}
}
