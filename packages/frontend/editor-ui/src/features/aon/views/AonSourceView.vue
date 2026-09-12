<script setup lang="ts">
import type { AonSourceDetail } from '@n8n/api-types';
import { N8nBadge, N8nButton } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { computed, onMounted, ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import AonNav from '../components/AonNav.vue';
import { AON_MEMORY_VIEW } from '../constants';
import { deleteSource, getSource } from '../memory.api';
import { statusTheme } from '../status';
import { useAonTime } from '../useAonTime';

const i18n = useI18n();
const rootStore = useRootStore();
const route = useRoute();
const router = useRouter();
const { ago } = useAonTime();

const id = computed(() => String(route.params.id ?? ''));
const source = ref<AonSourceDetail | null>(null);
const missing = ref(false);
const error = ref<string | null>(null);
const deleting = ref(false);

const externalUrl = computed(() => {
	const external = source.value?.externalId;
	return external && /^https?:\/\//i.test(external) ? external : null;
});

onMounted(async () => {
	try {
		source.value = await getSource(rootStore.restApiContext, id.value);
	} catch (e) {
		const status = (e as { httpStatusCode?: number }).httpStatusCode;
		if (status === 404) missing.value = true;
		else error.value = (e as Error).message;
	}
});

async function onDelete() {
	if (!source.value) return;
	const confirmed = window.confirm(
		i18n.baseText('aon.source.deleteConfirm', { interpolate: { title: source.value.title } }),
	);
	if (!confirmed) return;

	deleting.value = true;
	try {
		await deleteSource(rootStore.restApiContext, id.value);
		await router.push({ name: AON_MEMORY_VIEW });
	} catch (e) {
		error.value = (e as Error).message;
		deleting.value = false;
	}
}
</script>

<template>
	<div :class="$style.page">
		<AonNav />
		<RouterLink :to="{ name: AON_MEMORY_VIEW }" :class="$style.back">
			{{ i18n.baseText('aon.source.back') }}
		</RouterLink>

		<p v-if="missing" :class="$style.lede">{{ i18n.baseText('aon.source.notFound') }}</p>
		<p v-else-if="error" :class="$style.error">
			{{ i18n.baseText('aon.home.failed', { interpolate: { message: error } }) }}
		</p>

		<template v-else-if="source">
			<header :class="$style.head">
				<h1 :class="$style.title">{{ source.title }}</h1>
				<N8nBadge theme="tertiary">{{ source.origin }}</N8nBadge>
				<N8nBadge theme="tertiary">{{ source.kind }}</N8nBadge>
				<N8nBadge :theme="statusTheme(source.status)">{{ source.status }}</N8nBadge>
			</header>

			<section :class="$style.section">
				<h2 :class="$style.h2">{{ i18n.baseText('aon.source.meta') }}</h2>
				<dl :class="$style.details">
					<dt>{{ i18n.baseText('aon.source.docTime') }}</dt>
					<dd>{{ ago(source.docTime) }}</dd>

					<dt>{{ i18n.baseText('aon.source.indexedAt') }}</dt>
					<dd>{{ ago(source.indexedAt) }}</dd>

					<template v-if="source.externalId">
						<dt>{{ i18n.baseText('aon.source.externalId') }}</dt>
						<dd>
							<a v-if="externalUrl" :href="externalUrl" target="_blank" rel="noopener noreferrer">{{
								source.externalId
							}}</a>
							<span v-else>{{ source.externalId }}</span>
						</dd>
					</template>

					<dt>{{ i18n.baseText('aon.source.chunks') }}</dt>
					<dd>{{ source.embeddedCount }}/{{ source.chunkCount }}</dd>
				</dl>
			</section>

			<section :class="$style.section">
				<h2 :class="$style.h2">
					{{ i18n.baseText('aon.source.content') }} ·
					{{
						i18n.baseText('aon.source.bytes', {
							interpolate: { bytes: source.bytes.toLocaleString() },
						})
					}}
				</h2>
				<pre :class="$style.content" data-test-id="aon-source-content">{{ source.content }}</pre>
			</section>

			<section :class="$style.section">
				<h2 :class="$style.h2">{{ i18n.baseText('aon.source.chunks') }}</h2>
				<ul v-if="source.chunks.length > 0" :class="$style.cards">
					<li v-for="chunk in source.chunks" :key="chunk.id" :class="$style.card">
						<div :class="$style.cardHead">
							<span :class="$style.cardTitle">
								{{ i18n.baseText('aon.source.chunkOf', { interpolate: { seq: String(chunk.seq + 1) } }) }}
							</span>
							<N8nBadge :theme="chunk.embeddedAt ? 'success' : 'warning'" size="small">
								{{
									i18n.baseText(
										chunk.embeddedAt ? 'aon.source.chunkEmbedded' : 'aon.source.chunkPending',
									)
								}}
							</N8nBadge>
						</div>
						<p :class="$style.prose">{{ chunk.text }}</p>
					</li>
				</ul>
			</section>

			<N8nButton
				:label="i18n.baseText('aon.source.delete')"
				:loading="deleting"
				variant="destructive"
				data-test-id="aon-source-delete"
				@click="onDelete"
			/>
		</template>
	</div>
</template>

<style lang="scss" module>
.page {
	max-width: 960px;
	margin: 0 auto;
	padding: var(--spacing--2xl) var(--spacing--lg) var(--spacing--3xl);
	display: flex;
	flex-direction: column;
	gap: var(--spacing--md);
}

.back {
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
	align-self: flex-start;
}

.head {
	display: flex;
	align-items: center;
	gap: var(--spacing--xs);
	flex-wrap: wrap;
}

.title {
	font-size: var(--font-size--2xl);
	margin: 0;
	color: var(--color--text--shade-1);
}

.h2 {
	font-size: var(--font-size--lg);
	margin: 0 0 var(--spacing--2xs);
	color: var(--color--text--shade-1);
}

.section {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
}

.lede {
	color: var(--color--text--tint-1);
	margin: 0;
}

.error {
	margin: 0;
	color: var(--color--danger);
}

.prose {
	margin: 0;
	color: var(--color--text);
	white-space: pre-wrap;
	max-width: 72ch;
}

.details {
	margin: 0;
	display: grid;
	grid-template-columns: minmax(120px, max-content) 1fr;
	gap: var(--spacing--3xs) var(--spacing--md);

	dt {
		color: var(--color--text--tint-1);
		font-size: var(--font-size--2xs);
		padding-top: 2px;
	}

	dd {
		margin: 0;
		white-space: pre-wrap;
		word-break: break-word;
		color: var(--color--text);
		max-width: 72ch;
	}
}

.content {
	margin: 0;
	padding: var(--spacing--sm);
	border: var(--border);
	border-radius: var(--radius--lg);
	background: var(--color--background--light-3);
	color: var(--color--text);
	font-size: var(--font-size--2xs);
	font-family: inherit;
	white-space: pre-wrap;
	word-break: break-word;
	max-height: 50vh;
	overflow-y: auto;
}

.cards {
	list-style: none;
	margin: 0;
	padding: 0;
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
}

.card {
	padding: var(--spacing--xs) var(--spacing--sm);
	border: var(--border);
	border-radius: var(--radius--lg);
	background: var(--color--background--light-3);
	display: flex;
	flex-direction: column;
	gap: var(--spacing--4xs);
}

.cardHead {
	display: flex;
	align-items: center;
	gap: var(--spacing--3xs);
	flex-wrap: wrap;
}

.cardTitle {
	font-weight: var(--font-weight--bold);
	color: var(--color--text--shade-1);
	margin-right: var(--spacing--3xs);
}
</style>
