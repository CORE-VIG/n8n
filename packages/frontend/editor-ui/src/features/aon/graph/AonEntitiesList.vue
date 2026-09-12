<script setup lang="ts">
/**
 * Every entity Aon has met: kind chips, a search box, and rows. Selecting
 * one asks the container to focus the graph on it and open the entity
 * panel — this component only lists and searches.
 */
import type { AonEntitySummary } from '@n8n/api-types';
import { N8nBadge, N8nInput } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { useDebounceFn } from '@vueuse/core';
import { computed, onMounted, ref, watch } from 'vue';

import { getDebounceTime } from '@n8n/composables/useDebounce';
import { DEBOUNCE_TIME } from '@/app/constants';

import { listEntities } from '../memory-graph.api';

const PAGE_SIZE = 40;

const emit = defineEmits<{ select: [id: string] }>();

const i18n = useI18n();
const rootStore = useRootStore();

const query = ref('');
const debouncedQuery = ref('');
const selectedKind = ref<string | null>(null);
const items = ref<AonEntitySummary[]>([]);
const total = ref(0);
const kinds = ref<Array<{ kind: string; count: number }>>([]);
const loading = ref(false);
const error = ref<string | null>(null);

const canLoadMore = computed(() => items.value.length < total.value);

const setDebouncedQuery = useDebounceFn((value: string) => {
	debouncedQuery.value = value;
}, getDebounceTime(DEBOUNCE_TIME.INPUT.SEARCH));

watch(query, (value) => {
	void setDebouncedQuery(value);
});
watch(debouncedQuery, () => void load({ append: false }));

function selectKind(kind: string | null) {
	if (selectedKind.value === kind) return;
	selectedKind.value = kind;
	void load({ append: false });
}

async function load({ append }: { append: boolean }) {
	loading.value = true;
	error.value = null;
	try {
		const page = await listEntities(rootStore.restApiContext, {
			q: debouncedQuery.value.trim() || undefined,
			kind: selectedKind.value ?? undefined,
			limit: PAGE_SIZE,
			offset: append ? items.value.length : 0,
		});
		items.value = append ? [...items.value, ...page.items] : page.items;
		total.value = page.total;
		kinds.value = page.kinds;
	} catch (e) {
		error.value = (e as Error).message;
	} finally {
		loading.value = false;
	}
}

onMounted(() => {
	void load({ append: false });
});

defineExpose({ reload: () => load({ append: false }) });
</script>

<template>
	<div :class="$style.wrap" data-test-id="aon-entities-list">
		<div :class="$style.chipsRow" role="group" :aria-label="i18n.baseText('aon.entities.filterKind')">
			<button type="button" :class="[$style.chip, selectedKind === null && $style.chipOn]" @click="selectKind(null)">
				{{ i18n.baseText('aon.entities.kindAll') }}
			</button>
			<button
				v-for="k in kinds"
				:key="k.kind"
				type="button"
				:class="[$style.chip, selectedKind === k.kind && $style.chipOn]"
				@click="selectKind(k.kind)"
			>
				{{ k.kind }} ({{ k.count }})
			</button>
		</div>

		<N8nInput
			v-model="query"
			:placeholder="i18n.baseText('aon.entities.searchPlaceholder')"
			data-test-id="aon-entities-search"
		/>

		<p v-if="error" :class="$style.error">
			{{ i18n.baseText('aon.home.failed', { interpolate: { message: error } }) }}
		</p>
		<p v-else-if="!loading && items.length === 0" :class="$style.empty">
			{{ i18n.baseText('aon.entities.empty') }}
		</p>
		<ul v-else :class="$style.list">
			<li v-for="entity in items" :key="entity.id">
				<button type="button" :class="$style.row" @click="emit('select', entity.id)">
					<span :class="$style.name">{{ entity.name }}</span>
					<N8nBadge theme="tertiary" size="small">{{ entity.kind }}</N8nBadge>
					<span :class="$style.factCount">
						{{ i18n.baseText('aon.entities.panel.facts', { interpolate: { count: String(entity.factCount) } }) }}
					</span>
				</button>
			</li>
		</ul>

		<button v-if="canLoadMore" type="button" :class="$style.more" :disabled="loading" @click="load({ append: true })">
			{{ i18n.baseText('aon.memory.loadMore') }}
		</button>
	</div>
</template>

<style lang="scss" module>
.wrap {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xs);
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

.list {
	list-style: none;
	margin: 0;
	padding: 0;
	display: flex;
	flex-direction: column;
	gap: var(--spacing--3xs);
}

.row {
	width: 100%;
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
	padding: var(--spacing--xs) var(--spacing--sm);
	border: var(--border);
	border-radius: var(--radius--lg);
	background: var(--color--background--light-3);
	color: inherit;
	cursor: pointer;
	text-align: left;
	font: inherit;
}

.name {
	font-weight: var(--font-weight--bold);
	color: var(--color--text--shade-1);
	flex: 1 1 auto;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.factCount {
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
	white-space: nowrap;
}

.more {
	align-self: flex-start;
	font: inherit;
	font-size: var(--font-size--2xs);
	padding: var(--spacing--3xs) var(--spacing--sm);
	border: var(--border);
	border-radius: var(--radius);
	background: transparent;
	color: var(--color--text);
	cursor: pointer;
}

.empty {
	margin: 0;
	color: var(--color--text--tint-1);
}

.error {
	margin: 0;
	color: var(--color--danger);
}
</style>
