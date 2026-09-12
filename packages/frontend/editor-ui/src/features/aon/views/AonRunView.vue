<script setup lang="ts">
import type { AonRunDetail, AonRunEvent } from '@n8n/api-types';
import { useToast } from '@n8n/composables/useToast';
import { N8nBadge, N8nButton } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { RouterLink, useRoute } from 'vue-router';

import AonNav from '../components/AonNav.vue';
import { AON_AGENT_VIEW, AON_GUARD_VIEW, AON_RUNS_VIEW } from '../constants';
import { getRun, getRunEvents, stopRun } from '../runs.api';
import { statusTheme } from '../status';
import { useAonTime } from '../useAonTime';

const IN_FLIGHT_STATUSES = new Set(['queued', 'working', 'validating', 'waiting_approval']);
const EVENTS_POLL_MS = 3_000;

const i18n = useI18n();
const rootStore = useRootStore();
const route = useRoute();
const { ago } = useAonTime();
const { showMessage, showError } = useToast();

const id = computed(() => String(route.params.id ?? ''));
const shortId = computed(() => id.value.slice(0, 8));
const run = ref<AonRunDetail | null>(null);
const missing = ref(false);
const error = ref<string | null>(null);
const events = ref<AonRunEvent[]>([]);
const stopping = ref(false);

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

function failedTitle(e: unknown): string {
	return i18n.baseText('aon.home.failed', { interpolate: { message: errorMessage(e) } });
}

const isInFlight = computed(() => run.value !== null && IN_FLIGHT_STATUSES.has(run.value.status));
const lastSeq = computed(() => events.value.at(-1)?.seq ?? 0);
const visibleEvents = computed(() => events.value.filter((ev) => ev.type !== 'cost' && ev.type !== 'note'));

interface JudgeVerdictView {
	status: 'pass' | 'fail' | 'unknown';
	critique: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/** `run.verification.judge`, read without trusting its shape. */
const judge = computed<JudgeVerdictView | null>(() => {
	const verification = run.value?.verification;
	if (!isRecord(verification) || !isRecord(verification.judge)) return null;
	const j = verification.judge;
	const status = j.status === 'pass' || j.status === 'fail' ? j.status : 'unknown';
	return { status, critique: typeof j.critique === 'string' ? j.critique : '' };
});

const judgeText = computed(() => {
	if (!judge.value) return '';
	if (judge.value.status === 'pass') return i18n.baseText('aon.run.judge.pass');
	if (judge.value.status === 'fail') {
		return i18n.baseText('aon.run.judge.fail', { interpolate: { critique: judge.value.critique } });
	}
	return i18n.baseText('aon.run.judge.unknown');
});

function toolBadgeTheme(status: string | null): 'success' | 'warning' | 'danger' | 'default' {
	if (status === 'ok') return 'success';
	if (status === 'error') return 'danger';
	if (status === 'start') return 'warning';
	return 'default';
}

let eventsPoll: ReturnType<typeof setInterval> | undefined;

function syncPolling() {
	if (isInFlight.value && !eventsPoll) {
		eventsPoll = setInterval(() => void loadEvents(), EVENTS_POLL_MS);
	} else if (!isInFlight.value && eventsPoll) {
		clearInterval(eventsPoll);
		eventsPoll = undefined;
	}
}

async function loadEvents(): Promise<void> {
	if (!run.value) return;
	try {
		const fresh = await getRunEvents(rootStore.restApiContext, run.value.id, lastSeq.value);
		if (!fresh.length) return;
		events.value = [...events.value, ...fresh];
		if (fresh.some((ev) => ev.type === 'status')) {
			run.value = await getRun(rootStore.restApiContext, run.value.id);
			syncPolling();
		}
	} catch {
		// A live poll failing once is not worth showing; the next tick retries.
	}
}

async function doStop(): Promise<void> {
	if (!run.value || stopping.value) return;
	stopping.value = true;
	try {
		run.value = await stopRun(rootStore.restApiContext, run.value.id);
		await loadEvents();
		syncPolling();
		showMessage({ type: 'success', title: i18n.baseText('aon.run.stopped') });
	} catch (e) {
		showError(e, failedTitle(e));
	} finally {
		stopping.value = false;
	}
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
		await loadEvents();
		syncPolling();
	} catch (e) {
		if (httpStatusOf(e) === 404) missing.value = true;
		else error.value = errorMessage(e);
	}
});

onUnmounted(() => {
	if (eventsPoll) clearInterval(eventsPoll);
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
				<N8nBadge v-if="isInFlight" theme="warning" size="small">
					{{ i18n.baseText('aon.run.live') }}
				</N8nBadge>
				<N8nButton
					v-if="isInFlight"
					:label="i18n.baseText('aon.run.stop')"
					:loading="stopping"
					variant="outline"
					size="small"
					data-test-id="aon-run-stop"
					@click="doStop"
				/>
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
			<p v-if="run.status === 'waiting_approval'" :class="$style.notice">
				<RouterLink :to="{ name: AON_GUARD_VIEW }">{{ i18n.baseText('aon.run.waitingApproval') }}</RouterLink>
			</p>
			<p v-else-if="run.status === 'needs_help'" :class="$style.notice">
				{{ i18n.baseText('aon.run.needsHelp') }}<template v-if="run.help">: {{ run.help }}</template>
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

			<section v-if="judge" :class="$style.section">
				<h2 :class="$style.h2">{{ i18n.baseText('aon.run.judge') }}</h2>
				<N8nBadge :theme="statusTheme(judge.status)" size="small">{{ judge.status }}</N8nBadge>
				<p :class="$style.prose">{{ judgeText }}</p>
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

			<section :class="$style.section">
				<h2 :class="$style.h2">{{ i18n.baseText('aon.run.log') }}</h2>
				<p v-if="visibleEvents.length === 0" :class="$style.lede">
					{{ i18n.baseText('aon.run.noLog') }}
				</p>
				<ul v-else :class="$style.log" data-test-id="aon-run-log">
					<li v-for="ev in visibleEvents" :key="ev.id" :class="$style.logRow">
						<template v-if="ev.type === 'tool'">
							<N8nBadge :theme="toolBadgeTheme(ev.status)" size="small">{{ ev.status }}</N8nBadge>
							<code :class="$style.logName">{{ ev.name }}</code>
						</template>
						<template v-else-if="ev.type === 'text'">
							<pre :class="$style.logText">{{ ev.text }}</pre>
						</template>
						<template v-else>
							<N8nBadge :theme="statusTheme(ev.status ?? ev.type)" size="small">{{ ev.type }}</N8nBadge>
							<span v-if="ev.text" :class="$style.logNoteText">{{ ev.text }}</span>
						</template>
						<span :class="$style.logWhen">{{ ago(ev.createdAt) }}</span>
					</li>
				</ul>
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

.notice {
	margin: 0;
	font-size: var(--font-size--sm);
	color: var(--color--text--tint-1);
}

.log {
	list-style: none;
	margin: 0;
	padding: 0;
	display: flex;
	flex-direction: column;
	gap: var(--spacing--3xs);
}

.logRow {
	display: flex;
	align-items: baseline;
	gap: var(--spacing--3xs);
	padding: var(--spacing--3xs) var(--spacing--sm);
	border: var(--border);
	border-radius: var(--radius--sm);
	background: var(--color--background--light-3);
	flex-wrap: wrap;
}

.logName {
	font-family: var(--font-family--monospace);
	font-size: var(--font-size--2xs);
	color: var(--color--text--shade-1);
}

.logText {
	margin: 0;
	flex-basis: 100%;
	white-space: pre-wrap;
	font-family: inherit;
	font-size: var(--font-size--2xs);
	color: var(--color--text);
}

.logNoteText {
	font-size: var(--font-size--2xs);
	color: var(--color--text);
}

.logWhen {
	margin-left: auto;
	font-size: var(--font-size--3xs);
	color: var(--color--text--tint-1);
	white-space: nowrap;
}
</style>
