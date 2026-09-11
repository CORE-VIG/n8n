<script setup lang="ts">
import { useAonAssistantStore } from '../assistant/aonAssistant.store';

const assistant = useAonAssistantStore();
</script>

<template>
	<div :class="$style.home">
		<h1 :class="$style.title">Aon</h1>
		<p :class="$style.lede">
			Ask for a workflow and it is built here, as a draft, for you to read and publish. The
			assistant sits in the corner of every page; this is only its front door.
		</p>
		<button :class="$style.open" type="button" @click="assistant.open()">Open the assistant</button>
	</div>
</template>

<style lang="scss" module>
.home {
	max-width: 640px;
	margin: 0 auto;
	padding: var(--spacing--2xl) var(--spacing--lg);
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}
.title {
	font-size: var(--font-size--2xl);
	margin: 0;
}
.lede {
	color: var(--color--text--tint-1);
	margin: 0;
	max-width: 60ch;
}
.open {
	align-self: flex-start;
	margin-top: var(--spacing--sm);
	padding: var(--spacing--2xs) var(--spacing--sm);
	border-radius: var(--radius);
	border: none;
	cursor: pointer;
	background: var(--color--primary);
	color: var(--color--text--tint-3);
	font: inherit;
	font-weight: var(--font-weight--bold);
}
</style>
