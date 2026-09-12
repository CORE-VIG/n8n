import type { AonCouncilClassView, AonCouncilOverview, AonGuardApproval, AonGuardPolicy } from '@n8n/api-types';
import { Logger } from '@n8n/backend-common';
import { Service } from '@n8n/di';

import { AonRunnerService } from '@/modules/aon-agents/executor/aon-runner.service';
import { costEur } from '@/modules/aon-agents/executor/run-machine';

import { AonGuardApprovalRepository } from '../../database/repositories/aon-guard-approval.repository';
import { AonGuardEventRepository } from '../../database/repositories/aon-guard-event.repository';
import { AonGuardPolicyRepository } from '../../database/repositories/aon-guard-policy.repository';
import { AonSettingsService } from '../../settings/aon-settings.service';
import { AonGuardCardsService } from '../aon-guard-cards.service';

import { isHumanOnly } from './council-lanes';
import {
	councilApproveGate,
	isLiveClass,
	scoreClass,
	type CouncilClassScore,
	type CouncilMemberAnswer,
	type CouncilRulingRow,
} from './council-score';

/** The two independent models a ruling is made of; the runner's model aliases, not provider names. */
const COUNCIL_MODELS = ['haiku', 'sonnet'] as const;
/** Standing rules and decided history are given to the model, never the whole table. */
const STANDING_RULE_HISTORY = 10;
/** How far back into the raw event stream a shadow score is willing to look before giving up. */
const RULING_LOOKBACK = 200;
const RULE_TIMEOUT_MS = 90_000;
const SYSTEM_PROMPT =
	'You are one independent member of a two-model council ruling on a Guard card under the owner’s ' +
	'standing rules. Approve only when one of the standing rule ids you were given resolves this exact ' +
	'case. Answer with one JSON object and nothing else: no prose, no code fence.';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function preview(text: string, max = 160): string {
	const t = text.trim();
	return t.length > max ? `${t.slice(0, max)}…` : t;
}

type StandingRuleView = { id: string; identity: string; opClass: string; verdict: string; note: string | null };

function standingRuleViews(policies: readonly AonGuardPolicy[]): StandingRuleView[] {
	return policies.map((p, i) => ({ id: `R${i + 1}`, identity: p.identity, opClass: p.opClass, verdict: p.verdict, note: p.note }));
}

function ruleLine(r: StandingRuleView): string {
	return `[${r.id}] identity=${r.identity} opClass=${r.opClass} verdict=${r.verdict}${r.note ? ` note="${r.note}"` : ''}`;
}

/** The rule text shown to the owner: the cited standing rule's note, or its shape when it carries none. */
function describeCitedRules(rules: readonly StandingRuleView[], citedIds: readonly string[]): string {
	const found = rules.filter((r) => citedIds.includes(r.id));
	if (found.length === 0) return citedIds.join(', ') || 'a standing rule';
	return found.map((r) => r.note ?? `${r.opClass} ${r.verdict}`).join('; ');
}

function buildPrompt(
	card: AonGuardApproval,
	rules: readonly StandingRuleView[],
	history: readonly AonGuardApproval[],
): string {
	const rulesText = rules.length ? rules.map(ruleLine).join('\n') : '(no standing rules for this identity)';
	const historyText = history.length
		? history
				.map(
					(h) =>
						`- asked by ${h.identity}: "${preview(h.summary)}" -> ${h.status}${h.decidedBy ? ` (decided by ${h.decidedBy})` : ''}`,
				)
				.join('\n')
		: '(no decided history for this op class yet)';
	return [
		'Card waiting for a decision:',
		`  identity: ${card.identity}`,
		`  opClass: ${card.opClass}`,
		`  tier: ${card.tier}`,
		`  summary: ${card.summary}`,
		`  body: ${card.body ? JSON.stringify(card.body).slice(0, 2000) : '(none)'}`,
		'',
		'Standing rules for this identity:',
		rulesText,
		'',
		`The last ${history.length} decided card(s) of this op class:`,
		historyText,
		'',
		'Approve only when one cited standing rule id above resolves this exact case. Reply with one JSON',
		'object and nothing else, no prose, no code fence:',
		'{"approve":true|false,"reason":"...","citedRule":"<one rule id from the list above>"|null}',
		'If no standing rule resolves this case, reply {"approve":false,"reason":"...","citedRule":null}.',
	].join('\n');
}

/** Unparseable, or not the expected shape, is never an approve. */
function parseMemberAnswer(model: string, text: string | null | undefined): CouncilMemberAnswer {
	const raw = String(text ?? '').trim();
	const start = raw.indexOf('{');
	const end = raw.lastIndexOf('}');
	const fail = (reason: string): CouncilMemberAnswer => ({ model, approve: false, reason, citedRule: null });
	if (start < 0 || end <= start) return fail('the answer carried no JSON object');
	let doc: unknown;
	try {
		doc = JSON.parse(raw.slice(start, end + 1));
	} catch {
		return fail('the answer was not valid JSON');
	}
	if (!isRecord(doc)) return fail('the answer was not a JSON object');
	const approve = doc.approve === true;
	const reason = typeof doc.reason === 'string' ? doc.reason.trim().slice(0, 500) : '';
	const citedRule = typeof doc.citedRule === 'string' && doc.citedRule.trim() ? doc.citedRule.trim() : null;
	return { model, approve, reason, citedRule };
}

/**
 * The council: Guard's automatic approver for tier-3 cards a standing rule
 * has marked `council`. It never touches a human-only op class (money,
 * access, sending, acting on a page, publishing, an agent's own charter, or
 * tier 4), and it never decides on its own until an op class has been
 * promoted to live by its shadow record — twenty decided shadow rulings
 * with zero false approvals, and the owner has not pinned it back to
 * shadow. Every ruling is recorded as an audit event whether or not it
 * decides anything; only a live approval acts and only a live approval
 * reaches Telegram.
 *
 * Deliberately does not depend on {@link AonGuardService}: that service
 * calls `consider()` after it raises a card, so the reverse dependency
 * would be circular. This service writes through the same repositories
 * `AonGuardService.decideApproval` uses, with the same effect.
 */
@Service()
export class AonCouncilService {
	constructor(
		private readonly policies: AonGuardPolicyRepository,
		private readonly approvals: AonGuardApprovalRepository,
		private readonly events: AonGuardEventRepository,
		private readonly cards: AonGuardCardsService,
		private readonly runner: AonRunnerService,
		private readonly settings: AonSettingsService,
		private readonly logger: Logger,
	) {}

	/** Called once, right after a card is raised. Never throws: a failed ruling just leaves the card pending, as if the council had never run. */
	async consider(card: AonGuardApproval): Promise<void> {
		try {
			await this.rule(card);
		} catch (e) {
			this.logger.warn(
				`[aon] council could not rule on card ${card.id}: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}

	private policyFor(rows: readonly AonGuardPolicy[], candidates: readonly string[], opClass: string): AonGuardPolicy | undefined {
		for (const key of candidates) {
			const match = rows.find((r) => r.identity === key && r.opClass === opClass);
			if (match) return match;
		}
		return undefined;
	}

	private async rule(card: AonGuardApproval): Promise<void> {
		if (isHumanOnly(card.opClass, card.tier)) return;

		const candidates = [card.identity, '*'];
		const standing = await this.policies.findFor(candidates);
		const match = this.policyFor(standing, candidates, card.opClass);
		if (!match || match.verdict !== 'council') return;

		const [history, shadowOnly] = await Promise.all([
			this.approvals.listDecidedByOpClass(card.opClass, STANDING_RULE_HISTORY),
			this.settings.councilShadowOnlyClasses(),
		]);
		const score = await this.scoreForClass(card.opClass);
		const live = isLiveClass(score, shadowOnly.includes(card.opClass));

		const rules = standingRuleViews(standing);
		const prompt = buildPrompt(card, rules, history);
		const members = await this.askMembers(prompt);
		const gate = councilApproveGate(members, rules.map((r) => r.id));

		await this.events.append({
			identity: card.identity,
			opClass: card.opClass,
			tier: card.tier,
			verdict: 'council',
			approvalId: card.id,
			meta: {
				verdict: gate.approve ? 'approve' : 'deny',
				reasons: members.map((m) => ({ model: m.model, approve: m.approve, reason: m.reason, citedRule: m.citedRule })),
				models: members.map((m) => m.model),
				shadow: !live,
			},
		});

		if (live && gate.approve) await this.decideAsLive(card, rules, gate.citedRules);
	}

	private async askMembers(prompt: string): Promise<CouncilMemberAnswer[]> {
		return await Promise.all(COUNCIL_MODELS.map(async (model) => await this.askOne(model, prompt)));
	}

	private async askOne(model: string, prompt: string): Promise<CouncilMemberAnswer> {
		const result = await this.runner.run({
			prompt,
			systemPrompt: SYSTEM_PROMPT,
			model,
			allowedTools: [],
			mcpConfigPath: null,
			maxTurns: 1,
			timeoutMs: RULE_TIMEOUT_MS,
			signal: new AbortController().signal,
			onEvent: () => {},
		});
		const spentEur = costEur(result.costUsd);
		if (spentEur > 0) await this.settings.addExtractSpend(spentEur);
		if (result.isError) {
			return { model, approve: false, reason: `model error: ${result.error ?? 'unknown'}`, citedRule: null };
		}
		return parseMemberAnswer(model, result.text);
	}

	/** Decides the card as the council, the same effect as `AonGuardService.decideApproval(id, 'approved', 'council')`. */
	private async decideAsLive(card: AonGuardApproval, rules: readonly StandingRuleView[], citedRuleIds: readonly string[]): Promise<void> {
		const decided = await this.approvals.decide(card.id, 'approved', 'council');
		if (!decided) return; // the owner (or a retried call) already decided it; nothing left to do
		const rule = describeCitedRules(rules, citedRuleIds);
		await this.events.append({
			identity: decided.identity,
			opClass: decided.opClass,
			tier: decided.tier,
			verdict: 'approved',
			approvalId: decided.id,
			meta: { by: 'council', rule },
		});
		void this.cards.notify({
			id: decided.id,
			identity: decided.identity,
			opClass: decided.opClass,
			tier: decided.tier,
			summary: `Council approved ${decided.summary} under rule ${rule}`,
			runId: decided.runId,
			kind: 'council',
		});
	}

	/** Freshly computed from events and approvals every time: never cached, never stored on the class. */
	private async scoreForClass(opClass: string): Promise<CouncilClassScore> {
		const raw = await this.events.listCouncilRulings(opClass, RULING_LOOKBACK);
		const shadowRulings = raw.filter((r) => isRecord(r.meta) && r.meta.shadow === true);
		const approvalIds = [...new Set(shadowRulings.map((r) => r.approvalId).filter((id): id is string => id !== null))];
		const approvals = approvalIds.length ? await this.approvals.findManyByIds(approvalIds) : [];
		const byId = new Map(approvals.map((a) => [a.id, a]));

		const rows: CouncilRulingRow[] = shadowRulings.map((r) => {
			const meta = isRecord(r.meta) ? r.meta : null;
			const verdict = meta?.verdict === 'approve' ? 'approve' : 'deny';
			const approval = r.approvalId ? byId.get(r.approvalId) : undefined;
			const ownerDecision =
				approval?.status === 'approved' || approval?.status === 'used'
					? 'approved'
					: approval?.status === 'denied'
						? 'denied'
						: null;
			return { verdict, ownerDecision };
		});
		return scoreClass(opClass, rows);
	}

	/** The Guard page's Council section: every op class the council has ever ruled on. */
	async overview(): Promise<AonCouncilOverview> {
		const [opClasses, shadowOnly] = await Promise.all([
			this.events.councilOpClasses(),
			this.settings.councilShadowOnlyClasses(),
		]);
		const classes = await Promise.all(opClasses.map(async (opClass) => await this.classView(opClass, shadowOnly)));
		return { classes };
	}

	async setShadowOnly(opClass: string, shadowOnly: boolean): Promise<AonCouncilClassView> {
		const shadowOnlyClasses = await this.settings.setCouncilShadowOnly(opClass, shadowOnly);
		return await this.classView(opClass, shadowOnlyClasses);
	}

	private async classView(opClass: string, shadowOnlyClasses: readonly string[]): Promise<AonCouncilClassView> {
		const [score, last] = await Promise.all([
			this.scoreForClass(opClass),
			this.events.listCouncilRulings(opClass, 1),
		]);
		const forced = shadowOnlyClasses.includes(opClass);
		return {
			opClass,
			live: isLiveClass(score, forced),
			shadowOnly: forced,
			rulings: score.rulings,
			decided: score.decided,
			agreement: score.agreement,
			falseApprovals: score.falseApprovals,
			blocker: score.blocker,
			lastRulingAt: last[0] ? last[0].ts.toISOString() : null,
		};
	}
}
