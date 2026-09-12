import type { IrreversibleMigration, MigrationContext } from '../migration-types';

/**
 * Guard's memory (policies, approvals, the audit trail) and a run's live log.
 * Postgres only, like the other aon_* tables.
 */
export class CreateAonGuardAndRunEvents1789300000000 implements IrreversibleMigration {
	async up({ runQuery, escape }: MigrationContext) {
		const t = (name: string) => escape.tableName(name);
		const i = (name: string) => escape.indexName(name);

		await runQuery(`CREATE TABLE ${t('aon_guard_policies')} (
			id text PRIMARY KEY,
			identity text NOT NULL,
			op_class text NOT NULL,
			verdict text NOT NULL,
			note text,
			updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`);
		await runQuery(
			`CREATE UNIQUE INDEX ${i('aon_guard_policies_identity_op_class_key')} ON ${t('aon_guard_policies')} (identity, op_class)`,
		);

		await runQuery(`CREATE TABLE ${t('aon_guard_approvals')} (
			id text PRIMARY KEY,
			identity text NOT NULL,
			op_class text NOT NULL,
			tier integer NOT NULL,
			summary text NOT NULL,
			body jsonb,
			run_id text,
			status text NOT NULL DEFAULT 'pending',
			decided_by text,
			decided_at timestamptz(3),
			expires_at timestamptz(3) NOT NULL,
			created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`);
		await runQuery(
			`CREATE INDEX ${i('aon_guard_approvals_status_created_at_idx')} ON ${t('aon_guard_approvals')} (status, created_at)`,
		);
		await runQuery(
			`CREATE INDEX ${i('aon_guard_approvals_run_id_idx')} ON ${t('aon_guard_approvals')} (run_id)`,
		);

		await runQuery(`CREATE TABLE ${t('aon_guard_events')} (
			id bigserial PRIMARY KEY,
			ts timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
			identity text NOT NULL,
			op_class text NOT NULL,
			tier integer NOT NULL,
			verdict text NOT NULL,
			approval_id text,
			meta jsonb
		)`);
		await runQuery(`CREATE INDEX ${i('aon_guard_events_ts_idx')} ON ${t('aon_guard_events')} (ts DESC)`);

		await runQuery(`CREATE TABLE ${t('aon_run_events')} (
			id bigserial PRIMARY KEY,
			run_id text NOT NULL REFERENCES ${t('aon_runs')} (id) ON DELETE CASCADE,
			seq integer NOT NULL,
			type text NOT NULL,
			name text,
			status text,
			text text,
			created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`);
		await runQuery(
			`CREATE INDEX ${i('aon_run_events_run_id_seq_idx')} ON ${t('aon_run_events')} (run_id, seq)`,
		);
	}
}
