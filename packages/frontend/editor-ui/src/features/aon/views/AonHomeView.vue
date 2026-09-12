<script setup lang="ts">
import { N8nButton } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';

import { useAonAssistantStore } from '../assistant/aonAssistant.store';
import AonNav from '../components/AonNav.vue';
import AonAgentsStrip from '../components/home/AonAgentsStrip.vue';
import AonConversations from '../components/home/AonConversations.vue';
import AonGuardPending from '../components/home/AonGuardPending.vue';
import AonLiveRuns from '../components/home/AonLiveRuns.vue';
import AonPartsStrip from '../components/home/AonPartsStrip.vue';
import AonSkyHero from '../components/home/AonSkyHero.vue';

const i18n = useI18n();
const assistant = useAonAssistantStore();
</script>

<template>
	<div :class="$style.page">
		<AonNav />
		<header :class="$style.head">
			<div>
				<h1 :class="$style.title">{{ i18n.baseText('aon.title') }}</h1>
				<p :class="$style.lede">{{ i18n.baseText('aon.home.lede') }}</p>
			</div>
			<N8nButton
				:label="i18n.baseText('aon.home.openAssistant')"
				size="large"
				data-test-id="aon-home-open-assistant"
				@click="assistant.open()"
			/>
		</header>

		<AonSkyHero />

		<AonPartsStrip />

		<div :class="$style.grid">
			<div :class="$style.column">
				<AonLiveRuns />
				<AonGuardPending />
			</div>
			<div :class="$style.column">
				<AonConversations />
				<AonAgentsStrip />
			</div>
		</div>
	</div>
</template>

<style lang="scss" module>
.page {
	max-width: 1080px;
	margin: 0 auto;
	padding: var(--spacing--2xl) var(--spacing--lg) var(--spacing--3xl);
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xl);
}

.head {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: var(--spacing--lg);
	flex-wrap: wrap;
}

.title {
	font-size: var(--font-size--2xl);
	margin: 0 0 var(--spacing--2xs);
	color: var(--color--text--shade-1);
}

.lede {
	color: var(--color--text--tint-1);
	margin: 0;
	max-width: 60ch;
}

.grid {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: var(--spacing--md);

	@media (max-width: 900px) {
		grid-template-columns: 1fr;
	}
}

.column {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--md);
	min-width: 0;
}
</style>
