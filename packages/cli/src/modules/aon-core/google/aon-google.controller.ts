import type { AonGoogleStatus } from '@n8n/api-types';
import type { AuthenticatedRequest } from '@n8n/db';
import type { NextFunction, Response } from 'express';
import { Get, Middleware, RestController } from '@n8n/decorators';

import { aonOwnerOnly } from '@/modules/aon-core/aon-owner';

import { AonGoogleAuthService } from './aon-google-auth.service';

/** The Google status card, for the owner's own Settings › Aon page. */
@RestController('/aon/google')
export class AonGoogleController {
	constructor(private readonly auth: AonGoogleAuthService) {}

	@Middleware()
	ownerOnly(req: AuthenticatedRequest, res: Response, next: NextFunction) {
		aonOwnerOnly(req, res, next);
	}

	@Get('/status')
	async status(req: AuthenticatedRequest): Promise<AonGoogleStatus> {
		return await this.auth.status(req.user);
	}
}
