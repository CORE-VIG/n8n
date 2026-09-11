import type { AonMemoryOverview } from '@n8n/api-types';
import { Service } from '@n8n/di';
import { DataSource, Repository } from '@n8n/typeorm';

import { AonSource } from '../entities/aon-source.entity';

@Service()
export class AonSourceRepository extends Repository<AonSource> {
	constructor(dataSource: DataSource) {
		super(AonSource, dataSource.manager);
	}

	private get table() {
		return this.manager.connection.driver.escape(this.metadata.tableName);
	}

	async countAll(): Promise<number> {
		return await this.count();
	}

	async countByOrigin(top: number): Promise<AonMemoryOverview['byOrigin']> {
		return await this.manager.query<AonMemoryOverview['byOrigin']>(
			`SELECT origin, count(*)::int AS count FROM ${this.table}
			GROUP BY origin ORDER BY count DESC, origin LIMIT $1`,
			[top],
		);
	}

	async lastIndexedAt(): Promise<string | null> {
		const rows = await this.manager.query<Array<{ last: Date | null }>>(
			`SELECT max(indexed_at) AS last FROM ${this.table}`,
		);
		return rows[0]?.last ? new Date(rows[0].last).toISOString() : null;
	}
}
