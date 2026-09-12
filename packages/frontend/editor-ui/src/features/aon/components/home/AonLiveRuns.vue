<script setup lang="ts">
import type { AonRunSummary } from '@n8n/api-types';
import { N8nBadge } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { RouterLink } from 'vue-router';

import { AON_RUN_VIEW, AON_RUNS_VIEW } from '../../constants';
import { getRuns } from '../../runs.api';
import { statusTheme } from '../../status';
import { useAonTime } from '../../useAonTime';

const LIVE_STATUSES = new Set(['working', 'validating', 'waiting_approval', 'needs_help']);
const FINISHED_STATUSES = new Set(['done', 'failed', 'stopped']);
const POLL_MS = 5_000;
const FETCH_LIMIT = 50;
const FINISHED_SHOWN = 5;

const i18n = useI18n();
const rootStore = useRootStore();
const { ago } = useAonTime();

const items = ref<AonRunSummary[]>([]);
const error = ref<string | null>(null);

const live = computed(() => items.value.filter((run) => LIVE_STATUSES.has(run.status)));
const finished = computed(() =>
	items.value.filter((run) => FINISHED_STATUSES.has(run.status)).slice(0, FINISHED_SHOWN),
);

async function load() {
	try {
		const page = await getRuns(rootStore.restApiContext, { limit: FETCH_LIMIT });
		items.value = page.items;
		error.value = null;
	} catch (e) {
		error.value = (e as Error).message;
	}
}

let pollTimer: ReturnType<typeof setInterval> | undefined;

onMounted(async () => {
	await load();
	pollTimer = setInterval(() => {
		if (document.visibilityState === 'visible' && live.value.length > 0) void load();
	}, POLL_MS);
});

onUnmounted(() => {
	if (pollTimer) clearInterval(pollTimer);
});
</script>

<template>
	<div :class="$style.card" data-test-id="aon-home-live-runs">
		<div :class="$style.head">
			<h2 :class="$style.h2">{{ i18n.baseText('aon.home.liveRuns') }}</h2>
			<RouterLink :to="{ name: AON_RUNS_VIEW }" :class="$style.more">
				{{ i18n.baseText('aon.home.seeAll') }}
			</RouterLink>
		</div>

		<p v-if="error" :class="$style.error">
			{{ i18n.baseText('aon.home.failed', { interpolate: { message: error } }) }}
		</p>
		<p v-else-if="live.length === 0" :class="$style.empty">
			{{ i18n.baseText('aon.home.liveRunsEmpty') }}
		</p>
		<ul v-else :class="$style.rows">
			<li v-for="run in live" :key="run.id" :class="$style.row">
				<N8nBadge :theme="statusTheme(run.status)" size="small">{{ run.status }}</N8nBadge>
				<RouterLink :to="{ name: AON_RUN_VIEW, params: { id: run.id } }" :class="$style.rowMain">
					{{ run.agentName ?? run.agentSlug ?? run.deliverableName ?? run.deliverableId }}
				</RouterLink>
				<span :class="$style.rowMeta">{{ ago(run.startedAt ?? run.createdAt) }}</span>
			</li>
		</ul>

		<template v-if="finished.length > 0">
			<h3 :class="$style.h3">{{ i18n.baseText('aon.home.finished') }}</h3>
			<ul :class="$style.rows">
				<li v-for="run in finished" :key="run.id" :class="$style.row">
					<N8nBadge :theme="statusTheme(run.status)" size="small">{{ run.status }}</N8nBadge>
					<RouterLink :to="{ name: AON_RUN_VIEW, params: { id: run.id } }" :class="$style.rowMain">
						{{ run.agentName ?? run.agentSlug ?? run.deliverableName ?? run.deliverableId }}
					</RouterLink>
					<span :class="$style.rowMeta">{{ ago(run.finishedAt ?? run.createdAt) }}</span>
				</li>
			</ul>
		</template>
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

.head {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	gap: var(--spacing--xs);
}

.h2 {
	font-size: var(--font-size--lg);
	margin: 0;
	color: var(--color--text--shade-1);
}

.h3 {
	font-size: var(--font-size--2xs);
	text-transform: uppercase;
	letter-spacing: 0.02em;
	margin: var(--spacing--2xs) 0 0;
	color: var(--color--text--tint-1);
}

.more {
	font: inherit;
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
	background: none;
	border: none;
	padding: 0;
	text-decoration: none;

	&:hover {
		color: var(--color--primary);
		text-decoration: none;
	}
}

.error {
	margin: 0;
	color: var(--color--danger);
}

.empty {
	margin: 0;
	color: var(--color--text--tint-1);
}

.rows {
	list-style: none;
	margin: 0;
	padding: 0;
	display: flex;
	flex-direction: column;
	gap: var(--spacing--3xs);
}

.row {
	display: flex;
	align-items: baseline;
	gap: var(--spacing--2xs);
	min-width: 0;
}

.rowMain {
	flex: 1 1 auto;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	color: var(--color--text--shade-1);
}

.rowMeta {
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
	white-space: nowrap;
}
</style>
