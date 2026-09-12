/**
 * aon-judge.ts: the definition-of-done judge.
 *
 * A second model, never the maker's, reads the maker's output against the
 * DoD in the owner's words and answers JSON only: { met, critique, evidence }.
 * It runs with no MCP and no tools, so it can only read what it was given.
 * An answer that does not parse is 'unknown', never a pass: a judge that
 * could not answer must not look like a judge that said yes.
 *
 * A faithful (exact) port of aon-os's judge.mjs prompt and reply parser.
 */

// The judge sees the inputs too, so it can say whether the output reflects
// them, but each is capped harder than the maker's copy: it grades, it does
// not rewrite.
const JUDGE_INPUT_MAX_CHARS = 6_000;
const OUTPUT_MAX_CHARS = 24_000;

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

export interface JudgeInput {
	id: string;
	label?: string | null;
	text?: string | null;
}

export interface JudgePromptArgs {
	dod: string | null | undefined;
	output: string | null | undefined;
	inputs: readonly JudgeInput[] | null | undefined;
	today?: Date;
}

export function judgePrompt({
	dod,
	output,
	inputs,
	today = new Date(),
}: JudgePromptArgs): { systemPrompt: string; prompt: string } {
	const blocks = (inputs ?? []).map((i) => {
		const body = String(i.text ?? '');
		const shown =
			body.length > JUDGE_INPUT_MAX_CHARS ? `${body.slice(0, JUDGE_INPUT_MAX_CHARS)}\n(truncated)` : body;
		return `## [${i.id}] ${i.label ?? i.id}\n${shown.trim() || '(empty)'}`;
	});
	const out = String(output ?? '');
	const shownOut = out.length > OUTPUT_MAX_CHARS ? `${out.slice(0, OUTPUT_MAX_CHARS)}\n(truncated)` : out;
	const prompt = [
		`Today is ${isoDate(today)}.`,
		'You are the judge of one deliverable. Grade the OUTPUT against the DEFINITION OF DONE and nothing else:',
		'not style, not length, not what you would have written. "Met" means a careful reader would agree every',
		'part of the definition is satisfied by what is actually on the page, using only the INPUTS below as the',
		'truth. A figure the output states that the inputs do not support is a reason to say not met.',
		'',
		'# Definition of done',
		String(dod ?? '').trim() || '(none written)',
		'',
		'# Inputs the maker was handed',
		blocks.length ? blocks.join('\n\n') : '(none)',
		'',
		'# Output to grade',
		shownOut.trim() || '(empty output)',
		'',
		'# Reply',
		'JSON only, no prose before or after, no code fence:',
		'{"met": true or false, "critique": "what is missing or wrong, in two or three sentences; empty if met", "evidence": "the lines of the output that satisfy or fail the definition"}',
	].join('\n');
	return {
		systemPrompt: 'You are a strict, fair judge. You answer with one JSON object and nothing else.',
		prompt,
	};
}

export type JudgeStatus = 'pass' | 'fail' | 'unknown';

export interface JudgeVerdict {
	met: boolean | null;
	critique: string;
	evidence: string;
	status: JudgeStatus;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/** Read the judge's reply. Unparseable is unknown, never pass. */
export function parseJudgeReply(text: string | null | undefined): JudgeVerdict {
	const raw = String(text ?? '').trim();
	const start = raw.indexOf('{');
	const end = raw.lastIndexOf('}');
	if (start < 0 || end <= start) {
		return {
			met: null,
			critique: raw ? `the judge did not answer in JSON: ${raw.slice(0, 200)}` : 'the judge gave no answer',
			evidence: '',
			status: 'unknown',
		};
	}
	let doc: unknown;
	try {
		doc = JSON.parse(raw.slice(start, end + 1));
	} catch {
		return {
			met: null,
			critique: `the judge's JSON did not parse: ${raw.slice(0, 200)}`,
			evidence: '',
			status: 'unknown',
		};
	}
	const record = isRecord(doc) ? doc : {};
	if (typeof record.met !== 'boolean') {
		return {
			met: null,
			critique: 'the judge answered without a true or false verdict',
			evidence: typeof record.evidence === 'string' ? record.evidence : '',
			status: 'unknown',
		};
	}
	return {
		met: record.met,
		critique: typeof record.critique === 'string' ? record.critique.slice(0, 4000) : '',
		evidence: typeof record.evidence === 'string' ? record.evidence.slice(0, 4000) : '',
		status: record.met ? 'pass' : 'fail',
	};
}
