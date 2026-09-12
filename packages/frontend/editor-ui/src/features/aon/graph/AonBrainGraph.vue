<script setup lang="ts">
/**
 * The Aon brain: memory as a volume, ported from `/root/VIG-VICORE/app/mission-control/mc-brain.tsx`
 * (three.js) into plain canvas 2D — no WebGL, no library, the arithmetic
 * written out by hand.
 *
 * Nodes sit inside an ellipsoid (semi-axes ~1.0, 0.75, 0.9) split into two
 * lobes along x; each cluster ("kind") gets an anchor point on that surface
 * and its nodes jitter around it. A faint wireframe shell (latitude and
 * longitude curves of the same ellipsoid) gives the volume its shape; a soft
 * mist glows behind each cluster's members; curved links bulge outward
 * between connected nodes; a few pulses travel along them; the whole thing
 * turns slowly around y. Projection is a simple perspective divide — nearer
 * points land bigger and brighter and are painted last.
 */
import type { AonMemoryGraph } from '@n8n/api-types';
import type { BaseTextKey } from '@n8n/i18n';
import { useI18n } from '@n8n/i18n';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps<{
	graph: AonMemoryGraph | null;
	loading: boolean;
}>();

const emit = defineEmits<{ select: [id: string] }>();

const i18n = useI18n();

const MAX_NODES = 400;
const A = 1.0;
const B = 0.75;
const C = 0.9;
const FOCAL = 3.2;
const FIELD = 220;
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

/** mulberry32: deterministic so the same graph always lays out the same way. */
function makeRng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface Pt3 {
	x: number;
	y: number;
	z: number;
}

interface BNode {
	id: string;
	label: string;
	cluster: number;
	weight: number;
	x: number;
	y: number;
	z: number;
	r: number;
	adj: number[];
	sx: number;
	sy: number;
	sz: number;
	sr: number;
	salpha: number;
}

interface BEdge {
	a: number;
	b: number;
	cluster: number;
	cross: boolean;
	ctrl: Pt3;
}

interface Pulse {
	edge: number;
	t: number;
	speed: number;
}

/** A point on the ellipsoid's surface for polar angle phi, azimuth theta. */
function ellipsoidPoint(phi: number, theta: number): Pt3 {
	return {
		x: A * Math.sin(phi) * Math.cos(theta),
		y: B * Math.cos(phi),
		z: C * Math.sin(phi) * Math.sin(theta),
	};
}

/** One anchor per cluster: alternating lobes along x, spread by index. */
function clusterAnchor(index: number, count: number): Pt3 {
	const lobe = index % 2 === 0 ? -1 : 1;
	const within = Math.floor(index / 2);
	const groups = Math.max(1, Math.ceil(count / 2));
	const t = groups > 1 ? within / (groups - 1) : 0.5;
	const phi = Math.PI * (0.22 + t * 0.56);
	const theta = lobe * (Math.PI / 2) + t * Math.PI * 1.6 - Math.PI * 0.8;
	const p = ellipsoidPoint(phi, theta);
	return { x: p.x * 0.66, y: p.y * 0.66, z: p.z * 0.66 };
}

function insideEllipsoid(p: Pt3): boolean {
	return (p.x / A) ** 2 + (p.y / B) ** 2 + (p.z / C) ** 2 <= 1;
}

function layout(graph: AonMemoryGraph): { nodes: BNode[]; edges: BEdge[] } {
	const rng = makeRng(20260912);
	const clusterCount = Math.max(1, graph.clusters.length);
	const anchors = graph.clusters.map((_, i) => clusterAnchor(i, clusterCount));
	const source = graph.nodes.slice(0, MAX_NODES);

	const nodes: BNode[] = source.map((n) => {
		const anchor = anchors[n.cluster] ?? { x: 0, y: 0, z: 0 };
		let p: Pt3 = anchor;
		for (let tries = 0; tries < 24; tries++) {
			const gauss = (rng() + rng() + rng() - 1.5) * 0.5;
			const gauss2 = (rng() + rng() + rng() - 1.5) * 0.5;
			const gauss3 = (rng() + rng() + rng() - 1.5) * 0.5;
			const candidate = {
				x: anchor.x + gauss * 0.3,
				y: anchor.y + gauss2 * 0.26,
				z: anchor.z + gauss3 * 0.3,
			};
			if (insideEllipsoid(candidate)) {
				p = candidate;
				break;
			}
			p = candidate;
		}
		return {
			id: n.id,
			label: n.label,
			cluster: n.cluster,
			weight: n.weight,
			x: p.x,
			y: p.y,
			z: p.z,
			r: 2.6 + Math.min(4, Math.sqrt(Math.max(0, n.weight))) * 1.1,
			adj: [],
			sx: 0,
			sy: 0,
			sz: 0,
			sr: 0,
			salpha: 0,
		};
	});

	const idIndex = new Map<string, number>();
	nodes.forEach((n, i) => idIndex.set(n.id, i));

	const edges: BEdge[] = [];
	for (const e of graph.edges) {
		const a = idIndex.get(e.from);
		const b = idIndex.get(e.to);
		if (a === undefined || b === undefined || a === b) continue;
		const A_ = nodes[a];
		const B_ = nodes[b];
		const mx = (A_.x + B_.x) / 2;
		const my = (A_.y + B_.y) / 2;
		const mz = (A_.z + B_.z) / 2;
		const bulge = 1.22;
		const ei = edges.length;
		edges.push({
			a,
			b,
			cluster: A_.cluster === B_.cluster ? A_.cluster : -1,
			cross: A_.cluster !== B_.cluster,
			ctrl: { x: mx * bulge, y: my * bulge, z: mz * bulge },
		});
		A_.adj.push(ei);
		B_.adj.push(ei);
	}

	return { nodes, edges };
}

// -- component state ---------------------------------------------------

const host = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const box = ref({ w: 0, h: 0 });
const look = ref<'organic' | 'wireframe'>('organic');
const interact = ref<'cluster' | 'node'>('cluster');
const hoverIdx = ref<number | null>(null);
const hoverCluster = ref<number | null>(null);
const selectedId = ref<string | null>(null);
const hoverLabel = ref<string | null>(null);

let model = { nodes: [] as BNode[], edges: [] as BEdge[] };
let shell: Pt3[][] = [];
let pulses: Pulse[] = [];
let angle = 0.6;
let dpr = 1;
let raf = 0;
let running = false;
let ro: ResizeObserver | null = null;

function buildShell(): Pt3[][] {
	const curves: Pt3[][] = [];
	const LAT = 6;
	const LON = 12;
	for (let i = 1; i <= LAT; i++) {
		const phi = (Math.PI * i) / (LAT + 1);
		const curve: Pt3[] = [];
		for (let j = 0; j <= 40; j++) curve.push(ellipsoidPoint(phi, (j / 40) * Math.PI * 2));
		curves.push(curve);
	}
	for (let i = 0; i < LON; i++) {
		const theta = (Math.PI * 2 * i) / LON;
		const curve: Pt3[] = [];
		for (let j = 0; j <= 24; j++) curve.push(ellipsoidPoint((j / 24) * Math.PI, theta));
		curves.push(curve);
	}
	return curves;
}

function rebuild() {
	if (!props.graph) {
		model = { nodes: [], edges: [] };
		return;
	}
	model = layout(props.graph);
	shell = buildShell();
	pulses = [];
	selectedId.value = null;
	hoverIdx.value = null;
	hoverCluster.value = null;
}

watch(() => props.graph, rebuild, { immediate: true });

function rotateY(p: Pt3): Pt3 {
	const ca = Math.cos(angle);
	const sa = Math.sin(angle);
	return { x: p.x * ca + p.z * sa, y: p.y, z: -p.x * sa + p.z * ca };
}

function project(p: Pt3, cx: number, cy: number): { x: number; y: number; scale: number } {
	const scale = FOCAL / (FOCAL + p.z);
	return { x: cx + p.x * FIELD * scale, y: cy - p.y * FIELD * scale, scale };
}

function bezierPoint(a: Pt3, ctrl: Pt3, b: Pt3, t: number): Pt3 {
	const u = 1 - t;
	return {
		x: u * u * a.x + 2 * u * t * ctrl.x + t * t * b.x,
		y: u * u * a.y + 2 * u * t * ctrl.y + t * t * b.y,
		z: u * u * a.z + 2 * u * t * ctrl.z + t * t * b.z,
	};
}

function draw() {
	const el = canvas.value;
	const ctx = el?.getContext('2d');
	if (!el || !ctx || box.value.w < 40 || box.value.h < 40) return;
	const { w, h } = box.value;
	const cx = w / 2;
	const cy = h / 2;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, w, h);

	const wireframeMode = look.value === 'wireframe';

	// wireframe shell
	ctx.strokeStyle = wireframeMode ? 'rgba(160,200,255,.16)' : 'rgba(160,200,255,.06)';
	ctx.lineWidth = 1;
	for (const curve of shell) {
		ctx.beginPath();
		curve.forEach((p, i) => {
			const s = project(rotateY(p), cx, cy);
			if (i === 0) ctx.moveTo(s.x, s.y);
			else ctx.lineTo(s.x, s.y);
		});
		ctx.stroke();
	}

	// per-cluster mist
	if (!wireframeMode && props.graph) {
		for (const c of props.graph.clusters) {
			const members = model.nodes.filter((n) => n.cluster === c.index);
			if (members.length === 0) continue;
			const cxp = members.reduce((s, n) => s + n.x, 0) / members.length;
			const cyp = members.reduce((s, n) => s + n.y, 0) / members.length;
			const czp = members.reduce((s, n) => s + n.z, 0) / members.length;
			const s = project(rotateY({ x: cxp, y: cyp, z: czp }), cx, cy);
			const radius = (24 + Math.sqrt(members.length) * 14) * s.scale;
			const grad = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, radius);
			const color = clusterColor(c.index);
			const focus = hoverCluster.value === c.index ? 0.22 : 0.09;
			grad.addColorStop(0, hexA(color, focus));
			grad.addColorStop(1, hexA(color, 0));
			ctx.fillStyle = grad;
			ctx.beginPath();
			ctx.arc(s.x, s.y, radius, 0, Math.PI * 2);
			ctx.fill();
		}
	}

	// project nodes, depth-sort
	for (const n of model.nodes) {
		const rp = rotateY({ x: n.x, y: n.y, z: n.z });
		const s = project(rp, cx, cy);
		n.sx = s.x;
		n.sy = s.y;
		n.sz = rp.z;
		n.sr = n.r * s.scale;
		n.salpha = Math.min(1, Math.max(0.35, 0.55 + (0.85 - s.scale) * -1.1));
	}
	const order = model.nodes.map((_, i) => i).sort((i, j) => model.nodes[j].sz - model.nodes[i].sz);

	// links
	for (const e of model.edges) {
		const a = model.nodes[e.a];
		const b = model.nodes[e.b];
		const inHover =
			interact.value === 'node' && hoverIdx.value !== null && (e.a === hoverIdx.value || e.b === hoverIdx.value);
		const inCluster = interact.value === 'cluster' && hoverCluster.value !== null && e.cluster === hoverCluster.value;
		const dim = interact.value === 'node' ? hoverIdx.value !== null && !inHover : hoverCluster.value !== null && !inCluster;
		const color = e.cluster >= 0 ? clusterColor(e.cluster) : '#78aeed';
		const c1 = bezierPoint({ x: a.x, y: a.y, z: a.z }, e.ctrl, { x: b.x, y: b.y, z: b.z }, 0.5);
		const cs = project(rotateY(c1), cx, cy);
		let alpha = (wireframeMode ? 0.32 : 0.22) * (e.cross ? 0.55 : 1);
		if (inHover || inCluster) alpha = 0.85;
		else if (dim) alpha *= 0.12;
		ctx.strokeStyle = hexA(color, alpha);
		ctx.lineWidth = inHover || inCluster ? 1.6 : 1;
		ctx.beginPath();
		ctx.moveTo(a.sx, a.sy);
		ctx.quadraticCurveTo(cs.x, cs.y, b.sx, b.sy);
		ctx.stroke();
	}

	// pulses
	ctx.save();
	for (const p of pulses) {
		const e = model.edges[p.edge];
		if (!e) continue;
		const a = model.nodes[e.a];
		const b = model.nodes[e.b];
		const pos = bezierPoint({ x: a.x, y: a.y, z: a.z }, e.ctrl, { x: b.x, y: b.y, z: b.z }, p.t);
		const s = project(rotateY(pos), cx, cy);
		const color = e.cluster >= 0 ? clusterColor(e.cluster) : '#cfe6f2';
		ctx.shadowBlur = 8;
		ctx.shadowColor = color;
		ctx.fillStyle = color;
		ctx.beginPath();
		ctx.arc(s.x, s.y, 1.8, 0, Math.PI * 2);
		ctx.fill();
	}
	ctx.restore();

	// nodes, far to near
	for (const idx of order) {
		const n = model.nodes[idx];
		const color = clusterColor(n.cluster);
		const isHoverNode = hoverIdx.value === idx;
		const isHoverCluster = hoverCluster.value === n.cluster;
		let alpha = n.salpha;
		if (interact.value === 'node' && hoverIdx.value !== null && !isHoverNode) alpha *= 0.25;
		if (interact.value === 'cluster' && hoverCluster.value !== null && !isHoverCluster) alpha *= 0.25;
		if (selectedId.value === n.id) alpha = 1;
		ctx.globalAlpha = alpha;
		if (wireframeMode) {
			ctx.strokeStyle = color;
			ctx.lineWidth = 1.3;
			ctx.beginPath();
			ctx.arc(n.sx, n.sy, Math.max(1.6, n.sr), 0, Math.PI * 2);
			ctx.stroke();
		} else {
			ctx.shadowBlur = isHoverNode || selectedId.value === n.id ? 10 : 4;
			ctx.shadowColor = color;
			ctx.fillStyle = color;
			ctx.beginPath();
			ctx.arc(n.sx, n.sy, Math.max(1.6, n.sr) * (isHoverNode ? 1.3 : 1), 0, Math.PI * 2);
			ctx.fill();
		}
		ctx.shadowBlur = 0;
		ctx.globalAlpha = 1;
	}
}

function hexA(hex: string, a: number): string {
	const h = hex.replace('#', '');
	const r = parseInt(h.substring(0, 2), 16);
	const g = parseInt(h.substring(2, 4), 16);
	const b = parseInt(h.substring(4, 6), 16);
	return `rgba(${r},${g},${b},${a})`;
}

function tick() {
	if (!running) return;
	angle += 0.0022;
	if (Math.random() < 0.05 && model.edges.length > 0 && pulses.length < 6) {
		pulses.push({ edge: Math.floor(Math.random() * model.edges.length), t: 0, speed: 0.006 + Math.random() * 0.006 });
	}
	pulses = pulses.filter((p) => {
		p.t += p.speed;
		return p.t < 1;
	});
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

function onVisibility() {
	if (document.visibilityState === 'visible') startLoop();
	else stopLoop();
}

function sizeCanvas() {
	const el = canvas.value;
	if (!el) return;
	dpr = Math.min(window.devicePixelRatio || 1, 2);
	el.width = Math.round(box.value.w * dpr);
	el.height = Math.round(box.value.h * dpr);
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
		if (d < n.sr + 7 && d < bestDist) {
			bestDist = d;
			best = i;
		}
	});
	return best;
}

function onMove(ev: MouseEvent) {
	const idx = hitTest(ev.clientX, ev.clientY);
	hoverIdx.value = idx;
	hoverCluster.value = idx !== null ? model.nodes[idx].cluster : null;
	hoverLabel.value = idx !== null ? model.nodes[idx].label : null;
}

function onLeave() {
	hoverIdx.value = null;
	hoverCluster.value = null;
	hoverLabel.value = null;
}

function onClick(ev: MouseEvent) {
	const idx = hitTest(ev.clientX, ev.clientY);
	if (idx === null) return;
	selectedId.value = model.nodes[idx].id;
	emit('select', model.nodes[idx].id);
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
	if (document.visibilityState === 'visible') startLoop();
});

onBeforeUnmount(() => {
	stopLoop();
	ro?.disconnect();
	ro = null;
	document.removeEventListener('visibilitychange', onVisibility);
});

const hasData = computed(() => model.nodes.length > 0);

const lookOptions: Array<{ value: 'organic' | 'wireframe'; key: BaseTextKey }> = [
	{ value: 'organic', key: 'aon.graph.lookOrganic' },
	{ value: 'wireframe', key: 'aon.graph.lookWireframe' },
];
const interactOptions: Array<{ value: 'cluster' | 'node'; key: BaseTextKey }> = [
	{ value: 'cluster', key: 'aon.graph.clusters' },
	{ value: 'node', key: 'aon.graph.nodes' },
];
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

		<div :class="$style.controls">
			<div :class="$style.toggle">
				<button
					v-for="opt in lookOptions"
					:key="opt.value"
					type="button"
					:class="[$style.toggleBtn, look === opt.value && $style.toggleOn]"
					@click="look = opt.value"
				>
					{{ i18n.baseText(opt.key) }}
				</button>
			</div>
			<div :class="$style.toggle">
				<button
					v-for="opt in interactOptions"
					:key="opt.value"
					type="button"
					:class="[$style.toggleBtn, interact === opt.value && $style.toggleOn]"
					@click="interact = opt.value"
				>
					{{ i18n.baseText(opt.key) }}
				</button>
			</div>
		</div>

		<div v-if="hoverLabel" :class="$style.hoverLabel">{{ hoverLabel }}</div>

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
	background: #060608;
	border-radius: var(--radius--lg);
	cursor: crosshair;
}

.canvas {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
}

.controls {
	position: absolute;
	top: var(--spacing--2xs);
	right: var(--spacing--2xs);
	display: flex;
	gap: var(--spacing--3xs);
}

.toggle {
	display: flex;
	background: rgba(10, 10, 12, 0.75);
	border-radius: var(--radius);
	overflow: hidden;
	backdrop-filter: blur(8px);
}

.toggleBtn {
	font: inherit;
	font-size: var(--font-size--3xs);
	letter-spacing: 0.08em;
	text-transform: uppercase;
	padding: var(--spacing--4xs) var(--spacing--2xs);
	border: none;
	background: transparent;
	color: rgba(230, 230, 235, 0.6);
	cursor: pointer;
}

.toggleOn {
	background: var(--color--primary);
	color: var(--color--neutral-white);
}

.hoverLabel {
	position: absolute;
	bottom: var(--spacing--2xs);
	left: var(--spacing--2xs);
	padding: var(--spacing--4xs) var(--spacing--2xs);
	border-radius: var(--radius);
	background: rgba(10, 10, 12, 0.75);
	color: #eef4f8;
	font-size: var(--font-size--3xs);
	pointer-events: none;
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
