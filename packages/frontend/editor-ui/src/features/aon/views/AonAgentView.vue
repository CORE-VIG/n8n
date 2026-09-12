<script setup lang="ts">
import type { AonAgentDetail, AonCharterInput, AonDeliverableSummary } from '@n8n/api-types';
import { useToast } from '@n8n/composables/useToast';
import { N8nBadge, N8nButton, N8nInput, N8nOption, N8nSelect } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { computed, onMounted, reactive, ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import {
	createDeliverable,
	deleteDeliverable as deleteDeliverableRequest,
	resetBreaker as resetBreakerRequest,
	runDeliverable,
	setAgentStatus,
	updateCharter,
	updateDeliverable,
} from '../agents.api';
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

const modelBands = ['fast', 'standard', 'deep'] as const;

/** One item per line, blanks dropped. */
const lines = (value: string): string[] =>
	value
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

const numberOrUndefined = (value: string): number | undefined => {
	const n = Number(value);
	return value.trim() !== '' && Number.isFinite(n) ? n : undefined;
};

// --- charter editing --------------------------------------------------

const editingCharter = ref(false);
const savingCharter = ref(false);
const charterForm = reactive({
	name: '',
	persona: '',
	purpose: '',
	owns: '',
	sources: '',
	rulesDo: '',
	rulesDont: '',
	skills: '',
	tools: '',
	tierCeiling: '',
	breakerLimit: '',
	budgetEurMonth: '',
	modelBand: 'standard' as (typeof modelBands)[number],
});

function startEditCharter() {
	if (!agent.value) return;
	const c = agent.value.charter;
	charterForm.name = agent.value.name;
	charterForm.persona = agent.value.persona;
	charterForm.purpose = c.orientation.purpose ?? '';
	charterForm.owns = c.orientation.owns.join('\n');
	charterForm.sources = c.orientation.sources.join('\n');
	charterForm.rulesDo = c.rules.do.join('\n');
	charterForm.rulesDont = c.rules.dont.join('\n');
	charterForm.skills = c.skills.join('\n');
	charterForm.tools = c.tools.join('\n');
	charterForm.tierCeiling = c.guard.tierCeiling !== null ? String(c.guard.tierCeiling) : '';
	charterForm.breakerLimit = c.guard.breakerLimit !== null ? String(c.guard.breakerLimit) : '';
	charterForm.budgetEurMonth = c.guard.budgetEurMonth !== null ? String(c.guard.budgetEurMonth) : '';
	charterForm.modelBand = (c.guard.modelBand as (typeof modelBands)[number] | null) ?? 'standard';
	editingCharter.value = true;
}

function cancelEditCharter() {
	editingCharter.value = false;
}

async function saveCharter() {
	if (!agent.value || savingCharter.value) return;
	savingCharter.value = true;
	try {
		const charter: AonCharterInput = {
			purpose: charterForm.purpose.trim() || undefined,
			owns: lines(charterForm.owns),
			sources: lines(charterForm.sources),
			do: lines(charterForm.rulesDo),
			dont: lines(charterForm.rulesDont),
			skills: lines(charterForm.skills),
			tools: lines(charterForm.tools),
			tierCeiling: numberOrUndefined(charterForm.tierCeiling),
			breakerLimit: numberOrUndefined(charterForm.breakerLimit),
			budgetEurMonth: numberOrUndefined(charterForm.budgetEurMonth),
			modelBand: charterForm.modelBand,
		};
		const updated = await updateCharter(rootStore.restApiContext, agent.value.slug, {
			name: charterForm.name.trim() || undefined,
			persona: charterForm.persona,
			charter,
		});
		agent.value = updated;
		editingCharter.value = false;
		showMessage({ type: 'success', title: i18n.baseText('aon.agent.saved') });
	} catch (e) {
		showError(e, failedTitle(e));
	} finally {
		savingCharter.value = false;
	}
}

// --- deliverable editing --------------------------------------------------

const editingDeliverableId = ref<string | null>(null);
const savingDeliverable = ref(false);
const deletingDeliverableId = ref<string | null>(null);
const addingDeliverable = ref(false);
const showNewDeliverable = ref(false);

const deliverableForm = reactive({
	name: '',
	dod: '',
	shape: 'single',
	cadence: '',
	tier: '2',
	approver: 'owner',
	maxIterations: '3',
});

function cancelNewDeliverable() {
	showNewDeliverable.value = false;
	resetDeliverableForm();
}

function resetDeliverableForm() {
	deliverableForm.name = '';
	deliverableForm.dod = '';
	deliverableForm.shape = 'single';
	deliverableForm.cadence = '';
	deliverableForm.tier = '2';
	deliverableForm.approver = 'owner';
	deliverableForm.maxIterations = '3';
}

function startEditDeliverable(d: AonDeliverableSummary) {
	editingDeliverableId.value = d.id;
	deliverableForm.name = d.name;
	deliverableForm.dod = d.dod;
	deliverableForm.shape = d.shape;
	deliverableForm.cadence = d.cadence ?? '';
	deliverableForm.tier = String(d.tier);
	deliverableForm.approver = d.approver;
	deliverableForm.maxIterations = String(d.maxIterations);
}

function cancelEditDeliverable() {
	editingDeliverableId.value = null;
}

function replaceDeliverable(updated: AonDeliverableSummary) {
	if (!agent.value) return;
	agent.value = {
		...agent.value,
		deliverables: agent.value.deliverables.map((d) => (d.id === updated.id ? updated : d)),
	};
}

async function saveDeliverable(id: string) {
	if (!agent.value || savingDeliverable.value) return;
	savingDeliverable.value = true;
	try {
		const updated = await updateDeliverable(rootStore.restApiContext, agent.value.slug, id, {
			name: deliverableForm.name.trim(),
			dod: deliverableForm.dod.trim(),
			shape: deliverableForm.shape,
			cadence: deliverableForm.cadence.trim() || undefined,
			tier: numberOrUndefined(deliverableForm.tier) ?? 2,
			approver: deliverableForm.approver,
			maxIterations: numberOrUndefined(deliverableForm.maxIterations),
		});
		replaceDeliverable(updated);
		editingDeliverableId.value = null;
		showMessage({ type: 'success', title: i18n.baseText('aon.agent.saved') });
	} catch (e) {
		showError(e, failedTitle(e));
	} finally {
		savingDeliverable.value = false;
	}
}

async function toggleDeliverableEnabled(d: AonDeliverableSummary) {
	if (!agent.value) return;
	try {
		const updated = await updateDeliverable(rootStore.restApiContext, agent.value.slug, d.id, {
			enabled: !d.enabled,
		});
		replaceDeliverable(updated);
	} catch (e) {
		showError(e, failedTitle(e));
	}
}

async function removeDeliverable(d: AonDeliverableSummary) {
	if (!agent.value || deletingDeliverableId.value) return;
	if (!window.confirm(i18n.baseText('aon.agent.deliverable.deleteConfirm', { interpolate: { name: d.name } }))) {
		return;
	}
	deletingDeliverableId.value = d.id;
	try {
		await deleteDeliverableRequest(rootStore.restApiContext, agent.value.slug, d.id);
		agent.value = { ...agent.value, deliverables: agent.value.deliverables.filter((x) => x.id !== d.id) };
	} catch (e) {
		showError(e, failedTitle(e));
	} finally {
		deletingDeliverableId.value = null;
	}
}

async function addDeliverable() {
	if (!agent.value || addingDeliverable.value) return;
	if (!deliverableForm.name.trim() || !deliverableForm.dod.trim()) {
		showMessage({ type: 'error', title: i18n.baseText('aon.agent.deliverable.nameAndDodRequired') });
		return;
	}
	addingDeliverable.value = true;
	try {
		const created = await createDeliverable(rootStore.restApiContext, agent.value.slug, {
			name: deliverableForm.name.trim(),
			dod: deliverableForm.dod.trim(),
			shape: deliverableForm.shape,
			cadence: deliverableForm.cadence.trim() || undefined,
			tier: numberOrUndefined(deliverableForm.tier) ?? 2,
			approver: deliverableForm.approver,
			maxIterations: numberOrUndefined(deliverableForm.maxIterations),
		});
		agent.value = { ...agent.value, deliverables: [...agent.value.deliverables, created] };
		resetDeliverableForm();
		showNewDeliverable.value = false;
		showMessage({ type: 'success', title: i18n.baseText('aon.agent.saved') });
	} catch (e) {
		showError(e, failedTitle(e));
	} finally {
		addingDeliverable.value = false;
	}
}

/** A short "next {duration}" for `nextRunAt`, without borrowing `ago()`'s past-tense wording. */
function dueIn(iso: string | null): string | null {
	if (!iso) return null;
	const minutes = Math.abs(new Date(iso).getTime() - Date.now()) / 60_000;
	if (minutes < 1) return i18n.baseText('aon.time.justNow');
	if (minutes < 60) return `${Math.round(minutes)} min`;
	if (minutes < 60 * 48) return `${Math.round(minutes / 60)} h`;
	if (minutes < 60 * 24 * 30) return `${Math.round(minutes / (60 * 24))} d`;
	return new Date(iso).toLocaleDateString();
}

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
				<N8nButton
					v-if="!editingCharter"
					:label="i18n.baseText('aon.agent.edit')"
					variant="outline"
					size="small"
					data-test-id="aon-agent-edit"
					@click="startEditCharter"
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

			<template v-if="!editingCharter">
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
			</template>

			<section v-else :class="$style.section" data-test-id="aon-agent-edit-form">
				<h2 :class="$style.h2">{{ i18n.baseText('aon.agent.edit') }}</h2>
				<div :class="$style.form">
					<div :class="$style.row">
						<label :class="$style.label">{{ i18n.baseText('aon.agent.new.name') }}</label>
						<N8nInput v-model="charterForm.name" />
					</div>
					<div :class="$style.row">
						<label :class="$style.label">{{ i18n.baseText('aon.agent.persona') }}</label>
						<N8nInput v-model="charterForm.persona" type="textarea" :rows="2" />
					</div>
					<div :class="$style.row">
						<label :class="$style.label">{{ i18n.baseText('aon.agent.purpose') }}</label>
						<N8nInput v-model="charterForm.purpose" type="textarea" :rows="2" />
					</div>
					<div :class="$style.row">
						<label :class="$style.label">{{ i18n.baseText('aon.agent.owns') }}</label>
						<N8nInput v-model="charterForm.owns" type="textarea" :rows="3" :placeholder="i18n.baseText('aon.agent.new.oneLine')" />
					</div>
					<div :class="$style.row">
						<label :class="$style.label">{{ i18n.baseText('aon.agent.sources') }}</label>
						<N8nInput v-model="charterForm.sources" type="textarea" :rows="3" :placeholder="i18n.baseText('aon.agent.new.oneLine')" />
					</div>
					<div :class="$style.row">
						<label :class="$style.label">{{ i18n.baseText('aon.agent.rulesDo') }}</label>
						<N8nInput v-model="charterForm.rulesDo" type="textarea" :rows="3" :placeholder="i18n.baseText('aon.agent.new.oneLine')" />
					</div>
					<div :class="$style.row">
						<label :class="$style.label">{{ i18n.baseText('aon.agent.rulesDont') }}</label>
						<N8nInput v-model="charterForm.rulesDont" type="textarea" :rows="3" :placeholder="i18n.baseText('aon.agent.new.oneLine')" />
					</div>
					<div :class="$style.row">
						<label :class="$style.label">{{ i18n.baseText('aon.agent.skills') }}</label>
						<N8nInput v-model="charterForm.skills" type="textarea" :rows="2" :placeholder="i18n.baseText('aon.agent.new.oneLine')" />
					</div>
					<div :class="$style.row">
						<label :class="$style.label">{{ i18n.baseText('aon.agent.tools') }}</label>
						<N8nInput v-model="charterForm.tools" type="textarea" :rows="2" :placeholder="i18n.baseText('aon.agent.new.oneLine')" />
					</div>
					<div :class="$style.formGrid">
						<div :class="$style.row">
							<label :class="$style.label">{{ i18n.baseText('aon.agent.guard.tierCeiling') }}</label>
							<N8nInput v-model="charterForm.tierCeiling" type="number" :min="0" :max="4" />
						</div>
						<div :class="$style.row">
							<label :class="$style.label">{{ i18n.baseText('aon.agent.guard.breakerLimit') }}</label>
							<N8nInput v-model="charterForm.breakerLimit" type="number" :min="1" />
						</div>
						<div :class="$style.row">
							<label :class="$style.label">{{ i18n.baseText('aon.agent.guard.budgetEurMonth') }}</label>
							<N8nInput v-model="charterForm.budgetEurMonth" type="number" :min="0" />
						</div>
						<div :class="$style.row">
							<label :class="$style.label">{{ i18n.baseText('aon.agent.guard.modelBand') }}</label>
							<N8nSelect v-model="charterForm.modelBand">
								<N8nOption v-for="band in modelBands" :key="band" :value="band" :label="band" />
							</N8nSelect>
						</div>
					</div>
					<div :class="$style.formActions">
						<N8nButton
							:label="i18n.baseText('aon.agent.save')"
							:loading="savingCharter"
							data-test-id="aon-agent-save"
							@click="saveCharter"
						/>
						<N8nButton
							:label="i18n.baseText('aon.agent.cancel')"
							variant="outline"
							:disabled="savingCharter"
							@click="cancelEditCharter"
						/>
					</div>
				</div>
			</section>

			<section :class="$style.section">
				<h2 :class="$style.h2">{{ i18n.baseText('aon.agent.deliverables') }}</h2>
				<p v-if="agent.deliverables.length === 0" :class="$style.lede">
					{{ i18n.baseText('aon.agent.noDeliverables') }}
				</p>
				<ul v-else :class="$style.cards">
					<li v-for="d in agent.deliverables" :key="d.id" :class="$style.card">
						<template v-if="editingDeliverableId === d.id">
							<div :class="$style.form">
								<div :class="$style.row">
									<label :class="$style.label">{{ i18n.baseText('aon.agent.new.name') }}</label>
									<N8nInput v-model="deliverableForm.name" />
								</div>
								<div :class="$style.row">
									<label :class="$style.label">{{ i18n.baseText('aon.agent.deliverable.dod') }}</label>
									<N8nInput v-model="deliverableForm.dod" type="textarea" :rows="2" />
								</div>
								<div :class="$style.formGrid">
									<div :class="$style.row">
										<label :class="$style.label">{{ i18n.baseText('aon.agent.deliverable.shape') }}</label>
										<N8nSelect v-model="deliverableForm.shape">
											<N8nOption value="single" label="single" />
											<N8nOption value="recurring" label="recurring" />
											<N8nOption value="goal" label="goal" />
										</N8nSelect>
									</div>
									<div :class="$style.row">
										<label :class="$style.label">{{ i18n.baseText('aon.agent.deliverable.cadence') }}</label>
										<N8nInput v-model="deliverableForm.cadence" placeholder="0 7 * * 1" />
										<span :class="$style.hint">{{ i18n.baseText('aon.agent.deliverable.cadenceHint') }}</span>
									</div>
									<div :class="$style.row">
										<label :class="$style.label">{{ i18n.baseText('aon.agent.deliverable.tier') }}</label>
										<N8nInput v-model="deliverableForm.tier" type="number" :min="0" :max="4" />
									</div>
									<div :class="$style.row">
										<label :class="$style.label">{{ i18n.baseText('aon.agent.deliverable.approver') }}</label>
										<N8nSelect v-model="deliverableForm.approver">
											<N8nOption value="owner" label="owner" />
											<N8nOption value="auto" label="auto" />
										</N8nSelect>
									</div>
									<div :class="$style.row">
										<label :class="$style.label">{{ i18n.baseText('aon.agent.deliverable.maxIterations') }}</label>
										<N8nInput v-model="deliverableForm.maxIterations" type="number" :min="1" />
									</div>
								</div>
								<div :class="$style.formActions">
									<N8nButton
										:label="i18n.baseText('aon.agent.save')"
										:loading="savingDeliverable"
										data-test-id="aon-deliverable-save"
										@click="saveDeliverable(d.id)"
									/>
									<N8nButton
										:label="i18n.baseText('aon.agent.cancel')"
										variant="outline"
										:disabled="savingDeliverable"
										@click="cancelEditDeliverable"
									/>
								</div>
							</div>
						</template>
						<template v-else>
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
							<span v-if="d.nextRunAt" :class="$style.meta">
								{{ i18n.baseText('aon.agent.deliverable.next', { interpolate: { when: dueIn(d.nextRunAt) ?? '' } }) }}
							</span>
							<div :class="$style.deliverableActions">
								<label :class="$style.toggle">
									<input type="checkbox" :checked="d.enabled" @change="toggleDeliverableEnabled(d)" />
									{{ i18n.baseText('aon.agent.deliverable.enabled') }}
								</label>
								<N8nButton
									:label="i18n.baseText('aon.agent.edit')"
									variant="outline"
									size="small"
									data-test-id="aon-deliverable-edit"
									@click="startEditDeliverable(d)"
								/>
								<N8nButton
									:label="i18n.baseText('aon.agent.deliverable.delete')"
									variant="outline"
									size="small"
									:loading="deletingDeliverableId === d.id"
									data-test-id="aon-deliverable-delete"
									@click="removeDeliverable(d)"
								/>
							</div>
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
						</template>
					</li>
				</ul>

				<div :class="$style.newDeliverable">
					<N8nButton
						v-if="!showNewDeliverable"
						:label="i18n.baseText('aon.agent.deliverable.new')"
						variant="outline"
						size="small"
						data-test-id="aon-deliverable-new"
						@click="showNewDeliverable = true"
					/>
					<div v-else :class="$style.form">
						<h3 :class="$style.h3">{{ i18n.baseText('aon.agent.deliverable.new') }}</h3>
						<div :class="$style.row">
							<label :class="$style.label">{{ i18n.baseText('aon.agent.new.name') }}</label>
							<N8nInput v-model="deliverableForm.name" />
						</div>
						<div :class="$style.row">
							<label :class="$style.label">{{ i18n.baseText('aon.agent.deliverable.dod') }}</label>
							<N8nInput v-model="deliverableForm.dod" type="textarea" :rows="2" />
						</div>
						<div :class="$style.formGrid">
							<div :class="$style.row">
								<label :class="$style.label">{{ i18n.baseText('aon.agent.deliverable.shape') }}</label>
								<N8nSelect v-model="deliverableForm.shape">
									<N8nOption value="single" label="single" />
									<N8nOption value="recurring" label="recurring" />
									<N8nOption value="goal" label="goal" />
								</N8nSelect>
							</div>
							<div :class="$style.row">
								<label :class="$style.label">{{ i18n.baseText('aon.agent.deliverable.cadence') }}</label>
								<N8nInput v-model="deliverableForm.cadence" placeholder="0 7 * * 1" />
								<span :class="$style.hint">{{ i18n.baseText('aon.agent.deliverable.cadenceHint') }}</span>
							</div>
							<div :class="$style.row">
								<label :class="$style.label">{{ i18n.baseText('aon.agent.deliverable.tier') }}</label>
								<N8nInput v-model="deliverableForm.tier" type="number" :min="0" :max="4" />
							</div>
							<div :class="$style.row">
								<label :class="$style.label">{{ i18n.baseText('aon.agent.deliverable.approver') }}</label>
								<N8nSelect v-model="deliverableForm.approver">
									<N8nOption value="owner" label="owner" />
									<N8nOption value="auto" label="auto" />
								</N8nSelect>
							</div>
							<div :class="$style.row">
								<label :class="$style.label">{{ i18n.baseText('aon.agent.deliverable.maxIterations') }}</label>
								<N8nInput v-model="deliverableForm.maxIterations" type="number" :min="1" />
							</div>
						</div>
						<div :class="$style.formActions">
							<N8nButton
								:label="i18n.baseText('aon.agent.deliverable.create')"
								:loading="addingDeliverable"
								data-test-id="aon-deliverable-create"
								@click="addDeliverable"
							/>
							<N8nButton
								:label="i18n.baseText('aon.agent.cancel')"
								variant="outline"
								:disabled="addingDeliverable"
								@click="cancelNewDeliverable"
							/>
						</div>
					</div>
				</div>
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

.form {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
	max-width: 640px;
}

.row {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--4xs);
}

.label {
	font-size: var(--font-size--2xs);
	font-weight: var(--font-weight--bold);
	color: var(--color--text--tint-1);
}

.hint {
	font-size: var(--font-size--3xs);
	color: var(--color--text--tint-1);
}

.formGrid {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
	gap: var(--spacing--sm);
}

.formActions {
	display: flex;
	align-items: center;
	gap: var(--spacing--xs);
}

.deliverableActions {
	display: flex;
	align-items: center;
	gap: var(--spacing--sm);
	margin-top: var(--spacing--3xs);
}

.toggle {
	display: flex;
	align-items: center;
	gap: var(--spacing--4xs);
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
}

.newDeliverable {
	margin-top: var(--spacing--sm);
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
