import type { AonThreadSummary } from '@n8n/api-types';
import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { streamRequest } from '@n8n/rest-api-client';
import { useRootStore } from '@n8n/stores/useRootStore';
import type { ChatUI } from '@n8n/design-system';

import { AON_DOING } from '../constants';
import { createThread, deleteThread, getThread, listThreads } from '../threads.api';

type Frame =
	| { type: 'session'; id: string | null }
	| { type: 'text'; delta: string }
	| { type: 'tool'; id: string; name: string; status: 'start' | 'ok' | 'error' }
	| { type: 'workflow'; id: string }
	| { type: 'cost'; usd: number; notional: boolean }
	| { type: 'done'; ms: number }
	| { type: 'error'; message: string };

const SESSION_KEY = 'aon.assistant.session';

function newSessionId() {
	return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function saveSessionId(id: string) {
	try {
		window.localStorage.setItem(SESSION_KEY, id);
	} catch {
		/* private mode */
	}
}

function loadSessionId(): string {
	try {
		const v = window.localStorage.getItem(SESSION_KEY);
		if (v) return v;
	} catch {
		/* private mode */
	}
	const id = newSessionId();
	saveSessionId(id);
	return id;
}

/** Tool names read as a row of words, not as identifiers. */
function toolWords(name: string, status: 'start' | 'ok' | 'error'): string {
	const words = AON_DOING[name];
	const plain = name.replace(/^mcp__n8n__/, '').replace(/_/g, ' ');
	if (status === 'error') return `${words?.done ?? plain} · did not work`;
	if (status === 'start') return `${words?.now ?? plain}…`;
	return words?.done ?? plain;
}

/**
 * The assistant window's state: one conversation per browser, kept across
 * reloads by its id, resumed on the server by the CLI's own session store.
 */
export const useAonAssistantStore = defineStore('aonAssistant', () => {
	const rootStore = useRootStore();

	const isOpen = ref(false);
	const streaming = ref(false);
	const unread = ref(0);
	const sessionId = ref<string>(loadSessionId());
	const messages = ref<ChatUI.AssistantMessage[]>([]);
	/** The last workflow it made or changed, so the window can open it. */
	const lastWorkflowId = ref<string | null>(null);
	/** The saved conversations, and whether the window is showing that list instead of the chat. */
	const threads = ref<AonThreadSummary[]>([]);
	const loadingThreads = ref(false);
	const loadingHistory = ref(false);
	const listOpen = ref(false);
	let seq = 0;
	const nextId = () => `aon-${Date.now()}-${seq++}`;

	const hasMessages = computed(() => messages.value.length > 0);

	function open() {
		isOpen.value = true;
		unread.value = 0;
		void restoreHistory();
	}
	function close() {
		isOpen.value = false;
	}
	function toggle() {
		if (isOpen.value) close();
		else open();
	}

	function push(m: ChatUI.AssistantMessage) {
		messages.value = [...messages.value, m];
	}

	async function loadThreads() {
		loadingThreads.value = true;
		try {
			threads.value = await listThreads(rootStore.restApiContext);
		} catch {
			threads.value = [];
		} finally {
			loadingThreads.value = false;
		}
	}

	/** Switches to a saved thread and rebuilds its messages the way `send` would have produced them. */
	async function openThread(id: string) {
		sessionId.value = id;
		saveSessionId(id);
		messages.value = [];
		lastWorkflowId.value = null;
		listOpen.value = false;
		loadingHistory.value = true;
		try {
			const detail = await getThread(rootStore.restApiContext, id);
			const rebuilt: ChatUI.AssistantMessage[] = [];
			for (const turn of detail.turns) {
				if (turn.role === 'user') {
					rebuilt.push({ id: nextId(), role: 'user', type: 'text', content: turn.text });
					continue;
				}
				for (const tool of turn.tools ?? []) {
					rebuilt.push({
						id: nextId(),
						role: 'assistant',
						type: 'block',
						title: toolWords(tool.name, tool.status),
						content: '',
					});
				}
				rebuilt.push({ id: nextId(), role: 'assistant', type: 'text', content: turn.text });
			}
			messages.value = rebuilt;
		} catch {
			// An id from before threads existed (404), or a transient failure:
			// start blank rather than block the window on it.
		} finally {
			loadingHistory.value = false;
		}
	}

	/** After a reload the window keeps its session id but not its messages; fetch them back once. */
	function restoreHistory() {
		if (messages.value.length > 0 || loadingHistory.value) return;
		return openThread(sessionId.value);
	}

	async function startNew() {
		messages.value = [];
		lastWorkflowId.value = null;
		let id: string;
		try {
			id = (await createThread(rootStore.restApiContext)).id;
		} catch {
			id = newSessionId();
		}
		sessionId.value = id;
		saveSessionId(id);
	}

	async function removeThread(id: string) {
		await deleteThread(rootStore.restApiContext, id);
		threads.value = threads.value.filter((t) => t.id !== id);
		if (sessionId.value === id) {
			await startNew();
		}
	}

	async function send(text: string) {
		const trimmed = text.trim();
		if (!trimmed || streaming.value) return;
		push({ id: nextId(), role: 'user', type: 'text', content: trimmed });
		streaming.value = true;

		let current: (ChatUI.TextMessage & { id: string }) | null = null;
		const toolRows = new Map<string, ChatUI.SummaryBlock & { id: string }>();

		const ensureText = () => {
			if (current) return current;
			current = { id: nextId(), role: 'assistant', type: 'text', content: '' };
			push(current);
			return current;
		};
		const replace = (id: string, next: ChatUI.AssistantMessage) => {
			messages.value = messages.value.map((m) => ((m as { id?: string }).id === id ? next : m));
		};

		await new Promise<void>((resolve) => {
			void streamRequest<Frame>(
				rootStore.restApiContext,
				'/aon/talk',
				{ sessionId: sessionId.value, text: trimmed },
				(frame) => {
					switch (frame.type) {
						case 'text': {
							const m = ensureText();
							const next = { ...m, content: m.content + frame.delta };
							current = next;
							replace(m.id, next);
							break;
						}
						case 'tool': {
							// A tool call is its own row so the answer text stays
							// the answer. A new row per call; the row updates on finish.
							const existing = toolRows.get(frame.id);
							const row: ChatUI.SummaryBlock & { id: string } = {
								id: existing?.id ?? nextId(),
								role: 'assistant',
								type: 'block',
								title: toolWords(frame.name, frame.status),
								content: '',
							};
							toolRows.set(frame.id, row);
							if (existing) replace(existing.id, row);
							else push(row);
							// The next text after a tool is a new bubble.
							current = null;
							break;
						}
						case 'workflow':
							lastWorkflowId.value = frame.id;
							break;
						case 'error':
							push({ id: nextId(), role: 'assistant', type: 'error', content: frame.message });
							break;
						default:
							break;
					}
				},
				() => resolve(),
				(e) => {
					push({ id: nextId(), role: 'assistant', type: 'error', content: e.message || 'the assistant could not be reached' });
					resolve();
				},
				'\n',
			);
		});

		streaming.value = false;
		if (!isOpen.value) unread.value += 1;
	}

	return {
		isOpen,
		streaming,
		unread,
		sessionId,
		messages,
		hasMessages,
		lastWorkflowId,
		threads,
		loadingThreads,
		loadingHistory,
		listOpen,
		open,
		close,
		toggle,
		send,
		startNew,
		loadThreads,
		openThread,
		removeThread,
		restoreHistory,
	};
});
