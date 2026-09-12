<script setup lang="ts">
import type { AonAgentSummary } from '@n8n/api-types';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';

import { getAgents } from '../../aon.api';
import { AON_AGENT_VIEW } from '../../constants';
import { statusTheme } from '../../status';
import { useAonTime } from '../../useAonTime';

const DOT_COLOR: Record<string, string> = {
	success: 'var(--color--success)',
	warning: 'var(--color--warning)',
	danger: 'var(--color--danger)',
	primary: 'var(--color--primary)',
};

const i18n = useI18n();
const rootStore = useRootStore();
const { ago } = useAonTime();

const agents = ref<AonAgentSummary[]>([]);
const error = ref<string | null>(null);

const active = computed(() => agents.value.filter((a) => a.status === 'active'));

function dotColor(status: string): string {
	return DOT_COLOR[statusTheme(status)] ?? 'var(--color--text--tint-2)';
}

onMounted(async () => {
	try {
		agents.value = await getAgents(rootStore.restApiContext);
	} catch (e) {
		error.value = (e as Error).message;
	}
});
</script>

<template>
	<div :class="$style.card" data-test-id="aon-home-agents">
		<h2 :class="$style.h2">{{ i18n.baseText('aon.home.agents') }}</h2>

		<p v-if="error" :class="$style.error">
			{{ i18n.baseText('aon.home.failed', { interpolate: { message: error } }) }}
		</p>
		<p v-else-if="active.length === 0" :class="$style.empty">
			{{ i18n.baseText('aon.home.agentsEmpty') }}
		</p>

		<div :class="$style.chips">
			<RouterLink
				v-for="agent in active"
				:key="agent.id"
				:to="{ name: AON_AGENT_VIEW, params: { slug: agent.slug } }"
				:class="$style.chip"
			>
				<span :class="$style.dot" :style="{ background: dotColor(agent.status) }" />
				<span :class="$style.chipName">{{ agent.name }}</span>
				<span v-if="agent.lastRun" :class="$style.chipMeta">
					{{ i18n.baseText('aon.home.lastRun', { interpolate: { when: ago(agent.lastRun.createdAt) } }) }}
				</span>
			</RouterLink>
			<RouterLink to="/aon/agents/new" :class="[$style.chip, $style.chipNew]">
				{{ i18n.baseText('aon.home.newAgent') }}
			</RouterLink>
		</div>
	</div>
</template>

<style lang="scss" module>
.card {
	padding: var(--spacing--sm) var(--spacing--md);
	border: var(--border);
	border-radius: var(--radius--lg);
	background: var(--color--background--light-3);
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xs);
}

.h2 {
	font-size: var(--font-size--lg);
	margin: 0;
	color: var(--color--text--shade-1);
}

.error {
	margin: 0;
	color: var(--color--danger);
}

.empty {
	margin: 0;
	color: var(--color--text--tint-1);
}

.chips {
	display: flex;
	flex-wrap: wrap;
	gap: var(--spacing--2xs);
}

.chip {
	display: inline-flex;
	align-items: center;
	gap: var(--spacing--3xs);
	padding: var(--spacing--3xs) var(--spacing--sm);
	border: var(--border);
	border-radius: var(--radius--full);
	background: var(--color--background--base);
	color: var(--color--text--shade-1);
	text-decoration: none;
	font-size: var(--font-size--2xs);

	&:hover {
		border-color: var(--color--primary);
		text-decoration: none;
	}
}

.chipNew {
	color: var(--color--primary);
	border-style: dashed;
}

.dot {
	width: 8px;
	height: 8px;
	border-radius: var(--radius--full);
	flex-shrink: 0;
}

.chipName {
	font-weight: var(--font-weight--bold);
	white-space: nowrap;
}

.chipMeta {
	color: var(--color--text--tint-1);
	white-space: nowrap;
}
</style>
