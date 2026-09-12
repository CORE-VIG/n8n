import type { AonCaptureRequest, AonGuardIdentity, AonMemorySkyCategory } from '@n8n/api-types';
import type { User } from '@n8n/db';
import { Service } from '@n8n/di';
import z from 'zod';

import { AonGuardService } from '@/modules/aon-core/guard/aon-guard.service';
import { AON_OP_CLASSES } from '@/modules/aon-core/guard/op-classes';
import { identityFromRequest } from '@/modules/aon-core/guard/request-identity';
import type { RegisterToolFn, ToolDefinition } from '@/modules/mcp/mcp.types';

import { AonCaptureService } from './aon-capture.service';
import { AonDreamService } from './aon-dream.service';
import { AonEmbedService } from './aon-embed.service';
import { AonGraphService } from './aon-graph.service';
import { AonChunkRepository } from './database/repositories/aon-chunk.repository';
import { AonEntityRepository } from './database/repositories/aon-entity.repository';
import { AonFactRepository } from './database/repositories/aon-fact.repository';
import { AonObservationRepository } from './database/repositories/aon-observation.repository';
import { AonSourceRepository } from './database/repositories/aon-source.repository';

const SOURCES_DEFAULT = 20;
const SOURCES_MAX = 50;
const ENTITIES_DEFAULT = 20;
const ENTITIES_MAX = 100;
const OBSERVATIONS_SHOWN = 100;
const CHUNKS_SHOWN_MAX = 40;
const CHUNK_TEXT_MAX = 1500;
const GRAPH_LIMIT_MAX = 200;
const GRAPH_DEPTH_MAX = 3;

const factDecideSchema = {
	factId: z.string().min(1).max(100),
	status: z.enum(['confirmed', 'rejected']),
	note: z.string().max(2000).optional(),
} satisfies z.ZodRawShape;

const pageWriteSchema = {
	title: z.string().min(1).max(200).describe('The page to create or replace, matched by exact title.'),
	text: z.string().min(1).max(2_000_000),
	kind: z.string().max(40).optional().describe('Default "page".'),
} satisfies z.ZodRawShape;

const pagesSchema = {
	q: z.string().max(200).optional().describe('Only pages whose title contains this. Empty for all.'),
	limit: z.number().int().min(1).max(100).optional().describe('Default 20.'),
} satisfies z.ZodRawShape;

const overviewSchema = {} satisfies z.ZodRawShape;

const sourcesSchema = {
	q: z.string().max(200).optional().describe('Only sources whose title contains this.'),
	kind: z.string().max(40).optional().describe('text | page | mail | note | decision …'),
	origin: z.string().max(40).optional().describe('capture | page | mail | dream …'),
	limit: z.number().int().min(1).max(SOURCES_MAX).optional().describe(`Default ${SOURCES_DEFAULT}, up to ${SOURCES_MAX}.`),
	offset: z.number().int().min(0).optional().describe('Default 0.'),
} satisfies z.ZodRawShape;

const sourceSchema = {
	id: z.string().min(1).max(100),
	withChunks: z.boolean().optional().describe(`Include its chunks (up to ${CHUNKS_SHOWN_MAX}, ${CHUNK_TEXT_MAX} characters each). Default false.`),
} satisfies z.ZodRawShape;

const sourceDeleteSchema = {
	id: z.string().min(1).max(100),
} satisfies z.ZodRawShape;

const graphSchema = {
	focus: z.string().max(200).optional().describe('An entity id to centre the graph on. Empty for the whole neighbourhood.'),
	depth: z.number().int().min(1).max(GRAPH_DEPTH_MAX).optional().describe('How many hops from the focus. Default 2.'),
	limit: z.number().int().min(1).max(GRAPH_LIMIT_MAX).optional().describe('Default 150.'),
} satisfies z.ZodRawShape;

const skySchema = {} satisfies z.ZodRawShape;

const entitiesSchema = {
	q: z.string().max(200).optional().describe('Only entities whose name or an alias contains this.'),
	kind: z.string().max(40).optional().describe('person | project | company | place …'),
	limit: z.number().int().min(1).max(ENTITIES_MAX).optional().describe(`Default ${ENTITIES_DEFAULT}, up to ${ENTITIES_MAX}.`),
	offset: z.number().int().min(0).optional().describe('Default 0.'),
} satisfies z.ZodRawShape;

const observationsSchema = {} satisfies z.ZodRawShape;

const dreamRunSchema = {} satisfies z.ZodRawShape;

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
const failure = (error: unknown) => ({
	content: [{ type: 'text' as const, text: `Memory: ${error instanceof Error ? error.message : String(error)}` }],
	isError: true,
});
const ownerOnly = () => ({ content: [{ type: 'text' as const, text: 'Only the owner does that in memory.' }], isError: true });

function skyCategoryLine(c: AonMemorySkyCategory): string {
	return `- ${c.group} ${c.name}: ${c.count}`;
}

/**
 * The rest of memory as tools: deciding a pending fact (the owner's own
 * call, never an agent's), pages — owner-authored sources of kind `page` —
 * and everything the Memory page shows and does beyond search and capture:
 * the overview numbers, browsing and forgetting sources, the entity/fact
 * graph and its sky, the entity list, observations, and running the dream
 * now.
 */
@Service()
export class McpAonMemoryExtraToolsService {
	constructor(
		private readonly facts: AonFactRepository,
		private readonly sources: AonSourceRepository,
		private readonly capture: AonCaptureService,
		private readonly guard: AonGuardService,
		private readonly chunks: AonChunkRepository,
		private readonly embedder: AonEmbedService,
		private readonly entities: AonEntityRepository,
		private readonly observations: AonObservationRepository,
		private readonly graph: AonGraphService,
		private readonly dream: AonDreamService,
	) {}

	private guardLabel(opClass: string): string {
		return AON_OP_CLASSES.find((c) => c.opClass === opClass)?.label ?? opClass;
	}

	/** Guard's verdict for one call: `deny` refuses, `ask` raises a card and returns the stop-and-wait text; `allow` records and returns null so the handler proceeds. */
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
		const factDecide: ToolDefinition<typeof factDecideSchema> = {
			name: 'memory_fact_decide',
			config: {
				description:
					'Confirm or reject a pending fact in memory, as the owner. Only the owner decides facts; an agent that calls this is refused.',
				inputSchema: factDecideSchema,
				annotations: { title: 'Decide a fact', readOnlyHint: false, destructiveHint: false },
			},
			handler: async (args, extra) => {
				try {
					const identity = identityFromRequest(extra, user);
					if (identity.kind !== 'owner') {
						return { content: [{ type: 'text' as const, text: 'Only the owner decides facts.' }], isError: true };
					}
					const decided = await this.facts.decide(args.factId, args.status, user.email, args.note);
					if (!decided) return text(`There is no fact with id ${args.factId}.`);
					return text(`Fact ${decided.id} is now ${decided.status}: ${decided.subject} — ${decided.predicate} — ${decided.object}.`);
				} catch (error) {
					return failure(error);
				}
			},
		};

		const pageWrite: ToolDefinition<typeof pageWriteSchema> = {
			name: 'memory_page_write',
			config: {
				description:
					'Write a page into memory: an owner-authored source, upserted by exact title. A second write with the same title replaces the first rather than duplicating it.',
				inputSchema: pageWriteSchema,
				annotations: { title: 'Write a page', readOnlyHint: false, destructiveHint: false },
			},
			handler: async (args, extra) => {
				try {
					const identity = identityFromRequest(extra, user);
					const blocked = await this.guarded(identity, 'memory_page_write', args, `Write page: ${args.title}.`);
					if (blocked) return blocked;

					const kind = args.kind?.trim() || 'page';
					const existing = await this.sources.findByTitleAndKind(args.title, kind);
					if (existing && identity.kind !== 'owner') {
						return {
							content: [
								{
									type: 'text' as const,
									text: `A page called "${args.title}" exists; only the owner replaces a page.`,
								},
							],
							isError: true,
						};
					}
					if (existing) await this.sources.deleteById(existing.id);
					const request: AonCaptureRequest = { title: args.title, text: args.text, kind, origin: 'page' };
					const result = await this.capture.capture(request);
					return text(
						`Wrote page "${result.source.title}" (source ${result.source.id}): ${result.chunks} chunks, ${result.embedded} embedded.`,
					);
				} catch (error) {
					return failure(error);
				}
			},
		};

		const pages: ToolDefinition<typeof pagesSchema> = {
			name: 'memory_pages',
			config: {
				description: 'Owner-authored pages in memory, newest first; filter by a word in the title.',
				inputSchema: pagesSchema,
				annotations: { title: 'List pages', readOnlyHint: true },
			},
			handler: async (args) => {
				try {
					const rows = await this.sources.listByKind('page', args.q, args.limit ?? 20);
					if (rows.length === 0) return text('No pages match that.');
					return text(rows.map((r) => `- ${r.title} (source ${r.id})${r.updatedAt ? `, updated ${r.updatedAt}` : ''}`).join('\n'));
				} catch (error) {
					return failure(error);
				}
			},
		};

		const overview: ToolDefinition<typeof overviewSchema> = {
			name: 'memory_overview',
			config: {
				description: 'The Memory page in one call: how many sources, chunks and embedded chunks, sources by origin, when memory was last indexed, and whether vector search is on.',
				inputSchema: overviewSchema,
				annotations: { title: 'Memory overview', readOnlyHint: true },
			},
			handler: async () => {
				try {
					const [sourceCount, chunkCount, embeddedCount, byOrigin, lastIndexedAt] = await Promise.all([
						this.sources.countAll(),
						this.chunks.countAll(),
						this.chunks.countEmbedded(),
						this.sources.countByOrigin(8),
						this.sources.lastIndexedAt(),
					]);
					const originLine = byOrigin.map((o) => `${o.origin} ${o.count}`).join(', ');
					return text(
						`${sourceCount} source(s), ${chunkCount} chunk(s), ${embeddedCount} embedded. Vector search ${this.embedder.enabled ? 'on' : 'off'}. Last indexed ${lastIndexedAt ?? 'never'}.${originLine ? `\nBy origin: ${originLine}` : ''}`,
					);
				} catch (error) {
					return failure(error);
				}
			},
		};

		const sourcesList: ToolDefinition<typeof sourcesSchema> = {
			name: 'memory_sources',
			config: {
				description: 'Sources in memory, newest first: filter by a word in the title, its kind, or its origin.',
				inputSchema: sourcesSchema,
				annotations: { title: 'List sources', readOnlyHint: true },
			},
			handler: async (args) => {
				try {
					const limit = Math.min(args.limit ?? SOURCES_DEFAULT, SOURCES_MAX);
					const result = await this.sources.listSources({
						q: args.q,
						kind: args.kind,
						origin: args.origin,
						limit,
						offset: args.offset ?? 0,
					});
					if (result.items.length === 0) return text('No sources match that.');
					const lines = result.items.map(
						(s) =>
							`- [${s.id}] ${s.title} (${s.kind}, ${s.origin}, ${s.status}), ${s.chunkCount} chunk(s)${s.docTime ? `, dated ${s.docTime.slice(0, 10)}` : ''}`,
					);
					return text(`${result.total} source(s) total, showing ${result.items.length}:\n${lines.join('\n')}`);
				} catch (error) {
					return failure(error);
				}
			},
		};

		const source: ToolDefinition<typeof sourceSchema> = {
			name: 'memory_source',
			config: {
				description: 'One source in memory: its title, kind, origin, status and, when asked, its chunks.',
				inputSchema: sourceSchema,
				annotations: { title: 'Read a source', readOnlyHint: true },
			},
			handler: async (args) => {
				try {
					const detail = await this.sources.findDetail(args.id);
					if (!detail) return text(`There is no source with id ${args.id}.`);
					const lines = [
						`${detail.title} (${detail.id})`,
						`${detail.kind}, origin ${detail.origin}, status ${detail.status}, ${detail.chunkCount} chunk(s), ${detail.embeddedCount} embedded`,
						detail.docTime ? `Dated ${detail.docTime}` : null,
						`Indexed ${detail.indexedAt ?? 'not yet'}`,
					].filter((l): l is string => Boolean(l));
					if (args.withChunks) {
						const shown = detail.chunks.slice(0, CHUNKS_SHOWN_MAX);
						lines.push(
							'',
							`Chunks (${shown.length} of ${detail.chunks.length}):`,
							...shown.map((c) => `[${c.seq}] ${c.text.slice(0, CHUNK_TEXT_MAX)}${c.text.length > CHUNK_TEXT_MAX ? '…' : ''}`),
						);
					}
					return text(lines.join('\n'));
				} catch (error) {
					return failure(error);
				}
			},
		};

		const sourceDelete: ToolDefinition<typeof sourceDeleteSchema> = {
			name: 'memory_source_delete',
			config: {
				description: 'Forget a source and its chunks, for good. Only the owner forgets a source.',
				inputSchema: sourceDeleteSchema,
				annotations: { title: 'Forget a source', readOnlyHint: false, destructiveHint: true },
			},
			handler: async (args, extra) => {
				try {
					const identity = identityFromRequest(extra, user);
					if (identity.kind !== 'owner') return ownerOnly();
					const blocked = await this.guarded(identity, 'memory_source_delete', args, `Forget source ${args.id}.`);
					if (blocked) return blocked;
					const existing = await this.sources.findDetail(args.id);
					if (!existing) return text(`There is no source with id ${args.id}.`);
					await this.sources.deleteById(args.id);
					return text(`Forgot "${existing.title}" (source ${args.id}).`);
				} catch (error) {
					return failure(error);
				}
			},
		};

		const graph: ToolDefinition<typeof graphSchema> = {
			name: 'memory_graph',
			config: {
				description: 'The entity/fact graph: the whole neighbourhood, or a BFS around one focus entity, as nodes, edges and clusters.',
				inputSchema: graphSchema,
				annotations: { title: 'Memory graph', readOnlyHint: true },
			},
			handler: async (args) => {
				try {
					const result = await this.graph.graph({ focus: args.focus, depth: args.depth, limit: args.limit });
					if (!result) return text(`There is no entity with id ${args.focus}.`);
					if (result.nodes.length === 0) return text('The graph is empty.');
					const nodeLines = result.nodes.map((n) => `- [${n.id}] ${n.label} (${n.kind}, weight ${n.weight}, cluster ${n.cluster})`);
					const edgeLines = result.edges.map((e) => `- ${e.from} —${e.label}→ ${e.to} (${e.status})`);
					return text(
						`${result.nodes.length} node(s), ${result.edges.length} edge(s)${result.truncated ? ' (truncated)' : ''}${result.focus ? `, focused on ${result.focus}` : ''}:\n\nNodes:\n${nodeLines.join('\n')}\n\nEdges:\n${edgeLines.join('\n') || '(none)'}`,
					);
				} catch (error) {
					return failure(error);
				}
			},
		};

		const sky: ToolDefinition<typeof skySchema> = {
			name: 'memory_sky',
			config: {
				description: 'The Memory page\'s sky overview: core weight and category counts by origin, kind, entity and fact.',
				inputSchema: skySchema,
				annotations: { title: 'Memory sky', readOnlyHint: true },
			},
			handler: async () => {
				try {
					const result = await this.graph.sky();
					return text(
						`core ${result.core}, ${result.sources} source(s), ${result.entities} entities, ${result.facts} facts, ${result.observations} observation(s)\n${result.categories.map(skyCategoryLine).join('\n')}`,
					);
				} catch (error) {
					return failure(error);
				}
			},
		};

		const entitiesList: ToolDefinition<typeof entitiesSchema> = {
			name: 'memory_entities',
			config: {
				description: 'Entities in memory, most mentioned first; filter by a word in the name or an alias, and by kind.',
				inputSchema: entitiesSchema,
				annotations: { title: 'List entities', readOnlyHint: true },
			},
			handler: async (args) => {
				try {
					const limit = Math.min(args.limit ?? ENTITIES_DEFAULT, ENTITIES_MAX);
					const { items, total } = await this.entities.list({ q: args.q, kind: args.kind, limit, offset: args.offset ?? 0 });
					if (items.length === 0) return text('No entities match that.');
					const lines = items.map((e) => `- [${e.id}] ${e.name} (${e.kind}), ${e.factCount} fact(s)`);
					return text(`${total} entit${total === 1 ? 'y' : 'ies'} total, showing ${items.length}:\n${lines.join('\n')}`);
				} catch (error) {
					return failure(error);
				}
			},
		};

		const observationsList: ToolDefinition<typeof observationsSchema> = {
			name: 'memory_observations',
			config: {
				description: 'Observations memory has kept: short notes by bucket, with their salience and status.',
				inputSchema: observationsSchema,
				annotations: { title: 'List observations', readOnlyHint: true },
			},
			handler: async () => {
				try {
					const rows = await this.observations.list(OBSERVATIONS_SHOWN);
					if (rows.length === 0) return text('No observations yet.');
					return text(rows.map((o) => `- (${o.bucket}, ${o.status}, salience ${o.salience}) ${o.text}`).join('\n'));
				} catch (error) {
					return failure(error);
				}
			},
		};

		const dreamRun: ToolDefinition<typeof dreamRunSchema> = {
			name: 'memory_dream_run',
			config: {
				description: 'Runs the dream now, rewriting the five-bucket model of the owner from facts, recent sources and observations. Only the owner runs the dream.',
				inputSchema: dreamRunSchema,
				annotations: { title: 'Run the dream', readOnlyHint: false, destructiveHint: false },
			},
			handler: async (args, extra) => {
				try {
					const identity = identityFromRequest(extra, user);
					if (identity.kind !== 'owner') return ownerOnly();
					const blocked = await this.guarded(identity, 'memory_dream_run', args, 'Run the dream now.');
					if (blocked) return blocked;
					const outcome = await this.dream.runNow('manual');
					return text(outcome.message);
				} catch (error) {
					return failure(error);
				}
			},
		};

		registerIfAllowed(factDecide);
		registerIfAllowed(pageWrite);
		registerIfAllowed(pages);
		registerIfAllowed(overview);
		registerIfAllowed(sourcesList);
		registerIfAllowed(source);
		registerIfAllowed(sourceDelete);
		registerIfAllowed(graph);
		registerIfAllowed(sky);
		registerIfAllowed(entitiesList);
		registerIfAllowed(observationsList);
		registerIfAllowed(dreamRun);
	}
}
