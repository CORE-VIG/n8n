import { BaseEntity, Column, Entity, PrimaryColumn } from '@n8n/typeorm';

/** Something dreamed up from the facts: a bucketed, salience-scored note. */
@Entity({ name: 'aon_observations' })
export class AonObservation extends BaseEntity {
	@PrimaryColumn({ type: 'text' })
	id: string;

	@Column({ type: 'text' })
	bucket: string;

	@Column({ type: 'text' })
	text: string;

	@Column({ type: 'double precision' })
	salience: number;

	@Column({ type: 'jsonb', nullable: true })
	evidence: unknown;

	@Column({ type: 'timestamptz', name: 'first_seen' })
	firstSeen: Date;

	@Column({ type: 'timestamptz', name: 'last_seen' })
	lastSeen: Date;

	@Column({ type: 'text', name: 'dream_id', nullable: true })
	dreamId: string | null;

	@Column({ type: 'text', default: 'active' })
	status: string;
}
