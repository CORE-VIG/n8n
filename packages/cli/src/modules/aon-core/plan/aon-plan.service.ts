import type { User } from '@n8n/db';
import { Service } from '@n8n/di';
import type { DataTableFilter, DataTableRow } from 'n8n-workflow';

import { DataTableService } from '@/modules/data-table/data-table.service';

/** The plan's four statuses; a task starts `todo` and ends `done` or `dropped`. A tuple (not just an array) so `z.enum` can build a schema from it. */
export const AON_PLAN_STATUSES = ['todo', 'doing', 'done', 'dropped'] as const;

export type AonPlanStatus = (typeof AON_PLAN_STATUSES)[number];

/** The single Data Table `plan_tasks`/`plan_day` read and write: one per owner, created the first time anything asks for it. */
const PLAN_TABLE_NAME = 'Aon plan';

function todayIso(): string {
	return new Date().toISOString().slice(0, 10);
}

function weekEndIso(): string {
	const inAWeek = new Date();
	inAWeek.setUTCDate(inAWeek.getUTCDate() + 7);
	return inAWeek.toISOString().slice(0, 10);
}

type PlanTable = { dataTableId: string; projectId: string };

/**
 * The owner's day-to-day task list, kept in a Data Table named "Aon plan"
 * rather than its own entity: the plan is a list of rows (title, status,
 * due, note), not a new kind of thing Aon needs to migrate or back up
 * separately. `plan_tasks`, `plan_task_add`, `plan_task_move` and `plan_day`
 * (aon-plan-tools.service.ts) are thin wrappers over this.
 */
@Service()
export class AonPlanService {
	constructor(private readonly dataTables: DataTableService) {}

	/** The table, if the owner has ever added a task; null before the first one. */
	async findTable(user: User): Promise<PlanTable | null> {
		const projectId = await this.dataTables.resolveOwningProjectId(user);
		const { data } = await this.dataTables.getManyAndCount({
			filter: { projectId, name: PLAN_TABLE_NAME },
			take: 1,
		});
		const table = data[0];
		return table ? { dataTableId: table.id, projectId } : null;
	}

	/** Creates "Aon plan" the first time anything writes to it; every later call reuses it. `createdAt` is the table's own system column, so it is not one of these. */
	async ensureTable(user: User): Promise<PlanTable> {
		const found = await this.findTable(user);
		if (found) return found;
		const projectId = await this.dataTables.resolveOwningProjectId(user);
		const table = await this.dataTables.createDataTable(projectId, {
			name: PLAN_TABLE_NAME,
			columns: [
				{ name: 'title', type: 'string' },
				{ name: 'status', type: 'string' },
				{ name: 'due', type: 'string' },
				{ name: 'note', type: 'string' },
			],
		});
		return { dataTableId: table.id, projectId };
	}

	async addTask(
		user: User,
		input: { title: string; due?: string; note?: string },
	): Promise<DataTableRow> {
		const { dataTableId, projectId } = await this.ensureTable(user);
		const row: DataTableRow = {
			title: input.title,
			status: 'todo',
			due: input.due ?? null,
			note: input.note ?? null,
		};
		const [inserted] = await this.dataTables.insertRows(dataTableId, projectId, [row], 'all');
		if (!inserted) throw new Error('The task was not saved.');
		return inserted;
	}

	/** Every task matching the filters, due date ascending. Empty before the plan's first task. */
	async listTasks(
		user: User,
		opts: { status?: AonPlanStatus; due?: 'today' | 'overdue' | 'week' },
	): Promise<DataTableRow[]> {
		const table = await this.findTable(user);
		if (!table) return [];
		const filters: DataTableFilter['filters'] = [];
		if (opts.status) filters.push({ columnName: 'status', condition: 'eq', value: opts.status });
		if (opts.due === 'today') {
			filters.push({ columnName: 'due', condition: 'eq', value: todayIso() });
		} else if (opts.due === 'overdue') {
			filters.push({ columnName: 'due', condition: 'lt', value: todayIso() });
			filters.push({ columnName: 'status', condition: 'neq', value: 'done' });
			filters.push({ columnName: 'status', condition: 'neq', value: 'dropped' });
		} else if (opts.due === 'week') {
			filters.push({ columnName: 'due', condition: 'gte', value: todayIso() });
			filters.push({ columnName: 'due', condition: 'lte', value: weekEndIso() });
		}
		const filter: DataTableFilter | undefined = filters.length ? { type: 'and', filters } : undefined;
		const { data } = await this.dataTables.getManyRowsAndCount(table.dataTableId, table.projectId, {
			filter,
			sortBy: ['due', 'ASC'],
			take: 200,
		});
		return data;
	}

	/** Every open (not done, not dropped) task, for `plan_day` and `aon_state`'s due-today count. */
	private async openTasks(user: User): Promise<DataTableRow[]> {
		const table = await this.findTable(user);
		if (!table) return [];
		const { data } = await this.dataTables.getManyRowsAndCount(table.dataTableId, table.projectId, {
			filter: {
				type: 'and',
				filters: [
					{ columnName: 'status', condition: 'neq', value: 'done' },
					{ columnName: 'status', condition: 'neq', value: 'dropped' },
				],
			},
			sortBy: ['due', 'ASC'],
			take: 200,
		});
		return data;
	}

	/** The day's briefing: what is due today, what is being worked, and what is overdue. A task can land in more than one group. */
	async dayBriefing(
		user: User,
	): Promise<{ dueToday: DataTableRow[]; doing: DataTableRow[]; overdue: DataTableRow[] }> {
		const open = await this.openTasks(user);
		const today = todayIso();
		const dueToday: DataTableRow[] = [];
		const doing: DataTableRow[] = [];
		const overdue: DataTableRow[] = [];
		for (const row of open) {
			const due = typeof row.due === 'string' ? row.due : null;
			if (row.status === 'doing') doing.push(row);
			if (due === today) dueToday.push(row);
			else if (due !== null && due < today) overdue.push(row);
		}
		return { dueToday, doing, overdue };
	}

	/** Sets one task's status, found by its row id or (case-insensitive, exact) its title. Throws when the plan is empty or nothing matches. */
	async moveTask(
		user: User,
		input: { id?: number; title?: string; status: AonPlanStatus },
	): Promise<DataTableRow> {
		const table = await this.findTable(user);
		if (!table) throw new Error('There is no plan yet: add a task first.');
		const target = await this.resolveTask(table, input);
		const [updated] = await this.dataTables.updateRows(
			table.dataTableId,
			table.projectId,
			{
				filter: { type: 'and', filters: [{ columnName: 'id', condition: 'eq', value: target.id }] },
				data: { status: input.status },
			},
			true,
		);
		if (!updated) throw new Error('The task was not found when it came time to change it.');
		return updated;
	}

	private async resolveTask(
		table: PlanTable,
		input: { id?: number; title?: string },
	): Promise<DataTableRow> {
		if (input.id !== undefined) {
			const { data } = await this.dataTables.getManyRowsAndCount(table.dataTableId, table.projectId, {
				filter: { type: 'and', filters: [{ columnName: 'id', condition: 'eq', value: input.id }] },
				take: 1,
			});
			const row = data[0];
			if (row) return row;
		}
		if (input.title) {
			const { data } = await this.dataTables.getManyRowsAndCount(table.dataTableId, table.projectId, {
				filter: { type: 'and', filters: [{ columnName: 'title', condition: 'ilike', value: input.title }] },
				take: 1,
			});
			const row = data[0];
			if (row) return row;
		}
		throw new Error('No task matches that id or title.');
	}
}
