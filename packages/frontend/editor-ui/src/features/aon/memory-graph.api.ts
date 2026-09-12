import type {
	AonEntityDetail,
	AonEntitySummary,
	AonFactList,
	AonMemoryGraph,
	AonMemorySky,
	AonObservationSummary,
} from '@n8n/api-types';
import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';

/**
 * The three memory graph views (Sky, Brain, Radial) and the lists behind
 * them: entities, facts and observations. Kept apart from `memory.api.ts`
 * (sources + capture) because this is a different slice of the contract.
 */

export interface AonEntityList {
	items: AonEntitySummary[];
	total: number;
	kinds: Array<{ kind: string; count: number }>;
}

export interface AonObservationList {
	items: AonObservationSummary[];
	total: number;
}

export async function getGraph(
	ctx: IRestApiContext,
	params: { focus?: string; depth?: number; limit?: number },
) {
	return await makeRestApiRequest<AonMemoryGraph>(ctx, 'GET', '/aon/memory/graph', params);
}

export async function getSky(ctx: IRestApiContext) {
	return await makeRestApiRequest<AonMemorySky>(ctx, 'GET', '/aon/memory/sky');
}

export async function listEntities(
	ctx: IRestApiContext,
	params: { q?: string; kind?: string; limit?: number; offset?: number },
) {
	return await makeRestApiRequest<AonEntityList>(ctx, 'GET', '/aon/memory/entities', params);
}

export async function getEntity(ctx: IRestApiContext, id: string) {
	return await makeRestApiRequest<AonEntityDetail>(
		ctx,
		'GET',
		`/aon/memory/entities/${encodeURIComponent(id)}`,
	);
}

export async function listFacts(
	ctx: IRestApiContext,
	params: { status?: string; entity?: string; limit?: number; offset?: number },
) {
	return await makeRestApiRequest<AonFactList>(ctx, 'GET', '/aon/memory/facts', params);
}

export async function decideFact(
	ctx: IRestApiContext,
	id: string,
	body: { status: 'confirmed' | 'rejected'; note?: string },
) {
	return await makeRestApiRequest<{ ok: boolean }>(
		ctx,
		'POST',
		`/aon/memory/facts/${encodeURIComponent(id)}/decide`,
		body,
	);
}

export async function listObservations(
	ctx: IRestApiContext,
	params: { bucket?: string; limit?: number; offset?: number },
) {
	return await makeRestApiRequest<AonObservationList>(ctx, 'GET', '/aon/memory/observations', params);
}
