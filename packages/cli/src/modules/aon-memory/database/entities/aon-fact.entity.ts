import { BaseEntity, Column, Entity, PrimaryColumn } from '@n8n/typeorm';

/**
 * One claim connecting two entities, or an entity and a plain value:
 * proposed by extraction, decided (confirmed or rejected) by the owner.
 * `source_chunk_id` carries no foreign key — the chunk it was read from may
 * already be gone.
 */
@Entity({ name: 'aon_facts' })
export class AonFact extends BaseEntity {
	@PrimaryColumn({ type: 'text' })
	id: string;

	@Column({ type: 'text', name: 'subject_id' })
	subjectId: string;

	@Column({ type: 'text' })
	predicate: string;

	@Column({ type: 'text', name: 'object_id', nullable: true })
	objectId: string | null;

	@Column({ type: 'text', name: 'object_value', nullable: true })
	objectValue: string | null;

	@Column({ type: 'timestamptz', name: 'valid_from', nullable: true })
	validFrom: Date | null;

	@Column({ type: 'timestamptz', name: 'valid_to', nullable: true })
	validTo: Date | null;

	@Column({ type: 'timestamptz', name: 'recorded_at' })
	recordedAt: Date;

	@Column({ type: 'timestamptz', name: 'retracted_at', nullable: true })
	retractedAt: Date | null;

	@Column({ type: 'text', default: 'pending' })
	status: string;

	@Column({ type: 'double precision', nullable: true })
	confidence: number | null;

	@Column({ type: 'text', name: 'proposed_by' })
	proposedBy: string;

	@Column({ type: 'text', name: 'source_chunk_id', nullable: true })
	sourceChunkId: string | null;

	@Column({ type: 'text', nullable: true })
	quote: string | null;

	@Column({ type: 'text', name: 'contradicts_id', nullable: true })
	contradictsId: string | null;

	@Column({ type: 'text', name: 'decided_by', nullable: true })
	decidedBy: string | null;

	@Column({ type: 'timestamptz', name: 'decided_at', nullable: true })
	decidedAt: Date | null;

	@Column({ type: 'text', nullable: true })
	note: string | null;
}
