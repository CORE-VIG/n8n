/**
 * Reading a tool's result text back apart: pretty-printing it when it is
 * JSON, pulling a per-node breakdown out of a workflow execution, and
 * finding the workflow + execution id pair an "Open execution" link needs.
 * Kept free of the window's own types so it can be tested on its own.
 */

interface JsonParsed {
	ok: true;
	value: unknown;
}
interface JsonNotParsed {
	ok: false;
}
type JsonParseResult = JsonParsed | JsonNotParsed;

function parseJson(text: string): JsonParseResult {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch {
		return { ok: false };
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function prettyJson(value: unknown): string {
	try {
		const printed = JSON.stringify(value, null, 2);
		return printed ?? String(value);
	} catch {
		return String(value);
	}
}

/** The result, pretty-printed when it parses as JSON; the raw text otherwise. */
export function formatToolResult(result: string): string {
	const parsed = parseJson(result);
	return parsed.ok ? prettyJson(parsed.value) : result;
}

export interface AonToolNodeOutput {
	name: string;
	itemCount: number | null;
	firstItem: string | null;
	errorMessage: string | null;
}

function mainBranch(taskData: Record<string, unknown>): unknown[] | null {
	const data = taskData.data;
	if (!isRecord(data)) return null;
	const main = data.main;
	if (!Array.isArray(main)) return null;
	const branch = main[0];
	return Array.isArray(branch) ? branch : null;
}

function taskErrorMessage(taskData: Record<string, unknown>): string | null {
	const error = taskData.error;
	if (!isRecord(error)) return null;
	return typeof error.message === 'string' ? error.message : null;
}

/**
 * A `get_workflow_execution` result carries `data.resultData.runData`, one
 * entry per node, each a list of tasks (retries included) whose last entry
 * is the one that matters. Anything else — a `test_workflow` result, an
 * error object, plain text — has no such shape, so this returns null and
 * the card falls back to the plain snippet.
 */
export function nodeOutputsFromResult(result: string): AonToolNodeOutput[] | null {
	const parsed = parseJson(result);
	if (!parsed.ok || !isRecord(parsed.value)) return null;
	const data = parsed.value.data;
	if (!isRecord(data)) return null;
	const resultData = data.resultData;
	if (!isRecord(resultData)) return null;
	const runData = resultData.runData;
	if (!isRecord(runData)) return null;

	const outputs: AonToolNodeOutput[] = [];
	for (const [name, tasks] of Object.entries(runData)) {
		if (!Array.isArray(tasks) || tasks.length === 0) continue;
		const last = tasks[tasks.length - 1];
		if (!isRecord(last)) continue;
		const branch = mainBranch(last);
		outputs.push({
			name,
			itemCount: branch ? branch.length : null,
			firstItem: branch && branch.length > 0 ? prettyJson(branch[0]) : null,
			errorMessage: taskErrorMessage(last),
		});
	}
	return outputs.length > 0 ? outputs : null;
}

export interface AonToolExecutionLink {
	workflowId: string;
	executionId: string;
}

function stringField(value: unknown, field: string): string | null {
	if (!isRecord(value)) return null;
	const found = value[field];
	return typeof found === 'string' ? found : null;
}

/**
 * The workflow + execution id pair, however the tool happened to carry
 * them: `get_workflow_execution`'s result nests both under `execution`;
 * `test_workflow`'s result has only the execution id, with the workflow id
 * back in the call's own input instead.
 */
export function executionLinkFrom(result: string, input: string | undefined): AonToolExecutionLink | null {
	const parsedResult = parseJson(result);
	const resultValue = parsedResult.ok ? parsedResult.value : null;
	const execution = isRecord(resultValue) ? resultValue.execution : null;

	const executionId = stringField(resultValue, 'executionId') ?? stringField(execution, 'id');
	if (!executionId) return null;

	const parsedInput = input === undefined ? null : parseJson(input);
	const inputValue = parsedInput && parsedInput.ok ? parsedInput.value : null;
	const workflowId =
		stringField(resultValue, 'workflowId') ??
		stringField(execution, 'workflowId') ??
		stringField(inputValue, 'workflowId');
	if (!workflowId) return null;

	return { workflowId, executionId };
}
