import type {
	AonHandsRunResult,
	AonWorkspaceFile,
	AonWorkspaceFileEntry,
	AonWorkspaceSummary,
} from '@n8n/api-types';
import type { AuthenticatedRequest } from '@n8n/db';
import { Delete, Get, Param, Post, RestController } from '@n8n/decorators';
import { z } from 'zod';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';

import { AonHandsService } from './aon-hands.service';

type PathQueryRequest = AuthenticatedRequest<{}, {}, {}, { path?: string }>;

const NOT_CONFIGURED = 'The sandbox service is not configured';

const createWorkspaceBody = z.object({
	slug: z.string().trim().min(1).max(64),
});

const runBody = z.object({
	command: z.string().min(1).max(20_000),
	timeoutSeconds: z.number().int().min(1).max(1800).optional(),
	network: z.boolean().optional(),
});

/**
 * The fenced Hands workspaces, browsable from the editor the same way the
 * assistant and Aon agents already reach them through `AonHandsService`.
 */
@RestController('/aon/hands')
export class AonHandsController {
	constructor(private readonly hands: AonHandsService) {}

	@Get('/workspaces')
	async listWorkspaces(req: AuthenticatedRequest): Promise<AonWorkspaceSummary[]> {
		if (!(await this.hands.isConfigured())) return [];
		return await this.hands.listWorkspaces(req.user);
	}

	@Post('/workspaces')
	async createWorkspace(req: AuthenticatedRequest): Promise<AonWorkspaceSummary> {
		await this.requireConfigured();
		const parsed = createWorkspaceBody.safeParse(req.body);
		if (!parsed.success) {
			throw new BadRequestError(parsed.error.issues.map((issue) => issue.message).join('; '));
		}
		return await this.hands.createWorkspace(req.user, parsed.data.slug);
	}

	@Delete('/workspaces/:slug')
	async deleteWorkspace(
		req: AuthenticatedRequest,
		_res: unknown,
		@Param('slug') slug: string,
	): Promise<{ success: true }> {
		await this.requireConfigured();
		await this.hands.deleteWorkspace(req.user, slug);
		return { success: true };
	}

	@Get('/workspaces/:slug/files')
	async listFiles(
		req: PathQueryRequest,
		_res: unknown,
		@Param('slug') slug: string,
	): Promise<AonWorkspaceFileEntry[]> {
		await this.requireConfigured();
		const path = typeof req.query.path === 'string' && req.query.path.length > 0 ? req.query.path : undefined;
		return await this.hands.listFiles(req.user, slug, path);
	}

	@Get('/workspaces/:slug/file')
	async readFile(
		req: PathQueryRequest,
		_res: unknown,
		@Param('slug') slug: string,
	): Promise<AonWorkspaceFile> {
		await this.requireConfigured();
		const path = typeof req.query.path === 'string' ? req.query.path : '';
		if (!path) throw new BadRequestError('path is required');
		return await this.hands.readFile(req.user, slug, path);
	}

	@Post('/workspaces/:slug/run')
	async run(
		req: AuthenticatedRequest,
		_res: unknown,
		@Param('slug') slug: string,
	): Promise<AonHandsRunResult> {
		await this.requireConfigured();
		const parsed = runBody.safeParse(req.body);
		if (!parsed.success) {
			throw new BadRequestError(parsed.error.issues.map((issue) => issue.message).join('; '));
		}
		return await this.hands.run(req.user, slug, parsed.data);
	}

	private async requireConfigured(): Promise<void> {
		if (!(await this.hands.isConfigured())) throw new BadRequestError(NOT_CONFIGURED);
	}
}
