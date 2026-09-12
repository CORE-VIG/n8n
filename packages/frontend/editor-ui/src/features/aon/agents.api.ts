import type {
	AonAgentDetail,
	AonAgentSummary,
	AonCharterInput,
	AonDeliverableSummary,
	AonRunNowRequest,
	AonRunSummary,
} from '@n8n/api-types';
import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';

/** Actions on one agent: activate/pause, reset its breaker, run a deliverable now, author its charter and deliverables. */

export interface AonDeliverableInput {
	name: string;
	dod: string;
	shape: string;
	cadence?: string;
	tier: number;
	approver: string;
	maxIterations?: number;
	enabled?: boolean;
}

export async function createAgent(
	ctx: IRestApiContext,
	body: { slug: string; name: string; persona?: string; charter: AonCharterInput },
) {
	return await makeRestApiRequest<AonAgentDetail>(ctx, 'POST', '/aon/agents', body);
}

export async function updateCharter(
	ctx: IRestApiContext,
	slug: string,
	body: { name?: string; persona?: string; charter?: AonCharterInput },
) {
	return await makeRestApiRequest<AonAgentDetail>(
		ctx,
		'PATCH',
		`/aon/agents/${encodeURIComponent(slug)}/charter`,
		body,
	);
}

export async function createDeliverable(ctx: IRestApiContext, slug: string, body: AonDeliverableInput) {
	return await makeRestApiRequest<AonDeliverableSummary>(
		ctx,
		'POST',
		`/aon/agents/${encodeURIComponent(slug)}/deliverables`,
		body,
	);
}

export async function updateDeliverable(
	ctx: IRestApiContext,
	slug: string,
	deliverableId: string,
	body: Partial<AonDeliverableInput>,
) {
	return await makeRestApiRequest<AonDeliverableSummary>(
		ctx,
		'PATCH',
		`/aon/agents/${encodeURIComponent(slug)}/deliverables/${encodeURIComponent(deliverableId)}`,
		body,
	);
}

export async function deleteDeliverable(ctx: IRestApiContext, slug: string, deliverableId: string) {
	return await makeRestApiRequest<{ deleted: true }>(
		ctx,
		'DELETE',
		`/aon/agents/${encodeURIComponent(slug)}/deliverables/${encodeURIComponent(deliverableId)}`,
	);
}

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
