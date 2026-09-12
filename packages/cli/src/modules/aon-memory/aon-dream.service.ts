import type { AonFactSummary, AonObservationSummary, AonOwnerModel, AonOwnerModelBuckets } from '@n8n/api-types';
import { Logger } from '@n8n/backend-common';
import { Service } from '@n8n/di';

import { AonRunnerService } from '@/modules/aon-agents/executor/aon-runner.service';
import { costEur } from '@/modules/aon-agents/executor/run-machine';

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
const DREAM_TIMEOUT_MS = 5 * 60_000;
const CONFIRMED_FACTS_LIMIT = 2000;
const PENDING_FACTS_LIMIT = 60;
const RECENT_SOURCES_LIMIT = 40;
const OBSERVATIONS_LIMIT = 200;
/** Each bucket of the model of the owner is at most this many characters. */
const BUCKET_CHAR_LIMIT = 1200;

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

interface ParsedDream {
	identity: unknown;
	people: unknown;
	projects: unknown;
	preferences: unknown;
	commitments: unknown;
	observations: ParsedObservation[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isString(value: unknown): value is string {
	return typeof value === 'string';
}

/** A bucket's text may come back as a string or a list of lines; either way it is capped at the budget. */
function normalizeBucketText(raw: unknown): string {
	const value = isString(raw) ? raw : Array.isArray(raw) ? raw.filter(isString).join('\n') : '';
	return value.trim().slice(0, BUCKET_CHAR_LIMIT);
}

function normalizeObservation(raw: unknown): ParsedObservation | null {
	if (!isRecord(raw)) return null;
	const bucket = isString(raw.bucket) ? raw.bucket.trim().toLowerCase().slice(0, 40) : '';
	const text = isString(raw.text) ? raw.text.trim() : '';
	if (!bucket || !text) return null;
	const salience =
		typeof raw.salience === 'number' && Number.isFinite(raw.salience)
			? Math.min(1, Math.max(0, raw.salience))
			: 0.5;
	return { bucket, text: text.slice(0, 400), salience };
}

/** Unparseable, or not a JSON object, is nothing dreamed — never an error. */
function parseDream(text: string | null | undefined): ParsedDream | null {
	const raw = String(text ?? '').trim();
	const start = raw.indexOf('{');
	const end = raw.lastIndexOf('}');
	if (start < 0 || end <= start) return null;
	let doc: unknown;
	try {
		doc = JSON.parse(raw.slice(start, end + 1));
	} catch {
		return null;
	}
	if (!isRecord(doc)) return null;
	const observations = Array.isArray(doc.observations)
		? doc.observations.map(normalizeObservation).filter((o): o is ParsedObservation => o !== null)
		: [];
	return {
		identity: doc.identity,
		people: doc.people,
		projects: doc.projects,
		preferences: doc.preferences,
		commitments: doc.commitments,
		observations,
	};
}

function factLine(f: AonFactSummary): string {
	return `- ${f.subject} ${f.predicate} ${f.object}${f.status === 'pending' ? ' (pending)' : ''}`;
}

function sourceLine(s: AonRecentSourceRow): string {
	const when = s.docTime ?? s.createdAt;
	return `- [${s.origin}] ${s.title}${when ? ` (${new Date(when).toISOString().slice(0, 10)})` : ''}`;
}

function observationLine(o: AonObservationSummary): string {
	return `- (${o.bucket}, salience ${o.salience.toFixed(2)}) ${o.text}`;
}

function buildPrompt(input: {
	confirmed: AonFactSummary[];
	pending: AonFactSummary[];
	recentSources: AonRecentSourceRow[];
	observations: AonObservationSummary[];
	previousModel: AonOwnerModel | null;
}): string {
	const prevLines = input.previousModel
		? BUCKET_NAMES.map((bucket) => `${bucket.toUpperCase()}:\n${input.previousModel!.buckets[bucket] || '(empty)'}`)
		: ['(no previous model yet)'];

	return [
		"You keep a private model of your owner, for the assistant to read before it advises him on his life, people or projects.",
		'',
		`Confirmed facts (${input.confirmed.length}):`,
		input.confirmed.length ? input.confirmed.map(factLine).join('\n') : '(none)',
		'',
		`Pending facts, most recent first (${input.pending.length}):`,
		input.pending.length ? input.pending.map(factLine).join('\n') : '(none)',
		'',
		`Sources read most recently (${input.recentSources.length}):`,
		input.recentSources.length ? input.recentSources.map(sourceLine).join('\n') : '(none)',
		'',
		`Observations already held (${input.observations.length}):`,
		input.observations.length ? input.observations.map(observationLine).join('\n') : '(none)',
		'',
		'The model of him as it stood before this dream:',
		...prevLines,
		'',
		'Rewrite the model of him in five buckets: identity (who he is, his roles and traits), people (who matters',
		'to him and how), projects (what he is building or running), preferences (how he likes things done), and',
		'commitments (what he owes, has promised, or has coming up). Each bucket is plain text, at most 1200',
		'characters, built only from the facts, sources and observations above, never invented. Keep what still',
		'holds from the previous model, drop what the facts now contradict, and add what is new.',
		'',
		'Also propose observations: short standalone notes worth remembering, each with the bucket it belongs in',
		'(identity, people, projects, preferences or commitments) and a salience from 0 to 1.',
		'',
		'Reply with one JSON object and nothing else, no prose, no code fence:',
		'{"identity":"...","people":"...","projects":"...","preferences":"...","commitments":"...",',
		' "observations":[{"bucket":"...","text":"...","salience":0.0}]}',
		'If nothing has changed, still return the buckets as they stand, with an empty observations list.',
	].join('\n');
}

function sameCalendarDay(a: Date, b: Date): boolean {
	return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * The nightly dream: once a day, at 03:30 instance time, it rereads the
 * facts, the newest sources and the observations, and rewrites the model of
 * the owner in five buckets. Runs through one sonnet turn, within the same
 * monthly budget as extraction, and is skipped entirely when there is no
 * signed-in Claude session to run it with. `runNow` also serves the owner's
 * "Dream now" button, sharing the same skip rules.
 */
@Service()
export class AonDreamService {
	private running = false;

	constructor(
		private readonly facts: AonFactRepository,
		private readonly sources: AonSourceRepository,
		private readonly observations: AonObservationRepository,
		private readonly capture: AonCaptureService,
		private readonly runner: AonRunnerService,
		private readonly settings: AonSettingsService,
		private readonly logger: Logger,
	) {}

	start(): void {
		setInterval(() => void this.tick(), CHECK_INTERVAL_MS).unref();
	}

	async tick(): Promise<void> {
		if (this.running) return;
		if (!process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return;
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

	/** `manual` is the owner's "Dream now" button; `schedule` is the daily tick. Both share the budget check. */
	async runNow(trigger: 'manual' | 'schedule'): Promise<AonDreamOutcome> {
		if (this.running) return { ran: false, message: 'A dream is already running.' };
		if (!process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
			return { ran: false, message: 'No Claude session is signed in, so there is nothing to dream with.' };
		}
		this.running = true;
		try {
			const budget = await this.settings.extractBudgetEurMonth();
			const spent = await this.settings.extractSpentEurThisMonth();
			if (spent >= budget) {
				return {
					ran: false,
					message: `This month's extraction budget (€${budget.toFixed(2)}) is already spent.`,
				};
			}
			const outcome = await this.dreamOnce(trigger);
			await this.settings.setDreamLastRunAt(new Date());
			return outcome;
		} finally {
			this.running = false;
		}
	}

	private async dreamOnce(trigger: 'manual' | 'schedule'): Promise<AonDreamOutcome> {
		const [confirmed, pending, recentSources, observations, previousModel] = await Promise.all([
			this.facts.list({ status: 'confirmed', limit: CONFIRMED_FACTS_LIMIT, offset: 0 }),
			this.facts.list({ status: 'pending', limit: PENDING_FACTS_LIMIT, offset: 0 }),
			this.sources.listRecentTitles(RECENT_SOURCES_LIMIT),
			this.observations.list(OBSERVATIONS_LIMIT),
			this.settings.modelOfOwner(),
		]);

		const prompt = buildPrompt({
			confirmed: confirmed.items,
			pending: pending.items,
			recentSources,
			observations,
			previousModel,
		});

		const result = await this.runner.run({
			prompt,
			systemPrompt: 'You build a private model of your owner from what memory holds. Answer with one JSON object and nothing else.',
			model: 'sonnet',
			allowedTools: [],
			mcpConfigPath: null,
			maxTurns: 1,
			timeoutMs: DREAM_TIMEOUT_MS,
			signal: new AbortController().signal,
			onEvent: () => {},
		});

		const spentEur = costEur(result.costUsd);
		if (spentEur > 0) await this.settings.addExtractSpend(spentEur);

		if (result.isError) {
			this.logger.warn(`Aon dream: model turn failed (${result.error}), €${spentEur.toFixed(4)} (${trigger})`);
			return { ran: false, message: `The dream failed: ${result.error ?? 'the model turn did not complete'}.` };
		}

		const parsed = parseDream(result.text);
		if (!parsed) {
			this.logger.warn(`Aon dream: could not parse a model from the reply, €${spentEur.toFixed(4)} (${trigger})`);
			return { ran: false, message: 'The dream ran but did not return a usable model this time.' };
		}

		const buckets: AonOwnerModelBuckets = {
			identity: normalizeBucketText(parsed.identity),
			people: normalizeBucketText(parsed.people),
			projects: normalizeBucketText(parsed.projects),
			preferences: normalizeBucketText(parsed.preferences),
			commitments: normalizeBucketText(parsed.commitments),
		};

		const document = BUCKET_NAMES.map((bucket) => `${bucket.toUpperCase()}\n${buckets[bucket] || '(empty)'}`).join(
			'\n\n',
		);
		await this.capture.captureModel(document);

		const now = new Date();
		const totalFacts = confirmed.total + pending.total;
		const model: AonOwnerModel = {
			updatedAt: now.toISOString(),
			buckets,
			sources: recentSources.length,
			facts: totalFacts,
		};
		await this.settings.setModelOfOwner(model);

		let added = 0;
		for (const o of parsed.observations) {
			await this.observations.upsertObservation(o);
			added += 1;
		}

		this.logger.info(
			`Aon dream: model of the owner rebuilt (${totalFacts} fact(s), ${recentSources.length} source(s), ` +
				`${added} observation(s)), €${spentEur.toFixed(4)} (${trigger})`,
		);
		return {
			ran: true,
			message: `The model of you was rebuilt from ${totalFacts} fact(s) and ${added} observation(s).`,
			model,
		};
	}
}
