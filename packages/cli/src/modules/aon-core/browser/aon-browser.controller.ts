import type { AonBrowserReadResult, AonBrowserStatus } from '@n8n/api-types';
import type { AuthenticatedRequest } from '@n8n/db';
import type { NextFunction, Response } from 'express';
import { Get, Middleware, Post, RestController } from '@n8n/decorators';
import { z } from 'zod';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { aonOwnerOnly } from '@/modules/aon-core/aon-owner';

import { AonBrowserService, BrowserOffline, UrlRefused } from './aon-browser.service';

const readBody = z.object({ url: z.string().min(1).max(2048) });

/** The Browser status card and a plain read, for the owner's own UI. */
@RestController('/aon/browser')
export class AonBrowserController {
	constructor(private readonly browser: AonBrowserService) {}

	@Middleware()
	ownerOnly(req: AuthenticatedRequest, res: Response, next: NextFunction) {
		aonOwnerOnly(req, res, next);
	}

	@Get('/status')
	async status(): Promise<AonBrowserStatus> {
		return await this.browser.status();
	}

	@Post('/read')
	async read(req: AuthenticatedRequest): Promise<AonBrowserReadResult> {
		const parsed = readBody.safeParse(req.body);
		if (!parsed.success) {
			throw new BadRequestError(parsed.error.issues.map((issue) => issue.message).join('; '));
		}
		try {
			return await this.browser.read(parsed.data.url);
		} catch (error) {
			if (error instanceof BrowserOffline) throw new BadRequestError('The browser is not configured.');
			if (error instanceof UrlRefused) throw new BadRequestError(error.reason);
			throw error;
		}
	}
}
