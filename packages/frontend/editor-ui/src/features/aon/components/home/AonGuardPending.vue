<script setup lang="ts">
import type { AonGuardApproval } from '@n8n/api-types';
import { N8nButton } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { RouterLink } from 'vue-router';

import { AON_GUARD_VIEW, AON_RUN_VIEW } from '../../constants';
import { approve, deny, getGuardOverview } from '../../guard.api';
import { useAonTime } from '../../useAonTime';

const POLL_MS = 15_000;
const SHOWN = 5;

const i18n = useI18n();
const rootStore = useRootStore();
const { untilLabel } = useAonTime();

const pending = ref<AonGuardApproval[]>([]);
const opClassLabels = ref<Record<string, string>>({});
const error = ref<string | null>(null);
const busyId = ref<string | null>(null);

const shown = computed(() => pending.value.slice(0, SHOWN));

function opClassLabel(opClass: string): string {
	return opClassLabels.value[opClass] ?? opClass;
}

async function load() {
	try {
		const overview = await getGuardOverview(rootStore.restApiContext);
		pending.value = overview.pending;
		opClassLabels.value = Object.fromEntries(overview.opClasses.map((c) => [c.opClass, c.label]));
		error.value = null;
	} catch (e) {
		error.value = (e as Error).message;
	}
}

async function onApprove(id: string) {
	busyId.value = id;
	try {
		await approve(rootStore.restApiContext, id);
		await load();
	} catch (e) {
		error.value = (e as Error).message;
	} finally {
		busyId.value = null;
	}
}

async function onDeny(id: string) {
	busyId.value = id;
	try {
		await deny(rootStore.restApiContext, id);
		await load();
	} catch (e) {
		error.value = (e as Error).message;
	} finally {
		busyId.value = null;
	}
}

let pollTimer: ReturnType<typeof setInterval> | undefined;

onMounted(async () => {
	await load();
	pollTimer = setInterval(() => {
		if (document.visibilityState === 'visible') void load();
	}, POLL_MS);
});

onUnmounted(() => {
	if (pollTimer) clearInterval(pollTimer);
});
</script>

<template>
	<div :class="$style.card" data-test-id="aon-home-guard">
		<div :class="$style.head">
			<h2 :class="$style.h2">{{ i18n.baseText('aon.guard.pending') }}</h2>
			<RouterLink :to="{ name: AON_GUARD_VIEW }" :class="$style.more">
				{{ i18n.baseText('aon.home.seeAll') }}
			</RouterLink>
		</div>

		<p v-if="error" :class="$style.error">
			{{ i18n.baseText('aon.home.failed', { interpolate: { message: error } }) }}
		</p>
		<p v-else-if="shown.length === 0" :class="$style.empty">
			{{ i18n.baseText('aon.guard.noPending') }}
		</p>
		<div v-else :class="$style.cards">
			<article v-for="card in shown" :key="card.id" :class="$style.item">
				<p :class="$style.itemLine">
					{{ i18n.baseText('aon.guard.card.by', { interpolate: { identity: card.identity } }) }}
					{{ opClassLabel(card.opClass) }}
				</p>
				<p :class="$style.itemMeta">
					<RouterLink
						v-if="card.runId"
						:class="$style.link"
						:to="{ name: AON_RUN_VIEW, params: { id: card.runId } }"
					>
						{{ i18n.baseText('aon.guard.card.run', { interpolate: { id: card.runId } }) }}
					</RouterLink>
					<span>
						{{ i18n.baseText('aon.guard.card.expires', { interpolate: { when: untilLabel(card.expiresAt) } }) }}
					</span>
				</p>
				<div :class="$style.itemActions">
					<N8nButton
						size="small"
						:label="i18n.baseText('aon.guard.approve')"
						:disabled="busyId === card.id"
						data-test-id="aon-home-guard-approve"
						@click="onApprove(card.id)"
					/>
					<N8nButton
						size="small"
						type="tertiary"
						:label="i18n.baseText('aon.guard.deny')"
						:disabled="busyId === card.id"
						data-test-id="aon-home-guard-deny"
						@click="onDeny(card.id)"
					/>
				</div>
			</article>
		</div>
	</div>
</template>

<style lang="scss" module>
.card {
	padding: var(--spacing--sm) var(--spacing--md);
	border: var(--border);
	border-radius: var(--radius--lg);
	background: var(--color--background--light-3);
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xs);
}

.head {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	gap: var(--spacing--xs);
}

.h2 {
	font-size: var(--font-size--lg);
	margin: 0;
	color: var(--color--text--shade-1);
}

.more {
	font: inherit;
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
	background: none;
	border: none;
	padding: 0;
	text-decoration: none;

	&:hover {
		color: var(--color--primary);
		text-decoration: none;
	}
}

.error {
	margin: 0;
	color: var(--color--danger);
}

.empty {
	margin: 0;
	color: var(--color--text--tint-1);
}

.cards {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
}

.item {
	border: var(--border);
	border-radius: var(--radius);
	padding: var(--spacing--xs) var(--spacing--sm);
	display: flex;
	flex-direction: column;
	gap: var(--spacing--4xs);
}

.itemLine {
	margin: 0;
	color: var(--color--text--shade-1);
	font-weight: var(--font-weight--bold);
}

.itemMeta {
	margin: 0;
	display: flex;
	gap: var(--spacing--sm);
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
}

.itemActions {
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
</style>
