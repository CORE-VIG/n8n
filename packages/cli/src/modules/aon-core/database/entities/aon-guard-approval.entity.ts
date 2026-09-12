import { BaseEntity, Column, Entity, PrimaryColumn } from '@n8n/typeorm';

/**
 * One card raised for the owner: an identity asking to do something its
 * policy does not allow by itself. `status` starts `pending`, and ends
 * `approved`, `denied`, or `expired` once its `expiresAt` deadline passes
 * unclaimed.
 */
@Entity({ name: 'aon_guard_approvals' })
export class AonGuardApproval extends BaseEntity {
	@PrimaryColumn({ type: 'text' })
	id: string;

	@Column({ type: 'text' })
	identity: string;

	@Column({ type: 'text', name: 'op_class' })
	opClass: string;

	@Column({ type: 'int' })
	tier: number;

	@Column({ type: 'text' })
	summary: string;

	@Column({ type: 'jsonb', nullable: true })
	body: Record<string, unknown> | null;

	@Column({ type: 'text', name: 'run_id', nullable: true })
	runId: string | null;

	@Column({ type: 'text', default: 'pending' })
	status: string;

	@Column({ type: 'text', name: 'decided_by', nullable: true })
	decidedBy: string | null;

	@Column({ type: 'timestamptz', name: 'decided_at', nullable: true })
	decidedAt: Date | null;

	@Column({ type: 'timestamptz', name: 'expires_at' })
	expiresAt: Date;

	@Column({ type: 'timestamptz', name: 'created_at' })
	createdAt: Date;
}
