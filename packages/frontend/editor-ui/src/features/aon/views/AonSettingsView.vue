<script setup lang="ts">
import type { AonSettingsView as AonSettingsViewType, AonSkillInfo, AonToolboxList } from '@n8n/api-types';
import {
	N8nButton,
	N8nInput,
	N8nInputNumber,
	N8nOption,
	N8nRadioGroup,
	N8nRadioGroupItem,
	N8nSelect,
	N8nSwitch,
} from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { computed, onMounted, onUnmounted, ref } from 'vue';

import AonNav from '../components/AonNav.vue';
import { getSettings, setSkillEnabled, updateSettings } from '../settings.api';
import { getToolbox, rescanToolbox } from '../toolbox.api';

/** The three model bands offered here, whatever this instance happens to run on today. */
const MODEL_BANDS = [
	{ value: 'haiku', labelKey: 'aon.settings.model.haiku.label', noteKey: 'aon.settings.model.haiku.note' },
	{ value: 'sonnet', labelKey: 'aon.settings.model.sonnet.label', noteKey: 'aon.settings.model.sonnet.note' },
	{ value: 'opus', labelKey: 'aon.settings.model.opus.label', noteKey: 'aon.settings.model.opus.note' },
] as const;

const SAVED_FLASH_MS = 1500;

/** Kept in step with `GOOGLE_REQUIRED_SCOPES` in `aon-core/google/aon-google-auth.service.ts`. */
const GOOGLE_SCOPES =
	'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email';

const i18n = useI18n();
const rootStore = useRootStore();

const settings = ref<AonSettingsViewType | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const skillsError = ref<string | null>(null);

const persona = ref('');
const talkModel = ref('');
const budgetEurMonth = ref(0);
const localModel = ref('');
const localModelOptions = ref<string[]>([]);
const backgroundPaidEurMonth = ref(0);
const backgroundJobsPaused = ref(false);

const saving = ref(false);
const savedFlash = ref(false);
const busySkill = ref<string | null>(null);
const pausing = ref(false);
const pauseError = ref<string | null>(null);

const toolbox = ref<AonToolboxList | null>(null);
const toolboxError = ref<string | null>(null);
const toolboxRescanning = ref(false);

let savedTimer: ReturnType<typeof setTimeout> | undefined;

/** `catch` hands us `unknown`; this narrows without a cast. */
function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

async function load() {
	loading.value = true;
	try {
		const view = await getSettings(rootStore.restApiContext);
		settings.value = view;
		persona.value = view.persona;
		talkModel.value = view.talkModel;
		budgetEurMonth.value = view.budgetEurMonth;
		localModel.value = view.localModel;
		localModelOptions.value = view.localModelOptions;
		backgroundPaidEurMonth.value = view.backgroundPaidEurMonth;
		backgroundJobsPaused.value = view.backgroundJobsPaused;
		error.value = null;
	} catch (e) {
		error.value = errorMessage(e);
	} finally {
		loading.value = false;
	}
}

async function loadToolbox() {
	try {
		toolbox.value = await getToolbox(rootStore.restApiContext);
		toolboxError.value = null;
	} catch (e) {
		toolboxError.value = errorMessage(e);
	}
}

async function rescan() {
	if (toolboxRescanning.value) return;
	toolboxRescanning.value = true;
	try {
		await rescanToolbox(rootStore.restApiContext);
		await loadToolbox();
	} catch (e) {
		toolboxError.value = errorMessage(e);
	} finally {
		toolboxRescanning.value = false;
	}
}

onMounted(load);
onMounted(loadToolbox);
onUnmounted(() => {
	if (savedTimer) clearTimeout(savedTimer);
});

function flashSaved() {
	savedFlash.value = true;
	if (savedTimer) clearTimeout(savedTimer);
	savedTimer = setTimeout(() => {
		savedFlash.value = false;
	}, SAVED_FLASH_MS);
}

async function save() {
	if (saving.value) return;
	saving.value = true;
	error.value = null;
	try {
		const updated = await updateSettings(rootStore.restApiContext, {
			persona: persona.value,
			talkModel: talkModel.value,
			budgetEurMonth: budgetEurMonth.value,
			localModel: localModel.value,
			backgroundPaidEurMonth: backgroundPaidEurMonth.value,
		});
		settings.value = updated;
		localModelOptions.value = updated.localModelOptions;
		flashSaved();
	} catch (e) {
		error.value = errorMessage(e);
	} finally {
		saving.value = false;
	}
}

/** The pause switch applies at once: it is a kill switch, not something the owner should have to remember to also press Save for. */
async function togglePaused() {
	if (pausing.value) return;
	const next = !backgroundJobsPaused.value;
	pausing.value = true;
	pauseError.value = null;
	try {
		const updated = await updateSettings(rootStore.restApiContext, { backgroundJobsPaused: next });
		settings.value = updated;
		backgroundJobsPaused.value = updated.backgroundJobsPaused;
	} catch (e) {
		pauseError.value = errorMessage(e);
	} finally {
		pausing.value = false;
	}
}

async function toggleSkill(skill: AonSkillInfo) {
	if (busySkill.value) return;
	busySkill.value = skill.name;
	skillsError.value = null;
	try {
		const updated = await setSkillEnabled(rootStore.restApiContext, skill.name, !skill.enabled);
		if (settings.value) {
			settings.value = {
				...settings.value,
				skills: settings.value.skills.map((s) => (s.name === updated.name ? updated : s)),
			};
		}
	} catch (e) {
		skillsError.value = errorMessage(e);
	} finally {
		busySkill.value = null;
	}
}

const skills = computed(() => settings.value?.skills ?? []);
const parts = computed(() => settings.value?.parts ?? null);
const toolboxItems = computed(() => toolbox.value?.items ?? []);
</script>

<template>
	<div :class="$style.page">
		<AonNav />
		<h1 :class="$style.title">{{ i18n.baseText('aon.settings.title') }}</h1>
		<p :class="$style.lede">{{ i18n.baseText('aon.settings.lede') }}</p>

		<p v-if="loading" :class="$style.lede">{{ i18n.baseText('aon.settings.loading') }}</p>
		<p v-else-if="!settings" :class="$style.error">
			{{ i18n.baseText('aon.settings.failed', { interpolate: { message: error ?? '' } }) }}
		</p>

		<template v-else>
			<div :class="$style.pauseRow" data-test-id="aon-settings-pause">
				<N8nSwitch
					data-test-id="aon-settings-pause-switch"
					:model-value="backgroundJobsPaused"
					:disabled="pausing"
					:label="i18n.baseText('aon.settings.background.paused')"
					@update:model-value="togglePaused"
				/>
				<span v-if="pauseError" :class="$style.error">
					{{ i18n.baseText('aon.settings.saveFailed', { interpolate: { message: pauseError } }) }}
				</span>
				<span v-else :class="$style.hint">{{ i18n.baseText('aon.settings.background.pausedLede') }}</span>
			</div>
			<section :class="$style.section" data-test-id="aon-settings-form">
				<h2 :class="$style.h2">{{ i18n.baseText('aon.settings.persona.title') }}</h2>
				<p :class="$style.lede">{{ i18n.baseText('aon.settings.persona.lede') }}</p>
				<N8nInput
					v-model="persona"
					type="textarea"
					:autosize="{ minRows: 3, maxRows: 10 }"
					:class="$style.fullWidth"
					data-test-id="aon-settings-persona"
				/>

				<h2 :class="$style.h2">{{ i18n.baseText('aon.settings.model.title') }}</h2>
				<N8nRadioGroup v-model="talkModel" orientation="vertical" data-test-id="aon-settings-model">
					<N8nRadioGroupItem
						v-for="band in MODEL_BANDS"
						:key="band.value"
						:value="band.value"
						:label="i18n.baseText(band.labelKey)"
						:description="i18n.baseText(band.noteKey)"
					/>
				</N8nRadioGroup>

				<h2 :class="$style.h2">{{ i18n.baseText('aon.settings.budget.title') }}</h2>
				<p :class="$style.lede">{{ i18n.baseText('aon.settings.budget.lede') }}</p>
				<N8nInputNumber
					:model-value="budgetEurMonth"
					:min="0"
					:max="1000"
					:precision="0"
					:controls="false"
					data-test-id="aon-settings-budget"
					@update:model-value="(v) => (budgetEurMonth = v ?? 0)"
				/>

				<h2 :class="$style.h2">{{ i18n.baseText('aon.settings.background.title') }}</h2>
				<p :class="$style.lede">{{ i18n.baseText('aon.settings.background.lede') }}</p>

				<p :class="$style.fieldLabel">{{ i18n.baseText('aon.settings.background.localModel') }}</p>
				<p :class="$style.hint">{{ i18n.baseText('aon.settings.background.localModelLede') }}</p>
				<N8nSelect
					v-if="localModelOptions.length > 0"
					:model-value="localModel"
					data-test-id="aon-settings-local-model"
					@update:model-value="(v) => (localModel = v ?? localModel)"
				>
					<N8nOption v-for="option in localModelOptions" :key="option" :value="option" :label="option" />
				</N8nSelect>
				<p v-else :class="$style.hint">{{ i18n.baseText('aon.settings.background.localModelEmpty') }}</p>

				<p :class="$style.fieldLabel">{{ i18n.baseText('aon.settings.background.paidBudget') }}</p>
				<p :class="$style.hint">{{ i18n.baseText('aon.settings.background.paidBudgetLede') }}</p>
				<N8nInputNumber
					:model-value="backgroundPaidEurMonth"
					:min="0"
					:max="100"
					:precision="0"
					:controls="false"
					data-test-id="aon-settings-background-budget"
					@update:model-value="(v) => (backgroundPaidEurMonth = v ?? 0)"
				/>

				<div :class="$style.saveRow">
					<N8nButton
						:label="i18n.baseText('aon.settings.save')"
						:loading="saving"
						data-test-id="aon-settings-save"
						@click="save"
					/>
					<span v-if="savedFlash" :class="$style.saved">{{ i18n.baseText('aon.settings.saved') }}</span>
					<span v-else-if="error" :class="$style.error">
						{{ i18n.baseText('aon.settings.saveFailed', { interpolate: { message: error } }) }}
					</span>
				</div>
			</section>

			<section :class="$style.section" data-test-id="aon-settings-skills">
				<h2 :class="$style.h2">{{ i18n.baseText('aon.settings.skills.title') }}</h2>
				<p :class="$style.lede">{{ i18n.baseText('aon.settings.skills.lede') }}</p>

				<p v-if="skillsError" :class="$style.error">
					{{ i18n.baseText('aon.settings.skills.failed', { interpolate: { message: skillsError } }) }}
				</p>
				<p v-if="skills.length === 0" :class="$style.lede">{{ i18n.baseText('aon.settings.skills.empty') }}</p>

				<ul v-else :class="$style.skillList">
					<li v-for="skill in skills" :key="skill.name" :class="$style.skillRow">
						<div :class="$style.skillInfo">
							<div :class="$style.skillName">
								{{ skill.name }}
								<span v-if="skill.builtIn" :class="$style.badge">{{ i18n.baseText('aon.settings.skills.builtIn') }}</span>
								<span :class="[$style.badge, skill.enabled ? $style.badgeOn : undefined]">
									{{ skill.enabled ? i18n.baseText('aon.settings.skills.on') : i18n.baseText('aon.settings.skills.off') }}
								</span>
							</div>
							<p :class="$style.skillDescription">{{ skill.description }}</p>
						</div>
						<N8nButton
							size="small"
							:variant="skill.enabled ? 'outline' : 'solid'"
							:label="
								skill.enabled
									? i18n.baseText('aon.settings.skills.disable')
									: i18n.baseText('aon.settings.skills.enable')
							"
							:loading="busySkill === skill.name"
							data-test-id="aon-settings-skill-toggle"
							@click="toggleSkill(skill)"
						/>
					</li>
				</ul>
			</section>

			<section :class="$style.section" data-test-id="aon-settings-toolbox">
				<h2 :class="$style.h2">{{ i18n.baseText('aon.settings.toolbox.title') }}</h2>
				<p :class="$style.lede">{{ i18n.baseText('aon.settings.toolbox.lede') }}</p>

				<p v-if="toolboxError" :class="$style.error">
					{{ i18n.baseText('aon.settings.toolbox.failed', { interpolate: { message: toolboxError } }) }}
				</p>
				<p v-if="toolbox && toolboxItems.length === 0" :class="$style.lede">
					{{ i18n.baseText('aon.settings.toolbox.empty') }}
				</p>

				<ul v-else-if="toolboxItems.length > 0" :class="$style.skillList">
					<li v-for="item in toolboxItems" :key="item.slug" :class="$style.skillRow">
						<div :class="$style.skillInfo">
							<div :class="$style.skillName">
								{{ item.name }}
								<span :class="$style.badge">{{ item.kind }}</span>
								<span v-if="item.away" :class="$style.badge">
									{{ i18n.baseText('aon.settings.toolbox.missing') }}
								</span>
								<span v-if="item.uses > 0" :class="$style.badge">
									{{ i18n.baseText('aon.settings.toolbox.uses', { interpolate: { count: String(item.uses) } }) }}
								</span>
							</div>
							<p :class="$style.skillDescription">{{ item.summary }}</p>
						</div>
					</li>
				</ul>

				<div :class="$style.saveRow">
					<N8nButton
						size="small"
						variant="outline"
						:label="i18n.baseText('aon.settings.toolbox.rescan')"
						:loading="toolboxRescanning"
						data-test-id="aon-settings-toolbox-rescan"
						@click="rescan"
					/>
				</div>
			</section>

			<section v-if="parts" :class="$style.section" data-test-id="aon-settings-parts">
				<h2 :class="$style.h2">{{ i18n.baseText('aon.settings.parts.title') }}</h2>
				<ul :class="$style.partsList">
					<li>
						{{
							parts.assistant.signedIn
								? i18n.baseText('aon.settings.parts.assistant.signedIn', {
										interpolate: { model: parts.assistant.model },
									})
								: i18n.baseText('aon.settings.parts.assistant.notSignedIn')
						}}
					</li>
					<li>
						{{
							parts.telegram.linked
								? i18n.baseText('aon.settings.parts.telegram.linked', {
										interpolate: { count: String(parts.telegram.chatCount) },
									})
								: i18n.baseText('aon.settings.parts.telegram.notLinked')
						}}
					</li>
					<li>
						{{
							parts.hands.configured
								? i18n.baseText('aon.settings.parts.hands.ready')
								: i18n.baseText('aon.settings.parts.hands.notConfigured')
						}}
					</li>
					<li>
						{{
							parts.memory.ollamaHost
								? i18n.baseText('aon.settings.parts.memory.configured', {
										interpolate: { embedModel: parts.memory.embedModel, host: parts.memory.ollamaHost },
									})
								: i18n.baseText('aon.settings.parts.memory.notConfigured')
						}}
					</li>
					<li>
						{{
							parts.executor.running
								? i18n.baseText('aon.settings.parts.executor.running')
								: i18n.baseText('aon.settings.parts.executor.off')
						}}
					</li>
					<li>
						{{
							i18n.baseText('aon.settings.parts.guard', {
								interpolate: { tier: String(parts.guard.tierCeilingDefault) },
							})
						}}
					</li>
					<li>
						{{
							i18n.baseText(
								parts.models.localAvailable ? 'aon.settings.parts.models.available' : 'aon.settings.parts.models.unavailable',
								{
									interpolate: {
										model: parts.models.localModel,
										budget: String(parts.models.backgroundPaidEurMonth),
										spent: parts.models.backgroundPaidSpentEur.toFixed(2),
									},
								},
							)
						}}
					</li>
					<li>
						{{
							parts.google.configured
								? i18n.baseText('aon.settings.parts.google.connected', {
										interpolate: { email: parts.google.email ?? parts.google.credentialName ?? '' },
									})
								: i18n.baseText('aon.settings.parts.google.notConnected', {
										interpolate: { scopes: GOOGLE_SCOPES },
									})
						}}
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

.hint {
	margin: 0;
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
}

.fieldLabel {
	margin: var(--spacing--2xs) 0 0;
	font-weight: var(--font-weight--bold);
	color: var(--color--text--shade-1);
}

.pauseRow {
	display: flex;
	align-items: center;
	gap: var(--spacing--sm);
	flex-wrap: wrap;
	padding: var(--spacing--sm) var(--spacing--md);
	border: var(--border);
	border-radius: var(--radius--lg);
	background: var(--color--background--light-3);
	margin-bottom: var(--spacing--sm);
}

.section {
	margin-top: var(--spacing--lg);
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xs);
}

.h2 {
	font-size: var(--font-size--lg);
	margin: var(--spacing--sm) 0 0;
	color: var(--color--text--shade-1);

	&:first-child {
		margin-top: 0;
	}
}

.fullWidth {
	width: 100%;
}

.saveRow {
	display: flex;
	align-items: center;
	gap: var(--spacing--xs);
	margin-top: var(--spacing--2xs);
}

.saved {
	font-size: var(--font-size--2xs);
	color: var(--color--success);
}

.skillList {
	list-style: none;
	margin: 0;
	padding: 0;
	display: flex;
	flex-direction: column;
	gap: var(--spacing--3xs);
}

.skillRow {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--spacing--md);
	width: 100%;
	border: var(--border);
	border-radius: var(--radius--lg);
	background: var(--color--background--light-3);
	padding: var(--spacing--sm) var(--spacing--md);
}

.skillInfo {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--4xs);
	min-width: 0;
}

.skillName {
	font-weight: var(--font-weight--bold);
	color: var(--color--text--shade-1);
	display: flex;
	align-items: center;
	gap: var(--spacing--3xs);
}

.badge {
	font-size: var(--font-size--3xs);
	font-weight: var(--font-weight--regular);
	color: var(--color--text--tint-1);
	border: var(--border);
	border-radius: var(--radius--sm);
	padding: 0 var(--spacing--3xs);
}

.badgeOn {
	color: var(--color--success);
	border-color: var(--color--success);
}

.skillDescription {
	margin: 0;
	color: var(--color--text--tint-1);
	font-size: var(--font-size--2xs);
}

.partsList {
	list-style: none;
	margin: 0;
	padding: 0;
	display: flex;
	flex-direction: column;
	gap: var(--spacing--3xs);
	color: var(--color--text);
	font-size: var(--font-size--sm);
}
</style>
