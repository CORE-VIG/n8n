<script setup lang="ts">
import type { AonThreadSummary } from '@n8n/api-types';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { onMounted, ref } from 'vue';

import { useAonAssistantStore } from '../../assistant/aonAssistant.store';
import { useAonTime } from '../../useAonTime';
import { listThreads } from '../../threads.api';

const SHOWN = 5;

const i18n = useI18n();
const rootStore = useRootStore();
const assistant = useAonAssistantStore();
const { ago } = useAonTime();

const threads = ref<AonThreadSummary[]>([]);
const error = ref<string | null>(null);

onMounted(async () => {
	try {
		threads.value = (await listThreads(rootStore.restApiContext)).slice(0, SHOWN);
	} catch (e) {
		error.value = (e as Error).message;
	}
});

/** Loads the conversation's turns before showing the window, so it never flashes the wrong thread. */
async function openConversation(id: string) {
	await assistant.openThread(id);
	assistant.open();
}
</script>

<template>
	<div :class="$style.card" data-test-id="aon-home-conversations">
		<div :class="$style.head">
			<h2 :class="$style.h2">{{ i18n.baseText('aon.home.conversations') }}</h2>
			<button type="button" :class="$style.more" @click="assistant.open()">
				{{ i18n.baseText('aon.home.seeAll') }}
			</button>
		</div>

		<p v-if="error" :class="$style.error">
			{{ i18n.baseText('aon.home.failed', { interpolate: { message: error } }) }}
		</p>
		<p v-else-if="threads.length === 0" :class="$style.empty">
			{{ i18n.baseText('aon.assistant.noConversations') }}
		</p>
		<ul v-else :class="$style.rows">
			<li v-for="thread in threads" :key="thread.id" :class="$style.row">
				<button type="button" :class="$style.rowMain" @click="openConversation(thread.id)">
					{{ thread.title ?? i18n.baseText('aon.assistant.untitled') }}
				</button>
				<span :class="$style.rowMeta">
					{{ i18n.baseText('aon.home.turns', { interpolate: { count: String(thread.turnCount) } }) }}
				</span>
				<span :class="$style.rowMeta">{{ ago(thread.lastTurnAt ?? thread.createdAt) }}</span>
			</li>
		</ul>
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
	cursor: pointer;

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

.rows {
	list-style: none;
	margin: 0;
	padding: 0;
	display: flex;
	flex-direction: column;
	gap: var(--spacing--3xs);
}

.row {
	display: flex;
	align-items: baseline;
	gap: var(--spacing--2xs);
	min-width: 0;
}

.rowMain {
	flex: 1 1 auto;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	text-align: left;
	color: var(--color--text--shade-1);
	background: none;
	border: none;
	padding: 0;
	font: inherit;
	cursor: pointer;

	&:hover {
		color: var(--color--primary);
	}
}

.rowMeta {
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
	white-space: nowrap;
}
</style>
