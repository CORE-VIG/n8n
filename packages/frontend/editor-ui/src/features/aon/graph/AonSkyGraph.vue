<script setup lang="ts">
/**
 * The Aon sky: memory as a constellation, ported from `/root/AON/lib/mem-sky.ts`
 * and `/root/AON/components/os/mem-sky.tsx`. All the layout arithmetic lives in
 * `sky-math.ts`; this walks what it returns and paints, in the same order the
 * original used — the faint web first, then the rings of stars outward, then
 * the closing ring and its knots on top — with the category labels and the
 * core disc as HTML overlays above the canvas, exactly as the original drew
 * them.
 *
 * Repaints only when the counts, the box, or the selected category change: a
 * sky that redrew on every render would flicker for no reason, and nothing
 * here animates.
 *
 * Reusable outside the graph tabs (the Home page embeds it too): it fetches
 * nothing itself, holds no selection state of its own, and never assumes it
 * is full-size — `compact` drops the category-label row and shrinks the
 * core disc for a small card.
 */
import type { AonMemorySky, AonMemorySkyCategory } from '@n8n/api-types';
import { useI18n } from '@n8n/i18n';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { type Cat, centre, labels, sky as buildSky } from './sky-math';

const props = withDefaults(
	defineProps<{
		sky: AonMemorySky | null;
		/** Optional: only the container fetching `/sky` needs to report this. */
		loading?: boolean;
		selected?: string | null;
		compact?: boolean;
	}>(),
	{ loading: false, selected: null, compact: false },
);

const emit = defineEmits<{ select: [name: string | null] }>();

const i18n = useI18n();

const host = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const box = ref({ w: 0, h: 0 });

/** Fixed per tab: the same seed always draws the same sky. */
const SEED = 42;

let ro: ResizeObserver | null = null;

onMounted(() => {
	const el = host.value;
	if (!el) return;
	ro = new ResizeObserver(([entry]) => {
		const r = entry.contentRect;
		const w = Math.round(r.width);
		const h = Math.round(r.height);
		if (Math.abs(box.value.w - w) < 2 && Math.abs(box.value.h - h) < 2) return;
		box.value = { w, h };
	});
	ro.observe(el);
});

onBeforeUnmount(() => {
	ro?.disconnect();
	ro = null;
});

/** origin = red family, kind = amber, entity = teal, fact = violet. */
function groupColor(group: AonMemorySkyCategory['group']): string {
	const style = typeof document !== 'undefined' ? getComputedStyle(document.body) : null;
	if (group === 'origin') return style?.getPropertyValue('--color--primary').trim() || '#e5484d';
	if (group === 'kind') return style?.getPropertyValue('--color--warning').trim() || '#f0a020';
	if (group === 'entity') return '#2dd4bf';
	return '#8b5cf6';
}

const cats = computed<Cat[]>(() => {
	if (!props.sky) return [];
	return props.sky.categories.map((c) => ({ name: c.name, n: c.count, color: groupColor(c.group) }));
});

const hasData = computed(() => cats.value.some((c) => c.n > 0));

const marks = computed(() => (box.value.w > 40 && box.value.h > 40 ? labels(cats.value, box.value) : []));

const centrePoint = computed(() => centre(box.value));

function draw() {
	const el = canvas.value;
	if (!el || box.value.w < 40 || box.value.h < 40) return;
	const { w, h } = box.value;
	const dpr = Math.min(window.devicePixelRatio || 1, 2);
	el.width = Math.round(w * dpr);
	el.height = Math.round(h * dpr);
	const ctx = el.getContext('2d');
	if (!ctx) return;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, w, h);

	const s = buildSky(cats.value, { w, h }, SEED);

	ctx.strokeStyle = 'rgba(150,150,150,.09)';
	ctx.lineWidth = 0.7;
	for (const l of s.chatter) {
		ctx.beginPath();
		ctx.moveTo(l.x1, l.y1);
		ctx.lineTo(l.x2, l.y2);
		ctx.stroke();
	}

	for (const d of s.dots) {
		const dim = props.selected !== null && props.selected !== undefined && !isOf(d.color, props.selected);
		ctx.globalAlpha = dim ? d.alpha * 0.18 : d.alpha;
		ctx.fillStyle = d.color;
		ctx.beginPath();
		ctx.arc(d.x, d.y, d.r, 0, 6.2832);
		ctx.fill();
	}
	ctx.globalAlpha = 1;

	ctx.strokeStyle = 'rgba(229,72,77,.3)';
	ctx.lineWidth = 1;
	ctx.beginPath();
	ctx.arc(s.ring.cx, s.ring.cy, s.ring.r, 0, 6.2832);
	ctx.stroke();

	for (const k of s.knots) {
		ctx.fillStyle = 'rgba(15,15,17,.9)';
		ctx.strokeStyle = 'rgba(255,138,141,.6)';
		ctx.beginPath();
		ctx.arc(k.x, k.y, 9, 0, 6.2832);
		ctx.fill();
		ctx.stroke();
		ctx.fillStyle = 'rgba(255,138,141,.85)';
		ctx.beginPath();
		ctx.arc(k.x, k.y, 2.2, 0, 6.2832);
		ctx.fill();
	}
}

function isOf(color: string, name: string): boolean {
	return cats.value.find((c) => c.name === name)?.color === color;
}

function togglePick(name: string) {
	emit('select', props.selected === name ? null : name);
}

const drawKey = computed(
	() => `${box.value.w}x${box.value.h}|${cats.value.map((c) => `${c.name}:${c.n}`).join(',')}|${props.selected ?? ''}`,
);
watch(drawKey, draw);
watch(box, draw, { deep: true });
</script>

<template>
	<div ref="host" :class="[$style.host, compact && $style.hostCompact]" @click="emit('select', null)">
		<canvas ref="canvas" data-test-id="aon-graph-canvas" :class="$style.canvas" />

		<div
			v-if="sky"
			:class="[$style.core, compact && $style.coreCompact]"
			:style="{ left: `${centrePoint.cx}px`, top: `${centrePoint.cy}px` }"
		>
			<span :class="$style.coreNum">{{ sky.core.toLocaleString() }}</span>
			<span :class="$style.coreSub">{{ i18n.baseText('aon.graph.coreSub') }}</span>
		</div>

		<template v-if="!compact">
			<button
				v-for="l in marks"
				:key="l.name"
				type="button"
				:class="[$style.label, selected === l.name && $style.labelOn]"
				:style="{ left: `${l.x}px`, top: `${l.y}px` }"
				@click.stop="togglePick(l.name)"
			>
				<span :class="$style.dot" :style="{ background: l.color }" />
				<span :class="$style.labelName" :style="{ color: l.color }">{{ l.name }}</span>
				<span :class="$style.labelCount">{{ l.n.toLocaleString() }}</span>
			</button>
		</template>

		<p v-if="!loading && !hasData" :class="$style.empty">{{ i18n.baseText('aon.graph.empty') }}</p>
		<p v-else-if="loading" :class="$style.empty">{{ i18n.baseText('aon.graph.loading') }}</p>
	</div>
</template>

<style lang="scss" module>
.host {
	position: relative;
	width: 100%;
	height: 100%;
	min-height: 420px;
	overflow: hidden;
	background: #0b0a0c;
	border-radius: var(--radius--lg);
}

.hostCompact {
	min-height: 160px;
}

.canvas {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
}

.core {
	position: absolute;
	transform: translate(-50%, -50%);
	width: 112px;
	height: 112px;
	border-radius: 50%;
	background: rgba(255, 255, 255, 0.07);
	backdrop-filter: blur(26px);
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: var(--spacing--4xs);
	box-shadow:
		inset 0 1px 0 rgba(255, 255, 255, 0.2),
		0 0 46px rgba(229, 72, 77, 0.24);
	pointer-events: none;
}

.coreCompact {
	width: 64px;
	height: 64px;
	backdrop-filter: blur(14px);
}

.coreCompact .coreNum {
	font-size: var(--font-size--xs);
}

.coreCompact .coreSub {
	font-size: 8px;
}

.coreNum {
	font-weight: var(--font-weight--bold);
	font-size: var(--font-size--md);
	color: #ff8a8d;
	letter-spacing: 0.04em;
}

.coreSub {
	font-size: var(--font-size--3xs);
	color: rgba(236, 238, 240, 0.5);
	letter-spacing: 0.12em;
	text-transform: uppercase;
}

.label {
	position: absolute;
	transform: translate(-50%, -50%);
	display: flex;
	align-items: center;
	gap: var(--spacing--4xs);
	padding: var(--spacing--4xs) var(--spacing--2xs);
	border-radius: var(--radius--full);
	background: rgba(20, 21, 23, 0.55);
	backdrop-filter: blur(14px);
	border: none;
	cursor: pointer;
	white-space: nowrap;
}

.labelOn {
	background: rgba(229, 72, 77, 0.24);
}

.dot {
	width: 7px;
	height: 7px;
	border-radius: 50%;
	flex: none;
}

.labelName {
	font-size: var(--font-size--3xs);
	font-weight: var(--font-weight--bold);
	letter-spacing: 0.1em;
	text-transform: uppercase;
}

.labelCount {
	font-size: var(--font-size--3xs);
	color: rgba(236, 238, 240, 0.5);
}

.empty {
	position: absolute;
	inset: 0;
	display: flex;
	align-items: center;
	justify-content: center;
	padding: var(--spacing--xl);
	text-align: center;
	color: rgba(236, 238, 240, 0.45);
	pointer-events: none;
}
</style>
