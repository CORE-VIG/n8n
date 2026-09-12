import type { User } from '@n8n/db';
import { Service } from '@n8n/di';
import z from 'zod';

import { identityFromRequest } from '@/modules/aon-core/guard/request-identity';
import type { RegisterToolFn, ToolDefinition } from '@/modules/mcp/mcp.types';

import { AonToolboxService } from './aon-toolbox.service';

const toolboxSchema = {
	q: z.string().max(200).optional().describe('Words to search by name, tag or summary. Empty lists everything live.'),
	kind: z.enum(['skill', 'script', 'mcp', 'cli']).optional().describe('Restrict to one kind. Every tool here is a skill today.'),
	limit: z.number().int().min(1).max(200).optional().describe('Default 50.'),
} satisfies z.ZodRawShape;

const toolUsedSchema = {
	slug: z.string().min(1).max(100).describe('The tool\'s slug, from aon_toolbox.'),
} satisfies z.ZodRawShape;

const rescanSchema = {} satisfies z.ZodRawShape;

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
const failure = (error: unknown) => ({
	content: [{ type: 'text' as const, text: `Toolbox: ${error instanceof Error ? error.message : String(error)}` }],
	isError: true,
});
const ownerOnly = () => ({ content: [{ type: 'text' as const, text: 'Only the owner rescans the toolbox.' }], isError: true });

/**
 * The toolbox as tools: what Aon can reach for but does not contain. A read
 * any identity may use, a use-counter any identity may bump, and a rescan
 * of the skills on disk — owner only, since it touches the catalogue.
 */
@Service()
export class McpAonToolboxToolsService {
	constructor(private readonly toolbox: AonToolboxService) {}

	registerTools(registerIfAllowed: RegisterToolFn, user: User) {
		const toolboxGet: ToolDefinition<typeof toolboxSchema> = {
			name: 'aon_toolbox',
			config: {
				description:
					'Search the toolbox: skills, scripts, MCP servers and CLIs Aon can reach for but does not contain. Returns the best matches, live tools first.',
				inputSchema: toolboxSchema,
				annotations: { title: 'Search the toolbox', readOnlyHint: true },
			},
			handler: async (args) => {
				try {
					const list = await this.toolbox.list({ q: args.q, kind: args.kind, limit: args.limit });
					if (list.empty) return text(list.empty);
					if (list.items.length === 0) return text(`Nothing in the toolbox matches "${args.q ?? ''}".`);
					return text(list.items.map((t) => `- ${t.line}`).join('\n'));
				} catch (error) {
					return failure(error);
				}
			},
		};

		const toolUsed: ToolDefinition<typeof toolUsedSchema> = {
			name: 'aon_tool_used',
			config: {
				description: 'Records that a tool from the toolbox was reached for. Bumps its use count; nothing else changes.',
				inputSchema: toolUsedSchema,
				annotations: { title: 'Record toolbox use', readOnlyHint: false, destructiveHint: false },
			},
			handler: async (args, extra) => {
				try {
					const identity = identityFromRequest(extra, user);
					const item = await this.toolbox.recordUse(args.slug, identity.name);
					if (!item) return { content: [{ type: 'text' as const, text: `No such tool: "${args.slug}".` }], isError: true };
					return text(`Noted. ${item.name} has been reached for ${item.uses} ${item.uses === 1 ? 'time' : 'times'}.`);
				} catch (error) {
					return failure(error);
				}
			},
		};

		const rescan: ToolDefinition<typeof rescanSchema> = {
			name: 'aon_toolbox_rescan',
			config: {
				description: "Rescans this host's skill folders and reconciles the toolbox: new skills are added, changed ones updated, vanished ones marked away. Owner only.",
				inputSchema: rescanSchema,
				annotations: { title: 'Rescan the toolbox', readOnlyHint: true },
			},
			handler: async (_args, extra) => {
				try {
					const identity = identityFromRequest(extra, user);
					if (identity.kind !== 'owner') return ownerOnly();
					const result = await this.toolbox.rescan();
					return text(result.words);
				} catch (error) {
					return failure(error);
				}
			},
		};

		registerIfAllowed(toolboxGet);
		registerIfAllowed(toolUsed);
		registerIfAllowed(rescan);
	}
}
