<script setup lang="ts">
import type { AonWorkspaceSummary } from '@n8n/api-types';
import { N8nButton, N8nInput } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { onMounted, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';

import AonNav from '../components/AonNav.vue';
import { AON_WORKSPACE_VIEW } from '../constants';
import { createWorkspace, getWorkspaces } from '../hands.api';
import { useAonTime } from '../useAonTime';

const i18n = useI18n();
const rootStore = useRootStore();
const router = useRouter();
const { ago } = useAonTime();

const workspaces = ref<AonWorkspaceSummary[] | null>(null);
const error = ref<string | null>(null);
const notConfigured = ref(false);
const newSlug = ref('');
const creating = ref(false);

const isNotConfiguredMessage = (message: string) => message.toLowerCase().includes('not configured');

/** `catch` hands us `unknown`; this narrows without a cast. */
function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

async function load() {
	try {
		workspaces.value = await getWorkspaces(rootStore.restApiContext);
	} catch (e) {
		const message = errorMessage(e);
		if (isNotConfiguredMessage(message)) notConfigured.value = true;
		else error.value = message;
	}
}

onMounted(load);

async function create() {
	const slug = newSlug.value.trim().toLowerCase();
	if (!slug || creating.value) return;
	creating.value = true;
	error.value = null;
	try {
		const workspace = await createWorkspace(rootStore.restApiContext, slug);
		newSlug.value = '';
		await router.push({ name: AON_WORKSPACE_VIEW, params: { slug: workspace.slug } });
	} catch (e) {
		const message = errorMessage(e);
		if (isNotConfiguredMessage(message)) notConfigured.value = true;
		else error.value = message;
	} finally {
		creating.value = false;
	}
}
</script>

<template>
	<div :class="$style.page">
		<AonNav />
		<h1 :class="$style.title">{{ i18n.baseText('aon.hands.title') }}</h1>
		<p :class="$style.lede">{{ i18n.baseText('aon.hands.lede') }}</p>

		<p v-if="notConfigured" :class="$style.lede">{{ i18n.baseText('aon.hands.notConfigured') }}</p>

		<template v-else>
			<form :class="$style.newForm" @submit.prevent="create">
				<label :class="$style.formLabel">
					<span>{{ i18n.baseText('aon.hands.newWorkspace') }}</span>
					<N8nInput
						v-model="newSlug"
						:placeholder="i18n.baseText('aon.hands.newWorkspacePlaceholder')"
						data-test-id="aon-hands-new-slug"
					/>
				</label>
				<N8nButton
					:label="i18n.baseText('aon.hands.create')"
					:loading="creating"
					native-type="submit"
					data-test-id="aon-hands-create"
				/>
			</form>

			<p v-if="error" :class="$style.error">
				{{ i18n.baseText('aon.home.failed', { interpolate: { message: error } }) }}
			</p>
			<p v-else-if="workspaces && workspaces.length === 0" :class="$style.lede">
				{{ i18n.baseText('aon.hands.empty') }}
			</p>

			<div v-else-if="workspaces" :class="$style.tableWrap">
				<table :class="$style.table" data-test-id="aon-hands-table">
					<thead>
						<tr>
							<th>{{ i18n.baseText('aon.hands.column.name') }}</th>
							<th>{{ i18n.baseText('aon.hands.column.created') }}</th>
							<th>{{ i18n.baseText('aon.hands.column.lastUsed') }}</th>
						</tr>
					</thead>
					<tbody>
						<tr v-for="workspace in workspaces" :key="workspace.id">
							<td>
								<RouterLink
									:to="{ name: AON_WORKSPACE_VIEW, params: { slug: workspace.slug } }"
									:class="$style.name"
								>
									{{ workspace.slug }}
								</RouterLink>
							</td>
							<td :class="$style.when">{{ ago(workspace.createdAt) }}</td>
							<td :class="$style.when">{{ ago(workspace.lastUsedAt) }}</td>
						</tr>
					</tbody>
				</table>
			</div>
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

.newForm {
	display: flex;
	align-items: flex-end;
	gap: var(--spacing--xs);
	margin-bottom: var(--spacing--md);
}

.formLabel {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--3xs);
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
	min-width: 260px;
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

.name {
	font-weight: var(--font-weight--bold);
	color: var(--color--text--shade-1);
}

.when {
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
	white-space: nowrap;
}
</style>
