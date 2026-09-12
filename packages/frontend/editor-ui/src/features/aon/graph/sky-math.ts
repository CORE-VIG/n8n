/**
 * The memory constellation's arithmetic, ported from `/root/AON/lib/mem-sky.ts`
 * (the Aon deck's `drawMem`).
 *
 * Each category owns an angular sector sized by its share of the total, and
 * the sector is filled with hundreds of small dots in that category's colour
 * across twenty rings, fading outward. A faint web of chatter sits behind it,
 * a ring closes it, and twenty-two knots sit on that ring. It reads as one
 * body of knowledge with visible proportions rather than a diagram of things
 * joined by lines.
 *
 * Everything here is deterministic: the same counts and the same box draw
 * the same sky, every time, because the randomness is a seeded generator.
 *
 * Pure: no DOM, no colour resolution. `AonSkyGraph.vue` resolves category
 * colours (from CSS tokens) and walks this to paint.
 */

export type Cat = { name: string; n: number; color: string };

export type Box = { w: number; h: number };

/** Lehmer generator: seeded so the same seed always draws the same sky. */
export function rng(seed: number): () => number {
	let s = seed % 2147483647;
	if (s <= 0) s += 2147483646;
	return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

export const GAP = 0.05;
export const RINGS = 20;

/** Where the sky sits in its box, and how far it reaches. */
export const centre = (b: Box) => ({ cx: b.w / 2, cy: b.h * 0.52, maxR: Math.min(b.w, b.h) * 0.44 });

export type Arc = { cat: Cat; a0: number; a1: number };

/**
 * One sector per category, sized by its share.
 *
 * A category with nothing in it still gets its gap but no arc worth
 * drawing, which is right: it is a name with no sky under it.
 */
export function arcs(cats: Cat[]): Arc[] {
	const total = cats.reduce((a, c) => a + Math.max(0, c.n), 0);
	if (total <= 0 || cats.length === 0) return [];
	const usable = 6.2832 - GAP * cats.length;
	let a = -Math.PI / 2;
	return cats.map((cat) => {
		const span = (Math.max(0, cat.n) / total) * usable;
		const arc = { cat, a0: a, a1: a + span };
		a += span + GAP;
		return arc;
	});
}

export type Label = { name: string; n: number; color: string; x: number; y: number; rad: number };

/**
 * Where each category's label goes: on its sector's midline, pushed out
 * when the sector is thin so a sliver's name is not lost in the crowd.
 *
 * Then two collision passes, kept exactly: without them the small
 * categories pile onto one another, and an unreadable label still costs
 * the space it covers.
 */
export function labels(cats: Cat[], b: Box): Label[] {
	const total = cats.reduce((a, c) => a + Math.max(0, c.n), 0);
	if (total <= 0) return [];
	const { cx, cy, maxR } = centre(b);
	const out: Label[] = arcs(cats).map(({ cat, a0, a1 }) => {
		const mid = (a0 + a1) / 2;
		const share = Math.max(0, cat.n) / total;
		const rad = maxR * (share < 0.06 ? 1.0 : 0.72);
		return {
			name: cat.name,
			n: cat.n,
			color: cat.color,
			rad,
			x: cx + Math.cos(mid) * rad,
			y: cy + Math.sin(mid) * rad,
		};
	});

	const clamp = (l: Label) => {
		l.x = Math.min(b.w - 84, Math.max(84, l.x));
		l.y = Math.min(b.h - 30, Math.max(50, l.y));
	};
	const near = (A: Label, B: Label) => Math.abs(A.x - B.x) < 128 && Math.abs(A.y - B.y) < 30;

	// Pass one: push the outer of an overlapping pair further out.
	for (let it = 0; it < 14; it++) {
		let moved = false;
		for (let i = 0; i < out.length; i++) {
			for (let j = i + 1; j < out.length; j++) {
				const A = out[i];
				const B = out[j];
				if (!near(A, B)) continue;
				const o = A.rad >= B.rad ? A : B;
				o.rad += 18;
				const ang = Math.atan2(o.y - cy, o.x - cx);
				o.x = cx + Math.cos(ang) * o.rad;
				o.y = cy + Math.sin(ang) * o.rad;
				clamp(o);
				moved = true;
			}
		}
		if (!moved) break;
	}
	out.forEach(clamp);

	// Pass two: whatever the clamp pressed back together, separate
	// vertically inside the box, and sideways when there is no room left.
	for (let it = 0; it < 10; it++) {
		let moved = false;
		for (let i = 0; i < out.length; i++) {
			for (let j = i + 1; j < out.length; j++) {
				const A = out[i];
				const B = out[j];
				if (!near(A, B)) continue;
				const lo = A.y <= B.y ? A : B;
				const hi = lo === A ? B : A;
				lo.y = Math.max(50, lo.y - 16);
				hi.y = Math.min(b.h - 30, hi.y + 16);
				if (hi.y - lo.y < 30) hi.x = Math.min(b.w - 84, hi.x + 132);
				moved = true;
			}
		}
		if (!moved) break;
	}

	for (const l of out) {
		l.x = Math.round(l.x);
		l.y = Math.round(l.y);
	}
	return out;
}

/* -- what to paint, as data ---------------------------------------------- */

export type Dot = { x: number; y: number; r: number; alpha: number; color: string };
export type Line = { x1: number; y1: number; x2: number; y2: number };
export type Knot = { x: number; y: number };

export type Sky = { chatter: Line[]; dots: Dot[]; ring: { cx: number; cy: number; r: number }; knots: Knot[] };

/** Twenty-two nodes evenly around the closing ring. */
export const KNOTS = 22;
/** The faint web behind everything. */
export const CHATTER = 110;

/**
 * The whole sky as plain numbers, so the component only paints and decides
 * nothing.
 *
 * The order of draws matters: chatter first, then the rings of dots
 * outward, then the closing ring and its knots on top.
 */
export function sky(cats: Cat[], b: Box, seed: number): Sky {
	const r = rng(seed);
	const { cx, cy, maxR } = centre(b);
	const chatter: Line[] = [];
	for (let i = 0; i < CHATTER; i++) {
		const a1 = r() * 6.2832;
		const a2 = r() * 6.2832;
		const r1 = maxR * (0.3 + r() * 0.6);
		const r2 = maxR * (0.3 + r() * 0.6);
		chatter.push({
			x1: cx + Math.cos(a1) * r1,
			y1: cy + Math.sin(a1) * r1,
			x2: cx + Math.cos(a2) * r2,
			y2: cy + Math.sin(a2) * r2,
		});
	}

	const dots: Dot[] = [];
	const segs = arcs(cats);
	const drawn = new Set<string>();
	for (let ring = 0; ring < RINGS; ring++) {
		const rad = maxR * 0.34 + ring * ((maxR * 0.63) / RINGS);
		const fade = 1 - (ring / RINGS) * 0.5;
		for (const seg of segs) {
			const step = 7 / rad;
			for (let ang = seg.a0 + 0.02; ang < seg.a1 - 0.02; ang += step) {
				// A fifth of the places are left empty, which is what stops the
				// rings reading as printed lines.
				if (r() < 0.2) continue;
				const rr = rad + (r() - 0.5) * 4;
				drawn.add(seg.cat.name);
				dots.push({
					x: cx + Math.cos(ang) * rr,
					y: cy + Math.sin(ang) * rr,
					r: 1.25 + r() * 0.85,
					alpha: (0.22 + r() * 0.62) * fade,
					color: seg.cat.color,
				});
			}
		}
	}

	// A category thinner than the 0.02 margins at each end of its sector
	// gets no stars at all, which makes the colour beside its name in the
	// rail mean nothing. Anything with a real count gets at least one star
	// on its own midline, so the key never lies.
	for (const seg of segs) {
		if (seg.cat.n <= 0 || drawn.has(seg.cat.name)) continue;
		const mid = (seg.a0 + seg.a1) / 2;
		const rad = maxR * 0.62;
		dots.push({
			x: cx + Math.cos(mid) * rad,
			y: cy + Math.sin(mid) * rad,
			r: 1.6,
			alpha: 0.72,
			color: seg.cat.color,
		});
	}

	const knots: Knot[] = [];
	for (let i = 0; i < KNOTS; i++) {
		const ang = -Math.PI / 2 + (i / KNOTS) * 6.2832;
		knots.push({ x: cx + Math.cos(ang) * maxR, y: cy + Math.sin(ang) * maxR });
	}

	return { chatter, dots, ring: { cx, cy, r: maxR }, knots };
}
