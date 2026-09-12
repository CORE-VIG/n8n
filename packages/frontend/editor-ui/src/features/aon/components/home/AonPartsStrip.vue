<script setup lang="ts">
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { RouterLink } from 'vue-router';

import { getAgents, getAgentsOverview, getMemoryOverview } from '../../aon.api';
import { useAonAssistantStore } from '../../assistant/aonAssistant.store';
import { AON_GUARD_VIEW, AON_HANDS_VIEW, AON_MEMORY_VIEW, AON_RUNS_VIEW } from '../../constants';
import { getGuardOverview } from '../../guard.api';
import { getWorkspaces } from '../../hands.api';
import { getHealth } from '../../home.api';

const POLL_MS = 20_000;

interface Part {
	key: string;
	name: string;
	figure: string;
	status: string;
}

const i18n = useI18n();
const rootStore = useRootStore();
const assistant = useAonAssistantStore();

const health = ref<{ ok: boolean; sessions: number } | null>(null);
const runsByStatus = ref<Record<string, number>>({});
const breakerTripped = ref(false);
const guardPending = ref(0);
const memorySources = ref<number | null>(null);
const memoryChunks = ref<number | null>(null);
const handsWorkspaces = ref<number | null>(null);
const loaded = ref(false);

const fmt = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString());

async function load() {
	const ctx = rootStore.restApiContext;
	const results = await Promise.allSettled([
		getHealth(ctx),
		getAgentsOverview(ctx),
		getAgents(ctx),
		getGuardOverview(ctx),
		getMemoryOverview(ctx),
		getWorkspaces(ctx),
	]);
	if (results[0].status === 'fulfilled') health.value = results[0].value;
	if (results[1].status === 'fulfilled') runsByStatus.value = results[1].value.runsByStatus;
	if (results[2].status === 'fulfilled') {
		breakerTripped.value = results[2].value.some((a) => a.breakerTrippedAt !== null);
	}
	if (results[3].status === 'fulfilled') guardPending.value = results[3].value.pending.length;
	if (results[4].status === 'fulfilled') {
		memorySources.value = results[4].value.sources;
		memoryChunks.value = results[4].value.chunks;
	}
	if (results[5].status === 'fulfilled') handsWorkspaces.value = results[5].value.length;
	loaded.value = true;
}

const inFlight = computed(() => {
	const s = runsByStatus.value;
	return (s.working ?? 0) + (s.validating ?? 0) + (s.waiting_approval ?? 0) + (s.needs_help ?? 0);
});

const parts = computed<Part[]>(() => [
	{
		key: 'assistant',
		name: i18n.baseText('aon.home.part.assistant'),
		figure: fmt(health.value?.sessions),
		status: health.value
			? health.value.ok
				? i18n.baseText('aon.home.part.assistant.connected')
				: i18n.baseText('aon.home.part.assistant.offline')
			: '—',
	},
	{
		key: 'executor',
		name: i18n.baseText('aon.home.part.executor'),
		figure: fmt(inFlight.value),
		status: breakerTripped.value
			? i18n.baseText('aon.home.part.executor.tripped')
			: i18n.baseText('aon.home.part.executor.queued', {
					interpolate: { count: String(runsByStatus.value.queued ?? 0) },
				}),
	},
	{
		key: 'guard',
		name: i18n.baseText('aon.nav.guard'),
		figure: fmt(guardPending.value),
		status:
			guardPending.value > 0
				? i18n.baseText('aon.home.part.guard.needsYou')
				: i18n.baseText('aon.home.part.guard.clear'),
	},
	{
		key: 'memory',
		name: i18n.baseText('aon.nav.memory'),
		figure: fmt(memorySources.value),
		status: i18n.baseText('aon.home.part.memory.chunks', {
			interpolate: { count: fmt(memoryChunks.value) },
		}),
	},
	{
		key: 'hands',
		name: i18n.baseText('aon.nav.hands'),
		figure: fmt(handsWorkspaces.value),
		status:
			(handsWorkspaces.value ?? 0) > 0
				? i18n.baseText('aon.home.part.hands.ready')
				: i18n.baseText('aon.home.part.hands.empty'),
	},
]);

let pollTimer: ReturnType<typeof setInterval> | undefined;

onMounted(async () => {
	await load();
	pollTimer = setInterval(() => {
		if (document.visibilityState === 'visible') void load();
	}, POLL_MS);
});

onUnmounted(() => {
	if (pollTimer) clearInterval(pollTimer);
});
</script>

<template>
	<section :class="$style.strip" data-test-id="aon-home-parts">
		<button
			type="button"
			:class="$style.card"
			data-test-id="aon-home-part-assistant"
			@click="assistant.open()"
		>
			<span :class="$style.name">{{ parts[0].name }}</span>
			<span :class="$style.figure">{{ parts[0].figure }}</span>
			<span :class="$style.status">{{ parts[0].status }}</span>
		</button>
		<RouterLink :to="{ name: AON_RUNS_VIEW }" :class="$style.card" data-test-id="aon-home-part-executor">
			<span :class="$style.name">{{ parts[1].name }}</span>
			<span :class="$style.figure">{{ parts[1].figure }}</span>
			<span :class="$style.status">{{ parts[1].status }}</span>
		</RouterLink>
		<RouterLink :to="{ name: AON_GUARD_VIEW }" :class="$style.card" data-test-id="aon-home-part-guard">
			<span :class="$style.name">{{ parts[2].name }}</span>
			<span :class="$style.figure">{{ parts[2].figure }}</span>
			<span :class="$style.status">{{ parts[2].status }}</span>
		</RouterLink>
		<RouterLink :to="{ name: AON_MEMORY_VIEW }" :class="$style.card" data-test-id="aon-home-part-memory">
			<span :class="$style.name">{{ parts[3].name }}</span>
			<span :class="$style.figure">{{ parts[3].figure }}</span>
			<span :class="$style.status">{{ parts[3].status }}</span>
		</RouterLink>
		<RouterLink :to="{ name: AON_HANDS_VIEW }" :class="$style.card" data-test-id="aon-home-part-hands">
			<span :class="$style.name">{{ parts[4].name }}</span>
			<span :class="$style.figure">{{ parts[4].figure }}</span>
			<span :class="$style.status">{{ parts[4].status }}</span>
		</RouterLink>
	</section>
</template>

<style lang="scss" module>
.strip {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
	gap: var(--spacing--xs);
}

.card {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--5xs);
	padding: var(--spacing--sm) var(--spacing--md);
	border: var(--border);
	border-radius: var(--radius--lg);
	background: var(--color--background--light-3);
	color: inherit;
	text-align: left;
	font: inherit;
	cursor: pointer;

	&:hover {
		border-color: var(--color--primary);
		text-decoration: none;
	}
}

.name {
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
}

.figure {
	font-size: var(--font-size--xl);
	font-weight: var(--font-weight--bold);
	color: var(--color--primary);
	font-variant-numeric: tabular-nums;
	line-height: 1.1;
}

.status {
	font-size: var(--font-size--2xs);
	color: var(--color--text);
}
</style>
