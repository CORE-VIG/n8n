import type { FrontendModuleDescription } from '@n8n/frontend-module-sdk';

import { AON_AGENT_VIEW, AON_AGENTS_VIEW, AON_HOME_VIEW } from './constants';

const AonHomeView = async () => await import('./views/AonHomeView.vue');
const AonAgentsView = async () => await import('./views/AonAgentsView.vue');
const AonAgentView = async () => await import('./views/AonAgentView.vue');

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
		{
			name: AON_HOME_VIEW,
			path: '/aon',
			component: AonHomeView,
			meta: {
				middleware: ['authenticated'],
			},
		},
		{
			name: AON_AGENTS_VIEW,
			path: '/aon/agents',
			component: AonAgentsView,
			meta: {
				middleware: ['authenticated'],
			},
		},
		{
			name: AON_AGENT_VIEW,
			path: '/aon/agents/:slug',
			component: AonAgentView,
			meta: {
				middleware: ['authenticated'],
			},
		},
	],
};
