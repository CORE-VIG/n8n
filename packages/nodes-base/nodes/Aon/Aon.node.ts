import type {
	IExecuteFunctions,
	IDataObject,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { aonApiRequest, asBoolean, asNumber, asString, isRecord } from './GenericFunctions';

/**
 * The Aon node: the one way a workflow uses Aon's agents and memory. It runs
 * an agent's deliverable as a means to the workflow's own end, or reads and
 * adds to memory. It never talks to the assistant — there is no such
 * operation here, on purpose (see AON.md, "Workflow").
 */
export class Aon implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Aon',
		name: 'aon',
		icon: 'file:aon.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: "Use one of this instance's Aon agents as a means, or read and add to its memory",
		defaults: {
			name: 'Aon',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'aonApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Agent', value: 'agent' },
					{ name: 'Memory', value: 'memory' },
				],
				default: 'agent',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: { resource: ['agent'] },
				},
				options: [
					{
						name: 'Run Deliverable',
						value: 'run',
						description: "Start one of an agent's deliverables, as a means to this workflow's own end",
						action: 'Run a deliverable',
					},
					{
						name: 'Get Run',
						value: 'getRun',
						description: 'Read one run by its id',
						action: 'Get a run',
					},
				],
				default: 'run',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: { resource: ['memory'] },
				},
				options: [
					{
						name: 'Search',
						value: 'search',
						description: 'Search memory by words, by meaning, or both',
						action: 'Search memory',
					},
					{
						name: 'Capture',
						value: 'capture',
						description: 'Add text or a page to memory',
						action: 'Capture to memory',
					},
				],
				default: 'search',
			},

			// --- Agent · Run Deliverable ------------------------------------
			{
				displayName: 'Agent Name or ID',
				name: 'agent',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getAgents',
				},
				displayOptions: {
					show: { resource: ['agent'], operation: ['run'] },
				},
				default: '',
				required: true,
				description:
					'The agent whose deliverable to run. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Deliverable Name or ID',
				name: 'deliverable',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getDeliverables',
					loadOptionsDependsOn: ['agent'],
				},
				displayOptions: {
					show: { resource: ['agent'], operation: ['run'] },
				},
				default: '',
				required: true,
				description:
					'The deliverable to run. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Input',
				name: 'input',
				type: 'string',
				typeOptions: { rows: 4 },
				displayOptions: {
					show: { resource: ['agent'], operation: ['run'] },
				},
				default: '',
				description: "Free text handed to the agent as this run's input",
			},
			{
				displayName: 'Wait for the Verdict',
				name: 'wait',
				type: 'boolean',
				displayOptions: {
					show: { resource: ['agent'], operation: ['run'] },
				},
				default: true,
				description:
					"Whether to hold this node open and poll the run until it is done, failed, or stopped, then return its output and verdict. Off starts the run and returns its id right away.",
			},
			{
				displayName: 'Timeout (Seconds)',
				name: 'timeoutSec',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 900 },
				displayOptions: {
					show: { resource: ['agent'], operation: ['run'], wait: [true] },
				},
				default: 60,
				description: 'How long to wait for the run before returning whatever it has reached so far',
			},

			// --- Agent · Get Run ---------------------------------------------
			{
				displayName: 'Run ID',
				name: 'runId',
				type: 'string',
				displayOptions: {
					show: { resource: ['agent'], operation: ['getRun'] },
				},
				default: '',
				required: true,
				description: 'The id of the run to read',
			},

			// --- Memory · Search ----------------------------------------------
			{
				displayName: 'Query',
				name: 'query',
				type: 'string',
				displayOptions: {
					show: { resource: ['memory'], operation: ['search'] },
				},
				default: '',
				required: true,
				description: 'What to search memory for',
			},
			{
				displayName: 'Mode',
				name: 'mode',
				type: 'options',
				displayOptions: {
					show: { resource: ['memory'], operation: ['search'] },
				},
				options: [
					{ name: 'Hybrid', value: 'hybrid', description: 'By words and by meaning, fused' },
					{ name: 'Words', value: 'words', description: 'By words only' },
					{ name: 'Meaning', value: 'meaning', description: 'By meaning only' },
				],
				default: 'hybrid',
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 50 },
				displayOptions: {
					show: { resource: ['memory'], operation: ['search'] },
				},
				default: 10,
			},

			// --- Memory · Capture ----------------------------------------------
			{
				displayName: 'Title',
				name: 'title',
				type: 'string',
				displayOptions: {
					show: { resource: ['memory'], operation: ['capture'] },
				},
				default: '',
			},
			{
				displayName: 'Capture',
				name: 'source',
				type: 'options',
				displayOptions: {
					show: { resource: ['memory'], operation: ['capture'] },
				},
				options: [
					{ name: 'Text', value: 'text' },
					{ name: 'A URL', value: 'url' },
				],
				default: 'text',
			},
			{
				displayName: 'Text',
				name: 'text',
				type: 'string',
				typeOptions: { rows: 4 },
				displayOptions: {
					show: { resource: ['memory'], operation: ['capture'], source: ['text'] },
				},
				default: '',
				required: true,
			},
			{
				displayName: 'URL',
				name: 'url',
				type: 'string',
				displayOptions: {
					show: { resource: ['memory'], operation: ['capture'], source: ['url'] },
				},
				default: '',
				required: true,
			},
			{
				displayName: 'Kind',
				name: 'kind',
				type: 'string',
				displayOptions: {
					show: { resource: ['memory'], operation: ['capture'] },
				},
				default: '',
				description: 'A short label for what this is, e.g. "note" or "page". Left blank picks a sensible default.',
			},
		],
	};

	methods = {
		loadOptions: {
			/** The agent roster, from `GET /aon/bridge/agents`. */
			async getAgents(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const response = await aonApiRequest.call(this, 'GET', '/agents');
				if (!Array.isArray(response)) return [];
				return response
					.filter(isRecord)
					.map((agent) => ({
						name: `${asString(agent.name)} (${asString(agent.status, 'draft')})`,
						value: asString(agent.slug),
					}))
					.filter((option) => option.value.length > 0);
			},

			/** The selected agent's deliverables, from the same roster call. */
			async getDeliverables(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const agentSlug = asString(this.getCurrentNodeParameter('agent'));
				if (!agentSlug) return [];
				const response = await aonApiRequest.call(this, 'GET', '/agents');
				if (!Array.isArray(response)) return [];
				const agent = response.filter(isRecord).find((a) => asString(a.slug) === agentSlug);
				if (!agent || !Array.isArray(agent.deliverables)) return [];
				return agent.deliverables
					.filter(isRecord)
					.map((deliverable) => ({
						name: `${asString(deliverable.name)}${
							asBoolean(deliverable.enabled, true) ? '' : ' (disabled)'
						} — ${asString(deliverable.shape)}`,
						value: asString(deliverable.id),
					}))
					.filter((option) => option.value.length > 0);
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = asString(this.getNodeParameter('resource', i, ''));
				const operation = asString(this.getNodeParameter('operation', i, ''));

				if (resource === 'agent' && operation === 'run') {
					const agent = asString(this.getNodeParameter('agent', i, ''));
					const deliverable = asString(this.getNodeParameter('deliverable', i, ''));
					if (!agent) throw new NodeOperationError(this.getNode(), 'Give me an agent.', { itemIndex: i });
					if (!deliverable) {
						throw new NodeOperationError(this.getNode(), 'Give me a deliverable.', { itemIndex: i });
					}
					const input = asString(this.getNodeParameter('input', i, ''));
					const wait = asBoolean(this.getNodeParameter('wait', i, true), true);
					const timeoutSec = asNumber(this.getNodeParameter('timeoutSec', i, 60), 60);

					const body: IDataObject = { agent, deliverable, wait };
					if (input) body.input = input;
					if (wait) body.timeoutSec = timeoutSec;

					const response = await aonApiRequest.call(this, 'POST', '/run', body);
					returnData.push({ json: isRecord(response) ? response : {}, pairedItem: { item: i } });
					continue;
				}

				if (resource === 'agent' && operation === 'getRun') {
					const runId = asString(this.getNodeParameter('runId', i, ''));
					if (!runId) throw new NodeOperationError(this.getNode(), 'Give me a run id.', { itemIndex: i });
					const response = await aonApiRequest.call(this, 'GET', `/run/${encodeURIComponent(runId)}`);
					returnData.push({ json: isRecord(response) ? response : {}, pairedItem: { item: i } });
					continue;
				}

				if (resource === 'memory' && operation === 'search') {
					const query = asString(this.getNodeParameter('query', i, ''));
					if (!query) {
						throw new NodeOperationError(this.getNode(), 'Give me something to search for.', { itemIndex: i });
					}
					const mode = asString(this.getNodeParameter('mode', i, 'hybrid'), 'hybrid');
					const limit = asNumber(this.getNodeParameter('limit', i, 10), 10);

					const response = await aonApiRequest.call(this, 'POST', '/memory/search', {
						query,
						mode,
						limit,
					});
					const hits = isRecord(response) && Array.isArray(response.hits) ? response.hits : [];
					if (hits.length === 0) {
						returnData.push({ json: {}, pairedItem: { item: i } });
					} else {
						for (const hit of hits) {
							returnData.push({ json: isRecord(hit) ? hit : {}, pairedItem: { item: i } });
						}
					}
					continue;
				}

				if (resource === 'memory' && operation === 'capture') {
					const source = asString(this.getNodeParameter('source', i, 'text'), 'text');
					const title = asString(this.getNodeParameter('title', i, ''));
					const kind = asString(this.getNodeParameter('kind', i, ''));

					const body: IDataObject = {};
					if (title) body.title = title;
					if (kind) body.kind = kind;
					if (source === 'url') {
						const url = asString(this.getNodeParameter('url', i, ''));
						if (!url) throw new NodeOperationError(this.getNode(), 'Give me a url to capture.', { itemIndex: i });
						body.url = url;
					} else {
						const text = asString(this.getNodeParameter('text', i, ''));
						if (!text) throw new NodeOperationError(this.getNode(), 'Give me text to capture.', { itemIndex: i });
						body.text = text;
					}

					const response = await aonApiRequest.call(this, 'POST', '/memory/capture', body);
					returnData.push({ json: isRecord(response) ? response : {}, pairedItem: { item: i } });
					continue;
				}

				throw new NodeOperationError(
					this.getNode(),
					`Unknown operation "${operation}" for resource "${resource}".`,
					{ itemIndex: i },
				);
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: error instanceof Error ? error.message : String(error) },
						pairedItem: { item: i },
					});
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}
