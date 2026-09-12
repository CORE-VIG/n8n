import type { AonMemoryHit } from '@n8n/api-types';
import { Service } from '@n8n/di';
import { DataSource, Not, IsNull, Repository } from '@n8n/typeorm';
import { randomUUID } from 'node:crypto';

import { AonChunk } from '../entities/aon-chunk.entity';
import { AonSource } from '../entities/aon-source.entity';

interface HitRow extends Omit<AonMemoryHit, 'docTime'> {
	docTime: Date | null;
}

const toHit = (r: HitRow): AonMemoryHit => ({
	...r,
	score: Number(r.score),
	docTime: r.docTime ? new Date(r.docTime).toISOString() : null,
});

@Service()
export class AonChunkRepository extends Repository<AonChunk> {
	constructor(dataSource: DataSource) {
		super(AonChunk, dataSource.manager);
	}

	private get chunks() {
		return this.manager.connection.driver.escape(this.metadata.tableName);
	}

	private get sources() {
		return this.manager.connection.driver.escape(
			this.manager.connection.getMetadata(AonSource).tableName,
		);
	}

	private readonly hitColumns = `c.id AS "chunkId", c.source_id AS "sourceId", c.seq, c.text,
		s.title, s.origin, s.kind, s.doc_time AS "docTime"`;

	async countAll(): Promise<number> {
		return await this.count();
	}

	async countEmbedded(): Promise<number> {
		return await this.count({ where: { embeddedAt: Not(IsNull()) } });
	}

	/** Word search over the tsvector: exact words, ranked by density. */
	async searchText(query: string, limit: number): Promise<AonMemoryHit[]> {
		const rows = await this.manager.query<HitRow[]>(
			`SELECT ${this.hitColumns}, ts_rank_cd(c.tsv, q) AS score
			FROM ${this.chunks} c
			JOIN ${this.sources} s ON s.id = c.source_id,
			plainto_tsquery('simple', $1) q
			WHERE c.tsv @@ q
			ORDER BY score DESC, c.created_at DESC
			LIMIT $2`,
			[query, limit],
		);
		return rows.map(toHit);
	}

	/** Meaning search: cosine similarity against the query's embedding. */
	async searchVector(embedding: number[], limit: number): Promise<AonMemoryHit[]> {
		const vector = `[${embedding.join(',')}]`;
		const rows = await this.manager.query<HitRow[]>(
			`SELECT ${this.hitColumns}, 1 - (c.embedding <=> $1::vector) AS score
			FROM ${this.chunks} c
			JOIN ${this.sources} s ON s.id = c.source_id
			WHERE c.embedding IS NOT NULL
			ORDER BY c.embedding <=> $1::vector
			LIMIT $2`,
			[vector, limit],
		);
		return rows.map(toHit);
	}

	/** Stores a source's pieces in order, ready to embed. */
	async insertMany(
		sourceId: string,
		chunks: Array<{ seq: number; text: string; tokens: number }>,
	): Promise<Array<{ id: string; seq: number; text: string }>> {
		if (chunks.length === 0) return [];
		const createdAt = new Date();
		const rows = chunks.map((chunk) => ({
			id: randomUUID(),
			sourceId,
			seq: chunk.seq,
			text: chunk.text,
			tokens: chunk.tokens,
			createdAt,
		}));
		await this.insert(rows);
		return rows.map(({ id, seq, text }) => ({ id, seq, text }));
	}

	/** Chunks capture could not embed inline, oldest first. */
	async listPendingEmbedding(limit: number): Promise<Array<{ id: string; text: string }>> {
		return await this.manager.query<Array<{ id: string; text: string }>>(
			`SELECT id, text FROM ${this.chunks}
			WHERE embedded_at IS NULL
			ORDER BY created_at
			LIMIT $1`,
			[limit],
		);
	}

	async setEmbedding(id: string, embedding: number[]): Promise<void> {
		const vector = `[${embedding.join(',')}]`;
		await this.manager.query(
			`UPDATE ${this.chunks} SET embedding = $1::vector, embedded_at = CURRENT_TIMESTAMP
			WHERE id = $2`,
			[vector, id],
		);
	}
}
