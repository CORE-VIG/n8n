import type { AonAgentDetail, AonAgentsOverview, AonRunSummary } from '@n8n/api-types';
import type { AuthenticatedRequest } from '@n8n/db';
import { Get, Param, RestController } from '@n8n/decorators';

import { NotFoundError } from '@/errors/response-errors/not-found.error';

import { AonAgentRepository } from './database/repositories/aon-agent.repository';
import { AonDeliverableRepository } from './database/repositories/aon-deliverable.repository';
import { AonLearnedRuleRepository } from './database/repositories/aon-learned-rule.repository';
import { AonRunRepository } from './database/repositories/aon-run.repository';

type RunsRequest = AuthenticatedRequest<{}, {}, {}, { agent?: string; limit?: string }>;

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
		return { ...summary, charter: agent.charter, deliverables, runs, rules };
	}
}

@RestController('/aon/runs')
export class AonRunsController {
	constructor(private readonly runs: AonRunRepository) {}

	@Get('/')
	async list(req: RunsRequest): Promise<AonRunSummary[]> {
		const agentId = typeof req.query.agent === 'string' ? req.query.agent : undefined;
		const asked = Number(req.query.limit);
		const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, RUNS_MAX) : RUNS_DEFAULT;
		return await this.runs.listRecent({ agentId, limit });
	}
}
