<script setup lang="ts">
import type {
	AonAgentsOverview,
	AonMemoryOverview,
	AonMemorySearchMode,
	AonMemorySearchResult,
} from '@n8n/api-types';
import { N8nBadge, N8nButton, N8nInput } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';

import { getAgentsOverview, getMemoryOverview, searchMemory } from '../aon.api';
import { useAonAssistantStore } from '../assistant/aonAssistant.store';
import { AON_AGENTS_VIEW } from '../constants';
import { useAonTime } from '../useAonTime';

const i18n = useI18n();
const rootStore = useRootStore();
const assistant = useAonAssistantStore();
const { ago } = useAonTime();

const agents = ref<AonAgentsOverview | null>(null);
const memory = ref<AonMemoryOverview | null>(null);
const error = ref<string | null>(null);

const query = ref('');
const mode = ref<AonMemorySearchMode>('hybrid');
const modes: AonMemorySearchMode[] = ['hybrid', 'text', 'vector'];
const searching = ref(false);
const result = ref<AonMemorySearchResult | null>(null);

const runsByStatus = computed(() =>
	Object.entries(agents.value?.runsByStatus ?? {})
		.sort((a, b) => b[1] - a[1])
		.map(([status, count]) => `${count} ${status}`)
		.join(' · '),
);

const origins = computed(() =>
	(memory.value?.byOrigin ?? [])
		.slice(0, 4)
		.map((o) => `${o.count} ${o.origin}`)
		.join(' · '),
);

const count = (n: number | undefined) => (n === undefined ? '·' : n.toLocaleString());

onMounted(async () => {
	try {
		[agents.value, memory.value] = await Promise.all([
			getAgentsOverview(rootStore.restApiContext),
			getMemoryOverview(rootStore.restApiContext),
		]);
	} catch (e) {
		error.value = (e as Error).message;
	}
});

async function search() {
	const q = query.value.trim();
	if (!q || searching.value) return;
	searching.value = true;
	try {
		result.value = await searchMemory(rootStore.restApiContext, { q, mode: mode.value, limit: 10 });
	} catch (e) {
		error.value = (e as Error).message;
	} finally {
		searching.value = false;
	}
}
</script>

<template>
	<div :class="$style.page">
		<header :class="$style.head">
			<div>
				<h1 :class="$style.title">{{ i18n.baseText('aon.title') }}</h1>
				<p :class="$style.lede">{{ i18n.baseText('aon.home.lede') }}</p>
			</div>
			<N8nButton
				:label="i18n.baseText('aon.home.openAssistant')"
				size="large"
				data-test-id="aon-home-open-assistant"
				@click="assistant.open()"
			/>
		</header>

		<p v-if="error" :class="$style.error">
			{{ i18n.baseText('aon.home.failed', { interpolate: { message: error } }) }}
		</p>

		<section :class="$style.tiles" data-test-id="aon-home-tiles">
			<RouterLink :to="{ name: AON_AGENTS_VIEW }" :class="[$style.tile, $style.tileLink]">
				<span :class="$style.n">{{ count(agents?.agents) }}</span>
				<span :class="$style.label">{{ i18n.baseText('aon.home.agents') }}</span>
				<span :class="$style.sub">
					{{
						agents
							? i18n.baseText('aon.home.active', {
									interpolate: { count: String(agents.activeAgents) },
								})
							: ''
					}}
				</span>
			</RouterLink>
			<div :class="$style.tile">
				<span :class="$style.n">{{ count(agents?.deliverables) }}</span>
				<span :class="$style.label">{{ i18n.baseText('aon.home.deliverables') }}</span>
			</div>
			<div :class="$style.tile">
				<span :class="$style.n">{{ count(agents?.runs) }}</span>
				<span :class="$style.label">{{ i18n.baseText('aon.home.runs') }}</span>
				<span :class="$style.sub">{{ runsByStatus }}</span>
				<span v-if="agents?.lastRunAt" :class="$style.sub">
					{{ i18n.baseText('aon.home.lastRun', { interpolate: { when: ago(agents.lastRunAt) } }) }}
				</span>
			</div>
			<div :class="$style.tile">
				<span :class="$style.n">{{ count(agents?.rules) }}</span>
				<span :class="$style.label">{{ i18n.baseText('aon.home.rules') }}</span>
			</div>
			<div :class="$style.tile">
				<span :class="$style.n">{{ count(memory?.sources) }}</span>
				<span :class="$style.label">{{ i18n.baseText('aon.home.sources') }}</span>
				<span :class="$style.sub">{{ origins }}</span>
			</div>
			<div :class="$style.tile">
				<span :class="$style.n">{{ count(memory?.chunks) }}</span>
				<span :class="$style.label">{{ i18n.baseText('aon.home.chunks') }}</span>
				<span :class="$style.sub">
					{{
						memory
							? i18n.baseText('aon.home.embedded', {
									interpolate: { count: memory.embedded.toLocaleString() },
								})
							: ''
					}}
				</span>
			</div>
		</section>

		<section :class="$style.memory" data-test-id="aon-home-memory">
			<h2 :class="$style.h2">{{ i18n.baseText('aon.memory.title') }}</h2>
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
					type="secondary"
				/>
			</form>
			<p :class="$style.hint">{{ i18n.baseText('aon.memory.searchHint') }}</p>

			<div v-if="result" data-test-id="aon-memory-results">
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
							<span :class="$style.hitTitle">{{ hit.title }}</span>
							<span :class="$style.hitMeta">{{ ago(hit.docTime) }}</span>
							<span :class="$style.hitMeta">{{ hit.score.toFixed(3) }}</span>
						</div>
						<p :class="$style.hitText">{{ hit.text }}</p>
					</li>
				</ol>
			</div>
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
	align-items: flex-start;
	justify-content: space-between;
	gap: var(--spacing--lg);
	flex-wrap: wrap;
}

.title {
	font-size: var(--font-size--2xl);
	margin: 0 0 var(--spacing--2xs);
	color: var(--color--text--shade-1);
}

.h2 {
	font-size: var(--font-size--lg);
	margin: 0;
	color: var(--color--text--shade-1);
}

.lede {
	color: var(--color--text--tint-1);
	margin: 0;
	max-width: 60ch;
}

.error {
	margin: 0;
	color: var(--color--danger);
}

.tiles {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
	gap: var(--spacing--sm);
}

.tile {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--5xs);
	padding: var(--spacing--sm) var(--spacing--md);
	border: var(--border);
	border-radius: var(--radius--lg);
	background: var(--color--background--light-3);
	color: inherit;
	min-height: 96px;
}

.tileLink:hover {
	border-color: var(--color--primary);
	text-decoration: none;
}

.n {
	font-size: var(--font-size--2xl);
	font-weight: var(--font-weight--bold);
	color: var(--color--text--shade-1);
	font-variant-numeric: tabular-nums;
	line-height: 1.1;
}

.label {
	color: var(--color--text);
}

.sub {
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
}

.memory {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xs);
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
	color: var(--color--text--tint-3);
}

.hint {
	margin: 0;
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
}

.empty {
	margin: var(--spacing--xs) 0 0;
	color: var(--color--text--tint-1);
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
</style>
