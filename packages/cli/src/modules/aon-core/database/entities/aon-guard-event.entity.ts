import { BaseEntity, Column, Entity, PrimaryGeneratedColumn } from '@n8n/typeorm';

/**
 * The audit trail: one row per Guard decision, whichever path it came
 * through (a plain verdict, a card raised, or the owner's approve/deny).
 * `id` is a bigserial; the pg driver hands it back as a string, and
 * {@link AonGuardEventRepository} converts it to a number for the API shape.
 */
@Entity({ name: 'aon_guard_events' })
export class AonGuardEvent extends BaseEntity {
	@PrimaryGeneratedColumn('increment', { type: 'bigint' })
	id: string;

	@Column({ type: 'timestamptz' })
	ts: Date;

	@Column({ type: 'text' })
	identity: string;

	@Column({ type: 'text', name: 'op_class' })
	opClass: string;

	@Column({ type: 'int' })
	tier: number;

	@Column({ type: 'text' })
	verdict: string;

	@Column({ type: 'text', name: 'approval_id', nullable: true })
	approvalId: string | null;

	@Column({ type: 'jsonb', nullable: true })
	meta: Record<string, unknown> | null;
}
