import type { AonTurnTool } from '@n8n/api-types';
import type { ChatUI } from '@n8n/design-system';

/**
 * Tool calls ride the chat's `custom` message type (its `data` is `unknown`
 * by design, so any consumer can put its own shape there) and are rendered
 * through the `custom-message` slot, in `AonToolCard.vue`. Kept apart from
 * the "block" rows the window used before, which could only hold a title
 * and a content string — not enough room for the input, the result and the
 * timing this window now wants to show.
 */
export const AON_TOOL_CUSTOM_TYPE = 'aon-tool';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isToolStatus(value: unknown): value is AonTurnTool['status'] {
	return value === 'start' || value === 'ok' || value === 'error';
}

/** Narrows a custom message's `data: unknown` back to the tool it was built from. */
export function toAonTurnTool(data: unknown): AonTurnTool | null {
	if (!isRecord(data)) return null;
	if (typeof data.id !== 'string' || typeof data.name !== 'string' || !isToolStatus(data.status)) {
		return null;
	}
	return {
		id: data.id,
		name: data.name,
		status: data.status,
		input: typeof data.input === 'string' ? data.input : undefined,
		result: typeof data.result === 'string' ? data.result : undefined,
		isError: typeof data.isError === 'boolean' ? data.isError : undefined,
		ms: typeof data.ms === 'number' ? data.ms : undefined,
	};
}

/** One tool call's row, as the chat's message list wants it. */
export function makeAonToolMessage(
	id: string,
	tool: AonTurnTool,
): ChatUI.CustomMessage & { id: string } {
	return {
		id,
		role: 'assistant',
		type: 'custom',
		customType: AON_TOOL_CUSTOM_TYPE,
		data: tool,
	};
}
