import type { IrreversibleMigration, MigrationContext } from '../migration-types';

/**
 * Aon's own tables, moved into this instance's database from the retired
 * standalone Aon. Postgres only: memory chunks carry a pgvector embedding and
 * a tsvector, which SQLite cannot hold. Column names stay snake_case so the
 * old rows load with a plain COPY.
 */
export class CreateAonTables1789171200000 implements IrreversibleMigration {
	async up({ runQuery, escape }: MigrationContext) {
		const t = (name: string) => escape.tableName(name);
		const i = (name: string) => escape.indexName(name);

		await runQuery('CREATE EXTENSION IF NOT EXISTS vector');

		await runQuery(`CREATE TABLE ${t('aon_agents')} (
			id text PRIMARY KEY,
			slug text NOT NULL,
			name text NOT NULL,
			persona text NOT NULL,
			charter jsonb NOT NULL,
			status text NOT NULL DEFAULT 'draft',
			token_id text,
			breaker_failures integer NOT NULL DEFAULT 0,
			breaker_tripped_at timestamptz(3),
			created_by text NOT NULL,
			created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`);
		await runQuery(
			`CREATE UNIQUE INDEX ${i('aon_agents_slug_key')} ON ${t('aon_agents')} (slug)`,
		);
		await runQuery(`CREATE INDEX ${i('aon_agents_status_idx')} ON ${t('aon_agents')} (status)`);

		await runQuery(`CREATE TABLE ${t('aon_deliverables')} (
			id text PRIMARY KEY,
			slug text NOT NULL,
			agent_id text NOT NULL REFERENCES ${t('aon_agents')} (id) ON UPDATE CASCADE ON DELETE CASCADE,
			name text NOT NULL,
			dod text NOT NULL,
			shape text NOT NULL DEFAULT 'single',
			cadence text,
			tier integer NOT NULL DEFAULT 2,
			approver text NOT NULL DEFAULT 'owner',
			required_inputs jsonb,
			max_iterations integer NOT NULL DEFAULT 3,
			enabled boolean NOT NULL DEFAULT true,
			last_run_at timestamptz(3),
			created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`);
		await runQuery(
			`CREATE UNIQUE INDEX ${i('aon_deliverables_slug_key')} ON ${t('aon_deliverables')} (slug)`,
		);
		await runQuery(
			`CREATE INDEX ${i('aon_deliverables_agent_id_idx')} ON ${t('aon_deliverables')} (agent_id)`,
		);
		await runQuery(
			`CREATE INDEX ${i('aon_deliverables_enabled_shape_idx')} ON ${t('aon_deliverables')} (enabled, shape)`,
		);

		await runQuery(`CREATE TABLE ${t('aon_runs')} (
			id text PRIMARY KEY,
			deliverable_id text NOT NULL REFERENCES ${t('aon_deliverables')} (id) ON UPDATE CASCADE ON DELETE CASCADE,
			agent_id text NOT NULL REFERENCES ${t('aon_agents')} (id) ON UPDATE CASCADE ON DELETE CASCADE,
			parent_run_id text,
			status text NOT NULL DEFAULT 'queued',
			attempt integer NOT NULL DEFAULT 1,
			iteration integer NOT NULL DEFAULT 1,
			trigger text NOT NULL DEFAULT 'manual',
			input jsonb,
			output text,
			output_page_id text,
			verification jsonb,
			help text,
			model text,
			tokens_in integer NOT NULL DEFAULT 0,
			tokens_out integer NOT NULL DEFAULT 0,
			cost_eur double precision NOT NULL DEFAULT 0,
			claimed_by text,
			heartbeat_at timestamptz(3),
			approval_id text,
			started_at timestamptz(3),
			finished_at timestamptz(3),
			created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`);
		await runQuery(
			`CREATE INDEX ${i('aon_runs_agent_id_created_at_idx')} ON ${t('aon_runs')} (agent_id, created_at)`,
		);
		await runQuery(
			`CREATE INDEX ${i('aon_runs_deliverable_id_created_at_idx')} ON ${t('aon_runs')} (deliverable_id, created_at)`,
		);
		await runQuery(
			`CREATE INDEX ${i('aon_runs_status_created_at_idx')} ON ${t('aon_runs')} (status, created_at)`,
		);

		await runQuery(`CREATE TABLE ${t('aon_learned_rules')} (
			id text PRIMARY KEY,
			agent_id text,
			text text NOT NULL,
			source_run_id text,
			evidence jsonb,
			state text NOT NULL DEFAULT 'canary',
			created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
			revoked_at timestamptz(3),
			reason text
		)`);
		await runQuery(
			`CREATE INDEX ${i('aon_learned_rules_agent_id_state_idx')} ON ${t('aon_learned_rules')} (agent_id, state)`,
		);

		await runQuery(`CREATE TABLE ${t('aon_sources')} (
			id text PRIMARY KEY,
			origin text NOT NULL,
			external_id text,
			title text NOT NULL,
			content text NOT NULL,
			meta jsonb,
			kind text NOT NULL DEFAULT 'text',
			status text NOT NULL DEFAULT 'new',
			content_hash text,
			doc_time timestamptz(3),
			indexed_at timestamptz(3),
			extracted_at timestamptz(3),
			created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`);
		await runQuery(
			`CREATE UNIQUE INDEX ${i('aon_sources_origin_external_id_key')} ON ${t('aon_sources')} (origin, external_id)`,
		);
		await runQuery(
			`CREATE INDEX ${i('aon_sources_created_at_idx')} ON ${t('aon_sources')} (created_at)`,
		);
		await runQuery(`CREATE INDEX ${i('aon_sources_status_idx')} ON ${t('aon_sources')} (status)`);

		await runQuery(`CREATE TABLE ${t('aon_chunks')} (
			id text PRIMARY KEY,
			source_id text NOT NULL REFERENCES ${t('aon_sources')} (id) ON UPDATE CASCADE ON DELETE CASCADE,
			seq integer NOT NULL,
			text text NOT NULL,
			tokens integer NOT NULL DEFAULT 0,
			embedding vector(1024),
			tsv tsvector,
			embedded_at timestamptz(3),
			created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`);
		await runQuery(
			`CREATE UNIQUE INDEX ${i('aon_chunks_source_id_seq_key')} ON ${t('aon_chunks')} (source_id, seq)`,
		);
		await runQuery(
			`CREATE INDEX ${i('aon_chunks_embedded_at_idx')} ON ${t('aon_chunks')} (embedded_at)`,
		);
		await runQuery(`CREATE INDEX ${i('aon_chunks_tsv_idx')} ON ${t('aon_chunks')} USING gin (tsv)`);
		await runQuery(
			`CREATE INDEX ${i('aon_chunks_embedding_idx')} ON ${t('aon_chunks')} USING hnsw (embedding vector_cosine_ops)`,
		);

		// The text index maintains itself: every insert or edit of a chunk's text rewrites its tsvector.
		await runQuery(`CREATE OR REPLACE FUNCTION ${escape.functionName('aon_chunks_tsv_update')}()
			RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN
				NEW.tsv := to_tsvector('simple', coalesce(NEW.text, ''));
				RETURN NEW;
			END $$`);
		await runQuery(`CREATE TRIGGER ${escape.triggerName('aon_chunks_tsv_trg')}
			BEFORE INSERT OR UPDATE OF text ON ${t('aon_chunks')}
			FOR EACH ROW EXECUTE FUNCTION ${escape.functionName('aon_chunks_tsv_update')}()`);
	}
}
