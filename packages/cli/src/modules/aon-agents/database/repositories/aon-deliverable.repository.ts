import type { AonDeliverableSummary } from '@n8n/api-types';
import { Service } from '@n8n/di';
import { DataSource, Repository } from '@n8n/typeorm';

import { nextRunAtFor } from '../../executor/run-machine';
import { AonDeliverable } from '../entities/aon-deliverable.entity';

export function toDeliverableSummary(d: AonDeliverable): AonDeliverableSummary {
	return {
		id: d.id,
		slug: d.slug,
		name: d.name,
		dod: d.dod,
		shape: d.shape,
		cadence: d.cadence,
		tier: d.tier,
		approver: d.approver,
		maxIterations: d.maxIterations,
		enabled: d.enabled,
		lastRunAt: d.lastRunAt ? d.lastRunAt.toISOString() : null,
		nextRunAt: nextRunAtFor(d.cadence, d.lastRunAt ?? d.createdAt)?.toISOString() ?? null,
	};
}

export interface CreateDeliverableInput {
	id: string;
	agentId: string;
	slug: string;
	name: string;
	dod: string;
	shape: string;
	cadence: string | null;
	tier: number;
	approver: string;
	maxIterations: number;
	enabled: boolean;
}

export interface DeliverablePatch {
	name?: string;
	dod?: string;
	shape?: string;
	cadence?: string | null;
	tier?: number;
	approver?: string;
	maxIterations?: number;
	enabled?: boolean;
}

@Service()
export class AonDeliverableRepository extends Repository<AonDeliverable> {
	constructor(dataSource: DataSource) {
		super(AonDeliverable, dataSource.manager);
	}

	private table(): string {
		return this.manager.connection.driver.escape(this.manager.connection.getMetadata(AonDeliverable).tableName);
	}

	async listForAgent(agentId: string): Promise<AonDeliverableSummary[]> {
		const rows = await this.find({ where: { agentId }, order: { name: 'ASC' } });
		return rows.map(toDeliverableSummary);
	}

	/** Raw SQL: TypeORM's partial-entity typing has no room for a nullable jsonb value (`required_inputs`). */
	async createOne(input: CreateDeliverableInput): Promise<AonDeliverable> {
		await this.manager.query(
			`INSERT INTO ${this.table()}
				(id, agent_id, slug, name, dod, shape, cadence, tier, approver, required_inputs, max_iterations, enabled, last_run_at, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, $11, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
			[
				input.id,
				input.agentId,
				input.slug,
				input.name,
				input.dod,
				input.shape,
				input.cadence,
				input.tier,
				input.approver,
				input.maxIterations,
				input.enabled,
			],
		);
		return await this.findOneByOrFail({ id: input.id });
	}

	/** Updates only the fields present in `patch`; scoped to the agent so one agent cannot touch another's deliverable. */
	async updateFields(id: string, agentId: string, patch: DeliverablePatch): Promise<void> {
		const set: Record<string, unknown> = { updatedAt: new Date() };
		if (patch.name !== undefined) set.name = patch.name;
		if (patch.dod !== undefined) set.dod = patch.dod;
		if (patch.shape !== undefined) set.shape = patch.shape;
		if (patch.cadence !== undefined) set.cadence = patch.cadence;
		if (patch.tier !== undefined) set.tier = patch.tier;
		if (patch.approver !== undefined) set.approver = patch.approver;
		if (patch.maxIterations !== undefined) set.maxIterations = patch.maxIterations;
		if (patch.enabled !== undefined) set.enabled = patch.enabled;
		await this.update({ id, agentId }, set);
	}

	async deleteForAgent(id: string, agentId: string): Promise<boolean> {
		const result = await this.delete({ id, agentId });
		return (result.affected ?? 0) > 0;
	}

	/** By its id, or (failing that) its slug or name, case-insensitively — for a tool call that names a deliverable rather than pasting its id. */
	async findByIdOrNameForAgent(agentId: string, idOrName: string): Promise<AonDeliverable | null> {
		const byId = await this.findOneBy({ id: idOrName, agentId });
		if (byId) return byId;
		const rows = await this.find({ where: { agentId } });
		const needle = idOrName.toLowerCase();
		return rows.find((d) => d.slug.toLowerCase() === needle || d.name.toLowerCase() === needle) ?? null;
	}

	/** Enabled, recurring deliverables: candidates for the executor's routine tick. */
	async listEnabledRecurring(): Promise<AonDeliverable[]> {
		return await this.find({ where: { shape: 'recurring', enabled: true } });
	}
}
