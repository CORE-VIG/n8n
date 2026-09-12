/** Types returned by the Aon threads API: the assistant's conversations and their turns. */

export interface AonThreadSummary {
	id: string;
	title: string | null;
	createdAt: string;
	lastTurnAt: string | null;
	turnCount: number;
	/** The last assistant text, shortened, for the list. */
	preview: string | null;
}

export interface AonTurnTool {
	id: string;
	name: string;
	status: 'start' | 'ok' | 'error';
	/** The tool call's input, compact JSON, secrets redacted. Absent until the call finishes. */
	input?: string;
	/** What the tool returned, cut to a cap. Absent until the call finishes. */
	result?: string;
	isError?: boolean;
	/** How long the call took, in milliseconds. */
	ms?: number;
}

export interface AonTurn {
	id: string;
	role: 'user' | 'assistant';
	text: string;
	tools: AonTurnTool[] | null;
	costUsd: number;
	createdAt: string;
}

export interface AonThreadDetail extends AonThreadSummary {
	turns: AonTurn[];
}
