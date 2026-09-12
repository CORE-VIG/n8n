<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { N8nIcon } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';

import { getVoiceStatus, transcribeVoice } from '../voice.api';

/**
 * The mic: press to record, release to transcribe. Renders nothing until
 * `/aon/voice/status` says the sidecar is configured — a plain, expected
 * state on an instance that has never had one set up, not an error to
 * surface.
 *
 * The shared chat input (`N8nChatInput`, in `@n8n/design-system`) has no way
 * for a caller to set its text from outside — only `focusInput` is exposed.
 * So a transcribed clip is sent as a turn directly, the same as pressing
 * enter, rather than dropped into the input box unsent.
 */
const emit = defineEmits<{ transcribed: [string]; error: [string] }>();

const rootStore = useRootStore();
const i18n = useI18n();

const configured = ref(false);
const recording = ref(false);
const busy = ref(false);

let recorder: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let chunks: Blob[] = [];

onMounted(async () => {
	try {
		const status = await getVoiceStatus(rootStore.restApiContext);
		configured.value = status.configured;
	} catch {
		configured.value = false;
	}
});

function pickMimeType(): string {
	if (typeof MediaRecorder === 'undefined') return '';
	const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
	return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
}

function stopTracks() {
	stream?.getTracks().forEach((track) => {
		track.stop();
	});
	stream = null;
}

async function startRecording() {
	if (recording.value || busy.value) return;
	try {
		stream = await navigator.mediaDevices.getUserMedia({ audio: true });
	} catch {
		emit('error', i18n.baseText('aon.voice.micDenied'));
		return;
	}
	const mimeType = pickMimeType();
	recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
	chunks = [];
	recorder.ondataavailable = (event: BlobEvent) => {
		if (event.data.size > 0) chunks.push(event.data);
	};
	recorder.onstop = () => {
		const usedMimeType = recorder?.mimeType || mimeType || 'audio/webm';
		void onRecordingStopped(usedMimeType);
	};
	recorder.start();
	recording.value = true;
}

function stopRecording() {
	if (!recording.value) return;
	recording.value = false;
	recorder?.stop();
	stopTracks();
}

async function onRecordingStopped(mimeType: string) {
	const clip = chunks;
	chunks = [];
	if (clip.length === 0) return;
	busy.value = true;
	try {
		const blob = new Blob(clip, { type: mimeType });
		const extension = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'm4a' : 'webm';
		const { text } = await transcribeVoice(rootStore.restApiContext, blob, `clip.${extension}`);
		const trimmed = text.trim();
		if (trimmed) emit('transcribed', trimmed);
		else emit('error', i18n.baseText('aon.voice.heardNothing'));
	} catch (err) {
		emit('error', err instanceof Error ? err.message : i18n.baseText('aon.voice.transcribeFailed'));
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<button
		v-if="configured"
		type="button"
		:class="[$style.mic, recording && $style.recording]"
		:disabled="busy"
		:title="i18n.baseText('aon.voice.hold')"
		:aria-label="i18n.baseText('aon.voice.hold')"
		data-test-id="aon-voice-mic"
		@mousedown="startRecording"
		@mouseup="stopRecording"
		@mouseleave="recording && stopRecording()"
		@touchstart.prevent="startRecording"
		@touchend.prevent="stopRecording"
	>
		<N8nIcon :icon="busy ? 'loader-circle' : 'mic'" :spin="busy" size="small" />
	</button>
</template>

<style lang="scss" module>
.mic {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 26px;
	height: 26px;
	border-radius: var(--radius--md);
	border: 1px solid var(--color--foreground);
	background: transparent;
	color: var(--color--text--tint-1);
	cursor: pointer;
	padding: 0;
}
.recording {
	background: var(--color--danger--tint-2);
	border-color: var(--color--danger);
	color: var(--color--danger);
}
</style>
