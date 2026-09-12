import { describe, it, expect } from 'vitest';

import {
	gmailHeader,
	parseAddress,
	parseAddressList,
	isUnread,
	messageBodyText,
	collectAttachments,
	toThreadSummary,
	toThreadText,
	buildRawMessage,
	headerValue,
	mailboxAddress,
	toBase64Url,
	calendarEventBody,
	calendarEventPatchBody,
	toCalendarEvent,
	driveSearchQuery,
	driveFolderQuery,
	toDriveFile,
	driveReadPlan,
} from '../aon-google.service';

describe('gmailHeader', () => {
	it('matches case-insensitively', () => {
		expect(gmailHeader([{ name: 'From', value: 'a@b.com' }], 'from')).toBe('a@b.com');
	});

	it('is null when absent or malformed', () => {
		expect(gmailHeader(undefined, 'From')).toBeNull();
		expect(gmailHeader('not an array', 'From')).toBeNull();
		expect(gmailHeader([{ name: 'From' }], 'From')).toBeNull();
	});
});

describe('parseAddress / parseAddressList', () => {
	it('reads the bare address out of a display name', () => {
		expect(parseAddress('Yoan Bonev <y@x.com>')).toBe('y@x.com');
		expect(parseAddress('plain@x.com')).toBe('plain@x.com');
		expect(parseAddress(null)).toBeNull();
	});

	it('splits on commas that separate addresses, not the one inside a quoted display name', () => {
		expect(parseAddressList('"Bonev, Yoan" <y@x.com>, b@x.com')).toEqual(['y@x.com', 'b@x.com']);
	});

	it('dedupes', () => {
		expect(parseAddressList('a@x.com, a@x.com')).toEqual(['a@x.com']);
	});
});

describe('isUnread', () => {
	it('is true only when UNREAD is present', () => {
		expect(isUnread(['UNREAD', 'INBOX'])).toBe(true);
		expect(isUnread(['INBOX'])).toBe(false);
	});
});

describe('messageBodyText', () => {
	it('prefers text/plain', () => {
		const payload = {
			mimeType: 'multipart/alternative',
			parts: [
				{ mimeType: 'text/plain', body: { data: toBase64Url('hello plain') } },
				{ mimeType: 'text/html', body: { data: toBase64Url('<p>hello html</p>') } },
			],
		};
		expect(messageBodyText(payload)).toBe('hello plain');
	});

	it('falls back to text/html turned into text', () => {
		const payload = { mimeType: 'text/html', body: { data: toBase64Url('<p>only html</p>') } };
		expect(messageBodyText(payload)).toBe('only html');
	});

	it('never reads a part that carries a filename as body text', () => {
		const payload = { mimeType: 'text/plain', filename: 'invoice.txt', body: { data: toBase64Url('not body text') } };
		expect(messageBodyText(payload)).toBe('');
	});

	it('caps at max chars', () => {
		const payload = { mimeType: 'text/plain', body: { data: toBase64Url('x'.repeat(50)) } };
		expect(messageBodyText(payload, 10)).toBe(`${'x'.repeat(10)}\n…(cut)`);
	});
});

describe('collectAttachments', () => {
	it('walks nested parts and collects every filename with an attachmentId', () => {
		const payload = {
			parts: [
				{ mimeType: 'text/plain', body: { data: 'x' } },
				{
					mimeType: 'multipart/mixed',
					parts: [{ filename: 'invoice.pdf', mimeType: 'application/pdf', body: { attachmentId: 'att1', size: 1234 } }],
				},
			],
		};
		expect(collectAttachments('msg1', payload)).toEqual([
			{ name: 'invoice.pdf', mimeType: 'application/pdf', size: 1234, attachmentId: 'att1', messageId: 'msg1' },
		]);
	});

	it('skips a part with no filename or no attachmentId', () => {
		const payload = { parts: [{ mimeType: 'image/png', body: { data: 'x' } }] };
		expect(collectAttachments('msg1', payload)).toEqual([]);
	});
});

describe('toThreadSummary', () => {
	it('takes the subject from the first message and sender/date/snippet/labels from the last', () => {
		const thread = {
			id: 't1',
			messages: [
				{ labelIds: ['INBOX'], payload: { headers: [{ name: 'Subject', value: 'Hello' }] } },
				{
					labelIds: ['INBOX', 'UNREAD'],
					snippet: 'a snippet',
					internalDate: '1700000000000',
					payload: { headers: [{ name: 'From', value: 'Alice <a@x.com>' }] },
				},
			],
		};
		expect(toThreadSummary(thread)).toEqual({
			id: 't1',
			subject: 'Hello',
			from: 'a@x.com',
			date: new Date(1700000000000).toISOString(),
			snippet: 'a snippet',
			unread: true,
			labels: ['INBOX', 'UNREAD'],
		});
	});

	it('is null for a thread with no messages or no id', () => {
		expect(toThreadSummary({ id: 't1', messages: [] })).toBeNull();
		expect(toThreadSummary({ messages: [{ payload: {} }] })).toBeNull();
	});
});

describe('toThreadText', () => {
	it('renders every message and collects attachments across the whole thread', () => {
		const thread = {
			messages: [
				{
					id: 'm1',
					internalDate: '1700000000000',
					payload: {
						headers: [
							{ name: 'Subject', value: 'Invoice' },
							{ name: 'From', value: 'a@x.com' },
							{ name: 'To', value: 'b@x.com' },
						],
						parts: [
							{ mimeType: 'text/plain', body: { data: toBase64Url('body one') } },
							{ filename: 'invoice.pdf', mimeType: 'application/pdf', body: { attachmentId: 'att1', size: 99 } },
						],
					},
				},
			],
		};
		const result = toThreadText(thread, 1000);
		expect(result.subject).toBe('Invoice');
		expect(result.messages).toEqual([{ from: 'a@x.com', to: ['b@x.com'], date: new Date(1700000000000).toISOString(), body: 'body one' }]);
		expect(result.attachments).toEqual([{ name: 'invoice.pdf', mimeType: 'application/pdf', size: 99, attachmentId: 'att1', messageId: 'm1' }]);
	});
});

describe('headerValue / mailboxAddress (header injection)', () => {
	it('rejects a CRLF or NUL anywhere in the value', () => {
		expect(() => headerValue('fine')).not.toThrow();
		expect(() => headerValue('line one\r\nBcc: evil@x.com')).toThrow();
		expect(() => headerValue('line one\nBcc: evil@x.com')).toThrow();
		expect(() => headerValue('null\0byte')).toThrow();
	});

	it('accepts a bare address or a display-name form', () => {
		expect(mailboxAddress('a@x.com')).toBe('a@x.com');
		expect(mailboxAddress('Alice <a@x.com>')).toBe('Alice <a@x.com>');
	});

	it('rejects a value that is not a mailbox at all', () => {
		expect(() => mailboxAddress('not-an-address')).toThrow();
		expect(() => mailboxAddress('')).toThrow();
	});

	it('rejects an address carrying an injected header', () => {
		expect(() => mailboxAddress('a@x.com\r\nBcc: evil@x.com')).toThrow();
	});
});

describe('buildRawMessage', () => {
	it('builds a message with the given headers', () => {
		const raw = buildRawMessage({ from: 'me@x.com', to: ['a@x.com'], subject: 'Hi', text: 'body' });
		expect(raw).toContain('From: me@x.com');
		expect(raw).toContain('To: a@x.com');
		expect(raw).toContain('Subject: Hi');
	});

	it('omits the From line when none is given, so Gmail fills in the authenticated address', () => {
		const raw = buildRawMessage({ to: ['a@x.com'], subject: 'Hi', text: 'body' });
		expect(raw).not.toContain('From:');
	});

	it('throws on a subject carrying a CRLF injection instead of writing it into the message', () => {
		expect(() => buildRawMessage({ to: ['a@x.com'], subject: 'Hi\r\nBcc: evil@x.com', text: 'body' })).toThrow();
	});

	it('throws when a "to" address carries an injected header', () => {
		expect(() => buildRawMessage({ to: ['a@x.com\r\nBcc: evil@x.com'], subject: 'Hi', text: 'body' })).toThrow();
	});

	it('throws when "to" is empty', () => {
		expect(() => buildRawMessage({ to: [], subject: 'Hi', text: 'body' })).toThrow();
	});

	it('throws when there are more than 20 recipients', () => {
		const to = Array.from({ length: 21 }, (_, i) => `a${i}@x.com`);
		expect(() => buildRawMessage({ to, subject: 'Hi', text: 'body' })).toThrow();
	});

	it('throws on an inReplyTo carrying an injection', () => {
		expect(() => buildRawMessage({ to: ['a@x.com'], subject: 'Hi', text: 'body', inReplyTo: '<id>\r\nBcc: evil@x.com' })).toThrow();
	});
});

describe('calendarEventBody / calendarEventPatchBody', () => {
	it('uses dateTime for a timed event and date for an all-day one', () => {
		expect(calendarEventBody({ title: 'Sync', start: '2026-09-12T10:00:00+03:00', end: '2026-09-12T11:00:00+03:00' })).toMatchObject({
			start: { dateTime: '2026-09-12T10:00:00+03:00' },
			end: { dateTime: '2026-09-12T11:00:00+03:00' },
		});
		expect(calendarEventBody({ title: 'Off', start: '2026-09-12', end: '2026-09-13' })).toMatchObject({
			start: { date: '2026-09-12' },
			end: { date: '2026-09-13' },
		});
	});

	it('maps attendees to {email} objects only when given', () => {
		expect(calendarEventBody({ title: 'x', start: '2026-09-12', end: '2026-09-13', attendees: ['a@x.com'] })).toMatchObject({
			attendees: [{ email: 'a@x.com' }],
		});
		expect(calendarEventBody({ title: 'x', start: '2026-09-12', end: '2026-09-13' })).not.toHaveProperty('attendees');
	});

	it('patch only sets the fields given', () => {
		expect(calendarEventPatchBody({ title: 'New title' })).toEqual({ summary: 'New title' });
		expect(calendarEventPatchBody({ start: '2026-09-12T10:00:00Z' })).toEqual({ start: { dateTime: '2026-09-12T10:00:00Z' } });
	});
});

describe('toCalendarEvent', () => {
	it('reads a timed and an all-day event', () => {
		expect(
			toCalendarEvent({
				id: 'e1',
				summary: 'Sync',
				start: { dateTime: '2026-09-12T10:00:00Z' },
				end: { dateTime: '2026-09-12T11:00:00Z' },
				attendees: [{ email: 'a@x.com' }],
				htmlLink: 'https://calendar.google.com/e1',
			}),
		).toEqual({
			id: 'e1',
			title: 'Sync',
			start: '2026-09-12T10:00:00Z',
			end: '2026-09-12T11:00:00Z',
			location: null,
			attendees: ['a@x.com'],
			link: 'https://calendar.google.com/e1',
		});
	});

	it('is null when it has no id or no usable start/end', () => {
		expect(toCalendarEvent({ summary: 'x' })).toBeNull();
		expect(toCalendarEvent({ id: 'e1' })).toBeNull();
	});
});

describe('driveSearchQuery / driveFolderQuery', () => {
	it('escapes a single quote in the query', () => {
		expect(driveSearchQuery("o'brien")).toBe(`trashed = false and fullText contains 'o\\'brien'`);
	});

	it('builds a folder-children query', () => {
		expect(driveFolderQuery('abc123')).toBe(`trashed = false and 'abc123' in parents`);
	});
});

describe('toDriveFile', () => {
	it('reads the fields it needs and defaults the rest', () => {
		expect(toDriveFile({ id: 'f1', name: 'doc.txt' })).toEqual({
			id: 'f1',
			name: 'doc.txt',
			mimeType: 'application/octet-stream',
			size: null,
			modifiedTime: null,
			webViewLink: null,
		});
	});

	it('is null without an id or a name', () => {
		expect(toDriveFile({ name: 'doc.txt' })).toBeNull();
		expect(toDriveFile({ id: 'f1' })).toBeNull();
	});
});

describe('driveReadPlan', () => {
	it('exports a Google Doc as text/plain and a Sheet as CSV', () => {
		expect(driveReadPlan('application/vnd.google-apps.document')).toEqual({ kind: 'export', exportMime: 'text/plain' });
		expect(driveReadPlan('application/vnd.google-apps.spreadsheet')).toEqual({ kind: 'export', exportMime: 'text/csv' });
	});

	it('downloads a plain text mime type', () => {
		expect(driveReadPlan('text/markdown')).toEqual({ kind: 'download' });
		expect(driveReadPlan('application/json')).toEqual({ kind: 'download' });
	});

	it('refuses a binary mime type', () => {
		expect(driveReadPlan('image/png')).toEqual({ kind: 'binary' });
		expect(driveReadPlan('application/vnd.google-apps.folder')).toEqual({ kind: 'binary' });
	});
});
