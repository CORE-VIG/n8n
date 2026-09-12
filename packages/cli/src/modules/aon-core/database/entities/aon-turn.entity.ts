import type { AonTurnTool } from '@n8n/api-types';
import { BaseEntity, Column, Entity, PrimaryColumn } from '@n8n/typeorm';

/** One message in a saved conversation: what he said, or what the assistant answered. */
@Entity({ name: 'aon_turns' })
export class AonTurn extends BaseEntity {
	@PrimaryColumn({ type: 'text' })
	id: string;

	@Column({ type: 'text', name: 'thread_id' })
	threadId: string;

	@Column({ type: 'text' })
	role: string;

	@Column({ type: 'text', default: '' })
	text: string;

	@Column({ type: 'jsonb', nullable: true })
	tools: AonTurnTool[] | null;

	@Column({ type: 'double precision', name: 'cost_usd', default: 0 })
	costUsd: number;

	@Column({ type: 'timestamptz', name: 'created_at' })
	createdAt: Date;
}
