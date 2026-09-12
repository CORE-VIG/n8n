import type {
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	IDataObject,
	ILoadOptionsFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

interface AonApiCredentials {
	baseUrl: string;
	apiKey: string;
}

/** True for a plain JSON object; false for null, an array, or anything else. */
export function isRecord(value: unknown): value is IDataObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads `value` as a string, or `fallback` when it is not one — never a cast. */
export function asString(value: unknown, fallback = ''): string {
	return typeof value === 'string' ? value : fallback;
}

export function asNumber(value: unknown, fallback = 0): number {
	return typeof value === 'number' ? value : fallback;
}

export function asBoolean(value: unknown, fallback = false): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

/**
 * One call to Aon's bridge: this same n8n instance's own REST API, under
 * `/rest/aon/bridge`. It is the one way a workflow reaches an Aon agent or
 * memory — never the assistant (see AON.md, "Workflow"). The workflow's id
 * rides along on `x-aon-workflow`, so a run this node starts carries its
 * origin into Guard's audit trail.
 */
export async function aonApiRequest(
	this: IExecuteFunctions | ILoadOptionsFunctions,
	method: IHttpRequestMethods,
	endpoint: string,
	body?: IDataObject,
): Promise<unknown> {
	const credentials = await this.getCredentials<AonApiCredentials>('aonApi');
	const baseUrl = credentials.baseUrl.replace(/\/+$/, '');
	const workflowId = this.getWorkflow().id;

	const options: IHttpRequestOptions = {
		method,
		url: `${baseUrl}/rest/aon/bridge${endpoint}`,
		json: true,
		...(body !== undefined ? { body } : {}),
		...(workflowId ? { headers: { 'x-aon-workflow': workflowId } } : {}),
	};

	try {
		return await this.helpers.httpRequestWithAuthentication.call(this, 'aonApi', options);
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as JsonObject);
	}
}
