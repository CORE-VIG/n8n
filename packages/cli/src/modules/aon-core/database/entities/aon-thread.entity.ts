import { BaseEntity, Column, Entity, PrimaryColumn } from '@n8n/typeorm';

/** One saved conversation with the assistant: a row per thread, turns live in {@link AonTurn}. */
@Entity({ name: 'aon_threads' })
export class AonThread extends BaseEntity {
	@PrimaryColumn({ type: 'text' })
	id: string;

	@Column({ type: 'uuid', name: 'user_id' })
	userId: string;

	@Column({ type: 'text', nullable: true })
	title: string | null;

	@Column({ type: 'text', name: 'claude_session_id', nullable: true })
	claudeSessionId: string | null;

	@Column({ type: 'timestamptz', name: 'created_at' })
	createdAt: Date;

	@Column({ type: 'timestamptz', name: 'updated_at' })
	updatedAt: Date;

	@Column({ type: 'timestamptz', name: 'last_turn_at', nullable: true })
	lastTurnAt: Date | null;
}
