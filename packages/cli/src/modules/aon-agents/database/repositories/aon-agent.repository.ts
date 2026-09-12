import type { AonAgentSummary } from '@n8n/api-types';
import { Service } from '@n8n/di';
import { DataSource, Repository } from '@n8n/typeorm';

import { AonAgent } from '../entities/aon-agent.entity';
import { AonDeliverable } from '../entities/aon-deliverable.entity';
import { AonRun } from '../entities/aon-run.entity';

interface RosterRow {
	id: string;
	slug: string;
	name: string;
	persona: string;
	status: string;
	breakerFailures: number;
	breakerTrippedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
	deliverables: number;
	runs: number;
	lastRunId: string | null;
	lastRunStatus: string | null;
	lastRunCreatedAt: Date | null;
	lastRunFinishedAt: Date | null;
}

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

export function toAgentSummary(row: RosterRow): AonAgentSummary {
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		persona: row.persona,
		status: row.status,
		breakerFailures: row.breakerFailures,
		breakerTrippedAt: iso(row.breakerTrippedAt),
		createdAt: iso(row.createdAt) ?? '',
		updatedAt: iso(row.updatedAt) ?? '',
		counts: { deliverables: row.deliverables, runs: row.runs },
		lastRun:
			row.lastRunId && row.lastRunStatus && row.lastRunCreatedAt
				? {
						id: row.lastRunId,
						status: row.lastRunStatus,
						createdAt: iso(row.lastRunCreatedAt) ?? '',
						finishedAt: iso(row.lastRunFinishedAt),
					}
				: null,
	};
}

@Service()
export class AonAgentRepository extends Repository<AonAgent> {
	constructor(dataSource: DataSource) {
		super(AonAgent, dataSource.manager);
	}

	private table(entity: typeof AonAgent | typeof AonRun | typeof AonDeliverable) {
		return this.manager.connection.driver.escape(
			this.manager.connection.getMetadata(entity).tableName,
		);
	}

	private rosterSql(where = '') {
		const agents = this.table(AonAgent);
		const runs = this.table(AonRun);
		const deliverables = this.table(AonDeliverable);
		return `SELECT a.id, a.slug, a.name, a.persona, a.status,
				a.breaker_failures AS "breakerFailures", a.breaker_tripped_at AS "breakerTrippedAt",
				a.created_at AS "createdAt", a.updated_at AS "updatedAt",
				(SELECT count(*) FROM ${deliverables} d WHERE d.agent_id = a.id)::int AS "deliverables",
				(SELECT count(*) FROM ${runs} r WHERE r.agent_id = a.id)::int AS "runs",
				lr.id AS "lastRunId", lr.status AS "lastRunStatus",
				lr.created_at AS "lastRunCreatedAt", lr.finished_at AS "lastRunFinishedAt"
			FROM ${agents} a
			LEFT JOIN LATERAL (
				SELECT id, status, created_at, finished_at FROM ${runs} r
				WHERE r.agent_id = a.id ORDER BY created_at DESC LIMIT 1
			) lr ON true
			${where}
			ORDER BY a.name`;
	}

	/** Every agent with its deliverable and run counts and its latest run. */
	async listRoster(): Promise<AonAgentSummary[]> {
		const rows = await this.manager.query<RosterRow[]>(this.rosterSql());
		return rows.map(toAgentSummary);
	}

	async findRosterBySlug(slug: string): Promise<AonAgentSummary | null> {
		const rows = await this.manager.query<RosterRow[]>(this.rosterSql('WHERE a.slug = $1'), [
			slug,
		]);
		return rows[0] ? toAgentSummary(rows[0]) : null;
	}

	async countByStatus(): Promise<Record<string, number>> {
		const rows = await this.manager.query<Array<{ status: string; count: number }>>(
			`SELECT status, count(*)::int AS count FROM ${this.table(AonAgent)} GROUP BY status`,
		);
		return Object.fromEntries(rows.map((r) => [r.status, r.count]));
	}

	async setStatus(id: string, status: string): Promise<void> {
		await this.update({ id }, { status, updatedAt: new Date() });
	}

	async resetBreaker(id: string): Promise<void> {
		await this.update({ id }, { breakerFailures: 0, breakerTrippedAt: null, updatedAt: new Date() });
	}

	/** Applied after a run finishes: `breakerAfter()` in run-machine.ts decides the numbers. */
	async applyBreakerOutcome(id: string, input: { failures: number; trippedAt: Date | null }): Promise<void> {
		await this.update(
			{ id },
			{ breakerFailures: input.failures, breakerTrippedAt: input.trippedAt, updatedAt: new Date() },
		);
	}
}
