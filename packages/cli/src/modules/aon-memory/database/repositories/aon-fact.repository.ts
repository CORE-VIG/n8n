import type { AonFactList, AonFactSummary } from '@n8n/api-types';
import { Service } from '@n8n/di';
import { DataSource, Repository } from '@n8n/typeorm';
import { randomUUID } from 'node:crypto';

import { returningRows } from '@/modules/aon-core/database/returning-rows';

import { AonFact } from '../entities/aon-fact.entity';

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

/** One entity-to-entity claim, ready to become a graph edge. */
export interface AonFactGraphEdgeRow {
	factId: string;
	subjectId: string;
	subjectName: string;
	subjectKind: string;
	predicate: string;
	objectId: string;
	objectName: string;
	objectKind: string;
	status: string;
}

const iso = (d: Date | string) => new Date(d).toISOString();

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

const FACT_COLUMNS = `f.id, f.subject_id AS "subjectId", se.name AS subject, f.predicate,
	f.object_id AS "objectId", COALESCE(oe.name, f.object_value, '') AS object,
	f.status, f.confidence, f.proposed_by AS "proposedBy", f.source_chunk_id AS "sourceChunkId",
	c.source_id AS "sourceId", s.title AS "sourceTitle", f.quote,
	f.recorded_at AS "recordedAt", f.decided_by AS "decidedBy", f.decided_at AS "decidedAt", f.note`;

@Service()
export class AonFactRepository extends Repository<AonFact> {
	constructor(dataSource: DataSource) {
		super(AonFact, dataSource.manager);
	}

	private get table() {
		return this.manager.connection.driver.escape(this.metadata.tableName);
	}

	private get entitiesTable() {
		return this.manager.connection.driver.escape('aon_entities');
	}

	private get chunksTable() {
		return this.manager.connection.driver.escape('aon_chunks');
	}

	private get sourcesTable() {
		return this.manager.connection.driver.escape('aon_sources');
	}

	private get fromClause() {
		return `${this.table} f
			JOIN ${this.entitiesTable} se ON se.id = f.subject_id
			LEFT JOIN ${this.entitiesTable} oe ON oe.id = f.object_id
			LEFT JOIN ${this.chunksTable} c ON c.id = f.source_chunk_id
			LEFT JOIN ${this.sourcesTable} s ON s.id = c.source_id`;
	}

	async countAll(): Promise<number> {
		return await this.count();
	}

	async countByStatus(): Promise<Array<{ status: string; count: number }>> {
		return await this.manager.query<Array<{ status: string; count: number }>>(
			`SELECT status, count(*)::int AS count FROM ${this.table} GROUP BY status ORDER BY count DESC, status`,
		);
	}

	async list({
		status,
		entityId,
		limit,
		offset,
	}: {
		status?: string;
		entityId?: string;
		limit: number;
		offset: number;
	}): Promise<AonFactList> {
		const [items, totalRows, byStatusRows] = await Promise.all([
			this.manager.query<FactRow[]>(
				`SELECT ${FACT_COLUMNS}
				FROM ${this.fromClause}
				WHERE ($1::text IS NULL OR f.status = $1)
					AND ($2::text IS NULL OR f.subject_id = $2 OR f.object_id = $2)
				ORDER BY f.recorded_at DESC
				LIMIT $3 OFFSET $4`,
				[status ?? null, entityId ?? null, limit, offset],
			),
			this.manager.query<Array<{ count: number }>>(
				`SELECT count(*)::int AS count FROM ${this.table} f
				WHERE ($1::text IS NULL OR f.status = $1)
					AND ($2::text IS NULL OR f.subject_id = $2 OR f.object_id = $2)`,
				[status ?? null, entityId ?? null],
			),
			this.manager.query<Array<{ status: string; count: number }>>(
				`SELECT f.status, count(*)::int AS count FROM ${this.table} f
				WHERE ($1::text IS NULL OR f.subject_id = $1 OR f.object_id = $1)
				GROUP BY f.status`,
				[entityId ?? null],
			),
		]);

		const byStatus: Record<string, number> = {};
		for (const row of byStatusRows) byStatus[row.status] = row.count;

		return { items: items.map(toFactSummary), total: totalRows[0]?.count ?? 0, byStatus };
	}

	async decide(
		id: string,
		status: 'confirmed' | 'rejected',
		decidedBy: string,
		note?: string,
	): Promise<AonFactSummary | null> {
		const raw = await this.manager.query(
			`UPDATE ${this.table}
			SET status = $1, decided_by = $2, decided_at = CURRENT_TIMESTAMP,
				note = COALESCE($3, note)
			WHERE id = $4
			RETURNING id`,
			[status, decidedBy, note ?? null, id],
		);
		const updated = returningRows<{ id: string }>(raw)[0];
		if (!updated) return null;

		const rows = await this.manager.query<FactRow[]>(
			`SELECT ${FACT_COLUMNS} FROM ${this.fromClause} WHERE f.id = $1`,
			[id],
		);
		return rows[0] ? toFactSummary(rows[0]) : null;
	}

	/** True when a live (non-rejected, non-retracted) fact already states this exact triple. */
	async existsTriple(
		subjectId: string,
		predicate: string,
		objectId: string | null,
		objectValue: string | null,
	): Promise<boolean> {
		const rows = await this.manager.query<Array<{ exists: boolean }>>(
			`SELECT EXISTS (
				SELECT 1 FROM ${this.table}
				WHERE subject_id = $1 AND lower(predicate) = lower($2)
					AND status != 'rejected' AND retracted_at IS NULL
					AND (
						($3::text IS NOT NULL AND object_id = $3)
						OR ($3::text IS NULL AND object_value IS NOT DISTINCT FROM $4)
					)
			) AS exists`,
			[subjectId, predicate, objectId, objectValue],
		);
		return rows[0]?.exists ?? false;
	}

	async insertPending(fact: {
		subjectId: string;
		predicate: string;
		objectId: string | null;
		objectValue: string | null;
		quote: string | null;
		confidence: number | null;
		proposedBy: string;
		sourceChunkId: string | null;
		recordedAt: Date;
		validFrom: Date | null;
	}): Promise<string> {
		const id = randomUUID();
		await this.insert({
			id,
			subjectId: fact.subjectId,
			predicate: fact.predicate,
			objectId: fact.objectId,
			objectValue: fact.objectValue,
			quote: fact.quote,
			confidence: fact.confidence,
			proposedBy: fact.proposedBy,
			sourceChunkId: fact.sourceChunkId,
			recordedAt: fact.recordedAt,
			validFrom: fact.validFrom,
			status: 'pending',
		});
		return id;
	}

	/** Entity-to-entity claims, newest first: the graph's edges. */
	async graphEdges(limit: number): Promise<AonFactGraphEdgeRow[]> {
		return await this.manager.query<AonFactGraphEdgeRow[]>(
			`SELECT f.id AS "factId", f.subject_id AS "subjectId", se.name AS "subjectName", se.kind AS "subjectKind",
				f.predicate, f.object_id AS "objectId", oe.name AS "objectName", oe.kind AS "objectKind", f.status
			FROM ${this.table} f
			JOIN ${this.entitiesTable} se ON se.id = f.subject_id
			JOIN ${this.entitiesTable} oe ON oe.id = f.object_id
			WHERE f.object_id IS NOT NULL AND f.status != 'rejected' AND f.retracted_at IS NULL
			ORDER BY f.recorded_at DESC
			LIMIT $1`,
			[limit],
		);
	}
}
