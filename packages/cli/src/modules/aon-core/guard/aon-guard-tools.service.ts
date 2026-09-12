import type { User } from '@n8n/db';
import { Service } from '@n8n/di';
import z from 'zod';

import type { RegisterToolFn, ToolDefinition } from '@/modules/mcp/mcp.types';

import { AonGuardService } from './aon-guard.service';
import { AON_OP_CLASSES } from './op-classes';
import { identityFromRequest } from './request-identity';

const requestSchema = {
	opClass: z
		.string()
		.min(1)
		.max(200)
		.describe(
			`One of Guard's op classes: ${AON_OP_CLASSES.map((c) => c.opClass).join(', ')}.`,
		),
	summary: z
		.string()
		.trim()
		.min(1)
		.max(300)
		.describe('One line, in plain words, for the card the owner will see.'),
} satisfies z.ZodRawShape;

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
const failure = (error: unknown) => ({
	content: [{ type: 'text' as const, text: `Guard: ${error instanceof Error ? error.message : String(error)}` }],
	isError: true,
});

/**
 * Guard's own tool: the way an agent raises a card for something its policy
 * would not let it do by itself. The owner never needs it — there is nothing
 * for the owner to ask.
 */
@Service()
export class McpAonGuardToolsService {
	constructor(private readonly guard: AonGuardService) {}

	registerTools(registerIfAllowed: RegisterToolFn, user: User) {
		const request: ToolDefinition<typeof requestSchema> = {
			name: 'guard_request',
			config: {
				description:
					'Ask the owner for a yes on one effect Guard would not allow by itself. Raises a card and returns; it never waits for the decision, so stop and report that you are waiting once you call this.',
				inputSchema: requestSchema,
				annotations: { title: 'Ask Guard', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			},
			handler: async (args, extra) => {
				try {
					const identity = identityFromRequest(extra, user);
					if (identity.kind === 'owner') {
						return text('You are the owner; nothing to ask.');
					}
					const known = AON_OP_CLASSES.find((c) => c.opClass === args.opClass);
					if (!known) {
						return {
							content: [{ type: 'text', text: `Guard does not know the op class "${args.opClass}".` }],
							isError: true,
						};
					}
					const approval = await this.guard.requestApproval(identity, known.opClass, args.summary);
					return text(
						`Guard raised card ${approval.id} for ${known.opClass}: ${args.summary}. Stop now and wait for the owner's decision.`,
					);
				} catch (error) {
					return failure(error);
				}
			},
		};

		registerIfAllowed(request);
	}
}
