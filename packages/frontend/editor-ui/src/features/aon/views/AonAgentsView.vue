<script setup lang="ts">
import type { AonAgentSummary } from '@n8n/api-types';
import { N8nBadge, N8nButton } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { onMounted, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';

import { getAgents } from '../aon.api';
import AonNav from '../components/AonNav.vue';
import { AON_AGENT_NEW_VIEW, AON_AGENT_VIEW } from '../constants';
import { statusTheme } from '../status';
import { useAonTime } from '../useAonTime';

const i18n = useI18n();
const rootStore = useRootStore();
const router = useRouter();
const { ago } = useAonTime();

const agents = ref<AonAgentSummary[] | null>(null);
const error = ref<string | null>(null);

onMounted(async () => {
	try {
		agents.value = await getAgents(rootStore.restApiContext);
	} catch (e) {
		error.value = (e as Error).message;
	}
});
</script>

<template>
	<div :class="$style.page">
		<AonNav />
		<div :class="$style.head">
			<h1 :class="$style.title">{{ i18n.baseText('aon.agents.title') }}</h1>
			<N8nButton
				:label="i18n.baseText('aon.agents.new')"
				data-test-id="aon-agent-new"
				@click="router.push({ name: AON_AGENT_NEW_VIEW })"
			/>
		</div>
		<p :class="$style.lede">{{ i18n.baseText('aon.agents.lede') }}</p>

		<p v-if="error" :class="$style.error">
			{{ i18n.baseText('aon.home.failed', { interpolate: { message: error } }) }}
		</p>
		<p v-else-if="agents && agents.length === 0" :class="$style.lede">
			{{ i18n.baseText('aon.agents.empty') }}
		</p>

		<div v-else-if="agents" :class="$style.tableWrap">
			<table :class="$style.table" data-test-id="aon-agents-table">
				<thead>
					<tr>
						<th>{{ i18n.baseText('aon.agents.column.agent') }}</th>
						<th>{{ i18n.baseText('aon.agents.column.status') }}</th>
						<th :class="$style.num">{{ i18n.baseText('aon.agents.column.deliverables') }}</th>
						<th :class="$style.num">{{ i18n.baseText('aon.agents.column.runs') }}</th>
						<th>{{ i18n.baseText('aon.agents.column.lastRun') }}</th>
					</tr>
				</thead>
				<tbody>
					<tr v-for="agent in agents" :key="agent.id" :data-test-id="`aon-agent-${agent.slug}`">
						<td>
							<RouterLink
								:to="{ name: AON_AGENT_VIEW, params: { slug: agent.slug } }"
								:class="$style.name"
							>
								{{ agent.name }}
							</RouterLink>
							<div :class="$style.persona">{{ agent.persona }}</div>
						</td>
						<td>
							<N8nBadge :theme="statusTheme(agent.status)" size="small">{{ agent.status }}</N8nBadge>
						</td>
						<td :class="$style.num">{{ agent.counts.deliverables }}</td>
						<td :class="$style.num">{{ agent.counts.runs }}</td>
						<td>
							<template v-if="agent.lastRun">
								<N8nBadge :theme="statusTheme(agent.lastRun.status)" size="small">
									{{ agent.lastRun.status }}
								</N8nBadge>
								<span :class="$style.when">{{ ago(agent.lastRun.createdAt) }}</span>
							</template>
							<span v-else :class="$style.when">{{ i18n.baseText('aon.agents.noRun') }}</span>
						</td>
					</tr>
				</tbody>
			</table>
		</div>
	</div>
</template>

<style lang="scss" module>
.page {
	max-width: 960px;
	margin: 0 auto;
	padding: var(--spacing--2xl) var(--spacing--lg) var(--spacing--3xl);
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xs);
}

.back {
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
	align-self: flex-start;
}

.head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--spacing--sm);
}

.title {
	font-size: var(--font-size--2xl);
	margin: 0;
	color: var(--color--text--shade-1);
}

.lede {
	color: var(--color--text--tint-1);
	margin: 0 0 var(--spacing--md);
	max-width: 60ch;
}

.error {
	margin: 0;
	color: var(--color--danger);
}

.tableWrap {
	overflow-x: auto;
	border: var(--border);
	border-radius: var(--radius--lg);
	background: var(--color--background--light-3);
}

.table {
	width: 100%;
	border-collapse: collapse;

	th,
	td {
		text-align: left;
		padding: var(--spacing--xs) var(--spacing--sm);
		vertical-align: top;
		border-bottom: var(--border);
	}

	th {
		font-size: var(--font-size--2xs);
		font-weight: var(--font-weight--bold);
		color: var(--color--text--tint-1);
		white-space: nowrap;
	}

	tbody tr:last-child td {
		border-bottom: none;
	}
}

.num {
	text-align: right !important;
	font-variant-numeric: tabular-nums;
}

.name {
	font-weight: var(--font-weight--bold);
	color: var(--color--text--shade-1);
}

.persona {
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
	max-width: 48ch;
	display: -webkit-box;
	-webkit-line-clamp: 2;
	-webkit-box-orient: vertical;
	overflow: hidden;
}

.when {
	margin-left: var(--spacing--3xs);
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
	white-space: nowrap;
}
</style>
