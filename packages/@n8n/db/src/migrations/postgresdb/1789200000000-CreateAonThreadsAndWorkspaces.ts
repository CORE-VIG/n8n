import type { IrreversibleMigration, MigrationContext } from '../migration-types';

/**
 * The assistant's conversations (threads and their turns) and the named
 * Hands workspaces, per user. Postgres only, like the other aon_* tables.
 */
export class CreateAonThreadsAndWorkspaces1789200000000 implements IrreversibleMigration {
	async up({ runQuery, escape }: MigrationContext) {
		const t = (name: string) => escape.tableName(name);
		const i = (name: string) => escape.indexName(name);
		const user = t('user');

		await runQuery(`CREATE TABLE ${t('aon_threads')} (
			id text PRIMARY KEY,
			user_id uuid NOT NULL REFERENCES ${user} (id) ON DELETE CASCADE,
			title text,
			claude_session_id text,
			created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
			last_turn_at timestamptz(3)
		)`);
		await runQuery(
			`CREATE INDEX ${i('aon_threads_user_id_last_turn_at_idx')} ON ${t('aon_threads')} (user_id, last_turn_at DESC)`,
		);

		await runQuery(`CREATE TABLE ${t('aon_turns')} (
			id text PRIMARY KEY,
			thread_id text NOT NULL REFERENCES ${t('aon_threads')} (id) ON DELETE CASCADE,
			role text NOT NULL,
			text text NOT NULL DEFAULT '',
			tools jsonb,
			cost_usd double precision NOT NULL DEFAULT 0,
			created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`);
		await runQuery(
			`CREATE INDEX ${i('aon_turns_thread_id_created_at_idx')} ON ${t('aon_turns')} (thread_id, created_at)`,
		);

		await runQuery(`CREATE TABLE ${t('aon_workspaces')} (
			id text PRIMARY KEY,
			user_id uuid NOT NULL REFERENCES ${user} (id) ON DELETE CASCADE,
			slug text NOT NULL,
			created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
			last_used_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`);
		await runQuery(
			`CREATE UNIQUE INDEX ${i('aon_workspaces_user_id_slug_key')} ON ${t('aon_workspaces')} (user_id, slug)`,
		);
	}
}
