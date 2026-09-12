/** Types returned by the Aon Guard API: policies, approvals and the audit trail. */

export type AonGuardVerdict = 'allow' | 'ask' | 'deny';

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
	verdict: AonGuardVerdict;
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
	status: 'pending' | 'approved' | 'denied' | 'expired';
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
	verdict: AonGuardVerdict | 'asked' | 'approved' | 'denied' | 'expired';
	approvalId: string | null;
	meta: Record<string, unknown> | null;
}

export interface AonGuardOverview {
	pending: AonGuardApproval[];
	policies: AonGuardPolicy[];
	opClasses: AonGuardOpClass[];
	recent: AonGuardEvent[];
}
