import { Service } from '@n8n/di';
import { DataSource, Repository } from '@n8n/typeorm';

import { AonWorkspace } from '../entities/aon-workspace.entity';

/** A workspace row, dates already as ISO strings. */
export interface AonWorkspaceRow {
	id: string;
	slug: string;
	createdAt: string;
	lastUsedAt: string;
}

interface WorkspaceRawRow {
	id: string;
	slug: string;
	createdAt: Date;
	lastUsedAt: Date;
}

const iso = (d: Date) => new Date(d).toISOString();

const toRow = (row: WorkspaceRawRow): AonWorkspaceRow => ({
	id: row.id,
	slug: row.slug,
	createdAt: iso(row.createdAt),
	lastUsedAt: iso(row.lastUsedAt),
});

@Service()
export class AonWorkspaceRepository extends Repository<AonWorkspace> {
	constructor(dataSource: DataSource) {
		super(AonWorkspace, dataSource.manager);
	}

	private table() {
		return this.manager.connection.driver.escape(
			this.manager.connection.getMetadata(AonWorkspace).tableName,
		);
	}

	/** A user's workspaces, most recently used first. */
	async listForUser(userId: string): Promise<AonWorkspaceRow[]> {
		const rows = await this.manager.query<WorkspaceRawRow[]>(
			`SELECT id, slug, created_at AS "createdAt", last_used_at AS "lastUsedAt"
				FROM ${this.table()}
				WHERE user_id = $1
				ORDER BY last_used_at DESC`,
			[userId],
		);
		return rows.map(toRow);
	}

	async findForUser(userId: string, slug: string): Promise<AonWorkspaceRow | null> {
		const rows = await this.manager.query<WorkspaceRawRow[]>(
			`SELECT id, slug, created_at AS "createdAt", last_used_at AS "lastUsedAt"
				FROM ${this.table()}
				WHERE user_id = $1 AND slug = $2`,
			[userId, slug],
		);
		return rows[0] ? toRow(rows[0]) : null;
	}

	/** Records that a workspace was just opened, creating its row the first time. */
	async touch({ id, userId, slug }: { id: string; userId: string; slug: string }): Promise<void> {
		await this.manager.query(
			`INSERT INTO ${this.table()} (id, user_id, slug)
				VALUES ($1, $2, $3)
				ON CONFLICT (id) DO UPDATE SET last_used_at = CURRENT_TIMESTAMP`,
			[id, userId, slug],
		);
	}

	/**
	 * Named `deleteById`, not `remove` or `delete`: `Repository<AonWorkspace>`
	 * already declares both with incompatible signatures.
	 */
	async deleteById(id: string): Promise<void> {
		await this.manager.query(`DELETE FROM ${this.table()} WHERE id = $1`, [id]);
	}
}
