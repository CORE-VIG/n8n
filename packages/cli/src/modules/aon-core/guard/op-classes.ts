import type { AonGuardOpClass } from '@n8n/api-types';

/** The tier ceiling an agent acts within by itself when its charter sets none. */
export const DEFAULT_AGENT_TIER_CEILING = 2;

/**
 * Every effect an actor can cause through this instance's tools, classed and
 * tiered. Tier 0 reads; 1 writes a draft or a file; 2 runs something inside
 * the fence; 3 reaches the outside world or makes something live; 4 spends
 * money or grants access. A tool not listed here is treated as tier 3.
 */
export const AON_OP_CLASSES: readonly AonGuardOpClass[] = [
	{ opClass: 'read', tier: 0, label: 'Read workflows, executions, nodes, credentials names, memory and files' },
	{ opClass: 'web.read', tier: 1, label: 'Read a public web page in the browser' },
	{ opClass: 'workflow.write', tier: 1, label: 'Create or change a workflow draft' },
	{ opClass: 'hands.write', tier: 1, label: 'Write or delete files in a workspace' },
	{ opClass: 'memory.delete', tier: 1, label: 'Forget a source' },
	{ opClass: 'threads.write', tier: 1, label: 'Rename or delete a conversation' },
	{ opClass: 'datatable.write', tier: 1, label: 'Create or change data tables and rows' },
	{ opClass: 'project.write', tier: 1, label: 'Create or move folders' },
	{ opClass: 'n8n-agent.write', tier: 1, label: 'Create or change an n8n agent draft' },
	{ opClass: 'memory.write', tier: 1, label: 'Remember something in memory' },
	{ opClass: 'workflow.test', tier: 2, label: 'Test or run a workflow manually' },
	{ opClass: 'hands.run', tier: 2, label: 'Run a command in a workspace' },
	{ opClass: 'n8n-agent.execute', tier: 2, label: 'Call an n8n agent' },
	{ opClass: 'run.start', tier: 2, label: "Start an agent's run" },
	{ opClass: 'run.stop', tier: 2, label: "Stop an agent's run" },
	{ opClass: 'memory.dream', tier: 2, label: 'Refresh the model of the owner' },
	{ opClass: 'workflow.publish', tier: 3, label: 'Publish, unpublish or archive a workflow' },
	{ opClass: 'n8n-agent.publish', tier: 3, label: 'Publish, unpublish or delete an n8n agent, or change its integrations' },
	{ opClass: 'agent.write', tier: 3, label: "Create or change an agent's charter, deliverables or status" },
	{ opClass: 'hands.network', tier: 3, label: 'Give a command the network' },
	{ opClass: 'web.act', tier: 3, label: 'Act on a web page: click, type, submit' },
	{ opClass: 'run.deliver', tier: 3, label: 'Accept a run\'s output as delivered' },
	{ opClass: 'guard.decide', tier: 3, label: 'Decide a Guard card' },
	{ opClass: 'settings.write', tier: 3, label: "Change Aon's settings" },
	{ opClass: 'mail.read', tier: 0, label: 'Read mail: threads, messages and attachment listings' },
	{ opClass: 'mail.draft', tier: 1, label: 'Create a Gmail draft' },
	{ opClass: 'mail.write', tier: 1, label: 'Label or mark mail read or unread' },
	{ opClass: 'mail.send', tier: 3, label: 'Send mail as him' },
	{ opClass: 'calendar.read', tier: 0, label: 'Read calendar events' },
	{ opClass: 'calendar.write', tier: 3, label: 'Create, change or delete a calendar event' },
	{ opClass: 'drive.read', tier: 0, label: 'Read Drive files, folders and sheets' },
	{ opClass: 'drive.write', tier: 1, label: 'Create a Drive file or write a sheet' },
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
	memory_entity: 'read',
	memory_facts: 'read',
	memory_pages: 'read',
	memory_about_me: 'read',
	memory_context: 'read',
	aon_agents: 'read',
	aon_agent: 'read',
	aon_agents_overview: 'read',
	aon_runs: 'read',
	aon_run_report: 'read',
	guard_cards: 'read',
	guard_overview: 'read',
	guard_council: 'read',
	aon_settings: 'read',
	aon_capabilities: 'read',
	aon_google_status: 'read',
	aon_threads: 'read',
	aon_thread: 'read',
	aon_toolbox: 'read',
	aon_toolbox_rescan: 'read',
	voice_status: 'read',
	browser_status: 'read',
	memory_overview: 'read',
	memory_sources: 'read',
	memory_source: 'read',
	memory_graph: 'read',
	memory_sky: 'read',
	memory_entities: 'read',
	memory_observations: 'read',
	hands_list_workspaces: 'read',
	aon_state: 'read',
	plan_tasks: 'read',
	plan_day: 'read',
	mail_search: 'mail.read',
	mail_read: 'mail.read',
	calendar_list: 'calendar.read',
	drive_search: 'drive.read',
	drive_folder: 'drive.read',
	drive_read: 'drive.read',
	sheet_read: 'drive.read',
	// tier 1
	create_workflow_from_code: 'workflow.write',
	update_workflow: 'workflow.write',
	prepare_workflow_pin_data: 'workflow.write',
	restore_workflow_version: 'workflow.write',
	hands_write_file: 'hands.write',
	hands_delete: 'hands.write',
	hands_create_workspace: 'hands.write',
	hands_delete_workspace: 'hands.write',
	memory_source_delete: 'memory.delete',
	aon_thread_rename: 'threads.write',
	aon_thread_delete: 'threads.write',
	web_read: 'web.read',
	create_data_table: 'datatable.write',
	rename_data_table: 'datatable.write',
	add_data_table_column: 'datatable.write',
	delete_data_table_column: 'datatable.write',
	rename_data_table_column: 'datatable.write',
	add_data_table_rows: 'datatable.write',
	plan_task_add: 'datatable.write',
	plan_task_move: 'datatable.write',
	create_folder: 'project.write',
	update_folder: 'project.write',
	move_workflows_to_folder: 'project.write',
	create_agent: 'n8n-agent.write',
	mutate_agent: 'n8n-agent.write',
	revert_agent: 'n8n-agent.write',
	memory_capture: 'memory.write',
	memory_page_write: 'memory.write',
	aon_tool_used: 'memory.write',
	mail_draft: 'mail.draft',
	mail_label: 'mail.write',
	mail_attachment: 'hands.write',
	drive_create: 'drive.write',
	sheet_write: 'drive.write',
	// tier 2
	test_workflow: 'workflow.test',
	execute_workflow: 'workflow.test',
	hands_run: 'hands.run',
	call_agent: 'n8n-agent.execute',
	aon_run_start: 'run.start',
	aon_run_stop: 'run.stop',
	memory_dream_run: 'memory.dream',
	// tier 3
	publish_workflow: 'workflow.publish',
	unpublish_workflow: 'workflow.publish',
	archive_workflow: 'workflow.publish',
	publish_agent: 'n8n-agent.publish',
	unpublish_agent: 'n8n-agent.publish',
	delete_agent: 'n8n-agent.publish',
	update_agent_integration: 'n8n-agent.publish',
	verify_agent_mcp_server: 'n8n-agent.publish',
	web_act: 'web.act',
	aon_agent_create: 'agent.write',
	aon_agent_update: 'agent.write',
	aon_deliverable_upsert: 'agent.write',
	aon_deliverable_delete: 'agent.write',
	aon_agent_status: 'agent.write',
	aon_agent_delete: 'agent.write',
	aon_agent_breaker_reset: 'agent.write',
	aon_confirm_agent: 'agent.write',
	guard_decide: 'guard.decide',
	memory_fact_decide: 'memory.write',
	aon_settings_set: 'settings.write',
	aon_settings_skill_set: 'settings.write',
	guard_policy_set: 'access',
	guard_policy_delete: 'access',
	mail_send: 'mail.send',
	calendar_create: 'calendar.write',
	calendar_update: 'calendar.write',
	calendar_delete: 'calendar.write',
};

const UNKNOWN_TOOL_TIER = 3;

export function tierOf(opClass: string): number {
	return AON_OP_CLASSES.find((c) => c.opClass === opClass)?.tier ?? UNKNOWN_TOOL_TIER;
}

/**
 * Old Aon app tool name -> the tool it now aliases. Registered by
 * `McpService.getServer` as a same-handler, same-schema clone under the old
 * name, so anything written for the old Aon app keeps working. `aon_runs`,
 * `aon_run_report` and `aon_agents` kept their old names outright, so they
 * need no entry here.
 */
export const ALIASES: Record<string, string> = {
	aon_memory_search: 'memory_search',
	aon_capture: 'memory_capture',
	aon_web_read: 'web_read',
	aon_web_act: 'web_act',
	aon_mail_send: 'mail_send',
	aon_calendar_create: 'calendar_create',
	aon_approvals: 'guard_cards',
	aon_decide: 'guard_decide',
	aon_fact_decide: 'memory_fact_decide',
	aon_dream: 'memory_dream_run',
	aon_context: 'memory_context',
	aon_about_me: 'memory_about_me',
	aon_config: 'aon_settings',
	aon_configure: 'aon_settings_set',
	aon_search: 'memory_pages',
	aon_write_page: 'memory_page_write',
	aon_council: 'guard_council',
	aon_create_agent: 'aon_agent_create',
	aon_flows: 'search_workflows',
	aon_create_flow: 'create_workflow_from_code',
	aon_publish_flow: 'publish_workflow',
	aon_tasks: 'plan_day',
	aon_task_add: 'plan_task_add',
};

/** The reverse of ALIASES: a current tool name -> every old name that aliases it. */
export const ALIAS_TARGETS: ReadonlyMap<string, readonly string[]> = (() => {
	const targets = new Map<string, string[]>();
	for (const [oldName, targetName] of Object.entries(ALIASES)) {
		const existing = targets.get(targetName);
		if (existing) existing.push(oldName);
		else targets.set(targetName, [oldName]);
	}
	return targets;
})();

/** The op class a tool call falls under; a hands_run with the network asked for is a network op. An old-app alias resolves to its current tool first. */
export function opClassOfTool(toolName: string, args?: Record<string, unknown>): AonGuardOpClass {
	const bare = toolName.replace(/^mcp__n8n__/, '');
	const resolved = ALIASES[bare] ?? bare;
	let opClass = TOOL_OP_CLASS[resolved];
	if (resolved === 'hands_run' && args?.network === true) opClass = 'hands.network';
	if (resolved === 'guard_request') opClass = 'read';
	if (!opClass) return { opClass: `tool:${resolved}`, tier: UNKNOWN_TOOL_TIER, label: `Use the ${resolved} tool` };
	return AON_OP_CLASSES.find((c) => c.opClass === opClass) ?? { opClass, tier: UNKNOWN_TOOL_TIER, label: opClass };
}

/** Every tool this instance's MCP server may register, for building a run's allow-list. Includes the old Aon app's aliases. */
export const KNOWN_TOOL_NAMES: readonly string[] = [...Object.keys(TOOL_OP_CLASS), ...Object.keys(ALIASES)];
