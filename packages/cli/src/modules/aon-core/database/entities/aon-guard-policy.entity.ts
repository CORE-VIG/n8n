import { BaseEntity, Column, Entity, PrimaryColumn } from '@n8n/typeorm';

/**
 * One identity's standing verdict for one op class: what it may do by
 * itself, without asking. Unique on (identity, op_class); `AonGuardService`
 * looks up `agent:<slug>` or `owner`, then `*`, before falling back to the
 * tier default.
 */
@Entity({ name: 'aon_guard_policies' })
export class AonGuardPolicy extends BaseEntity {
	@PrimaryColumn({ type: 'text' })
	id: string;

	@Column({ type: 'text' })
	identity: string;

	@Column({ type: 'text', name: 'op_class' })
	opClass: string;

	@Column({ type: 'text' })
	verdict: string;

	@Column({ type: 'text', nullable: true })
	note: string | null;

	@Column({ type: 'timestamptz', name: 'updated_at' })
	updatedAt: Date;
}
