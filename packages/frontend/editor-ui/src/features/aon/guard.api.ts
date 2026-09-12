import type { AonGuardApproval, AonGuardOverview, AonGuardPolicy, AonGuardVerdict } from '@n8n/api-types';
import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';

/** The cards waiting for him, every standing policy, and the audit trail. */
export async function getGuardOverview(ctx: IRestApiContext) {
	return await makeRestApiRequest<AonGuardOverview>(ctx, 'GET', '/aon/guard/overview');
}

export async function approve(ctx: IRestApiContext, id: string) {
	return await makeRestApiRequest<AonGuardApproval>(
		ctx,
		'POST',
		`/aon/guard/approvals/${encodeURIComponent(id)}/approve`,
	);
}

export async function deny(ctx: IRestApiContext, id: string) {
	return await makeRestApiRequest<AonGuardApproval>(
		ctx,
		'POST',
		`/aon/guard/approvals/${encodeURIComponent(id)}/deny`,
	);
}

export async function putPolicy(
	ctx: IRestApiContext,
	body: { identity: string; opClass: string; verdict: AonGuardVerdict; note?: string },
) {
	return await makeRestApiRequest<AonGuardPolicy>(ctx, 'PUT', '/aon/guard/policies', body);
}

export async function deletePolicy(ctx: IRestApiContext, id: string) {
	return await makeRestApiRequest<{ ok: true }>(
		ctx,
		'DELETE',
		`/aon/guard/policies/${encodeURIComponent(id)}`,
	);
}
