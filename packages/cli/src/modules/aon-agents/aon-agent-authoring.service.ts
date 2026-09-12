import type { AonAgentDetail, AonCharterInput, AonDeliverableSummary, AonRunSummary } from '@n8n/api-types';
import { Service } from '@n8n/di';
import { randomUUID } from 'node:crypto';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';

import { charterView } from './charter-view';
import type { AonAgent } from './database/entities/aon-agent.entity';
import type { AonDeliverable } from './database/entities/aon-deliverable.entity';
import { AonAgentRepository } from './database/repositories/aon-agent.repository';
import { AonDeliverableRepository, toDeliverableSummary } from './database/repositories/aon-deliverable.repository';
import { AonLearnedRuleRepository } from './database/repositories/aon-learned-rule.repository';
import { AonRunRepository } from './database/repositories/aon-run.repository';

const RUNS_PER_AGENT = 20;
const SLUG_RE = /^[a-z0-9-]{2,40}$/;
/** No charter, owner included, may set a standing monthly budget above this. */
const MAX_BUDGET_EUR_MONTH = 1000;

/**
 * Who is authoring the charter: the owner (unrestricted), or an agent acting
 * through its own tool call, which may not hand out a tier ceiling above its
 * own. The REST controller is owner-only, so it always passes `owner`; the
 * MCP tools service resolves this from the request's Guard identity.
 */
export type AgentAuthoringCaller = { kind: 'owner' } | { kind: 'agent'; tierCeiling: number };

function slugifyName(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60);
	return slug || 'item';
}

/** Drops undefined keys; a jsonb merge treats an undefined value differently from an absent one. */
function charterRawFrom(input: AonCharterInput): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		if (value !== undefined) out[key] = value;
	}
	return out;
}

export interface CreateAgentInput {
	slug: string;
	name: string;
	persona?: string;
	charter: AonCharterInput;
}

export interface UpdateCharterInput {
	name?: string;
	persona?: string;
	charter?: AonCharterInput;
}

export interface DeliverableAuthoringInput {
	name?: string;
	dod?: string;
	shape?: string;
	cadence?: string;
	tier?: number;
	approver?: string;
	maxIterations?: number;
	enabled?: boolean;
}

/**
 * Everything the REST controller and the MCP authoring tools do to an agent's
 * charter and deliverables, in one place, so the two surfaces stay identical.
 */
@Service()
export class AonAgentAuthoringService {
	constructor(
		private readonly agents: AonAgentRepository,
		private readonly deliverables: AonDeliverableRepository,
		private readonly runs: AonRunRepository,
		private readonly rules: AonLearnedRuleRepository,
	) {}

	async getDetail(slug: string): Promise<AonAgentDetail> {
		const summary = await this.agents.findRosterBySlug(slug);
		if (!summary) throw new NotFoundError(`There is no agent called ${slug}`);
		const agent = await this.agents.findOneByOrFail({ id: summary.id });
		const [deliverables, runs, rules, spentEurMonth] = await Promise.all([
			this.deliverables.listForAgent(agent.id),
			this.runs.listRecent({ agentId: agent.id, limit: RUNS_PER_AGENT }),
			this.rules.listForAgent(agent.id),
			this.runs.sumCostEurThisMonth(agent.id),
		]);
		return {
			...summary,
			charter: charterView(agent.charter, agent.persona),
			deliverables,
			runs,
			rules,
			spentEurMonth,
		};
	}

	async resolveAgent(slug: string): Promise<AonAgent> {
		const agent = await this.agents.findOneBy({ slug });
		if (!agent) throw new NotFoundError(`There is no agent called ${slug}`);
		return agent;
	}

	async resolveDeliverable(agentSlug: string, idOrName: string): Promise<AonDeliverable> {
		const agent = await this.resolveAgent(agentSlug);
		const deliverable = await this.deliverables.findByIdOrNameForAgent(agent.id, idOrName);
		if (!deliverable) throw new NotFoundError(`There is no deliverable "${idOrName}" for ${agentSlug}.`);
		return deliverable;
	}

	async createAgent(
		input: CreateAgentInput,
		createdBy: string,
		caller: AgentAuthoringCaller = { kind: 'owner' },
	): Promise<AonAgentDetail> {
		if (!SLUG_RE.test(input.slug)) {
			throw new BadRequestError('slug must be lowercase letters, digits and hyphens, 2 to 40 characters.');
		}
		const existing = await this.agents.findOneBy({ slug: input.slug });
		if (existing) throw new BadRequestError(`There is already an agent called ${input.slug}.`);
		await this.agents.createDraft({
			id: randomUUID(),
			slug: input.slug,
			name: input.name,
			persona: input.persona ?? '',
			charter: charterRawFrom(this.sanitizeCharter(input.charter, caller)),
			createdBy,
		});
		return await this.getDetail(input.slug);
	}

	async updateCharter(
		slug: string,
		input: UpdateCharterInput,
		caller: AgentAuthoringCaller = { kind: 'owner' },
	): Promise<AonAgentDetail> {
		const agent = await this.resolveAgent(slug);
		await this.agents.mergeCharter(agent.id, {
			name: input.name,
			persona: input.persona,
			charterPatch: input.charter ? charterRawFrom(this.sanitizeCharter(input.charter, caller)) : undefined,
		});
		return await this.getDetail(slug);
	}

	/**
	 * Caps a charter's budget instance-wide, and, when an agent is authoring
	 * (not the owner), refuses a tier ceiling above the caller's own — an
	 * agent may never hand a charter it writes more room than it has itself.
	 */
	private sanitizeCharter(charter: AonCharterInput, caller: AgentAuthoringCaller): AonCharterInput {
		const out: AonCharterInput = { ...charter };
		if (out.budgetEurMonth !== undefined) out.budgetEurMonth = Math.min(out.budgetEurMonth, MAX_BUDGET_EUR_MONTH);
		if (out.tierCeiling !== undefined && caller.kind === 'agent' && out.tierCeiling > caller.tierCeiling) {
			throw new BadRequestError(
				`An agent may not set a tier ceiling (${out.tierCeiling}) above its own (${caller.tierCeiling}).`,
			);
		}
		return out;
	}

	async createDeliverable(agentSlug: string, input: DeliverableAuthoringInput): Promise<AonDeliverableSummary> {
		const agent = await this.resolveAgent(agentSlug);
		if (!input.name?.trim()) throw new BadRequestError('A deliverable needs a name.');
		if (!input.dod?.trim()) throw new BadRequestError('A deliverable needs a definition of done.');
		const created = await this.deliverables.createOne({
			id: randomUUID(),
			agentId: agent.id,
			slug: `${agent.slug}-${slugifyName(input.name)}`,
			name: input.name,
			dod: input.dod,
			shape: input.shape ?? 'single',
			cadence: input.cadence?.trim() ? input.cadence.trim() : null,
			tier: input.tier ?? 2,
			approver: input.approver ?? 'owner',
			maxIterations: input.maxIterations ?? 3,
			enabled: input.enabled ?? true,
		});
		return toDeliverableSummary(created);
	}

	async updateDeliverable(
		agentSlug: string,
		deliverableId: string,
		input: DeliverableAuthoringInput,
	): Promise<AonDeliverableSummary> {
		const agent = await this.resolveAgent(agentSlug);
		const existing = await this.deliverables.findOneBy({ id: deliverableId, agentId: agent.id });
		if (!existing) throw new NotFoundError(`There is no deliverable ${deliverableId} for ${agentSlug}.`);
		await this.deliverables.updateFields(deliverableId, agent.id, {
			name: input.name,
			dod: input.dod,
			shape: input.shape,
			cadence: input.cadence !== undefined ? (input.cadence.trim() ? input.cadence.trim() : null) : undefined,
			tier: input.tier,
			approver: input.approver,
			maxIterations: input.maxIterations,
			enabled: input.enabled,
		});
		const updated = await this.deliverables.findOneByOrFail({ id: deliverableId });
		return toDeliverableSummary(updated);
	}

	/** Creates when `deliverableId` is omitted, updates otherwise — the MCP tool's one call for both. */
	async upsertDeliverable(
		agentSlug: string,
		deliverableId: string | undefined,
		input: DeliverableAuthoringInput,
	): Promise<AonDeliverableSummary> {
		return deliverableId
			? await this.updateDeliverable(agentSlug, deliverableId, input)
			: await this.createDeliverable(agentSlug, input);
	}

	async deleteDeliverable(agentSlug: string, deliverableId: string): Promise<void> {
		const agent = await this.resolveAgent(agentSlug);
		const deleted = await this.deliverables.deleteForAgent(deliverableId, agent.id);
		if (!deleted) throw new NotFoundError(`There is no deliverable ${deliverableId} for ${agentSlug}.`);
	}

	/** Only a draft or paused agent may be deleted, and only when nothing of it is in flight; its deliverables and runs go with it (cascade). */
	async deleteAgent(slug: string): Promise<void> {
		const agent = await this.resolveAgent(slug);
		if (agent.status === 'active') throw new BadRequestError(`${slug} is active; pause it before deleting it.`);
		if (await this.runs.hasInFlightForAgent(agent.id)) throw new BadRequestError(`${slug} has a run in flight; stop it first.`);
		await this.agents.delete({ id: agent.id });
	}

	async setStatus(slug: string, status: string): Promise<void> {
		const agent = await this.resolveAgent(slug);
		await this.agents.setStatus(agent.id, status);
	}

	async startRun(
		agentSlug: string,
		deliverableIdOrName: string,
		input: string | undefined,
		trigger: string,
	): Promise<AonRunSummary> {
		const agent = await this.resolveAgent(agentSlug);
		// The executor claims runs of active agents only; a run queued for a draft or paused agent would wait forever.
		if (agent.status !== 'active') {
			throw new BadRequestError(`${agentSlug} is ${agent.status}; activate it before starting a run.`);
		}
		const deliverable = await this.resolveDeliverable(agentSlug, deliverableIdOrName);
		const run = await this.runs.createQueued({
			id: randomUUID(),
			deliverableId: deliverable.id,
			agentId: agent.id,
			parentRunId: null,
			iteration: 1,
			attempt: 1,
			trigger,
			input: input?.trim() ? { text: input } : null,
		});
		return {
			id: run.id,
			agentId: agent.id,
			agentSlug: agent.slug,
			agentName: agent.name,
			deliverableId: deliverable.id,
			deliverableName: deliverable.name,
			status: run.status,
			attempt: run.attempt,
			iteration: run.iteration,
			invokedBy: run.trigger,
			model: run.model,
			tokensIn: run.tokensIn,
			tokensOut: run.tokensOut,
			costEur: run.costEur,
			help: run.help,
			startedAt: run.startedAt ? run.startedAt.toISOString() : null,
			finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
			createdAt: run.createdAt.toISOString(),
		};
	}
}
