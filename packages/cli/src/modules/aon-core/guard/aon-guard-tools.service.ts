import type { AonCouncilClassView, AonGuardApproval, AonGuardPolicy } from '@n8n/api-types';
import type { User } from '@n8n/db';
import { Service } from '@n8n/di';
import z from 'zod';

import type { RegisterToolFn, ToolDefinition } from '@/modules/mcp/mcp.types';

import { AonGuardPolicyRepository } from '../database/repositories/aon-guard-policy.repository';

import { AonGuardService } from './aon-guard.service';
import { AonCouncilService } from './council/aon-council.service';
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

const cardsSchema = {
	status: z
		.enum(['pending', 'approved', 'denied', 'expired', 'used'])
		.optional()
		.describe('Omit for every status.'),
	limit: z.number().int().min(1).max(50).optional().describe('Default 20.'),
} satisfies z.ZodRawShape;

const decideSchema = {
	cardId: z.string().min(1).max(100).describe('The card to decide.'),
	decision: z.enum(['approve', 'deny']),
	note: z.string().max(2000).optional(),
} satisfies z.ZodRawShape;

const overviewSchema = {} satisfies z.ZodRawShape;
const councilSchema = {} satisfies z.ZodRawShape;

const IDENTITY_RE = /^(\*|owner|agent:[a-z0-9._-]+)$/;

const policySetSchema = {
	identity: z.string().regex(IDENTITY_RE, 'identity must be "*", "owner", or "agent:<slug>"'),
	opClass: z
		.string()
		.min(1)
		.max(200)
		.describe(`One of Guard's op classes: ${AON_OP_CLASSES.map((c) => c.opClass).join(', ')}.`),
	verdict: z.enum(['allow', 'ask', 'deny', 'council']),
	note: z.string().trim().max(500).optional(),
} satisfies z.ZodRawShape;

const policyDeleteSchema = {
	id: z.string().min(1).max(100).describe('The policy row to remove.'),
} satisfies z.ZodRawShape;

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
const failure = (error: unknown) => ({
	content: [{ type: 'text' as const, text: `Guard: ${error instanceof Error ? error.message : String(error)}` }],
	isError: true,
});

function cardLine(c: AonGuardApproval): string {
	return `- [${c.id}] ${c.identity} — ${c.opClass} (${c.status}), tier ${c.tier}: ${c.summary}${c.runId ? ` (run ${c.runId})` : ''}, raised ${c.createdAt}, expires ${c.expiresAt}${c.decidedBy ? `, decided by ${c.decidedBy}` : ''}`;
}

function policyLine(p: AonGuardPolicy): string {
	return `- [${p.id}] ${p.identity} — ${p.opClass}: ${p.verdict}${p.note ? ` (${p.note})` : ''}`;
}

function councilLine(c: AonCouncilClassView): string {
	return `- ${c.opClass}: ${c.live ? 'live' : 'shadow'}${c.shadowOnly ? ', pinned to shadow' : ''}, ${c.rulings} ruling(s), ${c.decided} decided, ${c.agreement} agreed, ${c.falseApprovals} false approval(s)${c.blocker ? ` — ${c.blocker}` : ''}${c.lastRulingAt ? `, last ${c.lastRulingAt}` : ''}`;
}

/**
 * Guard's own tool: the way an agent raises a card for something its policy
 * would not let it do by itself. The owner never needs it — there is nothing
 * for the owner to ask.
 */
@Service()
export class McpAonGuardToolsService {
	constructor(
		private readonly guard: AonGuardService,
		private readonly policies: AonGuardPolicyRepository,
		private readonly council: AonCouncilService,
	) {}

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

		const cardsList: ToolDefinition<typeof cardsSchema> = {
			name: 'guard_cards',
			config: {
				description: 'Cards Guard has raised: pending, approved, denied, expired or used. Filter by status.',
				inputSchema: cardsSchema,
				annotations: { title: 'List Guard cards', readOnlyHint: true },
			},
			handler: async (args) => {
				try {
					const cards = await this.guard.listCards(args.status, args.limit ?? 20);
					if (cards.length === 0) return text('No cards match that.');
					return text(cards.map(cardLine).join('\n'));
				} catch (error) {
					return failure(error);
				}
			},
		};

		const decide: ToolDefinition<typeof decideSchema> = {
			name: 'guard_decide',
			config: {
				description:
					"Approve or deny a pending Guard card, as the owner. Only the owner decides cards; an agent that calls this is refused.",
				inputSchema: decideSchema,
				annotations: { title: 'Decide a Guard card', readOnlyHint: false, destructiveHint: false },
			},
			handler: async (args, extra) => {
				try {
					const identity = identityFromRequest(extra, user);
					if (identity.kind !== 'owner') {
						return {
							content: [{ type: 'text', text: 'Only the owner decides cards.' }],
							isError: true,
						};
					}
					const decided = await this.guard.decideApproval(
						args.cardId,
						args.decision === 'approve' ? 'approved' : 'denied',
						user.email,
					);
					if (args.note) {
						await this.guard.record(identity, decided.opClass, decided.status, { note: args.note }, decided.id);
					}
					return text(`Card ${decided.id} (${decided.opClass}) is now ${decided.status}.`);
				} catch (error) {
					return failure(error);
				}
			},
		};

		const overview: ToolDefinition<typeof overviewSchema> = {
			name: 'guard_overview',
			config: {
				description: 'The Guard page in one call: cards waiting for the owner, every standing policy, the op class catalogue, and the last 50 audit events.',
				inputSchema: overviewSchema,
				annotations: { title: 'Guard overview', readOnlyHint: true },
			},
			handler: async () => {
				try {
					const result = await this.guard.overview();
					const sections = [
						result.pending.length ? `Pending cards:\n${result.pending.map(cardLine).join('\n')}` : 'No cards are pending.',
						result.policies.length ? `Policies:\n${result.policies.map(policyLine).join('\n')}` : 'No standing policies.',
						`${result.recent.length} recent event(s).`,
					];
					return text(sections.join('\n\n'));
				} catch (error) {
					return failure(error);
				}
			},
		};

		const policySet: ToolDefinition<typeof policySetSchema> = {
			name: 'guard_policy_set',
			config: {
				description:
					'Sets a standing rule: how Guard decides one op class for one identity, from now on, without asking each time. Only the owner sets standing rules.',
				inputSchema: policySetSchema,
				annotations: { title: 'Set a Guard policy', readOnlyHint: false, destructiveHint: false },
			},
			handler: async (args, extra) => {
				try {
					const identity = identityFromRequest(extra, user);
					if (identity.kind !== 'owner') {
						return { content: [{ type: 'text', text: 'Only the owner sets standing rules.' }], isError: true };
					}
					const known = AON_OP_CLASSES.find((c) => c.opClass === args.opClass);
					if (!known) {
						return { content: [{ type: 'text', text: `Guard does not know the op class "${args.opClass}".` }], isError: true };
					}
					const policy = await this.policies.upsertPolicy({
						identity: args.identity,
						opClass: args.opClass,
						verdict: args.verdict,
						note: args.note ?? null,
					});
					return text(`Policy set: ${policy.identity} — ${policy.opClass} → ${policy.verdict}.`);
				} catch (error) {
					return failure(error);
				}
			},
		};

		const policyDelete: ToolDefinition<typeof policyDeleteSchema> = {
			name: 'guard_policy_delete',
			config: {
				description: 'Removes a standing rule, back to the tier default. Only the owner removes standing rules.',
				inputSchema: policyDeleteSchema,
				annotations: { title: 'Delete a Guard policy', readOnlyHint: false, destructiveHint: true },
			},
			handler: async (args, extra) => {
				try {
					const identity = identityFromRequest(extra, user);
					if (identity.kind !== 'owner') {
						return { content: [{ type: 'text', text: 'Only the owner sets standing rules.' }], isError: true };
					}
					const removed = await this.policies.deleteById(args.id);
					if (!removed) return text(`There is no policy with id ${args.id}.`);
					return text(`Policy ${args.id} removed.`);
				} catch (error) {
					return failure(error);
				}
			},
		};

		const council: ToolDefinition<typeof councilSchema> = {
			name: 'guard_council',
			config: {
				description: "The council overview: every op class it has ruled on, shadow or live, its agreement with the owner, and why an op class is not yet live.",
				inputSchema: councilSchema,
				annotations: { title: 'Council overview', readOnlyHint: true },
			},
			handler: async () => {
				try {
					const result = await this.council.overview();
					if (result.classes.length === 0) return text('The council has not ruled on anything yet.');
					return text(result.classes.map(councilLine).join('\n'));
				} catch (error) {
					return failure(error);
				}
			},
		};

		registerIfAllowed(request);
		registerIfAllowed(cardsList);
		registerIfAllowed(decide);
		registerIfAllowed(overview);
		registerIfAllowed(policySet);
		registerIfAllowed(policyDelete);
		registerIfAllowed(council);
	}
}
