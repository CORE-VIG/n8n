import type { AonAgentsOverview, AonGuardIdentity, AonRunEvent } from '@n8n/api-types';
import type { User } from '@n8n/db';
import { Service } from '@n8n/di';
import z from 'zod';

import { isAonOwner } from '@/modules/aon-core/aon-owner';
import { AonGuardService } from '@/modules/aon-core/guard/aon-guard.service';
import { AON_OP_CLASSES } from '@/modules/aon-core/guard/op-classes';
import { identityFromRequest } from '@/modules/aon-core/guard/request-identity';
import type { RegisterToolFn, ToolDefinition } from '@/modules/mcp/mcp.types';

import { AonAgentAuthoringService } from './aon-agent-authoring.service';
import { AonAgentRepository } from './database/repositories/aon-agent.repository';
import { AonDeliverableRepository } from './database/repositories/aon-deliverable.repository';
import { AonLearnedRuleRepository } from './database/repositories/aon-learned-rule.repository';
import { AonRunEventRepository } from './database/repositories/aon-run-event.repository';
import { AonRunRepository } from './database/repositories/aon-run.repository';
import { AonExecutorService } from './executor/aon-executor.service';

const EVENTS_SHOWN = 40;
const OUTPUT_MAX_CHARS = 8000;

const runReportSchema = {
	runId: z.string().min(1).max(100),
} satisfies z.ZodRawShape;

const overviewSchema = {} satisfies z.ZodRawShape;

const deliverableDeleteSchema = {
	agent: z.string().min(1).max(40).describe('The agent slug.'),
	id: z.string().min(1).max(100).describe('The deliverable to delete.'),
} satisfies z.ZodRawShape;

const agentDeleteSchema = {
	slug: z.string().min(1).max(40),
} satisfies z.ZodRawShape;

const breakerResetSchema = {
	slug: z.string().min(1).max(40),
} satisfies z.ZodRawShape;

const runStopSchema = {
	runId: z.string().min(1).max(100),
} satisfies z.ZodRawShape;

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
const failure = (error: unknown) => ({
	content: [{ type: 'text' as const, text: `Aon agents: ${error instanceof Error ? error.message : String(error)}` }],
	isError: true,
});

/** The judge's verdict as `aon-executor.service.ts` stores it: `{ judge: { met, critique, evidence, status } }`. */
function judgeVerdict(verification: unknown): { met: boolean | null; critique: string } | null {
	if (!verification || typeof verification !== 'object') return null;
	const judge = (verification as Record<string, unknown>).judge;
	if (!judge || typeof judge !== 'object') return null;
	const record = judge as Record<string, unknown>;
	const met = record.met;
	if (met !== true && met !== false && met !== null) return null;
	return { met, critique: typeof record.critique === 'string' ? record.critique : '' };
}

function eventLine(e: AonRunEvent): string {
	const bits = [e.type, e.name, e.status].filter((b): b is string => Boolean(b));
	return `- [${e.seq}] ${bits.join(' ')}${e.text ? `: ${e.text}` : ''}`;
}

function sumCounts(counts: Record<string, number>): number {
	return Object.values(counts).reduce((total, n) => total + n, 0);
}

/**
 * The rest of Aon agents as tools: the roster's overview numbers, deleting a
 * deliverable or a draft/paused agent, resetting a breaker, stopping a run,
 * and a run's full report in one call. Thin wrappers over the same
 * repositories and `AonAgentAuthoringService` the REST controllers use —
 * owner only, the way Aon belongs to him; each effect still passes Guard,
 * because an agent's own run may call these on itself.
 */
@Service()
export class McpAonAgentsExtraToolsService {
	constructor(
		private readonly agents: AonAgentRepository,
		private readonly deliverables: AonDeliverableRepository,
		private readonly runs: AonRunRepository,
		private readonly events: AonRunEventRepository,
		private readonly rules: AonLearnedRuleRepository,
		private readonly authoring: AonAgentAuthoringService,
		private readonly executor: AonExecutorService,
		private readonly guard: AonGuardService,
	) {}

	private guardLabel(opClass: string): string {
		return AON_OP_CLASSES.find((c) => c.opClass === opClass)?.label ?? opClass;
	}

	/** Guard's verdict for one call: `deny` refuses, `ask` raises a card and returns the stop-and-wait text; `allow` records and returns null so the handler proceeds. */
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

		const overview: ToolDefinition<typeof overviewSchema> = {
			name: 'aon_agents_overview',
			config: {
				description: 'The Agents page in one call: how many agents, active agents, deliverables and runs, runs by status, rules in force, and the last run time.',
				inputSchema: overviewSchema,
				annotations: { title: 'Agents overview', readOnlyHint: true },
			},
			handler: async (args, extra) => {
				try {
					const identity = identityFromRequest(extra, user);
					const blocked = await this.guarded(identity, 'aon_agents_overview', args, 'Read the agents overview.');
					if (blocked) return blocked;
					const [agentsByStatus, deliverableCount, runsByStatus, rulesInForce, lastRunAt] = await Promise.all([
						this.agents.countByStatus(),
						this.deliverables.count(),
						this.runs.countByStatus(),
						this.rules.countInForce(),
						this.runs.lastCreatedAt(),
					]);
					const overviewResult: AonAgentsOverview = {
						agents: sumCounts(agentsByStatus),
						activeAgents: agentsByStatus.active ?? 0,
						deliverables: deliverableCount,
						runs: sumCounts(runsByStatus),
						runsByStatus,
						rules: rulesInForce,
						lastRunAt,
					};
					const statusLine = Object.entries(overviewResult.runsByStatus)
						.map(([status, n]) => `${status} ${n}`)
						.join(', ');
					return text(
						`${overviewResult.agents} agent(s), ${overviewResult.activeAgents} active, ${overviewResult.deliverables} deliverable(s), ${overviewResult.rules} rule(s) in force.\nRuns: ${overviewResult.runs} total${statusLine ? ` (${statusLine})` : ''}. Last run ${overviewResult.lastRunAt ?? 'never'}.`,
					);
				} catch (error) {
					return failure(error);
				}
			},
		};

		const deliverableDelete: ToolDefinition<typeof deliverableDeleteSchema> = {
			name: 'aon_deliverable_delete',
			config: {
				description: "Delete one of an agent's deliverables.",
				inputSchema: deliverableDeleteSchema,
				annotations: { title: 'Delete a deliverable', readOnlyHint: false, destructiveHint: true },
			},
			handler: async (args, extra) => {
				try {
					const identity = identityFromRequest(extra, user);
					const blocked = await this.guarded(
						identity,
						'aon_deliverable_delete',
						args,
						`Delete deliverable ${args.id} of ${args.agent}.`,
					);
					if (blocked) return blocked;
					await this.authoring.deleteDeliverable(args.agent, args.id);
					return text(`Deleted deliverable ${args.id} of ${args.agent}.`);
				} catch (error) {
					return failure(error);
				}
			},
		};

		const agentDelete: ToolDefinition<typeof agentDeleteSchema> = {
			name: 'aon_agent_delete',
			config: {
				description: 'Delete a draft or paused agent, with its deliverables and runs. Refuses an active agent or one with a run in flight.',
				inputSchema: agentDeleteSchema,
				annotations: { title: 'Delete an Aon agent', readOnlyHint: false, destructiveHint: true },
			},
			handler: async (args, extra) => {
				try {
					const identity = identityFromRequest(extra, user);
					const blocked = await this.guarded(identity, 'aon_agent_delete', args, `Delete agent ${args.slug}.`);
					if (blocked) return blocked;
					await this.authoring.deleteAgent(args.slug);
					return text(`Deleted ${args.slug}.`);
				} catch (error) {
					return failure(error);
				}
			},
		};

		const breakerReset: ToolDefinition<typeof breakerResetSchema> = {
			name: 'aon_agent_breaker_reset',
			config: {
				description: "Resets an agent's breaker, so it may claim runs again after tripping its failure limit.",
				inputSchema: breakerResetSchema,
				annotations: { title: 'Reset an agent breaker', readOnlyHint: false, destructiveHint: false },
			},
			handler: async (args, extra) => {
				try {
					const identity = identityFromRequest(extra, user);
					const blocked = await this.guarded(identity, 'aon_agent_breaker_reset', args, `Reset breaker for ${args.slug}.`);
					if (blocked) return blocked;
					const summary = await this.agents.findRosterBySlug(args.slug);
					if (!summary) return text(`There is no agent called ${args.slug}.`);
					await this.agents.resetBreaker(summary.id);
					return text(`Breaker reset for ${args.slug}.`);
				} catch (error) {
					return failure(error);
				}
			},
		};

		const runStop: ToolDefinition<typeof runStopSchema> = {
			name: 'aon_run_stop',
			config: {
				description: "Stops an agent's run: aborts it if it is running now, and marks it stopped.",
				inputSchema: runStopSchema,
				annotations: { title: 'Stop a run', readOnlyHint: false, destructiveHint: true },
			},
			handler: async (args, extra) => {
				try {
					const identity = identityFromRequest(extra, user);
					const blocked = await this.guarded(identity, 'aon_run_stop', args, `Stop run ${args.runId}.`);
					if (blocked) return blocked;
					const existing = await this.runs.findDetail(args.runId);
					if (!existing) return text(`There is no run with id ${args.runId}.`);
					await this.executor.stop(args.runId);
					return text(`Run ${args.runId} stopped.`);
				} catch (error) {
					return failure(error);
				}
			},
		};

		const runReport: ToolDefinition<typeof runReportSchema> = {
			name: 'aon_run_report',
			config: {
				description:
					"One run's full report: its agent, deliverable, status, attempt, timing, model, cost, the judge's verdict and critique, its output, and its last events.",
				inputSchema: runReportSchema,
				annotations: { title: 'Run report', readOnlyHint: true },
			},
			handler: async (args) => {
				try {
					const run = await this.runs.findDetail(args.runId);
					if (!run) return text(`There is no run with id ${args.runId}.`);
					const verdict = judgeVerdict(run.verification);
					const allEvents = await this.events.listForRun(run.id);
					const recent = allEvents.slice(-EVENTS_SHOWN);
					const output = run.output ?? '';
					const truncated = output.length > OUTPUT_MAX_CHARS;
					const sections = [
						`${run.agentSlug ?? run.agentId} / ${run.deliverableName ?? run.deliverableId} — ${run.status}`,
						`Run ${run.id}, attempt ${run.attempt}.${run.iteration}, invoked by ${run.invokedBy}`,
						`Started ${run.startedAt ?? 'not yet'}, finished ${run.finishedAt ?? 'not yet'}`,
						`Model ${run.model ?? 'unknown'}, cost €${run.costEur.toFixed(4)} (${run.tokensIn} in / ${run.tokensOut} out)`,
						run.help ? `Help: ${run.help}` : null,
						verdict
							? `Judge: ${verdict.met === true ? 'met' : verdict.met === false ? 'not met' : 'unknown'}${verdict.critique ? ` — ${verdict.critique}` : ''}`
							: 'Judge: no verdict yet.',
						output
							? `Output:\n${output.slice(0, OUTPUT_MAX_CHARS)}${truncated ? '\n… (truncated)' : ''}`
							: 'Output: none yet.',
						recent.length
							? `Last ${recent.length} of ${allEvents.length} event(s):\n${recent.map(eventLine).join('\n')}`
							: 'No events yet.',
					].filter((s): s is string => Boolean(s));
					return text(sections.join('\n\n'));
				} catch (error) {
					return failure(error);
				}
			},
		};

		registerIfAllowed(overview);
		registerIfAllowed(deliverableDelete);
		registerIfAllowed(agentDelete);
		registerIfAllowed(breakerReset);
		registerIfAllowed(runStop);
		registerIfAllowed(runReport);
	}
}
