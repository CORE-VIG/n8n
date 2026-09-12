import type { AonGuardIdentity } from '@n8n/api-types';
import type { User } from '@n8n/db';
import { Service } from '@n8n/di';
import type { DataTableRow } from 'n8n-workflow';
import z from 'zod';

import type { RegisterToolFn, ToolDefinition } from '@/modules/mcp/mcp.types';

import { AonGuardService } from '../guard/aon-guard.service';
import { AON_OP_CLASSES } from '../guard/op-classes';
import { identityFromRequest } from '../guard/request-identity';

import { AON_PLAN_STATUSES, AonPlanService } from './aon-plan.service';

const tasksSchema = {
	status: z.enum(AON_PLAN_STATUSES).optional().describe('Omit for every status.'),
	due: z.enum(['today', 'overdue', 'week']).optional().describe('Omit for every due date.'),
} satisfies z.ZodRawShape;

const taskAddSchema = {
	title: z.string().trim().min(1).max(200),
	due: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
		.optional()
		.describe('An ISO date, e.g. "2026-09-15". Omit for no due date.'),
	note: z.string().trim().max(2000).optional(),
} satisfies z.ZodRawShape;

const taskMoveSchema = {
	id: z.number().int().optional().describe("The task's row id, from plan_tasks or plan_day."),
	title: z.string().trim().min(1).max(200).optional().describe('The task title, when its id is not at hand. Case-insensitive, exact.'),
	status: z.enum(AON_PLAN_STATUSES),
} satisfies z.ZodRawShape;

const daySchema = {} satisfies z.ZodRawShape;

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
const failure = (error: unknown) => ({
	content: [{ type: 'text' as const, text: `Aon plan: ${error instanceof Error ? error.message : String(error)}` }],
	isError: true,
});

function taskLine(row: DataTableRow): string {
	const due = typeof row.due === 'string' && row.due ? ` due ${row.due}` : '';
	const note = typeof row.note === 'string' && row.note ? ` — ${row.note}` : '';
	return `- [${row.id}] ${row.title} (${row.status})${due}${note}`;
}

/**
 * The owner's plan (a to-do list kept in a Data Table named "Aon plan") as
 * tools: read it, add to it, move a task along, and a one-shot day
 * briefing. `aon_tasks` and `aon_task_add`, the old Aon app's names, are
 * registered as aliases of `plan_day` and `plan_task_add` (see ALIASES in
 * op-classes.ts and McpService.getServer).
 */
@Service()
export class McpAonPlanToolsService {
	constructor(
		private readonly plan: AonPlanService,
		private readonly guard: AonGuardService,
	) {}

	private guardLabel(opClass: string): string {
		return AON_OP_CLASSES.find((c) => c.opClass === opClass)?.label ?? opClass;
	}

	/** Guard's verdict for one call: `deny` returns a refusal, `ask` raises a card and returns the stop-and-wait text; `allow` records and returns null so the handler proceeds. */
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
		const tasksList: ToolDefinition<typeof tasksSchema> = {
			name: 'plan_tasks',
			config: {
				description: 'Tasks on the plan, filtered by status and/or due date ("today", "overdue" or "week"). Omit both to see every task.',
				inputSchema: tasksSchema,
				annotations: { title: 'List plan tasks', readOnlyHint: true },
			},
			handler: async (args, extra) => {
				try {
					const identity = identityFromRequest(extra, user);
					const blocked = await this.guarded(identity, 'plan_tasks', args, 'List plan tasks.');
					if (blocked) return blocked;
					const rows = await this.plan.listTasks(user, { status: args.status, due: args.due });
					if (rows.length === 0) return text('No tasks match that.');
					return text(rows.map(taskLine).join('\n'));
				} catch (error) {
					return failure(error);
				}
			},
		};

		const taskAdd: ToolDefinition<typeof taskAddSchema> = {
			name: 'plan_task_add',
			config: {
				description: 'Adds a task to the plan, status "todo". Creates the plan the first time anything is added to it.',
				inputSchema: taskAddSchema,
				annotations: { title: 'Add a plan task', readOnlyHint: false, destructiveHint: false },
			},
			handler: async (args, extra) => {
				try {
					const identity = identityFromRequest(extra, user);
					const blocked = await this.guarded(identity, 'plan_task_add', args, `Add task: ${args.title}.`);
					if (blocked) return blocked;
					const row = await this.plan.addTask(user, args);
					return text(`Added [${row.id}] ${String(row.title)}.`);
				} catch (error) {
					return failure(error);
				}
			},
		};

		const taskMove: ToolDefinition<typeof taskMoveSchema> = {
			name: 'plan_task_move',
			config: {
				description: 'Sets a task\'s status: "todo", "doing", "done" or "dropped". Give its id, or its title when the id is not at hand.',
				inputSchema: taskMoveSchema,
				annotations: { title: 'Move a plan task', readOnlyHint: false, destructiveHint: false },
			},
			handler: async (args, extra) => {
				try {
					if (args.id === undefined && !args.title) {
						return { content: [{ type: 'text' as const, text: 'Give the task\'s id or its title.' }], isError: true };
					}
					const identity = identityFromRequest(extra, user);
					const blocked = await this.guarded(identity, 'plan_task_move', args, `Move task ${args.id ?? args.title} to ${args.status}.`);
					if (blocked) return blocked;
					const row = await this.plan.moveTask(user, args);
					return text(`[${row.id}] ${String(row.title)} is now ${args.status}.`);
				} catch (error) {
					return failure(error);
				}
			},
		};

		const day: ToolDefinition<typeof daySchema> = {
			name: 'plan_day',
			config: {
				description: "The day's briefing: what is due today, what is being worked, and what is overdue.",
				inputSchema: daySchema,
				annotations: { title: "Today's plan briefing", readOnlyHint: true },
			},
			handler: async (args, extra) => {
				try {
					const identity = identityFromRequest(extra, user);
					const blocked = await this.guarded(identity, 'plan_day', args, "Read today's plan briefing.");
					if (blocked) return blocked;
					const briefing = await this.plan.dayBriefing(user);
					if (briefing.dueToday.length === 0 && briefing.doing.length === 0 && briefing.overdue.length === 0) {
						return text('Nothing due today, nothing in progress, nothing overdue.');
					}
					const sections = [
						briefing.dueToday.length ? `Due today:\n${briefing.dueToday.map(taskLine).join('\n')}` : null,
						briefing.doing.length ? `Doing:\n${briefing.doing.map(taskLine).join('\n')}` : null,
						briefing.overdue.length ? `Overdue:\n${briefing.overdue.map(taskLine).join('\n')}` : null,
					].filter((s): s is string => Boolean(s));
					return text(sections.join('\n\n'));
				} catch (error) {
					return failure(error);
				}
			},
		};

		registerIfAllowed(tasksList);
		registerIfAllowed(taskAdd);
		registerIfAllowed(taskMove);
		registerIfAllowed(day);
	}
}
