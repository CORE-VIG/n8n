import type { User } from '@n8n/db';
import { Service } from '@n8n/di';
import z from 'zod';

import type { RegisterToolFn, ToolDefinition } from '@/modules/mcp/mcp.types';

import { AonGuardService } from '../guard/aon-guard.service';
import { AON_OP_CLASSES } from '../guard/op-classes';
import { identityFromRequest } from '../guard/request-identity';

import { AonHandsService, HANDS_WORKSPACE_DIR } from './aon-hands.service';

const MAX_TEXT = 100 * 1024;
const DEFAULT_TIMEOUT_S = 300;

const workspace = z
	.string()
	.trim()
	.max(64)
	.optional()
	.describe(
		'Which workspace to use: a short name such as "main" or "site-audit". Files persist there between commands, conversations and Aon agent runs. Leave empty for "main".',
	);

const runSchema = {
	workspace,
	command: z
		.string()
		.min(1)
		.max(20_000)
		.describe(
			`A bash command line, run in ${HANDS_WORKSPACE_DIR}. Run scripts as "bash x.sh" or "node x.js", never "./x".`,
		),
	timeoutSeconds: z
		.number()
		.int()
		.min(1)
		.max(1800)
		.optional()
		.describe(`How long the command may run. Default ${DEFAULT_TIMEOUT_S}.`),
	network: z
		.boolean()
		.optional()
		.describe(
			'Enable network access for this one command only (installing a package, fetching a page). Off by default; use it only when the command needs it and say that you did.',
		),
} satisfies z.ZodRawShape;

const pathSchema = z
	.string()
	.min(1)
	.max(1024)
	.describe(`A path inside the workspace, relative to ${HANDS_WORKSPACE_DIR} or absolute under /home/user.`);

const readSchema = { workspace, path: pathSchema } satisfies z.ZodRawShape;
const writeSchema = {
	workspace,
	path: pathSchema,
	content: z.string().max(5 * 1024 * 1024).describe('The whole file content; it replaces what was there.'),
} satisfies z.ZodRawShape;
const listSchema = {
	workspace,
	path: pathSchema.optional().describe(`A directory; default ${HANDS_WORKSPACE_DIR}.`),
	recursive: z.boolean().optional(),
} satisfies z.ZodRawShape;
const deleteSchema = {
	workspace,
	path: pathSchema,
	recursive: z.boolean().optional().describe('Required to delete a directory with its contents.'),
} satisfies z.ZodRawShape;

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
const failure = (error: unknown) => ({
	content: [{ type: 'text' as const, text: `Hands: ${error instanceof Error ? error.message : String(error)}` }],
	isError: true,
});

function clip(value: string, max = MAX_TEXT): string {
	if (Buffer.byteLength(value) <= max) return value;
	const kept = Buffer.from(value).subarray(-max).toString('utf8');
	return `...(cut, only the last ${max} bytes shown)\n${kept}`;
}

/** The start of a string, for a card or an event: the opposite of {@link clip}, which keeps the tail. */
function preview(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * The Aon assistant's hands, offered as MCP tools of this instance so any
 * client the owner allows can use them the same way. Thin wrappers: the
 * sandbox client does the work and the fence on the host does the guarding.
 */
@Service()
export class McpAonHandsToolsService {
	constructor(
		private readonly hands: AonHandsService,
		private readonly guard: AonGuardService,
	) {}

	async registerTools(registerIfAllowed: RegisterToolFn, user: User) {
		if (!(await this.hands.isConfigured())) return;
		for (const tool of this.tools(user)) registerIfAllowed(tool);
	}

	private tools(user: User): Array<ToolDefinition<z.ZodRawShape>> {
		const run: ToolDefinition<typeof runSchema> = {
			name: 'hands_run',
			config: {
				description: `Run a bash command in a fenced workspace on Aon's machine (bash, node 22, python 3.10, git, gcc). Nothing runs on the n8n host. Files under ${HANDS_WORKSPACE_DIR} persist. Returns the exit code, stdout and stderr.`,
				inputSchema: runSchema,
				annotations: { title: 'Run a command', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
			},
			handler: async (args, extra) => {
				try {
					const identity = identityFromRequest(extra, user);
					const decision = await this.guard.decideTool(identity, 'hands_run', args);

					if (decision.verdict === 'deny') {
						await this.guard.record(identity, decision.opClass, 'deny', {
							command: preview(args.command, 120),
						});
						const label =
							AON_OP_CLASSES.find((c) => c.opClass === decision.opClass)?.label ?? decision.opClass;
						return {
							content: [{ type: 'text' as const, text: `Guard denies this: ${label}` }],
							isError: true,
						};
					}

					if (decision.verdict === 'ask') {
						const summary = args.network
							? `Run: ${preview(args.command, 120)} with the network`
							: `Run: ${preview(args.command, 120)}`;
						const approval = await this.guard.requestApproval(identity, decision.opClass, summary, {
							command: args.command,
							network: args.network ?? false,
						});
						return text(`Guard needs the owner's yes: card ${approval.id} raised. Stop now and wait.`);
					}

					await this.guard.record(identity, decision.opClass, 'allow', {
						command: preview(args.command, 120),
					});

					const ws = await this.hands.workspace(user, args.workspace);
					if (!ws.sandbox.executeCommand) throw new Error('this sandbox cannot run commands');
					const result = await ws.sandbox.executeCommand(args.command, [], {
						timeout: (args.timeoutSeconds ?? DEFAULT_TIMEOUT_S) * 1000,
						env: args.network ? { HANDS_NETWORK: '1' } : undefined,
					});
					const head = `exit ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}${result.killed && !result.timedOut ? ' (killed)' : ''} in ${result.executionTimeMs} ms, workspace "${ws.slug}"`;
					const parts = [head];
					if (result.stdout) parts.push(`--- stdout ---\n${clip(result.stdout)}`);
					if (result.stderr) parts.push(`--- stderr ---\n${clip(result.stderr)}`);
					return text(parts.join('\n'));
				} catch (error) {
					return failure(error);
				}
			},
		};

		const read: ToolDefinition<typeof readSchema> = {
			name: 'hands_read_file',
			config: {
				description: 'Read a text file from the workspace.',
				inputSchema: readSchema,
				annotations: { title: 'Read a file', readOnlyHint: true },
			},
			handler: async (args) => {
				try {
					const ws = await this.hands.workspace(user, args.workspace);
					const content = await ws.files.readFile(args.path, { encoding: 'utf8' });
					return text(clip(typeof content === 'string' ? content : content.toString('utf8')));
				} catch (error) {
					return failure(error);
				}
			},
		};

		const write: ToolDefinition<typeof writeSchema> = {
			name: 'hands_write_file',
			config: {
				description: 'Write a whole text file into the workspace, creating directories as needed.',
				inputSchema: writeSchema,
				annotations: { title: 'Write a file', readOnlyHint: false, destructiveHint: true },
			},
			handler: async (args) => {
				try {
					const ws = await this.hands.workspace(user, args.workspace);
					await ws.files.writeFile(args.path, args.content, { overwrite: true, recursive: true });
					return text(`Wrote ${Buffer.byteLength(args.content)} bytes to ${args.path} in workspace "${ws.slug}".`);
				} catch (error) {
					return failure(error);
				}
			},
		};

		const list: ToolDefinition<typeof listSchema> = {
			name: 'hands_list_files',
			config: {
				description: 'List files in a workspace directory.',
				inputSchema: listSchema,
				annotations: { title: 'List files', readOnlyHint: true },
			},
			handler: async (args) => {
				try {
					const ws = await this.hands.workspace(user, args.workspace);
					const entries = await ws.files.readdir(args.path ?? HANDS_WORKSPACE_DIR, {
						recursive: args.recursive ?? false,
					});
					if (entries.length === 0) return text('(empty)');
					const lines = entries.map((e) =>
						e.type === 'directory' ? `${e.name}/` : `${e.name}  (${e.size ?? 0} bytes)`,
					);
					return text(clip(lines.join('\n')));
				} catch (error) {
					return failure(error);
				}
			},
		};

		const remove: ToolDefinition<typeof deleteSchema> = {
			name: 'hands_delete',
			config: {
				description: 'Delete a file, or a directory with recursive: true, from the workspace.',
				inputSchema: deleteSchema,
				annotations: { title: 'Delete', readOnlyHint: false, destructiveHint: true },
			},
			handler: async (args) => {
				try {
					const ws = await this.hands.workspace(user, args.workspace);
					await ws.files.deleteFile(args.path, { recursive: args.recursive ?? false, force: true });
					return text(`Deleted ${args.path} from workspace "${ws.slug}".`);
				} catch (error) {
					return failure(error);
				}
			},
		};

		return [run, read, write, list, remove] as Array<ToolDefinition<z.ZodRawShape>>;
	}
}
