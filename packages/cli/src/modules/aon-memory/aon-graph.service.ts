import type {
	AonGraphCluster,
	AonGraphEdge,
	AonGraphNode,
	AonMemoryGraph,
	AonMemorySky,
	AonMemorySkyCategory,
} from '@n8n/api-types';
import { Service } from '@n8n/di';

import { AonChunkRepository } from './database/repositories/aon-chunk.repository';
import type { AonFactGraphEdgeRow } from './database/repositories/aon-fact.repository';
import { AonFactRepository } from './database/repositories/aon-fact.repository';
import type { AonEntityDegreeRow } from './database/repositories/aon-entity.repository';
import { AonEntityRepository } from './database/repositories/aon-entity.repository';
import { AonObservationRepository } from './database/repositories/aon-observation.repository';
import { AonSourceRepository } from './database/repositories/aon-source.repository';

const DEFAULT_LIMIT = 150;
const MAX_LIMIT = 400;
const DEFAULT_DEPTH = 2;
const MAX_DEPTH = 3;
/** How many entity-to-entity facts to pull before filtering down to the shown nodes. */
const EDGE_FETCH_CAP = 2000;
const SKY_TOP_ORIGINS = 12;

interface NodeInfo {
	id: string;
	name: string;
	kind: string;
	degree: number;
}

/**
 * Builds the two views memory's graph page needs: the entity/fact graph
 * (the whole neighbourhood, or a BFS around one focus entity) and the "sky"
 * overview counts. Read-only; extraction (`AonExtractService`) is the only
 * writer of entities and facts.
 */
@Service()
export class AonGraphService {
	constructor(
		private readonly entities: AonEntityRepository,
		private readonly facts: AonFactRepository,
		private readonly observations: AonObservationRepository,
		private readonly sources: AonSourceRepository,
		private readonly chunks: AonChunkRepository,
	) {}

	async graph(opts: { focus?: string; depth?: number; limit?: number }): Promise<AonMemoryGraph | null> {
		const limit = clamp(opts.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
		const depth = clamp(opts.depth ?? DEFAULT_DEPTH, 1, MAX_DEPTH);
		const allEdges = await this.facts.graphEdges(EDGE_FETCH_CAP);

		let nodeMap: Map<string, NodeInfo>;
		let truncated: boolean;

		if (opts.focus) {
			const focusEntity = await this.entities.findBasic(opts.focus);
			if (!focusEntity) return null;

			const adjacency = new Map<string, AonFactGraphEdgeRow[]>();
			const pushAdjacency = (id: string, edge: AonFactGraphEdgeRow) => {
				const list = adjacency.get(id);
				if (list) list.push(edge);
				else adjacency.set(id, [edge]);
			};
			for (const edge of allEdges) {
				pushAdjacency(edge.subjectId, edge);
				pushAdjacency(edge.objectId, edge);
			}

			const visited = new Set<string>([focusEntity.id]);
			let frontier = [focusEntity.id];
			truncated = false;
			for (let d = 0; d < depth && frontier.length > 0; d++) {
				const next: string[] = [];
				for (const id of frontier) {
					for (const edge of adjacency.get(id) ?? []) {
						const otherId = edge.subjectId === id ? edge.objectId : edge.subjectId;
						if (visited.has(otherId)) continue;
						if (visited.size >= limit) {
							truncated = true;
							continue;
						}
						visited.add(otherId);
						next.push(otherId);
					}
				}
				frontier = next;
			}

			const rows = await this.entities.byIds(Array.from(visited));
			nodeMap = new Map(rows.map((r) => [r.id, r]));
		} else {
			const top = await this.entities.topByDegree(limit);
			nodeMap = new Map(top.map((r: AonEntityDegreeRow) => [r.id, r]));
			const liveCount = await this.entities.countLive();
			truncated = liveCount > nodeMap.size;
		}

		const clusters = clustersOf(nodeMap.values());
		const clusterIndex = new Map(clusters.map((c) => [c.kind, c.index]));

		const nodes: AonGraphNode[] = Array.from(nodeMap.values()).map((n) => ({
			id: n.id,
			label: n.name,
			kind: n.kind,
			weight: n.degree,
			cluster: clusterIndex.get(n.kind) ?? 0,
		}));

		const edges: AonGraphEdge[] = allEdges
			.filter((e) => nodeMap.has(e.subjectId) && nodeMap.has(e.objectId))
			.map((e) => ({ from: e.subjectId, to: e.objectId, label: e.predicate, status: e.status, factId: e.factId }));

		return { nodes, edges, clusters, focus: opts.focus ?? null, truncated };
	}

	async sky(): Promise<AonMemorySky> {
		const [core, sourcesTotal, sourcesByOrigin, sourcesByKind, entitiesByKind, factsByStatus, entitiesTotal, factsTotal, observationsTotal] =
			await Promise.all([
				this.chunks.countAll(),
				this.sources.countAll(),
				this.sources.countByOrigin(SKY_TOP_ORIGINS),
				this.sourcesByKind(),
				this.entities.countByKind(),
				this.facts.countByStatus(),
				this.entities.countLive(),
				this.facts.countAll(),
				this.observations.countAll(),
			]);

		const categories: AonMemorySkyCategory[] = [
			...sourcesByOrigin.map((r) => ({ name: r.origin, count: r.count, group: 'origin' as const })),
			...sourcesByKind.map((r) => ({ name: r.kind, count: r.count, group: 'kind' as const })),
			...entitiesByKind.map((r) => ({ name: r.kind, count: r.count, group: 'entity' as const })),
			...factsByStatus.map((r) => ({ name: r.status, count: r.count, group: 'fact' as const })),
		];

		return {
			core,
			categories,
			sources: sourcesTotal,
			entities: entitiesTotal,
			facts: factsTotal,
			observations: observationsTotal,
		};
	}

	/**
	 * Sources grouped by kind. `AonSourceRepository` (another module's file)
	 * has no such method, so this reads through its inherited query builder
	 * rather than adding one.
	 */
	private async sourcesByKind(): Promise<Array<{ kind: string; count: number }>> {
		const rows = await this.sources
			.createQueryBuilder('s')
			.select('s.kind', 'kind')
			.addSelect('COUNT(*)::int', 'count')
			.groupBy('s.kind')
			.orderBy('count', 'DESC')
			.getRawMany<{ kind: string; count: number | string }>();
		return rows.map((r) => ({ kind: r.kind, count: Number(r.count) }));
	}
}

function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(Math.max(Math.trunc(value), min), max);
}

function clustersOf(nodes: Iterable<NodeInfo>): AonGraphCluster[] {
	const counts = new Map<string, number>();
	for (const node of nodes) counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
	return Array.from(counts.entries())
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([kind, count], index) => ({ kind, index, count }));
}
