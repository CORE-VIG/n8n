import type { AonGuardApproval as AonGuardApprovalApi } from '@n8n/api-types';
import { Service } from '@n8n/di';
import { DataSource, Repository } from '@n8n/typeorm';
import { randomUUID } from 'node:crypto';

import { AonGuardApproval } from '../entities/aon-guard-approval.entity';

interface ApprovalRow {
	id: string;
	identity: string;
	opClass: string;
	tier: number;
	summary: string;
	body: Record<string, unknown> | null;
	runId: string | null;
	status: string;
	decidedBy: string | null;
	decidedAt: Date | null;
	expiresAt: Date;
	createdAt: Date;
}

const STATUSES: readonly string[] = ['pending', 'approved', 'denied', 'expired'];

function isStatus(value: string): value is AonGuardApprovalApi['status'] {
	return STATUSES.includes(value);
}

const toApproval = (row: ApprovalRow): AonGuardApprovalApi => ({
	id: row.id,
	identity: row.identity,
	opClass: row.opClass,
	tier: row.tier,
	summary: row.summary,
	body: row.body,
	runId: row.runId,
	status: isStatus(row.status) ? row.status : 'pending',
	decidedBy: row.decidedBy,
	decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
	expiresAt: row.expiresAt.toISOString(),
	createdAt: row.createdAt.toISOString(),
});

/**
 * Cards raised for the owner: asked, then approved, denied, or expired.
 * Named `insertNew`/`decide` rather than `insert`/`update`:
 * `Repository.insert`/`Repository.update` already exist with incompatible
 * shapes (see `AonTurnRepository.addTurn` for the same reasoning).
 */
@Service()
export class AonGuardApprovalRepository extends Repository<AonGuardApproval> {
	constructor(dataSource: DataSource) {
		super(AonGuardApproval, dataSource.manager);
	}

	private table(): string {
		return this.manager.connection.driver.escape(this.metadata.tableName);
	}

	async insertNew(input: {
		identity: string;
		opClass: string;
		tier: number;
		summary: string;
		body: Record<string, unknown> | null;
		runId: string | null;
		expiresAt: Date;
	}): Promise<AonGuardApprovalApi> {
		const row = await this.save(
			this.create({
				id: randomUUID(),
				identity: input.identity,
				opClass: input.opClass,
				tier: input.tier,
				summary: input.summary,
				body: input.body,
				runId: input.runId,
				status: 'pending',
				decidedBy: null,
				decidedAt: null,
				expiresAt: input.expiresAt,
				createdAt: new Date(),
			}),
		);
		return toApproval(row);
	}

	async findById(id: string): Promise<AonGuardApprovalApi | null> {
		const row = await this.findOneBy({ id });
		return row ? toApproval(row) : null;
	}

	/** The newest pending card a run is waiting on, if any. */
	async findPendingForRun(runId: string): Promise<AonGuardApprovalApi | null> {
		const row = await this.findOne({
			where: { runId, status: 'pending' },
			order: { createdAt: 'DESC' },
		});
		return row ? toApproval(row) : null;
	}

	async listPending(): Promise<AonGuardApprovalApi[]> {
		const rows = await this.find({ where: { status: 'pending' }, order: { createdAt: 'DESC' } });
		return rows.map(toApproval);
	}

	/** The owner's yes or no. Returns null when the card was not pending any more. */
	async decide(
		id: string,
		status: 'approved' | 'denied',
		decidedBy: string,
	): Promise<AonGuardApprovalApi | null> {
		const result = await this.update({ id, status: 'pending' }, { status, decidedBy, decidedAt: new Date() });
		if (result.affected !== 1) return null;
		return await this.findById(id);
	}

	/** Pending cards whose deadline passed: marks them expired and hands back what changed. */
	async expireOlderThan(now: Date): Promise<AonGuardApprovalApi[]> {
		const rows = await this.manager.query<ApprovalRow[]>(
			`UPDATE ${this.table()} SET status = 'expired'
			 WHERE status = 'pending' AND expires_at < $1
			 RETURNING id, identity, op_class AS "opClass", tier, summary, body, run_id AS "runId",
				status, decided_by AS "decidedBy", decided_at AS "decidedAt",
				expires_at AS "expiresAt", created_at AS "createdAt"`,
			[now],
		);
		return rows.map(toApproval);
	}
}
