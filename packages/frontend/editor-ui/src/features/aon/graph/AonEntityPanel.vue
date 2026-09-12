<script setup lang="ts">
/**
 * The shared entity panel: what any of the three graphs open when a node is
 * selected, and what the entities list opens too. Name, kind, aliases,
 * summary, its facts as "subject — predicate — object" with a status badge
 * and a confirm/reject pair on the pending ones, and where it was mentioned.
 */
import type { AonEntityDetail, AonFactSummary } from '@n8n/api-types';
import { N8nBadge, N8nButton } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { ref } from 'vue';
import { RouterLink } from 'vue-router';

import { decideFact } from '../memory-graph.api';
import { AON_SOURCE_VIEW } from '../constants';
import { statusTheme } from '../status';
import { useAonTime } from '../useAonTime';

defineProps<{
	entity: AonEntityDetail | null;
	loading: boolean;
}>();

const emit = defineEmits<{ close: []; decided: [] }>();

const i18n = useI18n();
const rootStore = useRootStore();
const { ago } = useAonTime();

const decidingId = ref<string | null>(null);
const decideError = ref<string | null>(null);

async function decide(fact: AonFactSummary, status: 'confirmed' | 'rejected') {
	decidingId.value = fact.id;
	decideError.value = null;
	try {
		await decideFact(rootStore.restApiContext, fact.id, { status });
		emit('decided');
	} catch (e) {
		decideError.value = (e as Error).message;
	} finally {
		decidingId.value = null;
	}
}
</script>

<template>
	<div :class="$style.panel" data-test-id="aon-entity-panel">
		<p v-if="loading" :class="$style.hint">{{ i18n.baseText('aon.graph.loading') }}</p>
		<template v-else-if="entity">
			<header :class="$style.head">
				<div :class="$style.headTop">
					<h3 :class="$style.name">{{ entity.name }}</h3>
					<button type="button" :class="$style.close" @click="emit('close')">×</button>
				</div>
				<div :class="$style.badges">
					<N8nBadge theme="tertiary" size="small">{{ entity.kind }}</N8nBadge>
					<N8nBadge v-for="alias in entity.aliases" :key="alias" theme="default" size="small">
						{{ alias }}
					</N8nBadge>
				</div>
				<p v-if="entity.summary" :class="$style.summary">{{ entity.summary }}</p>
			</header>

			<section :class="$style.section">
				<h4 :class="$style.h4">
					{{ i18n.baseText('aon.entities.panel.facts', { interpolate: { count: String(entity.facts.length) } }) }}
				</h4>
				<p v-if="decideError" :class="$style.error">{{ decideError }}</p>
				<ul v-if="entity.facts.length > 0" :class="$style.facts">
					<li v-for="fact in entity.facts" :key="fact.id" :class="$style.fact">
						<div :class="$style.factLine">
							<span :class="$style.factSubject">{{ fact.subject }}</span>
							<span :class="$style.factPredicate">{{ fact.predicate }}</span>
							<span :class="$style.factObject">{{ fact.object }}</span>
							<N8nBadge :theme="statusTheme(fact.status)" size="small">{{ fact.status }}</N8nBadge>
						</div>
						<p v-if="fact.quote" :class="$style.factQuote">{{ fact.quote }}</p>
						<div v-if="fact.status === 'pending'" :class="$style.factActions">
							<N8nButton
								:label="i18n.baseText('aon.facts.confirm')"
								size="small"
								variant="outline"
								:loading="decidingId === fact.id"
								@click="decide(fact, 'confirmed')"
							/>
							<N8nButton
								:label="i18n.baseText('aon.facts.reject')"
								size="small"
								variant="outline"
								:loading="decidingId === fact.id"
								@click="decide(fact, 'rejected')"
							/>
						</div>
					</li>
				</ul>
				<p v-else :class="$style.hint">{{ i18n.baseText('aon.entities.panel.noFacts') }}</p>
			</section>

			<section :class="$style.section">
				<h4 :class="$style.h4">{{ i18n.baseText('aon.entities.panel.mentionedIn') }}</h4>
				<ul v-if="entity.mentionedIn.length > 0" :class="$style.mentions">
					<li v-for="m in entity.mentionedIn" :key="m.sourceId">
						<RouterLink :to="{ name: AON_SOURCE_VIEW, params: { id: m.sourceId } }" :class="$style.mentionLink">
							{{ m.title }}
						</RouterLink>
						<N8nBadge theme="tertiary" size="small">{{ m.origin }}</N8nBadge>
					</li>
				</ul>
				<p v-else :class="$style.hint">{{ i18n.baseText('aon.entities.panel.noMentions') }}</p>
			</section>

			<p :class="$style.since">
				{{ i18n.baseText('aon.entities.panel.since', { interpolate: { when: ago(entity.createdAt) } }) }}
			</p>
		</template>
		<p v-else :class="$style.hint">{{ i18n.baseText('aon.entities.panel.empty') }}</p>
	</div>
</template>

<style lang="scss" module>
.panel {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
	padding: var(--spacing--sm);
	border: var(--border);
	border-radius: var(--radius--lg);
	background: var(--color--background--light-3);
}

.head {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--3xs);
}

.headTop {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--spacing--2xs);
}

.name {
	margin: 0;
	font-size: var(--font-size--md);
	color: var(--color--text--shade-1);
}

.close {
	border: none;
	background: transparent;
	color: var(--color--text--tint-1);
	font-size: var(--font-size--md);
	line-height: 1;
	cursor: pointer;
	padding: var(--spacing--4xs);
}

.badges {
	display: flex;
	flex-wrap: wrap;
	gap: var(--spacing--4xs);
}

.summary {
	margin: 0;
	color: var(--color--text);
}

.section {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
}

.h4 {
	margin: 0;
	font-size: var(--font-size--2xs);
	text-transform: uppercase;
	letter-spacing: 0.08em;
	color: var(--color--text--tint-1);
}

.facts {
	list-style: none;
	margin: 0;
	padding: 0;
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
}

.fact {
	padding: var(--spacing--2xs);
	border: var(--border);
	border-radius: var(--radius);
	background: var(--color--background--base);
}

.factLine {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--spacing--4xs);
}

.factSubject {
	font-weight: var(--font-weight--bold);
	color: var(--color--text--shade-1);
}

.factPredicate {
	color: var(--color--text--tint-1);
	font-style: italic;
}

.factObject {
	font-weight: var(--font-weight--bold);
	color: var(--color--text--shade-1);
}

.factQuote {
	margin: var(--spacing--4xs) 0 0;
	color: var(--color--text--tint-1);
	font-size: var(--font-size--2xs);
	white-space: pre-wrap;
}

.factActions {
	display: flex;
	gap: var(--spacing--3xs);
	margin-top: var(--spacing--3xs);
}

.mentions {
	list-style: none;
	margin: 0;
	padding: 0;
	display: flex;
	flex-direction: column;
	gap: var(--spacing--3xs);

	li {
		display: flex;
		align-items: center;
		gap: var(--spacing--3xs);
	}
}

.mentionLink {
	color: var(--color--text--shade-1);
	font-weight: var(--font-weight--bold);
	text-decoration: none;

	&:hover {
		text-decoration: underline;
	}
}

.since {
	margin: 0;
	font-size: var(--font-size--3xs);
	color: var(--color--text--tint-1);
}

.hint {
	margin: 0;
	color: var(--color--text--tint-1);
}

.error {
	margin: 0;
	color: var(--color--danger);
}
</style>
