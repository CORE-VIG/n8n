import type {
	AonOwnerModel,
	AonSettingsParts,
	AonSettingsUpdate,
	AonSettingsView,
	AonSkillInfo,
} from '@n8n/api-types';
import { ModuleRegistry } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import type { User } from '@n8n/db';
import { SettingsRepository } from '@n8n/db';
import { Container, Service } from '@n8n/di';
import { jsonParse } from 'n8n-workflow';
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';

import { AonGoogleAuthService } from '../google/aon-google-auth.service';
import { DEFAULT_AGENT_TIER_CEILING } from '../guard/op-classes';
import { AonHandsService } from '../hands/aon-hands.service';

const KEY_PERSONA = 'aon.persona';
const KEY_TALK_MODEL = 'aon.talkModel';
const KEY_BUDGET = 'aon.budgetEurMonth';
const KEY_EXTRACT_BUDGET = 'aon.extractBudgetEurMonth';
const KEY_DISABLED_SKILLS = 'aon.skills.disabled';
const KEY_GUARD_CARD_SECRET = 'aon.guardCardSecret';
/** `aon.extractSpentEur.<YYYY-MM>`: this month's counter, one row per month. */
const EXTRACT_SPENT_PREFIX = 'aon.extractSpentEur.';
const KEY_MODEL_OF_OWNER = 'aon.modelOfOwner';
const KEY_DREAM_LAST_RUN_AT = 'aon.dream.lastRunAt';
/** JSON array of op classes the owner has pinned to shadow, whatever the council's scoreboard says. */
const KEY_COUNCIL_SHADOW_ONLY = 'aon.council.shadowOnly';

/** The persona paragraph the assistant's system prompt used to hard-code; still the default until the owner changes it. */
export const DEFAULT_PERSONA =
	'You are Aon, the assistant inside this n8n instance, which belongs to the person talking to you. Speak as a colleague: short sentences, plain words, no bullet lists unless asked, never a menu of things you could do.';

/** The model bands Settings › Aon offers, regardless of what this instance happens to run on today. */
export const AON_MODEL_BANDS = ['haiku', 'sonnet', 'opus'] as const; // the CLI's aliases: always the current model of each band

export const DEFAULT_BUDGET_EUR_MONTH = 25;

export const DEFAULT_EXTRACT_BUDGET_EUR_MONTH = 5;

/** The fork's own skills: always on disk, never uninstalled, shown with a "built in" badge. */
const BUILT_IN_SKILLS = new Set([
	'loop-vs-graph',
	'aon-memory',
	'n8n-workflow-quality',
	'dogfood',
	'aon-reasoning',
	'aon-plan',
]);

/** A skill folder name, made safe: no path traversal, no surprises in a `rename`. */
function normalizeSkillName(raw: string): string {
	const name = raw.trim();
	if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(name)) {
		throw new BadRequestError('That is not a valid skill name.');
	}
	return name;
}

/** A URL's host only: never the path, query or any credential it carries. */
function hostOnly(url: string): string | null {
	try {
		return new URL(url).host || null;
	} catch {
		return null;
	}
}

/**
 * Settings › Aon: how the owner shapes the assistant (persona, model band,
 * monthly budget), which skills are on, and a status line for each part.
 *
 * Persona, model and budget are cheap to read and change rarely, so every
 * getter reads the settings table fresh rather than caching: a save here
 * must reach the very next assistant turn and the next executor tick.
 */
@Service()
export class AonSettingsService {
	constructor(
		private readonly settingsRepository: SettingsRepository,
		private readonly config: GlobalConfig,
		private readonly hands: AonHandsService,
		private readonly google: AonGoogleAuthService,
	) {}

	async persona(): Promise<string> {
		const row = await this.settingsRepository.findByKey(KEY_PERSONA);
		return row?.value ? row.value : DEFAULT_PERSONA;
	}

	async talkModel(): Promise<string> {
		const row = await this.settingsRepository.findByKey(KEY_TALK_MODEL);
		return row?.value ? row.value : this.config.aon.talkModel;
	}

	async budgetEurMonth(): Promise<number> {
		const row = await this.settingsRepository.findByKey(KEY_BUDGET);
		if (!row?.value) return DEFAULT_BUDGET_EUR_MONTH;
		const n = Number(row.value);
		return Number.isFinite(n) && n >= 0 ? n : DEFAULT_BUDGET_EUR_MONTH;
	}

	async extractBudgetEurMonth(): Promise<number> {
		const row = await this.settingsRepository.findByKey(KEY_EXTRACT_BUDGET);
		if (!row?.value) return DEFAULT_EXTRACT_BUDGET_EUR_MONTH;
		const n = Number(row.value);
		return Number.isFinite(n) && n >= 0 && n <= 200 ? n : DEFAULT_EXTRACT_BUDGET_EUR_MONTH;
	}

	/** The current calendar month's key for the extractor's spend counter, e.g. "2026-09". */
	private extractSpendKey(when: Date = new Date()): string {
		return `${EXTRACT_SPENT_PREFIX}${when.getUTCFullYear()}-${String(when.getUTCMonth() + 1).padStart(2, '0')}`;
	}

	/** What the extractor has spent this calendar month, in euros. */
	async extractSpentEurThisMonth(): Promise<number> {
		const row = await this.settingsRepository.findByKey(this.extractSpendKey());
		if (!row?.value) return 0;
		const n = Number(row.value);
		return Number.isFinite(n) && n >= 0 ? n : 0;
	}

	/** Adds `costEur` to this month's extraction spend counter. Read-modify-write: the extractor ticks once a minute, never concurrently. */
	async addExtractSpend(costEur: number): Promise<void> {
		if (!Number.isFinite(costEur) || costEur <= 0) return;
		const key = this.extractSpendKey();
		const current = await this.extractSpentEurThisMonth();
		await this.settingsRepository.upsert(
			{ key, value: String(current + costEur), loadOnStartup: false },
			['key'],
		);
	}

	/** The model of the owner the dream last wrote, or null before the first dream has ever run. */
	async modelOfOwner(): Promise<AonOwnerModel | null> {
		const row = await this.settingsRepository.findByKey(KEY_MODEL_OF_OWNER);
		if (!row?.value) return null;
		return jsonParse<AonOwnerModel | null>(row.value, { fallbackValue: null });
	}

	async setModelOfOwner(model: AonOwnerModel): Promise<void> {
		await this.settingsRepository.upsert(
			{ key: KEY_MODEL_OF_OWNER, value: JSON.stringify(model), loadOnStartup: false },
			['key'],
		);
	}

	/** When the dream last finished a pass, for the daily scheduler to know whether today's has run yet. */
	async dreamLastRunAt(): Promise<Date | null> {
		const row = await this.settingsRepository.findByKey(KEY_DREAM_LAST_RUN_AT);
		if (!row?.value) return null;
		const when = new Date(row.value);
		return Number.isNaN(when.getTime()) ? null : when;
	}

	async setDreamLastRunAt(when: Date): Promise<void> {
		await this.settingsRepository.upsert(
			{ key: KEY_DREAM_LAST_RUN_AT, value: when.toISOString(), loadOnStartup: false },
			['key'],
		);
	}

	/** Op classes the owner has pinned to shadow: the council still rules and records, but never decides. */
	async councilShadowOnlyClasses(): Promise<string[]> {
		const row = await this.settingsRepository.findByKey(KEY_COUNCIL_SHADOW_ONLY);
		if (!row?.value) return [];
		const parsed = jsonParse<string[]>(row.value, { fallbackValue: [] });
		return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
	}

	/** The Guard page's "Keep in shadow" switch, one op class at a time. Read-modify-write: the owner toggles this by hand, never concurrently. */
	async setCouncilShadowOnly(opClass: string, shadowOnly: boolean): Promise<string[]> {
		const current = await this.councilShadowOnlyClasses();
		const next = shadowOnly ? [...new Set([...current, opClass])] : current.filter((c) => c !== opClass);
		await this.settingsRepository.upsert(
			{ key: KEY_COUNCIL_SHADOW_ONLY, value: JSON.stringify(next), loadOnStartup: false },
			['key'],
		);
		return next;
	}

	/** The Guard-card notifier's own secret: generated once, on first use, and never rotated automatically. */
	async guardCardSecret(): Promise<string> {
		const row = await this.settingsRepository.findByKey(KEY_GUARD_CARD_SECRET);
		if (row?.value) return row.value;
		const secret = randomBytes(32).toString('hex');
		await this.settingsRepository.upsert(
			{ key: KEY_GUARD_CARD_SECRET, value: secret, loadOnStartup: false },
			['key'],
		);
		return secret;
	}

	/** The model band list a PUT may pick from: the three offered bands, plus whatever this instance already runs on. */
	allowedModels(): string[] {
		return [...AON_MODEL_BANDS, this.config.aon.talkModel];
	}

	isAllowedModel(model: string): boolean {
		return this.allowedModels().includes(model);
	}

	async update(input: AonSettingsUpdate): Promise<void> {
		if (input.persona !== undefined) {
			await this.settingsRepository.upsert(
				{ key: KEY_PERSONA, value: input.persona, loadOnStartup: false },
				['key'],
			);
		}
		if (input.talkModel !== undefined) {
			await this.settingsRepository.upsert(
				{ key: KEY_TALK_MODEL, value: input.talkModel, loadOnStartup: false },
				['key'],
			);
		}
		if (input.budgetEurMonth !== undefined) {
			await this.settingsRepository.upsert(
				{ key: KEY_BUDGET, value: String(input.budgetEurMonth), loadOnStartup: false },
				['key'],
			);
		}
		if (input.extractBudgetEurMonth !== undefined) {
			await this.settingsRepository.upsert(
				{ key: KEY_EXTRACT_BUDGET, value: String(input.extractBudgetEurMonth), loadOnStartup: false },
				['key'],
			);
		}
	}

	// --- skills --------------------------------------------------------------

	private skillsDir(): string {
		return path.join(this.config.aon.claudeHome, 'skills');
	}

	private skillsOffDir(): string {
		return path.join(this.config.aon.claudeHome, 'skills-off');
	}

	/** Every skill on disk, on or off, from whichever directory it is currently in. */
	async listSkills(): Promise<AonSkillInfo[]> {
		const [enabled, disabled] = await Promise.all([
			this.readSkillDir(this.skillsDir(), true),
			this.readSkillDir(this.skillsOffDir(), false),
		]);
		return [...enabled, ...disabled].sort((a, b) => a.name.localeCompare(b.name));
	}

	private async readSkillDir(dir: string, enabled: boolean): Promise<AonSkillInfo[]> {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return []; // the directory does not exist yet: no skills there
		}
		const skills: AonSkillInfo[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const description = await this.readSkillDescription(path.join(dir, entry.name, 'SKILL.md'));
			if (description === null) continue; // not a skill folder
			skills.push({ name: entry.name, description, enabled, builtIn: BUILT_IN_SKILLS.has(entry.name) });
		}
		return skills;
	}

	/** The `description:` line from a SKILL.md's YAML frontmatter, or null when there is no such file. */
	private async readSkillDescription(skillMdPath: string): Promise<string | null> {
		let text: string;
		try {
			text = await readFile(skillMdPath, 'utf8');
		} catch {
			return null;
		}
		const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
		const frontmatter = frontmatterMatch ? frontmatterMatch[1] : text;
		const line = frontmatter.split(/\r?\n/).find((l) => /^description:\s*/.test(l.trim()));
		if (!line) return '';
		return line
			.trim()
			.replace(/^description:\s*/, '')
			.trim()
			.replace(/^"(.*)"$/, '$1')
			.replace(/^'(.*)'$/, '$1');
	}

	/** Moves a skill folder between `skills/` and `skills-off/`; records the on/off list alongside it. */
	async setSkillEnabled(rawName: string, enabled: boolean): Promise<AonSkillInfo> {
		const name = normalizeSkillName(rawName);
		const fromDir = enabled ? this.skillsOffDir() : this.skillsDir();
		const toDir = enabled ? this.skillsDir() : this.skillsOffDir();
		const fromPath = path.join(fromDir, name);
		const toPath = path.join(toDir, name);

		await mkdir(toDir, { recursive: true });
		try {
			await rename(fromPath, toPath);
		} catch {
			// Maybe it is already where it should be (a retried toggle); otherwise it never existed.
			const already = await this.readSkillDescription(path.join(toPath, 'SKILL.md'));
			if (already === null) throw new NotFoundError(`There is no skill called "${name}".`);
		}

		await this.recordSkillDisabled(name, enabled);

		const description = (await this.readSkillDescription(path.join(toPath, 'SKILL.md'))) ?? '';
		return { name, description, enabled, builtIn: BUILT_IN_SKILLS.has(name) };
	}

	private async recordSkillDisabled(name: string, enabled: boolean): Promise<void> {
		const row = await this.settingsRepository.findByKey(KEY_DISABLED_SKILLS);
		const current = row?.value ? jsonParse<string[]>(row.value, { fallbackValue: [] }) : [];
		const next = enabled ? current.filter((n) => n !== name) : [...new Set([...current, name])];
		await this.settingsRepository.upsert(
			{ key: KEY_DISABLED_SKILLS, value: JSON.stringify(next), loadOnStartup: false },
			['key'],
		);
	}

	// --- parts -----------------------------------------------------------------

	async parts(user: User): Promise<AonSettingsParts> {
		const chatIds = this.config.aon.telegramChatIds
			.split(',')
			.map((id) => id.trim())
			.filter(Boolean);
		const [model, handsConfigured, executorRunning, extractSpentEur, google] = await Promise.all([
			this.talkModel(),
			this.hands.isConfigured(),
			this.executorRunning(),
			this.extractSpentEurThisMonth(),
			this.google.status(user),
		]);
		return {
			assistant: { model, signedIn: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) },
			telegram: { linked: chatIds.length > 0, chatCount: chatIds.length },
			hands: { configured: handsConfigured },
			memory: {
				ollamaHost: this.config.aon.ollamaUrl ? hostOnly(this.config.aon.ollamaUrl) : null,
				embedModel: this.config.aon.embedModel,
				extractSpentEur,
			},
			executor: { running: executorRunning },
			guard: { tierCeilingDefault: DEFAULT_AGENT_TIER_CEILING },
			google,
		};
	}

	/**
	 * The executor lives in the `aon-agents` module, not this one: read it only
	 * when that module is active, so this settings page works even when agents
	 * are not (a fresh instance, or a deployment with the module off).
	 */
	private async executorRunning(): Promise<boolean> {
		if (!Container.get(ModuleRegistry).isActive('aon-agents')) return false;
		const { AonExecutorService } = await import(
			'@/modules/aon-agents/executor/aon-executor.service.js'
		);
		return Container.get(AonExecutorService).isRunning();
	}

	async view(user: User): Promise<AonSettingsView> {
		const [persona, talkModel, budgetEurMonth, extractBudgetEurMonth, skills, parts] = await Promise.all([
			this.persona(),
			this.talkModel(),
			this.budgetEurMonth(),
			this.extractBudgetEurMonth(),
			this.listSkills(),
			this.parts(user),
		]);
		return { persona, talkModel, budgetEurMonth, extractBudgetEurMonth, skills, parts };
	}
}
