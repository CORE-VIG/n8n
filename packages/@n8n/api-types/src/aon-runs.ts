import type { AonRunSummary } from './aon';

/** Types returned by the Aon runs API. */

export interface AonRunDetail extends AonRunSummary {
	parentRunId: string | null;
	input: unknown;
	output: string | null;
	outputPageId: string | null;
	verification: unknown;
	claimedBy: string | null;
	heartbeatAt: string | null;
	approvalId: string | null;
	updatedAt: string;
}

export interface AonRunList {
	items: AonRunSummary[];
	total: number;
	byStatus: Record<string, number>;
}
