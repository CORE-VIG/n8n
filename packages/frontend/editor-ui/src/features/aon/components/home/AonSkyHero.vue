<script setup lang="ts">
import type { AonMemorySky } from '@n8n/api-types';
import { N8nInput } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { defineAsyncComponent, onMounted, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';

import { getMemorySky } from '../../home.api';
import { AON_MEMORY_VIEW } from '../../constants';

// A missing AonSkyGraph.vue (another agent's file) surfaces as one clear
// load error here instead of failing the whole page.
const AonSkyGraph = defineAsyncComponent(async () => await import('../../graph/AonSkyGraph.vue'));

const i18n = useI18n();
const rootStore = useRootStore();
const router = useRouter();

const sky = ref<AonMemorySky | null>(null);
const selected = ref<string | null>(null);
const query = ref('');

const isEmpty = (s: AonMemorySky | null) =>
	!s || (s.sources === 0 && s.entities === 0 && s.facts === 0 && s.observations === 0);

const fmt = (n: number | undefined) => (n === undefined ? '—' : n.toLocaleString());

onMounted(async () => {
	try {
		sky.value = await getMemorySky(rootStore.restApiContext);
	} catch {
		// The hero degrades to its empty state; the rest of the cockpit stands.
		sky.value = null;
	}
});

function onSelect(name: string | null) {
	selected.value = name;
}

function search() {
	const q = query.value.trim();
	if (!q) return;
	void router.push({ name: AON_MEMORY_VIEW, query: { q } });
}
</script>

<template>
	<section :class="$style.hero" data-test-id="aon-home-sky">
		<div :class="$style.graphWrap">
			<AonSkyGraph :sky="sky" :selected="selected" :compact="false" @select="onSelect" />
		</div>

		<div :class="$style.caption">
			<template v-if="isEmpty(sky)">
				<p :class="$style.emptyLine">{{ i18n.baseText('aon.home.skyEmpty') }}</p>
			</template>
			<template v-else>
				<div :class="$style.figures">
					<div :class="$style.figure">
						<span :class="$style.n">{{ fmt(sky?.sources) }}</span>
						<span :class="$style.label">{{ i18n.baseText('aon.home.sources') }}</span>
					</div>
					<div :class="$style.figure">
						<span :class="$style.n">{{ fmt(sky?.entities) }}</span>
						<span :class="$style.label">{{ i18n.baseText('aon.home.sky.entities') }}</span>
					</div>
					<div :class="$style.figure">
						<span :class="$style.n">{{ fmt(sky?.facts) }}</span>
						<span :class="$style.label">{{ i18n.baseText('aon.home.sky.facts') }}</span>
					</div>
					<div :class="$style.figure">
						<span :class="$style.n">{{ fmt(sky?.observations) }}</span>
						<span :class="$style.label">{{ i18n.baseText('aon.home.sky.observations') }}</span>
					</div>
				</div>
			</template>
			<RouterLink :to="{ name: AON_MEMORY_VIEW }" :class="$style.openMemory">
				{{ i18n.baseText('aon.home.openMemory') }}
			</RouterLink>
		</div>

		<form :class="$style.searchRow" @submit.prevent="search">
			<N8nInput
				v-model="query"
				:placeholder="i18n.baseText('aon.memory.searchPlaceholder')"
				size="large"
				data-test-id="aon-home-search"
			/>
		</form>
	</section>
</template>

<style lang="scss" module>
.hero {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}

.graphWrap {
	width: 100%;
	height: 360px;
	border: var(--border);
	border-radius: var(--radius--lg);
	overflow: hidden;
	background: var(--color--background--light-3);

	@media (max-width: 900px) {
		height: 260px;
	}
}

.caption {
	display: flex;
	align-items: center;
	justify-content: space-between;
	flex-wrap: wrap;
	gap: var(--spacing--sm);
}

.emptyLine {
	margin: 0;
	color: var(--color--text--tint-1);
}

.figures {
	display: flex;
	gap: var(--spacing--lg);
	flex-wrap: wrap;
}

.figure {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--5xs);
}

.n {
	font-size: var(--font-size--lg);
	font-weight: var(--font-weight--bold);
	color: var(--color--text--shade-1);
	font-variant-numeric: tabular-nums;
	line-height: 1.1;
}

.label {
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
}

.openMemory {
	font-size: var(--font-size--2xs);
	color: var(--color--primary);
	text-decoration: none;
	white-space: nowrap;

	&:hover {
		text-decoration: underline;
	}
}

.searchRow {
	display: flex;
}
</style>
