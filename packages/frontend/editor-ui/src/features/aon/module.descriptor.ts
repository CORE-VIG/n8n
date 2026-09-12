import type { FrontendModuleDescription } from '@n8n/frontend-module-sdk';

import {
	AON_AGENT_VIEW,
	AON_AGENTS_VIEW,
	AON_GUARD_VIEW,
	AON_HANDS_VIEW,
	AON_HOME_VIEW,
	AON_MEMORY_VIEW,
	AON_RUN_VIEW,
	AON_RUNS_VIEW,
	AON_SOURCE_VIEW,
	AON_WORKSPACE_VIEW,
} from './constants';

const AonHomeView = async () => await import('./views/AonHomeView.vue');
const AonAgentsView = async () => await import('./views/AonAgentsView.vue');
const AonAgentView = async () => await import('./views/AonAgentView.vue');
const AonRunsView = async () => await import('./views/AonRunsView.vue');
const AonRunView = async () => await import('./views/AonRunView.vue');
const AonMemoryView = async () => await import('./views/AonMemoryView.vue');
const AonSourceView = async () => await import('./views/AonSourceView.vue');
const AonHandsView = async () => await import('./views/AonHandsView.vue');
const AonWorkspaceView = async () => await import('./views/AonWorkspaceView.vue');
const AonGuardView = async () => await import('./views/AonGuardView.vue');

/**
 * Aon inside n8n.
 *
 * The module owns the Aon pages. The assistant window is not a route: it
 * is mounted once at the root of the app so it can be opened from anywhere,
 * the way a messenger sits over whatever you are doing.
 */
export const AonModule: FrontendModuleDescription = {
	id: 'aon',
	name: 'Aon',
	description: 'The assistant, Aon agents, memory, Hands and Guard.',
	icon: 'sparkles',
	routes: [
		{ name: AON_HOME_VIEW, path: '/aon', component: AonHomeView, meta: { middleware: ['authenticated'] } },
		{ name: AON_AGENTS_VIEW, path: '/aon/agents', component: AonAgentsView, meta: { middleware: ['authenticated'] } },
		{ name: AON_AGENT_VIEW, path: '/aon/agents/:slug', component: AonAgentView, meta: { middleware: ['authenticated'] } },
		{ name: AON_RUNS_VIEW, path: '/aon/runs', component: AonRunsView, meta: { middleware: ['authenticated'] } },
		{ name: AON_RUN_VIEW, path: '/aon/runs/:id', component: AonRunView, meta: { middleware: ['authenticated'] } },
		{ name: AON_MEMORY_VIEW, path: '/aon/memory', component: AonMemoryView, meta: { middleware: ['authenticated'] } },
		{ name: AON_SOURCE_VIEW, path: '/aon/memory/:id', component: AonSourceView, meta: { middleware: ['authenticated'] } },
		{ name: AON_HANDS_VIEW, path: '/aon/hands', component: AonHandsView, meta: { middleware: ['authenticated'] } },
		{
			name: AON_WORKSPACE_VIEW,
			path: '/aon/hands/:slug',
			component: AonWorkspaceView,
			meta: { middleware: ['authenticated'] },
		},
		{ name: AON_GUARD_VIEW, path: '/aon/guard', component: AonGuardView, meta: { middleware: ['authenticated'] } },
	],
};
