import type {
	AonAgentDetail,
	AonAgentsOverview,
	AonRunDetail,
	AonRunList,
} from '@n8n/api-types';
import type { AuthenticatedRequest } from '@n8n/db';
import type { NextFunction, Response } from 'express';
import { Get, Middleware, Param, RestController } from '@n8n/decorators';

import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { aonOwnerOnly } from '@/modules/aon-core/aon-owner';

import { charterView } from './charter-view';
import { AonAgentRepository } from './database/repositories/aon-agent.repository';
import { AonDeliverableRepository } from './database/repositories/aon-deliverable.repository';
import { AonLearnedRuleRepository } from './database/repositories/aon-learned-rule.repository';
import { AonRunRepository } from './database/repositories/aon-run.repository';

type RunsRequest = AuthenticatedRequest<
	{},
	{},
	{},
	{ agent?: string; status?: string; limit?: string; offset?: string }
>;

const RUNS_PER_AGENT = 20;
const RUNS_DEFAULT = 50;
const RUNS_MAX = 200;

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
		const [deliverables, runs, rules] = await Promise.all([
			this.deliverables.listForAgent(agent.id),
			this.runs.listRecent({ agentId: agent.id, limit: RUNS_PER_AGENT }),
			this.rules.listForAgent(agent.id),
		]);
		return { ...summary, charter: charterView(agent.charter, agent.persona), deliverables, runs, rules };
	}
}

@RestController('/aon/runs')
export class AonRunsController {
	constructor(private readonly runs: AonRunRepository) {}

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
}
