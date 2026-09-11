import { BaseEntity, Column, Entity, PrimaryColumn } from '@n8n/typeorm';

/** An Aon agent: a persona with a charter, hired to produce deliverables. */
@Entity({ name: 'aon_agents' })
export class AonAgent extends BaseEntity {
	@PrimaryColumn({ type: 'text' })
	id: string;

	@Column({ type: 'text' })
	slug: string;

	@Column({ type: 'text' })
	name: string;

	@Column({ type: 'text' })
	persona: string;

	@Column({ type: 'jsonb' })
	charter: Record<string, unknown>;

	@Column({ type: 'text', default: 'draft' })
	status: string;

	@Column({ type: 'text', name: 'token_id', nullable: true })
	tokenId: string | null;

	@Column({ type: 'integer', name: 'breaker_failures', default: 0 })
	breakerFailures: number;

	@Column({ type: 'timestamptz', name: 'breaker_tripped_at', nullable: true })
	breakerTrippedAt: Date | null;

	@Column({ type: 'text', name: 'created_by' })
	createdBy: string;

	@Column({ type: 'timestamptz', name: 'created_at' })
	createdAt: Date;

	@Column({ type: 'timestamptz', name: 'updated_at' })
	updatedAt: Date;
}
