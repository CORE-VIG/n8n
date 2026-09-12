import type { AonRunSummary } from '@n8n/api-types';
import { Service } from '@n8n/di';
import { DataSource, Repository } from '@n8n/typeorm';

import { AonAgent } from '../entities/aon-agent.entity';
import { AonDeliverable } from '../entities/aon-deliverable.entity';
import { AonRun } from '../entities/aon-run.entity';

interface RunRow extends Omit<AonRunSummary, 'startedAt' | 'finishedAt' | 'createdAt'> {
	startedAt: Date | null;
	finishedAt: Date | null;
	createdAt: Date;
}

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

@Service()
export class AonRunRepository extends Repository<AonRun> {
	constructor(dataSource: DataSource) {
		super(AonRun, dataSource.manager);
	}

	private table(entity: typeof AonAgent | typeof AonRun | typeof AonDeliverable) {
		return this.manager.connection.driver.escape(
			this.manager.connection.getMetadata(entity).tableName,
		);
	}

	/** Newest first, with the agent and deliverable names a list needs. */
	async listRecent({
		agentId,
		limit,
	}: {
		agentId?: string;
		limit: number;
	}): Promise<AonRunSummary[]> {
		const rows = await this.manager.query<RunRow[]>(
			`SELECT r.id, r.agent_id AS "agentId", a.slug AS "agentSlug", a.name AS "agentName",
				r.deliverable_id AS "deliverableId", d.name AS "deliverableName",
				r.status, r.attempt, r.iteration, r.trigger AS "invokedBy", r.model,
				r.tokens_in AS "tokensIn", r.tokens_out AS "tokensOut", r.cost_eur AS "costEur", r.help,
				r.started_at AS "startedAt", r.finished_at AS "finishedAt", r.created_at AS "createdAt"
			FROM ${this.table(AonRun)} r
			LEFT JOIN ${this.table(AonAgent)} a ON a.id = r.agent_id
			LEFT JOIN ${this.table(AonDeliverable)} d ON d.id = r.deliverable_id
			WHERE ($1::text IS NULL OR r.agent_id = $1)
			ORDER BY r.created_at DESC
			LIMIT $2`,
			[agentId ?? null, limit],
		);
		return rows.map((r) => ({
			...r,
			startedAt: iso(r.startedAt),
			finishedAt: iso(r.finishedAt),
			createdAt: iso(r.createdAt) ?? '',
		}));
	}

	async countByStatus(): Promise<Record<string, number>> {
		const rows = await this.manager.query<Array<{ status: string; count: number }>>(
			`SELECT status, count(*)::int AS count FROM ${this.table(AonRun)} GROUP BY status`,
		);
		return Object.fromEntries(rows.map((r) => [r.status, r.count]));
	}

	async lastCreatedAt(): Promise<string | null> {
		const rows = await this.manager.query<Array<{ last: Date | null }>>(
			`SELECT max(created_at) AS last FROM ${this.table(AonRun)}`,
		);
		return iso(rows[0]?.last ?? null);
	}
}
