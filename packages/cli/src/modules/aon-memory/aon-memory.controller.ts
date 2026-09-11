import type { AonMemoryOverview, AonMemorySearchMode, AonMemorySearchResult } from '@n8n/api-types';
import type { AuthenticatedRequest } from '@n8n/db';
import { Get, RestController } from '@n8n/decorators';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';

import { AonEmbedService } from './aon-embed.service';
import { AonMemorySearchService } from './aon-memory-search.service';
import { AonChunkRepository } from './database/repositories/aon-chunk.repository';
import { AonSourceRepository } from './database/repositories/aon-source.repository';

type SearchRequest = AuthenticatedRequest<{}, {}, {}, { q?: string; mode?: string; limit?: string }>;

const ORIGINS_SHOWN = 8;
const HITS_DEFAULT = 10;
const HITS_MAX = 50;
const MODES: AonMemorySearchMode[] = ['hybrid', 'text', 'vector'];

@RestController('/aon/memory')
export class AonMemoryController {
	constructor(
		private readonly sources: AonSourceRepository,
		private readonly chunks: AonChunkRepository,
		private readonly search: AonMemorySearchService,
		private readonly embedder: AonEmbedService,
	) {}

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
}
