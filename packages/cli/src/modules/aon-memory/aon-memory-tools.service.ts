import type { AonCaptureRequest } from '@n8n/api-types';
import { Service } from '@n8n/di';
import z from 'zod';

import type { RegisterToolFn, ToolDefinition } from '@/modules/mcp/mcp.types';

import { AonCaptureService } from './aon-capture.service';
import { AonMemorySearchService } from './aon-memory-search.service';

const searchSchema = {
	q: z.string().min(1).max(2000).describe('Words, or a question in plain language.'),
	mode: z.enum(['hybrid', 'text', 'vector']).optional().describe('Default hybrid: by words and by meaning together.'),
	limit: z.number().int().min(1).max(30).optional().describe('Default 8.'),
} satisfies z.ZodRawShape;

const captureSchema = {
	title: z.string().max(200).optional().describe('Optional; taken from the text or the page when empty.'),
	text: z.string().max(2_000_000).optional().describe('The text to remember. Give text or url, not both.'),
	url: z.string().max(2000).optional().describe('A public web page to read and remember.'),
	kind: z.string().max(40).optional().describe('text | note | page | mail | decision …'),
} satisfies z.ZodRawShape;

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
const failure = (error: unknown) => ({
	content: [{ type: 'text' as const, text: `Memory: ${error instanceof Error ? error.message : String(error)}` }],
	isError: true,
});

/**
 * Memory as tools of this instance: search what Aon has read, and remember
 * something new. Thin wrappers over the same services the Memory page uses.
 */
@Service()
export class McpAonMemoryToolsService {
	constructor(
		private readonly search: AonMemorySearchService,
		private readonly capture: AonCaptureService,
	) {}

	registerTools(registerIfAllowed: RegisterToolFn) {
		const search: ToolDefinition<typeof searchSchema> = {
			name: 'memory_search',
			config: {
				description:
					"Search Aon's memory: everything he has read, captured or been told, by words and by meaning. Returns the best chunks with their source and date.",
				inputSchema: searchSchema,
				annotations: { title: 'Search memory', readOnlyHint: true },
			},
			handler: async (args) => {
				try {
					const result = await this.search.search({ query: args.q, mode: args.mode ?? 'hybrid', limit: args.limit ?? 8 });
					if (result.hits.length === 0) return text('Nothing in memory matches that.');
					const lines = result.hits.map(
						(h, i) =>
							`${i + 1}. [${h.origin}] ${h.title}${h.docTime ? ` (${h.docTime.slice(0, 10)})` : ''} — source ${h.sourceId}\n${h.text.trim().slice(0, 700)}`,
					);
					return text(`${result.hits.length} hits (${result.mode}${result.embedded ? '' : ', words only'}):\n\n${lines.join('\n\n')}`);
				} catch (error) {
					return failure(error);
				}
			},
		};

		const remember: ToolDefinition<typeof captureSchema> = {
			name: 'memory_capture',
			config: {
				description:
					"Remember something in Aon's memory: a note, a decision, a fact he told you, or a public web page. It is chunked and embedded and searchable within seconds. Use it whenever he says remember, note, or keep this.",
				inputSchema: captureSchema,
				annotations: { title: 'Remember', readOnlyHint: false },
			},
			handler: async (args) => {
				try {
					const request: AonCaptureRequest = { title: args.title, text: args.text, url: args.url, kind: args.kind, origin: 'capture' };
					const result = await this.capture.capture(request);
					return text(
						`Remembered "${result.source.title}" (source ${result.source.id}): ${result.chunks} chunks, ${result.embedded} embedded${result.pending ? `, ${result.pending} still embedding` : ''}.`,
					);
				} catch (error) {
					return failure(error);
				}
			},
		};

		registerIfAllowed(search);
		registerIfAllowed(remember);
	}
}
