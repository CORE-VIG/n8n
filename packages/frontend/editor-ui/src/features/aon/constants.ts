export const AON_HOME_VIEW = 'AonHome';
export const AON_AGENTS_VIEW = 'AonAgents';
export const AON_AGENT_VIEW = 'AonAgent';

/** What a tool is doing, in his words rather than its name. */
export const AON_DOING: Record<string, { now: string; done: string }> = {
	mcp__n8n__get_workflow_sdk_reference: { now: 'Reading how workflows are written', done: 'Read the workflow SDK' },
	mcp__n8n__search_workflow_nodes: { now: 'Looking up nodes', done: 'Looked up nodes' },
	mcp__n8n__explore_node_resources: { now: 'Reading a node', done: 'Read a node' },
	mcp__n8n__validate_workflow_code: { now: 'Validating the workflow', done: 'Validated' },
	mcp__n8n__create_workflow_from_code: { now: 'Creating the workflow', done: 'Workflow created as a draft' },
	mcp__n8n__update_workflow: { now: 'Changing the workflow', done: 'Workflow changed' },
	mcp__n8n__search_workflows: { now: 'Reading your workflows', done: 'Read your workflows' },
	mcp__n8n__get_workflow_details: { now: 'Reading the workflow', done: 'Read the workflow' },
	mcp__n8n__prepare_workflow_pin_data: { now: 'Preparing test data', done: 'Test data ready' },
	mcp__n8n__test_workflow: { now: 'Testing the workflow', done: 'Test finished' },
	mcp__n8n__execute_workflow: { now: 'Running the workflow', done: 'Run finished' },
	mcp__n8n__publish_workflow: { now: 'Publishing', done: 'Published' },
	mcp__n8n__search_workflow_executions: { now: 'Reading executions', done: 'Read executions' },
	mcp__n8n__get_workflow_execution: { now: 'Reading the execution', done: 'Read the execution' },
	mcp__n8n__list_credentials: { now: 'Reading your credentials', done: 'Read your credentials' },
};
