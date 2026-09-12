import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

/**
 * Aon lives inside this same n8n instance. The node calls back into it over
 * its own REST API (`/rest/aon/bridge/...`), locked to the owner's MCP key —
 * the same key Settings › n8n API / MCP issues for every other MCP client.
 */
export class AonApi implements ICredentialType {
	name = 'aonApi';

	displayName = 'Aon API';

	documentationUrl = 'https://docs.n8n.io/';

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'http://127.0.0.1:5678',
			description: "This n8n instance's own URL. Aon runs inside it, so this is rarely anything else.",
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description: "The owner's key from Settings › n8n API / MCP. Aon answers only to the owner.",
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/rest/aon/bridge/agents',
			method: 'GET',
		},
	};
}
