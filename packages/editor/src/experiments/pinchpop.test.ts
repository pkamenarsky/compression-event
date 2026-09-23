// A diagnostic for PLAN-bevel's step 6: the pop in `bake.test.ts`'s 'rounded
// as well, its outline never pops', which the fold route brings and which has
// no erosion in it at all — so the order cannot be what breaks it.
//
// Needs the step 6 attempt applied (`git stash apply`); on the branch it
// measures the shipped pipeline, which does not pop.
//
// Run with the rest: `EXPERIMENT=1 pnpm vitest run experiments`.
//
// What it found. **The pop is not new and the shape never splits.**
//
//   Q1  the four rings the first probe saw are `truth`'s *runs*, not rings:
//       11, 26, 2 and 3 points, closing to one run of 37. `Frame` is what the
//       outline is drawn as, and a wall going out of sight splits it.
//   Q5  the same spike drawn outright and resolved at rest is one ring at
//       every size, 28 through 34 points. Nothing comes apart.
//   Q6  what moves is one point, the tooth standing past the spike's tip:
//       (0.83, -156.70) at `t` 0.6925 and (-0.81, -156.90) at 0.6950. That
//       1.64 is the whole of the 1.6489 step.
//   Q7  and the instant is the one already parked. Deform alone pops 0.8459
//       at `t` 0.6950 — *the same figure on the branch and eroded first* —
//       which is 3.9's 'a corner arriving on a deformed floor', parked at
//       0.85 against a bar of 0.5. The step scales with the amplitude (1 →
//       0.4918, 5 → 1.6489). What differs is the bevel: on the branch more of
//       it *quiets* the event (bevel 2 → 0.4096, 10 → 0.3140, and the worst
//       step moves off to a benign 0.7075), and eroded first more of it
//       amplifies (2 → 1.0114, 10 → 1.6489).
//
// So the round is not masking a fold-route fault eroded first; it is failing
// to mask the parked one. `clear` is not the reason — instrumented,
// `foldShaped` owns all five corners at that instant and clears 10 either
// side of every run. The teeth are off the arcs. It is the arriving corner
// and a tooth of the far naming crossing, exactly as 3.9 says, with the arc
// endpoints moving with it.

import { describe, expect, it } from 'vitest';
import { Point } from '@ce/game/world';
import { truth } from '../bake';
import { TOP, addPolygon, addVertex, resolveAt, rigOf, withRig } from '../scene';
import { nudged } from '../rig';
import { Writing, inSegments, wrote } from '../testing';
import { Effects, PolygonId, World, emptyWorld } from '../types';
import { Shape } from '../geometry';
import { imagesOf } from '../scene';

const ROUND: Effects = { round: inSegments(4, 20) };
const ZIGZAG: Effects['deform'] = { spacing: 66, pattern: 'zigzag', seed: 0, sides: 'both', jitter: 0 };
const round = (by: number): Writing => ({ kind: 'round', by });
const deform = (by: number): Writing => ({ kind: 'deform', by });

const rect = (x: number, y: number, w: number, h: number): Point[] =>
  [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];

function room(fx: Effects): { world: World, id: PolygonId } {
  const added = addPolygon(emptyWorld(), { level: 'hollow' }, rect(-100, -100, 200, 200), 0, TOP);

  return { world: { ...added.world, effects: new Map([[added.id, fx]]) }, id: added.id };
}

/** `bake.test.ts`'s own: a room with a corner arriving on its deformed floor
 * at v1, pulled out of it. */
function arriving(fx: Effects, ...ops: Writing[]): World {
  const { world, id } = room(fx);
  const w0 = wrote(world, 0, id, ...ops);
  const it = resolveAt(w0, 1).find(r => r.id === id)!;
  const grown = addVertex(w0, 1, it, 0, { x: 0, y: -100 }).world;
  const now = resolveAt(grown, 1).find(r => r.id === id)!;
  const where = now.corners.findIndex(c => c.birth === 1);

  return withRig(grown, id, nudged(rigOf(grown, id), now.corners[where].id, 1, { x: 0, y: -80 }));
}

const report: string[] = [];
const log = (line: string) => { report.push(line); };

describe.skipIf(!process.env.EXPERIMENT)('diagnostic: the fold route pinches', () => {
  it('Q1: what the outline is either side of the pop', () => {
    const w = arriving({ ...ROUND, deform: ZIGZAG }, round(10), deform(5));

    for (let i = 272; i <= 282; i++) {
      const t = i / 400;
      const f = truth(w, 0, t);

      log(`Q1 t ${t.toFixed(4)}: ${f.length} ring(s), ${f.map(r => r.points.length).join(',')} points`);
    }
  });

  it('Q2: the slivers themselves', () => {
    const w = arriving({ ...ROUND, deform: ZIGZAG }, round(10), deform(5));
    const t = 277 / 400;
    const f = truth(w, 0, t);

    f.forEach((r, k) => {
      if (r.points.length > 6) {
        log(`Q2 ring ${k}: ${r.points.length} points, skipped`);

        return;
      }

      log(`Q2 ring ${k}: ${r.points.map(p => `(${p.x.toFixed(3)}, ${p.y.toFixed(3)})`).join(' ')}`);
    });
  });

  it('Q3: does the round alone do it, or the deform, or the two?', () => {
    const cases: [string, Effects, Writing[]][] = [
      ['round alone', ROUND, [round(10)]],
      ['deform alone', { deform: ZIGZAG }, [deform(5)]],
      ['both', { ...ROUND, deform: ZIGZAG }, [round(10), deform(5)]],
    ];

    for (const [name, fx, ops] of cases) {
      const w = arriving(fx, ...ops);
      let worst = 0, when = 0, rings = '';

      for (let i = 0; i <= 400; i++) {
        const f = truth(w, 0, i / 400);

        if (f.length > worst) { worst = f.length; when = i / 400; rings = f.map(r => r.points.length).join(','); }
      }

      log(`Q3 ${name}: most rings ${worst} at t ${when.toFixed(4)} (${rings})`);
    }
  });

  it('Q5: the spike drawn outright, so the shape can be asked at every step', () => {
    // `resolveAt` takes a keyframe, so the span cannot be sampled through it.
    // The same geometry instead: the room with a fifth corner on its top wall,
    // pushed out from lying flat on it to eighty beyond, and resolved at rest.
    const spike = (out: number): Shape => {
      const ring = [
        { x: -100, y: -100 }, { x: 0, y: -100 - out }, { x: 100, y: -100 },
        { x: 100, y: 100 }, { x: -100, y: 100 },
      ];
      const added = addPolygon(emptyWorld(), { level: 'hollow' }, ring, 0, TOP);
      const w: World = { ...added.world, effects: new Map([[added.id, { ...ROUND, deform: ZIGZAG }]]) };
      const at = resolveAt(wrote(w, 0, added.id, round(10), deform(5)), 0)[0];

      return imagesOf(at)?.shape ?? [];
    };

    for (const out of [0, 20, 40, 50, 55, 60, 65, 70, 80]) {
      const s = spike(out);

      log(`Q5 out ${out}: ${s.length} ring(s), ${s.map(r => r.length).join(',')} points`);
    }
  });

  it('Q6: the tip, either side of the step', () => {
    const w = arriving({ ...ROUND, deform: ZIGZAG }, round(10), deform(5));

    for (const t of [277 / 400, 278 / 400]) {
      const f = truth(w, 0, t);

      f.forEach((r, k) => {
        const near = r.points.flatMap((p, i) => (p.y < -140 ? [`${i}:(${p.x.toFixed(2)}, ${p.y.toFixed(2)})`] : []));

        if (near.length > 0) log(`Q6 t ${t.toFixed(4)} run ${k} of ${r.points.length}: ${near.join(' ')}`);
      });
    }
  });

  it('Q7: the worst step, by what is written', () => {
    const segments = (f: ReturnType<typeof truth>) => f.flatMap(r => r.points.slice(1).map((q, i) => [r.points[i], q] as const));
    const off = (p: Point, f: ReturnType<typeof truth>) => Math.min(...segments(f).map(([a, c]) => {
      const dx = c.x - a.x, dy = c.y - a.y, l2 = dx * dx + dy * dy;
      const u = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));

      return Math.hypot(a.x + dx * u - p.x, a.y + dy * u - p.y);
    }));
    const apart = (a: ReturnType<typeof truth>, c: ReturnType<typeof truth>) =>
      Math.max(...a.flatMap(r => r.points.map(p => off(p, c))), ...c.flatMap(r => r.points.map(p => off(p, a))));
    const cases: [string, Effects, Writing[]][] = [
      ['round alone', ROUND, [round(10)]],
      ['deform alone', { deform: ZIGZAG }, [deform(5)]],
      ['both', { ...ROUND, deform: ZIGZAG }, [round(10), deform(5)]],
      ['both, bevel 2', { ...ROUND, deform: ZIGZAG }, [round(2), deform(5)]],
      ['both, amplitude 1', { ...ROUND, deform: ZIGZAG }, [round(10), deform(1)]],
    ];

    for (const [name, fx, ops] of cases) {
      const w = arriving(fx, ...ops);
      let worst = 0, when = 0;
      let was = truth(w, 0, 0);

      for (let i = 1; i <= 400; i++) {
        const now = truth(w, 0, i / 400);
        const d = apart(was, now);

        if (d > worst) { worst = d; when = i / 400; }
        was = now;
      }

      log(`Q7 ${name}: worst step ${worst.toFixed(4)} at t ${when.toFixed(4)}`);
    }
  });

  it('prints', () => {
    console.log(`\n${report.join('\n')}\n`);
    expect(report.length).toBeGreaterThan(0);
  });
});
