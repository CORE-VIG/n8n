<script setup lang="ts">
import { useI18n } from '@n8n/i18n';
import { RouterLink, useRoute } from 'vue-router';

import {
	AON_AGENTS_VIEW,
	AON_HANDS_VIEW,
	AON_HOME_VIEW,
	AON_MEMORY_VIEW,
	AON_RUNS_VIEW,
} from '../constants';

/** The tabs every Aon page carries, so the parts are always one click apart. */
const i18n = useI18n();
const route = useRoute();

const tabs = [
	{ name: AON_HOME_VIEW, label: 'aon.nav.home', prefix: '/aon' },
	{ name: AON_AGENTS_VIEW, label: 'aon.nav.agents', prefix: '/aon/agents' },
	{ name: AON_RUNS_VIEW, label: 'aon.nav.runs', prefix: '/aon/runs' },
	{ name: AON_MEMORY_VIEW, label: 'aon.nav.memory', prefix: '/aon/memory' },
	{ name: AON_HANDS_VIEW, label: 'aon.nav.hands', prefix: '/aon/hands' },
] as const;

const isActive = (prefix: string) =>
	prefix === '/aon' ? route.path === '/aon' : route.path.startsWith(prefix);
</script>

<template>
	<nav :class="$style.nav" data-test-id="aon-nav" aria-label="Aon">
		<RouterLink
			v-for="tab in tabs"
			:key="tab.name"
			:to="{ name: tab.name }"
			:class="[$style.tab, isActive(tab.prefix) && $style.active]"
		>
			{{ i18n.baseText(tab.label) }}
		</RouterLink>
	</nav>
</template>

<style lang="scss" module>
.nav {
	display: flex;
	gap: var(--spacing--4xs);
	border-bottom: var(--border);
	margin-bottom: var(--spacing--md);
}

.tab {
	padding: var(--spacing--2xs) var(--spacing--xs);
	margin-bottom: -1px;
	border-bottom: 2px solid transparent;
	color: var(--color--text--tint-1);
	font-size: var(--font-size--sm);
	text-decoration: none;

	&:hover {
		color: var(--color--text--shade-1);
		text-decoration: none;
	}
}

.active {
	color: var(--color--text--shade-1);
	border-bottom-color: var(--color--primary);
}
</style>
