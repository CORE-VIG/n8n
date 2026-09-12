import type { AonThreadDetail, AonThreadSummary } from '@n8n/api-types';
import { Service } from '@n8n/di';
import { DataSource, IsNull, Repository } from '@n8n/typeorm';
import { UserError } from 'n8n-workflow';

import { AonThread } from '../entities/aon-thread.entity';
import { AonTurn as AonTurnEntity } from '../entities/aon-turn.entity';

import { AonTurnRepository } from './aon-turn.repository';

interface SummaryRow {
	id: string;
	title: string | null;
	createdAt: Date;
	lastTurnAt: Date | null;
	turnCount: number;
	preview: string | null;
}

const toSummary = (row: SummaryRow): AonThreadSummary => ({
	id: row.id,
	title: row.title,
	createdAt: row.createdAt.toISOString(),
	lastTurnAt: row.lastTurnAt ? row.lastTurnAt.toISOString() : null,
	turnCount: row.turnCount,
	preview: row.preview,
});

/** The assistant's saved conversations: one row per thread, its turns held by {@link AonTurnRepository}. */
@Service()
export class AonThreadRepository extends Repository<AonThread> {
	constructor(
		dataSource: DataSource,
		private readonly turns: AonTurnRepository,
	) {
		super(AonThread, dataSource.manager);
	}

	private table(entity: typeof AonThread | typeof AonTurnEntity) {
		return this.manager.connection.driver.escape(
			this.manager.connection.getMetadata(entity).tableName,
		);
	}

	private summarySql(where: string) {
		const threads = this.table(AonThread);
		const turns = this.table(AonTurnEntity);
		return `SELECT t.id, t.title, t.created_at AS "createdAt", t.last_turn_at AS "lastTurnAt",
				(SELECT count(*) FROM ${turns} u WHERE u.thread_id = t.id)::int AS "turnCount",
				lp.preview AS "preview"
			FROM ${threads} t
			LEFT JOIN LATERAL (
				SELECT LEFT(u.text, 120) AS preview FROM ${turns} u
				WHERE u.thread_id = t.id AND u.role = 'assistant'
				ORDER BY u.created_at DESC LIMIT 1
			) lp ON true
			${where}
			ORDER BY t.last_turn_at DESC NULLS LAST, t.created_at DESC`;
	}

	/** Every one of the caller's saved conversations, most recently active first. */
	async listForUser(userId: string): Promise<AonThreadSummary[]> {
		const rows = await this.manager.query<SummaryRow[]>(this.summarySql('WHERE t.user_id = $1'), [
			userId,
		]);
		return rows.map(toSummary);
	}

	private async findSummaryForUser(id: string, userId: string): Promise<AonThreadSummary | null> {
		const rows = await this.manager.query<SummaryRow[]>(
			this.summarySql('WHERE t.id = $1 AND t.user_id = $2'),
			[id, userId],
		);
		return rows[0] ? toSummary(rows[0]) : null;
	}

	async findForUser(id: string, userId: string): Promise<AonThread | null> {
		return await this.findOneBy({ id, userId });
	}

	/** The full conversation: its summary plus every turn, oldest first. */
	async findDetail(id: string, userId: string): Promise<AonThreadDetail | null> {
		const summary = await this.findSummaryForUser(id, userId);
		if (!summary) return null;
		return { ...summary, turns: await this.turns.listForThread(id) };
	}

	/**
	 * Makes sure `id` has a row before a turn is appended to it. The id comes
	 * from the caller, so an existing row must already be theirs — otherwise
	 * this would let one user resume another user's conversation.
	 */
	async ensure(id: string, userId: string): Promise<AonThread> {
		const existing = await this.findOneBy({ id });
		if (existing) {
			if (existing.userId !== userId) {
				throw new UserError('That conversation belongs to someone else.');
			}
			return existing;
		}
		const now = new Date();
		const row = this.create({
			id,
			userId,
			title: null,
			claudeSessionId: null,
			createdAt: now,
			updatedAt: now,
			lastTurnAt: null,
		});
		try {
			return await this.save(row);
		} catch (error) {
			// Lost a race with a concurrent insert of the same id.
			const raced = await this.findOneBy({ id });
			if (raced && raced.userId === userId) return raced;
			throw error;
		}
	}

	async setClaudeSession(id: string, claudeSessionId: string | null): Promise<void> {
		await this.update({ id }, { claudeSessionId, updatedAt: new Date() });
	}

	async setTitleIfEmpty(id: string, title: string): Promise<void> {
		await this.update({ id, title: IsNull() }, { title, updatedAt: new Date() });
	}

	async touchLastTurn(id: string): Promise<void> {
		const now = new Date();
		await this.update({ id }, { lastTurnAt: now, updatedAt: now });
	}

	async rename(id: string, userId: string, title: string): Promise<AonThreadSummary | null> {
		const result = await this.update({ id, userId }, { title, updatedAt: new Date() });
		if (result.affected !== 1) return null;
		return await this.findSummaryForUser(id, userId);
	}

	/**
	 * Forgets a conversation. Named `deleteForUser`, not `remove`:
	 * `Repository.remove` already exists with an incompatible, entity-based shape.
	 */
	async deleteForUser(id: string, userId: string): Promise<boolean> {
		const result = await this.delete({ id, userId });
		return result.affected === 1;
	}
}
