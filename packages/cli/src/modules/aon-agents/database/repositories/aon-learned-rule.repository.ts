import type { AonLearnedRuleSummary } from '@n8n/api-types';
import { Service } from '@n8n/di';
import { DataSource, IsNull, Repository } from '@n8n/typeorm';

import { AonLearnedRule } from '../entities/aon-learned-rule.entity';

const toSummary = (r: AonLearnedRule): AonLearnedRuleSummary => ({
	id: r.id,
	agentId: r.agentId,
	text: r.text,
	state: r.state,
	reason: r.reason,
	createdAt: r.createdAt.toISOString(),
	revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
});

@Service()
export class AonLearnedRuleRepository extends Repository<AonLearnedRule> {
	constructor(dataSource: DataSource) {
		super(AonLearnedRule, dataSource.manager);
	}

	async listForAgent(agentId: string): Promise<AonLearnedRuleSummary[]> {
		const rows = await this.find({ where: { agentId }, order: { createdAt: 'DESC' } });
		return rows.map(toSummary);
	}

	/** Rules still in force: canary or kept, not revoked. */
	async countInForce(): Promise<number> {
		return await this.count({ where: { revokedAt: IsNull() } });
	}
}
