/** Types returned by the Aon Guard API: policies, approvals and the audit trail. */

export type AonGuardVerdict = 'allow' | 'ask' | 'deny';

/** A policy verdict only, never returned by Guard's own allow/ask/deny decision: this class of card for this identity may be ruled by the council instead of asking the owner every time. */
export type AonGuardPolicyVerdict = AonGuardVerdict | 'council';

export interface AonGuardIdentity {
	/** The owner acting through the assistant, or an agent acting through a run. */
	kind: 'owner' | 'agent';
	/** "owner", or the agent's slug. */
	name: string;
	runId?: string;
	/** The highest tier the agent may act within by itself; undefined for the owner. */
	tierCeiling?: number;
}

export interface AonGuardOpClass {
	opClass: string;
	tier: number;
	/** One line, in plain words, for policies and cards. */
	label: string;
}

export interface AonGuardPolicy {
	id: string;
	/** "*" for everyone, "owner", or "agent:<slug>". */
	identity: string;
	opClass: string;
	verdict: AonGuardPolicyVerdict;
	note: string | null;
	updatedAt: string;
}

export interface AonGuardApproval {
	id: string;
	identity: string;
	opClass: string;
	tier: number;
	summary: string;
	body: Record<string, unknown> | null;
	runId: string | null;
	status: 'pending' | 'approved' | 'denied' | 'expired' | 'used';
	decidedBy: string | null;
	decidedAt: string | null;
	expiresAt: string;
	createdAt: string;
}

export interface AonGuardEvent {
	id: number;
	ts: string;
	identity: string;
	opClass: string;
	tier: number;
	verdict: AonGuardVerdict | 'asked' | 'approved' | 'denied' | 'expired' | 'council';
	approvalId: string | null;
	meta: Record<string, unknown> | null;
}

export interface AonGuardOverview {
	pending: AonGuardApproval[];
	policies: AonGuardPolicy[];
	opClasses: AonGuardOpClass[];
	recent: AonGuardEvent[];
}

/** One op class's row in the Guard page's Council section. */
export interface AonCouncilClassView {
	opClass: string;
	/** Whether the council decides on its own for this class, or only records what it would have done. */
	live: boolean;
	/** The owner's "keep in shadow" switch: pinned to shadow even if the scoreboard would promote it. */
	shadowOnly: boolean;
	/** shadow rulings in the scored window (see `PROMOTION_WINDOW`), decided or not */
	rulings: number;
	/** rulings in the window whose card the owner has since decided */
	decided: number;
	/** decided rulings where the council's verdict matched the owner's decision */
	agreement: number;
	/** the council approved, the owner denied: the one disagreement that must stay at zero */
	falseApprovals: number;
	/** why this class is not live, in words; null once it is */
	blocker: string | null;
	lastRulingAt: string | null;
}

export interface AonCouncilOverview {
	classes: AonCouncilClassView[];
}
