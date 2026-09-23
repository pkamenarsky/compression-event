// An experiment for PLAN-bevel.md phase 3, not a test of anything shipped:
// round → erode → deform, measured against the shipped round → deform → erode
// before the pipeline is moved.
//
// "Today" here is the real thing — `resolveAt` and `imagesOf` — since phase 1
// made the shipped order the plan's own. "Last" is a prototype of phase 3:
// the ring rounded, eroded, and only then toothed, each run anchored at its
// source edge's middle pushed out by the depth (PLAN-bevel 3.1). The pinch of
// 3.2 is off, as the order of work says to measure it.
//
// Not run with the rest: `EXPERIMENT=1 pnpm vitest run experiments` runs it.
// It prints what it finds; the few assertions are only that what it measures
// is there to be measured.

import { describe, expect, it } from 'vitest';
import { Point } from '@ce/game/world';
import { Effecting, Ring, SQUARE, erodedCorners, foldShaped, isCCW, keeping, patternRun, rounded } from '../geometry';
import { TOP, addPolygon, imagesOf, namesOf, resolveAt } from '../scene';
import { Writing, erode, inSegments, wrote } from '../testing';
import { Effects, World, emptyWorld } from '../types';

const SEGMENTS = 4;
const TENSION = 0.5;
const SPACING = 20;
const E: Effecting = { spacing: SPACING, pattern: 'zigzag', seed: 0, sides: 'both', jitter: 0, falloff: 0, offset: false };

/** A point of an outline, by a name that is the same at every instant: what
 * the bake carries across a span. */
type Named = Map<string, Point>;

interface Amounts { bevel: number, amplitude: number, depth: number }

/** How an arc's teeth are held as the erosion changes its radius: marched out
 * from its middle by the spacing, or at the fractions the arc as drawn gives
 * them. See `last`. */
type ArcMode = 'length' | 'u'

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const round = (by: number): Writing => ({ kind: 'round', by });
const deform = (by: number): Writing => ({ kind: 'deform', by });

/** A room: a long rectangle with one corner pushed out, so no two corners are
 * alike. Wound counter-clockwise, so out of the material is to the right. */
function room(nudge = 0): Ring {
  const r = [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 130 + nudge, y: 70 + nudge / 2 }, { x: 0, y: 60 }];

  return isCCW(r) ? r : r.reverse();
}

// -----------------------------------------------------------------------------
// Today: the shipped pipeline, read by name
// -----------------------------------------------------------------------------

/** The room with its effects written, at one set of amounts. */
function world(ring: Ring, a: Amounts, held = false): World {
  const added = addPolygon(emptyWorld(), { level: 'hollow' }, ring, 0, TOP);
  const fx: Effects = {
    round: { ...inSegments(SEGMENTS, 20), held },
    deform: { spacing: SPACING, pattern: 'zigzag', seed: 0, sides: 'both', jitter: 0 },
  };
  const w: World = { ...added.world, effects: new Map([[added.id, fx]]) };

  return wrote(w, 0, added.id, round(a.bevel), deform(a.amplitude), erode(a.depth));
}

/**
 * Where today's outline puts each of its points: every corner of `Resolved`
 * — drawn corners and the teeth the deform made of them — named by its id and
 * which point of its arc it is, which is exactly what the bake carries.
 */
function today(ring: Ring, a: Amounts, held = false): Named {
  const at = resolveAt(world(ring, a, held), 0)[0];
  const im = imagesOf(at);
  const out: Named = new Map();

  expect(im).not.toBeNull();

  im!.corners.forEach((run, i) => run?.forEach((p, k) => out.set(`${at.corners[i].id}/${k}`, p)));

  return out;
}

// -----------------------------------------------------------------------------
// Last: the round eroded, and the teeth laid on what comes out
// -----------------------------------------------------------------------------

const unit = (p: Point, q: Point) => {
  const l = Math.hypot(q.x - p.x, q.y - p.y);

  return { x: (q.x - p.x) / l, y: (q.y - p.y) / l, l };
};

/** A polyline's length, and where a fraction of it lands with the outward
 * normal there. Out of the material is to the right of the way round. */
function walk(points: readonly Point[]): { length: number, at: (f: number) => { p: Point, n: Point } } {
  const legs = points.slice(1).map((q, i) => unit(points[i], q));
  const length = legs.reduce((s, l) => s + l.l, 0);

  return {
    length,
    at: (f: number) => {
      let want = f * length;

      for (let i = 0; i < legs.length; i++) {
        if (want <= legs[i].l || i === legs.length - 1) {
          const d = legs[i];

          return { p: { x: points[i].x + d.x * want, y: points[i].y + d.y * want }, n: { x: d.y, y: -d.x } };
        }

        want -= legs[i].l;
      }

      return { p: points[0], n: { x: 0, y: 0 } };
    },
  };
}

/** Where a point falls along a run, as a length from its start: the anchor a
 * straight takes, its source edge's middle pushed out by the depth landing on
 * the run's own line. */
function alongFrom(points: readonly Point[], p: Point): number {
  const d = unit(points[0], points[points.length - 1]);

  return (p.x - points[0].x) * d.x + (p.y - points[0].y) * d.y;
}

/**
 * Phase 3's order: the ring rounded as drawn, eroded, and the teeth laid on
 * what comes out — one kind of run, straights and arcs alike, each anchored
 * where its source says rather than at its own middle.
 */
function last(ring: Ring, a: Amounts, arcs_: ArcMode = 'length', seg = SEGMENTS, held = false): Named {
  const n = ring.length;

  // Held, a corner is drawn at its bevel and as much again as the erosion
  // takes back off it, so what comes out is the bevel asked for: see
  // `drawnBevels`.
  const arcs = rounded(ring, () => (held ? a.bevel + a.depth : a.bevel), seg, TENSION);
  const eroded = erodedCorners(arcs, a.depth);
  const out: Named = new Map();
  const arcOf = (i: number) => eroded.slice(i * (seg + 1), (i + 1) * (seg + 1));

  // The arcs themselves: points of the outline like any other.
  for (let i = 0; i < n; i++) arcOf(i).forEach((p, k) => out.set(`arc ${i}/${k}`, p));

  const lay = (name: string, key: number, points: Point[], from: number) => {
    const w = walk(points);
    const run = patternRun(E, key, a.amplitude, w.length, 0, 0, E.spacing, from);

    run.along.forEach((f, k) => {
      const { p, n: nrm } = w.at(f);
      const h = run.across[k];

      out.set(`${name}:${run.teeth[k]}`, { x: p.x + nrm.x * h, y: p.y + nrm.y * h });
    });
  };

  for (let i = 0; i < n; i++) {
    const mine = arcOf(i), theirs = arcOf((i + 1) % n);
    const straight = [mine[mine.length - 1], theirs[0]];

    // The source edge's middle, pushed out by the depth: its coordinate along
    // the run does not move with the depth, so no tooth slides.
    const j = (i + 1) % n;
    const middle = { x: (ring[i].x + ring[j].x) / 2, y: (ring[i].y + ring[j].y) / 2 };

    lay(`straight ${i}`, i, straight, alongFrom(straight, middle));

    // An arc offset by the depth is a concentric arc: its middle does not
    // move, but its *length* does, so a tooth marched out from the middle by
    // the spacing slides as the radius changes. `u` lays them on the arc as
    // drawn and carries the fractions over, which holds them still and lets
    // the spacing drift with the radius instead.
    if (a.bevel > 0) {
      const key = i ^ 0x5bd1e995;

      if (arcs_ === 'length') {
        lay(`arc ${i}`, key, mine, walk(mine).length / 2);
      }
      else {
        const drawn = arcs.slice(i * (seg + 1), (i + 1) * (seg + 1));
        const w = walk(drawn), on = walk(mine);
        const run = patternRun(E, key, a.amplitude, w.length, 0, 0, E.spacing, w.length / 2);

        run.along.forEach((f, k) => {
          const { p, n: nrm } = on.at(f);
          const h = run.across[k];

          out.set(`arc ${i}:${run.teeth[k]}`, { x: p.x + nrm.x * h, y: p.y + nrm.y * h });
        });
      }
    }
  }

  return out;
}

/**
 * The route 3.1 proposes, in shipped code: the polygon resolved with its round
 * alone, and its eroded shape handed to `foldShaped` with the names `namesOf`
 * gives it, no bevel and no depth — so all it does is name the runs and lay
 * the teeth.
 */
function viaFold(ring: Ring, a: Amounts, held = false, reach = false): { points: number, rings: number, ring: Point[] } {
  const w = world(ring, { ...a, amplitude: 0 }, held);
  const at = resolveAt(w, 0)[0];
  const names = namesOf(at);

  // The arcs `namesOf` used to report, which a member no longer publishes:
  // see PLAN-bevel's step 1. This route is about handing the fold arcs it
  // must leave alone, so it asks the projection for them itself.
  const im = imagesOf(at);
  const curves = (im?.corners ?? [])
    .flatMap((run, i) => (run === null || run.length < 2 ? [] : [{ id: at.corners[i].id, points: run }]));

  // Each source edge's half length, by the corner that names it.
  const halves = new Map<number, number>();

  at.corners.forEach((c, i) => {
    const q = at.source[(i + 1) % at.source.length];

    halves.set(c.id, Math.hypot(q.x - at.source[i].x, q.y - at.source[i].y) / 2);
  });
  const out = foldShaped(
    at.shape,
    [],
    [],
    names.lines,
    curves,
    SQUARE,
    0,
    false,
    {
      e: E,
      amplitude: () => a.amplitude,

      // Half the edge as *drawn* — the source's, which the erosion does not
      // change — so the same teeth are laid at every depth: PLAN-bevel 3.6
      // piece 3. Read off the ring rather than off `namesOf`, which reports a
      // line where the erosion put it.
      reach,
    },
    0,
  );

  // As `resolves` does it: the flat teeth are simplified out of the shape and
  // put back by the caller, which is what keeps the ring its length while the
  // deform comes up out of nothing. See `FoldShaped.fades`.
  const held_ = out.fades.filter(f => f.v === 0).map(f => f.p);
  const shape = held_.length === 0 ? out.shape : keeping(out.shape, held_);

  return { points: shape.reduce((n, r) => n + r.length, 0), rings: shape.length, ring: shape[0] ?? [] };
}

// -----------------------------------------------------------------------------
// Measuring
// -----------------------------------------------------------------------------

const lerpP = (p: Point, q: Point, t: number) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });

/** How far the middle of a span is from the lerp of its ends, point by point:
 * what the bake has to cut a stretch finer for. */
function midError(at: (t: number) => Named): { worst: number, of: number, name: string } {
  const p0 = at(0), p1 = at(1), pm = at(0.5);
  const both = [...pm.keys()].filter(k => p0.has(k) && p1.has(k));

  expect(both.length).toBeGreaterThan(0);

  const errs = both.map(k => {
    const q = lerpP(p0.get(k)!, p1.get(k)!, 0.5), p = pm.get(k)!;

    return Math.hypot(p.x - q.x, p.y - q.y);
  });
  const at_ = errs.indexOf(Math.max(...errs));

  return { worst: errs[at_], of: pm.size, name: both[at_] };
}

const report: string[] = [];
const log = (s: string) => report.push(s);

describe.skipIf(!process.env.EXPERIMENT)('experiment: round → erode → deform', () => {
  const cases: [string, (t: number) => Amounts][] = [
    ['depth 0 → 5', t => ({ bevel: 10, amplitude: 2, depth: mix(0, 5, t) })],
    ['depth 0 → 20', t => ({ bevel: 12, amplitude: 4, depth: mix(0, 20, t) })],
    ['bevel 4 → 14', t => ({ bevel: mix(4, 14, t), amplitude: 2, depth: 4 })],
    ['amplitude 0 → 3', t => ({ bevel: 10, amplitude: mix(0, 3, t), depth: 4 })],
    ['amplitude 1 → 6', t => ({ bevel: 12, amplitude: mix(1, 6, t), depth: 6 })],
    ['bevel and depth, no teeth', t => ({ bevel: mix(4, 14, t), amplitude: 0, depth: mix(0, 5, t) })],
    ['all three', t => ({ bevel: mix(4, 14, t), amplitude: mix(0, 3, t), depth: mix(0, 5, t) })],
  ];

  it('P1: how far the middle of a span is from the lerp of its ends', () => {
    for (const [name, amounts] of cases) {
      const a = midError(t => today(room(), amounts(t)));
      const b = midError(t => last(room(), amounts(t)));
      const c = midError(t => last(room(), amounts(t), 'u'));

      log(`P1 ${name}: today ${a.worst.toFixed(4)} (${a.name}), last ${b.worst.toFixed(4)} (${b.name}), last by u ${c.worst.toFixed(4)} (${c.name})`);
    }
  });

  it('P2: a corner moving', () => {
    const a = midError(t => today(room(mix(0, 30, t)), { bevel: 10, amplitude: 2, depth: 4 }));
    const b = midError(t => last(room(mix(0, 30, t)), { bevel: 10, amplitude: 2, depth: 4 }));

    log(`P2 a corner moving 30: today ${a.worst.toFixed(4)} (${a.name}), last ${b.worst.toFixed(4)} (${b.name})`);
  });

  it('P3: a tooth keeps its place while the depth runs', () => {
    // The claim 3.1 stands on: anchored at the source edge's middle pushed
    // out, a tooth moves along its own normal and nothing else. Measured as
    // how far each tooth strays from its own straight line over the span.
    const strays = (at: (t: number) => Named): number => {
      const p0 = at(0), p1 = at(1);
      let worst = 0;

      for (let k = 1; k < 16; k++) {
        const t = k / 16, now = at(t);

        for (const [id, p] of now) {
          const a = p0.get(id), b = p1.get(id);

          if (a === undefined || b === undefined) continue;

          const q = lerpP(a, b, t);

          worst = Math.max(worst, Math.hypot(p.x - q.x, p.y - q.y));
        }
      }

      return worst;
    };
    const amounts = (t: number): Amounts => ({ bevel: 12, amplitude: 4, depth: mix(0, 20, t) });

    log(`P3 depth 0 → 20, every instant: today ${strays(t => today(room(), amounts(t))).toFixed(4)}, last ${strays(t => last(room(), amounts(t))).toFixed(4)}, last by u ${strays(t => last(room(), amounts(t), 'u')).toFixed(4)}`);
  });

  it('P4: how many points each order carries at depth', () => {
    for (const depth of [0, 6, 20, 40]) {
      const a = { bevel: 12, amplitude: 6, depth };

      log(`P4 depth ${depth}: today ${today(room(), a).size} points, last ${last(room(), a).size}`);
    }
  });

  it('P5: is the arc tooth the order, or the polyline it stands on?', () => {
    // A tooth here is put on the arc's polyline and pushed along the segment's
    // own normal, which is the naive laying phase 1 found wanting. If the
    // residual is that and not the order, it falls away as the arc is drawn
    // finer.
    const amounts = (t: number): Amounts => ({ bevel: 12, amplitude: 4, depth: mix(0, 20, t) });

    for (const seg of [2, 4, 8, 16, 32]) {
      const b = midError(t => last(room(), amounts(t), 'length', seg));

      log(`P5 depth 0 → 20, ${seg} segments an arc: last ${b.worst.toFixed(4)} (${b.name})`);
    }
  });

  it('P6: held, so the arc is never eroded past its radius', () => {
    for (const [name, amounts] of cases) {
      const a = midError(t => today(room(), amounts(t), true));
      const b = midError(t => last(room(), amounts(t), 'length', SEGMENTS, true));

      log(`P6 ${name}, held: today ${a.worst.toFixed(4)} (${a.name}), last ${b.worst.toFixed(4)} (${b.name})`);
    }
  });

  it('P7: foldShaped lays a polygon\'s teeth on its eroded outline', () => {
    // The route of 3.1, in shipped code: if this names the runs and lays the
    // teeth, wiring `imagedBy` to it is mechanical.
    for (const depth of [0, 6, 20]) {
      for (const amplitude of [0, 4]) {
        const a = { bevel: 12, amplitude, depth };
        const got = viaFold(room(), a);
        const plain = viaFold(room(), { ...a, amplitude: 0 });

        log(`P7 depth ${depth}, amplitude ${amplitude}: ${got.rings} ring(s), ${got.points} points (undeformed ${plain.points})`);
        expect(got.rings).toBeGreaterThan(0);
      }
    }
  });

  it('P8: through foldShaped, a tooth keeps its place while the depth runs', () => {
    // The same span as P3, but laid by the shipped code the wiring will use.
    // Where the outline keeps its point count, index is identity, so the two
    // ends can be compared point for point.
    const amounts = (t: number): Amounts => ({ bevel: 12, amplitude: 4, depth: mix(0, 8, t) });
    const held = true;

    for (const reach of [false, true]) {
      const ends = [viaFold(room(), amounts(0), held, reach), viaFold(room(), amounts(1), held, reach)];

      log(`P8 depth 0 → 8, held, reach ${reach}: ${ends[0].points} points at one end, ${ends[1].points} at the other`);

      if (ends[0].points !== ends[1].points) continue;

      let worst = 0, moved = false;

      for (let k = 1; k < 16 && !moved; k++) {
        const t = k / 16, now = viaFold(room(), amounts(t), held, reach);

        if (now.points !== ends[0].points) {
          log(`P8   the count moves to ${now.points} at t ${t.toFixed(2)}`);
          moved = true;
          continue;
        }

        now.ring.forEach((p, i) => {
          const q = lerpP(ends[0].ring[i], ends[1].ring[i], t);

          worst = Math.max(worst, Math.hypot(p.x - q.x, p.y - q.y));
        });
      }

      if (!moved) log(`P8   worst from the lerp of the two ends, every instant: ${worst.toFixed(4)}`);
    }
  });

  it('P9: where the points go as the depth runs', () => {
    for (const held of [false, true]) {
      for (const depth of [0, 2, 4, 6, 8]) {
        const plain = viaFold(room(), { bevel: 12, amplitude: 0, depth }, held, true);
        const toothed = viaFold(room(), { bevel: 12, amplitude: 4, depth }, held, true);

        log(`P9 held ${held}, depth ${depth}: undeformed ${plain.points}, deformed ${toothed.points} (teeth ${toothed.points - plain.points})`);
      }
    }
  });

  it('prints', () => {
    console.log(`\n${report.join('\n')}\n`);
    expect(report.length).toBeGreaterThan(0);
  });
});
