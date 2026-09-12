<script setup lang="ts">
import type { AonTurnTool } from '@n8n/api-types';
import { N8nIcon } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';

import { VIEWS } from '@/app/constants';
import { AON_DOING } from '../constants';
import {
	executionLinkFrom,
	formatToolResult,
	nodeOutputsFromResult,
	type AonToolNodeOutput,
} from './aon-tool-result';

/**
 * One tool call, as a compact card under the assistant's message: what it
 * did, whether it worked, how long it took, and — expanded — the input and
 * result themselves, so he can check the work instead of only his summary
 * of it. `test_workflow` and `get_workflow_execution` also get a per-node
 * breakdown, since their result is a whole execution, not a short answer.
 *
 * `tool` is nullable because it arrives through the chat's generic
 * `custom-message` slot, whose data is `unknown` by design; the caller
 * passes null when that data doesn't actually look like a tool call, and
 * this card simply renders nothing for it.
 */
const props = defineProps<{ tool: AonTurnTool | null }>();

const i18n = useI18n();
const router = useRouter();

const NODE_BREAKDOWN_TOOLS = new Set(['test_workflow', 'get_workflow_execution']);

interface ToolView {
	label: string;
	dotIcon: string;
	dotColor: string;
	isError: boolean;
	elapsedText: string | null;
	input: string | null;
	hasResult: boolean;
	formattedResult: string;
	nodeOutputs: AonToolNodeOutput[] | null;
	executionLink: { workflowId: string; executionId: string } | null;
	rawResult: string | null;
}

/**
 * Everything the template shows, built from one narrowed local — TypeScript
 * tracks a plain local variable's narrowing through a function body, which
 * is what lets every field below read `tool.*` without re-checking null.
 */
const view = computed<ToolView | null>(() => {
	const tool = props.tool;
	if (!tool) return null;

	const bareName = tool.name.replace(/^mcp__n8n__/, '');
	const doing = AON_DOING[tool.name];
	const plain = bareName.replace(/_/g, ' ');
	const label = tool.status === 'start' ? (doing?.now ?? plain) : (doing?.done ?? plain);

	const dotIcon = tool.status === 'start' ? 'loader-circle' : tool.status === 'error' ? 'circle-x' : 'circle-check';
	const dotColor = tool.status === 'start' ? 'text-light' : tool.status === 'error' ? 'danger' : 'success';

	const elapsedText = typeof tool.ms === 'number' ? i18n.baseText('aon.chat.elapsed', { interpolate: { ms: tool.ms } }) : null;

	const hasResult = typeof tool.result === 'string' && tool.result.length > 0;
	const isExecutionTool = NODE_BREAKDOWN_TOOLS.has(bareName);

	return {
		label,
		dotIcon,
		dotColor,
		isError: tool.isError === true,
		elapsedText,
		input: tool.input ?? null,
		hasResult,
		formattedResult: hasResult && tool.result ? formatToolResult(tool.result) : '',
		nodeOutputs: hasResult && tool.result && isExecutionTool ? nodeOutputsFromResult(tool.result) : null,
		executionLink:
			hasResult && tool.result && isExecutionTool ? executionLinkFrom(tool.result, tool.input) : null,
		rawResult: hasResult ? (tool.result ?? null) : null,
	};
});

// Error results open already expanded; everything else starts collapsed.
// Once he clicks, his own choice wins over that default from then on.
const manuallySet = ref(false);
const manuallyExpanded = ref(false);
const expanded = computed(() => (manuallySet.value ? manuallyExpanded.value : (view.value?.isError ?? false)));
function toggle() {
	if (!view.value?.hasResult) return;
	manuallySet.value = true;
	manuallyExpanded.value = !expanded.value;
}

const copied = ref(false);
let copiedTimer: number | null = null;
async function copyResult() {
	const result = view.value?.rawResult;
	if (!result) return;
	try {
		await navigator.clipboard.writeText(result);
	} catch {
		// Clipboard access denied; there is nothing more to do about it here.
		return;
	}
	copied.value = true;
	if (copiedTimer) window.clearTimeout(copiedTimer);
	copiedTimer = window.setTimeout(() => {
		copied.value = false;
	}, 1500);
}

function openExecution() {
	const link = view.value?.executionLink;
	if (!link) return;
	void router.push({
		name: VIEWS.EXECUTION_PREVIEW,
		params: { workflowId: link.workflowId, executionId: link.executionId },
	});
}
</script>

<template>
	<div v-if="view" :class="[$style.card, view.isError && $style.cardError]" data-test-id="aon-tool-card">
		<button
			:class="$style.head"
			type="button"
			:disabled="!view.hasResult"
			:aria-expanded="expanded"
			@click="toggle"
		>
			<N8nIcon :icon="view.dotIcon" size="small" :spin="view.dotIcon === 'loader-circle'" :color="view.dotColor" />
			<span :class="$style.label">{{ view.label }}</span>
			<span v-if="view.elapsedText" :class="$style.elapsed">{{ view.elapsedText }}</span>
			<N8nIcon v-if="view.hasResult" :icon="expanded ? 'chevron-down' : 'chevron-right'" size="small" />
		</button>
		<div v-if="expanded && view.hasResult" :class="$style.body">
			<div v-if="view.input" :class="$style.section">
				<div :class="$style.sectionTitle">{{ i18n.baseText('aon.chat.input') }}</div>
				<pre :class="$style.inputPre">{{ view.input }}</pre>
			</div>
			<div :class="$style.section">
				<div :class="$style.sectionTitle">
					<span>{{ i18n.baseText('aon.chat.result') }}</span>
					<button :class="$style.copy" type="button" @click="copyResult">
						{{ copied ? i18n.baseText('aon.chat.copied') : i18n.baseText('aon.chat.copy') }}
					</button>
				</div>
				<pre :class="$style.resultPre" data-test-id="aon-tool-result">{{ view.formattedResult }}</pre>
			</div>
			<div v-if="view.nodeOutputs" :class="$style.section">
				<div :class="$style.sectionTitle">{{ i18n.baseText('aon.chat.nodeOutputs') }}</div>
				<div v-for="node in view.nodeOutputs" :key="node.name" :class="$style.node">
					<div :class="$style.nodeHead">
						<span :class="$style.nodeName">{{ node.name }}</span>
						<span v-if="node.itemCount !== null" :class="$style.nodeItems">
							{{ i18n.baseText('aon.chat.nodeItems', { interpolate: { count: node.itemCount } }) }}
						</span>
					</div>
					<p v-if="node.errorMessage" :class="$style.nodeError">{{ node.errorMessage }}</p>
					<pre v-else-if="node.firstItem" :class="$style.nodeItem">{{ node.firstItem }}</pre>
				</div>
			</div>
			<button v-if="view.executionLink" :class="$style.openExecution" type="button" @click="openExecution">
				<N8nIcon icon="external-link" size="small" />
				{{ i18n.baseText('aon.chat.openExecution') }}
			</button>
		</div>
	</div>
</template>

<style lang="scss" module>
.card {
	border: 1px solid var(--color--foreground);
	border-radius: var(--radius--sm);
	background: var(--color--background--light-3);
	margin-bottom: var(--spacing--3xs);
	overflow: hidden;
}
.cardError {
	border-color: var(--color--danger--tint-3);
}
.head {
	display: flex;
	align-items: center;
	gap: var(--spacing--3xs);
	width: 100%;
	padding: var(--spacing--3xs) var(--spacing--2xs);
	background: none;
	border: none;
	cursor: pointer;
	font: inherit;
	text-align: left;

	&:disabled {
		cursor: default;
	}
}
.label {
	flex: 1;
	min-width: 0;
	font-size: var(--font-size--2xs);
	color: var(--color--text);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.elapsed {
	font-size: var(--font-size--3xs);
	color: var(--color--text--tint-1);
	flex-shrink: 0;
}
.body {
	border-top: 1px solid var(--color--foreground);
	padding: var(--spacing--2xs);
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
}
.section {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--4xs);
}
.sectionTitle {
	display: flex;
	align-items: center;
	justify-content: space-between;
	font-size: var(--font-size--3xs);
	font-weight: var(--font-weight--medium);
	color: var(--color--text--tint-1);
	text-transform: uppercase;
}
.copy {
	background: none;
	border: none;
	cursor: pointer;
	color: var(--color--primary);
	font: inherit;
	font-size: var(--font-size--3xs);
	text-transform: none;
	padding: 0;
}
.inputPre,
.resultPre,
.nodeItem {
	margin: 0;
	padding: var(--spacing--3xs);
	background: var(--color--background--light-2);
	border-radius: var(--radius--xs);
	font-family: var(--font-family--monospace);
	font-size: var(--font-size--3xs);
	white-space: pre-wrap;
	word-break: break-word;
	overflow-y: auto;
}
.inputPre {
	max-height: 120px;
}
.resultPre {
	max-height: 320px;
}
.node {
	padding: var(--spacing--3xs);
	background: var(--color--background--light-2);
	border-radius: var(--radius--xs);
}
.nodeHead {
	display: flex;
	align-items: baseline;
	gap: var(--spacing--3xs);
}
.nodeName {
	font-size: var(--font-size--2xs);
	font-weight: var(--font-weight--medium);
}
.nodeItems {
	font-size: var(--font-size--3xs);
	color: var(--color--text--tint-1);
}
.nodeError {
	margin: var(--spacing--4xs) 0 0;
	font-size: var(--font-size--3xs);
	color: var(--color--danger);
}
.nodeItem {
	margin-top: var(--spacing--4xs);
	max-height: 160px;
}
.openExecution {
	display: inline-flex;
	align-items: center;
	gap: var(--spacing--4xs);
	align-self: flex-start;
	background: none;
	border: none;
	cursor: pointer;
	color: var(--color--primary);
	font: inherit;
	font-size: var(--font-size--2xs);
	padding: 0;
}
</style>
