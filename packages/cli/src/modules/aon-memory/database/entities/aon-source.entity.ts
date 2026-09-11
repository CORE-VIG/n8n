import { BaseEntity, Column, Entity, PrimaryColumn } from '@n8n/typeorm';

/** Something Aon read: a mail, a page, a document, a conversation turn. Chunked below. */
@Entity({ name: 'aon_sources' })
export class AonSource extends BaseEntity {
	@PrimaryColumn({ type: 'text' })
	id: string;

	@Column({ type: 'text' })
	origin: string;

	@Column({ type: 'text', name: 'external_id', nullable: true })
	externalId: string | null;

	@Column({ type: 'text' })
	title: string;

	@Column({ type: 'text' })
	content: string;

	@Column({ type: 'jsonb', nullable: true })
	meta: unknown;

	@Column({ type: 'text', default: 'text' })
	kind: string;

	@Column({ type: 'text', default: 'new' })
	status: string;

	@Column({ type: 'text', name: 'content_hash', nullable: true })
	contentHash: string | null;

	@Column({ type: 'timestamptz', name: 'doc_time', nullable: true })
	docTime: Date | null;

	@Column({ type: 'timestamptz', name: 'indexed_at', nullable: true })
	indexedAt: Date | null;

	@Column({ type: 'timestamptz', name: 'extracted_at', nullable: true })
	extractedAt: Date | null;

	@Column({ type: 'timestamptz', name: 'created_at' })
	createdAt: Date;
}
