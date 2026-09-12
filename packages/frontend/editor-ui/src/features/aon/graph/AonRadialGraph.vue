<script setup lang="ts">
/**
 * The Aon wheel: memory as a radial graph, ported from
 * `/root/VIG-VICORE/components/console/graph/graph-canvas.tsx` and
 * `/root/VIG-VICORE/lib/console/graph-data.ts` into plain canvas 2D.
 *
 * Core at the centre; one hub per cluster, spaced evenly around it; each
 * cluster's entities sit on two rings around their hub, the ones with more
 * links nearer the hub. Edges are curved chords — core→hub faint, hub→item
 * per cluster, item→item inside a cluster brighter than the ones that cross
 * clusters. Hover dims everything outside the hovered node's neighbourhood
 * and shows a HUD line; a hub click focuses its cluster (dims the rest);
 * an item click selects it.
 */
import type { AonMemoryGraph } from '@n8n/api-types';
import { useI18n } from '@n8n/i18n';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps<{
	graph: AonMemoryGraph | null;
	loading: boolean;
}>();

const emit = defineEmits<{ select: [id: string] }>();

const i18n = useI18n();

const MAX_NODES = 400;
const PALETTE = [
	'#e5484d',
	'#f0a020',
	'#2dd4bf',
	'#8b5cf6',
	'#60a5fa',
	'#f472b6',
	'#a3e635',
	'#fb923c',
	'#38bdf8',
	'#c084fc',
];
function clusterColor(index: number): string {
	return PALETTE[index % PALETTE.length];
}
function hexA(hex: string, a: number): string {
	const h = hex.replace('#', '');
	const r = parseInt(h.substring(0, 2), 16);
	const g = parseInt(h.substring(2, 4), 16);
	const b = parseInt(h.substring(4, 6), 16);
	return `rgba(${r},${g},${b},${a})`;
}

type Kind = 'core' | 'hub' | 'item';
interface RNode {
	kind: Kind;
	id: string | null;
	label: string;
	cluster: number;
	r: number;
	x: number;
	y: number;
	adj: number[];
	sx: number;
	sy: number;
}
interface REdge {
	a: number;
	b: number;
	kind: 'coreHub' | 'hubItem' | 'intra' | 'cross';
	cluster: number;
}
interface Pulse {
	edge: number;
	t: number;
	speed: number;
}

function layout(graph: AonMemoryGraph): { nodes: RNode[]; edges: REdge[] } {
	const nodes: RNode[] = [{ kind: 'core', id: null, label: i18n.baseText('aon.graph.core'), cluster: -1, r: 12, x: 0, y: 0, adj: [], sx: 0, sy: 0 }];
	const edges: REdge[] = [];
	const N = Math.max(1, graph.clusters.length);
	const hubIndexByCluster = new Map<number, number>();

	graph.clusters.forEach((cl, i) => {
		const th = -Math.PI / 2 + i * ((Math.PI * 2) / N);
		const hx = Math.cos(th) * 0.42;
		const hy = Math.sin(th) * 0.42;
		const hubIdx = nodes.length;
		hubIndexByCluster.set(cl.index, hubIdx);
		nodes.push({ kind: 'hub', id: null, label: cl.kind, cluster: cl.index, r: 8, x: hx, y: hy, adj: [], sx: 0, sy: 0 });
		edges.push({ a: 0, b: hubIdx, kind: 'coreHub', cluster: cl.index });

		const items = graph.nodes.filter((n) => n.cluster === cl.index).slice(0, MAX_NODES);
		const degree = new Map<string, number>();
		for (const e of graph.edges) {
			degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
			degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
		}
		const ordered = [...items].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0));
		const M = Math.max(1, ordered.length);
		ordered.forEach((node, j) => {
			const a2 = th + j * ((Math.PI * 2) / M);
			const ring = j < M / 2 ? 0.14 : 0.24;
			const ix = hx + Math.cos(a2) * ring;
			const iy = hy + Math.sin(a2) * ring;
			const idx = nodes.length;
			nodes.push({
				kind: 'item',
				id: node.id,
				label: node.label,
				cluster: cl.index,
				r: 3.4 + Math.min(3, Math.sqrt(Math.max(0, node.weight))),
				x: ix,
				y: iy,
				adj: [],
				sx: 0,
				sy: 0,
			});
			edges.push({ a: hubIdx, b: idx, kind: 'hubItem', cluster: cl.index });
		});
	});

	const idIndex = new Map<string, number>();
	nodes.forEach((n, i) => {
		if (n.id) idIndex.set(n.id, i);
	});
	for (const e of graph.edges) {
		const a = idIndex.get(e.from);
		const b = idIndex.get(e.to);
		if (a === undefined || b === undefined || a === b) continue;
		const ca = nodes[a].cluster;
		const cb = nodes[b].cluster;
		edges.push({ a, b, kind: ca === cb ? 'intra' : 'cross', cluster: ca === cb ? ca : -1 });
	}
	edges.forEach((e, ei) => {
		nodes[e.a].adj.push(ei);
		nodes[e.b].adj.push(ei);
	});
	return { nodes, edges };
}

const host = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const box = ref({ w: 0, h: 0 });
const hoverIdx = ref<number | null>(null);
const focusCluster = ref<number | null>(null);
const selectedId = ref<string | null>(null);

let model = { nodes: [] as RNode[], edges: [] as REdge[] };
let pulses: Pulse[] = [];
let dpr = 1;
let raf = 0;
let running = false;
let hovering = false;
let ro: ResizeObserver | null = null;

function rebuild() {
	model = props.graph ? layout(props.graph) : { nodes: [], edges: [] };
	pulses = [];
	hoverIdx.value = null;
	focusCluster.value = null;
	selectedId.value = null;
}
watch(() => props.graph, rebuild, { immediate: true });

function toScreen(x: number, y: number, cx: number, cy: number, field: number) {
	return { x: cx + x * field, y: cy + y * field };
}

function draw() {
	const el = canvas.value;
	const ctx = el?.getContext('2d');
	if (!el || !ctx || box.value.w < 40 || box.value.h < 40) return;
	const { w, h } = box.value;
	const cx = w / 2;
	const cy = h / 2;
	const field = Math.min(w, h) * 0.42;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, w, h);

	for (const n of model.nodes) {
		const s = toScreen(n.x, n.y, cx, cy, field);
		n.sx = s.x;
		n.sy = s.y;
	}

	let neighbourEdges: Set<number> | null = null;
	let neighbourNodes: Set<number> | null = null;
	if (hoverIdx.value !== null) {
		const hn = model.nodes[hoverIdx.value];
		neighbourEdges = new Set(hn.adj);
		neighbourNodes = new Set([hoverIdx.value]);
		hn.adj.forEach((ei) => {
			const e = model.edges[ei];
			neighbourNodes?.add(e.a);
			neighbourNodes?.add(e.b);
		});
	}

	// pulses (only spawned while hovering the field)
	if (hovering && model.edges.length > 0 && pulses.length < 14 && Math.random() < 0.3) {
		pulses.push({ edge: Math.floor(Math.random() * model.edges.length), t: 0, speed: 0.01 + Math.random() * 0.01 });
	}
	pulses = pulses.filter((p) => {
		p.t += p.speed;
		return p.t < 1;
	});

	for (let ei = 0; ei < model.edges.length; ei++) {
		const e = model.edges[ei];
		const a = model.nodes[e.a];
		const b = model.nodes[e.b];
		const relevant = focusCluster.value === null || e.cluster === focusCluster.value;
		let alpha = e.kind === 'coreHub' ? 0.18 : e.kind === 'cross' ? 0.08 : 0.14;
		if (!relevant) alpha *= 0.15;
		let color = 'rgba(150,178,198,1)';
		if (e.cluster >= 0) color = clusterColor(e.cluster);
		if (neighbourEdges) {
			if (neighbourEdges.has(ei)) alpha = 0.8;
			else alpha *= 0.12;
		}
		ctx.strokeStyle = e.cluster >= 0 ? hexA(color, alpha) : `rgba(150,178,198,${alpha})`;
		ctx.lineWidth = neighbourEdges?.has(ei) ? 1.6 : 1;
		const mx = (a.sx + b.sx) / 2 + (b.sy - a.sy) * 0.12;
		const my = (a.sy + b.sy) / 2 - (b.sx - a.sx) * 0.12;
		ctx.beginPath();
		ctx.moveTo(a.sx, a.sy);
		ctx.quadraticCurveTo(mx, my, b.sx, b.sy);
		ctx.stroke();
	}

	for (const p of pulses) {
		const e = model.edges[p.edge];
		const a = model.nodes[e.a];
		const b = model.nodes[e.b];
		const x = a.sx + (b.sx - a.sx) * p.t;
		const y = a.sy + (b.sy - a.sy) * p.t;
		const color = e.cluster >= 0 ? clusterColor(e.cluster) : '#cfe6f2';
		ctx.save();
		ctx.shadowBlur = 8;
		ctx.shadowColor = color;
		ctx.fillStyle = color;
		ctx.beginPath();
		ctx.arc(x, y, 1.8, 0, Math.PI * 2);
		ctx.fill();
		ctx.restore();
	}

	ctx.textBaseline = 'middle';
	for (let ni = 0; ni < model.nodes.length; ni++) {
		const n = model.nodes[ni];
		const relevant = n.kind === 'core' || focusCluster.value === null || n.cluster === focusCluster.value;
		const inHood = neighbourNodes ? neighbourNodes.has(ni) : true;
		let alpha = relevant ? 1 : 0.2;
		if (neighbourNodes && !inHood) alpha *= 0.2;
		const color = n.kind === 'core' ? '#eef4f8' : clusterColor(n.cluster);
		ctx.globalAlpha = alpha;
		ctx.shadowBlur = ni === hoverIdx.value ? 10 : n.kind === 'hub' ? 6 : 2;
		ctx.shadowColor = color;
		ctx.fillStyle = color;
		ctx.beginPath();
		ctx.arc(n.sx, n.sy, n.r * (ni === hoverIdx.value ? 1.3 : 1) * (selectedId.value === n.id ? 1.4 : 1), 0, Math.PI * 2);
		ctx.fill();
		ctx.shadowBlur = 0;
		if (n.kind !== 'item' || ni === hoverIdx.value || inHood) {
			ctx.font = n.kind === 'core' ? '600 11px sans-serif' : n.kind === 'hub' ? '600 10px sans-serif' : '400 9.5px monospace';
			ctx.fillStyle = n.kind === 'item' ? '#aeb9c2' : color;
			ctx.textAlign = n.sx > cx ? 'left' : 'right';
			ctx.fillText(n.label, n.sx + (n.sx > cx ? n.r + 6 : -(n.r + 6)), n.sy);
		}
		ctx.globalAlpha = 1;
	}
}

function tick() {
	if (!running) return;
	draw();
	raf = requestAnimationFrame(tick);
}
function startLoop() {
	if (running) return;
	running = true;
	raf = requestAnimationFrame(tick);
}
function stopLoop() {
	running = false;
	if (raf) cancelAnimationFrame(raf);
	raf = 0;
}
function maybeRun() {
	// Animate only while hovering (pulses) or while a redraw is pending from
	// data/size changes; otherwise a single static draw is enough.
	if (hovering && document.visibilityState === 'visible') startLoop();
	else {
		stopLoop();
		draw();
	}
}

function sizeCanvas() {
	const el = canvas.value;
	if (!el) return;
	dpr = Math.min(window.devicePixelRatio || 1, 2);
	el.width = Math.round(box.value.w * dpr);
	el.height = Math.round(box.value.h * dpr);
	draw();
}

function hitTest(clientX: number, clientY: number): number | null {
	const el = canvas.value;
	if (!el) return null;
	const rect = el.getBoundingClientRect();
	const mx = clientX - rect.left;
	const my = clientY - rect.top;
	let best: number | null = null;
	let bestDist = 1e9;
	model.nodes.forEach((n, i) => {
		const d = Math.hypot(mx - n.sx, my - n.sy);
		if (d < n.r + 7 && d < bestDist) {
			bestDist = d;
			best = i;
		}
	});
	return best;
}

function onMove(ev: MouseEvent) {
	hovering = true;
	hoverIdx.value = hitTest(ev.clientX, ev.clientY);
	maybeRun();
}
function onLeave() {
	hovering = false;
	hoverIdx.value = null;
	maybeRun();
}
function onClick(ev: MouseEvent) {
	const idx = hitTest(ev.clientX, ev.clientY);
	if (idx === null) {
		focusCluster.value = null;
		draw();
		return;
	}
	const n = model.nodes[idx];
	if (n.kind === 'core') {
		focusCluster.value = null;
	} else if (n.kind === 'hub') {
		focusCluster.value = focusCluster.value === n.cluster ? null : n.cluster;
	} else if (n.id) {
		selectedId.value = n.id;
		emit('select', n.id);
	}
	draw();
}

function onVisibility() {
	maybeRun();
}

onMounted(() => {
	const el = host.value;
	if (!el) return;
	ro = new ResizeObserver(([entry]) => {
		const r = entry.contentRect;
		box.value = { w: Math.round(r.width), h: Math.round(r.height) };
		sizeCanvas();
	});
	ro.observe(el);
	document.addEventListener('visibilitychange', onVisibility);
});
onBeforeUnmount(() => {
	stopLoop();
	ro?.disconnect();
	ro = null;
	document.removeEventListener('visibilitychange', onVisibility);
});

watch(() => props.graph, () => sizeCanvas());

const hasData = computed(() => model.nodes.length > 1);
</script>

<template>
	<div ref="host" :class="$style.host">
		<canvas
			ref="canvas"
			data-test-id="aon-graph-canvas"
			:class="$style.canvas"
			@mousemove="onMove"
			@mouseleave="onLeave"
			@click="onClick"
		/>

		<button v-if="focusCluster !== null" type="button" :class="$style.reset" @click="focusCluster = null; draw()">
			{{ i18n.baseText('aon.graph.wholeGraph') }}
		</button>

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
	background: #0a0a0d;
	border-radius: var(--radius--lg);
	cursor: crosshair;
}

.canvas {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
}

.reset {
	position: absolute;
	top: var(--spacing--2xs);
	right: var(--spacing--2xs);
	font: inherit;
	font-size: var(--font-size--3xs);
	letter-spacing: 0.06em;
	padding: var(--spacing--4xs) var(--spacing--2xs);
	border-radius: var(--radius);
	border: none;
	background: rgba(10, 10, 12, 0.75);
	color: #eef4f8;
	cursor: pointer;
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
