import type { AonCaptureRequest, AonFactSummary, AonOwnerModelBuckets } from '@n8n/api-types';
import { Service } from '@n8n/di';
import z from 'zod';

import type { RegisterToolFn, ToolDefinition } from '@/modules/mcp/mcp.types';
import { AonSettingsService } from '@/modules/aon-core/settings/aon-settings.service';

import { AonCaptureService } from './aon-capture.service';
import { AonEntityRepository } from './database/repositories/aon-entity.repository';
import { AonFactRepository } from './database/repositories/aon-fact.repository';
import { AonMemorySearchService } from './aon-memory-search.service';
import { AonObservationRepository } from './database/repositories/aon-observation.repository';

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

const factsSchema = {
	q: z.string().max(200).optional().describe('An entity name; only facts touching it. Empty for all.'),
	status: z.enum(['pending', 'confirmed', 'all']).optional().describe('Default: pending and confirmed, not rejected.'),
	limit: z.number().int().min(1).max(100).optional().describe('Default 20.'),
} satisfies z.ZodRawShape;

const entitySchema = {
	name: z.string().min(1).max(200).describe('The entity to look up, by name or alias.'),
} satisfies z.ZodRawShape;

const OWNER_MODEL_BUCKETS = ['identity', 'people', 'projects', 'preferences', 'commitments'] as const;

const aboutMeSchema = {
	bucket: z
		.enum(OWNER_MODEL_BUCKETS)
		.optional()
		.describe('One bucket of the model of him; all five when omitted.'),
} satisfies z.ZodRawShape;

const contextSchema = {
	topic: z.string().min(1).max(200).describe('A person, project or question to brief on.'),
	limit: z.number().int().min(1).max(8).optional().describe('Default 5.'),
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
		private readonly entities: AonEntityRepository,
		private readonly facts: AonFactRepository,
		private readonly observations: AonObservationRepository,
		private readonly settings: AonSettingsService,
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

		const facts: ToolDefinition<typeof factsSchema> = {
			name: 'memory_facts',
			config: {
				description:
					"Facts in Aon's memory: claims connecting entities, extracted from what he has read and either still pending his decision or already confirmed. Give a name to see only facts touching that entity.",
				inputSchema: factsSchema,
				annotations: { title: 'Facts', readOnlyHint: true },
			},
			handler: async (args) => {
				try {
					let entityId: string | undefined;
					if (args.q) {
						const entity = await this.entities.findByNameOrAlias(args.q);
						if (!entity) return text(`No entity matches "${args.q}".`);
						entityId = entity.id;
					}
					const limit = args.limit ?? 20;
					const result = await this.facts.list({ entityId, limit: Math.min(limit * 3, 300), offset: 0 });
					const wanted = args.status;
					const filtered = result.items
						.filter((f) => (wanted === 'all' ? true : wanted ? f.status === wanted : f.status !== 'rejected'))
						.slice(0, limit);
					if (filtered.length === 0) return text('No facts match that.');
					return text(filtered.map(factLine).join('\n'));
				} catch (error) {
					return failure(error);
				}
			},
		};

		const entity: ToolDefinition<typeof entitySchema> = {
			name: 'memory_entity',
			config: {
				description:
					"One entity in Aon's memory: its kind, aliases, summary, the facts that name it, and where it was read about. Look someone or something up by name before asking what Aon knows about them.",
				inputSchema: entitySchema,
				annotations: { title: 'Entity', readOnlyHint: true },
			},
			handler: async (args) => {
				try {
					const found = await this.entities.findByNameOrAlias(args.name);
					const detail = found ? await this.entities.findDetail(found.id) : null;
					if (!detail) return text(`No entity named "${args.name}".`);
					const lines = [
						`${detail.name} (${detail.kind})${detail.aliases.length ? ` — aka ${detail.aliases.join(', ')}` : ''}`,
						detail.summary?.trim() || '(no summary)',
						'',
						`Facts (${detail.facts.length}):`,
						...(detail.facts.length ? detail.facts.slice(0, 30).map(factLine) : ['(none)']),
						'',
						`Mentioned in: ${detail.mentionedIn.length ? detail.mentionedIn.map((m) => m.title).join(', ') : '(nothing)'}`,
					];
					return text(lines.join('\n'));
				} catch (error) {
					return failure(error);
				}
			},
		};

		const aboutMe: ToolDefinition<typeof aboutMeSchema> = {
			name: 'memory_about_me',
			config: {
				description:
					'Who he is: the model of him the nightly dream keeps, in five buckets (identity, people, projects, preferences, commitments). Call this to know who he is; call memory_context before advising on his life, people or projects.',
				inputSchema: aboutMeSchema,
				annotations: { title: 'The model of him', readOnlyHint: true },
			},
			handler: async (args) => {
				try {
					const model = await this.settings.modelOfOwner();
					if (!model?.updatedAt) return text('The model of him is empty: no dream has run yet.');
					const stamp = `as of ${model.updatedAt.slice(0, 10)}`;
					if (args.bucket) {
						const value = model.buckets[args.bucket];
						return text(value.trim() ? `${args.bucket} (${stamp}):\n${value}` : `Nothing yet in ${args.bucket} (${stamp}).`);
					}
					const lines = OWNER_MODEL_BUCKETS.map(
						(bucket) => `${bucket.toUpperCase()}:\n${model.buckets[bucket].trim() || '(empty)'}`,
					);
					return text(`The model of him, ${stamp}:\n\n${lines.join('\n\n')}`);
				} catch (error) {
					return failure(error);
				}
			},
		};

		const context: ToolDefinition<typeof contextSchema> = {
			name: 'memory_context',
			config: {
				description:
					"A brief on a topic before acting: the model of him where it mentions the topic, the best memory hits, matching entities with their confirmed facts, and observations that touch it. Call this before advising on his life, people or projects.",
				inputSchema: contextSchema,
				annotations: { title: 'Context brief', readOnlyHint: true },
			},
			handler: async (args) => {
				try {
					const topic = args.topic.trim();
					const lower = topic.toLowerCase();
					const limit = args.limit ?? 5;

					const [model, searchResult, entityMatches, observations] = await Promise.all([
						this.settings.modelOfOwner(),
						this.search.search({ query: topic, mode: 'hybrid', limit }),
						this.entities.list({ q: topic, limit: 3, offset: 0 }),
						this.observations.list(200),
					]);

					const modelHits: Array<{ bucket: keyof AonOwnerModelBuckets; value: string }> = model
						? OWNER_MODEL_BUCKETS.filter((bucket) => model.buckets[bucket].toLowerCase().includes(lower)).map(
								(bucket) => ({ bucket, value: model.buckets[bucket] }),
							)
						: [];
					const entityDetails = await Promise.all(
						entityMatches.items.map((e) => this.entities.findDetail(e.id)),
					);
					const matchingObservations = observations
						.filter((o) => o.text.toLowerCase().includes(lower))
						.slice(0, limit);

					const lines: string[] = [`Context on "${topic}":`];
					if (modelHits.length) {
						lines.push('', 'From the model of him:');
						for (const { bucket, value } of modelHits) lines.push(`- ${bucket}: ${value.slice(0, 400)}`);
					}
					if (searchResult.hits.length) {
						lines.push('', 'Memory hits:');
						for (const h of searchResult.hits) {
							lines.push(
								`- [${h.origin}] ${h.title}${h.docTime ? ` (${h.docTime.slice(0, 10)})` : ''}: ${h.text.trim().slice(0, 300)}`,
							);
						}
					}
					for (const detail of entityDetails) {
						if (!detail) continue;
						const confirmed = detail.facts.filter((f) => f.status === 'confirmed');
						lines.push('', `${detail.name} (${detail.kind}):`);
						if (confirmed.length) for (const f of confirmed.slice(0, limit)) lines.push(factLine(f));
						else lines.push('- (no confirmed facts yet)');
					}
					if (matchingObservations.length) {
						lines.push('', 'Observations:');
						for (const o of matchingObservations) lines.push(`- (${o.bucket}) ${o.text}`);
					}

					const brief = lines.join('\n').slice(0, 3000);
					if (lines.length === 1) return text(`Nothing in memory speaks to "${topic}" yet.`);
					return text(brief);
				} catch (error) {
					return failure(error);
				}
			},
		};

		registerIfAllowed(search);
		registerIfAllowed(remember);
		registerIfAllowed(facts);
		registerIfAllowed(entity);
		registerIfAllowed(aboutMe);
		registerIfAllowed(context);
	}
}

function factLine(f: AonFactSummary): string {
	return `${f.subject} — ${f.predicate} — ${f.object} (${f.status}${f.sourceTitle ? `, source: ${f.sourceTitle}` : ''})`;
}
