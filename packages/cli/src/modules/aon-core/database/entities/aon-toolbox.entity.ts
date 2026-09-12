import { BaseEntity, Column, Entity, PrimaryColumn } from '@n8n/typeorm';

/**
 * One thing Aon can reach for but does not contain: a skill on disk, a
 * script, an MCP server, a CLI. A catalogue, not code that runs — nothing
 * here is executed. Unique on `slug`; `AonToolboxService.rescan()` is the
 * only writer of every column but `uses`, `lastUsedAt` and `lastUsedBy`,
 * which only `recordUse` touches.
 */
@Entity({ name: 'aon_toolbox' })
export class AonToolbox extends BaseEntity {
	@PrimaryColumn({ type: 'text' })
	id: string;

	@Column({ type: 'text' })
	slug: string;

	@Column({ type: 'text' })
	kind: string;

	@Column({ type: 'text' })
	name: string;

	@Column({ type: 'text' })
	summary: string;

	@Column({ type: 'text' })
	location: string;

	@Column({ type: 'text', nullable: true })
	invocation: string | null;

	@Column({ type: 'text', array: true, default: '{}' })
	tags: string[];

	@Column({ type: 'text', default: 'disk' })
	source: string;

	@Column({ type: 'timestamptz', name: 'missing_since', nullable: true })
	missingSince: Date | null;

	@Column({ type: 'int', default: 0 })
	uses: number;

	@Column({ type: 'timestamptz', name: 'last_used_at', nullable: true })
	lastUsedAt: Date | null;

	@Column({ type: 'text', name: 'last_used_by', nullable: true })
	lastUsedBy: string | null;

	@Column({ type: 'jsonb', nullable: true })
	meta: Record<string, unknown> | null;

	@Column({ type: 'text', name: 'when_to_use', nullable: true })
	whenToUse: string | null;

	@Column({ type: 'int', name: 'est_tokens', default: 0 })
	estTokens: number;

	@Column({ type: 'timestamptz', name: 'created_at' })
	createdAt: Date;

	@Column({ type: 'timestamptz', name: 'updated_at' })
	updatedAt: Date;
}
