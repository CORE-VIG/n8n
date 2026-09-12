import type { AonSkillInfo } from '@n8n/api-types';
import { ModuleRegistry } from '@n8n/backend-common';
import type { User } from '@n8n/db';
import { Container, Service } from '@n8n/di';
import z from 'zod';

import { identityFromRequest } from '@/modules/aon-core/guard/request-identity';
import { AON_OP_CLASSES, ALIASES, KNOWN_TOOL_NAMES, opClassOfTool } from '@/modules/aon-core/guard/op-classes';
import { AonGoogleAuthService } from '@/modules/aon-core/google/aon-google-auth.service';
import { AonGuardService } from '@/modules/aon-core/guard/aon-guard.service';
import { AonPlanService } from '@/modules/aon-core/plan/aon-plan.service';
import type { RegisterToolFn, ToolDefinition } from '@/modules/mcp/mcp.types';

import { AonSettingsService } from './aon-settings.service';

/** The pages the assistant tells the owner about; kept in step with the `YOUR PAGES` prompt block. */
const UI_PAGES: ReadonlyArray<{ name: string; path: string }> = [
	{ name: 'Home', path: '/aon' },
	{ name: 'Agents', path: '/aon/agents' },
	{ name: 'Runs', path: '/aon/runs' },
	{ name: 'Memory', path: '/aon/memory' },
	{ name: 'Hands', path: '/aon/hands' },
	{ name: 'Guard', path: '/aon/guard' },
	{ name: 'Settings', path: '/aon/settings' },
];

const settingsSetSchema = {
	persona: z.string().trim().max(4000).optional(),
	talkModel: z.string().min(1).max(200).optional(),
	budgetEurMonth: z.number().min(0).max(1000).optional(),
	localModel: z.string().min(1).max(200).optional(),
	backgroundPaidEurMonth: z.number().min(0).max(100).optional(),
	backgroundJobsPaused: z.boolean().optional(),
} satisfies z.ZodRawShape;

const settingsSchema = {} satisfies z.ZodRawShape;
const capabilitiesSchema = {} satisfies z.ZodRawShape;
const googleStatusSchema = {} satisfies z.ZodRawShape;
const stateSchema = {} satisfies z.ZodRawShape;

const skillSetSchema = {
	name: z.string().min(1).max(100).describe('A skill folder name, from aon_settings or Settings › Aon.'),
	enabled: z.boolean(),
} satisfies z.ZodRawShape;

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
const failure = (error: unknown) => ({
	content: [{ type: 'text' as const, text: `Aon settings: ${error instanceof Error ? error.message : String(error)}` }],
	isError: true,
});
const ownerOnly = () => ({ content: [{ type: 'text' as const, text: 'Only the owner changes Aon settings.' }], isError: true });

function skillLine(s: AonSkillInfo): string {
	return `- ${s.name}${s.builtIn ? ' (built in)' : ''} — ${s.enabled ? 'on' : 'off'}: ${s.description || '(no description)'}`;
}

/**
 * Settings and self-description as tools: read and change what Settings ›
 * Aon shows (owner only, same as the page), and a capability catalogue any
 * identity may ask for — what tools exist, at what tier, what parts are up,
 * what skills are on disk, and where the owner's own pages live.
 */
@Service()
export class McpAonSettingsToolsService {
	constructor(
		private readonly settings: AonSettingsService,
		private readonly googleAuth: AonGoogleAuthService,
		private readonly guard: AonGuardService,
		private readonly plan: AonPlanService,
	) {}

	private async pendingCardsCount(): Promise<number> {
		const cards = await this.guard.listCards('pending', 500);
		return cards.length;
	}

	/**
	 * The executor's runs live in the `aon-agents` module, not this one: read
	 * them only when that module is active, the same way `AonSettingsService`
	 * reads the executor's own running state.
	 */
	private async runsInFlightAndSpendToday(): Promise<{ inFlight: number; spendTodayEur: number }> {
		if (!Container.get(ModuleRegistry).isActive('aon-agents')) return { inFlight: 0, spendTodayEur: 0 };
		const { AonRunRepository } = await import(
			'@/modules/aon-agents/database/repositories/aon-run.repository.js'
		);
		const runs = Container.get(AonRunRepository);
		const [byStatus, spendTodayEur] = await Promise.all([runs.countByStatus(), runs.sumCostEurToday()]);
		const inFlight =
			(byStatus.queued ?? 0) + (byStatus.working ?? 0) + (byStatus.validating ?? 0) + (byStatus.waiting_approval ?? 0);
		return { inFlight, spendTodayEur };
	}

	/** 0 before the plan's first task, or when the Data Table it lives in cannot be reached right now. */
	private async planDueTodayCount(user: User): Promise<number> {
		try {
			const briefing = await this.plan.dayBriefing(user);
			return briefing.dueToday.length;
		} catch {
			return 0;
		}
	}

	registerTools(registerIfAllowed: RegisterToolFn, user: User) {
		const settingsGet: ToolDefinition<typeof settingsSchema> = {
			name: 'aon_settings',
			config: {
				description: "Settings › Aon, as the owner sees it: persona, model, budgets, skills and each part's status.",
				inputSchema: settingsSchema,
				annotations: { title: 'Read Aon settings', readOnlyHint: true },
			},
			handler: async (_args, extra) => {
				try {
					const identity = identityFromRequest(extra, user);
					if (identity.kind !== 'owner') return ownerOnly();
					const view = await this.settings.view(user);
					const sections = [
						`Persona: ${view.persona}`,
						`Model: ${view.talkModel}`,
						`Budget: €${view.budgetEurMonth}/mo. Background jobs (extraction, dream, council): ${view.parts.models.localModel} local model (${view.parts.models.localAvailable ? 'available' : 'unavailable'}), paid budget €${view.backgroundPaidEurMonth}/mo (spent €${view.parts.models.backgroundPaidSpentEur.toFixed(2)})${view.backgroundJobsPaused ? ', PAUSED' : ''}`,
						`Skills:\n${view.skills.map(skillLine).join('\n')}`,
						`Parts: assistant ${view.parts.assistant.signedIn ? 'signed in' : 'signed out'} (${view.parts.assistant.model}), telegram ${view.parts.telegram.linked ? `linked (${view.parts.telegram.chatCount})` : 'not linked'}, hands ${view.parts.hands.configured ? 'configured' : 'not configured'}, executor ${view.parts.executor.running ? 'running' : 'stopped'}, guard default tier ceiling ${view.parts.guard.tierCeilingDefault}, google ${view.parts.google.configured ? `connected (${view.parts.google.credentialName ?? 'unnamed'})` : 'not connected'}`,
					];
					return text(sections.join('\n\n'));
				} catch (error) {
					return failure(error);
				}
			},
		};

		const settingsSet: ToolDefinition<typeof settingsSetSchema> = {
			name: 'aon_settings_set',
			config: {
				description: "Change Aon's persona, model band, or monthly budgets. Only the fields given are changed. Owner only.",
				inputSchema: settingsSetSchema,
				annotations: { title: 'Change Aon settings', readOnlyHint: false, destructiveHint: false },
			},
			handler: async (args, extra) => {
				try {
					const identity = identityFromRequest(extra, user);
					if (identity.kind !== 'owner') return ownerOnly();
					if (args.talkModel !== undefined && !this.settings.isAllowedModel(args.talkModel)) {
						return { content: [{ type: 'text' as const, text: `"${args.talkModel}" is not one of the models Aon offers.` }], isError: true };
					}
					if (args.localModel !== undefined && !(await this.settings.isAllowedLocalModel(args.localModel))) {
						return { content: [{ type: 'text' as const, text: `"${args.localModel}" is not one of the models Ollama reports.` }], isError: true };
					}
					await this.settings.update(args);
					return text('Settings updated.');
				} catch (error) {
					return failure(error);
				}
			},
		};

		const capabilities: ToolDefinition<typeof capabilitiesSchema> = {
			name: 'aon_capabilities',
			config: {
				description:
					"A self-description of this instance's Aon: every tool with its Guard op class and tier, each part's status, the skills on disk, and the owner's own pages.",
				inputSchema: capabilitiesSchema,
				annotations: { title: 'Aon capabilities', readOnlyHint: true },
			},
			handler: async () => {
				try {
					const view = await this.settings.view(user);
					const aliasNames = new Set(Object.keys(ALIASES));
					const tools = KNOWN_TOOL_NAMES.filter((name) => !aliasNames.has(name))
						.map((name) => {
							const { opClass, tier } = opClassOfTool(name);
							const label = AON_OP_CLASSES.find((c) => c.opClass === opClass)?.label ?? opClass;
							return `- ${name}: ${opClass} (tier ${tier}) — ${label}`;
						})
						.sort();
					const aliases = Object.entries(ALIASES)
						.map(([oldName, newName]) => `- ${oldName} -> ${newName}`)
						.sort();
					const pages = UI_PAGES.map((p) => `- ${p.name}: ${p.path}`);
					const sections = [
						`Tools (${tools.length}):\n${tools.join('\n')}`,
						`Aliases from the old Aon app (${aliases.length}):\n${aliases.join('\n')}`,
						`Parts: assistant ${view.parts.assistant.signedIn ? 'signed in' : 'signed out'}, telegram ${view.parts.telegram.linked ? 'linked' : 'not linked'}, hands ${view.parts.hands.configured ? 'configured' : 'not configured'}, executor ${view.parts.executor.running ? 'running' : 'stopped'}, google ${view.parts.google.configured ? 'connected' : 'not connected'}`,
						`Skills:\n${view.skills.map(skillLine).join('\n')}`,
						`Pages:\n${pages.join('\n')}`,
					];
					return text(sections.join('\n\n'));
				} catch (error) {
					return failure(error);
				}
			},
		};

		const state: ToolDefinition<typeof stateSchema> = {
			name: 'aon_state',
			config: {
				description:
					"One-call orientation: each part's status, pending Guard cards, runs in flight, today's spend, Google, the local model, the last dream, and the plan's due-today count.",
				inputSchema: stateSchema,
				annotations: { title: 'Aon state', readOnlyHint: true },
			},
			handler: async () => {
				try {
					const [view, pendingCards, dreamLastRunAt, dueToday, runsState] = await Promise.all([
						this.settings.view(user),
						this.pendingCardsCount(),
						this.settings.dreamLastRunAt(),
						this.planDueTodayCount(user),
						this.runsInFlightAndSpendToday(),
					]);
					const sections = [
						`Parts: assistant ${view.parts.assistant.signedIn ? 'signed in' : 'signed out'}, telegram ${view.parts.telegram.linked ? 'linked' : 'not linked'}, hands ${view.parts.hands.configured ? 'configured' : 'not configured'}, executor ${view.parts.executor.running ? 'running' : 'stopped'}, google ${view.parts.google.configured ? 'connected' : 'not connected'}, local model ${view.parts.models.localModel} (${view.parts.models.localAvailable ? 'available' : 'unavailable'}).`,
						`Guard: ${pendingCards} pending card(s).`,
						`Runs: ${runsState.inFlight} in flight.`,
						`Spend: €${runsState.spendTodayEur.toFixed(2)} today (executor), €${view.parts.models.backgroundPaidSpentEur.toFixed(2)} this month (background).`,
						`Dream: last ran ${dreamLastRunAt ? dreamLastRunAt.toISOString() : 'never'}.`,
						`Plan: ${dueToday} due today.`,
					];
					return text(sections.join('\n'));
				} catch (error) {
					return failure(error);
				}
			},
		};

		const skillSet: ToolDefinition<typeof skillSetSchema> = {
			name: 'aon_settings_skill_set',
			config: {
				description: 'Turns one of Aon\'s skills on or off. Only the owner changes skills.',
				inputSchema: skillSetSchema,
				annotations: { title: 'Turn a skill on or off', readOnlyHint: false, destructiveHint: false },
			},
			handler: async (args, extra) => {
				try {
					const identity = identityFromRequest(extra, user);
					if (identity.kind !== 'owner') return ownerOnly();
					const skill = await this.settings.setSkillEnabled(args.name, args.enabled);
					return text(`${skill.name} is now ${skill.enabled ? 'on' : 'off'}.`);
				} catch (error) {
					return failure(error);
				}
			},
		};

		const googleStatus: ToolDefinition<typeof googleStatusSchema> = {
			name: 'aon_google_status',
			config: {
				description: 'Whether Gmail, Calendar, Drive and Sheets are connected: the credential name, its granted scopes, and the signed-in address.',
				inputSchema: googleStatusSchema,
				annotations: { title: 'Google status', readOnlyHint: true },
			},
			handler: async () => {
				try {
					const status = await this.googleAuth.status(user);
					if (!status.configured) return text('Google is not connected: no "Aon Google" (or other Google) credential was found.');
					return text(
						`Connected as ${status.email ?? '(unknown address)'} via "${status.credentialName ?? 'unnamed credential'}". Scopes: ${status.scopes.length ? status.scopes.join(', ') : '(none)'}.`,
					);
				} catch (error) {
					return failure(error);
				}
			},
		};

		registerIfAllowed(settingsGet);
		registerIfAllowed(settingsSet);
		registerIfAllowed(capabilities);
		registerIfAllowed(state);
		registerIfAllowed(skillSet);
		registerIfAllowed(googleStatus);
	}
}
