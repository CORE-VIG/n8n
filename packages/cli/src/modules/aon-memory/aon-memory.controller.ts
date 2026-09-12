import type {
	AonCaptureRequest,
	AonCaptureResult,
	AonEntityDetail,
	AonEntitySummary,
	AonFactList,
	AonFactSummary,
	AonMemoryGraph,
	AonMemoryOverview,
	AonMemorySearchMode,
	AonMemorySearchResult,
	AonMemorySky,
	AonObservationSummary,
	AonSourceDetail,
	AonSourceList,
} from '@n8n/api-types';
import type { AuthenticatedRequest } from '@n8n/db';
import type { NextFunction, Response } from 'express';
import { Delete, Get, Middleware, Param, Post, RestController } from '@n8n/decorators';
import { z } from 'zod';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { aonOwnerOnly } from '@/modules/aon-core/aon-owner';
import { NotFoundError } from '@/errors/response-errors/not-found.error';

import { AonCaptureService } from './aon-capture.service';
import { AonEmbedService } from './aon-embed.service';
import { AonGraphService } from './aon-graph.service';
import { AonMemorySearchService } from './aon-memory-search.service';
import { AonChunkRepository } from './database/repositories/aon-chunk.repository';
import { AonEntityRepository } from './database/repositories/aon-entity.repository';
import { AonFactRepository } from './database/repositories/aon-fact.repository';
import { AonObservationRepository } from './database/repositories/aon-observation.repository';
import { AonSourceRepository } from './database/repositories/aon-source.repository';

type SearchRequest = AuthenticatedRequest<{}, {}, {}, { q?: string; mode?: string; limit?: string }>;
type SourcesRequest = AuthenticatedRequest<
	{},
	{},
	{},
	{ q?: string; origin?: string; status?: string; limit?: string; offset?: string }
>;
type EntitiesRequest = AuthenticatedRequest<
	{},
	{},
	{},
	{ q?: string; kind?: string; limit?: string; offset?: string }
>;
type FactsRequest = AuthenticatedRequest<{}, {}, {}, { status?: string; entity?: string; limit?: string; offset?: string }>;
type GraphRequest = AuthenticatedRequest<{}, {}, {}, { focus?: string; depth?: string; limit?: string }>;

const ORIGINS_SHOWN = 8;
const HITS_DEFAULT = 10;
const HITS_MAX = 50;
const MODES: AonMemorySearchMode[] = ['hybrid', 'text', 'vector'];
const SOURCES_DEFAULT = 50;
const SOURCES_MAX = 200;
const ENTITIES_DEFAULT = 50;
const ENTITIES_MAX = 200;
const FACTS_DEFAULT = 50;
const FACTS_MAX = 200;
const OBSERVATIONS_DEFAULT = 100;

const captureBody = z.object({
	title: z.string().max(500).optional(),
	text: z.string().optional(),
	url: z.string().max(4096).optional(),
	origin: z.string().max(200).optional(),
	kind: z.string().max(100).optional(),
	docTime: z.string().max(64).optional(),
});

const decideBody = z.object({
	status: z.enum(['confirmed', 'rejected']),
	note: z.string().max(2000).optional(),
});

@RestController('/aon/memory')
export class AonMemoryController {
	constructor(
		private readonly sources: AonSourceRepository,
		private readonly chunks: AonChunkRepository,
		private readonly search: AonMemorySearchService,
		private readonly embedder: AonEmbedService,
		private readonly captureService: AonCaptureService,
		private readonly entities: AonEntityRepository,
		private readonly facts: AonFactRepository,
		private readonly observations: AonObservationRepository,
		private readonly graph: AonGraphService,
	) {}

	@Middleware()
	ownerOnly(req: AuthenticatedRequest, res: Response, next: NextFunction) {
		aonOwnerOnly(req, res, next);
	}

	@Get('/overview')
	async overview(): Promise<AonMemoryOverview> {
		const [sources, chunks, embedded, byOrigin, lastIndexedAt] = await Promise.all([
			this.sources.countAll(),
			this.chunks.countAll(),
			this.chunks.countEmbedded(),
			this.sources.countByOrigin(ORIGINS_SHOWN),
			this.sources.lastIndexedAt(),
		]);
		return { sources, chunks, embedded, byOrigin, lastIndexedAt, vectorSearch: this.embedder.enabled };
	}

	@Get('/search')
	async find(req: SearchRequest): Promise<AonMemorySearchResult> {
		const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
		if (!query) throw new BadRequestError('Give me something to search for: q');
		const asked = typeof req.query.mode === 'string' ? req.query.mode : 'hybrid';
		const mode = MODES.find((m) => m === asked) ?? 'hybrid';
		const wanted = Number(req.query.limit);
		const limit = Number.isFinite(wanted) && wanted > 0 ? Math.min(wanted, HITS_MAX) : HITS_DEFAULT;
		return await this.search.search({ query, mode, limit });
	}

	@Get('/sources')
	async listSources(req: SourcesRequest): Promise<AonSourceList> {
		const q = optionalString(req.query.q);
		const origin = optionalString(req.query.origin);
		const status = optionalString(req.query.status);
		const askedLimit = Number(req.query.limit);
		const limit =
			Number.isFinite(askedLimit) && askedLimit > 0
				? Math.min(askedLimit, SOURCES_MAX)
				: SOURCES_DEFAULT;
		const askedOffset = Number(req.query.offset);
		const offset = Number.isFinite(askedOffset) && askedOffset > 0 ? askedOffset : 0;
		return await this.sources.listSources({ q, origin, status, limit, offset });
	}

	@Post('/capture')
	async capture(req: AuthenticatedRequest): Promise<AonCaptureResult> {
		const parsed = captureBody.safeParse(req.body);
		if (!parsed.success) {
			throw new BadRequestError(parsed.error.issues.map((issue) => issue.message).join('; '));
		}
		const request: AonCaptureRequest = parsed.data;
		return await this.captureService.capture(request);
	}

	@Get('/sources/:id')
	async getSource(
		_req: AuthenticatedRequest,
		_res: unknown,
		@Param('id') id: string,
	): Promise<AonSourceDetail> {
		const detail = await this.sources.findDetail(id);
		if (!detail) throw new NotFoundError('There is no source with that id.');
		return detail;
	}

	@Delete('/sources/:id')
	async deleteSource(
		_req: AuthenticatedRequest,
		_res: unknown,
		@Param('id') id: string,
	): Promise<{ ok: true }> {
		await this.sources.deleteById(id);
		return { ok: true };
	}

	@Get('/graph')
	async getGraph(req: GraphRequest): Promise<AonMemoryGraph> {
		const focus = optionalString(req.query.focus);
		const depth = req.query.depth !== undefined ? Number(req.query.depth) : undefined;
		const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
		const graph = await this.graph.graph({ focus, depth, limit });
		if (!graph) throw new NotFoundError('There is no entity with that id.');
		return graph;
	}

	@Get('/sky')
	async getSky(): Promise<AonMemorySky> {
		return await this.graph.sky();
	}

	@Get('/entities')
	async listEntities(
		req: EntitiesRequest,
	): Promise<{ items: AonEntitySummary[]; total: number; kinds: Array<{ kind: string; count: number }> }> {
		const q = optionalString(req.query.q);
		const kind = optionalString(req.query.kind);
		const askedLimit = Number(req.query.limit);
		const limit = Number.isFinite(askedLimit) && askedLimit > 0 ? Math.min(askedLimit, ENTITIES_MAX) : ENTITIES_DEFAULT;
		const askedOffset = Number(req.query.offset);
		const offset = Number.isFinite(askedOffset) && askedOffset > 0 ? askedOffset : 0;
		const [{ items, total }, kinds] = await Promise.all([
			this.entities.list({ q, kind, limit, offset }),
			this.entities.countByKind(),
		]);
		return { items, total, kinds };
	}

	@Get('/entities/:id')
	async getEntity(
		_req: AuthenticatedRequest,
		_res: unknown,
		@Param('id') id: string,
	): Promise<AonEntityDetail> {
		const detail = await this.entities.findDetail(id);
		if (!detail) throw new NotFoundError('There is no entity with that id.');
		return detail;
	}

	@Get('/facts')
	async listFacts(req: FactsRequest): Promise<AonFactList> {
		const status = optionalString(req.query.status);
		const entityId = optionalString(req.query.entity);
		const askedLimit = Number(req.query.limit);
		const limit = Number.isFinite(askedLimit) && askedLimit > 0 ? Math.min(askedLimit, FACTS_MAX) : FACTS_DEFAULT;
		const askedOffset = Number(req.query.offset);
		const offset = Number.isFinite(askedOffset) && askedOffset > 0 ? askedOffset : 0;
		return await this.facts.list({ status, entityId, limit, offset });
	}

	@Post('/facts/:id/decide')
	async decideFact(
		req: AuthenticatedRequest,
		_res: unknown,
		@Param('id') id: string,
	): Promise<AonFactSummary> {
		const parsed = decideBody.safeParse(req.body);
		if (!parsed.success) {
			throw new BadRequestError(parsed.error.issues.map((issue) => issue.message).join('; '));
		}
		const decided = await this.facts.decide(id, parsed.data.status, req.user.email, parsed.data.note);
		if (!decided) throw new NotFoundError('There is no fact with that id.');
		return decided;
	}

	@Get('/observations')
	async listObservations(): Promise<AonObservationSummary[]> {
		return await this.observations.list(OBSERVATIONS_DEFAULT);
	}
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
