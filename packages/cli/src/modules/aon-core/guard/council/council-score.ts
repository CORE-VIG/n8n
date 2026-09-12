/**
 * The council's arithmetic, in code, never a model's opinion of itself.
 * Every function here is pure over rows already loaded: no database, no
 * settings, no model call.
 *
 *   councilApproveGate  the only way a ruling may be an approve: every
 *                       member answers, every member approves, and every
 *                       member cites a standing rule id that was actually
 *                       given to it. Silence, a dissent, or an uncited or
 *                       unmatched rule all fall through to "leave it
 *                       pending" — never to approve.
 *   scoreClass          the shadow scoreboard for one op class: over its
 *                       most recent shadow rulings, how many are decided,
 *                       how many the owner's eventual decision agreed with,
 *                       and the false approvals that must stay at zero.
 *   isLiveClass         whether an op class may act on its own ruling: the
 *                       scoreboard says so, and the owner has not pinned it
 *                       to shadow.
 */

/** The council is at least this many independent models, or it never approves. */
export const MIN_MEMBERS = 2;

/** How many of the most recent shadow rulings the promotion decision is judged on. */
export const PROMOTION_WINDOW = 20;

export type CouncilMemberAnswer = {
	model: string;
	approve: boolean;
	reason: string;
	citedRule: string | null;
};

export type CouncilGateResult = {
	approve: boolean;
	/** The standing rule ids that actually resolved the case, one member each, deduplicated. */
	citedRules: string[];
};

/**
 * Whether the council may approve: at least {@link MIN_MEMBERS} members
 * answered, every one of them approved, and every one of them cited a
 * standing rule id from the set it was actually given. A member that cites
 * nothing, or cites something not in that set, blocks the whole gate — the
 * model's own claim that a rule applies is never enough on its own.
 */
export function councilApproveGate(
	members: readonly CouncilMemberAnswer[],
	standingRuleIds: readonly string[],
): CouncilGateResult {
	const no: CouncilGateResult = { approve: false, citedRules: [] };
	if (members.length < MIN_MEMBERS) return no;
	const matched = new Set(standingRuleIds);
	const resolves = (m: CouncilMemberAnswer): m is CouncilMemberAnswer & { citedRule: string } =>
		typeof m.citedRule === 'string' && matched.has(m.citedRule);
	if (!members.every((m) => m.approve && resolves(m))) return no;
	const citedRules = [...new Set(members.filter(resolves).map((m) => m.citedRule))];
	return { approve: true, citedRules };
}

/** One shadow ruling, and, once the owner has since decided that same card, what the owner decided. */
export type CouncilRulingRow = {
	verdict: 'approve' | 'deny';
	/** null while the card is still pending, or lapsed with no decision. */
	ownerDecision: 'approved' | 'denied' | null;
};

export type CouncilClassScore = {
	opClass: string;
	/** shadow rulings in the scored window, decided or not */
	rulings: number;
	/** rulings in the window whose card the owner has since decided */
	decided: number;
	/** decided rulings where the council's verdict matches the owner's decision */
	agreement: number;
	/** the council approved, the owner denied: the one disagreement that must stay at zero */
	falseApprovals: number;
	eligibleForLive: boolean;
	/** why not, in words, when it is not eligible */
	blocker: string | null;
};

function isFalseApproval(row: CouncilRulingRow): boolean {
	return row.verdict === 'approve' && row.ownerDecision === 'denied';
}

function agrees(row: CouncilRulingRow): boolean {
	if (row.ownerDecision === null) return false;
	return (
		(row.verdict === 'approve' && row.ownerDecision === 'approved') ||
		(row.verdict === 'deny' && row.ownerDecision === 'denied')
	);
}

/**
 * Scores the most recent {@link PROMOTION_WINDOW} shadow rulings for one op
 * class. `rowsNewestFirst` may carry more than the window; only the first
 * {@link PROMOTION_WINDOW} are scored, so a class with a long history is
 * judged on its latest behaviour, not its oldest.
 */
export function scoreClass(
	opClass: string,
	rowsNewestFirst: readonly CouncilRulingRow[],
): CouncilClassScore {
	const window = rowsNewestFirst.slice(0, PROMOTION_WINDOW);
	const decided = window.filter((r) => r.ownerDecision !== null);
	const falseApprovals = decided.filter(isFalseApproval).length;
	const agreement = decided.filter(agrees).length;
	const blocker =
		falseApprovals > 0
			? `${falseApprovals} false ${falseApprovals === 1 ? 'approval' : 'approvals'}`
			: decided.length < PROMOTION_WINDOW
				? `${decided.length} of ${PROMOTION_WINDOW} decided rulings`
				: null;
	return {
		opClass,
		rulings: window.length,
		decided: decided.length,
		agreement,
		falseApprovals,
		eligibleForLive: blocker === null,
		blocker,
	};
}

/** Live only when the scoreboard clears the bar and the owner has not pinned this class to shadow. */
export function isLiveClass(score: CouncilClassScore, forcedShadow: boolean): boolean {
	return !forcedShadow && score.eligibleForLive;
}
