<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { N8nAskAssistantButton, N8nAskAssistantChat } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { useUsersStore } from '@n8n/stores/users.store';

import { VIEWS } from '@/app/constants';
import { useAonAssistantStore } from './aonAssistant.store';
import { useAonTime } from '../useAonTime';

/**
 * The assistant as a messenger: a button in the corner of every page, and a
 * window over whatever he is doing. Not a route, not a side panel that
 * pushes the canvas around — a window he can leave open. "Conversations"
 * swaps the chat for a list of his saved threads; picking one, or "back",
 * swaps it back.
 */
const store = useAonAssistantStore();
const settings = useSettingsStore();
const users = useUsersStore();
const router = useRouter();
const i18n = useI18n();
const { ago } = useAonTime();

const available = computed(() => settings.isModuleActive('aon-core'));
const user = computed(() => {
	const u = users.currentUser;
	return u ? { firstName: u.firstName ?? '', lastName: u.lastName ?? '' } : undefined;
});

const onMessage = (text: string) => {
	void store.send(text);
};

const openWorkflow = async () => {
	if (!store.lastWorkflowId) return;
	await router.push({ name: VIEWS.WORKFLOW, params: { workflowId: store.lastWorkflowId } });
};

const toggleThreads = () => {
	store.listOpen = !store.listOpen;
	if (store.listOpen) void store.loadThreads();
};

const onNewThread = () => {
	void store.startNew();
};

const onOpenThread = (id: string) => {
	if (id === store.sessionId) {
		store.listOpen = false;
		return;
	}
	void store.openThread(id);
};

const onDeleteThread = (id: string) => {
	if (!window.confirm(`${i18n.baseText('aon.assistant.deleteConversation')}?`)) return;
	void store.removeThread(id);
};
</script>

<template>
	<div v-if="available" :class="$style.root">
		<div v-if="store.isOpen" :class="$style.window" data-test-id="aon-assistant-window">
			<div :class="$style.head">
				<span :class="$style.name">Aon</span>
				<button v-if="store.lastWorkflowId" :class="$style.link" type="button" @click="openWorkflow">Open the workflow</button>
				<button :class="$style.link" type="button" @click="toggleThreads">
					{{ i18n.baseText('aon.assistant.conversations') }}
				</button>
			</div>

			<div v-if="store.listOpen" :class="$style.listPanel" data-test-id="aon-assistant-threads">
				<div :class="$style.listToolbar">
					<button :class="$style.link" type="button" @click="toggleThreads">
						{{ i18n.baseText('aon.assistant.back') }}
					</button>
					<button
						:class="$style.link"
						type="button"
						data-test-id="aon-assistant-new-thread"
						@click="onNewThread"
					>
						{{ i18n.baseText('aon.assistant.newConversation') }}
					</button>
				</div>
				<p v-if="!store.loadingThreads && store.threads.length === 0" :class="$style.empty">
					{{ i18n.baseText('aon.assistant.noConversations') }}
				</p>
				<ul :class="$style.threadList">
					<li
						v-for="thread in store.threads"
						:key="thread.id"
						:class="[$style.threadRow, thread.id === store.sessionId && $style.threadRowActive]"
						data-test-id="aon-assistant-thread-row"
						@click="onOpenThread(thread.id)"
					>
						<div :class="$style.threadMain">
							<div :class="$style.threadTitle">
								{{ thread.title || i18n.baseText('aon.assistant.untitled') }}
							</div>
							<div :class="$style.threadMeta">{{ ago(thread.lastTurnAt ?? thread.createdAt) }}</div>
							<div v-if="thread.preview" :class="$style.threadPreview">{{ thread.preview }}</div>
						</div>
						<button
							:class="$style.deleteThread"
							type="button"
							:title="i18n.baseText('aon.assistant.deleteConversation')"
							:aria-label="i18n.baseText('aon.assistant.deleteConversation')"
							@click.stop="onDeleteThread(thread.id)"
						>
							×
						</button>
					</li>
				</ul>
			</div>
			<p v-else-if="store.loadingHistory" :class="$style.loadingHistory">
				{{ i18n.baseText('aon.assistant.loadingHistory') }}
			</p>
			<N8nAskAssistantChat
				v-else
				:class="$style.chat"
				:user="user"
				:messages="store.messages"
				:streaming="store.streaming"
				:session-id="store.sessionId"
				:scroll-on-new-message="true"
				input-placeholder="Ask for a workflow, a change, a test…"
				@close="store.close()"
				@message="onMessage"
			/>
		</div>
		<div v-else :class="$style.button" data-test-id="aon-assistant-button">
			<N8nAskAssistantButton :unread-count="store.unread" @click="store.open()" />
		</div>
	</div>
</template>

<style lang="scss" module>
.root {
	position: fixed;
	right: var(--spacing--md);
	bottom: var(--spacing--md);
	z-index: 1500;
}
.button {
	display: flex;
	justify-content: flex-end;
}
.window {
	width: min(420px, calc(100vw - 2 * var(--spacing--md)));
	height: min(640px, calc(100vh - 2 * var(--spacing--md)));
	display: flex;
	flex-direction: column;
	border-radius: var(--radius--lg);
	overflow: hidden;
	background: var(--color--background--light-3);
	box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35), 0 0 0 1px var(--color--foreground);
}
.head {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
	padding: var(--spacing--3xs) var(--spacing--xs);
	border-bottom: 1px solid var(--color--foreground);
	background: var(--color--background);
}
.name {
	font-weight: var(--font-weight--bold);
	margin-right: auto;
}
.link {
	background: none;
	border: none;
	cursor: pointer;
	color: var(--color--primary);
	font: inherit;
	font-size: var(--font-size--2xs);
	padding: var(--spacing--4xs) var(--spacing--3xs);
}
.chat {
	flex: 1;
	min-height: 0;
}
/* The chat component draws its own 65px header naming n8n's assistant;
   this window has a header of its own, so that one is collapsed. Collapsed,
   not removed: the component's root is a grid of three rows (auto 1fr auto)
   and a removed first child would shift the messages into the auto row and
   hand the input the 1fr — which is exactly what happened the first time. */
.chat > :first-child {
	height: 0;
	min-height: 0;
	padding: 0;
	border: 0;
	overflow: hidden;
	visibility: hidden;
}
.listPanel {
	flex: 1;
	min-height: 0;
	overflow-y: auto;
	padding: var(--spacing--xs);
	display: flex;
	flex-direction: column;
}
.listToolbar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	margin-bottom: var(--spacing--2xs);
}
.empty {
	color: var(--color--text--tint-1);
	font-size: var(--font-size--2xs);
	margin: var(--spacing--sm) 0;
}
.threadList {
	list-style: none;
	margin: 0;
	padding: 0;
	display: flex;
	flex-direction: column;
	gap: var(--spacing--4xs);
}
.threadRow {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: var(--spacing--3xs);
	padding: var(--spacing--3xs) var(--spacing--2xs);
	border-radius: var(--radius--xs);
	cursor: pointer;
}
.threadRowActive {
	background: var(--color--foreground--tint-1);
}
.threadMain {
	min-width: 0;
	flex: 1;
}
.threadTitle {
	font-size: var(--font-size--2xs);
	font-weight: var(--font-weight--medium);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.threadMeta,
.threadPreview {
	font-size: var(--font-size--3xs);
	color: var(--color--text--tint-1);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.deleteThread {
	background: none;
	border: none;
	cursor: pointer;
	color: var(--color--text--tint-1);
	font-size: var(--font-size--sm);
	line-height: 1;
	padding: var(--spacing--4xs);
	flex-shrink: 0;
}
.loadingHistory {
	flex: 1;
	display: flex;
	align-items: center;
	justify-content: center;
	color: var(--color--text--tint-1);
	font-size: var(--font-size--2xs);
	margin: 0;
}
</style>
