import type { AonGuardIdentity, AonThreadSummary, AonTurn } from '@n8n/api-types';
import type { User } from '@n8n/db';
import { Service } from '@n8n/di';
import z from 'zod';

import type { RegisterToolFn, ToolDefinition } from '@/modules/mcp/mcp.types';

import { AonThreadRepository } from './database/repositories/aon-thread.repository';
import { AonGuardService } from './guard/aon-guard.service';
import { AON_OP_CLASSES } from './guard/op-classes';
import { identityFromRequest } from './guard/request-identity';

const TURNS_MAX = 50;

const threadsSchema = {
	limit: z.number().int().min(1).max(100).optional().describe('Default 20.'),
} satisfies z.ZodRawShape;

const threadSchema = {
	id: z.string().min(1).max(100),
	turns: z.number().int().min(1).max(TURNS_MAX).optional().describe(`How many of its most recent turns to show; up to ${TURNS_MAX}, default ${TURNS_MAX}.`),
} satisfies z.ZodRawShape;

const renameSchema = {
	id: z.string().min(1).max(100),
	title: z.string().trim().min(1).max(120),
} satisfies z.ZodRawShape;

const deleteSchema = {
	id: z.string().min(1).max(100),
} satisfies z.ZodRawShape;

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
const failure = (error: unknown) => ({
	content: [{ type: 'text' as const, text: `Aon threads: ${error instanceof Error ? error.message : String(error)}` }],
	isError: true,
});
const ownerOnly = () => ({ content: [{ type: 'text' as const, text: 'Only the owner reads or changes conversations.' }], isError: true });

function threadLine(t: AonThreadSummary): string {
	return `- [${t.id}] ${t.title ?? '(untitled)'}, ${t.turnCount} turn(s), last ${t.lastTurnAt ?? t.createdAt}${t.preview ? `\n  ${t.preview}` : ''}`;
}

function turnLine(t: AonTurn): string {
	const tools = t.tools?.length ? ` [tools: ${t.tools.map((tool) => `${tool.name} ${tool.status}`).join(', ')}]` : '';
	return `${t.role} (${t.createdAt}): ${t.text}${tools}`;
}

/**
 * The assistant's saved conversations as tools: list, open, rename, forget.
 * Conversations are the owner's own — never an agent's — so every tool here
 * refuses a non-owner identity outright, the same as Guard's own tools.
 */
@Service()
export class McpAonThreadsToolsService {
	constructor(
		private readonly threads: AonThreadRepository,
		private readonly guard: AonGuardService,
	) {}

	private guardLabel(opClass: string): string {
		return AON_OP_CLASSES.find((c) => c.opClass === opClass)?.label ?? opClass;
	}

	/** Guard's verdict for one call: `deny` refuses, `ask` raises a card and returns the stop-and-wait text; `allow` records and returns null so the handler proceeds. */
	private async guarded(
		identity: AonGuardIdentity,
		toolName: string,
		args: Record<string, unknown>,
		summary: string,
	): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean } | null> {
		const decision = await this.guard.decideTool(identity, toolName, args);
		if (decision.verdict === 'deny') {
			await this.guard.record(identity, decision.opClass, 'deny', args);
			return { content: [{ type: 'text', text: `Guard denies this: ${this.guardLabel(decision.opClass)}` }], isError: true };
		}
		if (decision.verdict === 'ask') {
			const approval = await this.guard.requestApproval(identity, decision.opClass, summary, args);
			return text(`Guard needs the owner's yes: card ${approval.id} raised. Stop now and wait.`);
		}
		await this.guard.record(identity, decision.opClass, 'allow', args);
		return null;
	}

	registerTools(registerIfAllowed: RegisterToolFn, user: User) {
		const threadsList: ToolDefinition<typeof threadsSchema> = {
			name: 'aon_threads',
			config: {
				description: "The owner's saved conversations, most recently active first. Only the owner reads the list.",
				inputSchema: threadsSchema,
				annotations: { title: 'List conversations', readOnlyHint: true },
			},
			handler: async (args, extra) => {
				try {
					const identity = identityFromRequest(extra, user);
					if (identity.kind !== 'owner') return ownerOnly();
					const rows = await this.threads.listForUser(user.id);
					const limited = rows.slice(0, args.limit ?? 20);
					if (limited.length === 0) return text('No saved conversations yet.');
					return text(limited.map(threadLine).join('\n'));
				} catch (error) {
					return failure(error);
				}
			},
		};

		const threadGet: ToolDefinition<typeof threadSchema> = {
			name: 'aon_thread',
			config: {
				description: 'One conversation: its title and its most recent turns. Only the owner reads a conversation.',
				inputSchema: threadSchema,
				annotations: { title: 'Read a conversation', readOnlyHint: true },
			},
			handler: async (args, extra) => {
				try {
					const identity = identityFromRequest(extra, user);
					if (identity.kind !== 'owner') return ownerOnly();
					const detail = await this.threads.findDetail(args.id, user.id);
					if (!detail) return text('There is no conversation with that id.');
					const wanted = Math.min(args.turns ?? TURNS_MAX, TURNS_MAX);
					const shown = detail.turns.slice(-wanted);
					const header = `${detail.title ?? '(untitled)'} (${detail.id}), ${detail.turnCount} turn(s) total`;
					return text(`${header}\n\n${shown.map(turnLine).join('\n\n') || '(no turns)'}`);
				} catch (error) {
					return failure(error);
				}
			},
		};

		const rename: ToolDefinition<typeof renameSchema> = {
			name: 'aon_thread_rename',
			config: {
				description: 'Renames a saved conversation. Only the owner renames one.',
				inputSchema: renameSchema,
				annotations: { title: 'Rename a conversation', readOnlyHint: false, destructiveHint: false },
			},
			handler: async (args, extra) => {
				try {
					const identity = identityFromRequest(extra, user);
					if (identity.kind !== 'owner') return ownerOnly();
					const blocked = await this.guarded(identity, 'aon_thread_rename', args, `Rename conversation ${args.id} to "${args.title}".`);
					if (blocked) return blocked;
					const summary = await this.threads.rename(args.id, user.id, args.title);
					if (!summary) return text('There is no conversation with that id.');
					return text(`Renamed to "${summary.title}".`);
				} catch (error) {
					return failure(error);
				}
			},
		};

		const remove: ToolDefinition<typeof deleteSchema> = {
			name: 'aon_thread_delete',
			config: {
				description: 'Forgets a saved conversation, for good. Only the owner deletes one.',
				inputSchema: deleteSchema,
				annotations: { title: 'Delete a conversation', readOnlyHint: false, destructiveHint: true },
			},
			handler: async (args, extra) => {
				try {
					const identity = identityFromRequest(extra, user);
					if (identity.kind !== 'owner') return ownerOnly();
					const blocked = await this.guarded(identity, 'aon_thread_delete', args, `Delete conversation ${args.id}.`);
					if (blocked) return blocked;
					const removed = await this.threads.deleteForUser(args.id, user.id);
					if (!removed) return text('There is no conversation with that id.');
					return text(`Deleted conversation ${args.id}.`);
				} catch (error) {
					return failure(error);
				}
			},
		};

		registerIfAllowed(threadsList);
		registerIfAllowed(threadGet);
		registerIfAllowed(rename);
		registerIfAllowed(remove);
	}
}
