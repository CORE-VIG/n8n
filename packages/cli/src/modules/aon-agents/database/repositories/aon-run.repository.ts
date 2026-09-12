import type { AonRunDetail, AonRunSummary } from '@n8n/api-types';
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

interface RunDetailRow
	extends Omit<
		AonRunDetail,
		'startedAt' | 'finishedAt' | 'createdAt' | 'heartbeatAt' | 'updatedAt'
	> {
	startedAt: Date | null;
	finishedAt: Date | null;
	createdAt: Date;
	heartbeatAt: Date | null;
	updatedAt: Date;
}

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

/** The columns a summary needs, aliased to camelCase; `r`/`a`/`d` are the joined tables below. */
const SUMMARY_COLUMNS = `r.id, r.agent_id AS "agentId", a.slug AS "agentSlug", a.name AS "agentName",
	r.deliverable_id AS "deliverableId", d.name AS "deliverableName",
	r.status, r.attempt, r.iteration, r.trigger AS "invokedBy", r.model,
	r.tokens_in AS "tokensIn", r.tokens_out AS "tokensOut", r.cost_eur AS "costEur", r.help,
	r.started_at AS "startedAt", r.finished_at AS "finishedAt", r.created_at AS "createdAt"`;

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

	private toSummary(row: RunRow): AonRunSummary {
		return {
			...row,
			startedAt: iso(row.startedAt),
			finishedAt: iso(row.finishedAt),
			createdAt: iso(row.createdAt) ?? '',
		};
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
			`SELECT ${SUMMARY_COLUMNS}
			FROM ${this.table(AonRun)} r
			LEFT JOIN ${this.table(AonAgent)} a ON a.id = r.agent_id
			LEFT JOIN ${this.table(AonDeliverable)} d ON d.id = r.deliverable_id
			WHERE ($1::text IS NULL OR r.agent_id = $1)
			ORDER BY r.created_at DESC
			LIMIT $2`,
			[agentId ?? null, limit],
		);
		return rows.map((row) => this.toSummary(row));
	}

	/** Newest first, filtered by agent and/or status, with the total the filters match. */
	async list({
		agentId,
		status,
		limit,
		offset,
	}: {
		agentId?: string;
		status?: string;
		limit: number;
		offset: number;
	}): Promise<{ items: AonRunSummary[]; total: number }> {
		const filters = `WHERE ($1::text IS NULL OR r.agent_id = $1)
			AND ($2::text IS NULL OR r.status = $2)`;
		const [rows, totalRows] = await Promise.all([
			this.manager.query<RunRow[]>(
				`SELECT ${SUMMARY_COLUMNS}
				FROM ${this.table(AonRun)} r
				LEFT JOIN ${this.table(AonAgent)} a ON a.id = r.agent_id
				LEFT JOIN ${this.table(AonDeliverable)} d ON d.id = r.deliverable_id
				${filters}
				ORDER BY r.created_at DESC
				LIMIT $3 OFFSET $4`,
				[agentId ?? null, status ?? null, limit, offset],
			),
			this.manager.query<Array<{ count: number }>>(
				`SELECT count(*)::int AS count FROM ${this.table(AonRun)} r ${filters}`,
				[agentId ?? null, status ?? null],
			),
		]);
		return { items: rows.map((row) => this.toSummary(row)), total: totalRows[0]?.count ?? 0 };
	}

	/** Every column a run has, with the names a detail page needs. */
	async findDetail(id: string): Promise<AonRunDetail | null> {
		const rows = await this.manager.query<RunDetailRow[]>(
			`SELECT ${SUMMARY_COLUMNS}, r.parent_run_id AS "parentRunId",
				r.input, r.output, r.output_page_id AS "outputPageId", r.verification,
				r.claimed_by AS "claimedBy", r.heartbeat_at AS "heartbeatAt", r.approval_id AS "approvalId",
				r.updated_at AS "updatedAt"
			FROM ${this.table(AonRun)} r
			LEFT JOIN ${this.table(AonAgent)} a ON a.id = r.agent_id
			LEFT JOIN ${this.table(AonDeliverable)} d ON d.id = r.deliverable_id
			WHERE r.id = $1`,
			[id],
		);
		const row = rows[0];
		if (!row) return null;
		return {
			...row,
			startedAt: iso(row.startedAt),
			finishedAt: iso(row.finishedAt),
			createdAt: iso(row.createdAt) ?? '',
			heartbeatAt: iso(row.heartbeatAt),
			updatedAt: iso(row.updatedAt) ?? '',
		};
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
