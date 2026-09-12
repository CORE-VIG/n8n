import type { AonAgentSummary, AonRunNowRequest, AonRunSummary } from '@n8n/api-types';
import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';

/** Actions on one agent: activate/pause, reset its breaker, run a deliverable now. */

export async function setAgentStatus(
	ctx: IRestApiContext,
	slug: string,
	status: 'active' | 'paused' | 'draft',
) {
	return await makeRestApiRequest<AonAgentSummary>(
		ctx,
		'PATCH',
		`/aon/agents/${encodeURIComponent(slug)}`,
		{ status },
	);
}

export async function resetBreaker(ctx: IRestApiContext, slug: string) {
	return await makeRestApiRequest<AonAgentSummary>(
		ctx,
		'POST',
		`/aon/agents/${encodeURIComponent(slug)}/breaker/reset`,
	);
}

export async function runDeliverable(
	ctx: IRestApiContext,
	slug: string,
	deliverableId: string,
	body: AonRunNowRequest,
) {
	return await makeRestApiRequest<AonRunSummary>(
		ctx,
		'POST',
		`/aon/agents/${encodeURIComponent(slug)}/deliverables/${encodeURIComponent(deliverableId)}/run`,
		body,
	);
}
