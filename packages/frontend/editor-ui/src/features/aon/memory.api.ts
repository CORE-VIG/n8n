import type {
	AonCaptureRequest,
	AonCaptureResult,
	AonSourceDetail,
	AonSourceList,
} from '@n8n/api-types';
import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';

export async function listSources(
	ctx: IRestApiContext,
	params: { q?: string; origin?: string; status?: string; limit?: number; offset?: number },
) {
	return await makeRestApiRequest<AonSourceList>(ctx, 'GET', '/aon/memory/sources', params);
}

export async function getSource(ctx: IRestApiContext, id: string) {
	return await makeRestApiRequest<AonSourceDetail>(
		ctx,
		'GET',
		`/aon/memory/sources/${encodeURIComponent(id)}`,
	);
}

export async function captureMemory(ctx: IRestApiContext, body: AonCaptureRequest) {
	return await makeRestApiRequest<AonCaptureResult>(ctx, 'POST', '/aon/memory/capture', body);
}

export async function deleteSource(ctx: IRestApiContext, id: string) {
	return await makeRestApiRequest<{ ok: boolean }>(
		ctx,
		'DELETE',
		`/aon/memory/sources/${encodeURIComponent(id)}`,
	);
}
