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
}

/** Background jobs (extraction, dream, council rulings, observations): local-model routing and the paid budget that gates any paid step. */
export interface AonSettingsPartModels {
	/** The Ollama model background jobs run on, e.g. "qwen3:4b". */
	localModel: string;
	/** Whether Ollama answered just now. */
	localAvailable: boolean;
	/** 0 means local models only: a paid model never touches background work. */
	backgroundPaidEurMonth: number;
	/** What background jobs have spent this calendar month, in euros. */
	backgroundPaidSpentEur: number;
}

export interface AonSettingsPartExecutor {
	running: boolean;
}

export interface AonSettingsPartGuard {
	tierCeilingDefault: number;
}

export interface AonSettingsPartGoogle {
	configured: boolean;
	credentialName: string | null;
	email: string | null;
	scopes: string[];
}

export interface AonSettingsParts {
	assistant: AonSettingsPartAssistant;
	telegram: AonSettingsPartTelegram;
	hands: AonSettingsPartHands;
	memory: AonSettingsPartMemory;
	executor: AonSettingsPartExecutor;
	guard: AonSettingsPartGuard;
	google: AonSettingsPartGoogle;
	models: AonSettingsPartModels;
}

/** `GET /aon/settings`: the whole page in one call. */
export interface AonSettingsView {
	persona: string;
	talkModel: string;
	budgetEurMonth: number;
	/** The Ollama model background jobs run on. One of `localModelOptions`, when Ollama answered. */
	localModel: string;
	/** Every chat model Ollama currently reports; empty when Ollama did not answer. */
	localModelOptions: string[];
	/** Background jobs' paid budget, €/month. 0 (the default) means local models only. */
	backgroundPaidEurMonth: number;
	/** The owner's kill switch: extraction, dream and council all skip their tick while this is true. */
	backgroundJobsPaused: boolean;
	skills: AonSkillInfo[];
	parts: AonSettingsParts;
}

/** `PUT /aon/settings`: unset fields are left alone. */
export interface AonSettingsUpdate {
	persona?: string;
	talkModel?: string;
	budgetEurMonth?: number;
	localModel?: string;
	backgroundPaidEurMonth?: number;
	backgroundJobsPaused?: boolean;
}
