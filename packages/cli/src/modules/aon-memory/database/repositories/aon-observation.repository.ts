import type { AonObservationSummary } from '@n8n/api-types';
import { Service } from '@n8n/di';
import { DataSource, Repository } from '@n8n/typeorm';

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
}
