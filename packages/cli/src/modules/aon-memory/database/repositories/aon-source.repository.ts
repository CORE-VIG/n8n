import type {
	AonChunkSummary,
	AonMemoryOverview,
	AonSourceDetail,
	AonSourceList,
	AonSourceSummary,
} from '@n8n/api-types';
import { Service } from '@n8n/di';
import { DataSource, Repository } from '@n8n/typeorm';

import { AonChunk } from '../entities/aon-chunk.entity';
import { AonSource } from '../entities/aon-source.entity';

interface SourceRow {
	id: string;
	origin: string;
	kind: string;
	status: string;
	title: string;
	externalId: string | null;
	docTime: Date | null;
	indexedAt: Date | null;
	createdAt: Date;
	bytes: number;
	chunkCount: number;
	embeddedCount: number;
}

interface SourceDetailRow extends SourceRow {
	content: string;
	meta: Record<string, unknown> | null;
	extractedAt: Date | null;
}

/** One source the extractor may still read: never extracted, indexed, ready for a model turn. */
export interface AonUnextractedSourceRow {
	id: string;
	title: string;
	origin: string;
	kind: string;
	content: string;
	docTime: Date | null;
}

export interface AonSourceKindCount {
	kind: string;
	count: number;
}

interface ChunkRow {
	id: string;
	seq: number;
	tokens: number;
	text: string;
	embeddedAt: Date | null;
}

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

const toSummary = (r: SourceRow): AonSourceSummary => ({
	...r,
	docTime: iso(r.docTime),
	indexedAt: iso(r.indexedAt),
	createdAt: iso(r.createdAt) ?? '',
});

const toChunkSummary = (r: ChunkRow): AonChunkSummary => ({
	...r,
	embeddedAt: iso(r.embeddedAt),
});

@Service()
export class AonSourceRepository extends Repository<AonSource> {
	constructor(dataSource: DataSource) {
		super(AonSource, dataSource.manager);
	}

	private get table() {
		return this.manager.connection.driver.escape(this.metadata.tableName);
	}

	private get chunksTable() {
		return this.manager.connection.driver.escape(
			this.manager.connection.getMetadata(AonChunk).tableName,
		);
	}

	/** Every source listing needs identity, timestamps and its chunk counts. */
	private get summaryColumns() {
		return `s.id, s.origin, s.kind, s.status, s.title, s.external_id AS "externalId",
			s.doc_time AS "docTime", s.indexed_at AS "indexedAt", s.created_at AS "createdAt",
			octet_length(s.content)::int AS bytes,
			(SELECT count(*)::int FROM ${this.chunksTable} c WHERE c.source_id = s.id) AS "chunkCount",
			(SELECT count(*)::int FROM ${this.chunksTable} c WHERE c.source_id = s.id
				AND c.embedded_at IS NOT NULL) AS "embeddedCount"`;
	}

	async countAll(): Promise<number> {
		return await this.count();
	}

	async countByOrigin(top: number): Promise<AonMemoryOverview['byOrigin']> {
		return await this.manager.query<AonMemoryOverview['byOrigin']>(
			`SELECT origin, count(*)::int AS count FROM ${this.table}
			GROUP BY origin ORDER BY count DESC, origin LIMIT $1`,
			[top],
		);
	}

	async lastIndexedAt(): Promise<string | null> {
		const rows = await this.manager.query<Array<{ last: Date | null }>>(
			`SELECT max(indexed_at) AS last FROM ${this.table}`,
		);
		return rows[0]?.last ? new Date(rows[0].last).toISOString() : null;
	}

	/**
	 * A page of sources, newest first, plus the origin counts that build the
	 * filter chips. `origins` ignores the `origin` filter (but not `q` or
	 * `status`) so every chip keeps a useful count while one is selected.
	 */
	async listSources({
		q,
		origin,
		status,
		limit,
		offset,
	}: {
		q?: string;
		origin?: string;
		status?: string;
		limit: number;
		offset: number;
	}): Promise<AonSourceList> {
		const [items, totalRows, origins] = await Promise.all([
			this.manager.query<SourceRow[]>(
				`SELECT ${this.summaryColumns}
				FROM ${this.table} s
				WHERE ($1::text IS NULL OR s.title ILIKE '%' || $1 || '%')
					AND ($2::text IS NULL OR s.origin = $2)
					AND ($3::text IS NULL OR s.status = $3)
				ORDER BY s.created_at DESC
				LIMIT $4 OFFSET $5`,
				[q ?? null, origin ?? null, status ?? null, limit, offset],
			),
			this.manager.query<Array<{ count: number }>>(
				`SELECT count(*)::int AS count FROM ${this.table} s
				WHERE ($1::text IS NULL OR s.title ILIKE '%' || $1 || '%')
					AND ($2::text IS NULL OR s.origin = $2)
					AND ($3::text IS NULL OR s.status = $3)`,
				[q ?? null, origin ?? null, status ?? null],
			),
			this.manager.query<AonSourceList['origins']>(
				`SELECT s.origin, count(*)::int AS count FROM ${this.table} s
				WHERE ($1::text IS NULL OR s.title ILIKE '%' || $1 || '%')
					AND ($2::text IS NULL OR s.status = $2)
				GROUP BY s.origin ORDER BY count DESC, s.origin`,
				[q ?? null, status ?? null],
			),
		]);

		return { items: items.map(toSummary), total: totalRows[0]?.count ?? 0, origins };
	}

	async findDetail(id: string): Promise<AonSourceDetail | null> {
		const rows = await this.manager.query<SourceDetailRow[]>(
			`SELECT ${this.summaryColumns}, s.content, s.meta, s.extracted_at AS "extractedAt"
			FROM ${this.table} s
			WHERE s.id = $1`,
			[id],
		);
		const row = rows[0];
		if (!row) return null;

		const chunkRows = await this.manager.query<ChunkRow[]>(
			`SELECT id, seq, tokens, text, embedded_at AS "embeddedAt"
			FROM ${this.chunksTable}
			WHERE source_id = $1
			ORDER BY seq`,
			[id],
		);

		return {
			...toSummary(row),
			content: row.content,
			meta: row.meta,
			extractedAt: iso(row.extractedAt),
			chunks: chunkRows.map(toChunkSummary),
		};
	}

	async findByHash(origin: string, contentHash: string): Promise<AonSourceSummary | null> {
		const rows = await this.manager.query<SourceRow[]>(
			`SELECT ${this.summaryColumns} FROM ${this.table} s
			WHERE s.origin = $1 AND s.content_hash = $2
			LIMIT 1`,
			[origin, contentHash],
		);
		return rows[0] ? toSummary(rows[0]) : null;
	}

	async findByExternalId(origin: string, externalId: string): Promise<AonSourceSummary | null> {
		const rows = await this.manager.query<SourceRow[]>(
			`SELECT ${this.summaryColumns} FROM ${this.table} s
			WHERE s.origin = $1 AND s.external_id = $2
			LIMIT 1`,
			[origin, externalId],
		);
		return rows[0] ? toSummary(rows[0]) : null;
	}

	async insertSource(source: {
		id: string;
		origin: string;
		externalId: string | null;
		title: string;
		content: string;
		meta: Record<string, unknown>;
		kind: string;
		status: string;
		contentHash: string | null;
		docTime: Date;
		indexedAt: Date;
		createdAt: Date;
	}): Promise<void> {
		await this.save(source);
	}

	/** Its chunks cascade at the database level. */
	async deleteById(id: string): Promise<void> {
		await this.delete({ id });
	}

	// --- the extractor's own reads and writes ---------------------------------
	// AonExtractService reasons about which sources to read and what it found;
	// it never touches TypeORM directly, so every query it needs lives here.

	/** The extractor's own candidates: never extracted, indexed, newest first. */
	async listUnextracted(limit: number): Promise<AonUnextractedSourceRow[]> {
		return await this.manager.query<AonUnextractedSourceRow[]>(
			`SELECT id, title, origin, kind, content, doc_time AS "docTime"
			FROM ${this.table}
			WHERE extracted_at IS NULL AND status = 'indexed'
			ORDER BY created_at DESC
			LIMIT $1`,
			[limit],
		);
	}

	/** The first chunk of a source, in reading order: what a fact extracted from it cites as its evidence. */
	async firstChunkId(sourceId: string): Promise<string | null> {
		const rows = await this.manager.query<Array<{ id: string }>>(
			`SELECT id FROM ${this.chunksTable} WHERE source_id = $1 ORDER BY seq ASC LIMIT 1`,
			[sourceId],
		);
		return rows[0]?.id ?? null;
	}

	/** Marks a source read without extracting from it (too long, budget exhausted, …), with a note for why. */
	async markSkipped(id: string, note: string): Promise<void> {
		await this.manager.query(
			`UPDATE ${this.table} SET extracted_at = CURRENT_TIMESTAMP,
				meta = COALESCE(meta, '{}'::jsonb) || $2::jsonb
			WHERE id = $1`,
			[id, JSON.stringify({ extractSkipped: note })],
		);
	}

	async markExtracted(id: string): Promise<void> {
		await this.manager.query(`UPDATE ${this.table} SET extracted_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
	}

	/** Sources grouped by kind, most common first: the Memory page's "sky" categories. */
	async countByKind(): Promise<AonSourceKindCount[]> {
		const rows = await this.createQueryBuilder('s')
			.select('s.kind', 'kind')
			.addSelect('COUNT(*)::int', 'count')
			.groupBy('s.kind')
			.orderBy('count', 'DESC')
			.getRawMany<{ kind: string; count: number | string }>();
		return rows.map((r) => ({ kind: r.kind, count: Number(r.count) }));
	}
}
