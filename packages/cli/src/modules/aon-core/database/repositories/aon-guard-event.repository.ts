import type { AonGuardEvent as AonGuardEventApi, AonGuardVerdict } from '@n8n/api-types';
import { Service } from '@n8n/di';
import { DataSource, Repository } from '@n8n/typeorm';

import { AonGuardEvent } from '../entities/aon-guard-event.entity';

type EventVerdict = AonGuardVerdict | 'asked' | 'approved' | 'denied' | 'expired';

const EVENT_VERDICTS: readonly string[] = ['allow', 'ask', 'deny', 'asked', 'approved', 'denied', 'expired'];

function isEventVerdict(value: string): value is EventVerdict {
	return EVENT_VERDICTS.includes(value);
}

const toEvent = (row: AonGuardEvent): AonGuardEventApi => ({
	id: Number(row.id),
	ts: row.ts.toISOString(),
	identity: row.identity,
	opClass: row.opClass,
	tier: row.tier,
	verdict: isEventVerdict(row.verdict) ? row.verdict : 'asked',
	approvalId: row.approvalId,
	meta: row.meta,
});

/** The audit trail: append-only, read back newest first. */
@Service()
export class AonGuardEventRepository extends Repository<AonGuardEvent> {
	constructor(dataSource: DataSource) {
		super(AonGuardEvent, dataSource.manager);
	}

	async append(input: {
		identity: string;
		opClass: string;
		tier: number;
		verdict: string;
		approvalId: string | null;
		meta: Record<string, unknown> | null;
	}): Promise<void> {
		await this.save(
			this.create({
				ts: new Date(),
				identity: input.identity,
				opClass: input.opClass,
				tier: input.tier,
				verdict: input.verdict,
				approvalId: input.approvalId,
				meta: input.meta,
			}),
		);
	}

	async listRecent(limit: number): Promise<AonGuardEventApi[]> {
		const rows = await this.find({ order: { ts: 'DESC' }, take: limit });
		return rows.map(toEvent);
	}
}
