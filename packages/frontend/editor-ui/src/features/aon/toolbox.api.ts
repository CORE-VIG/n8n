import type { AonToolboxList, AonToolboxRescanResult } from '@n8n/api-types';
import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';

/** The toolbox: what Aon can reach for but does not contain. */
export async function getToolbox(ctx: IRestApiContext) {
	return await makeRestApiRequest<AonToolboxList>(ctx, 'GET', '/aon/toolbox');
}

export async function rescanToolbox(ctx: IRestApiContext) {
	return await makeRestApiRequest<AonToolboxRescanResult>(ctx, 'POST', '/aon/toolbox/rescan');
}
