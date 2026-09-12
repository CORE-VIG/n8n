<script setup lang="ts">
/**
 * Observations: the patterns Aon has noticed on its own, grouped by bucket,
 * with how strongly each one has stood out (salience) and when it was last
 * seen.
 */
import type { AonObservationSummary } from '@n8n/api-types';
import { N8nBadge, N8nButton } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { computed, onMounted, ref } from 'vue';

import { listObservations } from '../memory-graph.api';
import { useAonTime } from '../useAonTime';

const PAGE_SIZE = 30;

const i18n = useI18n();
const rootStore = useRootStore();
const { ago } = useAonTime();

const items = ref<AonObservationSummary[]>([]);
const total = ref(0);
const loading = ref(false);
const error = ref<string | null>(null);

const canLoadMore = computed(() => items.value.length < total.value);

async function load({ append }: { append: boolean }) {
	loading.value = true;
	error.value = null;
	try {
		const page = await listObservations(rootStore.restApiContext, {
			limit: PAGE_SIZE,
			offset: append ? items.value.length : 0,
		});
		items.value = append ? [...items.value, ...page.items] : page.items;
		total.value = page.total;
	} catch (e) {
		error.value = (e as Error).message;
	} finally {
		loading.value = false;
	}
}

function salienceWidth(salience: number): string {
	return `${Math.round(Math.min(1, Math.max(0, salience)) * 100)}%`;
}

onMounted(() => {
	void load({ append: false });
});
</script>

<template>
	<div :class="$style.wrap" data-test-id="aon-observations">
		<p v-if="error" :class="$style.error">
			{{ i18n.baseText('aon.home.failed', { interpolate: { message: error } }) }}
		</p>
		<p v-else-if="!loading && items.length === 0" :class="$style.empty">
			{{ i18n.baseText('aon.observations.empty') }}
		</p>
		<ul v-else :class="$style.list">
			<li v-for="ob in items" :key="ob.id" :class="$style.row">
				<div :class="$style.head">
					<N8nBadge theme="tertiary" size="small">{{ ob.bucket }}</N8nBadge>
					<N8nBadge theme="default" size="small">{{ ob.status }}</N8nBadge>
					<span :class="$style.seen">
						{{ i18n.baseText('aon.observations.seen', { interpolate: { when: ago(ob.lastSeen) } }) }}
					</span>
				</div>
				<p :class="$style.text">{{ ob.text }}</p>
				<div :class="$style.salience" :title="i18n.baseText('aon.observations.salience')">
					<div :class="$style.salienceFill" :style="{ width: salienceWidth(ob.salience) }" />
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
	display: flex;
	flex-direction: column;
	gap: var(--spacing--3xs);
}

.head {
	display: flex;
	align-items: center;
	gap: var(--spacing--3xs);
}

.seen {
	margin-left: auto;
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
}

.text {
	margin: 0;
	color: var(--color--text);
}

.salience {
	width: 100%;
	height: 4px;
	border-radius: var(--radius--full);
	background: var(--color--background--base);
	overflow: hidden;
}

.salienceFill {
	height: 100%;
	background: var(--color--primary);
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
