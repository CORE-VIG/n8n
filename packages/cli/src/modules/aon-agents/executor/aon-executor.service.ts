import type { AonCharterView, AonGuardApproval, AonLearnedRuleSummary } from '@n8n/api-types';
import { Logger } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import { Service } from '@n8n/di';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { AonGuardService } from '@/modules/aon-core/guard/aon-guard.service';
import { KNOWN_TOOL_NAMES, opClassOfTool } from '@/modules/aon-core/guard/op-classes';
import { McpServerApiKeyService } from '@/modules/mcp/mcp-api-key.service';
import { OwnershipService } from '@/services/ownership.service';

import { charterView } from '../charter-view';
import type { AonAgent } from '../database/entities/aon-agent.entity';
import type { AonDeliverable } from '../database/entities/aon-deliverable.entity';
import type { AonRun } from '../database/entities/aon-run.entity';
import { AonAgentRepository } from '../database/repositories/aon-agent.repository';
import { AonDeliverableRepository } from '../database/repositories/aon-deliverable.repository';
import { AonLearnedRuleRepository } from '../database/repositories/aon-learned-rule.repository';
import { AonRunEventRepository } from '../database/repositories/aon-run-event.repository';
import { AonRunRepository } from '../database/repositories/aon-run.repository';

import { judgePrompt, parseJudgeReply, type JudgeVerdict } from './aon-judge';
import { AonRunnerService, type AonRunnerEvent } from './aon-runner.service';
import {
	breakerAfter,
	breakerLimitOf,
	budgetDecision,
	claimable,
	costEur,
	HEARTBEAT_DEAD_MS,
	isRunStatus,
	judgeModelFor,
	makerModel,
	outcome,
	TERMINAL,
} from './run-machine';

const TICK_MS = 5_000;
const HEARTBEAT_MS = 30_000;
const MAKER_TIMEOUT_MS = 30 * 60_000;
const JUDGE_TIMEOUT_MS = 5 * 60_000;
const CLAIM_SCAN_LIMIT = 25;

interface InFlight {
	runId: string;
	controller: AbortController;
}

/** A JSON `input` blob's free-text field, or `(none)` when there is nothing to show. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
function runInputText(value: unknown): string {
	if (isRecord(value) && typeof value.text === 'string' && value.text.trim()) return value.text;
	return '(none)';
}

/**
 * The executor: claims a queued run, starts it, records it, and asks the
 * judge for the verdict. One run in flight at a time, in this process; a
 * tick that finds nothing to do is nearly free.
 */
@Service()
export class AonExecutorService {
	private ticking = false;
	private current: InFlight | null = null;

	constructor(
		private readonly runs: AonRunRepository,
		private readonly agents: AonAgentRepository,
		private readonly deliverables: AonDeliverableRepository,
		private readonly learnedRules: AonLearnedRuleRepository,
		private readonly events: AonRunEventRepository,
		private readonly runner: AonRunnerService,
		private readonly guard: AonGuardService,
		private readonly config: GlobalConfig,
		private readonly mcpApiKeys: McpServerApiKeyService,
		private readonly ownership: OwnershipService,
		private readonly logger: Logger,
	) {}

	start(): void {
		setInterval(() => void this.tick(), TICK_MS).unref();
		void this.tick();
	}

	/** Stops a run: aborts the child if this process runs it, then marks it stopped. */
	async stop(runId: string): Promise<void> {
		if (this.current?.runId === runId) this.current.controller.abort();
		const run = await this.runs.findOneBy({ id: runId });
		if (!run) return;
		if (isRunStatus(run.status) && TERMINAL.has(run.status)) return;
		await this.settle(run, { status: 'stopped', help: null });
	}

	async tick(): Promise<void> {
		if (this.ticking) return;
		this.ticking = true;
		try {
			await this.reconcileStuck();
			await this.reconcileWaitingApproval();
			if (!this.current) await this.claimAndExecute();
		} catch (e) {
			this.logger.error(`[aon] executor tick failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.ticking = false;
		}
	}

	// --- reconcile --------------------------------------------------------

	/** `working`/`validating` runs this process is not actually running: presumed dead. */
	private async reconcileStuck(): Promise<void> {
		const stuck = await this.runs.listStuck(HEARTBEAT_DEAD_MS);
		for (const run of stuck) {
			if (this.current?.runId === run.id) continue;
			await this.settle(run, { status: 'needs_help', help: 'lost its heartbeat' });
		}
	}

	private async reconcileWaitingApproval(): Promise<void> {
		const waiting = await this.runs.listByStatus('waiting_approval');
		for (const run of waiting) {
			if (this.current?.runId === run.id) continue;
			await this.reconcileOneApproval(run);
		}
	}

	private async reconcileOneApproval(run: AonRun): Promise<void> {
		if (!run.approvalId) {
			await this.settle(run, { status: 'needs_help', help: 'was waiting on a decision that was never asked for' });
			return;
		}
		const approval = await this.guard.findApproval(run.approvalId);
		if (!approval || approval.status === 'expired') {
			await this.settle(run, { status: 'needs_help', help: 'the approval card expired before it was decided' });
			return;
		}
		if (approval.status === 'denied') {
			await this.settle(run, { status: 'stopped', help: 'denied by the owner' });
			return;
		}
		if (approval.status === 'pending') return; // still waiting on him
		if (approval.opClass === 'run.deliver') {
			await this.settle(run, { status: 'done', output: run.output ?? '', verification: run.verification });
			return;
		}
		await this.resumeApproved(run, approval);
	}

	// --- claim + run --------------------------------------------------------

	private async claimAndExecute(): Promise<void> {
		const candidates = await this.runs.listQueuedOldestFirst(CLAIM_SCAN_LIMIT);
		for (const candidate of candidates) {
			const agent = await this.agents.findOneBy({ id: candidate.agentId });
			const deliverable = await this.deliverables.findOneBy({ id: candidate.deliverableId });
			const check = claimable({
				agent: agent ? { status: agent.status, breakerTrippedAt: agent.breakerTrippedAt } : null,
				deliverable: deliverable ? { enabled: deliverable.enabled } : null,
			});
			if (!check.ok || !agent || !deliverable) continue;

			const charter = charterView(agent.charter, agent.persona);
			if (charter.guard.budgetEurMonth !== null) {
				const spentEur = await this.runs.sumCostEurThisMonth(agent.id);
				const decision = budgetDecision({ spentEur, budgetEurMonth: charter.guard.budgetEurMonth });
				if (!decision.ok) {
					const claimed = await this.runs.claimForExecution(candidate.id);
					if (!claimed) continue;
					await this.settle(claimed, { status: 'needs_help', help: decision.reason ?? 'monthly budget reached' });
					return;
				}
			}

			const claimed = await this.runs.claimForExecution(candidate.id);
			if (!claimed) continue; // raced with something else; try the next candidate
			const allowedTools = await this.guard.allowedTools(
				{ kind: 'agent', name: agent.slug, runId: claimed.id, tierCeiling: charter.guard.tierCeiling ?? deliverable.tier },
				KNOWN_TOOL_NAMES,
			);
			await this.execute(claimed, agent, deliverable, charter, { prompt: 'Begin the run.', allowedTools });
			return;
		}
	}

	private async resumeApproved(run: AonRun, approval: AonGuardApproval): Promise<void> {
		const agent = await this.agents.findOneBy({ id: run.agentId });
		const deliverable = await this.deliverables.findOneBy({ id: run.deliverableId });
		if (!agent || !deliverable) {
			await this.settle(run, { status: 'needs_help', help: 'its agent or deliverable no longer exists' });
			return;
		}
		const sessionId = await this.findLastSessionId(run.id);
		if (!sessionId) {
			await this.settle(run, { status: 'needs_help', help: 'was approved but its session was lost' });
			return;
		}
		const charter = charterView(agent.charter, agent.persona);
		const previous = await this.guard.allowedTools(
			{ kind: 'agent', name: agent.slug, runId: run.id, tierCeiling: charter.guard.tierCeiling ?? deliverable.tier },
			KNOWN_TOOL_NAMES,
		);
		const extra = KNOWN_TOOL_NAMES.filter((name) => opClassOfTool(name).opClass === approval.opClass);
		const allowedTools = Array.from(new Set([...previous, ...extra]));
		const prompt = `The owner approved: ${approval.summary}. Continue and finish the deliverable; write it as your final message.`;
		await this.execute(run, agent, deliverable, charter, { prompt, allowedTools, resumeSessionId: sessionId });
	}

	/**
	 * The maker's turn, then (unless it asked Guard) the judge's. Covers both
	 * a fresh claim and a resume after an approval: the only difference is
	 * the prompt, the allowed tools, and whether a session id is resumed.
	 */
	private async execute(
		run: AonRun,
		agent: AonAgent,
		deliverable: AonDeliverable,
		charter: AonCharterView,
		opts: { prompt: string; allowedTools: string[]; resumeSessionId?: string },
	): Promise<void> {
		const controller = new AbortController();
		this.current = { runId: run.id, controller };
		await this.runs.setWorking(run.id);
		await this.events.append(run.id, { type: 'status', status: 'working' });
		const heartbeat = setInterval(() => void this.runs.touchHeartbeat(run.id), HEARTBEAT_MS);
		try {
			const model = makerModel(charter.guard.modelBand);
			const rules = await this.learnedRules.listForAgent(agent.id);
			const systemPrompt = `${this.buildSystemPrompt(agent, charter, rules)}\n\n${this.buildRunBriefing(run, deliverable)}`;
			const mcpConfigPath = await this.writeRunMcpConfig(run.id, agent.slug);
			const allowedTools = Array.from(new Set([...opts.allowedTools, 'guard_request']));

			const maker = await this.runner.run({
				prompt: opts.prompt,
				systemPrompt,
				model,
				allowedTools,
				mcpConfigPath,
				resumeSessionId: opts.resumeSessionId,
				timeoutMs: MAKER_TIMEOUT_MS,
				signal: controller.signal,
				onEvent: (ev) => void this.logEvent(run.id, ev),
			});

			if (maker.sessionId) {
				await this.events.append(run.id, { type: 'note', name: 'claude_session', text: maker.sessionId });
			}
			await this.runs.addUsage(run.id, {
				model,
				tokensIn: maker.usage.inputTokens,
				tokensOut: maker.usage.outputTokens,
				costEur: costEur(maker.costUsd),
			});

			if (controller.signal.aborted) return; // stop() already settled this run

			if (maker.isError) {
				await this.settle(run, { status: 'failed', help: maker.error ?? 'the run failed' });
				return;
			}

			if (maker.toolNames.includes('guard_request')) {
				const card = await this.guard.findPendingForRun(run.id);
				if (card) {
					await this.settle(run, { status: 'waiting_approval', approvalId: card.id, output: maker.text });
				} else {
					await this.settle(run, { status: 'needs_help', help: 'asked Guard but no card was raised' });
				}
				return;
			}

			await this.runs.setValidating(run.id);
			await this.events.append(run.id, { type: 'status', status: 'validating' });

			const hasInput = runInputText(run.input) !== '(none)';
			const { systemPrompt: judgeSystemPrompt, prompt: judgePromptText } = judgePrompt({
				dod: deliverable.dod,
				output: maker.text,
				inputs: hasInput ? [{ id: 'input', label: 'Input', text: runInputText(run.input) }] : [],
			});
			const judgeModel = judgeModelFor(model);
			const judgeResult = await this.runner.run({
				prompt: judgePromptText,
				systemPrompt: judgeSystemPrompt,
				model: judgeModel,
				allowedTools: [],
				mcpConfigPath: null,
				maxTurns: 1,
				timeoutMs: JUDGE_TIMEOUT_MS,
				signal: controller.signal,
				onEvent: (ev) => void this.logEvent(run.id, ev),
			});
			await this.runs.addUsage(run.id, {
				model: null,
				tokensIn: judgeResult.usage.inputTokens,
				tokensOut: judgeResult.usage.outputTokens,
				costEur: costEur(judgeResult.costUsd),
			});

			if (controller.signal.aborted) return; // stop() already settled this run

			const verdict: JudgeVerdict = judgeResult.isError
				? { met: null, critique: `the judge could not run: ${judgeResult.error ?? 'no result'}`, evidence: '', status: 'unknown' }
				: parseJudgeReply(judgeResult.text);
			await this.events.append(run.id, { type: 'judge', status: verdict.status, text: verdict.critique || null });
			const verification = { judge: verdict };

			const decision = outcome({
				shape: deliverable.shape,
				iteration: run.iteration,
				maxIterations: deliverable.maxIterations,
				tier: deliverable.tier,
				approver: deliverable.approver,
				judge: verdict,
			});

			if (decision.action === 'write_page') {
				await this.settle(run, { status: 'done', output: maker.text, verification });
				return;
			}
			if (decision.action === 'iterate') {
				await this.settle(run, { status: 'done', output: maker.text, verification });
				await this.runs.createQueued({
					id: randomUUID(),
					deliverableId: deliverable.id,
					agentId: agent.id,
					parentRunId: run.id,
					iteration: decision.nextIteration ?? run.iteration + 1,
					attempt: 1,
					trigger: run.trigger,
					input: run.input,
				});
				return;
			}
			if (decision.action === 'deliver') {
				const approval = await this.guard.requestApproval(
					{ kind: 'agent', name: agent.slug, runId: run.id },
					'run.deliver',
					`Deliver "${deliverable.name}" from run ${run.id}: ${maker.text.slice(0, 200)}`,
					{ runId: run.id },
				);
				await this.settle(run, {
					status: 'waiting_approval',
					approvalId: approval.id,
					output: maker.text,
					verification,
				});
				return;
			}
			await this.settle(run, { status: 'needs_help', help: decision.reason, verification });
		} finally {
			clearInterval(heartbeat);
			if (this.current?.runId === run.id) this.current = null;
		}
	}

	// --- persistence --------------------------------------------------------

	/**
	 * Every place a run's status settles funnels through here: it writes the
	 * row, a status event, and (for done/failed/needs_help) applies the
	 * breaker rule from run-machine.ts. `stopped` and `waiting_approval` say
	 * nothing about the agent's reliability, so they leave the breaker alone.
	 */
	private async settle(
		run: AonRun,
		result:
			| { status: 'done'; output: string; verification: Record<string, unknown> | null }
			| { status: 'failed'; help: string }
			| { status: 'needs_help'; help: string; verification?: Record<string, unknown> | null }
			| { status: 'stopped'; help: string | null }
			| { status: 'waiting_approval'; approvalId: string; output: string; verification?: Record<string, unknown> | null },
	): Promise<void> {
		if (this.current?.runId === run.id) this.current = null;

		if (result.status === 'done') {
			await this.runs.setDone(run.id, { output: result.output, verification: result.verification });
			await this.deliverables.update({ id: run.deliverableId }, { lastRunAt: new Date(), updatedAt: new Date() });
			await this.events.append(run.id, { type: 'status', status: 'done' });
		} else if (result.status === 'failed') {
			await this.runs.setFailed(run.id, result.help);
			await this.events.append(run.id, { type: 'error', status: 'failed', text: result.help });
		} else if (result.status === 'needs_help') {
			await this.runs.setNeedsHelp(run.id, result.help, result.verification ?? null);
			await this.events.append(run.id, { type: 'status', status: 'needs_help', text: result.help });
		} else if (result.status === 'stopped') {
			await this.runs.setStopped(run.id, result.help);
			await this.events.append(run.id, { type: 'status', status: 'stopped', text: result.help });
		} else {
			await this.runs.setWaitingApproval(run.id, {
				approvalId: result.approvalId,
				output: result.output,
				verification: result.verification,
			});
			await this.events.append(run.id, { type: 'status', status: 'waiting_approval' });
		}

		if (result.status === 'done' || result.status === 'failed' || result.status === 'needs_help') {
			const agent = await this.agents.findOneBy({ id: run.agentId });
			if (!agent) return;
			const guardCfg = charterView(agent.charter, agent.persona).guard;
			const limit = breakerLimitOf(guardCfg);
			const breaker = breakerAfter({ failures: agent.breakerFailures, outcome: result.status, limit }, new Date());
			if (breaker.unchanged) return;
			await this.agents.applyBreakerOutcome(agent.id, { failures: breaker.failures, trippedAt: breaker.trippedAt });
			if (breaker.tripped) {
				await this.events.append(run.id, {
					type: 'error',
					text: `the breaker tripped after ${breaker.failures} failures in a row`,
				});
			}
		}
	}

	private async logEvent(runId: string, ev: AonRunnerEvent): Promise<void> {
		try {
			await this.events.append(runId, {
				type: ev.type,
				name: ev.name ?? null,
				status: ev.status ?? null,
				text: ev.text ?? null,
			});
		} catch (e) {
			this.logger.warn(`[aon] could not log a run event: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private async findLastSessionId(runId: string): Promise<string | null> {
		const log = await this.events.listForRun(runId);
		for (let i = log.length - 1; i >= 0; i--) {
			const ev = log[i];
			if (ev.type === 'note' && ev.name === 'claude_session' && ev.text) return ev.text;
		}
		return null;
	}

	private buildSystemPrompt(
		agent: AonAgent,
		charter: AonCharterView,
		learnedRules: readonly AonLearnedRuleSummary[],
	): string {
		const sections: string[] = [
			`You are ${agent.name}, an Aon agent.${agent.persona ? ` ${agent.persona}` : ''}`,
		];

		const orientation: string[] = [];
		if (charter.orientation.purpose) orientation.push(`Purpose: ${charter.orientation.purpose}`);
		if (charter.orientation.owns.length) orientation.push(`Owns: ${charter.orientation.owns.join(', ')}`);
		if (charter.orientation.sources.length) orientation.push(`Sources: ${charter.orientation.sources.join(', ')}`);
		if (orientation.length) sections.push(['ORIENTATION', ...orientation].join('\n'));

		const inForce = learnedRules.filter((r) => r.state !== 'revoked').map((r) => r.text);
		const rules: string[] = [];
		if (charter.rules.do.length) rules.push(`Do:\n- ${charter.rules.do.join('\n- ')}`);
		if (charter.rules.dont.length) rules.push(`Never:\n- ${charter.rules.dont.join('\n- ')}`);
		if (inForce.length) rules.push(`Learned:\n- ${inForce.join('\n- ')}`);
		if (rules.length) sections.push(['RULES', ...rules].join('\n'));

		if (charter.skills.length) sections.push(`SKILLS\n${charter.skills.join(', ')}`);
		if (charter.tools.length) sections.push(`TOOLS\n${charter.tools.join(', ')}`);

		return sections.join('\n\n');
	}

	private buildRunBriefing(run: AonRun, deliverable: AonDeliverable): string {
		return [
			`YOUR RUN: run ${run.id}, iteration ${run.iteration} of ${deliverable.maxIterations}, for the deliverable ${deliverable.name}.`,
			`DEFINITION OF DONE: ${deliverable.dod}`,
			`INPUT: ${runInputText(run.input)}`,
			'Work with the tools you have. Finish by writing the deliverable itself as your final message: that text is what will be judged and delivered.',
			'If a tool you need is not allowed, call guard_request with the op class and one line saying why, then stop and wait; do not work around Guard.',
			'Never claim a thing happened unless a tool did it.',
		].join('\n');
	}

	/** The MCP config a run's own claude child reads: the owner's key, tagged with who is calling. */
	private async writeRunMcpConfig(runId: string, agentSlug: string): Promise<string> {
		const owner = await this.ownership.getInstanceOwner();
		const key =
			(await this.mcpApiKeys.findServerApiKeyForUser(owner, { redact: false })) ??
			(await this.mcpApiKeys.createMcpServerApiKey(owner));
		await mkdir(this.config.aon.claudeHome, { recursive: true });
		const file = path.join(this.config.aon.claudeHome, `aon-mcp-run-${runId}.json`);
		const body = {
			mcpServers: {
				n8n: {
					type: 'http',
					url: this.config.aon.mcpUrl,
					headers: {
						Authorization: `Bearer ${key.apiKey}`,
						'x-aon-identity': `agent:${agentSlug}`,
						'x-aon-run': runId,
					},
				},
			},
		};
		await writeFile(file, JSON.stringify(body), { mode: 0o600 });
		await chmod(file, 0o600);
		return file;
	}
}
