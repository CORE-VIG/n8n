import type { AonThreadDetail, AonThreadSummary } from '@n8n/api-types';
import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';

/** The assistant's saved conversations: list, open, rename, forget. */
export async function listThreads(ctx: IRestApiContext) {
	return await makeRestApiRequest<AonThreadSummary[]>(ctx, 'GET', '/aon/threads');
}

export async function createThread(ctx: IRestApiContext) {
	return await makeRestApiRequest<AonThreadSummary>(ctx, 'POST', '/aon/threads');
}

export async function getThread(ctx: IRestApiContext, id: string) {
	return await makeRestApiRequest<AonThreadDetail>(
		ctx,
		'GET',
		`/aon/threads/${encodeURIComponent(id)}`,
	);
}

export async function renameThread(ctx: IRestApiContext, id: string, title: string) {
	return await makeRestApiRequest<AonThreadSummary>(
		ctx,
		'PATCH',
		`/aon/threads/${encodeURIComponent(id)}`,
		{ title },
	);
}

export async function deleteThread(ctx: IRestApiContext, id: string) {
	return await makeRestApiRequest<{ ok: true }>(
		ctx,
		'DELETE',
		`/aon/threads/${encodeURIComponent(id)}`,
	);
}
