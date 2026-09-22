// An experiment for PLAN-bevel.md, not a test of anything shipped: the hard
// parts of round → deform → erode, measured against deform → erode → round
// before committing to the plan. Since phase 1, what it calls today is the
// new order for a polygon, and its figures are the plan's record, not this.
//
// Not run with the rest: `EXPERIMENT=1 pnpm vitest run experiments` runs it. It prints what it finds; the few assertions
// are only that what it measures is there to be measured.

import { describe, expect, it } from 'vitest';
import { bakeSpan } from '../bake';
import { TOP, addPolygon, grouped, rigOf, sealing, withRig } from '../scene';
import { nudged } from '../rig';
import { Writing, erode, inSegments, moved, wrote } from '../testing';
import { Effects, PolygonId, World, emptyWorld } from '../types';
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

let E: Effecting = { spacing: 12, pattern: 'zigzag', seed: 0, sides: 'both', jitter: 0 };
let N = 8;
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
function roundThenDeform(ring: Ring, bevel: number, amplitude: number, teeth: number, arcAmplitude = amplitude): Laid {
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

    // `teeth` below nought lays the arc as any other run: `patternRun` along
    // its length, from its middle, each tooth where its length puts it.
    const spaced = teeth < 0 ? spacedOn(at, t, i, arcAmplitude) : null;

    // The facets' turns and the teeth, merged by `u`: a turn where a tooth is
    // is the tooth, or the two are one point whenever the tooth is flat.
    const toothU = spaced?.map(x => x.u) ?? Array.from({ length: teeth }, (_x, j) => (j + 1) / (teeth + 1));
    const toothJ = spaced?.map(x => x.j) ?? toothU.map((_u, j) => j);
    const us: { u: number, j: number | null, k: number }[] = [
      ...spread(a.x * b.x + a.y * b.y, N, TENSION).filter(u => !toothU.some(w => Math.abs(w - u) < 1e-6)).map(u => ({ u, j: null, k: -1 })),
      ...toothU.map((u, k) => ({ u, j: toothJ[k], k })),
    ].sort((p, q) => p.u - q.u);

    for (const { u, j, k } of us) {
      const p = at(u);

      if (j === null) {
        points.push(p);
        kind.push('arc');
        ids.push(`arc ${i}:${u.toFixed(6)}`);
        continue;
      }

      const room = Math.min(1, 2 * Math.min(u, 1 - u) * (teeth + 1) / 2);
      const h = spaced !== null ? spaced[k].across : arcAmplitude * room * patterned(E, ~i, j);
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

/**
 * An arc's teeth as a straight's are laid: `patternRun` along its length, a
 * tooth every spacing out from its middle, shrinking to nothing within a
 * spacing of either end. Each is put back on the curve at the `u` its length
 * along it falls at, so it moves round the curve as the bevel changes.
 */
function spacedOn(at: (u: number) => Point, bevel: number, key: number, amplitude: number): { u: number, j: number, across: number }[] {
  if (!(bevel > 0)) return [];

  const K = 400;
  const lengths = [0];

  for (let k = 1; k <= K; k++) {
    const p = at((k - 1) / K), q = at(k / K);

    lengths.push(lengths[k - 1] + Math.hypot(q.x - p.x, q.y - p.y));
  }

  const total = lengths[K];
  const run = patternRun(E, ~key, amplitude, total);

  return run.along.map((f, n) => {
    const want = f * total;
    let k = 0;

    while (k < K - 1 && lengths[k + 1] < want) k++;

    const u = (k + (want - lengths[k]) / Math.max(lengths[k + 1] - lengths[k], 1e-12)) / K;

    return { u: Math.min(1 - 1e-9, Math.max(1e-9, u)), j: run.teeth[n], across: run.across[n] };
  }).filter(x => x.across !== 0 || true);
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

describe.skipIf(!process.env.EXPERIMENT)('experiment: round → deform → erode', () => {
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

/** The generator run to the end. */
function run<T>(g: Generator<number, T, void>): T {
  let step = g.next();

  while (!step.done) step = g.next();

  return step.value;
}

describe.skipIf(!process.env.EXPERIMENT)('experiment: the real bake, both ways', () => {
  const SIDE = 200;
  const SPACING = 20, SEGMENTS = 4;
  let ARC_TEETH = 1;
  const square: Ring = [{ x: -100, y: -100 }, { x: 100, y: -100 }, { x: 100, y: 100 }, { x: -100, y: 100 }];
  const round = (by: number): Writing => ({ kind: 'round', by });
  const deform = (by: number): Writing => ({ kind: 'deform', by });

  type Amounts = { bevel: number, amplitude: number, depth: number };

  /** Today: the effects on the room, the amounts written at each end. */
  function today(a: Amounts, b: Amounts): World {
    const added = addPolygon(emptyWorld(), { level: 'hollow' }, square, 0, TOP);
    const fx: Effects = {
      round: inSegments(SEGMENTS, 20),
      deform: { spacing: SPACING, pattern: 'zigzag', seed: 0, sides: 'both', jitter: 0 },
    };
    let w: World = { ...added.world, effects: new Map([[added.id, fx]]) };

    w = wrote(w, 0, added.id, round(a.bevel), deform(a.amplitude), erode(a.depth));
    w = wrote(w, 1, added.id, round(b.bevel - a.bevel), deform(b.amplitude - a.amplitude), erode(b.depth - a.depth));

    return w;
  }

  /** Planned: a plain room whose corners are the round and the deform, laid
   * as the prototype lays them at each end — the far end's as nudges — and
   * the erosion written as today. Between the ends the bake lerps the corners,
   * which is the plan's pipeline wherever it is linear: see the table in the
   * plan. */
  function planned(a: Amounts, b: Amounts): World {
    E = { spacing: SPACING, pattern: 'zigzag', seed: 0, sides: 'both', jitter: 0 };
    N = SEGMENTS;

    // With no teeth at either end, none are laid, flat or not.
    const flat = a.amplitude === 0 && b.amplitude === 0;
    const laid = (x: Amounts): Laid => {
      const l = roundThenDeform(square, x.bevel, x.amplitude, flat ? 0 : ARC_TEETH);
      const keep = l.kind.map(k => !flat || k === 'arc');

      return { points: l.points.filter((_p, i) => keep[i]), ids: l.ids.filter((_d, i) => keep[i]), kind: l.kind.filter((_k, i) => keep[i]) };
    };
    const at0 = laid(a), at1 = laid(b);

    E = { ...E, spacing: 12 };
    N = 8;

    expect(at1.ids).toEqual(at0.ids);

    const added = addPolygon(emptyWorld(), { level: 'hollow' }, at0.points, 0, TOP);
    const id: PolygonId = added.id;
    const vertices = added.world.polygons.get(id)!.points;
    let rig = rigOf(added.world, id);

    vertices.forEach((v, i) => {
      const by = { x: at1.points[i].x - at0.points[i].x, y: at1.points[i].y - at0.points[i].y };

      if (by.x !== 0 || by.y !== 0) rig = nudged(rig, v.id, 1, by);
    });

    let w = withRig(added.world, id, rig);

    w = wrote(w, 0, id, erode(a.depth));
    w = wrote(w, 1, id, erode(b.depth - a.depth));

    return w;
  }

  const cases: [string, Amounts, Amounts][] = [
    ['depth 0 → 20', { bevel: 12, amplitude: 4, depth: 0 }, { bevel: 12, amplitude: 4, depth: 20 }],
    ['depth 0 → 6', { bevel: 12, amplitude: 4, depth: 0 }, { bevel: 12, amplitude: 4, depth: 6 }],
    ['bevel 6 → 18', { bevel: 6, amplitude: 4, depth: 8 }, { bevel: 18, amplitude: 4, depth: 8 }],
    ['bevel 4 → 12, depth 1', { bevel: 4, amplitude: 4, depth: 1 }, { bevel: 12, amplitude: 4, depth: 1 }],
    ['amplitude 1 → 6', { bevel: 12, amplitude: 1, depth: 6 }, { bevel: 12, amplitude: 6, depth: 6 }],
    ['all three', { bevel: 6, amplitude: 1, depth: 0 }, { bevel: 18, amplitude: 6, depth: 20 }],
    ['all three, small', { bevel: 6, amplitude: 1, depth: 0 }, { bevel: 12, amplitude: 6, depth: 6 }],
    ['bevel and depth, no teeth', { bevel: 6, amplitude: 0, depth: 0 }, { bevel: 18, amplitude: 0, depth: 20 }],
    ['no teeth, depth under the bevel', { bevel: 12, amplitude: 0, depth: 0 }, { bevel: 18, amplitude: 0, depth: 5 }],
    ['no teeth, depth alone, under the bevel', { bevel: 18, amplitude: 0, depth: 0 }, { bevel: 18, amplitude: 0, depth: 10 }],
  ];

  /** The planned order with the bevel held: drawn `bevel ± depth`. */
  const held = (sign: number) => (x: Amounts): Amounts => ({ ...x, bevel: Math.max(0, x.bevel + sign * x.depth) });

  it('stretches, evaluations and time', () => {
    const lines: string[] = [];

    for (const [name, a, b] of cases) {
      const measure = (w: World) => {
        const t0 = performance.now();
        const span = run(bakeSpan(w, 0));
        const ms = performance.now() - t0;
        const stretches = span.tracks.reduce((n, t) => n + t.stretches.length, 0);

        return `${stretches} stretches, ${span.evaluations} evaluations, worst ${span.worst.toFixed(3)}, ${ms.toFixed(0)} ms`;
      };

      lines.push(`${name}: today ${measure(today(a, b))} | planned ${measure(planned(a, b))}`);

      const tried = (f: () => string) => {
        try {
          return f();
        }
        catch {
          return 'n/a (a tooth eaten)';
        }
      };

      lines.push(`  held: ${tried(() => measure(planned(held(1)(a), held(1)(b))))}`);

      if (a.amplitude !== 0 || b.amplitude !== 0) {
        ARC_TEETH = 0;
        lines.push(`  held, no teeth on the arcs: ${tried(() => measure(planned(held(1)(a), held(1)(b))))}`);
        ARC_TEETH = 1;
      }
    }

    console.log(`\nThe real bake, a ${SIDE} square room:\n${lines.join('\n')}\n`);
  });
});

/**
 * Two ends laid over the same corners, the way the bake's seeding does it: a
 * point one end has and the other does not is put, at the end without it,
 * half way between its nearest neighbours there. So a tooth arriving on an
 * arc grows out of the outline, and one a growing bevel eats lands back on it.
 */
function seeded(l0: Laid, l1: Laid): { ids: string[], p0: Point[], p1: Point[] } {
  const ids = [...l0.ids];

  l1.ids.forEach((id, k) => {
    if (ids.includes(id)) return;

    // After the nearest one before it that is already in.
    let before = k - 1;

    while (before >= 0 && !ids.includes(l1.ids[before])) before--;

    ids.splice(before < 0 ? 0 : ids.indexOf(l1.ids[before]) + 1, 0, id);
  });

  const fill = (l: Laid): Point[] => {
    const at = new Map(l.ids.map((id, i) => [id, l.points[i]]));
    const n = ids.length;

    return ids.map((id, i) => {
      const own = at.get(id);

      if (own !== undefined) return own;

      let a = i, b = i;

      do a = (a - 1 + n) % n; while (!at.has(ids[a]));
      do b = (b + 1) % n; while (!at.has(ids[b]));

      return lerpP(at.get(ids[a])!, at.get(ids[b])!, 0.5);
    });
  };

  return { ids, p0: fill(l0), p1: fill(l1) };
}

/** A plain room drawn at `p0`, its corners nudged to `p1` at keyframe 1, and
 * eroded by `d0` then `d1`: what the plan's pipeline bakes as. */
function plainRoom(p0: Point[], p1: Point[], d0: number, d1: number): World {
  const added = addPolygon(emptyWorld(), { level: 'hollow' }, p0, 0, TOP);
  const vertices = added.world.polygons.get(added.id)!.points;
  let rig = rigOf(added.world, added.id);

  vertices.forEach((v, i) => {
    const by = { x: p1[i].x - p0[i].x, y: p1[i].y - p0[i].y };

    if (by.x !== 0 || by.y !== 0) rig = nudged(rig, v.id, 1, by);
  });

  let w = withRig(added.world, added.id, rig);

  w = wrote(w, 0, added.id, erode(d0));
  w = wrote(w, 1, added.id, erode(d1 - d0));

  return w;
}

function measured(w: World): string {
  const t0 = performance.now();
  const span = run(bakeSpan(w, 0));
  const ms = performance.now() - t0;
  const stretches = span.tracks.reduce((n, t) => n + t.stretches.length, 0);

  return `${stretches} stretches, worst ${span.worst.toFixed(3)}, ${ms.toFixed(0)} ms`;
}

describe.skipIf(!process.env.EXPERIMENT)('experiment: fading and groups', () => {
  const SPACING = 20, SEGMENTS = 4;
  const fx = (deform: boolean): Effects => ({
    round: inSegments(SEGMENTS, 20),
    ...(deform ? { deform: { spacing: SPACING, pattern: 'zigzag' as const, seed: 0, sides: 'both' as const, jitter: 0 } } : {}),
  });
  const round = (by: number): Writing => ({ kind: 'round', by });
  const deform = (by: number): Writing => ({ kind: 'deform', by });

  /** The prototype with this section's spacing and segments. */
  function laid(ring: Ring, bevel: number, amplitude: number, teeth: number, arcAmplitude = amplitude): Laid {
    const was = [E, N] as const;

    E = { spacing: SPACING, pattern: 'zigzag', seed: 0, sides: 'both', jitter: 0 };
    N = SEGMENTS;

    const out = roundThenDeform(ring, bevel, amplitude, teeth, arcAmplitude);

    [E, N] = was;

    return out;
  }

  /** How many teeth an arc of a quarter turn gets at `bevel`: one a spacing
   * of its length, less one, as a straight's are. */
  const arcTeeth = (bevel: number) => Math.max(0, Math.floor(bevel * 1.2 / SPACING));

  it('fading: an arc gaining teeth, a straight losing them to the bevel', () => {
    const square: Ring = [{ x: -100, y: -100 }, { x: 100, y: -100 }, { x: 100, y: 100 }, { x: -100, y: 100 }];
    const lines: string[] = [];

    for (const [name, b0, b1, amp, depth] of [
      ['bevel 10 → 40, depth 4', 10, 40, 4, 4],
      ['bevel 10 → 40, depth 0 → 10', 10, 40, 4, -1],
      ['bevel 10 → 60, depth 4', 10, 60, 4, 4],
    ] as [string, number, number, number, number][]) {
      const d0 = depth < 0 ? 0 : depth, d1 = depth < 0 ? 10 : depth;

      const added = addPolygon(emptyWorld(), { level: 'hollow' }, square, 0, TOP);
      let w: World = { ...added.world, effects: new Map([[added.id, fx(true)]]) };

      w = wrote(w, 0, added.id, round(b0), deform(amp), erode(d0));
      w = wrote(w, 1, added.id, round(b1 - b0), erode(d1 - d0));

      // Held: drawn at bevel + depth.
      const l0 = laid(square, b0 + d0, amp, arcTeeth(b0 + d0)), l1 = laid(square, b1 + d1, amp, arcTeeth(b1 + d1));
      const s = seeded(l0, l1);
      const eaten = l0.ids.filter(id => !l1.ids.includes(id)).length, arriving = l1.ids.filter(id => !l0.ids.includes(id)).length;

      // The arcs' teeth coming up out of the curve instead: the far end's
      // count laid at both ends, flat at the near one. Only for a count
      // starting from nought, which these all do.
      const r0 = laid(square, b0 + d0, amp, arcTeeth(b1 + d1), 0);
      const r = seeded(r0, l1);

      const q = seeded(laid(square, b0 + d0, amp, -1), laid(square, b1 + d1, amp, -1));

      lines.push(`${name}: today ${measured(w)} | planned, held, seeded ${measured(plainRoom(s.p0, s.p1, d0, d1))} | rising ${measured(plainRoom(r.p0, r.p1, d0, d1))} | as any other ${measured(plainRoom(q.p0, q.p1, d0, d1))} (${arriving} arriving, ${eaten} eaten, arc teeth ${arcTeeth(b0 + d0)} → ${arcTeeth(b1 + d1)})`);
    }

    console.log(`\nFading:\n${lines.join('\n')}\n`);
  });

  it('how far a tooth spaced along an arc strays from its straight line', () => {
    const square: Ring = [{ x: -100, y: -100 }, { x: 100, y: -100 }, { x: 100, y: 100 }, { x: -100, y: 100 }];
    const lines: string[] = [];

    for (const [b0, b1] of [[10, 40], [20, 25], [30, 40], [40, 60]]) {
      const at = (t: number): Named => {
        const l = laid(square, mix(b0, b1, t), 4, -1);

        return new Map(l.ids.map((id, i) => [id, l.points[i]]));
      };

      const err = midError(at);

      lines.push(`bevel ${b0} → ${b1}: mid-span error ${err.toFixed(3)} at ${JSON.stringify(worstAt)}`);
    }

    console.log(`\nArc teeth as any other, off their lerp half way (tolerance 0.05):\n${lines.join('\n')}\n`);
  });

  it('groups: two rooms, one sliding, the group rounded', () => {
    const rect = (x0: number, y0: number, x1: number, y1: number): Ring => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
    const A = rect(-100, -60, 20, 60), B = rect(-20, -40, 100, 80);
    const slide = { x: 15, y: 20 };
    const Bt = (t: number) => B.map(p => ({ x: p.x + slide.x * t, y: p.y + slide.y * t }));
    const lines: string[] = [];

    /** The union's outer ring at `t`, started at its leftmost-lowest corner so
     * both ends begin at the same one. */
    const union = (t: number): Ring => {
      const out = unionAll([[A], [Bt(t)]]);
      const ring = out.reduce((a, r) => (Math.abs(area(r)) > Math.abs(area(a)) ? r : a));
      const start = ring.reduce((k, p, i) => (p.x < ring[k].x || (p.x === ring[k].x && p.y < ring[k].y) ? i : k), 0);

      return [...ring.slice(start), ...ring.slice(0, start)];
    };

    for (const [name, amp, bevel, depth, fixed, rising] of [
      ['round only', 0, 12, 0],
      ['round, depth 0 → 6', 0, 12, 6],
      ['round and deform', 4, 12, 0],
      ['round, deform, depth 0 → 6', 4, 12, 6],
      ['round, deform, depth 0 → 6, no arc teeth', 4, 12, 6, 0],
      ['round, deform, depth 0 → 6, one arc tooth throughout', 4, 12, 6, 1],
      ['round, deform, depth 0 → 6, arc tooth coming up out of the curve', 4, 12, 6, 1, true],
      ['round, deform, depth 0 → 6, arc teeth as any other', 4, 12, 6, -1],
    ] as [string, number, number, number, number?, boolean?][]) {
      const a = addPolygon(emptyWorld(), { level: 'hollow' }, A, 0, TOP);
      const b = addPolygon(a.world, { level: 'hollow' }, B, 0, TOP);
      const g = grouped(b.world, 0, [a.id, b.id], TOP)!;
      let w = sealing(g.world, g.id, true);

      w = { ...w, effects: new Map([[g.id, fx(amp > 0)]]) };
      w = wrote(w, 0, g.id, round(bevel), ...(amp > 0 ? [deform(amp)] : []));
      w = wrote(w, 1, g.id, erode(depth));
      w = wrote(w, 1, b.id, moved(slide.x, slide.y));

      const u0 = union(0), u1 = union(1);

      expect(u1.length).toBe(u0.length);

      // Held, and the union's arcs with teeth as a polygon's would have.
      const l0 = laid(u0, bevel, amp, fixed ?? (amp > 0 ? arcTeeth(bevel) : 0), rising === true ? 0 : amp);
      const l1 = laid(u1, bevel + depth, amp, fixed ?? (amp > 0 ? arcTeeth(bevel + depth) : 0));
      const flat = amp === 0;
      const strip = (l: Laid): Laid => {
        const keep = l.kind.map(k => !flat || k === 'arc');

        return { points: l.points.filter((_p, i) => keep[i]), ids: l.ids.filter((_d, i) => keep[i]), kind: l.kind.filter((_k, i) => keep[i]) };
      };
      const s = seeded(strip(l0), strip(l1));

      lines.push(`${name}: today ${measured(w)} | planned, held ${measured(plainRoom(s.p0, s.p1, 0, depth))}`);
    }

    console.log(`\nA sealed group of two, ${A.length + B.length} corners, one sliding:\n${lines.join('\n')}\n`);
  });
});

function area(r: Ring): number {
  return r.reduce((s, p, i) => s + p.x * r[(i + 1) % r.length].y - r[(i + 1) % r.length].x * p.y, 0) / 2;
}
