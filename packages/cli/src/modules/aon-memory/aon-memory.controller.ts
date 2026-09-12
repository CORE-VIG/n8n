import type {
	AonCaptureRequest,
	AonCaptureResult,
	AonMemoryOverview,
	AonMemorySearchMode,
	AonMemorySearchResult,
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
import { AonMemorySearchService } from './aon-memory-search.service';
import { AonChunkRepository } from './database/repositories/aon-chunk.repository';
import { AonSourceRepository } from './database/repositories/aon-source.repository';

type SearchRequest = AuthenticatedRequest<{}, {}, {}, { q?: string; mode?: string; limit?: string }>;
type SourcesRequest = AuthenticatedRequest<
	{},
	{},
	{},
	{ q?: string; origin?: string; status?: string; limit?: string; offset?: string }
>;

const ORIGINS_SHOWN = 8;
const HITS_DEFAULT = 10;
const HITS_MAX = 50;
const MODES: AonMemorySearchMode[] = ['hybrid', 'text', 'vector'];
const SOURCES_DEFAULT = 50;
const SOURCES_MAX = 200;

const captureBody = z.object({
	title: z.string().max(500).optional(),
	text: z.string().optional(),
	url: z.string().max(4096).optional(),
	origin: z.string().max(200).optional(),
	kind: z.string().max(100).optional(),
	docTime: z.string().max(64).optional(),
});

@RestController('/aon/memory')
export class AonMemoryController {
	constructor(
		private readonly sources: AonSourceRepository,
		private readonly chunks: AonChunkRepository,
		private readonly search: AonMemorySearchService,
		private readonly embedder: AonEmbedService,
		private readonly captureService: AonCaptureService,
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
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
