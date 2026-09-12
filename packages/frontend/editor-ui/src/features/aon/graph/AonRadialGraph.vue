<script setup lang="ts">
/**
 * The Aon wheel: memory as a radial graph, ported from
 * `/root/VIG-VICORE/components/console/graph/graph-canvas.tsx` and
 * `/root/VIG-VICORE/lib/console/graph-data.ts` into plain canvas 2D.
 *
 * Core at the centre; one hub per cluster, on a ring sized off the canvas so
 * the layout fills it edge to edge; each cluster gets a sector of the circle
 * sized by its share of the nodes, and its items sit on up to three rings
 * inside that sector — closer rings for higher-degree items, clamped so a
 * cluster never spills into its neighbour's sector. Edges are curved chords
 * — core→hub faint, hub→item per cluster, item→item inside a cluster
 * brighter than the ones that cross clusters.
 *
 * With ~200 nodes on screen at once, labelling every node is unreadable, so
 * only the core, the cluster hubs, and the top-10 nodes by degree are always
 * labelled; everything else shows a label only on hover (the one node under
 * the cursor) or while its cluster is focused (up to 40 of that cluster's
 * nodes). Labels get a dark backing and a simple placed-box collision check
 * so two never overlap — hubs and the core always win that check.
 *
 * Hover dims everything outside the hovered node's neighbourhood and shows
 * its label; a hub click (or its legend entry) focuses its cluster (dims
 * the rest, expands its label budget); an item click selects it.
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

// -- layout constants -------------------------------------------------------
// Outer ring radius: leaves a ~10% margin around the layout for labels.
const OUTER_SCALE = 0.46;
// Cluster hubs sit on a ring at this fraction of the outer ring.
const HUB_FRAC = 0.42;
// Floor sector angle so a tiny cluster still gets a usable wedge, before
// every cluster's raw share is renormalised back to sum to a full circle.
const MIN_SECTOR = Math.PI * 2 * 0.03;
// Radians of clear space kept at each edge of a cluster's sector.
const SECTOR_PAD = 0.05;
// Radians between two items on the same ring — sets how many fit per ring.
const MIN_ITEM_ANGLE = 0.055;
const ITEM_R_MIN = 2.5;
const ITEM_R_MAX = 7;

// -- label constants ----------------------------------------------------
const TOP_DEGREE_LABELS = 10;
const MAX_FOCUS_LABELS = 40;

// -- edge constants -------------------------------------------------------
const EDGE_ALPHA_BASE = 0.25;
const EDGE_ALPHA_CROSS = 0.12;
const EDGE_ALPHA_HOVER = 0.9;
const EDGE_DIM_MULT = 0.15;

type Kind = 'core' | 'hub' | 'item';
interface RNode {
	kind: Kind;
	id: string | null;
	label: string;
	cluster: number;
	degree: number;
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
	const nodes: RNode[] = [
		{
			kind: 'core',
			id: null,
			label: i18n.baseText('aon.graph.core'),
			cluster: -1,
			degree: 0,
			r: 12,
			x: 0,
			y: 0,
			adj: [],
			sx: 0,
			sy: 0,
		},
	];
	const edges: REdge[] = [];

	// Real-relation degree — drives item radius, the top-10 label set, and
	// which items sit on the ring closest to their hub.
	const degree = new Map<string, number>();
	for (const e of graph.edges) {
		degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
		degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
	}

	const TWO_PI = Math.PI * 2;
	const totalCount = graph.clusters.reduce((s, c) => s + Math.max(1, c.count), 0) || Math.max(1, graph.clusters.length);
	const rawAngles = graph.clusters.map((c) => Math.max(MIN_SECTOR, (Math.max(1, c.count) / totalCount) * TWO_PI));
	const rawSum = rawAngles.reduce((s, a) => s + a, 0) || TWO_PI;
	// Renormalise so every cluster's sector — floor included — sums to a full circle.
	const sectorAngles = rawAngles.map((a) => (a / rawSum) * TWO_PI);

	let cursor = -Math.PI / 2;

	graph.clusters.forEach((cl, i) => {
		const sectorAngle = sectorAngles[i];
		const startAngle = cursor;
		const hubAngle = startAngle + sectorAngle / 2;
		cursor += sectorAngle;

		const hx = Math.cos(hubAngle) * HUB_FRAC;
		const hy = Math.sin(hubAngle) * HUB_FRAC;
		const hubIdx = nodes.length;
		nodes.push({
			kind: 'hub',
			id: null,
			label: `${cl.kind} · ${cl.count}`,
			cluster: cl.index,
			degree: cl.count,
			r: 8,
			x: hx,
			y: hy,
			adj: [],
			sx: 0,
			sy: 0,
		});
		edges.push({ a: 0, b: hubIdx, kind: 'coreHub', cluster: cl.index });

		const items = graph.nodes.filter((n) => n.cluster === cl.index).slice(0, MAX_NODES);
		const ordered = [...items].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0));
		const M = ordered.length;

		// Ring capacity from the sector's usable angle — items that don't fit
		// on ring 0 spill to ring 1, then ring 2 (overflow: still spread
		// evenly across the sector, just denser).
		const usable = Math.max(0, sectorAngle - SECTOR_PAD * 2);
		const cap = Math.max(1, Math.floor(usable / MIN_ITEM_ANGLE));
		const rings = [ordered.slice(0, cap), ordered.slice(cap, cap * 2), ordered.slice(cap * 2)];
		// Bigger clusters push their rings further out to use the extra room.
		const growth = Math.min(1, M / 50);
		const ringFracs = [0.3 + growth * 0.05, 0.58 + growth * 0.08, 0.9];

		rings.forEach((ringItems, ringIdx) => {
			const count = ringItems.length;
			if (count === 0) return;
			const radiusFrac = HUB_FRAC + (1 - HUB_FRAC) * ringFracs[ringIdx];
			ringItems.forEach((node, j) => {
				const t = (j + 0.5) / count;
				const angle = startAngle + SECTOR_PAD + t * usable;
				const ix = Math.cos(angle) * radiusFrac;
				const iy = Math.sin(angle) * radiusFrac;
				const idx = nodes.length;
				const deg = degree.get(node.id) ?? 0;
				nodes.push({
					kind: 'item',
					id: node.id,
					label: node.label,
					cluster: cl.index,
					degree: deg,
					r: Math.min(ITEM_R_MAX, Math.max(ITEM_R_MIN, ITEM_R_MIN + Math.sqrt(deg) * 1.4)),
					x: ix,
					y: iy,
					adj: [],
					sx: 0,
					sy: 0,
				});
				edges.push({ a: hubIdx, b: idx, kind: 'hubItem', cluster: cl.index });
			});
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
// The top-10-by-degree item nodes — recomputed only when the graph changes,
// not every frame.
let topDegreeIndices = new Set<number>();
let pulses: Pulse[] = [];
let dpr = 1;
let raf = 0;
let running = false;
let hovering = false;
let ro: ResizeObserver | null = null;
// The dark label backing colour — read once from the host's own computed
// background (the theme-driven equivalent of the sibling graphs' hardcoded
// dark canvas surface) so it always matches the canvas underneath it.
let labelBg = 'rgba(10,10,13,0.7)';

function resolveLabelBg() {
	const el = host.value;
	if (!el || typeof window === 'undefined') return;
	const bg = window.getComputedStyle(el).backgroundColor;
	const match = /rgba?\(([^)]+)\)/.exec(bg);
	if (!match) return;
	const parts = match[1].split(',').map((part) => Number.parseFloat(part.trim()));
	if (parts.length >= 3 && parts.every((part) => !Number.isNaN(part))) {
		labelBg = `rgba(${parts[0]},${parts[1]},${parts[2]},0.7)`;
	}
}

function rebuild() {
	model = props.graph ? layout(props.graph) : { nodes: [], edges: [] };
	topDegreeIndices = new Set(
		model.nodes
			.map((n, i) => ({ n, i }))
			.filter((entry) => entry.n.kind === 'item')
			.sort((a, b) => b.n.degree - a.n.degree)
			.slice(0, TOP_DEGREE_LABELS)
			.map((entry) => entry.i),
	);
	pulses = [];
	hoverIdx.value = null;
	focusCluster.value = null;
	selectedId.value = null;
}
watch(() => props.graph, rebuild, { immediate: true });

function toScreen(x: number, y: number, cx: number, cy: number, outer: number) {
	return { x: cx + x * outer, y: cy + y * outer };
}

// -- labels -----------------------------------------------------------------

interface LabelBox {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

function boxesOverlap(a: LabelBox, b: LabelBox): boolean {
	return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
	const rr = Math.min(r, w / 2, h / 2);
	ctx.beginPath();
	ctx.moveTo(x + rr, y);
	ctx.lineTo(x + w - rr, y);
	ctx.arcTo(x + w, y, x + w, y + rr, rr);
	ctx.lineTo(x + w, y + h - rr);
	ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
	ctx.lineTo(x + rr, y + h);
	ctx.arcTo(x, y + h, x, y + h - rr, rr);
	ctx.lineTo(x, y + rr);
	ctx.arcTo(x, y, x + rr, y, rr);
	ctx.closePath();
}

/**
 * Draws one label, anchored just past the node along the direction from the
 * centre through it (so a cluster's labels fan outward from its hub without
 * crossing). Skips the draw — and never reserves the box — unless
 * `mustPlace` or the box clears every previously placed one.
 */
function drawLabel(
	ctx: CanvasRenderingContext2D,
	placed: LabelBox[],
	node: RNode,
	font: string,
	textColor: string,
	alpha: number,
	mustPlace: boolean,
): void {
	const mag = Math.hypot(node.x, node.y);
	const dirX = mag > 0 ? node.x / mag : 0;
	const dirY = mag > 0 ? node.y / mag : 1;
	const gap = node.r + 8;
	const anchorX = node.sx + dirX * gap;
	const anchorY = node.sy + dirY * gap;
	const align: CanvasTextAlign = dirX >= 0 ? 'left' : 'right';

	ctx.font = font;
	const textW = ctx.measureText(node.label).width;
	const textH = 12;
	const boxPad = 3;
	const x0 = align === 'left' ? anchorX - boxPad : anchorX - textW - boxPad;
	const x1 = align === 'left' ? anchorX + textW + boxPad : anchorX + boxPad;
	const y0 = anchorY - textH / 2 - boxPad;
	const y1 = anchorY + textH / 2 + boxPad;
	const box: LabelBox = { x0, y0, x1, y1 };

	if (!mustPlace) {
		for (const p of placed) {
			if (boxesOverlap(box, p)) return;
		}
	}
	placed.push(box);

	ctx.globalAlpha = alpha;
	ctx.fillStyle = labelBg;
	roundedRect(ctx, x0, y0, x1 - x0, y1 - y0, 4);
	ctx.fill();
	ctx.fillStyle = textColor;
	ctx.textAlign = align;
	ctx.textBaseline = 'middle';
	ctx.fillText(node.label, anchorX, anchorY);
	ctx.globalAlpha = 1;
}

/**
 * Core and hubs always label. Beyond that: the hovered item (if any), the
 * top-10-by-degree items, and — while a cluster is focused — up to 40 more
 * of that cluster's items. Each of those is subject to the collision check.
 */
function drawLabels(ctx: CanvasRenderingContext2D) {
	const placed: LabelBox[] = [];

	const core = model.nodes[0];
	if (core) drawLabel(ctx, placed, core, '600 11px sans-serif', '#eef4f8', 1, true);

	for (const n of model.nodes) {
		if (n.kind !== 'hub') continue;
		const relevant = focusCluster.value === null || n.cluster === focusCluster.value;
		drawLabel(ctx, placed, n, '600 10px sans-serif', clusterColor(n.cluster), relevant ? 1 : 0.4, true);
	}

	const candidates: number[] = [];
	const seen = new Set<number>();
	const addCandidate = (idx: number) => {
		if (!seen.has(idx)) {
			seen.add(idx);
			candidates.push(idx);
		}
	};
	if (hoverIdx.value !== null && model.nodes[hoverIdx.value]?.kind === 'item') addCandidate(hoverIdx.value);
	for (const idx of topDegreeIndices) addCandidate(idx);
	if (focusCluster.value !== null) {
		const clusterItems = model.nodes
			.map((n, i) => ({ n, i }))
			.filter((entry) => entry.n.kind === 'item' && entry.n.cluster === focusCluster.value)
			.sort((a, b) => b.n.degree - a.n.degree)
			.slice(0, MAX_FOCUS_LABELS);
		for (const entry of clusterItems) addCandidate(entry.i);
	}

	for (const idx of candidates) {
		const n = model.nodes[idx];
		const relevant = focusCluster.value === null || n.cluster === focusCluster.value;
		const alpha = idx === hoverIdx.value ? 1 : relevant ? 0.85 : 0.25;
		drawLabel(ctx, placed, n, '400 9.5px monospace', '#aeb9c2', alpha, false);
	}
}

// -- draw ---------------------------------------------------------------

function draw() {
	const el = canvas.value;
	const ctx = el?.getContext('2d');
	if (!el || !ctx || box.value.w < 40 || box.value.h < 40) return;
	const { w, h } = box.value;
	const cx = w / 2;
	const cy = h / 2;
	const outer = Math.min(w, h) * OUTER_SCALE;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, w, h);

	for (const n of model.nodes) {
		const s = toScreen(n.x, n.y, cx, cy, outer);
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
		let alpha = e.kind === 'cross' ? EDGE_ALPHA_CROSS : EDGE_ALPHA_BASE;
		if (!relevant) alpha *= EDGE_DIM_MULT;
		let color = 'rgba(150,178,198,1)';
		if (e.cluster >= 0) color = clusterColor(e.cluster);
		if (neighbourEdges) {
			if (neighbourEdges.has(ei)) alpha = EDGE_ALPHA_HOVER;
			else alpha *= 0.12;
		}
		ctx.strokeStyle = e.cluster >= 0 ? hexA(color, alpha) : `rgba(150,178,198,${alpha})`;
		ctx.lineWidth = 1;
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
		ctx.globalAlpha = 1;
	}

	drawLabels(ctx);
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

/** Legend entry click — same effect as clicking that cluster's hub. */
function focusClusterFromLegend(index: number) {
	focusCluster.value = focusCluster.value === index ? null : index;
	draw();
}

function onVisibility() {
	maybeRun();
}

onMounted(() => {
	const el = host.value;
	if (!el) return;
	resolveLabelBg();
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

		<div v-if="graph && graph.clusters.length > 0" :class="$style.legend">
			<button
				v-for="cl in graph.clusters"
				:key="cl.index"
				type="button"
				:class="[$style.legendItem, focusCluster === cl.index && $style.legendOn]"
				@click="focusClusterFromLegend(cl.index)"
			>
				<span :class="$style.legendDot" :style="{ background: clusterColor(cl.index) }" />
				{{ cl.kind }}
			</button>
		</div>

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

.legend {
	position: absolute;
	left: var(--spacing--2xs);
	bottom: var(--spacing--2xs);
	display: flex;
	flex-wrap: wrap;
	gap: var(--spacing--4xs);
	max-width: calc(100% - var(--spacing--xl));
}

.legendItem {
	display: inline-flex;
	align-items: center;
	gap: var(--spacing--4xs);
	font: inherit;
	font-size: var(--font-size--3xs);
	padding: var(--spacing--4xs) var(--spacing--3xs);
	border: none;
	border-radius: var(--radius);
	background: rgba(10, 10, 12, 0.75);
	color: rgba(238, 244, 248, 0.75);
	cursor: pointer;
}

.legendOn {
	background: rgba(238, 244, 248, 0.18);
	color: #eef4f8;
}

.legendDot {
	width: 7px;
	height: 7px;
	border-radius: 50%;
	flex: none;
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
