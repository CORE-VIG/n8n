import type { AonRunDetail, AonRunSummary } from '@n8n/api-types';
import { Service } from '@n8n/di';

import { returningRows } from '@/modules/aon-core/database/returning-rows';
import { DataSource, In, LessThan, Repository } from '@n8n/typeorm';

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

	// --- executor -----------------------------------------------------

	/** Oldest queued runs first, for the executor to check for claimability. */
	async listQueuedOldestFirst(limit: number): Promise<AonRun[]> {
		return await this.find({ where: { status: 'queued' }, order: { createdAt: 'ASC' }, take: limit });
	}

	/**
	 * Claims one specific queued run for this process, atomically: a run
	 * another claimer (or a concurrent tick) already took is skipped rather
	 * than waited on. Returns null when it could not be claimed.
	 */
	async claimForExecution(id: string): Promise<AonRun | null> {
		const raw: unknown = await this.manager.query(
			`UPDATE ${this.table(AonRun)}
			SET status = 'working', claimed_by = 'executor', started_at = now(), heartbeat_at = now(), updated_at = now()
			WHERE id = (
				SELECT id FROM ${this.table(AonRun)}
				WHERE id = $1 AND status = 'queued'
				FOR UPDATE SKIP LOCKED
			)
			RETURNING id`,
			[id],
		);
		const claimedId = returningRows<{ id: string }>(raw)[0]?.id;
		return claimedId ? await this.findOneBy({ id: claimedId }) : null;
	}

	/** `working`/`validating` runs whose heartbeat has gone stale. */
	async listStuck(deadMs: number): Promise<AonRun[]> {
		const cutoff = new Date(Date.now() - deadMs);
		return await this.find({ where: { status: In(['working', 'validating']), heartbeatAt: LessThan(cutoff) } });
	}

	async listByStatus(status: string): Promise<AonRun[]> {
		return await this.find({ where: { status } });
	}

	/** True when a deliverable already has a run in flight: a routine must not double-queue it. */
	async hasInFlightForDeliverable(deliverableId: string): Promise<boolean> {
		const rows = await this.manager.query<Array<{ exists: boolean }>>(
			`SELECT EXISTS (
				SELECT 1 FROM ${this.table(AonRun)}
				WHERE deliverable_id = $1 AND status IN ('queued', 'working', 'validating', 'waiting_approval')
			) AS exists`,
			[deliverableId],
		);
		return rows[0]?.exists ?? false;
	}

	/** This month's spend for one agent, at list price, in euros. */
	async sumCostEurThisMonth(agentId: string): Promise<number> {
		const rows = await this.manager.query<Array<{ sum: number | null }>>(
			`SELECT COALESCE(sum(cost_eur), 0)::float8 AS sum
			FROM ${this.table(AonRun)}
			WHERE agent_id = $1 AND created_at >= date_trunc('month', CURRENT_TIMESTAMP)`,
			[agentId],
		);
		return rows[0]?.sum ?? 0;
	}

	async createQueued(input: {
		id: string;
		deliverableId: string;
		agentId: string;
		parentRunId: string | null;
		iteration: number;
		attempt: number;
		trigger: string;
		input: Record<string, unknown> | null;
	}): Promise<AonRun> {
		// Raw SQL: TypeORM's partial-entity typing has no room for a nullable jsonb value.
		await this.manager.query(
			`INSERT INTO ${this.table(AonRun)} (id, deliverable_id, agent_id, parent_run_id, status, attempt, iteration, trigger, input, created_at, updated_at)
			VALUES ($1, $2, $3, $4, 'queued', $5, $6, $7, $8::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
			[
				input.id,
				input.deliverableId,
				input.agentId,
				input.parentRunId,
				input.attempt,
				input.iteration,
				input.trigger,
				input.input === null ? null : JSON.stringify(input.input),
			],
		);
		return await this.findOneByOrFail({ id: input.id });
	}

	async setWorking(id: string): Promise<void> {
		await this.update({ id }, { status: 'working', heartbeatAt: new Date(), updatedAt: new Date() });
	}

	async setValidating(id: string): Promise<void> {
		await this.update({ id }, { status: 'validating', updatedAt: new Date() });
	}

	async setDone(
		id: string,
		input: { output: string; verification: Record<string, unknown> | null },
	): Promise<void> {
		await this.manager.query(
			`UPDATE ${this.table(AonRun)} SET status = 'done', output = $2, verification = $3::jsonb,
				finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
			[id, input.output, input.verification === null ? null : JSON.stringify(input.verification)],
		);
	}

	async setWaitingApproval(
		id: string,
		input: { approvalId: string; output: string; verification?: Record<string, unknown> | null },
	): Promise<void> {
		await this.manager.query(
			`UPDATE ${this.table(AonRun)} SET status = 'waiting_approval', approval_id = $2, output = $3,
				verification = $4::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
			[id, input.approvalId, input.output, input.verification ? JSON.stringify(input.verification) : null],
		);
	}

	async setNeedsHelp(
		id: string,
		help: string,
		verification: Record<string, unknown> | null = null,
	): Promise<void> {
		await this.manager.query(
			`UPDATE ${this.table(AonRun)} SET status = 'needs_help', help = $2, verification = $3::jsonb,
				updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
			[id, help, verification === null ? null : JSON.stringify(verification)],
		);
	}

	async setFailed(id: string, help: string): Promise<void> {
		await this.update({ id }, { status: 'failed', help, finishedAt: new Date(), updatedAt: new Date() });
	}

	async setStopped(id: string, help: string | null): Promise<void> {
		await this.update({ id }, { status: 'stopped', help, finishedAt: new Date(), updatedAt: new Date() });
	}

	async touchHeartbeat(id: string): Promise<void> {
		await this.update({ id }, { heartbeatAt: new Date() });
	}

	/** Adds to the run's usage rather than replacing it: a resume keeps the first attempt's cost. */
	async addUsage(
		id: string,
		input: { model: string | null; tokensIn: number; tokensOut: number; costEur: number },
	): Promise<void> {
		await this.manager.query(
			`UPDATE ${this.table(AonRun)}
			SET model = COALESCE($2, model),
				tokens_in = tokens_in + $3,
				tokens_out = tokens_out + $4,
				cost_eur = cost_eur + $5,
				updated_at = now()
			WHERE id = $1`,
			[id, input.model, input.tokensIn, input.tokensOut, input.costEur],
		);
	}
}
