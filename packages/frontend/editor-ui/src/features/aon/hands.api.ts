import type {
	AonHandsRunRequest,
	AonHandsRunResult,
	AonWorkspaceFile,
	AonWorkspaceFileEntry,
	AonWorkspaceSummary,
} from '@n8n/api-types';
import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';

/** Hands workspaces, their files, and running commands inside them. */

export async function getWorkspaces(ctx: IRestApiContext) {
	return await makeRestApiRequest<AonWorkspaceSummary[]>(ctx, 'GET', '/aon/hands/workspaces');
}

export async function createWorkspace(ctx: IRestApiContext, slug: string) {
	return await makeRestApiRequest<AonWorkspaceSummary>(ctx, 'POST', '/aon/hands/workspaces', {
		slug,
	});
}

export async function deleteWorkspace(ctx: IRestApiContext, slug: string) {
	return await makeRestApiRequest<{ success: true }>(
		ctx,
		'DELETE',
		`/aon/hands/workspaces/${encodeURIComponent(slug)}`,
	);
}

export async function getWorkspaceFiles(ctx: IRestApiContext, slug: string, path?: string) {
	return await makeRestApiRequest<AonWorkspaceFileEntry[]>(
		ctx,
		'GET',
		`/aon/hands/workspaces/${encodeURIComponent(slug)}/files`,
		path ? { path } : undefined,
	);
}

export async function getWorkspaceFile(ctx: IRestApiContext, slug: string, path: string) {
	return await makeRestApiRequest<AonWorkspaceFile>(
		ctx,
		'GET',
		`/aon/hands/workspaces/${encodeURIComponent(slug)}/file`,
		{ path },
	);
}

export async function runInWorkspace(
	ctx: IRestApiContext,
	slug: string,
	body: AonHandsRunRequest,
) {
	return await makeRestApiRequest<AonHandsRunResult>(
		ctx,
		'POST',
		`/aon/hands/workspaces/${encodeURIComponent(slug)}/run`,
		body,
	);
}
