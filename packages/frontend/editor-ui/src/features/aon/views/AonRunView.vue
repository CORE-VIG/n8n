<script setup lang="ts">
import type { AonRunDetail } from '@n8n/api-types';
import { N8nBadge } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { computed, onMounted, ref } from 'vue';
import { RouterLink, useRoute } from 'vue-router';

import AonNav from '../components/AonNav.vue';
import { AON_AGENT_VIEW, AON_RUNS_VIEW } from '../constants';
import { getRun } from '../runs.api';
import { statusTheme } from '../status';
import { useAonTime } from '../useAonTime';

const i18n = useI18n();
const rootStore = useRootStore();
const route = useRoute();
const { ago } = useAonTime();

const id = computed(() => String(route.params.id ?? ''));
const shortId = computed(() => id.value.slice(0, 8));
const run = ref<AonRunDetail | null>(null);
const missing = ref(false);
const error = ref<string | null>(null);

const euro = (n: number) => `€${n.toFixed(2)}`;

/** `catch` hands us `unknown`; these narrow it without a cast. */
function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function httpStatusOf(e: unknown): number | undefined {
	if (typeof e === 'object' && e !== null && 'httpStatusCode' in e) {
		const value = e.httpStatusCode;
		return typeof value === 'number' ? value : undefined;
	}
	return undefined;
}

/** A jsonb column, shown as indented JSON; empty when there is nothing recorded. */
const pretty = (value: unknown): string =>
	value === null || value === undefined ? '' : JSON.stringify(value, null, 2);

const inputText = computed(() => pretty(run.value?.input));
const verificationText = computed(() => pretty(run.value?.verification));

interface FactRow {
	label: string;
	value: string;
}

/** Skips every field whose value is null, so the timeline only shows what happened. */
const timelineRows = computed<FactRow[]>(() => {
	const r = run.value;
	if (!r) return [];
	const rows: FactRow[] = [{ label: i18n.baseText('aon.run.created'), value: ago(r.createdAt) }];
	if (r.startedAt) rows.push({ label: i18n.baseText('aon.run.started'), value: ago(r.startedAt) });
	if (r.finishedAt) {
		rows.push({ label: i18n.baseText('aon.run.finished'), value: ago(r.finishedAt) });
	}
	if (r.heartbeatAt) {
		rows.push({ label: i18n.baseText('aon.run.heartbeat'), value: ago(r.heartbeatAt) });
	}
	if (r.claimedBy) rows.push({ label: i18n.baseText('aon.run.claimedBy'), value: r.claimedBy });
	if (r.parentRunId) rows.push({ label: i18n.baseText('aon.run.parent'), value: r.parentRunId });
	return rows;
});

onMounted(async () => {
	try {
		run.value = await getRun(rootStore.restApiContext, id.value);
	} catch (e) {
		if (httpStatusOf(e) === 404) missing.value = true;
		else error.value = errorMessage(e);
	}
});
</script>

<template>
	<div :class="$style.page">
		<AonNav />
		<RouterLink :to="{ name: AON_RUNS_VIEW }" :class="$style.back">
			{{ i18n.baseText('aon.run.back') }}
		</RouterLink>

		<p v-if="missing" :class="$style.lede">{{ i18n.baseText('aon.run.notFound') }}</p>
		<p v-else-if="error" :class="$style.error">
			{{ i18n.baseText('aon.home.failed', { interpolate: { message: error } }) }}
		</p>

		<template v-else-if="run">
			<header :class="$style.head">
				<h1 :class="$style.title">
					{{ i18n.baseText('aon.run.title', { interpolate: { id: shortId } }) }}
				</h1>
				<N8nBadge :theme="statusTheme(run.status)">{{ run.status }}</N8nBadge>
			</header>
			<p :class="$style.meta">
				{{
					i18n.baseText('aon.run.attempt', {
						interpolate: { attempt: String(run.attempt), iteration: String(run.iteration) },
					})
				}}
				·
				{{
					i18n.baseText('aon.run.tokens', {
						interpolate: { tokensIn: String(run.tokensIn), tokensOut: String(run.tokensOut) },
					})
				}}
			</p>

			<section :class="$style.section">
				<dl :class="$style.facts">
					<dt>{{ i18n.baseText('aon.runs.column.agent') }}</dt>
					<dd>
						<RouterLink
							v-if="run.agentSlug"
							:to="{ name: AON_AGENT_VIEW, params: { slug: run.agentSlug } }"
						>
							{{ run.agentName ?? run.agentSlug }}
						</RouterLink>
						<span v-else>{{ run.agentName ?? '—' }}</span>
					</dd>
					<dt>{{ i18n.baseText('aon.runs.column.deliverable') }}</dt>
					<dd>{{ run.deliverableName ?? run.deliverableId }}</dd>
					<dt>{{ i18n.baseText('aon.runs.column.invokedBy') }}</dt>
					<dd>{{ run.invokedBy }}</dd>
					<dt>{{ i18n.baseText('aon.runs.column.model') }}</dt>
					<dd>{{ run.model ?? '—' }}</dd>
					<dt>{{ i18n.baseText('aon.runs.column.cost') }}</dt>
					<dd>{{ euro(run.costEur) }}</dd>
				</dl>
			</section>

			<section :class="$style.section">
				<h2 :class="$style.h2">{{ i18n.baseText('aon.run.timeline') }}</h2>
				<dl :class="$style.facts">
					<template v-for="row in timelineRows" :key="row.label">
						<dt>{{ row.label }}</dt>
						<dd>{{ row.value }}</dd>
					</template>
				</dl>
			</section>

			<section :class="$style.section">
				<h2 :class="$style.h2">{{ i18n.baseText('aon.run.input') }}</h2>
				<pre v-if="inputText" :class="$style.pre">{{ inputText }}</pre>
				<p v-else :class="$style.lede">{{ i18n.baseText('aon.run.none') }}</p>
			</section>

			<section :class="$style.section">
				<h2 :class="$style.h2">{{ i18n.baseText('aon.run.output') }}</h2>
				<pre
					v-if="run.output"
					:class="$style.preWrap"
					data-test-id="aon-run-output"
				>{{ run.output }}</pre>
				<p v-else :class="$style.lede" data-test-id="aon-run-output">
					{{ i18n.baseText('aon.run.none') }}
				</p>
			</section>

			<section :class="$style.section">
				<h2 :class="$style.h2">{{ i18n.baseText('aon.run.verification') }}</h2>
				<pre v-if="verificationText" :class="$style.pre">{{ verificationText }}</pre>
				<p v-else :class="$style.lede">{{ i18n.baseText('aon.run.none') }}</p>
			</section>

			<section :class="$style.section">
				<h2 :class="$style.h2">{{ i18n.baseText('aon.run.help') }}</h2>
				<p v-if="run.help" :class="$style.prose">{{ run.help }}</p>
				<p v-else :class="$style.lede">{{ i18n.baseText('aon.run.none') }}</p>
			</section>
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

.meta {
	margin: 0;
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
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

.facts {
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
		color: var(--color--text);
	}
}

.pre,
.preWrap {
	margin: 0;
	padding: var(--spacing--sm);
	background: var(--color--background--light-3);
	border: var(--border);
	border-radius: var(--radius--lg);
	font-family: var(--font-family--monospace);
	font-size: var(--font-size--2xs);
	overflow: auto;
	max-height: 480px;
}

.pre {
	white-space: pre;
}

.preWrap {
	white-space: pre-wrap;
}
</style>
