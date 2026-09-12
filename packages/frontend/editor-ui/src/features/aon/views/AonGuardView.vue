<script setup lang="ts">
import type {
	AonAgentSummary,
	AonCouncilClassView,
	AonGuardEvent,
	AonGuardOverview,
	AonGuardPolicyVerdict,
} from '@n8n/api-types';
import { N8nButton, N8nOption, N8nSelect } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { RouterLink } from 'vue-router';

import { getAgents } from '../aon.api';
import AonNav from '../components/AonNav.vue';
import { AON_RUN_VIEW } from '../constants';
import {
	approve,
	deletePolicy,
	deny,
	getCouncilOverview,
	getGuardOverview,
	putCouncilShadowOnly,
	putPolicy,
} from '../guard.api';
import { useAonTime } from '../useAonTime';

/** One row of the policy table, for the currently selected identity. */
interface PolicyRowState {
	opClass: string;
	tier: number;
	label: string;
	policyId: string | null;
	verdict: '' | AonGuardPolicyVerdict;
	note: string;
}

const POLL_MS = 10_000;
const SAVED_FLASH_MS = 1500;

const i18n = useI18n();
const rootStore = useRootStore();
const { ago, untilLabel } = useAonTime();

const overview = ref<AonGuardOverview | null>(null);
const council = ref<AonCouncilClassView[]>([]);
const agents = ref<AonAgentSummary[]>([]);
const error = ref<string | null>(null);
const busyCard = ref<string | null>(null);
const busyCouncilClass = ref<string | null>(null);
const savedFlash = ref(false);
const selectedIdentity = ref('*');

let pollTimer: ReturnType<typeof setInterval> | undefined;
let savedTimer: ReturnType<typeof setTimeout> | undefined;

/** `catch` hands us `unknown`; this narrows without a cast. */
function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

async function loadOverview() {
	try {
		overview.value = await getGuardOverview(rootStore.restApiContext);
		error.value = null;
	} catch (e) {
		error.value = errorMessage(e);
	}
}

async function loadCouncil() {
	try {
		council.value = (await getCouncilOverview(rootStore.restApiContext)).classes;
	} catch (e) {
		error.value = errorMessage(e);
	}
}

async function loadAgents() {
	try {
		agents.value = await getAgents(rootStore.restApiContext);
	} catch {
		// The identity selector's agent list is a convenience; policies still work without it.
	}
}

onMounted(async () => {
	await Promise.all([loadOverview(), loadCouncil(), loadAgents()]);
	pollTimer = setInterval(() => {
		void loadOverview();
		void loadCouncil();
	}, POLL_MS);
});

onUnmounted(() => {
	if (pollTimer) clearInterval(pollTimer);
	if (savedTimer) clearTimeout(savedTimer);
});

function flashSaved() {
	savedFlash.value = true;
	if (savedTimer) clearTimeout(savedTimer);
	savedTimer = setTimeout(() => {
		savedFlash.value = false;
	}, SAVED_FLASH_MS);
}

function opClassLabel(opClass: string): string {
	return overview.value?.opClasses.find((c) => c.opClass === opClass)?.label ?? opClass;
}

function verdictLabel(verdict: AonGuardEvent['verdict']): string {
	if (verdict === 'allow') return i18n.baseText('aon.guard.event.allow');
	if (verdict === 'ask') return i18n.baseText('aon.guard.event.ask');
	if (verdict === 'deny') return i18n.baseText('aon.guard.event.deny');
	if (verdict === 'asked') return i18n.baseText('aon.guard.event.asked');
	if (verdict === 'approved') return i18n.baseText('aon.guard.event.approved');
	if (verdict === 'denied') return i18n.baseText('aon.guard.event.denied');
	if (verdict === 'council') return i18n.baseText('aon.guard.event.council');
	return i18n.baseText('aon.guard.event.expired');
}

/** The run an event belongs to, when it has one: its own meta, or (for a still-pending card) the approval it raised. */
function eventRunId(event: AonGuardEvent): string | null {
	const metaRunId = event.meta?.runId;
	if (typeof metaRunId === 'string' && metaRunId) return metaRunId;
	const approval = event.approvalId
		? overview.value?.pending.find((p) => p.id === event.approvalId)
		: undefined;
	return approval?.runId ?? null;
}

const policyRows = computed<PolicyRowState[]>(() => {
	const data = overview.value;
	if (!data) return [];
	const sorted = [...data.opClasses].sort((a, b) => a.tier - b.tier);
	return sorted.map((oc): PolicyRowState => {
		const policy = data.policies.find(
			(p) => p.identity === selectedIdentity.value && p.opClass === oc.opClass,
		);
		return {
			opClass: oc.opClass,
			tier: oc.tier,
			label: oc.label,
			policyId: policy?.id ?? null,
			verdict: policy?.verdict ?? '',
			note: policy?.note ?? '',
		};
	});
});

async function onApprove(id: string) {
	busyCard.value = id;
	try {
		await approve(rootStore.restApiContext, id);
		await loadOverview();
	} catch (e) {
		error.value = errorMessage(e);
	} finally {
		busyCard.value = null;
	}
}

async function onDeny(id: string) {
	busyCard.value = id;
	try {
		await deny(rootStore.restApiContext, id);
		await loadOverview();
	} catch (e) {
		error.value = errorMessage(e);
	} finally {
		busyCard.value = null;
	}
}

async function onToggleShadowOnly(row: AonCouncilClassView, event: Event) {
	const target = event.target;
	if (!(target instanceof HTMLInputElement)) return;
	busyCouncilClass.value = row.opClass;
	try {
		await putCouncilShadowOnly(rootStore.restApiContext, row.opClass, target.checked);
		flashSaved();
		await loadCouncil();
	} catch (e) {
		error.value = errorMessage(e);
	} finally {
		busyCouncilClass.value = null;
	}
}

async function onVerdictChange(row: PolicyRowState, event: Event) {
	const target = event.target;
	if (!(target instanceof HTMLSelectElement)) return;
	const value = target.value;
	try {
		if (value === 'allow' || value === 'ask' || value === 'deny' || value === 'council') {
			await putPolicy(rootStore.restApiContext, {
				identity: selectedIdentity.value,
				opClass: row.opClass,
				verdict: value,
				note: row.note || undefined,
			});
		} else if (row.policyId) {
			await deletePolicy(rootStore.restApiContext, row.policyId);
		}
		flashSaved();
		await loadOverview();
	} catch (e) {
		error.value = errorMessage(e);
	}
}

async function onNoteChange(row: PolicyRowState, event: Event) {
	const target = event.target;
	if (!(target instanceof HTMLInputElement)) return;
	if (row.verdict === '') return;
	try {
		await putPolicy(rootStore.restApiContext, {
			identity: selectedIdentity.value,
			opClass: row.opClass,
			verdict: row.verdict,
			note: target.value.trim() || undefined,
		});
		flashSaved();
		await loadOverview();
	} catch (e) {
		error.value = errorMessage(e);
	}
}
</script>

<template>
	<div :class="$style.page">
		<AonNav />
		<h1 :class="$style.title">{{ i18n.baseText('aon.guard.title') }}</h1>
		<p :class="$style.lede">{{ i18n.baseText('aon.guard.lede') }}</p>

		<p v-if="error" :class="$style.error">
			{{ i18n.baseText('aon.home.failed', { interpolate: { message: error } }) }}
		</p>

		<section :class="$style.section" data-test-id="aon-guard-pending">
			<h2 :class="$style.h2">{{ i18n.baseText('aon.guard.pending') }}</h2>
			<template v-if="overview">
				<p v-if="overview.pending.length === 0" :class="$style.lede">
					{{ i18n.baseText('aon.guard.noPending') }}
				</p>
				<div v-else :class="$style.cards">
					<article v-for="card in overview.pending" :key="card.id" :class="$style.card">
						<p :class="$style.cardLine">
							{{ i18n.baseText('aon.guard.card.by', { interpolate: { identity: card.identity } }) }}
							{{ opClassLabel(card.opClass) }}
							({{ i18n.baseText('aon.guard.card.tier', { interpolate: { tier: String(card.tier) } }) }})
						</p>
						<p :class="$style.cardSummary">{{ card.summary }}</p>
						<p :class="$style.cardMeta">
							<RouterLink
								v-if="card.runId"
								:class="$style.link"
								:to="{ name: AON_RUN_VIEW, params: { id: card.runId ?? '' } }"
							>
								{{ i18n.baseText('aon.guard.card.run', { interpolate: { id: card.runId ?? '' } }) }}
							</RouterLink>
							<span>
								{{ i18n.baseText('aon.guard.card.expires', { interpolate: { when: untilLabel(card.expiresAt) } }) }}
							</span>
						</p>
						<div :class="$style.cardActions">
							<N8nButton
								size="small"
								:label="i18n.baseText('aon.guard.approve')"
								:disabled="busyCard === card.id"
								data-test-id="aon-guard-approve"
								@click="onApprove(card.id)"
							/>
							<N8nButton
								size="small"
								type="tertiary"
								:label="i18n.baseText('aon.guard.deny')"
								:disabled="busyCard === card.id"
								data-test-id="aon-guard-deny"
								@click="onDeny(card.id)"
							/>
						</div>
					</article>
				</div>
			</template>
		</section>

		<section :class="$style.section" data-test-id="aon-guard-policies">
			<h2 :class="$style.h2">
				{{ i18n.baseText('aon.guard.policies') }}
				<span v-if="savedFlash" :class="$style.saved">{{ i18n.baseText('aon.guard.saved') }}</span>
			</h2>
			<p :class="$style.lede">{{ i18n.baseText('aon.guard.policiesLede') }}</p>

			<div :class="$style.filters">
				<N8nSelect v-model="selectedIdentity" :teleported="false" size="small" :class="$style.identitySelect">
					<N8nOption value="*" :label="i18n.baseText('aon.guard.identity.everyone')" />
					<N8nOption value="owner" :label="i18n.baseText('aon.guard.identity.owner')" />
					<N8nOption
						v-for="agent in agents"
						:key="agent.slug"
						:value="`agent:${agent.slug}`"
						:label="i18n.baseText('aon.guard.identity.agent', { interpolate: { slug: agent.slug } })"
					/>
				</N8nSelect>
			</div>

			<div v-if="overview" :class="$style.tableWrap">
				<table :class="$style.table">
					<thead>
						<tr>
							<th>{{ i18n.baseText('aon.guard.column.opClass') }}</th>
							<th>{{ i18n.baseText('aon.guard.column.tier') }}</th>
							<th>{{ i18n.baseText('aon.guard.column.verdict') }}</th>
							<th>{{ i18n.baseText('aon.guard.column.note') }}</th>
						</tr>
					</thead>
					<tbody>
						<tr v-for="row in policyRows" :key="row.opClass">
							<td>
								<div>{{ row.label }}</div>
								<div :class="$style.opClassCode">{{ row.opClass }}</div>
							</td>
							<td>{{ row.tier }}</td>
							<td>
								<select :class="$style.verdictSelect" :value="row.verdict" @change="onVerdictChange(row, $event)">
									<option value="">{{ i18n.baseText('aon.guard.verdict.default') }}</option>
									<option value="allow">{{ i18n.baseText('aon.guard.verdict.allow') }}</option>
									<option value="ask">{{ i18n.baseText('aon.guard.verdict.ask') }}</option>
									<option value="deny">{{ i18n.baseText('aon.guard.verdict.deny') }}</option>
									<option value="council">{{ i18n.baseText('aon.guard.verdict.council') }}</option>
								</select>
							</td>
							<td>
								<input
									:class="$style.noteInput"
									:value="row.note"
									:disabled="row.verdict === ''"
									@change="onNoteChange(row, $event)"
								/>
							</td>
						</tr>
					</tbody>
				</table>
			</div>
		</section>

		<section :class="$style.section" data-test-id="aon-guard-council">
			<h2 :class="$style.h2">{{ i18n.baseText('aon.guard.council.title') }}</h2>
			<p :class="$style.lede">{{ i18n.baseText('aon.guard.council.lede') }}</p>

			<p v-if="council.length === 0" :class="$style.lede">
				{{ i18n.baseText('aon.guard.council.none') }}
			</p>
			<div v-else :class="$style.tableWrap">
				<table :class="$style.table">
					<thead>
						<tr>
							<th>{{ i18n.baseText('aon.guard.column.opClass') }}</th>
							<th>{{ i18n.baseText('aon.guard.council.column.status') }}</th>
							<th>{{ i18n.baseText('aon.guard.council.column.rulings') }}</th>
							<th>{{ i18n.baseText('aon.guard.council.column.agreement') }}</th>
							<th>{{ i18n.baseText('aon.guard.council.column.falseApprovals') }}</th>
							<th>{{ i18n.baseText('aon.guard.council.column.last') }}</th>
							<th>{{ i18n.baseText('aon.guard.council.column.shadowOnly') }}</th>
						</tr>
					</thead>
					<tbody>
						<tr v-for="row in council" :key="row.opClass">
							<td>
								<div>{{ opClassLabel(row.opClass) }}</div>
								<div :class="$style.opClassCode">{{ row.opClass }}</div>
							</td>
							<td>
								<span v-if="row.live">{{ i18n.baseText('aon.guard.council.live') }}</span>
								<span v-else>{{ i18n.baseText('aon.guard.council.shadow') }}</span>
								<div v-if="row.blocker" :class="$style.opClassCode">{{ row.blocker }}</div>
							</td>
							<td>{{ row.decided }} / {{ row.rulings }}</td>
							<td>{{ row.agreement }}</td>
							<td>{{ row.falseApprovals }}</td>
							<td>{{ row.lastRulingAt ? ago(row.lastRulingAt) : '—' }}</td>
							<td>
								<input
									type="checkbox"
									:checked="row.shadowOnly"
									:disabled="busyCouncilClass === row.opClass"
									@change="onToggleShadowOnly(row, $event)"
								/>
							</td>
						</tr>
					</tbody>
				</table>
			</div>
		</section>

		<section :class="$style.section">
			<h2 :class="$style.h2">{{ i18n.baseText('aon.guard.recent') }}</h2>
			<template v-if="overview">
				<p v-if="overview.recent.length === 0" :class="$style.lede">
					{{ i18n.baseText('aon.guard.noRecent') }}
				</p>
				<ul v-else :class="$style.eventList">
					<li v-for="ev in overview.recent" :key="ev.id" :class="$style.eventLine">
						<span>{{ ev.identity }}</span>
						<span :class="$style.dot">·</span>
						<span>{{ opClassLabel(ev.opClass) }}</span>
						<span :class="$style.dot">·</span>
						<span>{{ verdictLabel(ev.verdict) }}</span>
						<span :class="$style.dot">·</span>
						<span :class="$style.when">{{ ago(ev.ts) }}</span>
						<RouterLink
							v-if="eventRunId(ev)"
							:class="$style.link"
							:to="{ name: AON_RUN_VIEW, params: { id: eventRunId(ev) ?? '' } }"
						>
							{{ i18n.baseText('aon.guard.card.run', { interpolate: { id: eventRunId(ev) ?? '' } }) }}
						</RouterLink>
					</li>
				</ul>
			</template>
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
	gap: var(--spacing--xs);
}

.title {
	font-size: var(--font-size--2xl);
	margin: 0;
	color: var(--color--text--shade-1);
}

.lede {
	color: var(--color--text--tint-1);
	margin: 0 0 var(--spacing--md);
	max-width: 60ch;
}

.error {
	margin: 0;
	color: var(--color--danger);
}

.section {
	margin-top: var(--spacing--lg);
}

.h2 {
	font-size: var(--font-size--lg);
	margin: 0 0 var(--spacing--3xs);
	color: var(--color--text--shade-1);
	display: flex;
	align-items: baseline;
	gap: var(--spacing--xs);
}

.saved {
	font-size: var(--font-size--2xs);
	font-weight: var(--font-weight--regular);
	color: var(--color--success);
}

.cards {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xs);
}

.card {
	border: var(--border);
	border-radius: var(--radius--lg);
	background: var(--color--background--light-3);
	padding: var(--spacing--sm) var(--spacing--md);
	display: flex;
	flex-direction: column;
	gap: var(--spacing--3xs);
}

.cardLine {
	margin: 0;
	color: var(--color--text--shade-1);
	font-weight: var(--font-weight--bold);
}

.cardSummary {
	margin: 0;
	color: var(--color--text);
}

.cardMeta {
	margin: 0;
	display: flex;
	gap: var(--spacing--sm);
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
}

.cardActions {
	display: flex;
	gap: var(--spacing--2xs);
	margin-top: var(--spacing--3xs);
}

.link {
	color: var(--color--primary);
	text-decoration: none;

	&:hover {
		text-decoration: underline;
	}
}

.filters {
	display: flex;
	flex-wrap: wrap;
	align-items: flex-end;
	gap: var(--spacing--lg);
	margin-bottom: var(--spacing--xs);
}

.identitySelect {
	min-width: 220px;
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

.opClassCode {
	font-size: var(--font-size--3xs);
	color: var(--color--text--tint-1);
}

.verdictSelect {
	font: inherit;
	font-size: var(--font-size--2xs);
	padding: var(--spacing--4xs) var(--spacing--2xs);
	border: var(--border);
	border-radius: var(--radius--sm);
	color: var(--color--text);
}

.noteInput {
	width: 100%;
	min-width: 160px;
	font: inherit;
	font-size: var(--font-size--2xs);
	padding: var(--spacing--4xs) var(--spacing--2xs);
	border: var(--border);
	border-radius: var(--radius--sm);
	color: var(--color--text);

	&:disabled {
		opacity: 0.5;
	}
}

.eventList {
	list-style: none;
	margin: 0;
	padding: 0;
	display: flex;
	flex-direction: column;
	gap: var(--spacing--3xs);
}

.eventLine {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	gap: var(--spacing--3xs);
	font-size: var(--font-size--2xs);
	color: var(--color--text);
	padding: var(--spacing--3xs) 0;
	border-bottom: var(--border);
}

.dot {
	color: var(--color--text--tint-2);
}

.when {
	color: var(--color--text--tint-1);
}
</style>
