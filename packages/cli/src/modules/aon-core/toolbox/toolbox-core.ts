/**
 * The toolbox: what Aon can reach for but does not contain.
 *
 * A skill on disk, a script on the host, an MCP server, a CLI. None of it is
 * Aon's own code, and none of it is executed from here — this is a
 * catalogue, so that "what can I use for this" has an answer that is not
 * somebody's memory of what they installed.
 *
 * Ported from the retired standalone Aon's `lib/toolbox.ts`. The shape is
 * VICORE's, which has run a registry like this for months, and the three
 * rules below are its lessons rather than guesses:
 *
 *   A SCAN NEVER DELETES. A tool that vanished is marked gone and keeps its
 *   row, its tags and its usage. Deleting would lose the one thing a
 *   registry accumulates that cannot be rebuilt — how often he actually
 *   reached for it — and a tool that is gone today is often back tomorrow.
 *
 *   A SCAN NEVER OVERWRITES USE. Re-reading a file tells you its name and
 *   its summary. It tells you nothing about whether anyone used it.
 *
 *   AN EMPTY FIELD BEATS A GUESSED ONE. Rank on what is known: an exact
 *   name, then a tag, then the words — and let use break ties only once
 *   there is use.
 *
 * Pure: no database, no filesystem. `aon-toolbox.service.ts` does the
 * reading and writing.
 */

export const TOOLBOX_KINDS = ['skill', 'script', 'mcp', 'cli'] as const;
export type ToolboxKind = (typeof TOOLBOX_KINDS)[number];

export function isToolboxKind(v: unknown): v is ToolboxKind {
	return typeof v === 'string' && (TOOLBOX_KINDS as readonly string[]).includes(v);
}

/** What a scan found on disk. No id, no history — just what the file says. */
export interface ToolboxFound {
	slug: string;
	kind: ToolboxKind;
	name: string;
	/** What it IS. A listing reads this. */
	summary: string;
	/** WHEN to reach for it. A router reads this. Null when the file does not separate them. */
	whenToUse: string | null;
	/** A path, a command, or an MCP server name. Where it actually is. */
	location: string;
	/** How a person or an agent would invoke it, in words. Never run from here. */
	invocation: string | null;
	tags: string[];
	/** Roughly what loading it would cost in context. fileSize / 4. */
	estTokens: number;
}

/** What the table holds. */
export interface ToolboxStored extends ToolboxFound {
	id: string;
	source: string;
	/**
	 * When a scan of its own kind first failed to find it. A grace clock
	 * rather than a flag: a skill directory is missing for all sorts of
	 * uninteresting reasons, and flipping it to gone on the first miss makes
	 * the catalogue flicker. It is cleared the moment it is seen again.
	 */
	missingSince: Date | null;
	uses: number;
	lastUsedAt: Date | null;
}

/** Away this long, and it is fair to call it gone rather than late. */
export const TOOLBOX_GONE_AFTER_MS = 7 * 24 * 3600_000;

export function isToolboxGone(t: Pick<ToolboxStored, 'missingSince'>, now = new Date()): boolean {
	return t.missingSince !== null && now.getTime() - t.missingSince.getTime() >= TOOLBOX_GONE_AFTER_MS;
}

const clean = (v: unknown, max: number): string =>
	typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** Lowercase, digits and dashes. The one identity a tool has across scans. */
export function toolboxSlugify(raw: unknown): string {
	return clean(raw, 120)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 100);
}

/* ── reading a skill file ──────────────────────────────────────────────── */

/**
 * The YAML frontmatter of a SKILL.md, as far as this needs it. Deliberately
 * not a YAML parser: a skill file's frontmatter is `key: value` with the
 * occasional quoted string and list, and pulling in a parser to read three
 * keys would be a dependency that can break on a file nobody controls.
 */
export function toolboxFrontmatter(text: string): Record<string, string> {
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text ?? '');
	if (!m) return {};
	const out: Record<string, string> = {};
	let key: string | null = null;
	for (const line of m[1].split(/\r?\n/)) {
		// A nested key (two spaces in) belongs to its parent and is not one of
		// the three this reads; skip it rather than flatten it into a wrong value.
		if (/^\s+\S/.test(line) && !/^\s*-\s/.test(line)) continue;
		const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
		if (kv) {
			key = kv[1];
			const v = kv[2].trim().replace(/^["']|["']$/g, '');
			if (v) out[key] = v;
			continue;
		}
		const item = /^\s*-\s+(.*)$/.exec(line);
		if (item && key) out[key] = out[key] ? `${out[key]}, ${item[1].trim()}` : item[1].trim();
	}
	return out;
}

/**
 * Tags, taken from what the file already says rather than invented.
 * `metadata.tags` if it has them; otherwise the quoted trigger phrases a
 * skill description is full of, which are the words he would actually
 * search for. No model, no classifier.
 */
export function toolboxTagsFrom(summary: string, fm: Record<string, string> = {}): string[] {
	const declared = (fm.tags ?? '').split(',').map((t) => toolboxSlugify(t)).filter(Boolean);
	const quoted = [...(summary.match(/["']([^"']{3,40})["']/g) ?? [])]
		.map((q) => toolboxSlugify(q))
		.filter(Boolean);
	return [...new Set([...declared, ...quoted])].slice(0, 24);
}

/** One skill directory: its SKILL.md and the path it sits at. */
export function toolboxReadSkill(dir: string, text: string): ToolboxFound | null {
	const fm = toolboxFrontmatter(text);
	const slug = toolboxSlugify(fm.name || dir.split('/').filter(Boolean).pop());
	if (!slug) return null;
	// The description IS the discovery surface for a skill — it is what a
	// model reads to decide whether to reach for it — so it is kept long.
	const summary = clean(fm.description, 2_000);
	// A skill description is written as trigger phrases, which is a `when`,
	// not a `what`. Where the file separates them, keep them separate.
	const when = clean(fm['when-to-use'] ?? fm.when, 1_000);
	return {
		slug,
		kind: 'skill',
		name: clean(fm.name, 120) || slug,
		summary,
		whenToUse: when || null,
		location: dir,
		invocation: `Skill(${slug})`,
		tags: toolboxTagsFrom(`${summary} ${when}`, fm),
		estTokens: Math.round((text ?? '').length / 4),
	};
}

/* ── the reconcile ─────────────────────────────────────────────────────── */

export interface ToolboxPlan {
	add: ToolboxFound[];
	/** Everything the file says, and nothing about use. */
	update: Array<{ id: string; found: ToolboxFound }>;
	/** Ids to start the grace clock on: in scope, not found now, not already counting. */
	missing: string[];
	/** Ids whose clock stops: it was away, and it is back. */
	back: string[];
	unchanged: number;
}

const same = (a: ToolboxFound, b: ToolboxFound): boolean =>
	a.kind === b.kind &&
	a.name === b.name &&
	a.summary === b.summary &&
	a.whenToUse === b.whenToUse &&
	a.location === b.location &&
	a.invocation === b.invocation &&
	a.estTokens === b.estTokens &&
	a.tags.length === b.tags.length &&
	a.tags.every((t, i) => t === b.tags[i]);

/**
 * What one scan should change. `scope` is the set of kinds this scan
 * actually looked for: a scan of the skills directory says nothing about
 * whether an MCP server still exists, so it must not mark one gone.
 */
export function toolboxReconcile(
	found: ToolboxFound[],
	stored: ToolboxStored[],
	scope: readonly ToolboxKind[],
): ToolboxPlan {
	const inScope = new Set<ToolboxKind>(scope);
	const bySlug = new Map(stored.map((s) => [s.slug, s]));
	const seen = new Set<string>();
	const plan: ToolboxPlan = { add: [], update: [], missing: [], back: [], unchanged: 0 };

	for (const f of found) {
		if (!f.slug) continue;
		seen.add(f.slug);
		const was = bySlug.get(f.slug);
		if (!was) {
			plan.add.push(f);
			continue;
		}
		if (was.missingSince) plan.back.push(was.id);
		if (same(f, was)) plan.unchanged += 1;
		else plan.update.push({ id: was.id, found: f });
	}

	for (const s of stored) {
		if (!inScope.has(s.kind)) continue;
		if (seen.has(s.slug) || s.missingSince) continue;
		plan.missing.push(s.id);
	}
	return plan;
}

/* ── finding one ───────────────────────────────────────────────────────── */

/**
 * Rank by what is known. An exact slug beats a tag beats a name beats the
 * words, and use only separates two that are otherwise equal.
 */
export function toolboxScore(t: ToolboxStored, q: string): number {
	const needle = q.trim().toLowerCase();
	if (!needle) return t.missingSince ? 0 : 1;
	let s = 0;
	if (t.slug === needle) s += 100;
	else if (t.slug.includes(needle)) s += 40;
	if (t.tags.some((tag) => tag === needle)) s += 50;
	else if (t.tags.some((tag) => tag.includes(needle))) s += 15;
	if (t.name.toLowerCase().includes(needle)) s += 20;
	if ((t.whenToUse ?? '').toLowerCase().includes(needle)) s += 14;
	if (t.summary.toLowerCase().includes(needle)) s += 10;
	if (s === 0) return 0;
	return s + Math.min(9, t.uses);
}

/**
 * Everything present, best first; then everything gone, best first. A gone
 * tool still appears, because knowing it existed is the difference between
 * "Aon cannot do that" and "that was uninstalled".
 */
export function toolboxSearch(tools: ToolboxStored[], q: string, limit = 20): ToolboxStored[] {
	return tools
		.map((t) => ({ t, s: toolboxScore(t, q) }))
		.filter((x) => x.s > 0)
		.sort(
			(a, b) =>
				Number(Boolean(a.t.missingSince)) - Number(Boolean(b.t.missingSince)) ||
				b.s - a.s ||
				a.t.slug.localeCompare(b.t.slug),
		)
		.slice(0, Math.max(1, Math.min(100, limit)))
		.map((x) => x.t);
}

/** One line per tool, for a listing. */
export function toolboxLine(t: ToolboxStored, now = new Date()): string {
	const where =
		t.kind === 'skill' ? 'a skill' : t.kind === 'mcp' ? 'an MCP server' : t.kind === 'cli' ? 'a command' : 'a script';
	// Late and gone read differently, and he can act on the difference.
	const away = !t.missingSince ? '' : isToolboxGone(t, now) ? ' (no longer on the host)' : ' (not found in the last scan)';
	const used = t.uses > 0 ? ` · used ${t.uses}×` : '';
	return `${t.name} — ${where}${away}${used}`;
}
