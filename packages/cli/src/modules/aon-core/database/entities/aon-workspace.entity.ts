import { BaseEntity, Column, Entity, PrimaryColumn } from '@n8n/typeorm';

/** A named, persistent Hands sandbox workspace, one row per user and slug. */
@Entity({ name: 'aon_workspaces' })
export class AonWorkspace extends BaseEntity {
	@PrimaryColumn({ type: 'text' })
	id: string;

	@Column({ type: 'varchar', length: 36, name: 'user_id' })
	userId: string;

	@Column({ type: 'text' })
	slug: string;

	@Column({ type: 'timestamptz', name: 'created_at' })
	createdAt: Date;

	@Column({ type: 'timestamptz', name: 'last_used_at' })
	lastUsedAt: Date;
}
