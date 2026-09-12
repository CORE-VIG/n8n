import type { AonFactSummary, AonObservationSummary, AonOwnerModel, AonOwnerModelBuckets } from '@n8n/api-types';
import { Logger } from '@n8n/backend-common';
import { Service } from '@n8n/di';

import { AonRunnerService } from '@/modules/aon-agents/executor/aon-runner.service';
import { costEur } from '@/modules/aon-agents/executor/run-machine';
import { AonLocalModelService, LocalModelUnavailableError } from '@/modules/aon-core/models/aon-local-model.service';

import { AonSettingsService } from '../aon-core/settings/aon-settings.service';

import { AonCaptureService } from './aon-capture.service';
import { AonFactRepository } from './database/repositories/aon-fact.repository';
import { AonObservationRepository } from './database/repositories/aon-observation.repository';
import type { AonRecentSourceRow } from './database/repositories/aon-source.repository';
import { AonSourceRepository } from './database/repositories/aon-source.repository';

/** How often the scheduler checks whether today's dream is due; the dream itself runs once a day. */
const CHECK_INTERVAL_MS = 10 * 60_000;
const DREAM_HOUR = 3;
const DREAM_MINUTE = 30;
const CONFIRMED_FACTS_LIMIT = 2000;
const PENDING_FACTS_LIMIT = 60;
const RECENT_SOURCES_LIMIT = 40;
const OBSERVATIONS_LIMIT = 200;
/** Each bucket of the model of the owner is at most this many characters. */
const BUCKET_CHAR_LIMIT = 1200;
/** A local call's evidence batch stays well under the 6k-character prompt cap, leaving room for the instructions around it. */
const BUCKET_EVIDENCE_CHAR_LIMIT = 4_500;
/** A batch summary, before the merge step folds several of them together. */
const BATCH_SUMMARY_CHAR_LIMIT = 500;
const HAIKU_POLISH_TIMEOUT_MS = 3 * 60_000;

const BUCKET_NAMES: ReadonlyArray<keyof AonOwnerModelBuckets> = [
	'identity',
	'people',
	'projects',
	'preferences',
	'commitments',
];

export interface AonDreamOutcome {
	ran: boolean;
	message: string;
	model?: AonOwnerModel;
}

interface ParsedObservation {
	bucket: string;
	text: string;
	salience: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isString(value: unknown): value is string {
	return typeof value === 'string';
}

/** A bucket's text may come back as a string or a list of lines; either way it is capped at the budget. */
function normalizeBucketText(raw: unknown, limit: number = BUCKET_CHAR_LIMIT): string {
	const value = isString(raw) ? raw : Array.isArray(raw) ? raw.filter(isString).join('\n') : '';
	return value.trim().slice(0, limit);
}

function normalizeBatchObservation(bucket: string, raw: unknown): ParsedObservation | null {
	if (!isRecord(raw)) return null;
	const text = isString(raw.text) ? raw.text.trim() : '';
	if (!text) return null;
	const salience =
		typeof raw.salience === 'number' && Number.isFinite(raw.salience)
			? Math.min(1, Math.max(0, raw.salience))
			: 0.5;
	return { bucket, text: text.slice(0, 400), salience };
}

/** Unparseable, or not a JSON object, is nothing found — never an error. */
function parseJsonObject(text: string | null | undefined): Record<string, unknown> | null {
	const raw = String(text ?? '').trim();
	const start = raw.indexOf('{');
	const end = raw.lastIndexOf('}');
	if (start < 0 || end <= start) return null;
	try {
		const doc = JSON.parse(raw.slice(start, end + 1));
		return isRecord(doc) ? doc : null;
	} catch {
		return null;
	}
}

function factLine(f: AonFactSummary): string {
	return `- ${f.subject} ${f.predicate} ${f.object}${f.status === 'pending' ? ' (pending)' : ''}`;
}

function sourceLine(s: AonRecentSourceRow): string {
	const when = s.docTime ?? s.createdAt;
	return `- [${s.origin}] ${s.title}${when ? ` (${new Date(when).toISOString().slice(0, 10)})` : ''}`;
}

function observationLine(o: AonObservationSummary): string {
	return `- (salience ${o.salience.toFixed(2)}) ${o.text}`;
}

/** Splits already-built lines into batches that stay under the character cap, without cutting a line in half. */
function chunkLines(lines: readonly string[], maxChars: number): string[] {
	const chunks: string[] = [];
	let current: string[] = [];
	let len = 0;
	for (const line of lines) {
		if (current.length > 0 && len + line.length + 1 > maxChars) {
			chunks.push(current.join('\n'));
			current = [];
			len = 0;
		}
		current.push(line);
		len += line.length + 1;
	}
	if (current.length > 0) chunks.push(current.join('\n'));
	return chunks.length > 0 ? chunks : [''];
}

function sameCalendarDay(a: Date, b: Date): boolean {
	return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

interface DreamEvidence {
	confirmed: AonFactSummary[];
	pending: AonFactSummary[];
	recentSources: AonRecentSourceRow[];
	observations: AonObservationSummary[];
	previousModel: AonOwnerModel | null;
}

/** Every line of evidence for one bucket: shared facts and sources, plus that bucket's own observations. Facts and sources carry no bucket of their own, so every bucket reads the same pool of them. */
function bucketEvidenceLines(bucket: string, evidence: DreamEvidence): string[] {
	const bucketObservations = evidence.observations.filter((o) => o.bucket === bucket);
	return [
		`Confirmed facts (${evidence.confirmed.length}):`,
		...(evidence.confirmed.length ? evidence.confirmed.map(factLine) : ['(none)']),
		'',
		`Pending facts (${evidence.pending.length}):`,
		...(evidence.pending.length ? evidence.pending.map(factLine) : ['(none)']),
		'',
		`Sources read most recently (${evidence.recentSources.length}):`,
		...(evidence.recentSources.length ? evidence.recentSources.map(sourceLine) : ['(none)']),
		'',
		`"${bucket}" observations already held (${bucketObservations.length}):`,
		...(bucketObservations.length ? bucketObservations.map(observationLine) : ['(none)']),
	];
}

/**
 * The nightly dream: once a day, at 03:30 instance time, it rereads the
 * facts, the newest sources and the observations, and rewrites the model of
 * the owner in five buckets. Every step runs on the local model — background
 * work stays local by policy — batch by batch when a bucket's evidence is
 * too long for one turn, merged back into one bucket with a final local
 * call. Only when the owner has raised the background-paid budget above
 * zero does one further haiku turn (through {@link AonRunnerService}, within
 * that same budget) reason over the five local drafts and polish them; the
 * local drafts are the model otherwise. Skipped entirely when Ollama does
 * not answer, or the owner has paused background work. `runNow` also serves
 * the owner's "Dream now" button, sharing the same skip rules.
 */
@Service()
export class AonDreamService {
	private running = false;

	constructor(
		private readonly facts: AonFactRepository,
		private readonly sources: AonSourceRepository,
		private readonly observations: AonObservationRepository,
		private readonly capture: AonCaptureService,
		private readonly localModel: AonLocalModelService,
		private readonly runner: AonRunnerService,
		private readonly settings: AonSettingsService,
		private readonly logger: Logger,
	) {}

	start(): void {
		setInterval(() => void this.tick(), CHECK_INTERVAL_MS).unref();
	}

	async tick(): Promise<void> {
		if (this.running) return;
		if (!(await this.isDue())) return;
		const outcome = await this.runNow('schedule');
		if (outcome.ran) this.logger.info(`Aon dream: ${outcome.message}`);
	}

	private async isDue(): Promise<boolean> {
		const now = new Date();
		const pastHour = now.getHours() > DREAM_HOUR || (now.getHours() === DREAM_HOUR && now.getMinutes() >= DREAM_MINUTE);
		if (!pastHour) return false;
		const last = await this.settings.dreamLastRunAt();
		return !last || !sameCalendarDay(last, now);
	}

	/** `manual` is the owner's "Dream now" button; `schedule` is the daily tick. Both share the same skip rules. */
	async runNow(trigger: 'manual' | 'schedule'): Promise<AonDreamOutcome> {
		if (this.running) return { ran: false, message: 'A dream is already running.' };
		if (await this.settings.backgroundJobsPaused()) {
			return { ran: false, message: 'Background work is paused, so there is nothing to dream with.' };
		}
		if (!(await this.localModel.available())) {
			return { ran: false, message: 'The local model (Ollama) is unavailable, so there is nothing to dream with.' };
		}
		this.running = true;
		try {
			const outcome = await this.dreamOnce(trigger);
			await this.settings.setDreamLastRunAt(new Date());
			return outcome;
		} finally {
			this.running = false;
		}
	}

	private async dreamOnce(trigger: 'manual' | 'schedule'): Promise<AonDreamOutcome> {
		const model = await this.settings.localModel();
		const [confirmed, pending, recentSources, observations, previousModel] = await Promise.all([
			this.facts.list({ status: 'confirmed', limit: CONFIRMED_FACTS_LIMIT, offset: 0 }),
			this.facts.list({ status: 'pending', limit: PENDING_FACTS_LIMIT, offset: 0 }),
			this.sources.listRecentTitles(RECENT_SOURCES_LIMIT),
			this.observations.list(OBSERVATIONS_LIMIT),
			this.settings.modelOfOwner(),
		]);
		const evidence: DreamEvidence = {
			confirmed: confirmed.items,
			pending: pending.items,
			recentSources,
			observations,
			previousModel,
		};

		const localBuckets: AonOwnerModelBuckets = {
			identity: '',
			people: '',
			projects: '',
			preferences: '',
			commitments: '',
		};
		const proposedObservations: ParsedObservation[] = [];

		for (const bucket of BUCKET_NAMES) {
			const previousText = previousModel?.buckets[bucket] ?? '';
			const { text, observations: obs } = await this.dreamBucket(bucket, model, evidence, previousText);
			localBuckets[bucket] = text;
			proposedObservations.push(...obs);
		}

		const totalFacts = confirmed.total + pending.total;
		let buckets = localBuckets;
		let modelLabel: `local:${string}` | 'local+haiku' = `local:${model}`;
		let polishNote = '';

		if (await this.settings.backgroundPaidAllowed()) {
			if (process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
				const polished = await this.polishWithHaiku(localBuckets);
				if (polished) {
					buckets = polished;
					modelLabel = 'local+haiku';
				} else {
					polishNote = ' (haiku polish did not return a usable result; kept the local draft)';
				}
			} else {
				polishNote = ' (no Claude session is signed in; kept the local draft)';
			}
		}

		const document = BUCKET_NAMES.map((bucket) => `${bucket.toUpperCase()}\n${buckets[bucket] || '(empty)'}`).join(
			'\n\n',
		);
		await this.capture.captureModel(document);

		const now = new Date();
		const ownerModel: AonOwnerModel = {
			updatedAt: now.toISOString(),
			buckets,
			sources: recentSources.length,
			facts: totalFacts,
			model: modelLabel,
		};
		await this.settings.setModelOfOwner(ownerModel);

		let added = 0;
		for (const o of proposedObservations) {
			await this.observations.upsertObservation(o);
			added += 1;
		}

		this.logger.info(
			`Aon dream: model of the owner rebuilt (${totalFacts} fact(s), ${recentSources.length} source(s), ` +
				`${added} observation(s)), ${modelLabel} (${trigger})`,
		);
		return {
			ran: true,
			message: `The model of you was rebuilt from ${totalFacts} fact(s) and ${added} observation(s), on ${modelLabel}${polishNote}.`,
			model: ownerModel,
		};
	}

	/**
	 * One bucket, start to finish, entirely on the local model: the
	 * evidence is split into batches under the prompt cap, each batch is
	 * summarised on its own, and one final call folds every batch summary
	 * (plus the bucket as it stood before this dream) into the new bucket
	 * text. Never throws: a local-model failure just keeps the previous
	 * bucket text, the way a failed dream used to leave the model alone.
	 */
	private async dreamBucket(
		bucket: keyof AonOwnerModelBuckets,
		model: string,
		evidence: DreamEvidence,
		previousText: string,
	): Promise<{ text: string; observations: ParsedObservation[] }> {
		const batches = chunkLines(bucketEvidenceLines(bucket, evidence), BUCKET_EVIDENCE_CHAR_LIMIT);
		const batchSummaries: string[] = [];
		const observations: ParsedObservation[] = [];

		try {
			for (const [i, batch] of batches.entries()) {
				const prompt = [
					`Bucket: ${bucket}`,
					`The "${bucket}" bucket as it stood before this dream:`,
					previousText || '(empty)',
					'',
					`Evidence batch ${i + 1} of ${batches.length}:`,
					batch,
					'',
					`Summarize what this batch says that belongs in the "${bucket}" bucket of a private model of your`,
					`owner, in plain text, at most ${BATCH_SUMMARY_CHAR_LIMIT} characters. Also propose up to 3 short`,
					'standalone observations worth remembering from this batch, each with a salience from 0 to 1.',
					'Reply with one JSON object and nothing else, no prose, no code fence:',
					'{"summary":"...","observations":[{"text":"...","salience":0.0}]}',
				].join('\n');
				const result = await this.localModel.chat({
					system: `You summarize evidence for one part of a private model of your owner. Answer with one JSON object and nothing else.`,
					user: prompt,
					json: true,
					model,
					maxTokens: 500,
				});
				const doc = parseJsonObject(result.text);
				const summary = normalizeBucketText(doc?.summary, BATCH_SUMMARY_CHAR_LIMIT);
				if (summary) batchSummaries.push(summary);
				const obsRaw = Array.isArray(doc?.observations) ? doc.observations : [];
				for (const raw of obsRaw) {
					const parsed = normalizeBatchObservation(bucket, raw);
					if (parsed) observations.push(parsed);
				}
			}

			const mergePrompt = [
				`Bucket: ${bucket}`,
				`The "${bucket}" bucket as it stood before this dream:`,
				previousText || '(empty)',
				'',
				`Summaries of ${batchSummaries.length} evidence batch(es):`,
				...(batchSummaries.length ? batchSummaries.map((s, i) => `${i + 1}. ${s}`) : ['(none)']),
				'',
				`Rewrite the "${bucket}" bucket in plain text, at most ${BUCKET_CHAR_LIMIT} characters, built only from`,
				'the summaries above and the previous bucket text. Keep what still holds, drop what is now',
				'contradicted, and add what is new. Reply with one JSON object and nothing else, no prose, no code',
				'fence: {"text":"..."}',
			].join('\n');
			const mergeResult = await this.localModel.chat({
				system: `You rewrite one part of a private model of your owner. Answer with one JSON object and nothing else.`,
				user: mergePrompt,
				json: true,
				model,
				maxTokens: 500,
			});
			const mergeDoc = parseJsonObject(mergeResult.text);
			const text = normalizeBucketText(mergeDoc?.text) || previousText;
			return { text, observations };
		} catch (e) {
			if (e instanceof LocalModelUnavailableError) {
				this.logger.warn(`Aon dream: local model unavailable while dreaming "${bucket}" (${e.message}); kept the previous text`);
				return { text: previousText, observations: [] };
			}
			throw e;
		}
	}

	/** One paid haiku turn that reasons over the five local drafts and polishes them. Null on any failure: the caller keeps the local draft. */
	private async polishWithHaiku(drafts: AonOwnerModelBuckets): Promise<AonOwnerModelBuckets | null> {
		const prompt = [
			"You keep a private model of your owner, for the assistant to read before it advises him on his life,",
			'people or projects. A local model has just drafted the five buckets below from the facts, sources and',
			'observations memory holds. Polish them: tighten the writing, resolve any awkward duplication between',
			'buckets, and fix anything that reads as clearly wrong, but do not invent facts the drafts do not',
			'already state.',
			'',
			...BUCKET_NAMES.map((bucket) => `${bucket.toUpperCase()}:\n${drafts[bucket] || '(empty)'}`),
			'',
			'Reply with one JSON object and nothing else, no prose, no code fence:',
			'{"identity":"...","people":"...","projects":"...","preferences":"...","commitments":"..."}',
			'Each bucket stays plain text, at most 1200 characters.',
		].join('\n');

		const result = await this.runner.run({
			prompt,
			systemPrompt: 'You polish a private model of the owner that a local model already drafted. Answer with one JSON object and nothing else.',
			model: 'haiku',
			allowedTools: [],
			mcpConfigPath: null,
			maxTurns: 1,
			timeoutMs: HAIKU_POLISH_TIMEOUT_MS,
			signal: new AbortController().signal,
			onEvent: () => {},
		});

		const spentEur = costEur(result.costUsd);
		if (spentEur > 0) await this.settings.addBackgroundSpend(spentEur);

		if (result.isError) {
			this.logger.warn(`Aon dream: haiku polish failed (${result.error}), €${spentEur.toFixed(4)}`);
			return null;
		}
		const doc = parseJsonObject(result.text);
		if (!doc) {
			this.logger.warn(`Aon dream: haiku polish did not return a JSON object, €${spentEur.toFixed(4)}`);
			return null;
		}
		const polished: AonOwnerModelBuckets = {
			identity: normalizeBucketText(doc.identity) || drafts.identity,
			people: normalizeBucketText(doc.people) || drafts.people,
			projects: normalizeBucketText(doc.projects) || drafts.projects,
			preferences: normalizeBucketText(doc.preferences) || drafts.preferences,
			commitments: normalizeBucketText(doc.commitments) || drafts.commitments,
		};
		return polished;
	}
}
