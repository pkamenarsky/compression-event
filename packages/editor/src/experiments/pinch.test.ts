// -----------------------------------------------------------------------------
// Experiment: is the pinch worth reproducing?
//
// Teeth laid after the erosion are not eroded, so nothing makes a tooth vanish
// as the walls thicken. PLAN-bevel's step 7 proposes fading the amplitude by
// the law today's pinch follows, to have the look and the vertex count back.
//
// A polygon already lays its teeth last, so the question can be asked without
// building anything: erode a room from nothing to past the room itself, with
// teeth and without, and count what the bake pays and what the outline keeps.
// If persisting teeth cost stretches without end, the pinch buys something; if
// the arrangement quietly eats them, it buys a look and no more.
//
// Run with EXPERIMENT=1.
// -----------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { Point } from '@ce/game/world';
import { EXACT_GAP, Span, TOLERANCE, bakeSpan, sample, truth } from '../bake';
import { TOP, addPolygon, csg } from '../scene';
import { Writing, erode, inSegments, wrote } from '../testing';
import { World, emptyWorld } from '../types';

const round = (by: number): Writing => ({ kind: 'round', by });
const deform = (by: number): Writing => ({ kind: 'deform', by });
const ZIGZAG = { spacing: 20, pattern: 'zigzag' as const, seed: 0, sides: 'both' as const, jitter: 0 };
const ROOM: Point[] = [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 200 }, { x: 0, y: 200 }];

function run<T>(g: Generator<number, T, void>): T {
  let step = g.next();

  while (!step.done) step = g.next();

  return step.value;
}

/** A room with a round, an amplitude and a span that erodes it to `depth`. */
function world(amplitude: number, depth: number): World {
  const a = addPolygon(emptyWorld(), { level: 'hollow' }, ROOM, 0, TOP);
  let w: World = { ...a.world, effects: new Map(a.world.effects).set(a.id, { round: inSegments(8, 20), deform: ZIGZAG }) };

  w = wrote(w, 0, a.id, round(20), ...(amplitude > 0 ? [deform(amplitude)] : []));
  w = wrote(w, 1, a.id, erode(depth));

  return w;
}

describe.skipIf(!process.env.EXPERIMENT)('experiment: the pinch', () => {
  const lines: string[] = [];

  for (const depth of [40, 80, 95]) {
    for (const amplitude of [0, 6, 14]) {
      it(`erode to ${depth}, amplitude ${amplitude}`, () => {
        const w = world(amplitude, depth);
        const span: Span = run(bakeSpan(w, 0, TOLERANCE, EXACT_GAP));
        const stretches = span.tracks.reduce((n, t) => n + t.stretches.length, 0);
        const jumps = span.tracks.reduce((n, t) => n + t.jumps.length, 0);

        // What the outline keeps at each quarter of the way in.
        const points = [0, 0.5, 0.9, 1].map(t => csg(w, 0) && truth(w, 0, t).reduce((n, r) => n + r.points.length, 0));
        let worst = 0;

        for (let i = 0; i <= 400; i++) {
          const t = i / 400;
          const a = sample(span, t), b = truth(w, 0, t);
          const n = Math.min(a.length, b.length);
          let d = 0;

          for (let r = 0; r < n; r++) {
            const p = a[r].points, q = b[r].points;

            for (let k = 0; k < Math.min(p.length, q.length); k++) d = Math.max(d, Math.hypot(p[k].x - q[k].x, p[k].y - q[k].y));
          }

          worst = Math.max(worst, d);
        }

        lines.push(`depth ${String(depth).padStart(3)}  amplitude ${String(amplitude).padStart(2)}   `
          + `${String(stretches).padStart(3)} stretches ${String(jumps).padStart(2)} jumps   `
          + `points ${points.join(' → ')}   worst ${worst.toFixed(3)}`);
        expect(stretches).toBeGreaterThan(0);
      }, 300_000);
    }
  }

  it('prints', () => console.log(`\n${lines.join('\n')}\n`));
});
