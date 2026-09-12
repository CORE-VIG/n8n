import { Logger } from '@n8n/backend-common';
import { Service } from '@n8n/di';
import { randomUUID } from 'node:crypto';

import { AonRunnerService } from '@/modules/aon-agents/executor/aon-runner.service';
import { costEur } from '@/modules/aon-agents/executor/run-machine';

import { AonSettingsService } from '../aon-core/settings/aon-settings.service';

import { AonEntityRepository } from './database/repositories/aon-entity.repository';
import { AonFactRepository } from './database/repositories/aon-fact.repository';
import type { AonUnextractedSourceRow } from './database/repositories/aon-source.repository';
import { AonSourceRepository } from './database/repositories/aon-source.repository';

const TICK_MS = 60_000;
const BATCH_LIMIT = 3;
/** A `page` source longer than this is skipped: too much to send to a fast model in one turn. */
const PAGE_CHAR_LIMIT = 20_000;
/** How much of a source's content actually reaches the model. */
const CONTENT_CHARS_TO_MODEL = 12_000;
const EXTRACT_TIMEOUT_MS = 3 * 60_000;
const ENTITY_KINDS = new Set(['person', 'org', 'place', 'thing', 'concept', 'document', 'event']);
/** The budget-reached notice is worth repeating occasionally, never once a tick. */
const BUDGET_LOG_INTERVAL_MS = 60 * 60_000;

type CandidateSource = AonUnextractedSourceRow;

interface ExtractedEntity {
	name: string;
	kind: string;
	aliases: string[];
}

interface ExtractedFact {
	subject: string;
	predicate: string;
	object: string;
	quote: string | null;
	confidence: number | null;
}

interface ResolvedEntity {
	id: string;
	kind: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isString(value: unknown): value is string {
	return typeof value === 'string';
}

function normalizeEntity(raw: unknown): ExtractedEntity | null {
	if (!isRecord(raw)) return null;
	const name = isString(raw.name) ? raw.name.trim() : '';
	if (!name) return null;
	const kind = isString(raw.kind) && ENTITY_KINDS.has(raw.kind) ? raw.kind : 'unknown';
	const aliases = Array.isArray(raw.aliases) ? raw.aliases.filter(isString) : [];
	return { name, kind, aliases };
}

function normalizeFact(raw: unknown): ExtractedFact | null {
	if (!isRecord(raw)) return null;
	const subject = isString(raw.subject) ? raw.subject.trim() : '';
	const predicate = isString(raw.predicate) ? raw.predicate.trim().toLowerCase() : '';
	const object = isString(raw.object)
		? raw.object.trim()
		: typeof raw.object === 'number'
			? String(raw.object)
			: '';
	if (!subject || !predicate || !object) return null;
	const quote = isString(raw.quote) ? raw.quote.trim() : null;
	const confidence =
		typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
			? Math.min(1, Math.max(0, raw.confidence))
			: null;
	return { subject, predicate, object, quote, confidence };
}

/** Unparseable, or not a JSON object, is nothing extracted — never an error. */
function parseExtraction(text: string | null | undefined): { entities: ExtractedEntity[]; facts: ExtractedFact[] } {
	const raw = String(text ?? '').trim();
	const start = raw.indexOf('{');
	const end = raw.lastIndexOf('}');
	if (start < 0 || end <= start) return { entities: [], facts: [] };
	let doc: unknown;
	try {
		doc = JSON.parse(raw.slice(start, end + 1));
	} catch {
		return { entities: [], facts: [] };
	}
	if (!isRecord(doc)) return { entities: [], facts: [] };
	const entities = Array.isArray(doc.entities)
		? doc.entities.map(normalizeEntity).filter((e): e is ExtractedEntity => e !== null)
		: [];
	const facts = Array.isArray(doc.facts)
		? doc.facts.map(normalizeFact).filter((f): f is ExtractedFact => f !== null)
		: [];
	return { entities, facts };
}

function buildPrompt(source: CandidateSource): string {
	const date = source.docTime ? source.docTime.toISOString().slice(0, 10) : 'unknown';
	const body =
		source.content.length > CONTENT_CHARS_TO_MODEL
			? `${source.content.slice(0, CONTENT_CHARS_TO_MODEL)}\n(truncated)`
			: source.content;
	return [
		`Title: ${source.title}`,
		`Origin: ${source.origin}`,
		`Date: ${date}`,
		'',
		'Content:',
		body.trim() || '(empty)',
		'',
		'Extract the entities and facts this content actually states. Reply with one JSON object and',
		'nothing else, no prose, no code fence:',
		'{"entities":[{"name":"...","kind":"person|org|place|thing|concept|document|event","aliases":[]}],',
		' "facts":[{"subject":"...","predicate":"...","object":"...","quote":"...","confidence":0.0}]}',
		'Predicates are short and lowercase, e.g. "works at", "is due on", "owns". "object" is either the',
		'name of one of the entities above or a plain value (a date, a number, a short phrase). "quote" is',
		'the exact sentence or phrase the fact came from. "confidence" is 0 to 1. If nothing is worth',
		'extracting, reply {"entities":[],"facts":[]}.',
	].join('\n');
}

/**
 * Memory's writer for facts and entities: every minute, reads a few unread
 * sources through a fast model and turns what it says into pending facts
 * (and the entities they connect), for the owner to confirm or reject on
 * the Memory page. Skipped entirely when there is no runner to call.
 */
@Service()
export class AonExtractService {
	private running = false;
	/** Wall-clock time of the last "budget reached" log line: once an hour, not once a tick. */
	private lastBudgetLogAt = 0;

	constructor(
		private readonly entities: AonEntityRepository,
		private readonly facts: AonFactRepository,
		private readonly sources: AonSourceRepository,
		private readonly runner: AonRunnerService,
		private readonly settings: AonSettingsService,
		private readonly logger: Logger,
	) {}

	start(): void {
		setInterval(() => void this.tick(), TICK_MS).unref();
	}

	async tick(): Promise<void> {
		if (this.running) return;
		if (!process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return;
		this.running = true;
		try {
			const budget = await this.settings.extractBudgetEurMonth();
			let spent = await this.settings.extractSpentEurThisMonth();
			const candidates = await this.sources.listUnextracted(BATCH_LIMIT);
			for (const source of candidates) {
				if (spent >= budget) {
					this.logBudgetReached(spent, budget);
					break;
				}
				if (source.kind === 'page' && source.content.length > PAGE_CHAR_LIMIT) {
					await this.sources.markSkipped(source.id, 'too long for extraction');
					this.logger.info(`Aon memory extractor: skipped ${source.id} (${source.title}), too long to extract`);
					continue;
				}
				const outcome = await this.extractOne(source);
				if (outcome === 'runner-unavailable') break;
				spent = await this.settings.extractSpentEurThisMonth();
			}
		} catch (e) {
			this.logger.error(`Aon memory extractor tick failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.running = false;
		}
	}

	/** Logged at most once an hour: the tick runs every minute and would otherwise repeat this every time. */
	private logBudgetReached(spent: number, budget: number): void {
		const now = Date.now();
		if (now - this.lastBudgetLogAt < BUDGET_LOG_INTERVAL_MS) return;
		this.lastBudgetLogAt = now;
		this.logger.info(
			`Aon memory extractor: this month's spend (€${spent.toFixed(4)}) has reached the €${budget} extraction budget; pausing until next month or a higher budget`,
		);
	}

	private async extractOne(source: CandidateSource): Promise<'done' | 'runner-unavailable'> {
		const result = await this.runner.run({
			prompt: buildPrompt(source),
			systemPrompt: 'You extract facts. Answer with one JSON object and nothing else.',
			model: 'haiku',
			allowedTools: [],
			mcpConfigPath: null,
			maxTurns: 1,
			timeoutMs: EXTRACT_TIMEOUT_MS,
			signal: new AbortController().signal,
			onEvent: () => {},
		});

		if (result.isError && result.error?.startsWith('could not start claude')) {
			this.logger.warn(`Aon memory extractor: the runner is unavailable (${result.error}); pausing this pass`);
			return 'runner-unavailable';
		}

		const spentEur = costEur(result.costUsd);
		if (spentEur > 0) await this.settings.addExtractSpend(spentEur);

		let inserted = 0;
		if (!result.isError) {
			const { entities, facts } = parseExtraction(result.text);
			inserted = await this.applyExtraction(source, entities, facts);
		}
		await this.sources.markExtracted(source.id);
		this.logger.info(
			`Aon memory extractor: source ${source.id} (${source.title}) -> ${inserted} fact(s), ` +
				`€${spentEur.toFixed(4)}` +
				(result.isError ? `, model error: ${result.error}` : ''),
		);
		return 'done';
	}

	private async applyExtraction(
		source: CandidateSource,
		entities: ExtractedEntity[],
		facts: ExtractedFact[],
	): Promise<number> {
		const byName = new Map<string, ResolvedEntity>();

		for (const e of entities) {
			const key = e.name.toLowerCase();
			if (byName.has(key)) continue;
			byName.set(key, await this.resolveOrCreate(e.name, e.kind, e.aliases));
		}

		const resolveNamed = async (name: string): Promise<ResolvedEntity | null> => {
			const key = name.toLowerCase();
			const cached = byName.get(key);
			if (cached) return cached;
			const existing = await this.entities.findByNameOrAlias(name);
			if (!existing) return null;
			const resolved: ResolvedEntity = { id: existing.id, kind: existing.kind };
			byName.set(key, resolved);
			return resolved;
		};

		const firstChunkId = await this.sources.firstChunkId(source.id);
		const now = new Date();
		let inserted = 0;

		for (const f of facts) {
			const subject = (await resolveNamed(f.subject)) ?? (await this.resolveOrCreate(f.subject, 'unknown', []));
			byName.set(f.subject.toLowerCase(), subject);

			const objectEntity = await resolveNamed(f.object);
			const objectId = objectEntity?.id ?? null;
			const objectValue = objectEntity ? null : f.object;

			const duplicate = await this.facts.existsTriple(subject.id, f.predicate, objectId, objectValue);
			if (duplicate) continue;

			await this.facts.insertPending({
				subjectId: subject.id,
				predicate: f.predicate,
				objectId,
				objectValue,
				quote: f.quote,
				confidence: f.confidence,
				proposedBy: 'extractor',
				sourceChunkId: firstChunkId,
				recordedAt: now,
				validFrom: source.docTime,
			});
			inserted += 1;
		}

		return inserted;
	}

	private async resolveOrCreate(name: string, kind: string, aliases: string[]): Promise<ResolvedEntity> {
		const existing = await this.entities.findByNameOrAlias(name);
		if (existing) return { id: existing.id, kind: existing.kind };
		const id = randomUUID();
		const now = new Date();
		await this.entities.insertEntity({ id, name, kind, aliases, summary: null, createdAt: now, updatedAt: now });
		return { id, kind };
	}
}
