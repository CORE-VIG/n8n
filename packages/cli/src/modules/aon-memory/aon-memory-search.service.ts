import type { AonMemoryHit, AonMemorySearchMode, AonMemorySearchResult } from '@n8n/api-types';
import { Service } from '@n8n/di';

import { AonEmbedService } from './aon-embed.service';
import { AonChunkRepository } from './database/repositories/aon-chunk.repository';

/** Reciprocal rank fusion constant: the usual 60, which keeps top ranks from dominating. */
const RRF_K = 60;

@Service()
export class AonMemorySearchService {
	constructor(
		private readonly chunks: AonChunkRepository,
		private readonly embedder: AonEmbedService,
	) {}

	async search({
		query,
		mode,
		limit,
	}: {
		query: string;
		mode: AonMemorySearchMode;
		limit: number;
	}): Promise<AonMemorySearchResult> {
		const started = Date.now();
		const vector = mode === 'text' ? null : await this.embedder.embed(query);
		const embedded = vector !== null;

		let hits: AonMemoryHit[];
		if (mode === 'vector' && vector) {
			hits = await this.chunks.searchVector(vector, limit);
		} else if (mode === 'hybrid' && vector) {
			// Both lists are fetched a little deeper than asked, so fusion has something to fuse.
			const depth = Math.min(limit * 3, 60);
			const [byText, byMeaning] = await Promise.all([
				this.chunks.searchText(query, depth),
				this.chunks.searchVector(vector, depth),
			]);
			hits = fuse([byText, byMeaning], limit);
		} else {
			hits = await this.chunks.searchText(query, limit);
		}

		return {
			query,
			mode: embedded ? mode : 'text',
			hits,
			embedded,
			tookMs: Date.now() - started,
		};
	}
}

/** Reciprocal rank fusion: a chunk high on either list ends up high on the merged one. */
function fuse(lists: AonMemoryHit[][], limit: number): AonMemoryHit[] {
	const scores = new Map<string, { hit: AonMemoryHit; score: number }>();
	for (const list of lists) {
		list.forEach((hit, rank) => {
			const entry = scores.get(hit.chunkId) ?? { hit, score: 0 };
			entry.score += 1 / (RRF_K + rank + 1);
			scores.set(hit.chunkId, entry);
		});
	}
	return [...scores.values()]
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map(({ hit, score }) => ({ ...hit, score }));
}
