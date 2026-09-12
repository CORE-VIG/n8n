<script setup lang="ts">
import type { AonCharterInput } from '@n8n/api-types';
import { useToast } from '@n8n/composables/useToast';
import { N8nButton, N8nInput, N8nOption, N8nSelect } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';

import { createAgent } from '../agents.api';
import AonNav from '../components/AonNav.vue';
import { AON_AGENT_VIEW } from '../constants';

const i18n = useI18n();
const rootStore = useRootStore();
const router = useRouter();
const { showError } = useToast();

const modelBands = ['fast', 'standard', 'deep'] as const;

const form = reactive({
	slug: '',
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

const creating = ref(false);

/** One item per line, blanks dropped. */
function lines(value: string): string[] {
	return value
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

function numberOrUndefined(value: string): number | undefined {
	const n = Number(value);
	return value.trim() !== '' && Number.isFinite(n) ? n : undefined;
}

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

async function submit() {
	if (creating.value) return;
	if (!/^[a-z0-9-]{2,40}$/.test(form.slug)) {
		showError(new Error(i18n.baseText('aon.agent.new.slugInvalid')), i18n.baseText('aon.agent.new.slugInvalid'));
		return;
	}
	if (!form.name.trim()) {
		showError(new Error(i18n.baseText('aon.agent.new.nameRequired')), i18n.baseText('aon.agent.new.nameRequired'));
		return;
	}
	creating.value = true;
	try {
		const charter: AonCharterInput = {
			purpose: form.purpose.trim() || undefined,
			owns: lines(form.owns),
			sources: lines(form.sources),
			do: lines(form.rulesDo),
			dont: lines(form.rulesDont),
			skills: lines(form.skills),
			tools: lines(form.tools),
			tierCeiling: numberOrUndefined(form.tierCeiling),
			breakerLimit: numberOrUndefined(form.breakerLimit),
			budgetEurMonth: numberOrUndefined(form.budgetEurMonth),
			modelBand: form.modelBand,
		};
		const agent = await createAgent(rootStore.restApiContext, {
			slug: form.slug.trim(),
			name: form.name.trim(),
			persona: form.persona.trim() || undefined,
			charter,
		});
		await router.push({ name: AON_AGENT_VIEW, params: { slug: agent.slug } });
	} catch (e) {
		showError(e, i18n.baseText('aon.home.failed', { interpolate: { message: errorMessage(e) } }));
	} finally {
		creating.value = false;
	}
}
</script>

<template>
	<div :class="$style.page">
		<AonNav />
		<h1 :class="$style.title">{{ i18n.baseText('aon.agent.new.title') }}</h1>
		<p :class="$style.lede">{{ i18n.baseText('aon.agent.new.lede') }}</p>

		<form :class="$style.form" data-test-id="aon-agent-new-form" @submit.prevent="submit">
			<div :class="$style.row">
				<label :class="$style.label" for="aon-new-slug">{{ i18n.baseText('aon.agent.new.slug') }}</label>
				<N8nInput id="aon-new-slug" v-model="form.slug" :placeholder="i18n.baseText('aon.agent.new.slugPlaceholder')" />
			</div>
			<div :class="$style.row">
				<label :class="$style.label" for="aon-new-name">{{ i18n.baseText('aon.agent.new.name') }}</label>
				<N8nInput id="aon-new-name" v-model="form.name" />
			</div>
			<div :class="$style.row">
				<label :class="$style.label" for="aon-new-persona">{{ i18n.baseText('aon.agent.persona') }}</label>
				<N8nInput id="aon-new-persona" v-model="form.persona" type="textarea" :rows="2" />
			</div>
			<div :class="$style.row">
				<label :class="$style.label" for="aon-new-purpose">{{ i18n.baseText('aon.agent.purpose') }}</label>
				<N8nInput id="aon-new-purpose" v-model="form.purpose" type="textarea" :rows="2" />
			</div>
			<div :class="$style.row">
				<label :class="$style.label" for="aon-new-owns">{{ i18n.baseText('aon.agent.owns') }}</label>
				<N8nInput
					id="aon-new-owns"
					v-model="form.owns"
					type="textarea"
					:rows="3"
					:placeholder="i18n.baseText('aon.agent.new.oneLine')"
				/>
			</div>
			<div :class="$style.row">
				<label :class="$style.label" for="aon-new-sources">{{ i18n.baseText('aon.agent.sources') }}</label>
				<N8nInput
					id="aon-new-sources"
					v-model="form.sources"
					type="textarea"
					:rows="3"
					:placeholder="i18n.baseText('aon.agent.new.oneLine')"
				/>
			</div>
			<div :class="$style.row">
				<label :class="$style.label" for="aon-new-do">{{ i18n.baseText('aon.agent.rulesDo') }}</label>
				<N8nInput
					id="aon-new-do"
					v-model="form.rulesDo"
					type="textarea"
					:rows="3"
					:placeholder="i18n.baseText('aon.agent.new.oneLine')"
				/>
			</div>
			<div :class="$style.row">
				<label :class="$style.label" for="aon-new-dont">{{ i18n.baseText('aon.agent.rulesDont') }}</label>
				<N8nInput
					id="aon-new-dont"
					v-model="form.rulesDont"
					type="textarea"
					:rows="3"
					:placeholder="i18n.baseText('aon.agent.new.oneLine')"
				/>
			</div>
			<div :class="$style.row">
				<label :class="$style.label" for="aon-new-skills">{{ i18n.baseText('aon.agent.skills') }}</label>
				<N8nInput
					id="aon-new-skills"
					v-model="form.skills"
					type="textarea"
					:rows="2"
					:placeholder="i18n.baseText('aon.agent.new.oneLine')"
				/>
			</div>
			<div :class="$style.row">
				<label :class="$style.label" for="aon-new-tools">{{ i18n.baseText('aon.agent.tools') }}</label>
				<N8nInput
					id="aon-new-tools"
					v-model="form.tools"
					type="textarea"
					:rows="2"
					:placeholder="i18n.baseText('aon.agent.new.oneLine')"
				/>
			</div>
			<div :class="$style.grid">
				<div :class="$style.row">
					<label :class="$style.label" for="aon-new-tier">{{ i18n.baseText('aon.agent.guard.tierCeiling') }}</label>
					<N8nInput id="aon-new-tier" v-model="form.tierCeiling" type="number" :min="0" :max="4" />
				</div>
				<div :class="$style.row">
					<label :class="$style.label" for="aon-new-breaker">{{ i18n.baseText('aon.agent.guard.breakerLimit') }}</label>
					<N8nInput id="aon-new-breaker" v-model="form.breakerLimit" type="number" :min="1" />
				</div>
				<div :class="$style.row">
					<label :class="$style.label" for="aon-new-budget">{{ i18n.baseText('aon.agent.guard.budgetEurMonth') }}</label>
					<N8nInput id="aon-new-budget" v-model="form.budgetEurMonth" type="number" :min="0" />
				</div>
				<div :class="$style.row">
					<label :class="$style.label" for="aon-new-band">{{ i18n.baseText('aon.agent.guard.modelBand') }}</label>
					<N8nSelect id="aon-new-band" v-model="form.modelBand">
						<N8nOption v-for="band in modelBands" :key="band" :value="band" :label="band" />
					</N8nSelect>
				</div>
			</div>

			<N8nButton
				type="primary"
				native-type="submit"
				:label="i18n.baseText('aon.agent.new.create')"
				:loading="creating"
				data-test-id="aon-agent-new-create"
			/>
		</form>
	</div>
</template>

<style lang="scss" module>
.page {
	max-width: 720px;
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

.form {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
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

.grid {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
	gap: var(--spacing--sm);
}
</style>
