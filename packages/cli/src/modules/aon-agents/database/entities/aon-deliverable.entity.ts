import { BaseEntity, Column, Entity, PrimaryColumn } from '@n8n/typeorm';

/** What an agent owes: a named outcome with a definition of done and a cadence. */
@Entity({ name: 'aon_deliverables' })
export class AonDeliverable extends BaseEntity {
	@PrimaryColumn({ type: 'text' })
	id: string;

	@Column({ type: 'text' })
	slug: string;

	@Column({ type: 'text', name: 'agent_id' })
	agentId: string;

	@Column({ type: 'text' })
	name: string;

	@Column({ type: 'text' })
	dod: string;

	@Column({ type: 'text', default: 'single' })
	shape: string;

	@Column({ type: 'text', nullable: true })
	cadence: string | null;

	@Column({ type: 'integer', default: 2 })
	tier: number;

	@Column({ type: 'text', default: 'owner' })
	approver: string;

	@Column({ type: 'jsonb', name: 'required_inputs', nullable: true })
	requiredInputs: unknown;

	@Column({ type: 'integer', name: 'max_iterations', default: 3 })
	maxIterations: number;

	@Column({ type: 'boolean', default: true })
	enabled: boolean;

	@Column({ type: 'timestamptz', name: 'last_run_at', nullable: true })
	lastRunAt: Date | null;

	@Column({ type: 'timestamptz', name: 'created_at' })
	createdAt: Date;

	@Column({ type: 'timestamptz', name: 'updated_at' })
	updatedAt: Date;
}
