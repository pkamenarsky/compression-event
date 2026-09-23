// The question step 6's cure depends on, asked before either cure is built.
//
// `arcsWith` cuts a bevel back by the room the eroded wall has, so eroded
// first the `min` changes hands partway down a span: one kink a corner. P1 and
// P3 measure how far the middle of a span is from the lerp of its *two ends*,
// and a kink fails that by construction. The bake does not interpolate a span
// from its two ends: it bisects until the chord is inside the tolerance, and a
// kink is continuous, so bisection converges on it.
//
// So: what does the kink actually cost the bake?
//
// **Nothing that shows.** Nothing is strained, on either pipeline, at any
// depth to hand, and every `worst` is inside `TOLERANCE`. The one figure worth
// watching is the deepest toothed span eroded first, 0.0476 against 0.05 —
// and that span is carrying 83 points where the branch carries 24, so it is
// the outline being kept that is dear, not the kink.
//
// Eroded first costs more stretches wherever it keeps more points: toothed,
// 111 / 147 / 245 / 330 against 73 / 126 / 174 / 245. The `truth at ½` count
// beside each figure is the guard that says the two pipelines are really
// drawing different outlines — without it an earlier run of this file
// reported the two as identical, which they are not.
//
// Needs the step 6 attempt applied (`git stash apply`) for the eroded-first
// figures; on the branch it reports the held pipeline.
//
// Run with the rest: `EXPERIMENT=1 pnpm vitest run experiments`.

import { describe, expect, it } from 'vitest';
import { Point } from '@ce/game/world';
import { TOLERANCE, bakeSpan, sample, truth } from '../bake';
import { TOP, addPolygon } from '../scene';
import { Writing, erode, inSegments, wrote } from '../testing';
import { Effects, World, emptyWorld } from '../types';

const SEGMENTS = 4;
const round = (by: number): Writing => ({ kind: 'round', by });
const deform = (by: number): Writing => ({ kind: 'deform', by });

/** `deformlast`'s room, so the figures line up with its table: the kinks are
 * at a depth of 18.69 and 22.10. */
const ROOM: Point[] = [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 130, y: 70 }, { x: 0, y: 60 }];

function run<T>(g: Generator<number, T, void>): T {
  let step = g.next();

  while (!step.done) step = g.next();

  return step.value;
}

/** The room with a span from no erosion to `depth`, rounded and toothed. */
function spanning(depth: number, bevel: number, amplitude: number): World {
  const added = addPolygon(emptyWorld(), { level: 'hollow' }, ROOM, 0, TOP);
  const fx: Effects = {
    round: inSegments(SEGMENTS, 20),
    deform: { spacing: 20, pattern: 'zigzag', seed: 0, sides: 'both', jitter: 0 },
  };
  const w: World = { ...added.world, effects: new Map([[added.id, fx]]) };
  const at0 = wrote(w, 0, added.id, round(bevel), deform(amplitude), erode(0));

  return wrote(at0, 1, added.id, erode(depth));
}

const report: string[] = [];
const log = (line: string) => { report.push(line); };

describe.skipIf(!process.env.EXPERIMENT)('what the cut-back kink costs the bake', () => {
  it('K1: stretches and error, over spans that cross a kink and spans that do not', () => {
    // 15 clears both kinks, 20 crosses the first, 30 crosses both.
    for (const depth of [15, 20, 30, 40]) {
      for (const [name, bevel, amplitude] of [['plain', 12, 0], ['toothed', 12, 4], ['small bevel', 4, 4]] as const) {
        const span = run(bakeSpan(spanning(depth, bevel, amplitude), 0));
        const stretches = span.tracks.reduce((n, t) => n + t.stretches.length, 0);
        const jumps = span.tracks.reduce((n, t) => n + t.jumps.length, 0);

        const w = spanning(depth, bevel, amplitude);
        const mid = truth(w, 0, 0.5).reduce((n, r) => n + r.points.length, 0);

        log(`K1 depth 0 → ${depth}, ${name}: ${span.tracks.length} track(s), ${stretches} stretches, ${jumps} jumps, worst ${span.worst.toFixed(4)} (tolerance ${TOLERANCE}), strained ${span.strained?.length ?? 0}, truth at ½ ${mid} points`);
      }
    }
  });

  it('K2: the span is really exercising the round', () => {
    // Guard on K1: if held and eroded first give the same figures, it should
    // be because the outlines agree, not because the harness is measuring a
    // span with no round in it.
    for (const depth of [20, 40]) {
      const w = spanning(depth, 12, 4);

      for (const t of [0, 0.5, 1]) {
        const f = truth(w, 0, t);
        const pts = f.reduce((n, r) => n + r.points.length, 0);

        log(`K2 depth 0 → ${depth}, t ${t}: ${f.length} run(s), ${pts} points`);
      }
    }
  });

  it('prints', () => {
    console.log(`\n${report.join('\n')}\n`);
    expect(report.length).toBeGreaterThan(0);
  });
});
