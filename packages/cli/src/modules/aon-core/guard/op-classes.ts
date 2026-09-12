import type { AonGuardOpClass } from '@n8n/api-types';

/**
 * Every effect an actor can cause through this instance's tools, classed and
 * tiered. Tier 0 reads; 1 writes a draft or a file; 2 runs something inside
 * the fence; 3 reaches the outside world or makes something live; 4 spends
 * money or grants access. A tool not listed here is treated as tier 3.
 */
export const AON_OP_CLASSES: readonly AonGuardOpClass[] = [
	{ opClass: 'read', tier: 0, label: 'Read workflows, executions, nodes, credentials names, memory and files' },
	{ opClass: 'workflow.write', tier: 1, label: 'Create or change a workflow draft' },
	{ opClass: 'hands.write', tier: 1, label: 'Write or delete files in a workspace' },
	{ opClass: 'datatable.write', tier: 1, label: 'Create or change data tables and rows' },
	{ opClass: 'project.write', tier: 1, label: 'Create or move folders' },
	{ opClass: 'n8n-agent.write', tier: 1, label: 'Create or change an n8n agent draft' },
	{ opClass: 'memory.write', tier: 1, label: 'Remember something in memory' },
	{ opClass: 'workflow.test', tier: 2, label: 'Test or run a workflow manually' },
	{ opClass: 'hands.run', tier: 2, label: 'Run a command in a workspace' },
	{ opClass: 'n8n-agent.execute', tier: 2, label: 'Call an n8n agent' },
	{ opClass: 'workflow.publish', tier: 3, label: 'Publish, unpublish or archive a workflow' },
	{ opClass: 'n8n-agent.publish', tier: 3, label: 'Publish, unpublish or delete an n8n agent, or change its integrations' },
	{ opClass: 'hands.network', tier: 3, label: 'Give a command the network' },
	{ opClass: 'run.deliver', tier: 3, label: 'Accept a run\'s output as delivered' },
	{ opClass: 'money', tier: 4, label: 'Spend money' },
	{ opClass: 'access', tier: 4, label: 'Grant access or change credentials' },
];

const TOOL_OP_CLASS: Record<string, string> = {
	// tier 0
	search_workflows: 'read',
	get_workflow_details: 'read',
	get_workflow_history: 'read',
	get_workflow_version: 'read',
	get_workflow_versions_diff: 'read',
	search_nodes: 'read',
	get_node_types: 'read',
	get_workflow_best_practices: 'read',
	get_workflow_sdk_reference: 'read',
	validate_workflow: 'read',
	validate_node_config: 'read',
	get_workflow_execution: 'read',
	search_workflow_executions: 'read',
	list_credentials: 'read',
	list_n8n_gateway_services: 'read',
	explore_node_resources: 'read',
	search_data_tables: 'read',
	get_data_table_rows: 'read',
	search_projects: 'read',
	search_folders: 'read',
	list_workflow_tags: 'read',
	search_agents: 'read',
	get_agent: 'read',
	list_agent_versions: 'read',
	discover_agent_assets: 'read',
	validate_agent: 'read',
	get_agent_builder_reference: 'read',
	hands_read_file: 'read',
	hands_list_files: 'read',
	memory_search: 'read',
	// tier 1
	create_workflow_from_code: 'workflow.write',
	update_workflow: 'workflow.write',
	prepare_workflow_pin_data: 'workflow.write',
	restore_workflow_version: 'workflow.write',
	hands_write_file: 'hands.write',
	hands_delete: 'hands.write',
	create_data_table: 'datatable.write',
	rename_data_table: 'datatable.write',
	add_data_table_column: 'datatable.write',
	delete_data_table_column: 'datatable.write',
	rename_data_table_column: 'datatable.write',
	add_data_table_rows: 'datatable.write',
	create_folder: 'project.write',
	update_folder: 'project.write',
	move_workflows_to_folder: 'project.write',
	create_agent: 'n8n-agent.write',
	mutate_agent: 'n8n-agent.write',
	revert_agent: 'n8n-agent.write',
	memory_capture: 'memory.write',
	// tier 2
	test_workflow: 'workflow.test',
	execute_workflow: 'workflow.test',
	hands_run: 'hands.run',
	call_agent: 'n8n-agent.execute',
	// tier 3
	publish_workflow: 'workflow.publish',
	unpublish_workflow: 'workflow.publish',
	archive_workflow: 'workflow.publish',
	publish_agent: 'n8n-agent.publish',
	unpublish_agent: 'n8n-agent.publish',
	delete_agent: 'n8n-agent.publish',
	update_agent_integration: 'n8n-agent.publish',
	verify_agent_mcp_server: 'n8n-agent.publish',
};

const UNKNOWN_TOOL_TIER = 3;

export function tierOf(opClass: string): number {
	return AON_OP_CLASSES.find((c) => c.opClass === opClass)?.tier ?? UNKNOWN_TOOL_TIER;
}

/** The op class a tool call falls under; a hands_run with the network asked for is a network op. */
export function opClassOfTool(toolName: string, args?: Record<string, unknown>): AonGuardOpClass {
	const bare = toolName.replace(/^mcp__n8n__/, '');
	let opClass = TOOL_OP_CLASS[bare];
	if (bare === 'hands_run' && args?.network === true) opClass = 'hands.network';
	if (bare === 'guard_request') opClass = 'read';
	if (!opClass) return { opClass: `tool:${bare}`, tier: UNKNOWN_TOOL_TIER, label: `Use the ${bare} tool` };
	return AON_OP_CLASSES.find((c) => c.opClass === opClass) ?? { opClass, tier: UNKNOWN_TOOL_TIER, label: opClass };
}

/** Every tool this instance's MCP server may register, for building a run's allow-list. */
export const KNOWN_TOOL_NAMES: readonly string[] = Object.keys(TOOL_OP_CLASS);
