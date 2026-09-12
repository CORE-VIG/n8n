import type { AonGuardPolicy as AonGuardPolicyApi, AonGuardPolicyVerdict } from '@n8n/api-types';
import { Service } from '@n8n/di';
import { DataSource, In, Repository } from '@n8n/typeorm';
import { randomUUID } from 'node:crypto';

import { AonGuardPolicy } from '../entities/aon-guard-policy.entity';

interface PolicyRow {
	id: string;
	identity: string;
	opClass: string;
	verdict: string;
	note: string | null;
	updatedAt: Date;
}

const POLICY_VERDICTS: readonly string[] = ['allow', 'ask', 'deny', 'council'];

function isPolicyVerdict(value: string): value is AonGuardPolicyVerdict {
	return POLICY_VERDICTS.includes(value);
}

const toPolicy = (row: PolicyRow): AonGuardPolicyApi => ({
	id: row.id,
	identity: row.identity,
	opClass: row.opClass,
	verdict: isPolicyVerdict(row.verdict) ? row.verdict : 'ask',
	note: row.note,
	updatedAt: row.updatedAt.toISOString(),
});

/**
 * What each identity may do by itself, one row per (identity, op class).
 * Named `upsertPolicy`, not `upsert`: `Repository.upsert` already exists
 * with an incompatible shape (see `AonTurnRepository.addTurn` for the same
 * reasoning). It also writes through raw SQL rather than the base
 * `Repository.upsert`, which would put the freshly generated `id` in its
 * `ON CONFLICT ... DO UPDATE SET` (it overwrites every column present in the
 * value literal, and `id` must be present for the insert branch), churning
 * the row's primary key on every save.
 */
@Service()
export class AonGuardPolicyRepository extends Repository<AonGuardPolicy> {
	constructor(dataSource: DataSource) {
		super(AonGuardPolicy, dataSource.manager);
	}

	private table(): string {
		return this.manager.connection.driver.escape(this.metadata.tableName);
	}

	/** Every policy row for any of these identity strings, across all op classes. */
	async findFor(identities: string[]): Promise<AonGuardPolicyApi[]> {
		if (identities.length === 0) return [];
		const rows = await this.find({ where: { identity: In(identities) } });
		return rows.map(toPolicy);
	}

	async listAll(): Promise<AonGuardPolicyApi[]> {
		const rows = await this.find({ order: { identity: 'ASC', opClass: 'ASC' } });
		return rows.map(toPolicy);
	}

	async upsertPolicy(input: {
		identity: string;
		opClass: string;
		verdict: string;
		note: string | null;
	}): Promise<AonGuardPolicyApi> {
		const rows = await this.manager.query<PolicyRow[]>(
			`INSERT INTO ${this.table()} (id, identity, op_class, verdict, note, updated_at)
			 VALUES ($1, $2, $3, $4, $5, now())
			 ON CONFLICT (identity, op_class) DO UPDATE
			 SET verdict = EXCLUDED.verdict, note = EXCLUDED.note, updated_at = EXCLUDED.updated_at
			 RETURNING id, identity, op_class AS "opClass", verdict, note, updated_at AS "updatedAt"`,
			[randomUUID(), input.identity, input.opClass, input.verdict, input.note],
		);
		return toPolicy(rows[0]);
	}

	async deleteById(id: string): Promise<boolean> {
		const result = await this.delete({ id });
		return result.affected === 1;
	}
}
