import { BaseEntity, Column, Entity, PrimaryColumn } from '@n8n/typeorm';

/**
 * Something Aon's memory has recognised: a person, an org, a place, a
 * thing, a concept, a document, an event. The `embedding` (pgvector) column
 * exists in the table but not here, like `aon_chunks`: only a raw query
 * would touch it, and nothing does yet.
 */
@Entity({ name: 'aon_entities' })
export class AonEntity extends BaseEntity {
	@PrimaryColumn({ type: 'text' })
	id: string;

	@Column({ type: 'text' })
	name: string;

	@Column({ type: 'text', default: 'unknown' })
	kind: string;

	@Column({ type: 'text', array: true, default: '{}' })
	aliases: string[];

	@Column({ type: 'text', nullable: true })
	summary: string | null;

	@Column({ type: 'text', name: 'merged_into_id', nullable: true })
	mergedIntoId: string | null;

	@Column({ type: 'timestamptz', name: 'merged_at', nullable: true })
	mergedAt: Date | null;

	@Column({ type: 'timestamptz', name: 'created_at' })
	createdAt: Date;

	@Column({ type: 'timestamptz', name: 'updated_at' })
	updatedAt: Date;
}
