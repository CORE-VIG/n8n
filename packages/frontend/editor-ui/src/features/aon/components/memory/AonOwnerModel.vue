<script setup lang="ts">
/**
 * The model of the owner: the five buckets the nightly dream keeps
 * (identity, people, projects, preferences, commitments), with a "Dream now"
 * button that asks Aon to rebuild it on the spot.
 */
import type { AonOwnerModel, AonOwnerModelBuckets } from '@n8n/api-types';
import { N8nButton } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { onMounted, ref } from 'vue';

import { dreamNow, getOwnerModel } from '../../memory.api';
import { useAonTime } from '../../useAonTime';

const BUCKETS: ReadonlyArray<keyof AonOwnerModelBuckets> = [
	'identity',
	'people',
	'projects',
	'preferences',
	'commitments',
];

const i18n = useI18n();
const rootStore = useRootStore();
const { ago } = useAonTime();

const model = ref<AonOwnerModel | null>(null);
const loading = ref(false);
const loadError = ref<string | null>(null);
const dreaming = ref(false);
const dreamMessage = ref<string | null>(null);

async function load() {
	loading.value = true;
	loadError.value = null;
	try {
		model.value = await getOwnerModel(rootStore.restApiContext);
	} catch (e) {
		loadError.value = (e as Error).message;
	} finally {
		loading.value = false;
	}
}

async function runDream() {
	if (dreaming.value) return;
	dreaming.value = true;
	dreamMessage.value = null;
	try {
		const result = await dreamNow(rootStore.restApiContext);
		dreamMessage.value = result.message;
		if (result.model) {
			model.value = result.model;
		} else {
			await load();
		}
	} catch (e) {
		dreamMessage.value = i18n.baseText('aon.memory.model.dreamFailed', {
			interpolate: { message: (e as Error).message },
		});
	} finally {
		dreaming.value = false;
	}
}

onMounted(() => {
	void load();
});
</script>

<template>
	<section :class="$style.wrap" data-test-id="aon-owner-model">
		<div :class="$style.head">
			<div>
				<h2 :class="$style.h2">{{ i18n.baseText('aon.memory.model.title') }}</h2>
				<p :class="$style.lede">{{ i18n.baseText('aon.memory.model.lede') }}</p>
			</div>
			<N8nButton
				:label="i18n.baseText('aon.memory.model.dreamNow')"
				:loading="dreaming"
				variant="outline"
				data-test-id="aon-owner-model-dream-now"
				@click="runDream"
			/>
		</div>

		<p v-if="loadError" :class="$style.error">
			{{ i18n.baseText('aon.home.failed', { interpolate: { message: loadError } }) }}
		</p>
		<p v-if="dreamMessage" :class="$style.hint">{{ dreamMessage }}</p>
		<p v-if="model?.updatedAt" :class="$style.hint">
			{{ i18n.baseText('aon.memory.model.updatedAt', { interpolate: { when: ago(model.updatedAt) } }) }}
			<template v-if="model.model">
				— {{ i18n.baseText('aon.memory.model.builtBy', { interpolate: { model: model.model } }) }}
			</template>
		</p>
		<p v-else-if="!loading" :class="$style.hint">{{ i18n.baseText('aon.memory.model.never') }}</p>

		<div v-if="model" :class="$style.grid">
			<div v-for="bucket in BUCKETS" :key="bucket" :class="$style.card">
				<h3 :class="$style.cardTitle">{{ i18n.baseText(`aon.memory.model.bucket.${bucket}`) }}</h3>
				<p :class="$style.cardText">
					{{ model.buckets[bucket] || i18n.baseText('aon.memory.model.bucketEmpty') }}
				</p>
			</div>
		</div>
	</section>
</template>

<style lang="scss" module>
.wrap {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xs);
}

.head {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: var(--spacing--sm);
	flex-wrap: wrap;
}

.h2 {
	font-size: var(--font-size--lg);
	margin: 0;
	color: var(--color--text--shade-1);
}

.lede {
	color: var(--color--text--tint-1);
	margin: var(--spacing--4xs) 0 0;
	max-width: 60ch;
}

.hint {
	margin: 0;
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
}

.error {
	margin: 0;
	color: var(--color--danger);
}

.grid {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
	gap: var(--spacing--xs);
}

.card {
	padding: var(--spacing--xs) var(--spacing--sm);
	border: var(--border);
	border-radius: var(--radius--lg);
	background: var(--color--background--light-3);
	display: flex;
	flex-direction: column;
	gap: var(--spacing--3xs);
}

.cardTitle {
	margin: 0;
	font-size: var(--font-size--xs);
	color: var(--color--text--shade-1);
}

.cardText {
	margin: 0;
	color: var(--color--text);
	white-space: pre-wrap;
}
</style>
