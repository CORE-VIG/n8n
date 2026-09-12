<script setup lang="ts">
import type { AonAgentSummary, AonRunList } from '@n8n/api-types';
import { N8nBadge, N8nOption, N8nSelect } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';

import { getAgents } from '../aon.api';
import AonNav from '../components/AonNav.vue';
import { AON_AGENT_VIEW, AON_RUN_VIEW } from '../constants';
import { getRuns } from '../runs.api';
import { statusTheme } from '../status';
import { useAonTime } from '../useAonTime';

const i18n = useI18n();
const rootStore = useRootStore();
const router = useRouter();
const { ago } = useAonTime();

const agents = ref<AonAgentSummary[]>([]);
const list = ref<AonRunList | null>(null);
const error = ref<string | null>(null);

const statusFilter = ref('');
const agentFilter = ref('');

const statusEntries = computed(() => Object.entries(list.value?.byStatus ?? {}));

const euro = (n: number) => `€${n.toFixed(2)}`;

/** `catch` hands us `unknown`; this narrows without a cast. */
function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

async function load() {
	try {
		list.value = await getRuns(rootStore.restApiContext, {
			agent: agentFilter.value || undefined,
			status: statusFilter.value || undefined,
			limit: 50,
		});
		error.value = null;
	} catch (e) {
		error.value = errorMessage(e);
	}
}

function goToRun(id: string) {
	void router.push({ name: AON_RUN_VIEW, params: { id } });
}

onMounted(async () => {
	try {
		agents.value = await getAgents(rootStore.restApiContext);
	} catch {
		// The agent filter is a convenience; the table still works without it.
	}
	await load();
});

watch([statusFilter, agentFilter], load);
</script>

<template>
	<div :class="$style.page">
		<AonNav />
		<h1 :class="$style.title">{{ i18n.baseText('aon.runs.title') }}</h1>
		<p :class="$style.lede">{{ i18n.baseText('aon.runs.lede') }}</p>

		<div :class="$style.filters">
			<div :class="$style.filterGroup">
				<span :class="$style.filterLabel">{{ i18n.baseText('aon.runs.filterStatus') }}</span>
				<div :class="$style.chips">
					<button
						type="button"
						:class="[$style.chip, statusFilter === '' && $style.chipOn]"
						@click="statusFilter = ''"
					>
						{{ i18n.baseText('aon.runs.filterAll') }}
					</button>
					<button
						v-for="[status, count] in statusEntries"
						:key="status"
						type="button"
						:class="[$style.chip, statusFilter === status && $style.chipOn]"
						@click="statusFilter = status"
					>
						{{ status }} ({{ count }})
					</button>
				</div>
			</div>
			<div :class="$style.filterGroup">
				<span :class="$style.filterLabel">{{ i18n.baseText('aon.runs.filterAgent') }}</span>
				<N8nSelect v-model="agentFilter" :teleported="false" size="small" :class="$style.select">
					<N8nOption value="" :label="i18n.baseText('aon.runs.filterAll')" />
					<N8nOption v-for="agent in agents" :key="agent.id" :value="agent.id" :label="agent.name" />
				</N8nSelect>
			</div>
		</div>

		<p v-if="error" :class="$style.error">
			{{ i18n.baseText('aon.home.failed', { interpolate: { message: error } }) }}
		</p>
		<p v-else-if="list && list.items.length === 0" :class="$style.lede">
			{{ i18n.baseText('aon.runs.empty') }}
		</p>

		<div v-else-if="list" :class="$style.tableWrap">
			<table :class="$style.table" data-test-id="aon-runs-table">
				<thead>
					<tr>
						<th>{{ i18n.baseText('aon.runs.column.status') }}</th>
						<th>{{ i18n.baseText('aon.runs.column.agent') }}</th>
						<th>{{ i18n.baseText('aon.runs.column.deliverable') }}</th>
						<th>{{ i18n.baseText('aon.runs.column.invokedBy') }}</th>
						<th>{{ i18n.baseText('aon.runs.column.model') }}</th>
						<th :class="$style.num">{{ i18n.baseText('aon.runs.column.cost') }}</th>
						<th>{{ i18n.baseText('aon.runs.column.when') }}</th>
					</tr>
				</thead>
				<tbody>
					<tr
						v-for="run in list.items"
						:key="run.id"
						:class="$style.row"
						:data-test-id="`aon-run-${run.id}`"
						@click="goToRun(run.id)"
					>
						<td><N8nBadge :theme="statusTheme(run.status)" size="small">{{ run.status }}</N8nBadge></td>
						<td>
							<RouterLink
								v-if="run.agentSlug"
								:to="{ name: AON_AGENT_VIEW, params: { slug: run.agentSlug } }"
								:class="$style.name"
								@click.stop
							>
								{{ run.agentName ?? run.agentSlug }}
							</RouterLink>
							<span v-else>{{ run.agentName ?? '—' }}</span>
						</td>
						<td>{{ run.deliverableName ?? run.deliverableId }}</td>
						<td>{{ run.invokedBy }}</td>
						<td>{{ run.model ?? '—' }}</td>
						<td :class="$style.num">{{ euro(run.costEur) }}</td>
						<td :class="$style.when">{{ ago(run.createdAt) }}</td>
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

.filters {
	display: flex;
	flex-wrap: wrap;
	align-items: flex-end;
	gap: var(--spacing--lg);
	margin-bottom: var(--spacing--xs);
}

.filterGroup {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--3xs);
}

.filterLabel {
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
}

.chips {
	display: flex;
	flex-wrap: wrap;
	gap: var(--spacing--3xs);
}

.chip {
	font: inherit;
	font-size: var(--font-size--2xs);
	padding: var(--spacing--4xs) var(--spacing--xs);
	border: var(--border);
	border-radius: var(--radius--sm);
	background: var(--color--background--light-3);
	color: var(--color--text);
	cursor: pointer;
	white-space: nowrap;
}

.chipOn {
	background: var(--color--primary);
	border-color: var(--color--primary);
	color: var(--color--neutral-white);
}

.select {
	min-width: 200px;
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

.row {
	cursor: pointer;

	&:hover {
		background: var(--table--row--color--background--hover);
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

.when {
	white-space: nowrap;
	color: var(--color--text--tint-1);
}
</style>
