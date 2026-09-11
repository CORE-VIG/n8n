import { BaseEntity, Column, Entity, PrimaryColumn } from '@n8n/typeorm';

/** A rule an agent learned from its own runs: canary first, then kept or revoked. */
@Entity({ name: 'aon_learned_rules' })
export class AonLearnedRule extends BaseEntity {
	@PrimaryColumn({ type: 'text' })
	id: string;

	@Column({ type: 'text', name: 'agent_id', nullable: true })
	agentId: string | null;

	@Column({ type: 'text' })
	text: string;

	@Column({ type: 'text', name: 'source_run_id', nullable: true })
	sourceRunId: string | null;

	@Column({ type: 'jsonb', nullable: true })
	evidence: unknown;

	@Column({ type: 'text', default: 'canary' })
	state: string;

	@Column({ type: 'timestamptz', name: 'created_at' })
	createdAt: Date;

	@Column({ type: 'timestamptz', name: 'revoked_at', nullable: true })
	revokedAt: Date | null;

	@Column({ type: 'text', nullable: true })
	reason: string | null;
}
