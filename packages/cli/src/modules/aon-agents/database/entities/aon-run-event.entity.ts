import { BaseEntity, Column, Entity, PrimaryGeneratedColumn } from '@n8n/typeorm';

/** One line of a run's live log: what the agent said, called, or was told. */
@Entity({ name: 'aon_run_events' })
export class AonRunEvent extends BaseEntity {
	@PrimaryGeneratedColumn({ type: 'bigint' })
	id: string;

	@Column({ type: 'text', name: 'run_id' })
	runId: string;

	@Column({ type: 'integer' })
	seq: number;

	@Column({ type: 'text' })
	type: string;

	@Column({ type: 'text', nullable: true })
	name: string | null;

	@Column({ type: 'text', nullable: true })
	status: string | null;

	@Column({ type: 'text', nullable: true })
	text: string | null;

	@Column({ type: 'timestamptz', name: 'created_at' })
	createdAt: Date;
}
