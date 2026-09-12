import type { IrreversibleMigration, MigrationContext } from '../migration-types';

/**
 * Memory's graph: entities and the facts that connect them, plus the
 * observations dreamed up from them. Moved from the retired standalone Aon,
 * same shape (snake_case, `vector(1024)` on entities) so the old rows load
 * with a plain COPY. `aon_facts.source_chunk_id` carries no foreign key: a
 * fact's evidence chunk may already be gone.
 */
export class CreateAonEntitiesAndFacts1789400000000 implements IrreversibleMigration {
	async up({ runQuery, escape }: MigrationContext) {
		const t = (name: string) => escape.tableName(name);
		const i = (name: string) => escape.indexName(name);

		await runQuery(`CREATE TABLE ${t('aon_entities')} (
			id text PRIMARY KEY,
			name text NOT NULL,
			kind text NOT NULL DEFAULT 'unknown',
			aliases text[] NOT NULL DEFAULT ARRAY[]::text[],
			summary text,
			embedding vector(1024),
			merged_into_id text,
			merged_at timestamptz(3),
			created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`);
		await runQuery(
			`CREATE INDEX ${i('aon_entities_lower_name_idx')} ON ${t('aon_entities')} (lower(name))`,
		);
		await runQuery(`CREATE INDEX ${i('aon_entities_kind_idx')} ON ${t('aon_entities')} (kind)`);

		await runQuery(`CREATE TABLE ${t('aon_facts')} (
			id text PRIMARY KEY,
			subject_id text NOT NULL REFERENCES ${t('aon_entities')} (id) ON DELETE CASCADE,
			predicate text NOT NULL,
			object_id text REFERENCES ${t('aon_entities')} (id) ON DELETE CASCADE,
			object_value text,
			valid_from timestamptz(3),
			valid_to timestamptz(3),
			recorded_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
			retracted_at timestamptz(3),
			status text NOT NULL DEFAULT 'pending',
			confidence double precision,
			proposed_by text NOT NULL,
			source_chunk_id text,
			quote text,
			contradicts_id text,
			decided_by text,
			decided_at timestamptz(3),
			note text
		)`);
		await runQuery(`CREATE INDEX ${i('aon_facts_subject_id_idx')} ON ${t('aon_facts')} (subject_id)`);
		await runQuery(`CREATE INDEX ${i('aon_facts_object_id_idx')} ON ${t('aon_facts')} (object_id)`);
		await runQuery(`CREATE INDEX ${i('aon_facts_status_idx')} ON ${t('aon_facts')} (status)`);

		await runQuery(`CREATE TABLE ${t('aon_observations')} (
			id text PRIMARY KEY,
			bucket text NOT NULL,
			text text NOT NULL,
			salience double precision NOT NULL,
			evidence jsonb,
			first_seen timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
			last_seen timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
			dream_id text,
			status text NOT NULL DEFAULT 'active'
		)`);
		await runQuery(
			`CREATE INDEX ${i('aon_observations_bucket_status_idx')} ON ${t('aon_observations')} (bucket, status)`,
		);
	}
}
