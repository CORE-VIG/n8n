<script setup lang="ts">
import type { AonHandsRunResult, AonWorkspaceFile, AonWorkspaceFileEntry } from '@n8n/api-types';
import { N8nButton, N8nIcon, N8nInput } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { computed, onMounted, ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import AonNav from '../components/AonNav.vue';
import { AON_HANDS_VIEW } from '../constants';
import { deleteWorkspace, getWorkspaceFile, getWorkspaceFiles, runInWorkspace } from '../hands.api';

/** Where every workspace's files live, as the sandbox sees it. */
const ROOT = '/home/user/workspace';

const i18n = useI18n();
const rootStore = useRootStore();
const route = useRoute();
const router = useRouter();

const slug = computed(() => String(route.params.slug ?? ''));

const currentPath = ref(ROOT);
const entries = ref<AonWorkspaceFileEntry[] | null>(null);
const missing = ref(false);
const error = ref<string | null>(null);

const openFile = ref<AonWorkspaceFile | null>(null);
const openFileError = ref<string | null>(null);

const command = ref('');
const network = ref(false);
const running = ref(false);
const runResult = ref<AonHandsRunResult | null>(null);
const runError = ref<string | null>(null);

const deleting = ref(false);

interface Crumb {
	label: string;
	path: string;
}

const crumbs = computed<Crumb[]>(() => {
	const rest = currentPath.value.slice(ROOT.length).split('/').filter(Boolean);
	const result: Crumb[] = [{ label: ROOT, path: ROOT }];
	let acc = ROOT;
	for (const part of rest) {
		acc = `${acc}/${part}`;
		result.push({ label: part, path: acc });
	}
	return result;
});

const canGoUp = computed(() => crumbs.value.length > 1);

/** `catch` hands us `unknown`; these narrow it without a cast. */
function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function httpStatusOf(e: unknown): number | undefined {
	if (typeof e === 'object' && e !== null && 'httpStatusCode' in e) {
		const value = e.httpStatusCode;
		return typeof value === 'number' ? value : undefined;
	}
	return undefined;
}

function childPath(name: string): string {
	return `${currentPath.value}/${name}`;
}

async function loadEntries(path: string) {
	try {
		entries.value = await getWorkspaceFiles(rootStore.restApiContext, slug.value, path);
		error.value = null;
	} catch (e) {
		if (httpStatusOf(e) === 404) missing.value = true;
		else error.value = errorMessage(e);
	}
}

async function navigate(path: string) {
	currentPath.value = path;
	openFile.value = null;
	openFileError.value = null;
	await loadEntries(path);
}

function goUp() {
	const parent = crumbs.value[crumbs.value.length - 2];
	if (parent) void navigate(parent.path);
}

async function openEntry(entry: AonWorkspaceFileEntry) {
	const path = childPath(entry.name);
	if (entry.type === 'directory') {
		await navigate(path);
		return;
	}
	openFileError.value = null;
	try {
		openFile.value = await getWorkspaceFile(rootStore.restApiContext, slug.value, path);
	} catch (e) {
		openFile.value = null;
		openFileError.value = errorMessage(e);
	}
}

async function run() {
	const cmd = command.value.trim();
	if (!cmd || running.value) return;
	running.value = true;
	runError.value = null;
	try {
		runResult.value = await runInWorkspace(rootStore.restApiContext, slug.value, {
			command: cmd,
			network: network.value,
		});
		await loadEntries(currentPath.value);
	} catch (e) {
		runResult.value = null;
		runError.value = errorMessage(e);
	} finally {
		running.value = false;
	}
}

async function remove() {
	if (deleting.value) return;
	if (!window.confirm(i18n.baseText('aon.workspace.deleteConfirm', { interpolate: { slug: slug.value } }))) {
		return;
	}
	deleting.value = true;
	try {
		await deleteWorkspace(rootStore.restApiContext, slug.value);
		await router.push({ name: AON_HANDS_VIEW });
	} catch (e) {
		error.value = errorMessage(e);
	} finally {
		deleting.value = false;
	}
}

onMounted(async () => {
	await loadEntries(ROOT);
});
</script>

<template>
	<div :class="$style.page">
		<AonNav />
		<RouterLink :to="{ name: AON_HANDS_VIEW }" :class="$style.back">
			{{ i18n.baseText('aon.workspace.back') }}
		</RouterLink>

		<p v-if="missing" :class="$style.lede">
			{{ i18n.baseText('aon.workspace.notFound', { interpolate: { slug } }) }}
		</p>

		<template v-else>
			<header :class="$style.head">
				<h1 :class="$style.title">{{ slug }}</h1>
				<N8nButton
					type="tertiary"
					size="small"
					:label="i18n.baseText('aon.workspace.delete')"
					:loading="deleting"
					@click="remove"
				/>
			</header>

			<p v-if="error" :class="$style.error">
				{{ i18n.baseText('aon.home.failed', { interpolate: { message: error } }) }}
			</p>

			<section :class="$style.section">
				<nav :class="$style.breadcrumb" aria-label="path">
					<template v-for="(crumb, i) in crumbs" :key="crumb.path">
						<span v-if="i > 0" :class="$style.crumbSep">/</span>
						<button
							v-if="i < crumbs.length - 1"
							type="button"
							:class="$style.crumb"
							@click="navigate(crumb.path)"
						>
							{{ crumb.label }}
						</button>
						<span v-else :class="$style.crumbCurrent">{{ crumb.label }}</span>
					</template>
					<button v-if="canGoUp" type="button" :class="$style.up" @click="goUp">
						{{ i18n.baseText('aon.workspace.up') }}
					</button>
				</nav>

				<ul
					v-if="entries && entries.length > 0"
					:class="$style.entries"
					data-test-id="aon-workspace-files"
				>
					<li v-for="entry in entries" :key="entry.name">
						<button type="button" :class="$style.entry" @click="openEntry(entry)">
							<N8nIcon :icon="entry.type === 'directory' ? 'folder' : 'file-text'" size="small" />
							<span :class="$style.entryName">{{ entry.name }}</span>
							<span v-if="entry.type === 'file' && entry.size !== null" :class="$style.entrySize">
								{{ entry.size }} B
							</span>
						</button>
					</li>
				</ul>
				<p v-else-if="entries" :class="$style.lede">{{ i18n.baseText('aon.workspace.emptyDir') }}</p>

				<section v-if="openFile" :class="$style.filePanel">
					<h2 :class="$style.h2">{{ i18n.baseText('aon.workspace.file') }}: {{ openFile.path }}</h2>
					<p v-if="openFile.truncated" :class="$style.hint">
						{{ i18n.baseText('aon.workspace.fileTruncated') }}
					</p>
					<pre :class="$style.pre">{{ openFile.text }}</pre>
				</section>
				<p v-if="openFileError" :class="$style.error">
					{{ i18n.baseText('aon.home.failed', { interpolate: { message: openFileError } }) }}
				</p>
			</section>

			<section :class="$style.section" data-test-id="aon-workspace-run">
				<h2 :class="$style.h2">{{ i18n.baseText('aon.workspace.run') }}</h2>
				<N8nInput
					v-model="command"
					type="textarea"
					:rows="4"
					:placeholder="i18n.baseText('aon.workspace.runPlaceholder')"
					data-test-id="aon-workspace-command"
				/>
				<label :class="$style.checkboxRow">
					<input v-model="network" type="checkbox" />
					<span>{{ i18n.baseText('aon.workspace.runNetwork') }}</span>
				</label>
				<div>
					<N8nButton
						:label="i18n.baseText('aon.workspace.runSubmit')"
						:loading="running"
						:disabled="!command.trim()"
						@click="run"
					/>
				</div>

				<p v-if="runError" :class="$style.error">
					{{ i18n.baseText('aon.home.failed', { interpolate: { message: runError } }) }}
				</p>

				<template v-if="runResult">
					<p :class="$style.hint">
						{{
							i18n.baseText('aon.workspace.runResult', {
								interpolate: {
									exitCode: String(runResult.exitCode),
									ms: String(runResult.executionTimeMs),
								},
							})
						}}
						<span v-if="runResult.timedOut"> · {{ i18n.baseText('aon.workspace.runTimedOut') }}</span>
					</p>
					<template v-if="runResult.stdout">
						<h3 :class="$style.h3">{{ i18n.baseText('aon.workspace.stdout') }}</h3>
						<pre :class="$style.pre">{{ runResult.stdout }}</pre>
					</template>
					<template v-if="runResult.stderr">
						<h3 :class="$style.h3">{{ i18n.baseText('aon.workspace.stderr') }}</h3>
						<pre :class="$style.pre">{{ runResult.stderr }}</pre>
					</template>
				</template>
			</section>
		</template>
	</div>
</template>

<style lang="scss" module>
.page {
	max-width: 960px;
	margin: 0 auto;
	padding: var(--spacing--2xl) var(--spacing--lg) var(--spacing--3xl);
	display: flex;
	flex-direction: column;
	gap: var(--spacing--md);
}

.back {
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
	align-self: flex-start;
}

.head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--spacing--xs);
	flex-wrap: wrap;
}

.title {
	font-size: var(--font-size--2xl);
	margin: 0;
	color: var(--color--text--shade-1);
	font-family: var(--font-family--monospace);
}

.h2 {
	font-size: var(--font-size--lg);
	margin: 0;
	color: var(--color--text--shade-1);
}

.h3 {
	font-size: var(--font-size--sm);
	font-weight: var(--font-weight--bold);
	margin: var(--spacing--xs) 0 var(--spacing--4xs);
	color: var(--color--text--tint-1);
}

.section {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
}

.lede {
	color: var(--color--text--tint-1);
	margin: 0;
}

.error {
	margin: 0;
	color: var(--color--danger);
}

.hint {
	margin: 0;
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
}

.breadcrumb {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: var(--spacing--4xs);
	font-size: var(--font-size--2xs);
}

.crumb {
	font: inherit;
	font-size: inherit;
	color: var(--color--text--tint-1);
	background: none;
	border: none;
	padding: 0;
	cursor: pointer;

	&:hover {
		color: var(--color--text--shade-1);
		text-decoration: underline;
	}
}

.crumbCurrent {
	color: var(--color--text--shade-1);
	font-weight: var(--font-weight--bold);
}

.crumbSep {
	color: var(--color--text--tint-1);
}

.up {
	font: inherit;
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
	background: none;
	border: var(--border);
	border-radius: var(--radius--sm);
	padding: var(--spacing--4xs) var(--spacing--2xs);
	margin-left: auto;
	cursor: pointer;

	&:hover {
		color: var(--color--text--shade-1);
	}
}

.entries {
	list-style: none;
	margin: 0;
	padding: 0;
	border: var(--border);
	border-radius: var(--radius--lg);
	background: var(--color--background--light-3);
	overflow: hidden;
}

.entry {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
	width: 100%;
	font: inherit;
	font-size: var(--font-size--sm);
	color: var(--color--text);
	background: none;
	border: none;
	border-bottom: var(--border);
	padding: var(--spacing--2xs) var(--spacing--sm);
	cursor: pointer;
	text-align: left;

	&:hover {
		background: var(--table--row--color--background--hover);
	}
}

li:last-child .entry {
	border-bottom: none;
}

.entryName {
	flex: 1 1 auto;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.entrySize {
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
	white-space: nowrap;
}

.filePanel {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--3xs);
	margin-top: var(--spacing--2xs);
}

.pre {
	margin: 0;
	padding: var(--spacing--sm);
	background: var(--color--background--light-3);
	border: var(--border);
	border-radius: var(--radius--lg);
	font-family: var(--font-family--monospace);
	font-size: var(--font-size--2xs);
	white-space: pre;
	overflow: auto;
	max-height: 400px;
}

.checkboxRow {
	display: flex;
	align-items: center;
	gap: var(--spacing--3xs);
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
	cursor: pointer;
	width: fit-content;
}
</style>
