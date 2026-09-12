import type { AonEntityDetail, AonEntitySummary, AonFactSummary } from '@n8n/api-types';
import { Service } from '@n8n/di';
import { DataSource, IsNull, Repository } from '@n8n/typeorm';

import { AonEntity } from '../entities/aon-entity.entity';

interface EntityRow {
	id: string;
	name: string;
	kind: string;
	aliases: string[];
	summary: string | null;
	createdAt: Date;
	factCount: number;
}

interface FactRow {
	id: string;
	subjectId: string;
	subject: string;
	predicate: string;
	objectId: string | null;
	object: string;
	status: string;
	confidence: number | null;
	proposedBy: string | null;
	sourceChunkId: string | null;
	sourceId: string | null;
	sourceTitle: string | null;
	quote: string | null;
	recordedAt: Date;
	decidedBy: string | null;
	decidedAt: Date | null;
	note: string | null;
}

interface MentionRow {
	sourceId: string;
	title: string;
	origin: string;
}

/** An entity's connectedness: any non-rejected, non-retracted fact touching it. */
export interface AonEntityDegreeRow {
	id: string;
	name: string;
	kind: string;
	degree: number;
}

const iso = (d: Date | string) => new Date(d).toISOString();

const toSummary = (r: EntityRow): AonEntitySummary => ({
	id: r.id,
	name: r.name,
	kind: r.kind,
	aliases: r.aliases ?? [],
	summary: r.summary,
	factCount: r.factCount,
	createdAt: iso(r.createdAt),
});

const toFactSummary = (r: FactRow): AonFactSummary => ({
	id: r.id,
	subjectId: r.subjectId,
	subject: r.subject,
	predicate: r.predicate,
	objectId: r.objectId,
	object: r.object,
	status: r.status,
	confidence: r.confidence,
	proposedBy: r.proposedBy,
	sourceChunkId: r.sourceChunkId,
	sourceId: r.sourceId,
	sourceTitle: r.sourceTitle,
	quote: r.quote,
	recordedAt: iso(r.recordedAt),
	decidedBy: r.decidedBy,
	decidedAt: r.decidedAt ? iso(r.decidedAt) : null,
	note: r.note,
});

/** Every fact column memory's writer needs, joined to the names either side reads by. */
const FACT_COLUMNS = `f.id, f.subject_id AS "subjectId", se.name AS subject, f.predicate,
	f.object_id AS "objectId", COALESCE(oe.name, f.object_value, '') AS object,
	f.status, f.confidence, f.proposed_by AS "proposedBy", f.source_chunk_id AS "sourceChunkId",
	c.source_id AS "sourceId", s.title AS "sourceTitle", f.quote,
	f.recorded_at AS "recordedAt", f.decided_by AS "decidedBy", f.decided_at AS "decidedAt", f.note`;

@Service()
export class AonEntityRepository extends Repository<AonEntity> {
	constructor(dataSource: DataSource) {
		super(AonEntity, dataSource.manager);
	}

	private get table() {
		return this.manager.connection.driver.escape(this.metadata.tableName);
	}

	private get factsTable() {
		return this.manager.connection.driver.escape('aon_facts');
	}

	private get chunksTable() {
		return this.manager.connection.driver.escape('aon_chunks');
	}

	private get sourcesTable() {
		return this.manager.connection.driver.escape('aon_sources');
	}

	/** `e` is the entity row in scope; every listing/detail query builds on it. */
	private get summaryColumns() {
		return `e.id, e.name, e.kind, e.aliases, e.summary, e.created_at AS "createdAt",
			(SELECT count(*)::int FROM ${this.factsTable} f
				WHERE f.subject_id = e.id OR f.object_id = e.id) AS "factCount"`;
	}

	async list({
		q,
		kind,
		limit,
		offset,
	}: {
		q?: string;
		kind?: string;
		limit: number;
		offset: number;
	}): Promise<{ items: AonEntitySummary[]; total: number }> {
		const [items, totalRows] = await Promise.all([
			this.manager.query<EntityRow[]>(
				`SELECT ${this.summaryColumns}
				FROM ${this.table} e
				WHERE e.merged_into_id IS NULL
					AND ($1::text IS NULL OR e.name ILIKE '%' || $1 || '%'
						OR EXISTS (SELECT 1 FROM unnest(e.aliases) a WHERE a ILIKE '%' || $1 || '%'))
					AND ($2::text IS NULL OR e.kind = $2)
				ORDER BY "factCount" DESC, e.name
				LIMIT $3 OFFSET $4`,
				[q ?? null, kind ?? null, limit, offset],
			),
			this.manager.query<Array<{ count: number }>>(
				`SELECT count(*)::int AS count FROM ${this.table} e
				WHERE e.merged_into_id IS NULL
					AND ($1::text IS NULL OR e.name ILIKE '%' || $1 || '%'
						OR EXISTS (SELECT 1 FROM unnest(e.aliases) a WHERE a ILIKE '%' || $1 || '%'))
					AND ($2::text IS NULL OR e.kind = $2)`,
				[q ?? null, kind ?? null],
			),
		]);
		return { items: items.map(toSummary), total: totalRows[0]?.count ?? 0 };
	}

	async countByKind(): Promise<Array<{ kind: string; count: number }>> {
		return await this.manager.query<Array<{ kind: string; count: number }>>(
			`SELECT kind, count(*)::int AS count FROM ${this.table}
			WHERE merged_into_id IS NULL
			GROUP BY kind ORDER BY count DESC, kind`,
		);
	}

	async findDetail(id: string): Promise<AonEntityDetail | null> {
		const rows = await this.manager.query<EntityRow[]>(
			`SELECT ${this.summaryColumns} FROM ${this.table} e WHERE e.id = $1`,
			[id],
		);
		const row = rows[0];
		if (!row) return null;

		const [factRows, mentionRows] = await Promise.all([
			this.manager.query<FactRow[]>(
				`SELECT ${FACT_COLUMNS}
				FROM ${this.factsTable} f
				JOIN ${this.table} se ON se.id = f.subject_id
				LEFT JOIN ${this.table} oe ON oe.id = f.object_id
				LEFT JOIN ${this.chunksTable} c ON c.id = f.source_chunk_id
				LEFT JOIN ${this.sourcesTable} s ON s.id = c.source_id
				WHERE f.subject_id = $1 OR f.object_id = $1
				ORDER BY f.recorded_at DESC`,
				[id],
			),
			this.manager.query<MentionRow[]>(
				`SELECT DISTINCT s.id AS "sourceId", s.title, s.origin
				FROM ${this.factsTable} f
				JOIN ${this.chunksTable} c ON c.id = f.source_chunk_id
				JOIN ${this.sourcesTable} s ON s.id = c.source_id
				WHERE (f.subject_id = $1 OR f.object_id = $1) AND f.source_chunk_id IS NOT NULL
				ORDER BY s.title`,
				[id],
			),
		]);

		return {
			...toSummary(row),
			facts: factRows.map(toFactSummary),
			mentionedIn: mentionRows,
		};
	}

	/** A live entity (not merged away) whose name or one of its aliases matches, case-insensitively. */
	async findByNameOrAlias(name: string): Promise<{ id: string; name: string; kind: string } | null> {
		const rows = await this.manager.query<Array<{ id: string; name: string; kind: string }>>(
			`SELECT id, name, kind FROM ${this.table}
			WHERE merged_into_id IS NULL
				AND (lower(name) = lower($1) OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE lower(a) = lower($1)))
			LIMIT 1`,
			[name],
		);
		return rows[0] ?? null;
	}

	async findBasic(id: string): Promise<{ id: string; name: string; kind: string } | null> {
		const rows = await this.manager.query<Array<{ id: string; name: string; kind: string }>>(
			`SELECT id, name, kind FROM ${this.table} WHERE id = $1`,
			[id],
		);
		return rows[0] ?? null;
	}

	async insertEntity(entity: {
		id: string;
		name: string;
		kind: string;
		aliases: string[];
		summary: string | null;
		createdAt: Date;
		updatedAt: Date;
	}): Promise<void> {
		await this.insert(entity);
	}

	/** How many non-rejected, non-retracted facts touch each live entity, most connected first. */
	async topByDegree(limit: number): Promise<AonEntityDegreeRow[]> {
		return await this.manager.query<AonEntityDegreeRow[]>(
			`SELECT e.id, e.name, e.kind,
				(SELECT count(*)::int FROM ${this.factsTable} f
					WHERE (f.subject_id = e.id OR f.object_id = e.id)
						AND f.status != 'rejected' AND f.retracted_at IS NULL) AS degree
			FROM ${this.table} e
			WHERE e.merged_into_id IS NULL
			ORDER BY degree DESC, e.name
			LIMIT $1`,
			[limit],
		);
	}

	/** The same degree measure as `topByDegree`, for a chosen set of entities rather than the top N. */
	async byIds(ids: string[]): Promise<AonEntityDegreeRow[]> {
		if (ids.length === 0) return [];
		return await this.manager.query<AonEntityDegreeRow[]>(
			`SELECT e.id, e.name, e.kind,
				(SELECT count(*)::int FROM ${this.factsTable} f
					WHERE (f.subject_id = e.id OR f.object_id = e.id)
						AND f.status != 'rejected' AND f.retracted_at IS NULL) AS degree
			FROM ${this.table} e
			WHERE e.id = ANY($1::text[])`,
			[ids],
		);
	}

	async countLive(): Promise<number> {
		return await this.count({ where: { mergedIntoId: IsNull() } });
	}
}
