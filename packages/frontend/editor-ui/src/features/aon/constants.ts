export const AON_HOME_VIEW = 'AonHome';
export const AON_AGENTS_VIEW = 'AonAgents';
export const AON_AGENT_NEW_VIEW = 'AonAgentNew';
export const AON_AGENT_VIEW = 'AonAgent';
export const AON_RUNS_VIEW = 'AonRuns';
export const AON_RUN_VIEW = 'AonRun';
export const AON_MEMORY_VIEW = 'AonMemory';
export const AON_SOURCE_VIEW = 'AonSource';
export const AON_HANDS_VIEW = 'AonHands';
export const AON_WORKSPACE_VIEW = 'AonWorkspace';
export const AON_GUARD_VIEW = 'AonGuard';
export const AON_SETTINGS_VIEW = 'AonSettings';

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
	mcp__n8n__test_workflow: { now: 'Testing the workflow', done: 'Workflow test finished' },
	mcp__n8n__execute_workflow: { now: 'Starting a workflow execution', done: 'Workflow execution finished' },
	mcp__n8n__publish_workflow: { now: 'Publishing', done: 'Published' },
	mcp__n8n__search_workflow_executions: { now: 'Reading executions', done: 'Read executions' },
	mcp__n8n__get_workflow_execution: { now: 'Reading the execution', done: 'Read the execution' },
	mcp__n8n__list_credentials: { now: 'Reading your credentials', done: 'Read your credentials' },
	mcp__n8n__hands_run: { now: 'Running a command', done: 'Ran a command' },
	mcp__n8n__hands_write_file: { now: 'Writing a file', done: 'Wrote a file' },
	mcp__n8n__hands_read_file: { now: 'Reading a file', done: 'Read a file' },
	mcp__n8n__hands_list_files: { now: 'Listing files', done: 'Listed files' },
	mcp__n8n__hands_delete: { now: 'Deleting a file', done: 'Deleted a file' },
	mcp__n8n__guard_request: { now: 'Asking Guard', done: 'Asked Guard' },
	mcp__n8n__web_read: { now: 'Reading a web page', done: 'Read a web page' },
	mcp__n8n__web_act: { now: 'Acting in the browser', done: 'Acted in the browser' },
	mcp__n8n__memory_search: { now: 'Searching memory', done: 'Searched memory' },
	mcp__n8n__memory_capture: { now: 'Remembering', done: 'Remembered' },
	mcp__n8n__memory_about_me: { now: 'Reading the model of him', done: 'Read the model of him' },
	mcp__n8n__memory_context: { now: 'Building context', done: 'Built context' },
	mcp__n8n__search_agents: { now: 'Reading n8n agents', done: 'Read n8n agents' },
	mcp__n8n__get_agent: { now: 'Reading the n8n agent', done: 'Read the n8n agent' },
	mcp__n8n__list_agent_versions: { now: 'Reading n8n agent versions', done: 'Read n8n agent versions' },
	mcp__n8n__discover_agent_assets: { now: 'Looking up n8n agent assets', done: 'Looked up n8n agent assets' },
	mcp__n8n__validate_agent: { now: 'Checking the n8n agent', done: 'Checked the n8n agent' },
	mcp__n8n__get_agent_builder_reference: {
		now: 'Reading how n8n agents are built',
		done: 'Read the n8n agent reference',
	},
	mcp__n8n__create_agent: { now: 'Creating an n8n agent draft', done: 'n8n agent draft created' },
	mcp__n8n__mutate_agent: { now: 'Changing the n8n agent', done: 'n8n agent changed' },
	mcp__n8n__revert_agent: { now: 'Reverting the n8n agent', done: 'n8n agent reverted' },
	mcp__n8n__delete_agent: { now: 'Deleting the n8n agent', done: 'n8n agent deleted' },
	mcp__n8n__verify_agent_mcp_server: {
		now: 'Verifying the n8n agent MCP server',
		done: 'n8n agent MCP server verified',
	},
	mcp__n8n__update_agent_integration: {
		now: 'Updating the n8n agent integration',
		done: 'n8n agent integration updated',
	},
	mcp__n8n__publish_agent: { now: 'Publishing the n8n agent', done: 'n8n agent published' },
	mcp__n8n__unpublish_agent: { now: 'Unpublishing the n8n agent', done: 'n8n agent unpublished' },
	mcp__n8n__mail_search: { now: 'Searching mail', done: 'Searched mail' },
	mcp__n8n__mail_read: { now: 'Reading mail', done: 'Read mail' },
	mcp__n8n__mail_attachment: { now: 'Saving an attachment', done: 'Saved an attachment' },
	mcp__n8n__mail_draft: { now: 'Drafting mail', done: 'Drafted mail' },
	mcp__n8n__mail_send: { now: 'Sending mail', done: 'Sent mail' },
	mcp__n8n__mail_label: { now: 'Labelling mail', done: 'Labelled mail' },
	mcp__n8n__calendar_list: { now: 'Reading the calendar', done: 'Read the calendar' },
	mcp__n8n__calendar_create: { now: 'Creating a calendar event', done: 'Created a calendar event' },
	mcp__n8n__calendar_update: { now: 'Changing a calendar event', done: 'Changed a calendar event' },
	mcp__n8n__calendar_delete: { now: 'Deleting a calendar event', done: 'Deleted a calendar event' },
	mcp__n8n__drive_search: { now: 'Searching Drive', done: 'Searched Drive' },
	mcp__n8n__drive_folder: { now: 'Reading a Drive folder', done: 'Read a Drive folder' },
	mcp__n8n__drive_read: { now: 'Reading a Drive file', done: 'Read a Drive file' },
	mcp__n8n__drive_create: { now: 'Creating a Drive file', done: 'Created a Drive file' },
	mcp__n8n__sheet_read: { now: 'Reading a sheet', done: 'Read a sheet' },
	mcp__n8n__sheet_write: { now: 'Writing a sheet', done: 'Wrote a sheet' },
};
