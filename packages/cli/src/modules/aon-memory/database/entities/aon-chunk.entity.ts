import { BaseEntity, Column, Entity, PrimaryColumn } from '@n8n/typeorm';

/**
 * A piece of a source, small enough to embed. The `embedding` (pgvector) and
 * `tsv` (tsvector) columns exist in the table but not here: TypeORM does not
 * know those types, and only the repository's raw search touches them.
 */
@Entity({ name: 'aon_chunks' })
export class AonChunk extends BaseEntity {
	@PrimaryColumn({ type: 'text' })
	id: string;

	@Column({ type: 'text', name: 'source_id' })
	sourceId: string;

	@Column({ type: 'integer' })
	seq: number;

	@Column({ type: 'text' })
	text: string;

	@Column({ type: 'integer', default: 0 })
	tokens: number;

	@Column({ type: 'timestamptz', name: 'embedded_at', nullable: true })
	embeddedAt: Date | null;

	@Column({ type: 'timestamptz', name: 'created_at' })
	createdAt: Date;
}
