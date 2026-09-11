import type { AonDeliverableSummary } from '@n8n/api-types';
import { Service } from '@n8n/di';
import { DataSource, Repository } from '@n8n/typeorm';

import { AonDeliverable } from '../entities/aon-deliverable.entity';

@Service()
export class AonDeliverableRepository extends Repository<AonDeliverable> {
	constructor(dataSource: DataSource) {
		super(AonDeliverable, dataSource.manager);
	}

	async listForAgent(agentId: string): Promise<AonDeliverableSummary[]> {
		const rows = await this.find({ where: { agentId }, order: { name: 'ASC' } });
		return rows.map((d) => ({
			id: d.id,
			slug: d.slug,
			name: d.name,
			dod: d.dod,
			shape: d.shape,
			cadence: d.cadence,
			tier: d.tier,
			approver: d.approver,
			maxIterations: d.maxIterations,
			enabled: d.enabled,
			lastRunAt: d.lastRunAt ? d.lastRunAt.toISOString() : null,
		}));
	}
}
