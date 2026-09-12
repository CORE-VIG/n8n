<script setup lang="ts">
/**
 * The container for the three memory graph views: tabs (Sky / Brain /
 * Radial), a search box that focuses the graph on an entity, a depth
 * control, and the shared entity panel that any of the three opens.
 *
 * Sky paints from `/sky` (fetched once, on mount). Brain and Radial paint
 * from `/graph` (limit 200; depth applies once a focus is set). Selecting a
 * node in Brain or Radial — or a search result, or an entity from the
 * sibling Entities list via `focusEntity` — opens the panel and refocuses
 * the graph; "Whole graph" clears the focus.
 */
import type { AonEntityDetail, AonEntitySummary, AonMemoryGraph, AonMemorySky } from '@n8n/api-types';
import { N8nButton, N8nInput, N8nTabs } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { useDebounceFn } from '@vueuse/core';
import { computed, onMounted, ref, watch } from 'vue';

import { getDebounceTime } from '@n8n/composables/useDebounce';
import { DEBOUNCE_TIME } from '@/app/constants';

import AonBrainGraph from './AonBrainGraph.vue';
import AonEntityPanel from './AonEntityPanel.vue';
import AonRadialGraph from './AonRadialGraph.vue';
import AonSkyGraph from './AonSkyGraph.vue';
import { getEntity, getGraph, getSky, listEntities } from '../memory-graph.api';

const i18n = useI18n();
const rootStore = useRootStore();

type Tab = 'sky' | 'brain' | 'radial';
const tab = ref<Tab>('sky');
const tabOptions = computed(() => [
	{ value: 'sky' as Tab, label: i18n.baseText('aon.graph.sky') },
	{ value: 'brain' as Tab, label: i18n.baseText('aon.graph.brain') },
	{ value: 'radial' as Tab, label: i18n.baseText('aon.graph.radial') },
]);

// -- sky ------------------------------------------------------------------

const sky = ref<AonMemorySky | null>(null);
const skyLoading = ref(false);
const skyCategory = ref<string | null>(null);

async function loadSky() {
	skyLoading.value = true;
	try {
		sky.value = await getSky(rootStore.restApiContext);
	} finally {
		skyLoading.value = false;
	}
}

// -- graph (brain + radial) ------------------------------------------------

const GRAPH_LIMIT = 200;
const graph = ref<AonMemoryGraph | null>(null);
const graphLoading = ref(false);
const focusId = ref<string | null>(null);
const depth = ref(2);

async function loadGraph() {
	graphLoading.value = true;
	try {
		graph.value = await getGraph(rootStore.restApiContext, {
			focus: focusId.value ?? undefined,
			depth: depth.value,
			limit: GRAPH_LIMIT,
		});
	} finally {
		graphLoading.value = false;
	}
}

let graphLoaded = false;
watch(tab, (value) => {
	if ((value === 'brain' || value === 'radial') && !graphLoaded) {
		graphLoaded = true;
		void loadGraph();
	}
});

function setDepth(next: number) {
	if (depth.value === next) return;
	depth.value = next;
	if (graphLoaded) void loadGraph();
}

function clearFocus() {
	focusId.value = null;
	if (graphLoaded) void loadGraph();
}

// -- search: focus the graph on an entity ----------------------------------

const query = ref('');
const debouncedQuery = ref('');
const results = ref<AonEntitySummary[]>([]);
const searching = ref(false);

const setDebouncedQuery = useDebounceFn((value: string) => {
	debouncedQuery.value = value;
}, getDebounceTime(DEBOUNCE_TIME.INPUT.SEARCH));

watch(query, (value) => void setDebouncedQuery(value));

watch(debouncedQuery, async (value) => {
	const q = value.trim();
	if (!q) {
		results.value = [];
		return;
	}
	searching.value = true;
	try {
		const page = await listEntities(rootStore.restApiContext, { q, limit: 8 });
		results.value = page.items;
	} finally {
		searching.value = false;
	}
});

function pickResult(entity: AonEntitySummary) {
	results.value = [];
	query.value = '';
	focusEntity(entity.id);
}

// -- entity panel -----------------------------------------------------------

const panelEntity = ref<AonEntityDetail | null>(null);
const panelLoading = ref(false);
const panelOpen = ref(false);

async function openEntity(id: string) {
	panelLoading.value = true;
	panelOpen.value = true;
	try {
		panelEntity.value = await getEntity(rootStore.restApiContext, id);
	} finally {
		panelLoading.value = false;
	}
}

function closePanel() {
	panelOpen.value = false;
	panelEntity.value = null;
}

function onDecided() {
	if (panelEntity.value) void openEntity(panelEntity.value.id);
}

function onGraphSelect(id: string) {
	void openEntity(id);
}

/**
 * Focuses the graph on an entity and opens its panel — called for a search
 * pick, a node click in Brain/Radial, and (via `defineExpose`) from
 * AonEntitiesList in the sibling section.
 */
function focusEntity(id: string) {
	focusId.value = id;
	graphLoaded = true;
	void loadGraph();
	void openEntity(id);
	if (tab.value === 'sky') tab.value = 'brain';
}

defineExpose({ focusEntity });

onMounted(() => {
	void loadSky();
});
</script>

<template>
	<div :class="$style.wrap">
		<div :class="$style.toolbar">
			<div data-test-id="aon-graph-tabs">
				<N8nTabs v-model="tab" :options="tabOptions" />
			</div>

			<div :class="$style.search">
				<N8nInput
					v-model="query"
					size="small"
					:placeholder="i18n.baseText('aon.graph.searchPlaceholder')"
					data-test-id="aon-graph-search"
				/>
				<ul v-if="results.length > 0" :class="$style.results">
					<li v-for="entity in results" :key="entity.id">
						<button type="button" :class="$style.resultRow" @click="pickResult(entity)">
							<span>{{ entity.name }}</span>
							<span :class="$style.resultKind">{{ entity.kind }}</span>
						</button>
					</li>
				</ul>
			</div>

			<div v-if="tab !== 'sky'" :class="$style.depth" role="radiogroup" :aria-label="i18n.baseText('aon.graph.depth')">
				<span :class="$style.depthLabel">{{ i18n.baseText('aon.graph.depth') }}</span>
				<button
					v-for="d in [1, 2, 3]"
					:key="d"
					type="button"
					role="radio"
					:aria-checked="depth === d"
					:class="[$style.depthBtn, depth === d && $style.depthOn]"
					@click="setDepth(d)"
				>
					{{ d }}
				</button>
			</div>

			<N8nButton
				v-if="focusId"
				:label="i18n.baseText('aon.graph.wholeGraph')"
				size="small"
				variant="outline"
				@click="clearFocus"
			/>
		</div>

		<div :class="[$style.body, panelOpen && $style.bodyWithPanel]">
			<div :class="$style.canvasArea">
				<AonSkyGraph
					v-if="tab === 'sky'"
					:sky="sky"
					:loading="skyLoading"
					:selected="skyCategory"
					@select="skyCategory = $event"
				/>
				<AonBrainGraph v-else-if="tab === 'brain'" :graph="graph" :loading="graphLoading" @select="onGraphSelect" />
				<AonRadialGraph v-else :graph="graph" :loading="graphLoading" @select="onGraphSelect" />
			</div>

			<AonEntityPanel
				v-if="panelOpen"
				:class="$style.panel"
				:entity="panelEntity"
				:loading="panelLoading"
				@close="closePanel"
				@decided="onDecided"
			/>
		</div>
	</div>
</template>

<style lang="scss" module>
.wrap {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xs);
}

.toolbar {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--spacing--xs);
}

.search {
	position: relative;
	flex: 1 1 220px;
	min-width: 160px;
}

.results {
	position: absolute;
	z-index: 5;
	top: 100%;
	left: 0;
	right: 0;
	margin: var(--spacing--4xs) 0 0;
	padding: 0;
	list-style: none;
	border: var(--border);
	border-radius: var(--radius--lg);
	background: var(--color--background--light-3);
	overflow: hidden;
}

.resultRow {
	width: 100%;
	display: flex;
	justify-content: space-between;
	gap: var(--spacing--2xs);
	padding: var(--spacing--3xs) var(--spacing--sm);
	border: none;
	background: transparent;
	color: var(--color--text--shade-1);
	cursor: pointer;
	font: inherit;
	text-align: left;
}

.resultKind {
	color: var(--color--text--tint-1);
	font-size: var(--font-size--2xs);
}

.depth {
	display: inline-flex;
	align-items: center;
	gap: var(--spacing--4xs);
}

.depthLabel {
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
}

.depthBtn {
	font: inherit;
	font-size: var(--font-size--2xs);
	width: 24px;
	height: 24px;
	border: var(--border);
	border-radius: var(--radius);
	background: var(--color--background--light-3);
	color: var(--color--text);
	cursor: pointer;
}

.depthOn {
	background: var(--color--primary);
	border-color: var(--color--primary);
	color: var(--color--neutral-white);
}

.body {
	display: grid;
	grid-template-columns: minmax(0, 1fr);
	gap: var(--spacing--sm);
}

.canvasArea {
	min-height: 420px;
}

.panel {
	max-height: 520px;
	overflow-y: auto;
}

@media (min-width: 900px) {
	.bodyWithPanel {
		grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr);
	}
}
</style>
