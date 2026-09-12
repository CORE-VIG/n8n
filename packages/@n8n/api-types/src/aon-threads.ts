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
