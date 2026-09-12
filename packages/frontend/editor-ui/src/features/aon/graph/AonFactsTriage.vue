<script setup lang="ts">
/**
 * Facts triage: every fact Aon has extracted, filtered by status, with a
 * confirm/reject pair on the pending ones. Self-contained: fetches its own
 * page and re-fetches after a decision, same pattern as the sources table
 * in AonMemoryView.
 */
import type { AonFactSummary } from '@n8n/api-types';
import { N8nBadge, N8nButton } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { computed, onMounted, ref } from 'vue';

import { decideFact, listFacts } from '../memory-graph.api';
import { statusTheme } from '../status';
import { useAonTime } from '../useAonTime';

const PAGE_SIZE = 30;

const i18n = useI18n();
const rootStore = useRootStore();
const { ago } = useAonTime();

type StatusFilter = 'pending' | 'confirmed' | 'rejected' | 'all';
const statuses: StatusFilter[] = ['pending', 'confirmed', 'rejected', 'all'];
const status = ref<StatusFilter>('pending');

const items = ref<AonFactSummary[]>([]);
const total = ref(0);
const byStatus = ref<Record<string, number>>({});
const loading = ref(false);
const error = ref<string | null>(null);
const decidingId = ref<string | null>(null);

const canLoadMore = computed(() => items.value.length < total.value);

async function load({ append }: { append: boolean }) {
	loading.value = true;
	error.value = null;
	try {
		const page = await listFacts(rootStore.restApiContext, {
			status: status.value === 'all' ? undefined : status.value,
			limit: PAGE_SIZE,
			offset: append ? items.value.length : 0,
		});
		items.value = append ? [...items.value, ...page.items] : page.items;
		total.value = page.total;
		byStatus.value = page.byStatus;
	} catch (e) {
		error.value = (e as Error).message;
	} finally {
		loading.value = false;
	}
}

function setStatus(next: StatusFilter) {
	if (status.value === next) return;
	status.value = next;
	void load({ append: false });
}

async function decide(fact: AonFactSummary, next: 'confirmed' | 'rejected') {
	decidingId.value = fact.id;
	try {
		await decideFact(rootStore.restApiContext, fact.id, { status: next });
		await load({ append: false });
	} catch (e) {
		error.value = (e as Error).message;
	} finally {
		decidingId.value = null;
	}
}

onMounted(() => {
	void load({ append: false });
});
</script>

<template>
	<div :class="$style.wrap" data-test-id="aon-facts-triage">
		<div :class="$style.chipsRow" role="group" :aria-label="i18n.baseText('aon.facts.filterStatus')">
			<button
				v-for="s in statuses"
				:key="s"
				type="button"
				:class="[$style.chip, status === s && $style.chipOn]"
				@click="setStatus(s)"
			>
				{{ i18n.baseText(`aon.facts.status.${s}`) }}
				<span v-if="s !== 'all'" :class="$style.chipCount">{{ byStatus[s] ?? 0 }}</span>
			</button>
		</div>

		<p v-if="error" :class="$style.error">
			{{ i18n.baseText('aon.home.failed', { interpolate: { message: error } }) }}
		</p>
		<p v-else-if="!loading && items.length === 0" :class="$style.empty">
			{{ i18n.baseText('aon.facts.empty') }}
		</p>
		<ul v-else :class="$style.list">
			<li v-for="fact in items" :key="fact.id" :class="$style.row">
				<div :class="$style.rowHead">
					<span :class="$style.subject">{{ fact.subject }}</span>
					<span :class="$style.predicate">{{ fact.predicate }}</span>
					<span :class="$style.object">{{ fact.object }}</span>
					<N8nBadge :theme="statusTheme(fact.status)" size="small">{{ fact.status }}</N8nBadge>
					<span :class="$style.when">{{ ago(fact.recordedAt) }}</span>
				</div>
				<p v-if="fact.sourceTitle" :class="$style.source">{{ fact.sourceTitle }}</p>
				<div v-if="fact.status === 'pending'" :class="$style.actions">
					<N8nButton
						:label="i18n.baseText('aon.facts.confirm')"
						size="small"
						variant="outline"
						:loading="decidingId === fact.id"
						@click="decide(fact, 'confirmed')"
					/>
					<N8nButton
						:label="i18n.baseText('aon.facts.reject')"
						size="small"
						variant="outline"
						:loading="decidingId === fact.id"
						@click="decide(fact, 'rejected')"
					/>
				</div>
			</li>
		</ul>

		<N8nButton
			v-if="canLoadMore"
			:label="i18n.baseText('aon.memory.loadMore')"
			:loading="loading"
			variant="outline"
			@click="load({ append: true })"
		/>
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
	display: inline-flex;
	align-items: center;
	gap: var(--spacing--4xs);
}

.chipOn {
	background: var(--color--primary);
	border-color: var(--color--primary);
	color: var(--color--neutral-white);
}

.chipCount {
	font-variant-numeric: tabular-nums;
	opacity: 0.75;
}

.list {
	list-style: none;
	margin: 0;
	padding: 0;
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
}

.row {
	padding: var(--spacing--xs) var(--spacing--sm);
	border: var(--border);
	border-radius: var(--radius--lg);
	background: var(--color--background--light-3);
}

.rowHead {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--spacing--3xs);
}

.subject {
	font-weight: var(--font-weight--bold);
	color: var(--color--text--shade-1);
}

.predicate {
	color: var(--color--text--tint-1);
	font-style: italic;
}

.object {
	font-weight: var(--font-weight--bold);
	color: var(--color--text--shade-1);
}

.when {
	margin-left: auto;
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
}

.source {
	margin: var(--spacing--4xs) 0 0;
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
}

.actions {
	display: flex;
	gap: var(--spacing--3xs);
	margin-top: var(--spacing--2xs);
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
