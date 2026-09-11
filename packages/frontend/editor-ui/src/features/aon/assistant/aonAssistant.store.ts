import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { streamRequest } from '@n8n/rest-api-client';
import { useRootStore } from '@n8n/stores/useRootStore';
import type { ChatUI } from '@n8n/design-system';

import { AON_DOING } from '../constants';

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

function loadSessionId(): string {
	try {
		const v = window.localStorage.getItem(SESSION_KEY);
		if (v) return v;
	} catch {
		/* private mode */
	}
	const id = newSessionId();
	try {
		window.localStorage.setItem(SESSION_KEY, id);
	} catch {
		/* private mode */
	}
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
	let seq = 0;
	const nextId = () => `aon-${Date.now()}-${seq++}`;

	const hasMessages = computed(() => messages.value.length > 0);

	function open() {
		isOpen.value = true;
		unread.value = 0;
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

	function startNew() {
		messages.value = [];
		lastWorkflowId.value = null;
		sessionId.value = newSessionId();
		try {
			window.localStorage.setItem(SESSION_KEY, sessionId.value);
		} catch {
			/* private mode */
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

	return { isOpen, streaming, unread, sessionId, messages, hasMessages, lastWorkflowId, open, close, toggle, send, startNew };
});
