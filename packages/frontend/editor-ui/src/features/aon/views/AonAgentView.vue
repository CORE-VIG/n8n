<script setup lang="ts">
import type { AonAgentDetail } from '@n8n/api-types';
import { useToast } from '@n8n/composables/useToast';
import { N8nBadge, N8nButton, N8nInput } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { computed, onMounted, reactive, ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import { resetBreaker as resetBreakerRequest, runDeliverable, setAgentStatus } from '../agents.api';
import { getAgent } from '../aon.api';
import AonNav from '../components/AonNav.vue';
import { AON_AGENTS_VIEW, AON_RUN_VIEW } from '../constants';
import { statusTheme } from '../status';
import { useAonTime } from '../useAonTime';

const i18n = useI18n();
const rootStore = useRootStore();
const route = useRoute();
const router = useRouter();
const { ago } = useAonTime();
const { showMessage, showError } = useToast();

const slug = computed(() => String(route.params.slug ?? ''));
const agent = ref<AonAgentDetail | null>(null);
const missing = ref(false);
const error = ref<string | null>(null);

const togglingStatus = ref(false);
const resettingBreaker = ref(false);
const runInputs = reactive<Record<string, string>>({});
const runningDeliverable = ref<string | null>(null);

const isActive = computed(() => agent.value?.status === 'active');
const spentEurMonthText = computed(() => (agent.value?.spentEurMonth ?? 0).toFixed(2));
const budgetEurMonthText = computed(() => (agent.value?.charter.guard.budgetEurMonth ?? 0).toFixed(2));

/** `catch` hands us `unknown`; this narrows without a cast. */
function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function failedTitle(e: unknown): string {
	return i18n.baseText('aon.home.failed', { interpolate: { message: errorMessage(e) } });
}

async function toggleStatus() {
	if (!agent.value || togglingStatus.value) return;
	togglingStatus.value = true;
	const next = isActive.value ? 'paused' : 'active';
	try {
		const updated = await setAgentStatus(rootStore.restApiContext, agent.value.slug, next);
		agent.value = { ...agent.value, ...updated };
		showMessage({
			type: 'success',
			title: i18n.baseText('aon.agent.statusChanged', {
				interpolate: { name: updated.name, status: updated.status },
			}),
		});
	} catch (e) {
		showError(e, failedTitle(e));
	} finally {
		togglingStatus.value = false;
	}
}

async function doResetBreaker() {
	if (!agent.value || resettingBreaker.value) return;
	resettingBreaker.value = true;
	try {
		const updated = await resetBreakerRequest(rootStore.restApiContext, agent.value.slug);
		agent.value = { ...agent.value, ...updated };
		showMessage({ type: 'success', title: i18n.baseText('aon.agent.breakerReset') });
	} catch (e) {
		showError(e, failedTitle(e));
	} finally {
		resettingBreaker.value = false;
	}
}

async function runNow(deliverableId: string) {
	if (!agent.value || runningDeliverable.value) return;
	runningDeliverable.value = deliverableId;
	try {
		const input = (runInputs[deliverableId] ?? '').trim();
		const run = await runDeliverable(rootStore.restApiContext, agent.value.slug, deliverableId, {
			input: input || undefined,
		});
		runInputs[deliverableId] = '';
		showMessage({
			type: 'success',
			title: i18n.baseText('aon.agent.runQueued', { interpolate: { id: run.id } }),
			onClick: () => void router.push({ name: AON_RUN_VIEW, params: { id: run.id } }),
		});
	} catch (e) {
		showMessage({
			type: 'error',
			title: i18n.baseText('aon.agent.runFailedToQueue', { interpolate: { message: errorMessage(e) } }),
		});
	} finally {
		runningDeliverable.value = null;
	}
}

/** A charter value, readable: strings as they are, everything else as JSON. */
const show = (value: unknown): string => {
	if (typeof value === 'string') return value;
	if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value.join(', ');
	return JSON.stringify(value, null, 2);
};

const join = (values: string[]) => values.join(', ');

/** Purpose / Owns / Sources, skipping whichever of them is empty. */
const orientationRows = computed(() => {
	const o = agent.value?.charter.orientation;
	if (!o) return [];
	const rows: Array<{ label: string; value: string }> = [];
	if (o.purpose) rows.push({ label: i18n.baseText('aon.agent.purpose'), value: o.purpose });
	if (o.owns.length > 0) rows.push({ label: i18n.baseText('aon.agent.owns'), value: join(o.owns) });
	if (o.sources.length > 0) {
		rows.push({ label: i18n.baseText('aon.agent.sources'), value: join(o.sources) });
	}
	return rows;
});

/** The Guard settings that are actually set, skipping the rest. */
const guardRows = computed(() => {
	const g = agent.value?.charter.guard;
	if (!g) return [];
	const rows: Array<{ label: string; value: string }> = [];
	if (g.tierCeiling !== null) {
		rows.push({ label: i18n.baseText('aon.agent.guard.tierCeiling'), value: String(g.tierCeiling) });
	}
	if (g.breakerLimit !== null) {
		rows.push({ label: i18n.baseText('aon.agent.guard.breakerLimit'), value: String(g.breakerLimit) });
	}
	if (g.escalateWhen !== null) {
		rows.push({ label: i18n.baseText('aon.agent.guard.escalateWhen'), value: g.escalateWhen });
	}
	if (g.budgetEurMonth !== null) {
		rows.push({ label: i18n.baseText('aon.agent.guard.budgetEurMonth'), value: String(g.budgetEurMonth) });
	}
	if (g.modelBand !== null) {
		rows.push({ label: i18n.baseText('aon.agent.guard.modelBand'), value: g.modelBand });
	}
	return rows;
});

/** Whatever the imported charter carried that Aon's own shape does not name. */
const otherRows = computed(() =>
	Object.entries(agent.value?.charter.other ?? {}).map(([key, value]) => ({ key, value: show(value) })),
);

const euro = (n: number) => `€${n.toFixed(2)}`;

onMounted(async () => {
	try {
		agent.value = await getAgent(rootStore.restApiContext, slug.value);
	} catch (e) {
		const status = (e as { httpStatusCode?: number }).httpStatusCode;
		if (status === 404) missing.value = true;
		else error.value = (e as Error).message;
	}
});
</script>

<template>
	<div :class="$style.page">
		<AonNav />
		<RouterLink :to="{ name: AON_AGENTS_VIEW }" :class="$style.back">
			{{ i18n.baseText('aon.agent.back') }}
		</RouterLink>

		<p v-if="missing" :class="$style.lede">
			{{ i18n.baseText('aon.agent.notFound', { interpolate: { slug } }) }}
		</p>
		<p v-else-if="error" :class="$style.error">
			{{ i18n.baseText('aon.home.failed', { interpolate: { message: error } }) }}
		</p>

		<template v-else-if="agent">
			<header :class="$style.head" data-test-id="aon-agent-head">
				<h1 :class="$style.title">{{ agent.name }}</h1>
				<N8nBadge :theme="statusTheme(agent.status)" data-test-id="aon-agent-status">
					{{ agent.status }}
				</N8nBadge>
				<code :class="$style.slug">{{ agent.slug }}</code>
				<N8nButton
					:label="i18n.baseText(isActive ? 'aon.agent.pause' : 'aon.agent.activate')"
					:loading="togglingStatus"
					variant="outline"
					size="small"
					@click="toggleStatus"
				/>
				<N8nButton
					v-if="agent.breakerTrippedAt"
					:label="i18n.baseText('aon.agent.resetBreaker')"
					:loading="resettingBreaker"
					variant="outline"
					size="small"
					@click="doResetBreaker"
				/>
			</header>
			<p v-if="agent.breakerTrippedAt" :class="$style.error">
				{{
					i18n.baseText('aon.agent.breaker', {
						interpolate: {
							when: ago(agent.breakerTrippedAt),
							failures: String(agent.breakerFailures),
						},
					})
				}}
			</p>
			<p v-if="agent.charter.guard.budgetEurMonth !== null" :class="$style.meta">
				{{
					i18n.baseText('aon.agent.budget', {
						interpolate: { spent: spentEurMonthText, budget: budgetEurMonthText },
					})
				}}
			</p>

			<section :class="$style.section">
				<h2 :class="$style.h2">{{ i18n.baseText('aon.agent.orientation') }}</h2>
				<p :class="$style.prose">{{ agent.persona }}</p>
				<dl v-if="orientationRows.length > 0" :class="$style.charter">
					<template v-for="row in orientationRows" :key="row.label">
						<dt>{{ row.label }}</dt>
						<dd>{{ row.value }}</dd>
					</template>
				</dl>
			</section>

			<section :class="$style.section">
				<h2 :class="$style.h2">{{ i18n.baseText('aon.agent.rulesStanding') }}</h2>
				<h3 :class="$style.h3">{{ i18n.baseText('aon.agent.rulesDo') }}</h3>
				<ul :class="$style.cards">
					<li v-for="(item, i) in agent.charter.rules.do" :key="i" :class="$style.card">{{ item }}</li>
				</ul>
				<h3 :class="$style.h3">{{ i18n.baseText('aon.agent.rulesDont') }}</h3>
				<ul :class="$style.cards">
					<li v-for="(item, i) in agent.charter.rules.dont" :key="i" :class="$style.card">{{ item }}</li>
				</ul>
				<h3 :class="$style.h3">{{ i18n.baseText('aon.agent.rulesLearned') }}</h3>
				<p v-if="agent.rules.length === 0" :class="$style.lede">
					{{ i18n.baseText('aon.agent.none') }}
				</p>
				<ul v-else :class="$style.cards">
					<li v-for="rule in agent.rules" :key="rule.id" :class="$style.card">
						<div :class="$style.cardHead">
							<N8nBadge :theme="statusTheme(rule.state)" size="small">{{ rule.state }}</N8nBadge>
							<span :class="$style.meta">{{ ago(rule.createdAt) }}</span>
						</div>
						<p :class="$style.prose">{{ rule.text }}</p>
						<span v-if="rule.reason" :class="$style.meta">{{ rule.reason }}</span>
					</li>
				</ul>
			</section>

			<section :class="$style.section">
				<h2 :class="$style.h2">{{ i18n.baseText('aon.agent.skills') }}</h2>
				<p v-if="agent.charter.skills.length === 0" :class="$style.lede">
					{{ i18n.baseText('aon.agent.none') }}
				</p>
				<ul v-else :class="$style.cards">
					<li v-for="(item, i) in agent.charter.skills" :key="i" :class="$style.card">{{ item }}</li>
				</ul>
			</section>

			<section :class="$style.section">
				<h2 :class="$style.h2">{{ i18n.baseText('aon.agent.tools') }}</h2>
				<p v-if="agent.charter.tools.length === 0" :class="$style.lede">
					{{ i18n.baseText('aon.agent.none') }}
				</p>
				<ul v-else :class="$style.cards">
					<li v-for="(item, i) in agent.charter.tools" :key="i" :class="$style.card">{{ item }}</li>
				</ul>
			</section>

			<section :class="$style.section">
				<h2 :class="$style.h2">{{ i18n.baseText('aon.agent.guard') }}</h2>
				<dl v-if="guardRows.length > 0" :class="$style.charter">
					<template v-for="row in guardRows" :key="row.label">
						<dt>{{ row.label }}</dt>
						<dd>{{ row.value }}</dd>
					</template>
				</dl>
			</section>

			<section :class="$style.section">
				<h2 :class="$style.h2">{{ i18n.baseText('aon.agent.deliverables') }}</h2>
				<p v-if="agent.deliverables.length === 0" :class="$style.lede">
					{{ i18n.baseText('aon.agent.noDeliverables') }}
				</p>
				<ul v-else :class="$style.cards">
					<li v-for="d in agent.deliverables" :key="d.id" :class="$style.card">
						<div :class="$style.cardHead">
							<span :class="$style.cardTitle">{{ d.name }}</span>
							<N8nBadge size="small" theme="tertiary">{{ d.shape }}</N8nBadge>
							<N8nBadge v-if="d.cadence" size="small" theme="tertiary">{{ d.cadence }}</N8nBadge>
							<N8nBadge size="small" theme="tertiary">
								{{ i18n.baseText('aon.agent.deliverable.tier', { interpolate: { tier: String(d.tier) } }) }}
							</N8nBadge>
							<N8nBadge v-if="!d.enabled" size="small" theme="warning">
								{{ i18n.baseText('aon.agent.deliverable.disabled') }}
							</N8nBadge>
						</div>
						<p :class="$style.prose">{{ d.dod }}</p>
						<span v-if="d.lastRunAt" :class="$style.meta">
							{{ i18n.baseText('aon.agent.deliverable.lastRun', { interpolate: { when: ago(d.lastRunAt) } }) }}
						</span>
						<div :class="$style.runNow">
							<N8nInput
								v-model="runInputs[d.id]"
								type="textarea"
								:rows="2"
								:disabled="!isActive"
								:placeholder="i18n.baseText('aon.agent.runInput')"
							/>
							<div :class="$style.runNowRow">
								<N8nButton
									:label="i18n.baseText('aon.agent.runNow')"
									:disabled="!isActive"
									:loading="runningDeliverable === d.id"
									data-test-id="aon-agent-run-now"
									@click="runNow(d.id)"
								/>
								<span v-if="!isActive" :class="$style.meta">{{ i18n.baseText('aon.agent.notActive') }}</span>
							</div>
						</div>
					</li>
				</ul>
			</section>

			<section :class="$style.section">
				<h2 :class="$style.h2">{{ i18n.baseText('aon.agent.runs') }}</h2>
				<p v-if="agent.runs.length === 0" :class="$style.lede">
					{{ i18n.baseText('aon.agent.noRuns') }}
				</p>
				<div v-else :class="$style.tableWrap">
					<table :class="$style.table" data-test-id="aon-agent-runs">
						<thead>
							<tr>
								<th>{{ i18n.baseText('aon.run.column.status') }}</th>
								<th>{{ i18n.baseText('aon.run.column.deliverable') }}</th>
								<th>{{ i18n.baseText('aon.run.column.invokedBy') }}</th>
								<th>{{ i18n.baseText('aon.run.column.model') }}</th>
								<th :class="$style.num">{{ i18n.baseText('aon.run.column.cost') }}</th>
								<th>{{ i18n.baseText('aon.run.column.started') }}</th>
								<th>{{ i18n.baseText('aon.run.column.finished') }}</th>
							</tr>
						</thead>
						<tbody>
							<tr v-for="run in agent.runs" :key="run.id">
								<td>
									<N8nBadge :theme="statusTheme(run.status)" size="small">{{ run.status }}</N8nBadge>
									<div :class="$style.meta">
										{{
											i18n.baseText('aon.run.attempt', {
												interpolate: { attempt: String(run.attempt), iteration: String(run.iteration) },
											})
										}}
									</div>
									<div v-if="run.help" :class="$style.help">{{ run.help }}</div>
								</td>
								<td>{{ run.deliverableName ?? run.deliverableId }}</td>
								<td>{{ run.invokedBy }}</td>
								<td>{{ run.model ?? '—' }}</td>
								<td :class="$style.num">{{ euro(run.costEur) }}</td>
								<td :class="$style.when">{{ ago(run.startedAt ?? run.createdAt) }}</td>
								<td :class="$style.when">{{ ago(run.finishedAt) }}</td>
							</tr>
						</tbody>
					</table>
				</div>
			</section>

			<section v-if="otherRows.length > 0" :class="$style.section">
				<h2 :class="$style.h2">{{ i18n.baseText('aon.agent.other') }}</h2>
				<dl :class="$style.charter">
					<template v-for="row in otherRows" :key="row.key">
						<dt>{{ row.key }}</dt>
						<dd>{{ row.value }}</dd>
					</template>
				</dl>
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

.slug {
	font-family: var(--font-family--monospace);
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
}

.h2 {
	font-size: var(--font-size--lg);
	margin: 0 0 var(--spacing--2xs);
	color: var(--color--text--shade-1);
}

.h3 {
	font-size: var(--font-size--sm);
	font-weight: var(--font-weight--bold);
	margin: var(--spacing--xs) 0 var(--spacing--4xs);
	color: var(--color--text--tint-1);
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

.charter {
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
		color: var(--color--text);
		max-width: 72ch;
	}
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

.meta {
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
}

.help {
	font-size: var(--font-size--2xs);
	color: var(--color--warning);
	max-width: 40ch;
}

.runNow {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--3xs);
	margin-top: var(--spacing--3xs);
	max-width: 480px;
}

.runNowRow {
	display: flex;
	align-items: center;
	gap: var(--spacing--xs);
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
</style>
