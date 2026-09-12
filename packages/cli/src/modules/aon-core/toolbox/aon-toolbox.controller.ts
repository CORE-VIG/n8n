import type { AonToolboxList, AonToolboxRescanResult } from '@n8n/api-types';
import type { AuthenticatedRequest } from '@n8n/db';
import type { NextFunction, Response } from 'express';
import { Get, Middleware, Post, RestController } from '@n8n/decorators';

import { aonOwnerOnly } from '@/modules/aon-core/aon-owner';

import { AonToolboxService } from './aon-toolbox.service';

type ListRequest = AuthenticatedRequest<{}, {}, {}, { q?: string; kind?: string; limit?: string }>;

const LIMIT_DEFAULT = 50;

/**
 * The toolbox as a page: what Aon can reach for but does not contain.
 * Owner only, same as Settings › Aon, which is the only page that shows it.
 */
@RestController('/aon/toolbox')
export class AonToolboxController {
	constructor(private readonly toolbox: AonToolboxService) {}

	@Middleware()
	ownerOnly(req: AuthenticatedRequest, res: Response, next: NextFunction) {
		aonOwnerOnly(req, res, next);
	}

	@Get('/')
	async list(req: ListRequest): Promise<AonToolboxList> {
		const limit = req.query.limit ? Number(req.query.limit) : LIMIT_DEFAULT;
		return await this.toolbox.list({
			q: req.query.q,
			kind: req.query.kind,
			limit: Number.isFinite(limit) ? limit : LIMIT_DEFAULT,
		});
	}

	@Post('/rescan')
	async rescan(): Promise<AonToolboxRescanResult> {
		return await this.toolbox.rescan();
	}
}
