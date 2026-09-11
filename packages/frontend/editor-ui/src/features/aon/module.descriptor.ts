import type { FrontendModuleDescription } from '@n8n/frontend-module-sdk';

import { AON_HOME_VIEW } from './constants';

const AonHomeView = async () => await import('./views/AonHomeView.vue');

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
	description: 'Your agents, your memory, and the assistant that builds for you.',
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
	],
};
