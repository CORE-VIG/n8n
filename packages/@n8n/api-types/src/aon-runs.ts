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

/** The statuses a run moves through; done, failed and stopped are terminal. */
export const AON_RUN_STATUSES = [
	'queued',
	'working',
	'validating',
	'waiting_approval',
	'needs_help',
	'done',
	'failed',
	'stopped',
] as const;
export type AonRunStatus = (typeof AON_RUN_STATUSES)[number];

/** One line of a run's live log: what the agent said, called, or was told. */
export interface AonRunEvent {
	id: number;
	runId: string;
	seq: number;
	type: 'text' | 'tool' | 'judge' | 'status' | 'error' | 'cost' | 'note';
	name: string | null;
	status: string | null;
	text: string | null;
	createdAt: string;
}

export interface AonRunNowRequest {
	/** Free text handed to the agent as this run's input, optional. */
	input?: string;
}
