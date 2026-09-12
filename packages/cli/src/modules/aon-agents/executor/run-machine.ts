import type { AonRunStatus } from '@n8n/api-types';
import { AON_RUN_STATUSES } from '@n8n/api-types';
import { CronTime } from 'cron';

/**
 * run-machine.ts: every decision the executor makes, with no I/O.
 *
 * A faithful port of aon-os's run-machine.mjs. The runner reads rows and
 * calls these; a rule that lives here is a rule kept in exactly one place.
 */

export const STATUSES: readonly AonRunStatus[] = AON_RUN_STATUSES;

// The contract's transitions, exactly. Anything may go to stopped: that is him.
const TRANSITIONS: Record<AonRunStatus, readonly AonRunStatus[]> = {
	queued: ['working', 'stopped'],
	working: ['validating', 'needs_help', 'failed', 'stopped'],
	validating: ['done', 'waiting_approval', 'needs_help', 'failed', 'stopped'],
	waiting_approval: ['done', 'stopped', 'needs_help'],
	needs_help: ['queued', 'stopped'],
	done: [],
	failed: ['stopped'], // the contract: only needs_help is retried
	stopped: [],
};

export function canTransition(from: AonRunStatus, to: AonRunStatus): boolean {
	return TRANSITIONS[from].includes(to);
}

export const TERMINAL: ReadonlySet<AonRunStatus> = new Set(['done', 'failed', 'stopped']);
export const IN_FLIGHT: ReadonlySet<AonRunStatus> = new Set([
	'queued',
	'working',
	'validating',
	'waiting_approval',
]);

const KNOWN_STATUSES: ReadonlySet<string> = new Set<AonRunStatus>(AON_RUN_STATUSES);

/** Narrows a plain DB `status` column to the union, for use with TERMINAL/IN_FLIGHT. */
export function isRunStatus(value: string): value is AonRunStatus {
	return KNOWN_STATUSES.has(value);
}

// Routing bands. The judge always runs on a different model than the maker:
// haiku judges sonnet and opus, sonnet judges haiku.
export const MODEL_BANDS = { fast: 'haiku', standard: 'sonnet', deep: 'opus' } as const;
export type ModelBand = keyof typeof MODEL_BANDS;

function isModelBand(value: string | null | undefined): value is ModelBand {
	return value === 'fast' || value === 'standard' || value === 'deep';
}

export function makerModel(band: string | null | undefined): string {
	return isModelBand(band) ? MODEL_BANDS[band] : MODEL_BANDS.standard;
}

export function judgeModelFor(maker: string | null | undefined): string {
	const m = String(maker ?? '').toLowerCase();
	return m.includes('haiku') ? 'sonnet' : 'haiku';
}

// claude reports total_cost_usd at list price; the ledger is in euros.
export const USD_TO_EUR = 0.92;
export function costEur(costUsd: number): number {
	return Number.isFinite(costUsd) && costUsd > 0 ? Math.round(costUsd * USD_TO_EUR * 1e6) / 1e6 : 0;
}

// Enough consecutive failed or needs_help runs trip the agent. The status
// stays active; its runs are simply not claimed until he resets the breaker.
export const BREAKER_LIMIT = 3;
const BREAKER_LIMIT_CHOICES: readonly number[] = [2, 3, 5, 10];

/** The four the Agent Builder offers. Anything else reads as the default. */
export function breakerLimitOf(guard: { breakerLimit: number | null }): number {
	const n = guard.breakerLimit;
	return n !== null && BREAKER_LIMIT_CHOICES.includes(n) ? n : BREAKER_LIMIT;
}

export interface BreakerResult {
	failures: number;
	trippedAt: Date | null;
	tripped: boolean;
	unchanged?: boolean;
}

export function breakerAfter(
	input: { failures: number; outcome: string; limit: number },
	now: Date = new Date(),
): BreakerResult {
	const cap = Number.isFinite(input.limit) && input.limit > 0 ? input.limit : BREAKER_LIMIT;
	if (input.outcome === 'failed' || input.outcome === 'needs_help') {
		const next = input.failures + 1;
		return { failures: next, trippedAt: next >= cap ? now : null, tripped: next >= cap };
	}
	if (input.outcome === 'done') return { failures: 0, trippedAt: null, tripped: false };
	// waiting_approval, stopped and a goal iteration the judge rejected say
	// nothing about the agent's reliability; an iteration must not clear the
	// streak, or a goal that fails every round never trips the breaker.
	return { failures: input.failures, trippedAt: null, tripped: false, unchanged: true };
}

export interface BudgetDecision {
	ok: boolean;
	reason?: string;
	remainingEur?: number;
}

// Month-to-date spend at or over the charter's budget: the run is not executed.
export function budgetDecision(input: { spentEur: number; budgetEurMonth: number }): BudgetDecision {
	const budget = input.budgetEurMonth;
	const spent = Number.isFinite(input.spentEur) ? input.spentEur : 0;
	if (!Number.isFinite(budget) || budget <= 0) {
		return { ok: false, reason: 'the charter has no monthly budget, so nothing may be spent' };
	}
	if (spent >= budget) {
		return {
			ok: false,
			reason: `month-to-date spend ${spent.toFixed(2)} EUR is at the charter budget of ${budget.toFixed(2)} EUR (estimated at list price)`,
		};
	}
	return { ok: true, remainingEur: Math.round((budget - spent) * 100) / 100 };
}

export interface ClaimableResult {
	ok: boolean;
	reason?: string;
}

// Whether a queued run may be claimed at all. Mirrors the executor's claim
// so the rule is stated once and can be checked without a DB.
export function claimable(input: {
	agent: { status: string; breakerTrippedAt: Date | string | null } | null;
	deliverable?: { enabled: boolean } | null;
}): ClaimableResult {
	const { agent, deliverable } = input;
	if (!agent) return { ok: false, reason: 'agent missing' };
	if (agent.status !== 'active') return { ok: false, reason: `agent is ${agent.status}` };
	if (agent.breakerTrippedAt) return { ok: false, reason: 'breaker tripped' };
	if (deliverable && deliverable.enabled === false) return { ok: false, reason: 'deliverable disabled' };
	return { ok: true };
}

export type OutcomeAction = 'none' | 'write_page' | 'iterate' | 'deliver';

export interface OutcomeResult {
	status: AonRunStatus;
	action: OutcomeAction;
	reason: string;
	nextIteration?: number;
}

export interface JudgeVerdictForOutcome {
	status: 'pass' | 'fail' | 'unknown';
	critique?: string | null;
}

/**
 * Where a run goes after validating.
 *
 * The judge saying the DoD is not met is not a failure (the run itself
 * worked fine) but is not done either: a goal iterates until its last
 * iteration, everything else needs him. A judge that could not answer
 * (unknown) neither passes nor fails; the report shows unknown and the
 * delivery rule decides. Then: auto approver at tier <= 2 is done here;
 * anything else is delivered through the approval machinery and waits for
 * his yes.
 */
export function outcome(input: {
	shape: string;
	iteration: number;
	maxIterations: number;
	tier: number;
	approver: string;
	judge: JudgeVerdictForOutcome | null | undefined;
}): OutcomeResult {
	const { shape, iteration, maxIterations, tier, approver, judge } = input;
	const judgeStatus = judge?.status ?? 'unknown';
	if (judgeStatus === 'fail') {
		const critique = judge?.critique ? `: ${judge.critique}` : '';
		if (shape === 'goal' && iteration < maxIterations) {
			return {
				status: 'done',
				action: 'iterate',
				nextIteration: iteration + 1,
				reason: `iteration ${iteration} of ${maxIterations}: the judge says not yet${critique}`,
			};
		}
		return {
			status: 'needs_help',
			action: 'none',
			reason:
				shape === 'goal'
					? `iteration ${iteration} of ${maxIterations} and the judge still says the definition of done is not met${critique}`
					: `the judge says the definition of done is not met${critique}`,
		};
	}
	if (judgeStatus === 'unknown') {
		// The second model never actually checked the definition of done. That
		// is not a pass; at auto tier it used to write the page anyway.
		if (shape === 'goal' && iteration < maxIterations) {
			return {
				status: 'done',
				action: 'iterate',
				nextIteration: iteration + 1,
				reason: `iteration ${iteration} of ${maxIterations}: the judge could not answer`,
			};
		}
		return {
			status: 'needs_help',
			action: 'none',
			reason: 'the judge could not answer; retry, or approve it yourself',
		};
	}
	if (approver === 'auto' && tier <= 2) {
		return { status: 'done', action: 'write_page', reason: 'the judge says done' };
	}
	return {
		status: 'waiting_approval',
		action: 'deliver',
		reason: `delivery needs ${approver === 'auto' ? `an approval at tier ${tier}` : 'his yes'}`,
	};
}

// Routines: a recurring deliverable's cadence is a cron expression. The next
// due time is always computed fresh from `lastRunAt ?? createdAt`, so a
// deliverable that was never scheduled while paused simply becomes due once,
// not once per missed tick.
export function nextRunAtFor(cadence: string | null, after: Date): Date | null {
	if (!cadence || !cadence.trim()) return null;
	try {
		return new CronTime(cadence.trim()).getNextDateFrom(after).toJSDate();
	} catch {
		return null;
	}
}

// runs-reconcile: a worker that stopped reporting is presumed dead.
export const HEARTBEAT_DEAD_MS = 20 * 60_000;

export function heartbeatDead(
	input: { heartbeatAt: Date | string | null; startedAt: Date | string | null },
	now: Date = new Date(),
	limitMs: number = HEARTBEAT_DEAD_MS,
): boolean {
	const last = input.heartbeatAt ?? input.startedAt;
	if (!last) return true;
	const t = new Date(last).getTime();
	if (Number.isNaN(t)) return true;
	return now.getTime() - t > limitMs;
}
