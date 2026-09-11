import type {
	AonAgentDetail,
	AonAgentSummary,
	AonAgentsOverview,
	AonMemoryOverview,
	AonMemorySearchMode,
	AonMemorySearchResult,
	AonRunSummary,
} from '@n8n/api-types';
import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';

export async function getAgentsOverview(ctx: IRestApiContext) {
	return await makeRestApiRequest<AonAgentsOverview>(ctx, 'GET', '/aon/agents/overview');
}

export async function getAgents(ctx: IRestApiContext) {
	return await makeRestApiRequest<AonAgentSummary[]>(ctx, 'GET', '/aon/agents');
}

export async function getAgent(ctx: IRestApiContext, slug: string) {
	return await makeRestApiRequest<AonAgentDetail>(
		ctx,
		'GET',
		`/aon/agents/${encodeURIComponent(slug)}`,
	);
}

export async function getRuns(ctx: IRestApiContext, params: { agent?: string; limit?: number }) {
	return await makeRestApiRequest<AonRunSummary[]>(ctx, 'GET', '/aon/runs', params);
}

export async function getMemoryOverview(ctx: IRestApiContext) {
	return await makeRestApiRequest<AonMemoryOverview>(ctx, 'GET', '/aon/memory/overview');
}

export async function searchMemory(
	ctx: IRestApiContext,
	params: { q: string; mode?: AonMemorySearchMode; limit?: number },
) {
	return await makeRestApiRequest<AonMemorySearchResult>(ctx, 'GET', '/aon/memory/search', params);
}
