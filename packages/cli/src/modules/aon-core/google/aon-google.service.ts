import type { User } from '@n8n/db';
import { Service } from '@n8n/di';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';

import { htmlToText } from '../../aon-memory/aon-html-to-text';

import { AonGoogleAuthService } from './aon-google-auth.service';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

/** A downloaded attachment or Drive file over this size is refused rather than held in memory whole. */
export const MAX_BINARY_BYTES = 25 * 1024 * 1024;
const BODY_MAX_CHARS_DEFAULT = 20_000;

// --- reading untrusted JSON without `any` or `as` --------------------------
//
// Every Google response arrives as `unknown`. Rather than casting it into a
// shape and trusting the network, every field is pulled out through one of
// these, so a response that does not look as expected reads as absent
// (undefined, or an empty array/record) instead of throwing somewhere deep
// inside a `.map`.

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function record(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

export function arr(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

export function str(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function num(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim() !== '') {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

// --- shared shapes -----------------------------------------------------------

export interface AonGoogleThreadSummary {
	id: string;
	subject: string | null;
	from: string | null;
	date: string | null;
	snippet: string | null;
	unread: boolean;
	labels: string[];
}

export interface AonGoogleAttachment {
	name: string;
	mimeType: string;
	size: number;
	attachmentId: string;
	messageId: string;
}

export interface AonGoogleMessageText {
	from: string | null;
	to: string[];
	date: string | null;
	body: string;
}

export interface AonGoogleThreadText {
	subject: string | null;
	messages: AonGoogleMessageText[];
	attachments: AonGoogleAttachment[];
}

export interface AonGoogleSentMail {
	id: string;
	threadId: string | null;
}

export interface AonGoogleCalendarEvent {
	id: string;
	title: string;
	start: string;
	end: string;
	location: string | null;
	attendees: string[];
	link: string | null;
}

export interface AonGoogleCalendarEventInput {
	title: string;
	start: string;
	end: string;
	description?: string;
	attendees?: string[];
	location?: string;
}

export interface AonGoogleDriveFile {
	id: string;
	name: string;
	mimeType: string;
	size: number | null;
	modifiedTime: string | null;
	webViewLink: string | null;
}

export interface AonGoogleDriveContent {
	name: string;
	mimeType: string;
	text: string | null;
	/** Set instead of `text` when the file is binary and cannot be read as text. */
	binaryNote: string | null;
	truncated: boolean;
}

// --- pure helpers (exported for tests) --------------------------------------

/** RFC 5322 header names are case-insensitive; Gmail's own casing is not consistent between messages. */
export function gmailHeader(headers: unknown, name: string): string | null {
	const want = name.toLowerCase();
	for (const raw of arr(headers)) {
		const header = record(raw);
		const headerName = str(header.name);
		if (headerName && headerName.toLowerCase() === want) return str(header.value) ?? null;
	}
	return null;
}

/** Splits an address list on commas that separate addresses, not the comma inside `"Last, First" <a@b.c>`. */
export function splitAddressList(value: string): string[] {
	const out: string[] = [];
	let buf = '';
	let inQuotes = false;
	let inAngle = false;
	for (const ch of value) {
		if (ch === '"') {
			inQuotes = !inQuotes;
			buf += ch;
			continue;
		}
		if (!inQuotes && ch === '<') inAngle = true;
		if (!inQuotes && ch === '>') inAngle = false;
		if (ch === ',' && !inQuotes && !inAngle) {
			out.push(buf);
			buf = '';
			continue;
		}
		buf += ch;
	}
	out.push(buf);
	return out.map((s) => s.trim()).filter(Boolean);
}

export function parseAddress(value: string | null | undefined): string | null {
	if (!value) return null;
	const angle = value.match(/<([^>]*)>/);
	const raw = (angle ? angle[1] : value).trim().replace(/^"(.*)"$/, '$1').trim();
	return raw || null;
}

export function parseAddressList(value: string | null | undefined): string[] {
	if (!value) return [];
	const seen = new Set<string>();
	for (const part of splitAddressList(value)) {
		const addr = parseAddress(part);
		if (addr) seen.add(addr);
	}
	return [...seen];
}

export function isUnread(labels: string[]): boolean {
	return labels.includes('UNREAD');
}

export function decodeBase64Url(data: string | undefined): string {
	if (!data) return '';
	try {
		return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
	} catch {
		return '';
	}
}

function collectParts(part: unknown, want: string, out: string[]): void {
	const p = record(part);
	const mime = (str(p.mimeType) ?? '').toLowerCase();
	const body = record(p.body);
	if (mime === want && str(body.data) && !str(p.filename)) out.push(decodeBase64Url(str(body.data)));
	for (const child of arr(p.parts)) collectParts(child, want, out);
}

/** text/plain when the message carries one, else text/html turned into text. Attachments (parts with a filename) are never read as body. */
export function messageBodyText(payload: unknown, max = BODY_MAX_CHARS_DEFAULT): string {
	const plain: string[] = [];
	collectParts(payload, 'text/plain', plain);
	let text = plain.join('\n').replace(/\r\n?/g, '\n').trim();
	if (!text) {
		const html: string[] = [];
		collectParts(payload, 'text/html', html);
		text = htmlToText(html.join('\n'));
	}
	return text.length > max ? `${text.slice(0, max)}\n…(cut)` : text;
}

/** Every attachment on one message, walking every part (inline images included; the caller decides what is worth fetching). */
export function collectAttachments(messageId: string, payload: unknown): AonGoogleAttachment[] {
	const out: AonGoogleAttachment[] = [];
	const walk = (part: unknown) => {
		const p = record(part);
		const filename = str(p.filename);
		const body = record(p.body);
		const attachmentId = str(body.attachmentId);
		const size = num(body.size) ?? 0;
		if (filename && attachmentId) {
			out.push({ name: filename, mimeType: str(p.mimeType) ?? 'application/octet-stream', size, attachmentId, messageId });
		}
		for (const child of arr(p.parts)) walk(child);
	};
	walk(payload);
	return out;
}

/** A thread's search-result row: subject from the first message, sender/date/snippet/labels from the last, as Gmail's own UI reads a thread. */
export function toThreadSummary(thread: unknown): AonGoogleThreadSummary | null {
	const messages = arr(record(thread).messages);
	const id = str(record(thread).id);
	if (messages.length === 0 || !id) return null;
	const first = messages[0];
	const last = messages[messages.length - 1];
	const labels = [...new Set(messages.flatMap((m) => arr(record(m).labelIds).map(str).filter((l): l is string => Boolean(l))))];
	const subject = gmailHeader(record(first).payload && record(record(first).payload).headers, 'Subject')
		?? gmailHeader(record(last).payload && record(record(last).payload).headers, 'Subject');
	const internal = num(record(last).internalDate);
	const date = internal !== undefined && internal > 0 ? new Date(internal).toISOString() : null;
	const lastPayload = record(last).payload;
	return {
		id,
		subject: subject ?? null,
		from: parseAddress(gmailHeader(record(lastPayload).headers, 'From')),
		date,
		snippet: str(record(last).snippet) ?? null,
		unread: isUnread(labels),
		labels,
	};
}

/** A thread's full text: every message rendered, and every attachment across the thread. */
export function toThreadText(thread: unknown, maxCharsPerMessage: number): AonGoogleThreadText {
	const messages = arr(record(thread).messages);
	const firstPayload = messages.length > 0 ? record(messages[0]).payload : undefined;
	const subject = messages.length > 0 ? gmailHeader(record(firstPayload).headers, 'Subject') : null;
	const rendered: AonGoogleMessageText[] = [];
	const attachments: AonGoogleAttachment[] = [];
	for (const raw of messages) {
		const message = record(raw);
		const payload = message.payload;
		const headers = record(payload).headers;
		const internal = num(message.internalDate);
		rendered.push({
			from: parseAddress(gmailHeader(headers, 'From')),
			to: parseAddressList(gmailHeader(headers, 'To')),
			date: internal !== undefined && internal > 0 ? new Date(internal).toISOString() : null,
			body: messageBodyText(payload, maxCharsPerMessage),
		});
		const messageId = str(message.id);
		if (messageId) attachments.push(...collectAttachments(messageId, payload));
	}
	return { subject: subject ?? null, messages: rendered, attachments };
}

/** RFC 2047 encoded word when the header carries anything outside printable ASCII. */
export function encodeMailHeader(value: string): string {
	// eslint-disable-next-line no-control-regex
	return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function base64Body(value: string): string {
	return Buffer.from(value, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
}

export const MAX_MAIL_RECIPIENTS = 20;

/** A mailbox: a bare address, or `Display Name <addr@host>`. */
const MAILBOX_CORE_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

/**
 * Refuses a value that could inject a header or an extra line into the raw
 * RFC 2822 message — a `\r`, `\n` or NUL anywhere in a subject, address or
 * `In-Reply-To` would otherwise let a caller smuggle a `Bcc:` line or a
 * second message in behind the one this builds. Never relied on base64
 * encoding the body to make this safe; the headers are plain text lines.
 */
export function headerValue(value: string): string {
	if (/[\r\n\0]/.test(value)) {
		throw new BadRequestError('That text cannot contain a line break.');
	}
	return value;
}

/** One address, checked against a strict mailbox shape after the injection check. */
export function mailboxAddress(value: string): string {
	const checked = headerValue(value).trim();
	const display = /^(.*)<([^<>]+)>$/.exec(checked);
	const address = display ? display[2].trim() : checked;
	if (!MAILBOX_CORE_RE.test(address)) {
		throw new BadRequestError(`"${checked.slice(0, 80)}" is not a valid mail address.`);
	}
	return checked;
}

function mailboxList(values: string[] | undefined, field: string): string[] {
	const list = values ?? [];
	if (list.length > MAX_MAIL_RECIPIENTS) {
		throw new BadRequestError(`${field}: at most ${MAX_MAIL_RECIPIENTS} addresses.`);
	}
	return list.map((value) => mailboxAddress(value));
}

/** The RFC 2822 message, ready for base64url as Gmail's `raw` field. Every header value is checked before it is written. */
export function buildRawMessage(input: {
	/** Left out when unknown: Gmail fills the authenticated account's own address in. */
	from?: string;
	to: string[];
	cc?: string[];
	subject: string;
	text: string;
	inReplyTo?: string;
}): string {
	const to = mailboxList(input.to, 'to');
	if (to.length === 0) throw new BadRequestError('to is required.');
	const cc = mailboxList(input.cc, 'cc');
	const from = input.from !== undefined ? mailboxAddress(input.from) : undefined;
	const subject = headerValue(input.subject);
	const inReplyTo = input.inReplyTo !== undefined ? headerValue(input.inReplyTo) : undefined;
	const lines = [
		...(from ? [`From: ${from}`] : []),
		`To: ${to.join(', ')}`,
		...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
		`Subject: ${encodeMailHeader(subject)}`,
		...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`] : []),
		'MIME-Version: 1.0',
		'Content-Type: text/plain; charset="UTF-8"',
		'Content-Transfer-Encoding: base64',
		'',
		base64Body(input.text),
	];
	return lines.join('\r\n');
}

export function toBase64Url(value: string): string {
	return Buffer.from(value, 'utf8').toString('base64url');
}

/** A date-only string (YYYY-MM-DD) vs. an RFC 3339 instant, the same distinction Google Calendar makes between `date` and `dateTime`. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function calendarEventBody(input: AonGoogleCalendarEventInput): Record<string, unknown> {
	const allDayStart = DATE_ONLY.test(input.start);
	const allDayEnd = DATE_ONLY.test(input.end);
	return {
		summary: input.title,
		...(input.location ? { location: input.location } : {}),
		...(input.description ? { description: input.description } : {}),
		start: allDayStart ? { date: input.start } : { dateTime: input.start },
		end: allDayEnd ? { date: input.end } : { dateTime: input.end },
		...(input.attendees?.length ? { attendees: input.attendees.map((email) => ({ email })) } : {}),
	};
}

export function calendarEventPatchBody(input: Partial<AonGoogleCalendarEventInput>): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	if (input.title !== undefined) patch.summary = input.title;
	if (input.location !== undefined) patch.location = input.location;
	if (input.description !== undefined) patch.description = input.description;
	if (input.attendees !== undefined) patch.attendees = input.attendees.map((email) => ({ email }));
	if (input.start !== undefined) patch.start = DATE_ONLY.test(input.start) ? { date: input.start } : { dateTime: input.start };
	if (input.end !== undefined) patch.end = DATE_ONLY.test(input.end) ? { date: input.end } : { dateTime: input.end };
	return patch;
}

export function toCalendarEvent(event: unknown): AonGoogleCalendarEvent | null {
	const e = record(event);
	const id = str(e.id);
	const start = str(record(e.start).dateTime) ?? str(record(e.start).date);
	const end = str(record(e.end).dateTime) ?? str(record(e.end).date);
	if (!id || !start || !end) return null;
	const attendees = arr(e.attendees)
		.map((a) => str(record(a).email))
		.filter((email): email is string => Boolean(email));
	return {
		id,
		title: str(e.summary) ?? '(no title)',
		start,
		end,
		location: str(e.location) ?? null,
		attendees,
		link: str(e.htmlLink) ?? null,
	};
}

/** The Drive query for a full-text search, or for one folder's direct children. */
export function driveSearchQuery(query: string): string {
	const escaped = query.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
	return `trashed = false and fullText contains '${escaped}'`;
}

export function driveFolderQuery(folderId: string): string {
	const escaped = folderId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
	return `trashed = false and '${escaped}' in parents`;
}

export function toDriveFile(file: unknown): AonGoogleDriveFile | null {
	const f = record(file);
	const id = str(f.id);
	const name = str(f.name);
	if (!id || !name) return null;
	return {
		id,
		name,
		mimeType: str(f.mimeType) ?? 'application/octet-stream',
		size: num(f.size) ?? null,
		modifiedTime: str(f.modifiedTime) ?? null,
		webViewLink: str(f.webViewLink) ?? null,
	};
}

/** What a Google-native file exports as, when it has no bytes of its own to download. */
const DRIVE_EXPORTS: Record<string, { mimeType: string }> = {
	'application/vnd.google-apps.document': { mimeType: 'text/plain' },
	'application/vnd.google-apps.spreadsheet': { mimeType: 'text/csv' },
	'application/vnd.google-apps.presentation': { mimeType: 'text/plain' },
};

const TEXT_MIME_RE = /^(text\/|application\/(json|xml|csv))/i;

export function driveReadPlan(
	mimeType: string,
): { kind: 'export'; exportMime: string } | { kind: 'download' } | { kind: 'binary' } {
	const exp = DRIVE_EXPORTS[mimeType];
	if (exp) return { kind: 'export', exportMime: exp.mimeType };
	if (mimeType.startsWith('application/vnd.google-apps.')) return { kind: 'binary' };
	if (TEXT_MIME_RE.test(mimeType)) return { kind: 'download' };
	return { kind: 'binary' };
}

// --- the API calls -----------------------------------------------------------

async function readBody(response: Response): Promise<string> {
	return await response.text().catch(() => '');
}

/**
 * One Google REST call, JSON in, JSON out — as `unknown`, never cast. Not
 * the sync daemon's `gapi`: no retries or backoff, since these are
 * on-demand tool calls, not a scheduled sync, and a failed one should say
 * so at once rather than hold the assistant's turn open.
 */
async function googleJson(token: string, url: string, init: RequestInit = {}): Promise<unknown> {
	let response: Response;
	try {
		response = await fetch(url, {
			...init,
			headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}`, accept: 'application/json' },
			signal: AbortSignal.timeout(30_000),
		});
	} catch (error) {
		throw new Error(`Google: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!response.ok) {
		const body = await readBody(response);
		throw new Error(`Google ${response.status} ${url.split('?')[0]}: ${body.slice(0, 400)}`);
	}
	if (response.status === 204) return {};
	return await response.json().catch(() => ({}));
}

async function googleBytes(token: string, url: string, maxBytes = MAX_BINARY_BYTES): Promise<Buffer> {
	let response: Response;
	try {
		response = await fetch(url, {
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(60_000),
		});
	} catch (error) {
		throw new Error(`Google: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!response.ok) {
		const body = await readBody(response);
		throw new Error(`Google ${response.status} ${url.split('?')[0]}: ${body.slice(0, 400)}`);
	}
	const declared = num(response.headers.get('content-length')) ?? 0;
	if (declared > maxBytes) throw new Error(`that file is ${declared} bytes, over the ${maxBytes} Aon reads`);
	const buffer = Buffer.from(await response.arrayBuffer());
	if (buffer.byteLength > maxBytes) throw new Error(`that file is ${buffer.byteLength} bytes, over the ${maxBytes} Aon reads`);
	return buffer;
}

@Service()
export class AonGoogleService {
	constructor(private readonly auth: AonGoogleAuthService) {}

	async isConfigured(user: User): Promise<boolean> {
		return await this.auth.isConfigured(user);
	}

	// --- mail ---------------------------------------------------------------

	async searchMail(user: User, query: string, limit: number): Promise<AonGoogleThreadSummary[]> {
		const token = await this.auth.accessToken(user);
		const listed = await googleJson(
			token,
			`${GMAIL_API}/threads?${new URLSearchParams({ q: query, maxResults: String(limit) }).toString()}`,
		);
		const ids = arr(record(listed).threads)
			.map((t) => str(record(t).id))
			.filter((id): id is string => Boolean(id));
		const threads = await Promise.all(
			ids.map(
				async (id) =>
					await googleJson(
						token,
						`${GMAIL_API}/threads/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
					),
			),
		);
		return threads.map(toThreadSummary).filter((t): t is AonGoogleThreadSummary => t !== null);
	}

	async readThread(user: User, threadId: string, maxChars: number): Promise<AonGoogleThreadText> {
		const token = await this.auth.accessToken(user);
		const thread = await googleJson(token, `${GMAIL_API}/threads/${encodeURIComponent(threadId)}?format=full`);
		return toThreadText(thread, maxChars);
	}

	async fetchAttachment(user: User, messageId: string, attachmentId: string): Promise<{ data: Buffer }> {
		const token = await this.auth.accessToken(user);
		const attachment = await googleJson(
			token,
			`${GMAIL_API}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
		);
		const data = str(record(attachment).data);
		if (!data) throw new Error('Gmail returned no data for that attachment.');
		return { data: Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64') };
	}

	async createDraft(
		user: User,
		input: { to: string[]; subject: string; body: string; cc?: string[]; replyToThreadId?: string },
	): Promise<AonGoogleSentMail> {
		const token = await this.auth.accessToken(user);
		const from = (await this.auth.status(user)).email ?? undefined;
		const raw = toBase64Url(buildRawMessage({ from, to: input.to, cc: input.cc, subject: input.subject, text: input.body }));
		const message: Record<string, unknown> = { raw };
		if (input.replyToThreadId) message.threadId = input.replyToThreadId;
		const created = await googleJson(token, `${GMAIL_API}/drafts`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ message }),
		});
		const createdMessage = record(record(created).message);
		const id = str(createdMessage.id);
		if (!id) throw new Error('Gmail answered without a draft id.');
		return { id, threadId: str(createdMessage.threadId) ?? null };
	}

	async sendMail(
		user: User,
		input: { to: string[]; subject: string; body: string; cc?: string[]; replyToThreadId?: string },
	): Promise<AonGoogleSentMail> {
		const token = await this.auth.accessToken(user);
		const from = (await this.auth.status(user)).email ?? undefined;
		const raw = toBase64Url(buildRawMessage({ from, to: input.to, cc: input.cc, subject: input.subject, text: input.body }));
		const body: Record<string, unknown> = { raw };
		if (input.replyToThreadId) body.threadId = input.replyToThreadId;
		const sent = await googleJson(token, `${GMAIL_API}/messages/send`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
		const id = str(record(sent).id);
		if (!id) throw new Error('Gmail answered without a message id.');
		return { id, threadId: str(record(sent).threadId) ?? null };
	}

	async labelThread(user: User, input: { threadId: string; add?: string[]; remove?: string[]; markRead?: boolean }): Promise<void> {
		const token = await this.auth.accessToken(user);
		const addLabelIds = await this.resolveLabelIds(token, input.add ?? []);
		const removeLabelIds = await this.resolveLabelIds(token, input.remove ?? []);
		if (input.markRead === true) removeLabelIds.push('UNREAD');
		if (input.markRead === false) addLabelIds.push('UNREAD');
		await googleJson(token, `${GMAIL_API}/threads/${encodeURIComponent(input.threadId)}/modify`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ addLabelIds, removeLabelIds }),
		});
	}

	/** Gmail's modify API wants label IDs; a name he typed (e.g. "Invoices") is looked up, a system id (UNREAD, STARRED…) passes straight through. */
	private async resolveLabelIds(token: string, names: string[]): Promise<string[]> {
		if (names.length === 0) return [];
		const listed = await googleJson(token, `${GMAIL_API}/labels`);
		const byName = new Map<string, string>();
		for (const raw of arr(record(listed).labels)) {
			const label = record(raw);
			const name = str(label.name);
			const id = str(label.id);
			if (name && id) byName.set(name.toLowerCase(), id);
		}
		return names.map((name) => byName.get(name.toLowerCase()) ?? name);
	}

	// --- calendar -------------------------------------------------------------

	async listEvents(user: User, from: string, to: string, calendarId = 'primary'): Promise<AonGoogleCalendarEvent[]> {
		const token = await this.auth.accessToken(user);
		const params = new URLSearchParams({ timeMin: from, timeMax: to, singleEvents: 'true', orderBy: 'startTime' });
		const result = await googleJson(token, `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`);
		return arr(record(result).items)
			.map(toCalendarEvent)
			.filter((e): e is AonGoogleCalendarEvent => e !== null);
	}

	async createEvent(user: User, input: AonGoogleCalendarEventInput, calendarId = 'primary'): Promise<AonGoogleCalendarEvent> {
		const token = await this.auth.accessToken(user);
		const created = await googleJson(token, `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(calendarEventBody(input)),
		});
		const event = toCalendarEvent(created);
		if (!event) throw new Error('Google Calendar answered without a usable event.');
		return event;
	}

	async updateEvent(
		user: User,
		eventId: string,
		input: Partial<AonGoogleCalendarEventInput>,
		calendarId = 'primary',
	): Promise<AonGoogleCalendarEvent> {
		const token = await this.auth.accessToken(user);
		const updated = await googleJson(
			token,
			`${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
			{ method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(calendarEventPatchBody(input)) },
		);
		const event = toCalendarEvent(updated);
		if (!event) throw new Error('Google Calendar answered without a usable event.');
		return event;
	}

	async deleteEvent(user: User, eventId: string, calendarId = 'primary'): Promise<void> {
		const token = await this.auth.accessToken(user);
		await googleJson(token, `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
			method: 'DELETE',
		});
	}

	// --- drive ------------------------------------------------------------

	async searchDrive(user: User, query: string, limit: number): Promise<AonGoogleDriveFile[]> {
		const token = await this.auth.accessToken(user);
		const params = new URLSearchParams({
			q: driveSearchQuery(query),
			fields: 'files(id,name,mimeType,modifiedTime,size,webViewLink)',
			pageSize: String(limit),
		});
		const result = await googleJson(token, `${DRIVE_API}/files?${params.toString()}`);
		return arr(record(result).files)
			.map(toDriveFile)
			.filter((f): f is AonGoogleDriveFile => f !== null);
	}

	async listFolder(user: User, folderId: string): Promise<AonGoogleDriveFile[]> {
		const token = await this.auth.accessToken(user);
		const params = new URLSearchParams({
			q: driveFolderQuery(folderId),
			fields: 'files(id,name,mimeType,modifiedTime,size,webViewLink)',
			pageSize: '200',
			supportsAllDrives: 'true',
			includeItemsFromAllDrives: 'true',
		});
		const result = await googleJson(token, `${DRIVE_API}/files?${params.toString()}`);
		return arr(record(result).files)
			.map(toDriveFile)
			.filter((f): f is AonGoogleDriveFile => f !== null);
	}

	async readFile(user: User, fileId: string, maxChars: number): Promise<AonGoogleDriveContent> {
		const token = await this.auth.accessToken(user);
		const meta = await googleJson(token, `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType&supportsAllDrives=true`);
		const metaRecord = record(meta);
		const name = str(metaRecord.name) ?? fileId;
		const mimeType = str(metaRecord.mimeType) ?? 'application/octet-stream';
		const plan = driveReadPlan(mimeType);
		if (plan.kind === 'binary') {
			return { name, mimeType, text: null, binaryNote: `"${name}" is a binary file (${mimeType}); Aon cannot read it as text.`, truncated: false };
		}
		const url =
			plan.kind === 'export'
				? `${DRIVE_API}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(plan.exportMime)}`
				: `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
		const bytes = await googleBytes(token, url);
		const text = bytes.toString('utf8');
		const truncated = text.length > maxChars;
		return {
			name,
			mimeType: plan.kind === 'export' ? plan.exportMime : mimeType,
			text: truncated ? text.slice(0, maxChars) : text,
			binaryNote: null,
			truncated,
		};
	}

	async createFile(user: User, input: { name: string; mimeType: string; content: string; folderId?: string }): Promise<AonGoogleDriveFile> {
		const token = await this.auth.accessToken(user);
		const boundary = `aon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
		const metadata = { name: input.name, ...(input.folderId ? { parents: [input.folderId] } : {}) };
		const body =
			`--${boundary}\r\n` +
			'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
			`${JSON.stringify(metadata)}\r\n` +
			`--${boundary}\r\n` +
			`Content-Type: ${input.mimeType}\r\n\r\n` +
			`${input.content}\r\n` +
			`--${boundary}--`;
		const created = await googleJson(
			token,
			`${DRIVE_UPLOAD_API}?uploadType=multipart&fields=id,name,mimeType,modifiedTime,size,webViewLink&supportsAllDrives=true`,
			{ method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body },
		);
		const file = toDriveFile(created);
		if (!file) throw new Error('Drive answered without a usable file.');
		return file;
	}

	// --- sheets -------------------------------------------------------------

	async readSheet(user: User, spreadsheetId: string, range: string): Promise<string[][]> {
		const token = await this.auth.accessToken(user);
		const result = await googleJson(token, `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`);
		return arr(record(result).values).map((row) => arr(row).map((cell) => str(cell) ?? (cell === undefined || cell === null ? '' : String(cell))));
	}

	async writeSheet(user: User, spreadsheetId: string, range: string, values: string[][]): Promise<void> {
		const token = await this.auth.accessToken(user);
		await googleJson(
			token,
			`${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
			{ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ range, values }) },
		);
	}
}
