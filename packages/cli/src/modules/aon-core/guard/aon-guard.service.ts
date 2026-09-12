import type { AonGuardApproval, AonGuardIdentity, AonGuardOverview, AonGuardVerdict } from '@n8n/api-types';
import { Service } from '@n8n/di';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';

import { AonGuardApprovalRepository } from '../database/repositories/aon-guard-approval.repository';
import { AonGuardEventRepository } from '../database/repositories/aon-guard-event.repository';
import { AonGuardPolicyRepository } from '../database/repositories/aon-guard-policy.repository';

import { AonGuardCardsService } from './aon-guard-cards.service';
import { AON_OP_CLASSES, DEFAULT_AGENT_TIER_CEILING, opClassOfTool, tierOf } from './op-classes';

/** A card stays open this long before it expires unclaimed. */
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
const RECENT_EVENTS_LIMIT = 50;

/**
 * Guard: every effect is classed, the class has a tier, the tier has a policy,
 * and what the policy does not allow goes to the owner as a card.
 */
export interface GuardDecision {
	verdict: AonGuardVerdict;
	opClass: string;
	tier: number;
	/** Where the verdict came from: a policy row's id, or "default". */
	source: string;
}

/** The policy identity string for this actor: "agent:<slug>" or "owner". */
function identityKey(identity: AonGuardIdentity): string {
	return identity.kind === 'agent' ? `agent:${identity.name}` : 'owner';
}

/** Policy rows are checked in this order: the actor's own identity, then everyone's. */
function candidateIdentities(identity: AonGuardIdentity): string[] {
	return [identityKey(identity), '*'];
}

@Service()
export class AonGuardService {
	constructor(
		private readonly policyRepository: AonGuardPolicyRepository,
		private readonly approvalRepository: AonGuardApprovalRepository,
		private readonly eventRepository: AonGuardEventRepository,
		private readonly cards: AonGuardCardsService,
	) {}

	/**
	 * The verdict for one op class, for this identity: an approved card
	 * already covers it, else a policy row, else the tier default.
	 *
	 * `consumeApproval` (default true) marks a matching card used once it is
	 * relied on. `allowedTools` passes false: it sweeps every known tool name
	 * to build a harness allow-list, and must not spend the one real card a
	 * retried call still needs on that sweep.
	 */
	async decide(
		identity: AonGuardIdentity,
		opClass: string,
		options?: { consumeApproval?: boolean },
	): Promise<GuardDecision> {
		const tier = tierOf(opClass);
		const approved = await this.approvalRepository.findApprovedUnused(
			identityKey(identity),
			opClass,
			identity.runId ?? null,
		);
		if (approved) {
			if (options?.consumeApproval ?? true) await this.approvalRepository.markUsed(approved.id);
			return { verdict: 'allow', opClass, tier, source: `approved card ${approved.id}` };
		}
		const candidates = candidateIdentities(identity);
		const rows = await this.policyRepository.findFor(candidates);
		for (const key of candidates) {
			const match = rows.find((row) => row.identity === key && row.opClass === opClass);
			if (match) return { verdict: match.verdict, opClass, tier, source: match.id };
		}
		return { verdict: this.defaultVerdict(identity, tier), opClass, tier, source: 'default' };
	}

	/** The verdict for a concrete tool call (the network flag on hands_run counts). */
	async decideTool(
		identity: AonGuardIdentity,
		toolName: string,
		args?: Record<string, unknown>,
		options?: { consumeApproval?: boolean },
	): Promise<GuardDecision> {
		const { opClass } = opClassOfTool(toolName, args);
		return await this.decide(identity, opClass, options);
	}

	/** Of these tool names, the ones this identity may call without asking. Never spends an approved card. */
	async allowedTools(identity: AonGuardIdentity, toolNames: readonly string[]): Promise<string[]> {
		const allowed: string[] = [];
		for (const name of toolNames) {
			const decision = await this.decideTool(identity, name, undefined, { consumeApproval: false });
			if (decision.verdict === 'allow') allowed.push(name);
		}
		return allowed;
	}

	/** Raise a card for the owner. */
	async requestApproval(
		identity: AonGuardIdentity,
		opClass: string,
		summary: string,
		body?: Record<string, unknown>,
	): Promise<AonGuardApproval> {
		const tier = tierOf(opClass);
		const approval = await this.approvalRepository.insertNew({
			identity: identityKey(identity),
			opClass,
			tier,
			summary,
			body: body ?? null,
			runId: identity.runId ?? null,
			expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
		});
		await this.appendEvent({
			identity: approval.identity,
			runId: approval.runId,
			opClass,
			tier,
			verdict: 'asked',
			approvalId: approval.id,
		});
		// Fire and forget: a failed notification must not stop the card from
		// existing, and the owner can always find it on the Guard page.
		void this.cards.notify({
			id: approval.id,
			identity: approval.identity,
			opClass: approval.opClass,
			tier: approval.tier,
			summary: approval.summary,
			runId: approval.runId,
		});
		return approval;
	}

	async findApproval(id: string): Promise<AonGuardApproval | null> {
		return await this.approvalRepository.findById(id);
	}

	/** The newest pending card a run is waiting on, if any. */
	async findPendingForRun(runId: string): Promise<AonGuardApproval | null> {
		return await this.approvalRepository.findPendingForRun(runId);
	}

	/** The owner's yes or no on a card. Refuses once it is no longer pending. */
	async decideApproval(
		id: string,
		decision: 'approved' | 'denied',
		decidedBy: string,
	): Promise<AonGuardApproval> {
		const decided = await this.approvalRepository.decide(id, decision, decidedBy);
		if (!decided) throw new BadRequestError('That card is not waiting for a decision any more.');
		await this.appendEvent({
			identity: decided.identity,
			runId: decided.runId,
			opClass: decided.opClass,
			tier: decided.tier,
			verdict: decision,
			approvalId: decided.id,
		});
		return decided;
	}

	/** Audit trail. */
	async record(
		identity: AonGuardIdentity,
		opClass: string,
		verdict: string,
		meta?: Record<string, unknown>,
		approvalId?: string | null,
	): Promise<void> {
		await this.appendEvent({
			identity: identityKey(identity),
			runId: identity.runId ?? null,
			opClass,
			tier: tierOf(opClass),
			verdict,
			approvalId: approvalId ?? null,
			meta,
		});
	}

	/** The Guard page's one call: cards waiting, every policy, the op class catalogue, and recent history. */
	async overview(): Promise<AonGuardOverview> {
		await this.approvalRepository.expireOlderThan(new Date());
		const [pending, policies, recent] = await Promise.all([
			this.approvalRepository.listPending(),
			this.policyRepository.listAll(),
			this.eventRepository.listRecent(RECENT_EVENTS_LIMIT),
		]);
		return { pending, policies, opClasses: [...AON_OP_CLASSES], recent };
	}

	/** Without a policy row: an agent acts alone up to its ceiling, asks for tier 3, never tier 4; the owner is asked only for tier 4. */
	defaultVerdict(identity: AonGuardIdentity, tier: number): AonGuardVerdict {
		if (identity.kind === 'owner') return tier >= 4 ? 'deny' : 'allow';
		const ceiling = identity.tierCeiling ?? DEFAULT_AGENT_TIER_CEILING;
		if (tier >= 4) return 'deny';
		if (tier <= ceiling) return 'allow';
		return 'ask';
	}

	/**
	 * Every event carries the run it belongs to (when there is one) in its
	 * `meta`, so the Guard page can link a decision back to its run without a
	 * second lookup.
	 */
	private async appendEvent(input: {
		identity: string;
		runId: string | null;
		opClass: string;
		tier: number;
		verdict: string;
		approvalId: string | null;
		meta?: Record<string, unknown>;
	}): Promise<void> {
		const meta = input.runId ? { ...input.meta, runId: input.runId } : (input.meta ?? null);
		await this.eventRepository.append({
			identity: input.identity,
			opClass: input.opClass,
			tier: input.tier,
			verdict: input.verdict,
			approvalId: input.approvalId,
			meta,
		});
	}
}
