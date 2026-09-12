import type {
	AonAgentDetail,
	AonAgentSummary,
	AonAgentsOverview,
	AonDeliverableSummary,
	AonRunDetail,
	AonRunEvent,
	AonRunList,
	AonRunSummary,
} from '@n8n/api-types';
import type { AuthenticatedRequest } from '@n8n/db';
import type { NextFunction, Response } from 'express';
import { Delete, Get, Middleware, Param, Patch, Post, RestController } from '@n8n/decorators';
import { z } from 'zod';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { aonOwnerOnly } from '@/modules/aon-core/aon-owner';

import { AonAgentAuthoringService } from './aon-agent-authoring.service';
import { AonAgentRepository } from './database/repositories/aon-agent.repository';
import { AonDeliverableRepository } from './database/repositories/aon-deliverable.repository';
import { AonLearnedRuleRepository } from './database/repositories/aon-learned-rule.repository';
import { AonRunEventRepository } from './database/repositories/aon-run-event.repository';
import { AonRunRepository } from './database/repositories/aon-run.repository';
import { AonExecutorService } from './executor/aon-executor.service';

type RunsRequest = AuthenticatedRequest<
	{},
	{},
	{},
	{ agent?: string; status?: string; limit?: string; offset?: string }
>;
type EventsRequest = AuthenticatedRequest<{}, {}, {}, { after?: string }>;

const RUNS_DEFAULT = 50;
const RUNS_MAX = 200;

const agentStatusBody = z.object({
	status: z.enum(['active', 'paused', 'draft']),
});

const runNowBody = z.object({
	input: z.string().max(20_000).optional(),
});

const charterInputSchema = z
	.object({
		purpose: z.string().max(4000).optional(),
		owns: z.array(z.string().max(200)).max(50).optional(),
		sources: z.array(z.string().max(200)).max(50).optional(),
		do: z.array(z.string().max(500)).max(50).optional(),
		dont: z.array(z.string().max(500)).max(50).optional(),
		skills: z.array(z.string().max(100)).max(50).optional(),
		tools: z.array(z.string().max(100)).max(50).optional(),
		tierCeiling: z.number().int().min(0).max(4).optional(),
		breakerLimit: z.number().int().min(1).max(50).optional(),
		escalateWhen: z.string().max(2000).optional(),
		budgetEurMonth: z.number().min(0).optional(),
		modelBand: z.enum(['fast', 'standard', 'deep']).optional(),
	})
	.strict();

const createAgentBody = z.object({
	slug: z
		.string()
		.regex(/^[a-z0-9-]{2,40}$/, 'slug must be lowercase letters, digits and hyphens, 2 to 40 characters.'),
	name: z.string().min(1).max(200),
	persona: z.string().max(2000).optional(),
	charter: charterInputSchema,
});

const updateCharterBody = z.object({
	name: z.string().min(1).max(200).optional(),
	persona: z.string().max(2000).optional(),
	charter: charterInputSchema.optional(),
});

const deliverableFields = {
	name: z.string().min(1).max(200),
	dod: z.string().min(1).max(4000),
	shape: z.enum(['single', 'recurring', 'goal']),
	cadence: z.string().max(200).optional(),
	tier: z.number().int().min(0).max(4),
	approver: z.enum(['owner', 'auto']),
	maxIterations: z.number().int().min(1).max(20).optional(),
	enabled: z.boolean().optional(),
};

const createDeliverableBody = z.object(deliverableFields).strict();
const patchDeliverableBody = z.object(deliverableFields).partial().strict();

@RestController('/aon/agents')
export class AonAgentsController {
	constructor(
		private readonly agents: AonAgentRepository,
		private readonly deliverables: AonDeliverableRepository,
		private readonly runs: AonRunRepository,
		private readonly rules: AonLearnedRuleRepository,
		private readonly authoring: AonAgentAuthoringService,
	) {}

	@Middleware()
	ownerOnly(req: AuthenticatedRequest, res: Response, next: NextFunction) {
		aonOwnerOnly(req, res, next);
	}

	@Get('/overview')
	async overview(): Promise<AonAgentsOverview> {
		const [agentsByStatus, deliverables, runsByStatus, rules, lastRunAt] = await Promise.all([
			this.agents.countByStatus(),
			this.deliverables.count(),
			this.runs.countByStatus(),
			this.rules.countInForce(),
			this.runs.lastCreatedAt(),
		]);
		const sum = (counts: Record<string, number>) =>
			Object.values(counts).reduce((total, n) => total + n, 0);
		return {
			agents: sum(agentsByStatus),
			activeAgents: agentsByStatus.active ?? 0,
			deliverables,
			runs: sum(runsByStatus),
			runsByStatus,
			rules,
			lastRunAt,
		};
	}

	@Get('/')
	async list() {
		return await this.agents.listRoster();
	}

	@Get('/:slug')
	async get(
		_req: AuthenticatedRequest,
		_res: unknown,
		@Param('slug') slug: string,
	): Promise<AonAgentDetail> {
		return await this.authoring.getDetail(slug);
	}

	@Post('/')
	async create(req: AuthenticatedRequest): Promise<AonAgentDetail> {
		const parsed = createAgentBody.safeParse(req.body);
		if (!parsed.success) {
			throw new BadRequestError(parsed.error.issues.map((issue) => issue.message).join('; '));
		}
		return await this.authoring.createAgent(
			{ slug: parsed.data.slug, name: parsed.data.name, persona: parsed.data.persona, charter: parsed.data.charter },
			req.user.email,
		);
	}

	@Patch('/:slug/charter')
	async updateCharter(
		req: AuthenticatedRequest,
		_res: unknown,
		@Param('slug') slug: string,
	): Promise<AonAgentDetail> {
		const parsed = updateCharterBody.safeParse(req.body);
		if (!parsed.success) {
			throw new BadRequestError(parsed.error.issues.map((issue) => issue.message).join('; '));
		}
		return await this.authoring.updateCharter(slug, parsed.data);
	}

	@Post('/:slug/deliverables')
	async createDeliverable(
		req: AuthenticatedRequest,
		_res: unknown,
		@Param('slug') slug: string,
	): Promise<AonDeliverableSummary> {
		const parsed = createDeliverableBody.safeParse(req.body);
		if (!parsed.success) {
			throw new BadRequestError(parsed.error.issues.map((issue) => issue.message).join('; '));
		}
		return await this.authoring.createDeliverable(slug, parsed.data);
	}

	@Patch('/:slug/deliverables/:id')
	async patchDeliverable(
		req: AuthenticatedRequest,
		_res: unknown,
		@Param('slug') slug: string,
		@Param('id') id: string,
	): Promise<AonDeliverableSummary> {
		const parsed = patchDeliverableBody.safeParse(req.body);
		if (!parsed.success) {
			throw new BadRequestError(parsed.error.issues.map((issue) => issue.message).join('; '));
		}
		return await this.authoring.updateDeliverable(slug, id, parsed.data);
	}

	@Delete('/:slug/deliverables/:id')
	async deleteDeliverable(
		_req: AuthenticatedRequest,
		_res: unknown,
		@Param('slug') slug: string,
		@Param('id') id: string,
	): Promise<{ deleted: true }> {
		await this.authoring.deleteDeliverable(slug, id);
		return { deleted: true };
	}

	@Patch('/:slug')
	async setStatus(
		req: AuthenticatedRequest,
		_res: unknown,
		@Param('slug') slug: string,
	): Promise<AonAgentSummary> {
		const parsed = agentStatusBody.safeParse(req.body);
		if (!parsed.success) {
			throw new BadRequestError(parsed.error.issues.map((issue) => issue.message).join('; '));
		}
		const summary = await this.agents.findRosterBySlug(slug);
		if (!summary) throw new NotFoundError(`There is no agent called ${slug}`);
		await this.agents.setStatus(summary.id, parsed.data.status);
		const updated = await this.agents.findRosterBySlug(slug);
		if (!updated) throw new NotFoundError(`There is no agent called ${slug}`);
		return updated;
	}

	@Post('/:slug/breaker/reset')
	async resetBreaker(
		_req: AuthenticatedRequest,
		_res: unknown,
		@Param('slug') slug: string,
	): Promise<AonAgentSummary> {
		const summary = await this.agents.findRosterBySlug(slug);
		if (!summary) throw new NotFoundError(`There is no agent called ${slug}`);
		await this.agents.resetBreaker(summary.id);
		const updated = await this.agents.findRosterBySlug(slug);
		if (!updated) throw new NotFoundError(`There is no agent called ${slug}`);
		return updated;
	}

	@Post('/:slug/deliverables/:deliverableId/run')
	async runNow(
		req: AuthenticatedRequest,
		_res: unknown,
		@Param('slug') slug: string,
		@Param('deliverableId') deliverableId: string,
	): Promise<AonRunSummary> {
		const parsed = runNowBody.safeParse(req.body);
		if (!parsed.success) {
			throw new BadRequestError(parsed.error.issues.map((issue) => issue.message).join('; '));
		}
		return await this.authoring.startRun(slug, deliverableId, parsed.data.input, 'owner');
	}
}

@RestController('/aon/runs')
export class AonRunsController {
	constructor(
		private readonly runs: AonRunRepository,
		private readonly runEvents: AonRunEventRepository,
		private readonly executor: AonExecutorService,
	) {}

	@Middleware()
	ownerOnly(req: AuthenticatedRequest, res: Response, next: NextFunction) {
		aonOwnerOnly(req, res, next);
	}

	@Get('/')
	async list(req: RunsRequest): Promise<AonRunList> {
		const agentId = typeof req.query.agent === 'string' ? req.query.agent : undefined;
		const status = typeof req.query.status === 'string' ? req.query.status : undefined;
		const askedLimit = Number(req.query.limit);
		const limit =
			Number.isFinite(askedLimit) && askedLimit > 0 ? Math.min(askedLimit, RUNS_MAX) : RUNS_DEFAULT;
		const askedOffset = Number(req.query.offset);
		const offset = Number.isFinite(askedOffset) && askedOffset > 0 ? askedOffset : 0;
		const [{ items, total }, byStatus] = await Promise.all([
			this.runs.list({ agentId, status, limit, offset }),
			this.runs.countByStatus(),
		]);
		return { items, total, byStatus };
	}

	@Get('/:id')
	async get(
		_req: AuthenticatedRequest,
		_res: unknown,
		@Param('id') id: string,
	): Promise<AonRunDetail> {
		const run = await this.runs.findDetail(id);
		if (!run) throw new NotFoundError(`There is no run with the id ${id}.`);
		return run;
	}

	@Post('/:id/stop')
	async stop(
		_req: AuthenticatedRequest,
		_res: unknown,
		@Param('id') id: string,
	): Promise<AonRunDetail> {
		const existing = await this.runs.findDetail(id);
		if (!existing) throw new NotFoundError(`There is no run with the id ${id}.`);
		await this.executor.stop(id);
		const updated = await this.runs.findDetail(id);
		if (!updated) throw new NotFoundError(`There is no run with the id ${id}.`);
		return updated;
	}

	@Get('/:id/events')
	async events(
		req: EventsRequest,
		_res: unknown,
		@Param('id') id: string,
	): Promise<AonRunEvent[]> {
		const askedAfter = Number(req.query.after);
		const after = Number.isFinite(askedAfter) && askedAfter > 0 ? askedAfter : 0;
		return await this.runEvents.listForRun(id, after);
	}
}
