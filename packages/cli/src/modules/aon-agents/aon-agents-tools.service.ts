import type { AonDeliverableSummary, AonGuardIdentity, AonRunSummary } from '@n8n/api-types';
import type { User } from '@n8n/db';
import { Service } from '@n8n/di';
import z from 'zod';

import { isAonOwner } from '@/modules/aon-core/aon-owner';
import { AonGuardService } from '@/modules/aon-core/guard/aon-guard.service';
import { AON_OP_CLASSES, DEFAULT_AGENT_TIER_CEILING } from '@/modules/aon-core/guard/op-classes';
import { identityFromRequest } from '@/modules/aon-core/guard/request-identity';
import type { RegisterToolFn, ToolDefinition } from '@/modules/mcp/mcp.types';

import type { AgentAuthoringCaller } from './aon-agent-authoring.service';
import { AonAgentAuthoringService } from './aon-agent-authoring.service';
import { charterView } from './charter-view';
import { AonAgentRepository } from './database/repositories/aon-agent.repository';
import { AonRunRepository } from './database/repositories/aon-run.repository';

const charterShape = {
	purpose: z.string().max(4000).optional(),
	owns: z.array(z.string().max(200)).max(50).optional(),
	sources: z.array(z.string().max(200)).max(50).optional(),
	do: z.array(z.string().max(500)).max(50).optional(),
	dont: z.array(z.string().max(500)).max(50).optional(),
	skills: z.array(z.string().max(100)).max(50).optional(),
	tools: z.array(z.string().max(100)).max(50).optional(),
	tierCeiling: z.number().int().min(0).max(4).optional(),
	breakerLimit: z.number().int().min(1).max(50).optional(),
	escalateWhen: z.string().max(2000).optional(),
	budgetEurMonth: z.number().min(0).optional(),
	modelBand: z.enum(['fast', 'standard', 'deep']).optional(),
} satisfies z.ZodRawShape;

const deliverableSeedShape = {
	name: z.string().min(1).max(200),
	dod: z.string().min(1).max(4000),
	shape: z.enum(['single', 'recurring', 'goal']),
	cadence: z.string().max(200).optional(),
	tier: z.number().int().min(0).max(4).optional(),
	approver: z.enum(['owner', 'auto']).optional(),
} satisfies z.ZodRawShape;

const slugField = z.string().regex(/^[a-z0-9-]{2,40}$/, 'lowercase letters, digits and hyphens, 2 to 40 characters');

const agentsSchema = {} satisfies z.ZodRawShape;

const agentSchema = {
	slug: z.string().min(1).max(40).describe('The agent to read.'),
} satisfies z.ZodRawShape;

const agentCreateSchema = {
	slug: slugField.describe('A new, unused slug.'),
	name: z.string().min(1).max(200),
	persona: z.string().max(2000).optional(),
	charter: z.object(charterShape).describe('purpose, owns, sources, do, dont, skills, tools, and Guard settings.'),
	deliverables: z
		.array(z.object(deliverableSeedShape))
		.max(20)
		.optional()
		.describe('Deliverables to create alongside the agent.'),
} satisfies z.ZodRawShape;

const agentUpdateSchema = {
	slug: z.string().min(1).max(40),
	name: z.string().min(1).max(200).optional(),
	persona: z.string().max(2000).optional(),
	charter: z.object(charterShape).optional().describe('Only the keys given are changed; the rest are left alone.'),
} satisfies z.ZodRawShape;

const deliverableUpsertSchema = {
	agent: z.string().min(1).max(40).describe('The agent slug.'),
	id: z.string().optional().describe('Omit to create; give a deliverable id to change it.'),
	name: z.string().min(1).max(200),
	dod: z.string().min(1).max(4000).describe('Definition of done.'),
	shape: z.enum(['single', 'recurring', 'goal']),
	cadence: z.string().max(200).optional().describe('A cron expression, for shape "recurring", e.g. "0 7 * * 1".'),
	tier: z.number().int().min(0).max(4).optional(),
	approver: z.enum(['owner', 'auto']).optional(),
	enabled: z.boolean().optional(),
} satisfies z.ZodRawShape;

const agentStatusSchema = {
	slug: z.string().min(1).max(40),
	status: z.enum(['active', 'paused', 'draft']),
} satisfies z.ZodRawShape;

const runStartSchema = {
	agent: z.string().min(1).max(40),
	deliverable: z.string().min(1).max(200).describe('A deliverable id, its slug, or its name.'),
	input: z.string().max(20_000).optional(),
} satisfies z.ZodRawShape;

const runsSchema = {
	agent: z.string().max(40).optional(),
	status: z.string().max(40).optional(),
	limit: z.number().int().min(1).max(100).optional().describe('Default 20.'),
} satisfies z.ZodRawShape;

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
const failure = (error: unknown) => ({
	content: [{ type: 'text' as const, text: `Aon agents: ${error instanceof Error ? error.message : String(error)}` }],
	isError: true,
});

function deliverableLine(d: AonDeliverableSummary): string {
	const bits = [
		`[${d.id}] ${d.name}`,
		d.shape,
		d.cadence ? `cadence ${d.cadence}` : null,
		d.enabled ? null : 'disabled',
		d.nextRunAt ? `next ${d.nextRunAt}` : null,
		`tier ${d.tier}`,
		`approver ${d.approver}`,
	].filter((b): b is string => Boolean(b));
	return `- ${bits.join(', ')}\n  DoD: ${d.dod}`;
}

function runLine(r: AonRunSummary): string {
	return `- [${r.id}] ${r.agentSlug ?? r.agentId} / ${r.deliverableName ?? r.deliverableId}: ${r.status} (${r.invokedBy}, attempt ${r.attempt}.${r.iteration})${r.help ? ` — ${r.help}` : ''}`;
}

/**
 * Agent authoring as tools of this instance: build, read and change an
 * agent's charter and deliverables, start a run, read the roster and recent
 * runs. Thin wrappers over `AonAgentAuthoringService`, the same service the
 * REST controller uses — owner only, the way Aon belongs to him.
 */
@Service()
export class McpAonAgentsToolsService {
	constructor(
		private readonly agents: AonAgentRepository,
		private readonly runs: AonRunRepository,
		private readonly authoring: AonAgentAuthoringService,
		private readonly guard: AonGuardService,
	) {}

	/** The identity's own tier ceiling, for capping what it may hand a charter it authors. */
	private async callerContext(identity: AonGuardIdentity): Promise<AgentAuthoringCaller> {
		if (identity.kind === 'owner') return { kind: 'owner' };
		const agent = await this.agents.findOneBy({ slug: identity.name });
		const tierCeiling = agent
			? (charterView(agent.charter, agent.persona).guard.tierCeiling ?? DEFAULT_AGENT_TIER_CEILING)
			: DEFAULT_AGENT_TIER_CEILING;
		return { kind: 'agent', tierCeiling };
	}

	private guardLabel(opClass: string): string {
		return AON_OP_CLASSES.find((c) => c.opClass === opClass)?.label ?? opClass;
	}

	/** Guard's verdict for one call: `deny` returns a refusal, `ask` raises a card and returns the stop-and-wait text; `allow` records and returns null so the handler proceeds. */
	private async guarded(
		identity: AonGuardIdentity,
		toolName: string,
		args: Record<string, unknown>,
		summary: string,
	): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean } | null> {
		const decision = await this.guard.decideTool(identity, toolName, args);
		if (decision.verdict === 'deny') {
			await this.guard.record(identity, decision.opClass, 'deny', args);
			return { content: [{ type: 'text', text: `Guard denies this: ${this.guardLabel(decision.opClass)}` }], isError: true };
		}
		if (decision.verdict === 'ask') {
			const approval = await this.guard.requestApproval(identity, decision.opClass, summary, args);
			return text(`Guard needs the owner's yes: card ${approval.id} raised. Stop now and wait.`);
		}
		await this.guard.record(identity, decision.opClass, 'allow', args);
		return null;
	}

	registerTools(registerIfAllowed: RegisterToolFn, user: User) {
		if (!isAonOwner(user)) return;

		const agentsList: ToolDefinition<typeof agentsSchema> = {
			name: 'aon_agents',
			config: {
				description: "The roster of Aon agents: status, counts, and each one's last run.",
				inputSchema: agentsSchema,
				annotations: { title: 'List Aon agents', readOnlyHint: true },
			},
			handler: async (args, extra) => {
				try {
					const identity = identityFromRequest(extra, user);
					const blocked = await this.guarded(identity, 'aon_agents', args, 'List the agent roster.');
					if (blocked) return blocked;
					const roster = await this.agents.listRoster();
					if (roster.length === 0) return text('No agents yet.');
					const lines = roster.map(
						(a) =>
							`- ${a.name} (${a.slug}), ${a.status}, ${a.counts.deliverables} deliverables, ${a.counts.runs} runs, last run ${a.lastRun ? `${a.lastRun.status} at ${a.lastRun.createdAt}` : 'never'}`,
					);
					return text(lines.join('\n'));
				} catch (error) {
					return failure(error);
				}
			},
		};

		const agentGet: ToolDefinition<typeof agentSchema> = {
			name: 'aon_agent',
			config: {
				description: "One agent's full charter, its deliverables (with ids) and its most recent runs.",
				inputSchema: agentSchema,
				annotations: { title: 'Read an Aon agent', readOnlyHint: true },
			},
			handler: async (args, extra) => {
				try {
					const identity = identityFromRequest(extra, user);
					const blocked = await this.guarded(identity, 'aon_agent', args, `Read agent: ${args.slug}.`);
					if (blocked) return blocked;
					const detail = await this.authoring.getDetail(args.slug);
					const c = detail.charter;
					const sections = [
						`${detail.name} (${detail.slug}) — ${detail.status}`,
						detail.persona ? `Persona: ${detail.persona}` : null,
						c.orientation.purpose ? `Purpose: ${c.orientation.purpose}` : null,
						c.orientation.owns.length ? `Owns: ${c.orientation.owns.join(', ')}` : null,
						c.orientation.sources.length ? `Sources: ${c.orientation.sources.join(', ')}` : null,
						c.rules.do.length ? `Do:\n${c.rules.do.map((r) => `  - ${r}`).join('\n')}` : null,
						c.rules.dont.length ? `Never:\n${c.rules.dont.map((r) => `  - ${r}`).join('\n')}` : null,
						c.skills.length ? `Skills: ${c.skills.join(', ')}` : null,
						c.tools.length ? `Tools: ${c.tools.join(', ')}` : null,
						`Guard: tier ceiling ${c.guard.tierCeiling ?? 'default'}, breaker limit ${c.guard.breakerLimit ?? 'default'}, model band ${c.guard.modelBand ?? 'standard'}, budget €${c.guard.budgetEurMonth ?? 'none'}/mo`,
						detail.deliverables.length
							? `Deliverables:\n${detail.deliverables.map(deliverableLine).join('\n')}`
							: 'Deliverables: none yet.',
						detail.runs.length
							? `Recent runs:\n${detail.runs.slice(0, 10).map(runLine).join('\n')}`
							: 'Recent runs: none yet.',
					].filter((s): s is string => Boolean(s));
					return text(sections.join('\n\n'));
				} catch (error) {
					return failure(error);
				}
			},
		};

		const agentCreate: ToolDefinition<typeof agentCreateSchema> = {
			name: 'aon_agent_create',
			config: {
				description: 'Create a new Aon agent, as a draft: its orientation, rules, skills, tools, Guard, and optionally its first deliverables.',
				inputSchema: agentCreateSchema,
				annotations: { title: 'Create an Aon agent', readOnlyHint: false, destructiveHint: false },
			},
			handler: async (args, extra) => {
				try {
					const identity = identityFromRequest(extra, user);
					const blocked = await this.guarded(identity, 'aon_agent_create', args, `Create agent: ${args.slug}.`);
					if (blocked) return blocked;
					const caller = await this.callerContext(identity);
					const detail = await this.authoring.createAgent(
						{ slug: args.slug, name: args.name, persona: args.persona, charter: args.charter },
						user.email,
						caller,
					);
					for (const d of args.deliverables ?? []) {
						await this.authoring.createDeliverable(args.slug, d);
					}
					const final = args.deliverables?.length ? await this.authoring.getDetail(args.slug) : detail;
					return text(
						`Created ${final.name} (${final.slug}), draft, with ${final.deliverables.length} deliverable(s). Activate it with aon_agent_status once it is ready.`,
					);
				} catch (error) {
					return failure(error);
				}
			},
		};

		const agentUpdate: ToolDefinition<typeof agentUpdateSchema> = {
			name: 'aon_agent_update',
			config: {
				description: "Change an agent's name, persona, or charter. Only the fields given are changed; a list replaces the old one, everything else is left alone.",
				inputSchema: agentUpdateSchema,
				annotations: { title: 'Update an Aon agent', readOnlyHint: false, destructiveHint: false },
			},
			handler: async (args, extra) => {
				try {
					const identity = identityFromRequest(extra, user);
					const blocked = await this.guarded(identity, 'aon_agent_update', args, `Update agent: ${args.slug}.`);
					if (blocked) return blocked;
					const caller = await this.callerContext(identity);
					const detail = await this.authoring.updateCharter(
						args.slug,
						{
							name: args.name,
							persona: args.persona,
							charter: args.charter,
						},
						caller,
					);
					return text(`Updated ${detail.name} (${detail.slug}).`);
				} catch (error) {
					return failure(error);
				}
			},
		};

		const deliverableUpsert: ToolDefinition<typeof deliverableUpsertSchema> = {
			name: 'aon_deliverable_upsert',
			config: {
				description: 'Create a deliverable (omit id) or change one (give its id): name, definition of done, shape, cadence, tier, approver, enabled.',
				inputSchema: deliverableUpsertSchema,
				annotations: { title: 'Create or change a deliverable', readOnlyHint: false, destructiveHint: false },
			},
			handler: async (args, extra) => {
				try {
					const identity = identityFromRequest(extra, user);
					const blocked = await this.guarded(
						identity,
						'aon_deliverable_upsert',
						args,
						`${args.id ? 'Update' : 'Create'} deliverable for ${args.agent}: ${args.name}.`,
					);
					if (blocked) return blocked;
					const d = await this.authoring.upsertDeliverable(args.agent, args.id, {
						name: args.name,
						dod: args.dod,
						shape: args.shape,
						cadence: args.cadence,
						tier: args.tier,
						approver: args.approver,
						enabled: args.enabled,
					});
					return text(`${args.id ? 'Updated' : 'Created'} deliverable ${d.name} [${d.id}] for ${args.agent}.`);
				} catch (error) {
					return failure(error);
				}
			},
		};

		const agentStatus: ToolDefinition<typeof agentStatusSchema> = {
			name: 'aon_agent_status',
			config: {
				description: 'Set an agent to active, paused, or draft. Only an active agent claims runs.',
				inputSchema: agentStatusSchema,
				annotations: { title: 'Set an Aon agent status', readOnlyHint: false, destructiveHint: false },
			},
			handler: async (args, extra) => {
				try {
					const identity = identityFromRequest(extra, user);
					const blocked = await this.guarded(identity, 'aon_agent_status', args, `Set ${args.slug} to ${args.status}.`);
					if (blocked) return blocked;
					await this.authoring.setStatus(args.slug, args.status);
					return text(`${args.slug} is now ${args.status}.`);
				} catch (error) {
					return failure(error);
				}
			},
		};

		const runStart: ToolDefinition<typeof runStartSchema> = {
			name: 'aon_run_start',
			config: {
				description: "Queue a run of one of an agent's deliverables. It starts within a few seconds; it does not wait for the result.",
				inputSchema: runStartSchema,
				annotations: { title: 'Start an Aon run', readOnlyHint: false, destructiveHint: false },
			},
			handler: async (args, extra) => {
				try {
					const identity = identityFromRequest(extra, user);
					const blocked = await this.guarded(
						identity,
						'aon_run_start',
						args,
						`Start run: ${args.agent} / ${args.deliverable}.`,
					);
					if (blocked) return blocked;
					const run = await this.authoring.startRun(args.agent, args.deliverable, args.input, 'owner');
					return text(`Queued run ${run.id} for ${run.agentSlug ?? args.agent} / ${run.deliverableName ?? args.deliverable}.`);
				} catch (error) {
					return failure(error);
				}
			},
		};

		const runsList: ToolDefinition<typeof runsSchema> = {
			name: 'aon_runs',
			config: {
				description: 'Recent Aon runs, newest first; filter by agent slug and/or status.',
				inputSchema: runsSchema,
				annotations: { title: 'List Aon runs', readOnlyHint: true },
			},
			handler: async (args, extra) => {
				try {
					const identity = identityFromRequest(extra, user);
					const blocked = await this.guarded(identity, 'aon_runs', args, 'List recent runs.');
					if (blocked) return blocked;
					const agentId = args.agent ? (await this.agents.findRosterBySlug(args.agent))?.id : undefined;
					if (args.agent && !agentId) return text(`There is no agent called ${args.agent}.`);
					const { items } = await this.runs.list({ agentId, status: args.status, limit: args.limit ?? 20, offset: 0 });
					if (items.length === 0) return text('No runs match that.');
					return text(items.map(runLine).join('\n'));
				} catch (error) {
					return failure(error);
				}
			},
		};

		registerIfAllowed(agentsList);
		registerIfAllowed(agentGet);
		registerIfAllowed(agentCreate);
		registerIfAllowed(agentUpdate);
		registerIfAllowed(deliverableUpsert);
		registerIfAllowed(agentStatus);
		registerIfAllowed(runStart);
		registerIfAllowed(runsList);
	}
}
