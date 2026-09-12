import type { AonTurn, AonTurnTool } from '@n8n/api-types';
import { Service } from '@n8n/di';
import { DataSource, Repository } from '@n8n/typeorm';
import { randomUUID } from 'node:crypto';

import { AonTurn as AonTurnEntity } from '../entities/aon-turn.entity';

/** `role` is stored as plain text; only our own `addTurn` ever writes it, so this narrowing is safe. */
export const toTurn = (row: AonTurnEntity): AonTurn => ({
	id: row.id,
	role: row.role === 'user' ? 'user' : 'assistant',
	text: row.text,
	tools: row.tools,
	costUsd: row.costUsd,
	createdAt: row.createdAt.toISOString(),
});

@Service()
export class AonTurnRepository extends Repository<AonTurnEntity> {
	constructor(dataSource: DataSource) {
		super(AonTurnEntity, dataSource.manager);
	}

	/**
	 * One turn, spoken or answered, appended to a thread. Named `addTurn`, not
	 * `insert`: `Repository.insert` already exists with an incompatible shape.
	 */
	async addTurn(input: {
		threadId: string;
		role: 'user' | 'assistant';
		text: string;
		tools: AonTurnTool[] | null;
		costUsd: number;
	}): Promise<AonTurn> {
		const row = await this.save(
			this.create({
				id: randomUUID(),
				threadId: input.threadId,
				role: input.role,
				text: input.text,
				tools: input.tools,
				costUsd: input.costUsd,
				createdAt: new Date(),
			}),
		);
		return toTurn(row);
	}

	/** A thread's turns, oldest first: the order a conversation reads in. */
	async listForThread(threadId: string): Promise<AonTurn[]> {
		const rows = await this.find({ where: { threadId }, order: { createdAt: 'ASC' } });
		return rows.map(toTurn);
	}
}
