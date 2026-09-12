import type { AonRunEvent } from '@n8n/api-types';
import { Service } from '@n8n/di';
import { DataSource, Repository } from '@n8n/typeorm';

import { AonRunEvent as AonRunEventEntity } from '../entities/aon-run-event.entity';

interface EventRow {
	id: string;
	runId: string;
	seq: number;
	type: string;
	name: string | null;
	status: string | null;
	text: string | null;
	createdAt: Date;
}

/** The DB column is free text; only our own `append` ever writes it, so this narrowing is safe. */
function toEventType(value: string): AonRunEvent['type'] {
	if (value === 'tool') return 'tool';
	if (value === 'judge') return 'judge';
	if (value === 'status') return 'status';
	if (value === 'error') return 'error';
	if (value === 'cost') return 'cost';
	if (value === 'note') return 'note';
	return 'text';
}

const toEvent = (row: EventRow): AonRunEvent => ({
	id: Number(row.id),
	runId: row.runId,
	seq: row.seq,
	type: toEventType(row.type),
	name: row.name,
	status: row.status,
	text: row.text,
	createdAt: row.createdAt.toISOString(),
});

/** A run's live log: what the agent said, called, or was told, in order. */
@Service()
export class AonRunEventRepository extends Repository<AonRunEventEntity> {
	constructor(dataSource: DataSource) {
		super(AonRunEventEntity, dataSource.manager);
	}

	private table(): string {
		return this.manager.connection.driver.escape(this.metadata.tableName);
	}

	/**
	 * One line appended to a run's log. The next sequence number is computed
	 * in the same statement as the insert, so two events from the same run
	 * never race for the same seq.
	 */
	async append(
		runId: string,
		input: { type: AonRunEvent['type']; name?: string | null; status?: string | null; text?: string | null },
	): Promise<AonRunEvent> {
		const rows = await this.manager.query<EventRow[]>(
			`INSERT INTO ${this.table()} (run_id, seq, type, name, status, text, created_at)
			SELECT $1, COALESCE(MAX(seq), 0) + 1, $2, $3, $4, $5, CURRENT_TIMESTAMP
			FROM ${this.table()} WHERE run_id = $1
			RETURNING id, run_id AS "runId", seq, type, name, status, text, created_at AS "createdAt"`,
			[runId, input.type, input.name ?? null, input.status ?? null, input.text ?? null],
		);
		const row = rows[0];
		if (!row) throw new Error(`Could not append an event to run ${runId}.`);
		return toEvent(row);
	}

	/** A run's log, oldest first; `afterSeq` gives only what a live poll has not seen. */
	async listForRun(runId: string, afterSeq = 0): Promise<AonRunEvent[]> {
		const rows = await this.manager.query<EventRow[]>(
			`SELECT id, run_id AS "runId", seq, type, name, status, text, created_at AS "createdAt"
			FROM ${this.table()}
			WHERE run_id = $1 AND seq > $2
			ORDER BY seq ASC`,
			[runId, afterSeq],
		);
		return rows.map(toEvent);
	}
}
