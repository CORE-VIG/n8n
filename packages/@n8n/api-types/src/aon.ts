/** Types returned by the Aon agent and memory APIs. */

export interface AonRunSummary {
	id: string;
	agentId: string;
	agentSlug: string | null;
	agentName: string | null;
	deliverableId: string;
	deliverableName: string | null;
	status: string;
	attempt: number;
	iteration: number;
	invokedBy: string;
	model: string | null;
	tokensIn: number;
	tokensOut: number;
	costEur: number;
	help: string | null;
	startedAt: string | null;
	finishedAt: string | null;
	createdAt: string;
}

export interface AonDeliverableSummary {
	id: string;
	slug: string;
	name: string;
	dod: string;
	shape: string;
	cadence: string | null;
	tier: number;
	approver: string;
	maxIterations: number;
	enabled: boolean;
	lastRunAt: string | null;
}

export interface AonLearnedRuleSummary {
	id: string;
	agentId: string | null;
	text: string;
	state: string;
	reason: string | null;
	createdAt: string;
	revokedAt: string | null;
}

export interface AonAgentSummary {
	id: string;
	slug: string;
	name: string;
	persona: string;
	status: string;
	breakerFailures: number;
	breakerTrippedAt: string | null;
	createdAt: string;
	updatedAt: string;
	counts: { deliverables: number; runs: number };
	lastRun: { id: string; status: string; createdAt: string; finishedAt: string | null } | null;
}

/** An agent's charter, grouped the way Aon defines an agent. Unknown keys land in `other`. */
export interface AonCharterView {
	orientation: { purpose: string | null; persona: string; owns: string[]; sources: string[] };
	rules: { do: string[]; dont: string[] };
	skills: string[];
	tools: string[];
	guard: {
		tierCeiling: number | null;
		breakerLimit: number | null;
		escalateWhen: string | null;
		budgetEurMonth: number | null;
		modelBand: string | null;
	};
	other: Record<string, unknown>;
}

export interface AonAgentDetail extends AonAgentSummary {
	charter: AonCharterView;
	deliverables: AonDeliverableSummary[];
	runs: AonRunSummary[];
	rules: AonLearnedRuleSummary[];
}

export interface AonAgentsOverview {
	agents: number;
	activeAgents: number;
	deliverables: number;
	runs: number;
	runsByStatus: Record<string, number>;
	rules: number;
	lastRunAt: string | null;
}

export interface AonMemoryOverview {
	sources: number;
	chunks: number;
	embedded: number;
	byOrigin: Array<{ origin: string; count: number }>;
	lastIndexedAt: string | null;
	vectorSearch: boolean;
}

export type AonMemorySearchMode = 'hybrid' | 'text' | 'vector';

export interface AonMemoryHit {
	chunkId: string;
	sourceId: string;
	seq: number;
	text: string;
	score: number;
	title: string;
	origin: string;
	kind: string;
	docTime: string | null;
}

export interface AonMemorySearchResult {
	query: string;
	mode: AonMemorySearchMode;
	hits: AonMemoryHit[];
	/** False when the query could not be embedded, so only text was searched. */
	embedded: boolean;
	tookMs: number;
}
