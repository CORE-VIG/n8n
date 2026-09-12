import type { AonRunDetail, AonRunList } from '@n8n/api-types';
import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';

/** The Runs list, filtered and paged, and one run's full detail. */

export async function getRuns(
	ctx: IRestApiContext,
	params: { agent?: string; status?: string; limit?: number; offset?: number },
) {
	return await makeRestApiRequest<AonRunList>(ctx, 'GET', '/aon/runs', params);
}

export async function getRun(ctx: IRestApiContext, id: string) {
	return await makeRestApiRequest<AonRunDetail>(ctx, 'GET', `/aon/runs/${encodeURIComponent(id)}`);
}
