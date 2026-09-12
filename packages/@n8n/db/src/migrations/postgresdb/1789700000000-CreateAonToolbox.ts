import type { IrreversibleMigration, MigrationContext } from '../migration-types';

/**
 * The toolbox: what Aon can reach for but does not contain — a skill on
 * disk, a script, an MCP server, a CLI. Moved from the retired standalone
 * Aon, same shape (snake_case) so the old `tools` rows load with a plain
 * COPY. `aon_toolbox_slug_key` keeps one row per tool across rescans.
 */
export class CreateAonToolbox1789700000000 implements IrreversibleMigration {
	async up({ runQuery, escape }: MigrationContext) {
		const t = (name: string) => escape.tableName(name);
		const i = (name: string) => escape.indexName(name);

		await runQuery(`CREATE TABLE ${t('aon_toolbox')} (
			id text PRIMARY KEY,
			slug text NOT NULL,
			kind text NOT NULL,
			name text NOT NULL,
			summary text NOT NULL,
			location text NOT NULL,
			invocation text,
			tags text[] NOT NULL DEFAULT ARRAY[]::text[],
			source text NOT NULL DEFAULT 'disk',
			missing_since timestamptz(3),
			uses integer NOT NULL DEFAULT 0,
			last_used_at timestamptz(3),
			last_used_by text,
			meta jsonb,
			when_to_use text,
			est_tokens integer NOT NULL DEFAULT 0,
			created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`);
		await runQuery(`CREATE UNIQUE INDEX ${i('aon_toolbox_slug_key')} ON ${t('aon_toolbox')} (slug)`);
		await runQuery(`CREATE INDEX ${i('aon_toolbox_kind_idx')} ON ${t('aon_toolbox')} (kind)`);
		await runQuery(
			`CREATE INDEX ${i('aon_toolbox_missing_since_idx')} ON ${t('aon_toolbox')} (missing_since)`,
		);
	}
}
