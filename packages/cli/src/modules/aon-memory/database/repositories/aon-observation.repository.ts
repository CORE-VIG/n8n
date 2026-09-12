import type { AonObservationSummary } from '@n8n/api-types';
import { Service } from '@n8n/di';
import { DataSource, Repository } from '@n8n/typeorm';
import { randomUUID } from 'node:crypto';

import { AonObservation } from '../entities/aon-observation.entity';

interface ObservationRow {
	id: string;
	bucket: string;
	text: string;
	salience: number;
	status: string;
	firstSeen: Date;
	lastSeen: Date;
}

const iso = (d: Date | string) => new Date(d).toISOString();

const toSummary = (r: ObservationRow): AonObservationSummary => ({
	id: r.id,
	bucket: r.bucket,
	text: r.text,
	salience: Number(r.salience),
	status: r.status,
	firstSeen: iso(r.firstSeen),
	lastSeen: iso(r.lastSeen),
});

@Service()
export class AonObservationRepository extends Repository<AonObservation> {
	constructor(dataSource: DataSource) {
		super(AonObservation, dataSource.manager);
	}

	private get table() {
		return this.manager.connection.driver.escape(this.metadata.tableName);
	}

	/** Most salient, most recently seen first. */
	async list(limit: number): Promise<AonObservationSummary[]> {
		const rows = await this.manager.query<ObservationRow[]>(
			`SELECT id, bucket, text, salience, status, first_seen AS "firstSeen", last_seen AS "lastSeen"
			FROM ${this.table}
			ORDER BY salience DESC, last_seen DESC
			LIMIT $1`,
			[limit],
		);
		return rows.map(toSummary);
	}

	async countAll(): Promise<number> {
		return await this.count();
	}

	/**
	 * The dream's own write: an identical (bucket, text) is refreshed in
	 * place — its salience and `lastSeen` move, nothing new is inserted —
	 * anything else becomes a new active observation.
	 */
	async upsertObservation(input: { bucket: string; text: string; salience: number }): Promise<void> {
		const text = input.text.trim().slice(0, 400);
		if (!text) return;
		const now = new Date();
		const existing = await this.manager.query<Array<{ id: string }>>(
			`SELECT id FROM ${this.table} WHERE bucket = $1 AND lower(text) = lower($2) LIMIT 1`,
			[input.bucket, text],
		);
		if (existing[0]) {
			await this.manager.query(
				`UPDATE ${this.table} SET salience = $1, last_seen = $2, status = 'active' WHERE id = $3`,
				[input.salience, now, existing[0].id],
			);
			return;
		}
		await this.insert({
			id: randomUUID(),
			bucket: input.bucket,
			text,
			salience: input.salience,
			firstSeen: now,
			lastSeen: now,
			status: 'active',
		});
	}
}
