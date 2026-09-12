<script setup lang="ts">
import type { AonMemorySearchMode, AonMemorySearchResult, AonSourceSummary } from '@n8n/api-types';
import { N8nBadge, N8nButton, N8nInput, N8nInputLabel } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { useDebounceFn } from '@vueuse/core';
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';

import { getDebounceTime } from '@n8n/composables/useDebounce';
import { DEBOUNCE_TIME } from '@/app/constants';

import { searchMemory } from '../aon.api';
import AonNav from '../components/AonNav.vue';
import AonOwnerModel from '../components/memory/AonOwnerModel.vue';
import { AON_SOURCE_VIEW } from '../constants';
import AonEntitiesList from '../graph/AonEntitiesList.vue';
import AonFactsTriage from '../graph/AonFactsTriage.vue';
import AonMemoryGraphs from '../graph/AonMemoryGraphs.vue';
import AonObservations from '../graph/AonObservations.vue';
import { captureMemory, listSources } from '../memory.api';
import { statusTheme } from '../status';
import { useAonTime } from '../useAonTime';

const memoryGraphs = ref<InstanceType<typeof AonMemoryGraphs> | null>(null);

const i18n = useI18n();
const rootStore = useRootStore();
const route = useRoute();
const { ago } = useAonTime();

const PAGE_SIZE = 50;

// --- capture ---------------------------------------------------------------

const captureTextValue = ref('');
const captureUrlValue = ref('');
const captureTitleValue = ref('');
const capturing = ref(false);
const captureMessage = ref<string | null>(null);
const captureFailedMessage = ref<string | null>(null);

const canCapture = computed(() => {
	if (capturing.value) return false;
	return captureTextValue.value.trim() !== '' || captureUrlValue.value.trim() !== '';
});

async function submitCapture() {
	if (!canCapture.value) return;
	capturing.value = true;
	captureMessage.value = null;
	captureFailedMessage.value = null;
	try {
		const result = await captureMemory(rootStore.restApiContext, {
			text: captureTextValue.value.trim() || undefined,
			url: captureUrlValue.value.trim() || undefined,
			title: captureTitleValue.value.trim() || undefined,
		});
		let message = i18n.baseText('aon.memory.captureDone', {
			interpolate: {
				title: result.source.title,
				chunks: String(result.chunks),
				embedded: String(result.embedded),
			},
		});
		if (result.pending > 0) {
			const pendingNote = i18n.baseText('aon.memory.capturePending', {
				interpolate: { pending: String(result.pending) },
			});
			message += ` ${pendingNote}`;
		}
		captureMessage.value = message;
		captureTextValue.value = '';
		captureUrlValue.value = '';
		captureTitleValue.value = '';
		await loadSources({ append: false });
	} catch (e) {
		captureFailedMessage.value = i18n.baseText('aon.memory.captureFailed', {
			interpolate: { message: (e as Error).message },
		});
	} finally {
		capturing.value = false;
	}
}

// --- search ------------------------------------------------------------------

const query = ref('');
const mode = ref<AonMemorySearchMode>('hybrid');
const modes: AonMemorySearchMode[] = ['hybrid', 'text', 'vector'];
const searching = ref(false);
const result = ref<AonMemorySearchResult | null>(null);
const searchError = ref<string | null>(null);

async function search() {
	const q = query.value.trim();
	if (!q || searching.value) return;
	searching.value = true;
	searchError.value = null;
	try {
		result.value = await searchMemory(rootStore.restApiContext, { q, mode: mode.value, limit: 10 });
	} catch (e) {
		searchError.value = (e as Error).message;
	} finally {
		searching.value = false;
	}
}

// --- sources -------------------------------------------------------------

const sources = ref<AonSourceSummary[]>([]);
const total = ref(0);
const origins = ref<Array<{ origin: string; count: number }>>([]);
const selectedOrigin = ref<string | null>(null);
const titleFilter = ref('');
const debouncedTitleFilter = ref('');
const loadingSources = ref(false);
const sourcesError = ref<string | null>(null);

const canLoadMore = computed(() => sources.value.length < total.value);

const setDebouncedTitleFilter = useDebounceFn((value: string) => {
	debouncedTitleFilter.value = value;
}, getDebounceTime(DEBOUNCE_TIME.INPUT.SEARCH));

watch(titleFilter, (value) => {
	void setDebouncedTitleFilter(value);
});

watch(debouncedTitleFilter, () => {
	void loadSources({ append: false });
});

function selectOrigin(origin: string | null) {
	if (selectedOrigin.value === origin) return;
	selectedOrigin.value = origin;
	void loadSources({ append: false });
}

async function loadSources({ append }: { append: boolean }) {
	loadingSources.value = true;
	sourcesError.value = null;
	try {
		const page = await listSources(rootStore.restApiContext, {
			q: debouncedTitleFilter.value.trim() || undefined,
			origin: selectedOrigin.value ?? undefined,
			limit: PAGE_SIZE,
			offset: append ? sources.value.length : 0,
		});
		sources.value = append ? [...sources.value, ...page.items] : page.items;
		total.value = page.total;
		origins.value = page.origins;
	} catch (e) {
		sourcesError.value = (e as Error).message;
	} finally {
		loadingSources.value = false;
	}
}

onMounted(() => {
	void loadSources({ append: false });
	// The Home cockpit's search box lands here with `?q=`; run it once, up front.
	const q = route.query.q;
	if (typeof q === 'string' && q.trim()) {
		query.value = q;
		void search();
	}
});
</script>

<template>
	<div :class="$style.page">
		<AonNav />
		<header :class="$style.head">
			<h1 :class="$style.title">{{ i18n.baseText('aon.memory.title') }}</h1>
			<p :class="$style.lede">{{ i18n.baseText('aon.memory.lede') }}</p>
		</header>

		<section :class="$style.section" data-test-id="aon-memory-capture">
			<h2 :class="$style.h2">{{ i18n.baseText('aon.memory.captureTitle') }}</h2>
			<form :class="$style.captureForm" @submit.prevent="submitCapture">
				<N8nInputLabel :label="i18n.baseText('aon.memory.captureText')" :bold="false" size="small">
					<N8nInput
						v-model="captureTextValue"
						type="textarea"
						:autosize="{ minRows: 3, maxRows: 10 }"
						:disabled="capturing"
						:placeholder="i18n.baseText('aon.memory.captureTextPlaceholder')"
						data-test-id="aon-memory-capture-text"
					/>
				</N8nInputLabel>
				<N8nInputLabel :label="i18n.baseText('aon.memory.captureUrl')" :bold="false" size="small">
					<N8nInput
						v-model="captureUrlValue"
						:disabled="capturing"
						:placeholder="i18n.baseText('aon.memory.captureUrlPlaceholder')"
						data-test-id="aon-memory-capture-url"
					/>
				</N8nInputLabel>
				<N8nInputLabel
					:label="i18n.baseText('aon.memory.captureTitleField')"
					:bold="false"
					size="small"
				>
					<N8nInput
						v-model="captureTitleValue"
						:disabled="capturing"
						:placeholder="i18n.baseText('aon.memory.captureTitlePlaceholder')"
						data-test-id="aon-memory-capture-title"
					/>
				</N8nInputLabel>
				<div :class="$style.submitRow">
					<N8nButton
						:label="i18n.baseText('aon.memory.captureSubmit')"
						:loading="capturing"
						:disabled="!canCapture"
						native-type="submit"
						size="large"
					/>
				</div>
			</form>
			<p v-if="captureMessage" :class="$style.hint">{{ captureMessage }}</p>
			<p v-if="captureFailedMessage" :class="$style.error">{{ captureFailedMessage }}</p>
		</section>

		<section :class="$style.section">
			<h2 :class="$style.h2">{{ i18n.baseText('aon.memory.search') }}</h2>
			<form :class="$style.searchRow" @submit.prevent="search">
				<N8nInput
					v-model="query"
					:placeholder="i18n.baseText('aon.memory.searchPlaceholder')"
					size="large"
					data-test-id="aon-memory-query"
				/>
				<div :class="$style.modes" role="radiogroup">
					<button
						v-for="m in modes"
						:key="m"
						type="button"
						role="radio"
						:aria-checked="mode === m"
						:class="[$style.mode, mode === m && $style.modeOn]"
						@click="mode = m"
					>
						{{ i18n.baseText(`aon.memory.mode.${m}`) }}
					</button>
				</div>
				<N8nButton
					:label="i18n.baseText('aon.memory.search')"
					:loading="searching"
					native-type="submit"
					size="large"
					variant="outline"
				/>
			</form>
			<p :class="$style.hint">{{ i18n.baseText('aon.memory.searchHint') }}</p>
			<p v-if="searchError" :class="$style.error">
				{{ i18n.baseText('aon.home.failed', { interpolate: { message: searchError } }) }}
			</p>

			<div v-if="result">
				<p :class="$style.hint">
					{{
						i18n.baseText('aon.memory.hits', {
							interpolate: { count: String(result.hits.length), ms: String(result.tookMs) },
						})
					}}
					<span v-if="!result.embedded && mode !== 'text'">
						· {{ i18n.baseText('aon.memory.textOnly') }}</span
					>
				</p>
				<p v-if="result.hits.length === 0" :class="$style.empty">
					{{ i18n.baseText('aon.memory.noHits') }}
				</p>
				<ol v-else :class="$style.hits">
					<li v-for="hit in result.hits" :key="hit.chunkId" :class="$style.hit">
						<div :class="$style.hitHead">
							<N8nBadge theme="tertiary" size="small">{{ hit.origin }}</N8nBadge>
							<RouterLink
								:to="{ name: AON_SOURCE_VIEW, params: { id: hit.sourceId } }"
								:class="$style.hitTitle"
								:title="i18n.baseText('aon.memory.openSource')"
							>
								{{ hit.title }}
							</RouterLink>
							<span :class="$style.hitMeta">{{ ago(hit.docTime) }}</span>
							<span :class="$style.hitMeta">{{ hit.score.toFixed(3) }}</span>
						</div>
						<p :class="$style.hitText">{{ hit.text }}</p>
					</li>
				</ol>
			</div>
		</section>

		<section :class="$style.section">
			<AonOwnerModel />
		</section>

		<section :class="$style.section" data-test-id="aon-memory-graph">
			<h2 :class="$style.h2">{{ i18n.baseText('aon.graph.title') }}</h2>
			<p :class="$style.lede">{{ i18n.baseText('aon.graph.lede') }}</p>
			<AonMemoryGraphs ref="memoryGraphs" />
		</section>

		<section :class="$style.section">
			<h2 :class="$style.h2">{{ i18n.baseText('aon.entities.title') }}</h2>
			<AonEntitiesList @select="memoryGraphs?.focusEntity($event)" />
		</section>

		<section :class="$style.section">
			<h2 :class="$style.h2">{{ i18n.baseText('aon.facts.title') }}</h2>
			<AonFactsTriage />
		</section>

		<section :class="$style.section">
			<h2 :class="$style.h2">{{ i18n.baseText('aon.observations.title') }}</h2>
			<AonObservations />
		</section>

		<section :class="$style.section" data-test-id="aon-memory-sources">
			<h2 :class="$style.h2">{{ i18n.baseText('aon.memory.sources') }}</h2>

			<div
				:class="$style.chipsRow"
				role="group"
				:aria-label="i18n.baseText('aon.memory.filterOrigin')"
			>
				<button
					type="button"
					:class="[$style.chip, selectedOrigin === null && $style.chipOn]"
					@click="selectOrigin(null)"
				>
					{{ i18n.baseText('aon.memory.filterAll') }}
				</button>
				<button
					v-for="o in origins"
					:key="o.origin"
					type="button"
					:class="[$style.chip, selectedOrigin === o.origin && $style.chipOn]"
					@click="selectOrigin(o.origin)"
				>
					{{ o.origin }} ({{ o.count }})
				</button>
			</div>

			<N8nInput
				v-model="titleFilter"
				:placeholder="i18n.baseText('aon.memory.filterQuery')"
				data-test-id="aon-memory-filter-query"
			/>

			<p v-if="sourcesError" :class="$style.error">
				{{ i18n.baseText('aon.home.failed', { interpolate: { message: sourcesError } }) }}
			</p>
			<p v-else-if="!loadingSources && sources.length === 0" :class="$style.empty">
				{{ i18n.baseText('aon.memory.empty') }}
			</p>
			<div v-else :class="$style.tableWrap">
				<table :class="$style.table">
					<thead>
						<tr>
							<th>{{ i18n.baseText('aon.memory.column.title') }}</th>
							<th>{{ i18n.baseText('aon.memory.column.origin') }}</th>
							<th>{{ i18n.baseText('aon.memory.column.when') }}</th>
							<th :class="$style.num">{{ i18n.baseText('aon.memory.column.chunks') }}</th>
							<th>{{ i18n.baseText('aon.memory.column.status') }}</th>
						</tr>
					</thead>
					<tbody>
						<tr v-for="source in sources" :key="source.id">
							<td>
								<RouterLink
									:to="{ name: AON_SOURCE_VIEW, params: { id: source.id } }"
									:class="$style.name"
								>
									{{ source.title }}
								</RouterLink>
							</td>
							<td><N8nBadge theme="tertiary" size="small">{{ source.origin }}</N8nBadge></td>
							<td :class="$style.when">{{ ago(source.docTime ?? source.createdAt) }}</td>
							<td :class="$style.num">{{ source.embeddedCount }}/{{ source.chunkCount }}</td>
							<td>
								<N8nBadge :theme="statusTheme(source.status)" size="small">
									{{ source.status }}
								</N8nBadge>
							</td>
						</tr>
					</tbody>
				</table>
			</div>

			<p :class="$style.hint">
				{{ i18n.baseText('aon.memory.sourcesCount', { interpolate: { count: String(total) } }) }}
			</p>
			<N8nButton
				v-if="canLoadMore"
				:label="i18n.baseText('aon.memory.loadMore')"
				:loading="loadingSources"
				variant="outline"
				@click="loadSources({ append: true })"
			/>
		</section>
	</div>
</template>

<style lang="scss" module>
.page {
	max-width: 960px;
	margin: 0 auto;
	padding: var(--spacing--2xl) var(--spacing--lg) var(--spacing--3xl);
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xl);
}

.head {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
}

.title {
	font-size: var(--font-size--2xl);
	margin: 0;
	color: var(--color--text--shade-1);
}

.lede {
	color: var(--color--text--tint-1);
	margin: 0;
	max-width: 60ch;
}

.section {
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

.hint {
	margin: 0;
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
}

.empty {
	margin: 0;
	color: var(--color--text--tint-1);
}

.captureForm {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xs);
}

.submitRow {
	align-self: flex-start;
}

.searchRow {
	display: flex;
	gap: var(--spacing--2xs);
	align-items: center;
	flex-wrap: wrap;

	> :first-child {
		flex: 1 1 320px;
	}
}

.modes {
	display: inline-flex;
	border: var(--border);
	border-radius: var(--radius);
	overflow: hidden;
}

.mode {
	font: inherit;
	font-size: var(--font-size--2xs);
	padding: var(--spacing--3xs) var(--spacing--xs);
	border: none;
	background: transparent;
	color: var(--color--text);
	cursor: pointer;

	& + & {
		border-left: var(--border);
	}
}

.modeOn {
	background: var(--color--primary);
	color: var(--color--neutral-white);
}

.hits {
	list-style: none;
	margin: var(--spacing--xs) 0 0;
	padding: 0;
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
}

.hit {
	padding: var(--spacing--xs) var(--spacing--sm);
	border: var(--border);
	border-radius: var(--radius--lg);
	background: var(--color--background--light-3);
}

.hitHead {
	display: flex;
	align-items: baseline;
	gap: var(--spacing--2xs);
	flex-wrap: wrap;
}

.hitTitle {
	font-weight: var(--font-weight--bold);
	color: var(--color--text--shade-1);
	flex: 1 1 auto;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	text-decoration: none;

	&:hover {
		text-decoration: underline;
	}
}

.hitMeta {
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
	font-variant-numeric: tabular-nums;
}

.hitText {
	margin: var(--spacing--4xs) 0 0;
	color: var(--color--text);
	white-space: pre-wrap;
	display: -webkit-box;
	-webkit-line-clamp: 4;
	-webkit-box-orient: vertical;
	overflow: hidden;
}

.chipsRow {
	display: flex;
	flex-wrap: wrap;
	gap: var(--spacing--3xs);
}

.chip {
	font: inherit;
	font-size: var(--font-size--2xs);
	padding: var(--spacing--4xs) var(--spacing--sm);
	border: var(--border);
	border-radius: var(--radius--full);
	background: var(--color--background--light-3);
	color: var(--color--text);
	cursor: pointer;
}

.chipOn {
	background: var(--color--primary);
	border-color: var(--color--primary);
	color: var(--color--neutral-white);
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

.when {
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
	white-space: nowrap;
}

.name {
	font-weight: var(--font-weight--bold);
	color: var(--color--text--shade-1);
}
</style>
