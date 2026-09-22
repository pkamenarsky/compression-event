// An experiment for PLAN-bevel.md, not a test of anything shipped: the hard
// parts of round → deform → erode, measured against deform → erode → round
// before committing to the plan. It prints what it finds; the few assertions
// are only that what it measures is there to be measured.

import { describe, expect, it } from 'vitest';
import { Point } from '@ce/game/world';
import {
  Effecting,
  Ring,
  erodeAt,
  erodedCorners,
  isCCW,
  patternRun,
  patterned,
  rounded,
  spread,
  unionAll,
} from '../geometry';

const E: Effecting = { spacing: 12, pattern: 'zigzag', seed: 0, sides: 'both', jitter: 0 };
const N = 8;
const TENSION = 0.5;

// The curve of `curveOf`, again: its control values, a Bézier of them, and
// its derivative.
const near = 0.7 - 0.3 * TENSION, inner = 0.45 * (1 - TENSION);
const A = [1, near, inner, 0, 0, 0], B = [0, 0, 0, inner, near, 1];

function bezier(c: readonly number[], u: number): number {
  const d = c.length - 1;
  let out = 0, binom = 1;

  for (let k = 0; k <= d; k++) {
    out += c[k] * binom * Math.pow(u, k) * Math.pow(1 - u, d - k);
    binom = binom * (d - k) / (k + 1);
  }

  return out;
}

const derived = (c: readonly number[]) => c.slice(1).map((x, k) => (x - c[k]) * (c.length - 1));
const A1 = derived(A), B1 = derived(B);

interface Laid {
  points: Point[]
  /** Each point's name, the same at every instant: what the bake carries. */
  ids: string[]
  /** What each point is: a drawn corner's arc, or a tooth. */
  kind: ('arc' | 'tooth')[]
}

/**
 * The plan's pipeline up to the erosion: every corner rounded by `bevel`, then
 * teeth along the straights (cleared by the arcs) and `teeth` of them along
 * each arc at fixed `u`, pushed along the curve's own normal. A ring wound
 * counter-clockwise, so out of the material is to the right.
 *
 * Every tooth is laid, flat or not, so two ends of a span have the same
 * points in the same order: what the bake's seeding would guarantee.
 */
function roundThenDeform(ring: Ring, bevel: number, amplitude: number, teeth: number): Laid {
  const n = ring.length;
  const points: Point[] = [], kind: Laid['kind'][number][] = [], ids: string[] = [];
  const unit = (p: Point, q: Point) => {
    const l = Math.hypot(q.x - p.x, q.y - p.y);

    return { x: (q.x - p.x) / l, y: (q.y - p.y) / l, l };
  };

  const cut = ring.map((_v, i) => {
    const before = unit(ring[i], ring[(i - 1 + n) % n]), after = unit(ring[i], ring[(i + 1) % n]);

    return Math.min(bevel, before.l / 2, after.l / 2);
  });

  ring.forEach((v, i) => {
    const a = unit(v, ring[(i - 1 + n) % n]), b = unit(v, ring[(i + 1) % n]);
    const t = cut[i];
    const at = (u: number) => ({ x: v.x + (a.x * bezier(A, u) + b.x * bezier(B, u)) * t, y: v.y + (a.y * bezier(A, u) + b.y * bezier(B, u)) * t });
    const normal = (u: number) => {
      const dx = a.x * bezier(A1, u) + b.x * bezier(B1, u), dy = a.y * bezier(A1, u) + b.y * bezier(B1, u);
      const l = Math.hypot(dx, dy) || 1;

      return { x: dy / l, y: -dx / l };
    };

    // The facets' turns and the teeth, merged by `u`: a turn where a tooth is
    // is the tooth, or the two are one point whenever the tooth is flat.
    const toothU = Array.from({ length: teeth }, (_x, j) => (j + 1) / (teeth + 1));
    const us: { u: number, j: number | null }[] = [
      ...spread(a.x * b.x + a.y * b.y, N, TENSION).filter(u => !toothU.some(w => Math.abs(w - u) < 1e-6)).map(u => ({ u, j: null })),
      ...Array.from({ length: teeth }, (_x, j) => ({ u: (j + 1) / (teeth + 1), j })),
    ].sort((p, q) => p.u - q.u);

    for (const { u, j } of us) {
      const p = at(u);

      if (j === null) {
        points.push(p);
        kind.push('arc');
        ids.push(`arc ${i}:${u.toFixed(6)}`);
        continue;
      }

      const room = Math.min(1, 2 * Math.min(u, 1 - u) * (teeth + 1) / 2);
      const h = amplitude * room * patterned(E, ~i, j);
      const m = normal(u);

      points.push({ x: p.x + m.x * h, y: p.y + m.y * h });
      kind.push('tooth');
      ids.push(`arc tooth ${i}:${j}`);
    }

    // The straight to the next corner, between the two arcs.
    const w = ring[(i + 1) % n];
    const l = b.l;
    const run = straightRun(l, cut[i], cut[(i + 1) % n], amplitude, i);

    run.forEach(({ along, across, j }) => {
      points.push({ x: v.x + b.x * along * l + b.y * across, y: v.y + b.y * along * l - b.x * across });
      kind.push('tooth');
      ids.push(`tooth ${i}:${j}`);
    });

    void w;
  });

  return { points, kind, ids };
}

/** `patternRun` with every tooth kept, flat or not: see `roundThenDeform`. */
function straightRun(length: number, clear: number, clearTo: number, amplitude: number, key: number) {
  const full = patternRun(E, key, amplitude, length, 0, 0);

  // One the arc has cut off is not laid, as `patternRun` does not lay it: the
  // bake seeds it on its edge at the end of a span that has it.
  return full.along.flatMap((u, k) => {
    const at = u * length;
    const room = Math.min(1, Math.min(at - clear, length - clearTo - at) / E.spacing);

    return room <= 0 ? [] : [{ along: u, across: amplitude * room * patterned(E, key, full.teeth[k]), j: full.teeth[k] }];
  });
}

/** Today's order, near enough: teeth on the source (cleared), eroded, then
 * every corner of the eroded drawn ring rounded. */
function deformErodeRound(ring: Ring, bevel: number, amplitude: number, depth: number): Named {
  const n = ring.length;
  const drawn: Point[] = [];
  const names: string[] = [];

  ring.forEach((v, i) => {
    const w = ring[(i + 1) % n];
    const l = Math.hypot(w.x - v.x, w.y - v.y);
    const bx = (w.x - v.x) / l, by = (w.y - v.y) / l;

    drawn.push(v);
    names.push(`corner ${i}`);
    straightRun(l, bevel, bevel, amplitude, i).forEach(({ along, across, j }) => {
      drawn.push({ x: v.x + bx * along * l + by * across, y: v.y + by * along * l - bx * across });
      names.push(`tooth ${i}:${j}`);
    });
  });

  const eroded = erodedCorners(drawn, depth);
  const out = new Map<string, Point>();
  const arcs = rounded(eroded, i => (names[i].startsWith('corner') ? bevel : 0), N, TENSION);

  // `N + 1` points a corner, in ring order.
  names.forEach((name, i) => arcs.slice(i * (N + 1), (i + 1) * (N + 1)).forEach((p, k) => out.set(`${name}/${k}`, p)));

  return out;
}

type Named = Map<string, Point>;

/** The plan's order, eroded, by name. */
function roundDeformErode(ring: Ring, bevel: number, amplitude: number, depth: number, teeth = 3): Named {
  const laid = roundThenDeform(ring, bevel, amplitude, teeth);
  const eroded = erodedCorners(laid.points, depth);

  return new Map(laid.ids.map((id, i) => [id, eroded[i]]));
}

function lerpP(p: Point, q: Point, t: number): Point {
  return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
}

/** How far the middle of a span is from the lerp of its ends, point by point:
 * what the bake has to cut a stretch finer for. */
function midError(at: (t: number) => Named): number {
  const p0 = at(0), p1 = at(1), pm = at(0.5);
  const both = [...pm.keys()].filter(k => p0.has(k) && p1.has(k));

  expect(both.length).toBeGreaterThan(0);

  const errs = both.map(k => {
    const q = lerpP(p0.get(k)!, p1.get(k)!, 0.5), p = pm.get(k)!;

    return Math.hypot(p.x - q.x, p.y - q.y);
  });
  const worst = errs.indexOf(Math.max(...errs));

  worstAt = { name: both[worst], of: `${both.length} of ${pm.size}` };

  return errs[worst];
}

let worstAt: unknown = null;

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** A room: a long rectangle with one corner pushed out, so no two corners
 * are alike. */
function room(nudge = 0): Ring {
  const r = [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 130 + nudge, y: 70 + nudge / 2 }, { x: 0, y: 60 }];

  return isCCW(r) ? r : r.reverse();
}

const report: string[] = [];
const log = (s: string) => report.push(s);

describe('experiment: round → deform → erode', () => {
  it('H1: the amounts alone, against today', () => {
    // Corners still; bevel, amplitude and depth change over the span, one at a
    // time and all together.
    const cases: [string, (t: number) => [number, number, number]][] = [
      ['bevel 4 → 14', t => [mix(4, 14, t), 2, 4]],
      ['amplitude 0 → 3', t => [10, mix(0, 3, t), 4]],
      ['depth 0 → 5', t => [10, 2, mix(0, 5, t)]],
      ['all three', t => [mix(4, 14, t), mix(0, 3, t), mix(0, 5, t)]],
      ['bevel and depth, no teeth', t => [mix(4, 14, t), 0, mix(0, 5, t)]],
    ];

    for (const [name, amounts] of cases) {
      const eOld = midError(t => deformErodeRound(room(), ...amounts(t)));
      const eNew = midError(t => roundDeformErode(room(), ...amounts(t), 1));
      const where = JSON.stringify(worstAt);
      const eDense = midError(t => roundDeformErode(room(), ...amounts(t), 3));

      log(`H1 ${name}: mid-span error old ${eOld.toFixed(4)}, new ${eNew.toFixed(4)} ${where}, new with 3 teeth an arc ${eDense.toFixed(4)}`);
    }
  });

  it('H2: a corner moving costs no more than it does today', () => {
    const newAt = (t: number) => roundDeformErode(room(mix(0, 30, t)), 10, 2, 4, 1);
    const oldAt = (t: number) => deformErodeRound(room(mix(0, 30, t)), 10, 2, 4);

    const eOld = midError(oldAt), eNew = midError(newAt);

    const named = JSON.stringify(worstAt);

    log(`H2 corner moves 30: mid-span error new ${eNew.toFixed(4)}, old ${eOld.toFixed(4)} ${named}`);

    // And a turn in place, which the frame plays exactly in both, so only a
    // change of shape is measured: nothing here to compare but the corner.
  });

  it('H2b: the bevel held as seen stays linear', () => {
    // Held: bevel + depth at the convex corners (all of them here).
    const at = (t: number) => {
      const d = mix(0, 8, t);

      return roundDeformErode(room(), mix(6, 10, t) + d, 2, d, 1);
    };
    const flat = (t: number) => {
      const d = mix(0, 8, t);

      return roundDeformErode(room(), mix(6, 10, t) + d, 0, d);
    };

    log(`H2b held bevel, no teeth: mid-span error ${midError(flat).toFixed(4)}`);

    log(`H2b held bevel, depth 0 → 8: mid-span error ${midError(at).toFixed(4)} ${JSON.stringify(worstAt)}`);
  });

  it('H3: the arrangement keeps the arcs and teeth, and at what cost', () => {
    const cases: [string, number, number, number][] = [
      ['shallow', 10, 2, 2],
      ['deep, past the radius', 10, 2, 14],
      ['big teeth', 10, 5, 4],
    ];

    for (const [name, bevel, amplitude, depth] of cases) {
      const laid = roundThenDeform(room(), bevel, amplitude, 3);
      const old = [...deformErodeRound(room(), bevel, amplitude, 0).values()];

      const t0 = performance.now();

      for (let k = 0; k < 20; k++) erodeAt(laid.points, laid.points.map(() => depth));

      const tNew = (performance.now() - t0) / 20;
      const out = erodeAt(laid.points, laid.points.map(() => depth));

      // Today's arrangement is of the teeth alone; the arcs are laid on after.
      const teethOnly = old.length;
      const t1 = performance.now();

      for (let k = 0; k < 20; k++) erodeAt(old, old.map(() => depth));

      const tOld = (performance.now() - t1) / 20;

      const kept = out.reduce((s, r) => s + r.length, 0);
      const area = out.reduce((s, r) => s + r.reduce((a, p, i) => a + p.x * r[(i + 1) % r.length].y - r[(i + 1) % r.length].x * p.y, 0) / 2, 0);

      log(`H3 ${name}: ${laid.points.length} points in, ${kept} out, ${out.length} ring(s), area ${area.toFixed(0)}; erode ${tNew.toFixed(2)} ms vs ${teethOnly} points ${tOld.toFixed(2)} ms`);
      expect(area).toBeGreaterThan(0);
    }
  });

  it('H4: a union\'s corners can be named by what they are made of', () => {
    const square = (x: number, y: number, s: number): Ring => [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }];
    const members = (t: number) => [square(0, 0, 50), square(mix(30, 45, t), mix(20, 35, t), 40)];

    const onSegment = (p: Point, a: Point, b: Point) => {
      const l = Math.hypot(b.x - a.x, b.y - a.y);
      const cross = ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / l;
      const dot = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (l * l);

      return Math.abs(cross) < 1e-6 && dot > -1e-9 && dot < 1 + 1e-9;
    };

    const names = (t: number): string[] => {
      const ms = members(t);
      const out = unionAll(ms.map(r => [r]));

      return out.flat().map(p => {
        for (let m = 0; m < ms.length; m++) {
          const k = ms[m].findIndex(q => Math.hypot(q.x - p.x, q.y - p.y) < 1e-6);

          if (k >= 0) return `corner ${m}:${k}`;
        }

        const edges = ms.flatMap((r, m) => r.flatMap((a, k) => (onSegment(p, a, r[(k + 1) % r.length]) ? [`${m}:${k}`] : [])));

        return edges.length === 2 ? `cross ${edges.join('×')}` : `unnamed (${edges.join(',')})`;
      }).sort();
    };

    const samples = [0, 0.25, 0.5, 0.75, 1].map(names);
    const stable = samples.every(s => JSON.stringify(s) === JSON.stringify(samples[0]));

    log(`H4 union corners: ${samples[0].join(', ')}; the same at every instant: ${stable}`);
    expect(samples.flat().some(n => n.startsWith('unnamed'))).toBe(false);
  });

  it('prints', () => {
    console.log(`\n${report.join('\n')}\n`);
  });
});
