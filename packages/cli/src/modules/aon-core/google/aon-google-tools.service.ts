import type { User } from '@n8n/db';
import { Service } from '@n8n/di';
import z from 'zod';

import type { RegisterToolFn, ToolDefinition } from '@/modules/mcp/mcp.types';

import { AonGuardService } from '../guard/aon-guard.service';
import { AON_OP_CLASSES } from '../guard/op-classes';
import { identityFromRequest } from '../guard/request-identity';
import { AonHandsService } from '../hands/aon-hands.service';

import { GOOGLE_NOT_CONNECTED_MESSAGE, GoogleNotConfigured } from './aon-google-auth.service';
import { AonGoogleService } from './aon-google.service';

type ToolContent = Array<{ type: 'text'; text: string }>;
type ToolResult = { content: ToolContent; isError?: boolean };

const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] });
const failure = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }], isError: true });

function googleFailureText(error: unknown): string {
	if (error instanceof GoogleNotConfigured) return error.message;
	return `Google: ${error instanceof Error ? error.message : String(error)}`;
}

// --- schemas -----------------------------------------------------------------

const mailSearchSchema = {
	query: z.string().min(1).max(500).describe('A Gmail search, exactly as typed in the Gmail search box (e.g. "from:namecheap invoice").'),
	limit: z.number().int().min(1).max(25).optional().describe('Up to 25; defaults to 10.'),
} satisfies z.ZodRawShape;

const mailReadSchema = {
	threadId: z.string().min(1).max(200),
	maxChars: z.number().int().min(1).max(20_000).optional().describe('Up to 20000 characters per message; defaults to 20000.'),
} satisfies z.ZodRawShape;

const mailAttachmentSchema = {
	messageId: z.string().min(1).max(200),
	attachmentId: z.string().min(1).max(200),
} satisfies z.ZodRawShape;

const mailDraftSchema = {
	to: z.array(z.string().min(1).max(320)).min(1).max(20),
	subject: z.string().min(1).max(500),
	body: z.string().min(1).max(100_000),
	replyToThreadId: z.string().min(1).max(200).optional(),
} satisfies z.ZodRawShape;

const mailSendSchema = {
	to: z.array(z.string().min(1).max(320)).min(1).max(20),
	subject: z.string().min(1).max(500),
	body: z.string().min(1).max(100_000),
	replyToThreadId: z.string().min(1).max(200).optional(),
	cc: z.array(z.string().min(1).max(320)).max(20).optional(),
} satisfies z.ZodRawShape;

const mailLabelSchema = {
	threadId: z.string().min(1).max(200),
	add: z.array(z.string().min(1).max(100)).max(20).optional(),
	remove: z.array(z.string().min(1).max(100)).max(20).optional(),
	markRead: z.boolean().optional(),
} satisfies z.ZodRawShape;

const calendarListSchema = {
	from: z.string().min(1).max(64).describe('RFC 3339, e.g. 2026-09-12T00:00:00Z'),
	to: z.string().min(1).max(64).describe('RFC 3339, e.g. 2026-09-19T00:00:00Z'),
	calendarId: z.string().min(1).max(320).optional().describe('Defaults to "primary".'),
} satisfies z.ZodRawShape;

const calendarCreateSchema = {
	title: z.string().min(1).max(300),
	start: z.string().min(1).max(64).describe('RFC 3339 date-time, or a bare YYYY-MM-DD for an all-day event.'),
	end: z.string().min(1).max(64).describe('RFC 3339 date-time, or a bare YYYY-MM-DD for an all-day event.'),
	description: z.string().max(8_000).optional(),
	attendees: z.array(z.string().min(1).max(320)).max(50).optional(),
	location: z.string().max(500).optional(),
} satisfies z.ZodRawShape;

const calendarUpdateSchema = {
	eventId: z.string().min(1).max(200),
	title: z.string().min(1).max(300).optional(),
	start: z.string().min(1).max(64).optional().describe('RFC 3339 date-time, or a bare YYYY-MM-DD for an all-day event.'),
	end: z.string().min(1).max(64).optional().describe('RFC 3339 date-time, or a bare YYYY-MM-DD for an all-day event.'),
	description: z.string().max(8_000).optional(),
	attendees: z.array(z.string().min(1).max(320)).max(50).optional(),
	location: z.string().max(500).optional(),
} satisfies z.ZodRawShape;

const calendarDeleteSchema = {
	eventId: z.string().min(1).max(200),
} satisfies z.ZodRawShape;

const driveSearchSchema = {
	query: z.string().min(1).max(300),
	limit: z.number().int().min(1).max(25).optional().describe('Up to 25; defaults to 10.'),
} satisfies z.ZodRawShape;

const driveFolderSchema = {
	folderId: z.string().min(1).max(200),
} satisfies z.ZodRawShape;

const driveReadSchema = {
	fileId: z.string().min(1).max(200),
	maxChars: z.number().int().min(1).max(50_000).optional().describe('Up to 50000 characters; defaults to 20000.'),
} satisfies z.ZodRawShape;

const driveCreateSchema = {
	name: z.string().min(1).max(300),
	mime: z.string().min(1).max(200).describe('e.g. text/plain, text/csv, text/markdown'),
	content: z.string().max(2_000_000),
	folderId: z.string().min(1).max(200).optional(),
} satisfies z.ZodRawShape;

const sheetReadSchema = {
	spreadsheetId: z.string().min(1).max(200),
	range: z.string().min(1).max(200),
} satisfies z.ZodRawShape;

const sheetWriteSchema = {
	spreadsheetId: z.string().min(1).max(200),
	range: z.string().min(1).max(200),
	values: z.array(z.array(z.string().max(50_000))).min(1).max(1000),
} satisfies z.ZodRawShape;

/**
 * The assistant's Google access, offered as MCP tools of this instance:
 * Gmail, Calendar, Drive and Sheets, all through the owner's own n8n
 * credential. Every tool answers `GOOGLE_NOT_CONNECTED_MESSAGE` when that
 * credential is missing or unfinished — a normal state, never a thrown
 * error — and otherwise passes through Guard exactly like the browser
 * tools: `identityFromRequest -> decideTool -> record`.
 */
@Service()
export class McpAonGoogleToolsService {
	constructor(
		private readonly google: AonGoogleService,
		private readonly guard: AonGuardService,
		private readonly hands: AonHandsService,
	) {}

	registerTools(registerIfAllowed: RegisterToolFn, user: User) {
		for (const tool of this.tools(user)) registerIfAllowed(tool);
	}

	/** Runs `perform` behind Guard for one op class; a `deny` or `ask` verdict never reaches `perform`. */
	private async guarded(
		user: User,
		extra: unknown,
		toolName: string,
		args: Record<string, unknown>,
		cardSummary: string,
		perform: () => Promise<ToolResult>,
	): Promise<ToolResult> {
		if (!(await this.google.isConfigured(user))) return failure(GOOGLE_NOT_CONNECTED_MESSAGE);

		const identity = identityFromRequest(extra, user);
		const decision = await this.guard.decideTool(identity, toolName, args);

		if (decision.verdict === 'deny') {
			await this.guard.record(identity, decision.opClass, 'deny', args);
			const label = AON_OP_CLASSES.find((c) => c.opClass === decision.opClass)?.label ?? decision.opClass;
			return failure(`Guard denies this: ${label}`);
		}
		if (decision.verdict === 'ask') {
			const approval = await this.guard.requestApproval(identity, decision.opClass, cardSummary, args);
			return text(`Guard needs the owner's yes: card ${approval.id} raised. Stop now and wait.`);
		}
		await this.guard.record(identity, decision.opClass, 'allow', args);
		try {
			return await perform();
		} catch (error) {
			return failure(googleFailureText(error));
		}
	}

	private tools(user: User): Array<ToolDefinition<z.ZodRawShape>> {
		const mailSearch: ToolDefinition<typeof mailSearchSchema> = {
			name: 'mail_search',
			config: {
				description: 'Search his Gmail. Returns threads: id, subject, from, date, snippet, unread, labels.',
				inputSchema: mailSearchSchema,
				annotations: { title: 'Search mail', readOnlyHint: true },
			},
			handler: async (args, extra) =>
				await this.guarded(user, extra, 'mail_search', args, `Search mail: ${args.query}`, async () => {
					const threads = await this.google.searchMail(user, args.query, args.limit ?? 10);
					if (threads.length === 0) return text('No threads matched.');
					const lines = threads.map(
						(t) =>
							`${t.id} — ${t.subject ?? '(no subject)'} — from ${t.from ?? '?'} — ${t.date ?? '?'}${t.unread ? ' — unread' : ''}\n  ${t.snippet ?? ''}`,
					);
					return text(lines.join('\n'));
				}),
		};

		const mailRead: ToolDefinition<typeof mailReadSchema> = {
			name: 'mail_read',
			config: {
				description:
					'Read a Gmail thread: every message as from/to/date/body text, and every attachment on it (name, mime, size, attachmentId).',
				inputSchema: mailReadSchema,
				annotations: { title: 'Read a mail thread', readOnlyHint: true },
			},
			handler: async (args, extra) =>
				await this.guarded(user, extra, 'mail_read', args, `Read mail thread ${args.threadId}`, async () => {
					const thread = await this.google.readThread(user, args.threadId, args.maxChars ?? 20_000);
					const body = thread.messages
						.map((m) => `From: ${m.from ?? '?'}\nTo: ${m.to.join(', ') || '?'}\nDate: ${m.date ?? '?'}\n\n${m.body}`)
						.join('\n\n---\n\n');
					const attachments = thread.attachments.length
						? `\n\nAttachments:\n${thread.attachments
								.map((a) => `- ${a.name} (${a.mimeType}, ${a.size} bytes) messageId=${a.messageId} attachmentId=${a.attachmentId}`)
								.join('\n')}`
						: '';
					return text(`Subject: ${thread.subject ?? '(no subject)'}\n\n${body}${attachments}`);
				}),
		};

		const mailAttachment: ToolDefinition<typeof mailAttachmentSchema> = {
			name: 'mail_attachment',
			config: {
				description: "Saves one Gmail attachment into his Hands workspace ('main', under attachments/<name>) and returns the path.",
				inputSchema: mailAttachmentSchema,
				annotations: { title: 'Save a mail attachment', readOnlyHint: false },
			},
			handler: async (args, extra) =>
				await this.guarded(user, extra, 'mail_attachment', args, `Save an attachment from mail message ${args.messageId}`, async () => {
					const { data } = await this.google.fetchAttachment(user, args.messageId, args.attachmentId);
					const ws = await this.hands.workspace(user, undefined);
					const name = args.attachmentId.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'attachment';
					const path = `attachments/${name}`;
					await ws.files.writeFile(path, data, { overwrite: true, recursive: true });
					return text(`Saved to ${path} (${data.byteLength} bytes).`);
				}),
		};

		const mailDraft: ToolDefinition<typeof mailDraftSchema> = {
			name: 'mail_draft',
			config: {
				description: 'Creates a Gmail draft. Never sends it.',
				inputSchema: mailDraftSchema,
				annotations: { title: 'Draft mail', readOnlyHint: false },
			},
			handler: async (args, extra) =>
				await this.guarded(user, extra, 'mail_draft', args, `Draft mail to ${args.to.join(', ')}: ${args.subject}`, async () => {
					const draft = await this.google.createDraft(user, args);
					return text(`Draft created (id ${draft.id}). It has not been sent.`);
				}),
		};

		const mailSend: ToolDefinition<typeof mailSendSchema> = {
			name: 'mail_send',
			config: {
				description: 'Sends mail as him, right now. Draft first unless he has clearly said to send.',
				inputSchema: mailSendSchema,
				annotations: { title: 'Send mail', readOnlyHint: false, destructiveHint: true },
			},
			handler: async (args, extra) =>
				await this.guarded(user, extra, 'mail_send', args, `Send mail to ${args.to.join(', ')}: ${args.subject}`, async () => {
					const sent = await this.google.sendMail(user, args);
					return text(`Sent (message id ${sent.id}).`);
				}),
		};

		const mailLabel: ToolDefinition<typeof mailLabelSchema> = {
			name: 'mail_label',
			config: {
				description: 'Adds or removes labels on a Gmail thread, and/or marks it read or unread.',
				inputSchema: mailLabelSchema,
				annotations: { title: 'Label mail', readOnlyHint: false },
			},
			handler: async (args, extra) =>
				await this.guarded(user, extra, 'mail_label', args, `Change labels on mail thread ${args.threadId}`, async () => {
					await this.google.labelThread(user, args);
					return text('Done.');
				}),
		};

		const calendarList: ToolDefinition<typeof calendarListSchema> = {
			name: 'calendar_list',
			config: {
				description: 'Lists events between two RFC 3339 instants. Returns id, title, start, end, location, attendees, link.',
				inputSchema: calendarListSchema,
				annotations: { title: 'List calendar events', readOnlyHint: true },
			},
			handler: async (args, extra) =>
				await this.guarded(user, extra, 'calendar_list', args, `List calendar events ${args.from}..${args.to}`, async () => {
					const events = await this.google.listEvents(user, args.from, args.to, args.calendarId);
					if (events.length === 0) return text('Nothing in that window.');
					return text(
						events
							.map(
								(e) =>
									`${e.id} — ${e.title} — ${e.start} to ${e.end}${e.location ? ` — ${e.location}` : ''}${
										e.attendees.length ? ` — with ${e.attendees.join(', ')}` : ''
									}`,
							)
							.join('\n'),
					);
				}),
		};

		const calendarCreate: ToolDefinition<typeof calendarCreateSchema> = {
			name: 'calendar_create',
			config: {
				description: 'Creates a calendar event on his primary calendar. Only when he asks for a calendar change.',
				inputSchema: calendarCreateSchema,
				annotations: { title: 'Create a calendar event', readOnlyHint: false, destructiveHint: true },
			},
			handler: async (args, extra) =>
				await this.guarded(user, extra, 'calendar_create', args, `Create calendar event: ${args.title}`, async () => {
					const event = await this.google.createEvent(user, args);
					return text(`Created "${event.title}" (${event.start} – ${event.end}), id ${event.id}.${event.link ? ` ${event.link}` : ''}`);
				}),
		};

		const calendarUpdate: ToolDefinition<typeof calendarUpdateSchema> = {
			name: 'calendar_update',
			config: {
				description: 'Changes an existing calendar event. Only the fields given are changed. Only when he asks for a calendar change.',
				inputSchema: calendarUpdateSchema,
				annotations: { title: 'Change a calendar event', readOnlyHint: false, destructiveHint: true },
			},
			handler: async (args, extra) =>
				await this.guarded(user, extra, 'calendar_update', args, `Change calendar event ${args.eventId}`, async () => {
					const { eventId, ...rest } = args;
					const event = await this.google.updateEvent(user, eventId, rest);
					return text(`Changed "${event.title}" (${event.start} – ${event.end}).`);
				}),
		};

		const calendarDelete: ToolDefinition<typeof calendarDeleteSchema> = {
			name: 'calendar_delete',
			config: {
				description: 'Deletes a calendar event. Only when he asks for a calendar change.',
				inputSchema: calendarDeleteSchema,
				annotations: { title: 'Delete a calendar event', readOnlyHint: false, destructiveHint: true },
			},
			handler: async (args, extra) =>
				await this.guarded(user, extra, 'calendar_delete', args, `Delete calendar event ${args.eventId}`, async () => {
					await this.google.deleteEvent(user, args.eventId);
					return text('Deleted.');
				}),
		};

		const driveSearch: ToolDefinition<typeof driveSearchSchema> = {
			name: 'drive_search',
			config: {
				description: 'Full-text search across his Drive. Returns id, name, mimeType, size, modifiedTime, webViewLink.',
				inputSchema: driveSearchSchema,
				annotations: { title: 'Search Drive', readOnlyHint: true },
			},
			handler: async (args, extra) =>
				await this.guarded(user, extra, 'drive_search', args, `Search Drive: ${args.query}`, async () => {
					const files = await this.google.searchDrive(user, args.query, args.limit ?? 10);
					if (files.length === 0) return text('No files matched.');
					return text(files.map((f) => `${f.id} — ${f.name} (${f.mimeType})${f.modifiedTime ? ` — modified ${f.modifiedTime}` : ''}`).join('\n'));
				}),
		};

		const driveFolder: ToolDefinition<typeof driveFolderSchema> = {
			name: 'drive_folder',
			config: {
				description: "Lists a Drive folder's direct contents.",
				inputSchema: driveFolderSchema,
				annotations: { title: 'List a Drive folder', readOnlyHint: true },
			},
			handler: async (args, extra) =>
				await this.guarded(user, extra, 'drive_folder', args, `List Drive folder ${args.folderId}`, async () => {
					const files = await this.google.listFolder(user, args.folderId);
					if (files.length === 0) return text('That folder is empty.');
					return text(files.map((f) => `${f.id} — ${f.name} (${f.mimeType})`).join('\n'));
				}),
		};

		const driveRead: ToolDefinition<typeof driveReadSchema> = {
			name: 'drive_read',
			config: {
				description:
					'Reads one Drive file as text: a Doc exports as plain text, a Sheet as CSV of its first sheet, other text files as-is. A binary file is named, not read.',
				inputSchema: driveReadSchema,
				annotations: { title: 'Read a Drive file', readOnlyHint: true },
			},
			handler: async (args, extra) =>
				await this.guarded(user, extra, 'drive_read', args, `Read Drive file ${args.fileId}`, async () => {
					const content = await this.google.readFile(user, args.fileId, args.maxChars ?? 20_000);
					if (content.binaryNote) return text(content.binaryNote);
					return text(`${content.name} (${content.mimeType})\n\n${content.text ?? ''}${content.truncated ? '\n…(cut)' : ''}`);
				}),
		};

		const driveCreate: ToolDefinition<typeof driveCreateSchema> = {
			name: 'drive_create',
			config: {
				description: 'Creates a new Drive file with the given text content.',
				inputSchema: driveCreateSchema,
				annotations: { title: 'Create a Drive file', readOnlyHint: false },
			},
			handler: async (args, extra) =>
				await this.guarded(user, extra, 'drive_create', args, `Create Drive file: ${args.name}`, async () => {
					const file = await this.google.createFile(user, {
						name: args.name,
						mimeType: args.mime,
						content: args.content,
						folderId: args.folderId,
					});
					return text(`Created "${file.name}", id ${file.id}.${file.webViewLink ? ` ${file.webViewLink}` : ''}`);
				}),
		};

		const sheetRead: ToolDefinition<typeof sheetReadSchema> = {
			name: 'sheet_read',
			config: {
				description: 'Reads a range of a Google Sheet, e.g. "Sheet1!A1:D20". Returns the rows as text.',
				inputSchema: sheetReadSchema,
				annotations: { title: 'Read a sheet', readOnlyHint: true },
			},
			handler: async (args, extra) =>
				await this.guarded(user, extra, 'sheet_read', args, `Read sheet ${args.spreadsheetId} ${args.range}`, async () => {
					const rows = await this.google.readSheet(user, args.spreadsheetId, args.range);
					if (rows.length === 0) return text('That range is empty.');
					return text(rows.map((row) => row.join('\t')).join('\n'));
				}),
		};

		const sheetWrite: ToolDefinition<typeof sheetWriteSchema> = {
			name: 'sheet_write',
			config: {
				description: 'Writes rows into a range of a Google Sheet, e.g. "Sheet1!A1:D3". Overwrites what is already there.',
				inputSchema: sheetWriteSchema,
				annotations: { title: 'Write a sheet', readOnlyHint: false, destructiveHint: true },
			},
			handler: async (args, extra) =>
				await this.guarded(user, extra, 'sheet_write', args, `Write sheet ${args.spreadsheetId} ${args.range}`, async () => {
					await this.google.writeSheet(user, args.spreadsheetId, args.range, args.values);
					return text('Written.');
				}),
		};

		return [
			mailSearch,
			mailRead,
			mailAttachment,
			mailDraft,
			mailSend,
			mailLabel,
			calendarList,
			calendarCreate,
			calendarUpdate,
			calendarDelete,
			driveSearch,
			driveFolder,
			driveRead,
			driveCreate,
			sheetRead,
			sheetWrite,
		] as Array<ToolDefinition<z.ZodRawShape>>;
	}
}
