import type { AonRunDetail, AonRunEvent, AonRunList } from '@n8n/api-types';
import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';

/** The Runs list, filtered and paged, one run's full detail, its live log, and stopping it. */

export async function getRuns(
	ctx: IRestApiContext,
	params: { agent?: string; status?: string; limit?: number; offset?: number },
) {
	return await makeRestApiRequest<AonRunList>(ctx, 'GET', '/aon/runs', params);
}

export async function getRun(ctx: IRestApiContext, id: string) {
	return await makeRestApiRequest<AonRunDetail>(ctx, 'GET', `/aon/runs/${encodeURIComponent(id)}`);
}

export async function stopRun(ctx: IRestApiContext, id: string) {
	return await makeRestApiRequest<AonRunDetail>(ctx, 'POST', `/aon/runs/${encodeURIComponent(id)}/stop`);
}

export async function getRunEvents(ctx: IRestApiContext, id: string, after = 0) {
	return await makeRestApiRequest<AonRunEvent[]>(
		ctx,
		'GET',
		`/aon/runs/${encodeURIComponent(id)}/events`,
		after > 0 ? { after } : undefined,
	);
}
