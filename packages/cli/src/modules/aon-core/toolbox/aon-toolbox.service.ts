import type { AonToolboxItem, AonToolboxKind, AonToolboxList, AonToolboxRescanResult } from '@n8n/api-types';
import { GlobalConfig } from '@n8n/config';
import { SettingsRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { jsonParse } from 'n8n-workflow';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AonToolbox } from '../database/entities/aon-toolbox.entity';
import { AonToolboxRepository } from '../database/repositories/aon-toolbox.repository';
import {
	isToolboxGone,
	isToolboxKind,
	toolboxReadSkill,
	toolboxReconcile,
	toolboxSearch,
	toolboxLine,
	type ToolboxFound,
	type ToolboxKind,
	type ToolboxStored,
} from './toolbox-core';

/** `aon.toolbox.scanDirs`: a JSON array of directories `rescan()` reads skills from. */
const KEY_SCAN_DIRS = 'aon.toolbox.scanDirs';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const toStored = (row: AonToolbox): ToolboxStored => ({
	id: row.id,
	slug: row.slug,
	kind: isToolboxKind(row.kind) ? row.kind : 'script',
	name: row.name,
	summary: row.summary,
	whenToUse: row.whenToUse,
	location: row.location,
	invocation: row.invocation,
	tags: row.tags,
	source: row.source,
	missingSince: row.missingSince,
	uses: row.uses,
	lastUsedAt: row.lastUsedAt,
	estTokens: row.estTokens,
});

const toItem = (t: ToolboxStored): AonToolboxItem => ({
	slug: t.slug,
	kind: t.kind,
	name: t.name,
	summary: t.summary,
	whenToUse: t.whenToUse,
	location: t.location,
	invocation: t.invocation,
	tags: t.tags,
	source: t.source,
	estTokens: t.estTokens,
	away: t.missingSince !== null,
	gone: isToolboxGone(t),
	missingSince: t.missingSince ? t.missingSince.toISOString() : null,
	uses: t.uses,
	lastUsedAt: t.lastUsedAt ? t.lastUsedAt.toISOString() : null,
	line: toolboxLine(t),
});

/**
 * The toolbox: what Aon can reach for but does not contain. Reads skill
 * folders on disk, reconciles them against `aon_toolbox`
 * (`toolbox-core.ts` owns the rules), and answers "what is within reach" —
 * not to be confused with `AonSettingsService`'s capability
 * self-description, which answers "what is Aon".
 */
@Service()
export class AonToolboxService {
	constructor(
		private readonly toolbox: AonToolboxRepository,
		private readonly settingsRepository: SettingsRepository,
		private readonly config: GlobalConfig,
	) {}

	/** `<claudeHome>/skills` and `<claudeHome>/skills-off`, unless the owner set `aon.toolbox.scanDirs`. */
	async scanDirs(): Promise<string[]> {
		const row = await this.settingsRepository.findByKey(KEY_SCAN_DIRS);
		if (row?.value) {
			const parsed = jsonParse<unknown>(row.value, { fallbackValue: null });
			if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string') && parsed.length > 0) {
				return parsed;
			}
		}
		const { claudeHome } = this.config.aon;
		return [join(claudeHome, 'skills'), join(claudeHome, 'skills-off')];
	}

	/**
	 * Every skill directory across every scan dir, read from disk. A
	 * directory without a SKILL.md is not a skill and is passed over in
	 * silence: a scan dir also holds things that are not skills, and a
	 * registry that complained about them would complain every tick.
	 */
	async scanSkills(dirs: string[]): Promise<ToolboxFound[]> {
		const out: ToolboxFound[] = [];
		const seenSlugs = new Set<string>();
		for (const dir of dirs) {
			let names: string[];
			try {
				names = (await readdir(dir, { withFileTypes: true }))
					.filter((e) => e.isDirectory() || e.isSymbolicLink())
					.map((e) => e.name);
			} catch {
				continue; // the directory does not exist (yet)
			}
			for (const name of names) {
				const path = join(dir, name);
				try {
					const text = await readFile(join(path, 'SKILL.md'), 'utf8');
					const found = toolboxReadSkill(path, text);
					// The first directory to claim a slug wins: `skills/` is scanned
					// before `skills-off/` by default, so an enabled copy shadows a
					// disabled one of the same name rather than the reconcile
					// treating them as two updates to the same row.
					if (found && !seenSlugs.has(found.slug)) {
						seenSlugs.add(found.slug);
						out.push(found);
					}
				} catch {
					// Not a skill, or unreadable. Either way there is nothing to catalogue.
				}
			}
		}
		return out;
	}

	async all(): Promise<ToolboxStored[]> {
		const rows = await this.toolbox.listAll();
		return rows.map(toStored);
	}

	/** Read the disk, reconcile, apply. The scope is what was actually looked at. */
	async rescan(): Promise<AonToolboxRescanResult> {
		const dirs = await this.scanDirs();
		const found = await this.scanSkills(dirs);
		const stored = await this.all();
		const scope: ToolboxKind[] = ['skill'];
		const plan = toolboxReconcile(found, stored, scope);

		for (const f of plan.add) {
			await this.toolbox.insertFound(randomUUID(), f, 'disk');
		}
		for (const { id, found: f } of plan.update) {
			await this.toolbox.updateFound(id, f);
		}
		const now = new Date();
		await this.toolbox.markMissing(plan.missing, now);
		await this.toolbox.markBack(plan.back);

		return {
			added: plan.add.length,
			updated: plan.update.length,
			missing: plan.missing.length,
			back: plan.back.length,
			unchanged: plan.unchanged,
			scanned: found.length,
			scope,
			words: `Read ${found.length} ${found.length === 1 ? 'skill' : 'skills'} on this host: ${plan.add.length} new, ${plan.update.length} changed, ${plan.missing.length} not found this time, ${plan.unchanged} the same.`,
		};
	}

	async list(o: { q?: string; kind?: string; limit?: number } = {}): Promise<AonToolboxList> {
		const tools = await this.all();
		const kind = o.kind && isToolboxKind(o.kind) ? o.kind : null;
		const scoped = kind ? tools.filter((t) => t.kind === kind) : tools;
		const limit = Math.min(MAX_LIMIT, Math.max(1, o.limit ?? DEFAULT_LIMIT));
		const hits = toolboxSearch(scoped, o.q ?? '', limit);
		const live = tools.filter((t) => !t.missingSince);
		const byKind: Record<AonToolboxKind, number> = { skill: 0, script: 0, mcp: 0, cli: 0 };
		for (const t of live) byKind[t.kind] += 1;
		return {
			count: tools.length,
			live: live.length,
			byKind,
			shown: hits.length,
			items: hits.map(toItem),
			empty: tools.length === 0 ? 'Nothing has been catalogued yet. Run a rescan and the skills on this host appear here.' : null,
		};
	}

	async get(slug: string): Promise<AonToolboxItem | null> {
		const row = await this.toolbox.findBySlug(slug);
		return row ? toItem(toStored(row)) : null;
	}

	/** Records that an identity reached for a tool. */
	async recordUse(slug: string, actor: string): Promise<AonToolboxItem | null> {
		const row = await this.toolbox.recordUse(slug, actor);
		return row ? toItem(toStored(row)) : null;
	}
}
