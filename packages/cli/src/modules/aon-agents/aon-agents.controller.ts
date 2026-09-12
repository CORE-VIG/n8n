import type {
	AonAgentDetail,
	AonAgentSummary,
	AonAgentsOverview,
	AonRunDetail,
	AonRunEvent,
	AonRunList,
	AonRunSummary,
} from '@n8n/api-types';
import type { AuthenticatedRequest } from '@n8n/db';
import type { NextFunction, Response } from 'express';
import { Get, Middleware, Param, Patch, Post, RestController } from '@n8n/decorators';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { aonOwnerOnly } from '@/modules/aon-core/aon-owner';

import { charterView } from './charter-view';
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

const RUNS_PER_AGENT = 20;
const RUNS_DEFAULT = 50;
const RUNS_MAX = 200;

const agentStatusBody = z.object({
	status: z.enum(['active', 'paused', 'draft']),
});

const runNowBody = z.object({
	input: z.string().max(20_000).optional(),
});

@RestController('/aon/agents')
export class AonAgentsController {
	constructor(
		private readonly agents: AonAgentRepository,
		private readonly deliverables: AonDeliverableRepository,
		private readonly runs: AonRunRepository,
		private readonly rules: AonLearnedRuleRepository,
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
		const summary = await this.agents.findRosterBySlug(slug);
		if (!summary) throw new NotFoundError(`There is no agent called ${slug}`);
		const agent = await this.agents.findOneByOrFail({ id: summary.id });
		const [deliverables, runs, rules, spentEurMonth] = await Promise.all([
			this.deliverables.listForAgent(agent.id),
			this.runs.listRecent({ agentId: agent.id, limit: RUNS_PER_AGENT }),
			this.rules.listForAgent(agent.id),
			this.runs.sumCostEurThisMonth(agent.id),
		]);
		return {
			...summary,
			charter: charterView(agent.charter, agent.persona),
			deliverables,
			runs,
			rules,
			spentEurMonth,
		};
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
		const summary = await this.agents.findRosterBySlug(slug);
		if (!summary) throw new NotFoundError(`There is no agent called ${slug}`);
		const deliverable = await this.deliverables.findOneBy({ id: deliverableId, agentId: summary.id });
		if (!deliverable) {
			throw new NotFoundError(`There is no deliverable ${deliverableId} for ${slug}.`);
		}
		const input = parsed.data.input && parsed.data.input.trim() ? { text: parsed.data.input } : null;
		const run = await this.runs.createQueued({
			id: randomUUID(),
			deliverableId: deliverable.id,
			agentId: summary.id,
			parentRunId: null,
			iteration: 1,
			attempt: 1,
			trigger: 'owner',
			input,
		});
		return {
			id: run.id,
			agentId: summary.id,
			agentSlug: summary.slug,
			agentName: summary.name,
			deliverableId: deliverable.id,
			deliverableName: deliverable.name,
			status: run.status,
			attempt: run.attempt,
			iteration: run.iteration,
			invokedBy: run.trigger,
			model: run.model,
			tokensIn: run.tokensIn,
			tokensOut: run.tokensOut,
			costEur: run.costEur,
			help: run.help,
			startedAt: run.startedAt ? run.startedAt.toISOString() : null,
			finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
			createdAt: run.createdAt.toISOString(),
		};
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
