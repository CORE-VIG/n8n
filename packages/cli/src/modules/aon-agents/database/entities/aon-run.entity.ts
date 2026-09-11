import { BaseEntity, Column, Entity, PrimaryColumn } from '@n8n/typeorm';

/** One attempt at a deliverable. */
@Entity({ name: 'aon_runs' })
export class AonRun extends BaseEntity {
	@PrimaryColumn({ type: 'text' })
	id: string;

	@Column({ type: 'text', name: 'deliverable_id' })
	deliverableId: string;

	@Column({ type: 'text', name: 'agent_id' })
	agentId: string;

	@Column({ type: 'text', name: 'parent_run_id', nullable: true })
	parentRunId: string | null;

	@Column({ type: 'text', default: 'queued' })
	status: string;

	@Column({ type: 'integer', default: 1 })
	attempt: number;

	@Column({ type: 'integer', default: 1 })
	iteration: number;

	@Column({ type: 'text', default: 'manual' })
	trigger: string;

	@Column({ type: 'jsonb', nullable: true })
	input: unknown;

	@Column({ type: 'text', nullable: true })
	output: string | null;

	@Column({ type: 'text', name: 'output_page_id', nullable: true })
	outputPageId: string | null;

	@Column({ type: 'jsonb', nullable: true })
	verification: unknown;

	@Column({ type: 'text', nullable: true })
	help: string | null;

	@Column({ type: 'text', nullable: true })
	model: string | null;

	@Column({ type: 'integer', name: 'tokens_in', default: 0 })
	tokensIn: number;

	@Column({ type: 'integer', name: 'tokens_out', default: 0 })
	tokensOut: number;

	@Column({ type: 'double precision', name: 'cost_eur', default: 0 })
	costEur: number;

	@Column({ type: 'text', name: 'claimed_by', nullable: true })
	claimedBy: string | null;

	@Column({ type: 'timestamptz', name: 'heartbeat_at', nullable: true })
	heartbeatAt: Date | null;

	@Column({ type: 'text', name: 'approval_id', nullable: true })
	approvalId: string | null;

	@Column({ type: 'timestamptz', name: 'started_at', nullable: true })
	startedAt: Date | null;

	@Column({ type: 'timestamptz', name: 'finished_at', nullable: true })
	finishedAt: Date | null;

	@Column({ type: 'timestamptz', name: 'created_at' })
	createdAt: Date;

	@Column({ type: 'timestamptz', name: 'updated_at' })
	updatedAt: Date;
}
