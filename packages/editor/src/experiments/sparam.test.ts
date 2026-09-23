// A diagnostic for PLAN-bevel's step 6, not a test of anything shipped.
//
// Step 6 puts the erosion first and the round after it, and `deformlast`
// reports that a point of the outline no longer keeps its place while the
// depth runs — P3, nought held and 1.1250 eroded first. This file asks
// *where* that comes from, and finds that it is not the teeth at all: it is
// `arcsWith`'s cut-back, `min(want, room either side)`, whose room is the
// eroded wall's length. Eroded first that length runs with the depth, so the
// `min` changes hands partway down a span — one kink a corner, linear either
// side of it and not linear across it. Held, the round is drawn on the source
// ring, whose walls do not move, so the `min` is settled before the span
// starts and nothing strays at all.
//
// **It reports nothing on the branch.** The step 6 attempt is stashed, and
// this measures the shipped pipeline: `git stash apply` it first, or every
// figure below is nought. Run with the rest: `EXPERIMENT=1 pnpm vitest run
// experiments`.
//
// What it found, on the room `deformlast` uses, bevel 12:
//
//   D1  amplitude 0 and amplitude 4 stray exactly the same — the teeth are
//       not in it. Nothing strays at all to a depth of 15.
//   D2  the worst are the arcs' own ends, 1/0 4/0 1/4 4/4: the tangent
//       points, which is where a cut-back bites.
//   D3  every arc holds its length and its chord to a depth of 15 — the
//       eroded ring is the source ring translated wall by wall, so an arc of
//       the radius asked for is rigidly translated and linear in the depth.
//       At 20 two of them have shrunk.
//   D4  a bevel of 4 or 8 strays nought over the same span; 12 strays.
//   D5  each arc's chord bends once, and once only: 18.7 for two of them and
//       22.2 for the other two.

import { describe, expect, it } from 'vitest';
import { Point } from '@ce/game/world';
import { Ring, isCCW } from '../geometry';
import { TOP, addPolygon, imagesOf, resolveAt } from '../scene';
import { Writing, erode, inSegments, wrote } from '../testing';
import { Effects, World, emptyWorld } from '../types';

const SEGMENTS = 4;
const SPACING = 20;

interface Amounts { bevel: number, amplitude: number, depth: number }

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const round = (by: number): Writing => ({ kind: 'round', by });
const deform = (by: number): Writing => ({ kind: 'deform', by });

/** `deformlast`'s room, so the figures line up with its table. */
function room(): Ring {
  const r = [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 130, y: 70 }, { x: 0, y: 60 }];

  return isCCW(r) ? r : r.reverse();
}

function world(ring: Ring, a: Amounts): World {
  const added = addPolygon(emptyWorld(), { level: 'hollow' }, ring, 0, TOP);
  const fx: Effects = {
    round: inSegments(SEGMENTS, 20),
    deform: { spacing: SPACING, pattern: 'zigzag', seed: 0, sides: 'both', jitter: 0 },
  };
  const w: World = { ...added.world, effects: new Map([[added.id, fx]]) };

  return wrote(w, 0, added.id, round(a.bevel), deform(a.amplitude), erode(a.depth));
}

/** Every point of the outline the bake can name: each corner's arc, by the
 * corner's id and which point of the arc it is. */
function named(ring: Ring, a: Amounts): Map<string, Point> {
  const at = resolveAt(world(ring, a), 0)[0];
  const im = imagesOf(at);
  const out = new Map<string, Point>();

  expect(im).not.toBeNull();

  im!.corners.forEach((run, i) => run?.forEach((p, k) => out.set(`${at.corners[i].id}/${k}`, p)));

  return out;
}

/** Each corner's arc, as lengths: how long it is and how far its ends are
 * apart. Rigidly translated, both hold while the depth runs. */
function arcSizes(ring: Ring, a: Amounts): Map<number, { length: number, chord: number }> {
  const at = resolveAt(world(ring, a), 0)[0];
  const im = imagesOf(at);
  const out = new Map<number, { length: number, chord: number }>();

  im!.corners.forEach((run, i) => {
    if (run === null || run.length < 2) return;

    let length = 0;

    for (let k = 1; k < run.length; k++) length += Math.hypot(run[k].x - run[k - 1].x, run[k].y - run[k - 1].y);

    const a0 = run[0], b0 = run[run.length - 1];

    out.set(at.corners[i].id, { length, chord: Math.hypot(b0.x - a0.x, b0.y - a0.y) });
  });

  return out;
}

const lerpP = (a: Point, b: Point, t: number) => ({ x: mix(a.x, b.x, t), y: mix(a.y, b.y, t) });

/** How far the worst point strays from the straight line between where it
 * starts and where it ends, over the whole span — `deformlast`'s P3. */
function strays(at: (t: number) => Map<string, Point>, steps = 16): { worst: number, name: string, t: number } {
  const p0 = at(0), p1 = at(1);
  let worst = 0, name = '', when = 0;

  for (let k = 1; k < steps; k++) {
    const t = k / steps, now = at(t);

    for (const [id, p] of now) {
      const a = p0.get(id), b = p1.get(id);

      if (a === undefined || b === undefined) continue;

      const off = Math.hypot(p.x - lerpP(a, b, t).x, p.y - lerpP(a, b, t).y);

      if (off > worst) { worst = off; name = id; when = t; }
    }
  }

  return { worst, name, t: when };
}

const report: string[] = [];
const log = (line: string) => { report.push(line); };

describe.skipIf(!process.env.EXPERIMENT)('diagnostic: where erode-first strays', () => {
  it('D1: how far the straying starts down the depth', () => {
    for (const to of [5, 10, 15, 20, 30]) {
      for (const amplitude of [0, 4]) {
        const s = strays(t => named(room(), { bevel: 12, amplitude, depth: mix(0, to, t) }));

        log(`D1 depth 0 → ${to}, amplitude ${amplitude}: ${s.worst.toFixed(4)} at ${s.name}, t ${s.t.toFixed(3)}`);
      }
    }
  });

  it('D2: which points stray, over the span the table measures', () => {
    const amounts = (t: number): Amounts => ({ bevel: 12, amplitude: 4, depth: mix(0, 20, t) });
    const p0 = named(room(), amounts(0)), p1 = named(room(), amounts(1));
    const worst = new Map<string, number>();

    for (let k = 1; k < 16; k++) {
      const t = k / 16;

      for (const [id, p] of named(room(), amounts(t))) {
        const a = p0.get(id), b = p1.get(id);

        if (a === undefined || b === undefined) continue;

        const off = Math.hypot(p.x - lerpP(a, b, t).x, p.y - lerpP(a, b, t).y);

        worst.set(id, Math.max(worst.get(id) ?? 0, off));
      }
    }

    const sorted = [...worst].sort((a, b) => b[1] - a[1]);

    log(`D2 depth 0 → 20, amplitude 4: ${sorted.length} points named at every instant`);
    sorted.slice(0, 8).forEach(([id, off]) => log(`D2   ${id}: ${off.toFixed(4)}`));
  });

  it('D3: is an arc rigidly translated as the depth runs?', () => {
    for (const depth of [0, 5, 10, 15, 20]) {
      const sizes = arcSizes(room(), { bevel: 12, amplitude: 0, depth });
      const shown = [...sizes].map(([id, s]) => `${id}: ${s.length.toFixed(3)}/${s.chord.toFixed(3)}`).join('  ');

      log(`D3 depth ${depth}, length/chord per arc — ${shown}`);
    }
  });

  it('D4: is it the bevel being cut back to fit the wall?', () => {
    // `arcsWith` takes each corner's cut-back as `min(want, room either
    // side)`, and the room is the *eroded* wall's length. Eroded first that
    // length runs with the depth, so the `min` changes hands partway down a
    // span — a kink, linear either side of it and not linear across it. Held,
    // the round is drawn on the source ring, whose walls do not move, so the
    // `min` is settled before the span starts.
    //
    // If that is the whole of it: a bevel small enough never to be cut back
    // strays nothing, and a span lying wholly past the changeover strays
    // nothing either.
    for (const bevel of [4, 8, 12]) {
      const s = strays(t => named(room(), { bevel, amplitude: 4, depth: mix(0, 20, t) }));

      log(`D4 bevel ${bevel}, depth 0 → 20: ${s.worst.toFixed(4)} at ${s.name}, t ${s.t.toFixed(3)}`);
    }

    for (const [from, to] of [[0, 15], [16, 20], [18, 20], [20, 30], [22, 30]]) {
      const s = strays(t => named(room(), { bevel: 12, amplitude: 4, depth: mix(from, to, t) }));

      log(`D4 bevel 12, depth ${from} → ${to}: ${s.worst.toFixed(4)} at ${s.name}, t ${s.t.toFixed(3)}`);
    }
  });

  it('D5: the cut-back down the depth, finely', () => {
    // If the cut-back is `min` of things linear in the depth, each arc's
    // chord is piecewise linear in it and every kink is a changeover. Read
    // the second difference: nought along a piece, and the size of the kink
    // where one ends.
    const chords = new Map<number, number[]>();
    const depths: number[] = [];

    for (let k = 0; k <= 28; k++) {
      const depth = 15 + k * 0.5;

      depths.push(depth);

      for (const [id, s] of arcSizes(room(), { bevel: 12, amplitude: 0, depth })) {
        if (!chords.has(id)) chords.set(id, []);

        chords.get(id)!.push(s.chord);
      }
    }

    for (const [id, cs] of chords) {
      const bends = cs.map((_c, k) => (k === 0 || k === cs.length - 1 ? 0 : cs[k - 1] - 2 * cs[k] + cs[k + 1]));
      const where = bends.flatMap((b, k) => (Math.abs(b) > 1e-6 ? [`${depths[k]}:${b.toFixed(3)}`] : []));

      log(`D5 arc ${id}: chord ${cs[0].toFixed(3)} → ${cs[cs.length - 1].toFixed(3)}, bends at ${where.length === 0 ? 'none' : where.join(' ')}`);
    }
  });

  it('prints', () => {
    console.log(`\n${report.join('\n')}\n`);
    expect(report.length).toBeGreaterThan(0);
  });
});
