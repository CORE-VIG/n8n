/** Types for Settings > Aon: how the owner shapes the assistant, and what it can see about it. */

export interface AonSkillInfo {
	name: string;
	/** From the skill's own SKILL.md frontmatter. */
	description: string;
	enabled: boolean;
	/** One of the fork's own `aon-skills/`: loop-vs-graph, aon-memory, n8n-workflow-quality. */
	builtIn: boolean;
}

export interface AonSettingsPartAssistant {
	model: string;
	signedIn: boolean;
}

export interface AonSettingsPartTelegram {
	linked: boolean;
	chatCount: number;
}

export interface AonSettingsPartHands {
	configured: boolean;
}

export interface AonSettingsPartMemory {
	/** Host only (no path, no credentials); null when memory has no embedding server configured. */
	ollamaHost: string | null;
	embedModel: string;
	/** What the extractor has spent this calendar month, in euros. */
	extractSpentEur: number;
}

export interface AonSettingsPartExecutor {
	running: boolean;
}

export interface AonSettingsPartGuard {
	tierCeilingDefault: number;
}

export interface AonSettingsParts {
	assistant: AonSettingsPartAssistant;
	telegram: AonSettingsPartTelegram;
	hands: AonSettingsPartHands;
	memory: AonSettingsPartMemory;
	executor: AonSettingsPartExecutor;
	guard: AonSettingsPartGuard;
}

/** `GET /aon/settings`: the whole page in one call. */
export interface AonSettingsView {
	persona: string;
	talkModel: string;
	budgetEurMonth: number;
	extractBudgetEurMonth: number;
	skills: AonSkillInfo[];
	parts: AonSettingsParts;
}

/** `PUT /aon/settings`: unset fields are left alone. */
export interface AonSettingsUpdate {
	persona?: string;
	talkModel?: string;
	budgetEurMonth?: number;
	extractBudgetEurMonth?: number;
}
