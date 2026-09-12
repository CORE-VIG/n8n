import type { AonMemorySky } from '@n8n/api-types';
import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';

/** Endpoints the Home cockpit reads that do not belong to any other feature's api file. */

/** The sky the hero draws: sources, entities, facts and observations, clustered into categories. */
export async function getMemorySky(ctx: IRestApiContext) {
	return await makeRestApiRequest<AonMemorySky>(ctx, 'GET', '/aon/memory/sky');
}

/** The assistant bridge's own pulse: up or not, and how many talk sessions it holds. */
export interface AonHealth {
	ok: boolean;
	sessions: number;
}

export async function getHealth(ctx: IRestApiContext) {
	return await makeRestApiRequest<AonHealth>(ctx, 'GET', '/aon/health');
}
