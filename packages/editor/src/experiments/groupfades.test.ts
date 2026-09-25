// -----------------------------------------------------------------------------
// Experiment: does a sealed group want the polygon's fades?
//
// PLAN-bevel 3.1 gave a polygon its fades — a tooth lying flat is kept in the
// ring and given a fade, so `explained` lets its line come up rather than
// cutting an event at it. 4.4 step 4 asks whether a scope is short of the
// same thing.
//
// The run that said it was turned out to be the ordering switch's own doing
// (4.2), so this asks the question the other way: bake a span in which a
// group's deform comes up out of nothing, and count what it costs — stretches,
// jumps, and how far the replay is from the truth — under the order that ships
// and under `erd`. A fade that is missing shows as a span cut into pieces at
// the instant the teeth arrive, and as drift between the cuts.
//
// Run with EXPERIMENT=1.
// -----------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { Point } from '@ce/game/world';
import { EXACT_GAP, Frame, Span, TOLERANCE, bakeSpan, sample, truth } from '../bake';
import { TOP, addPolygon, grouped, sealing } from '../scene';
import { Effects, Writing, deform, erode, inSegments, round, withEffects, wrote } from '../testing';
import { PolygonId, World, emptyWorld } from '../types';

const ZIGZAG = { spacing: 20, pattern: 'zigzag' as const, seed: 0, sides: 'both' as const, jitter: 0 };

function rect(x: number, y: number, w: number, h: number): Point[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

function run<T>(g: Generator<number, T, void>): T {
  let step = g.next();

  while (!step.done) step = g.next();

  return step.value;
}

/** How far the two boundaries are apart, sampled along their segments. */
function apart(a: Frame, b: Frame): number {
  const segs = (f: Frame): [Point, Point][] => f.flatMap(r =>
    r.points.slice(1).map((p, i) => [r.points[i], p] as [Point, Point]));
  const along = (f: Frame): Point[] => segs(f).flatMap(([p, q]) =>
    [0, 0.25, 0.5, 0.75, 1].map(u => ({ x: p.x + (q.x - p.x) * u, y: p.y + (q.y - p.y) * u })));
  const near = (p: Point, s: [Point, Point][]) => Math.min(...s.map(([q, r]) => {
    const dx = r.x - q.x, dy = r.y - q.y, l2 = dx * dx + dy * dy;
    const u = l2 === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - q.x) * dx + (p.y - q.y) * dy) / l2));

    return Math.hypot(p.x - q.x - dx * u, p.y - q.y - dy * u);
  }));

  if (a.length === 0 || b.length === 0) return Infinity;

  return Math.max(...along(a).map(p => near(p, segs(b))), ...along(b).map(p => near(p, segs(a))));
}

/** Two rooms sealed into a group with a round of its own, and a span over
 * which the group's `ops` are written. */
function world(bevel: number, first: Writing[], ops: Writing[]): { world: World, group: PolygonId } {
  const a = addPolygon(emptyWorld(), { level: 'hollow' }, rect(0, 0, 200, 140), 0, TOP);
  const b = addPolygon(a.world, { level: 'hollow' }, rect(160, 0, 200, 140), 0, TOP);
  const g = grouped(b.world, 0, [a.id, b.id], TOP)!;
  const fx: Effects = { round: inSegments(8, bevel), deform: ZIGZAG };
  let w = sealing(g.world, g.id, true);

  w = withEffects(w, g.id, fx);
  w = wrote(w, 0, g.id, round(bevel), ...first);
  w = wrote(w, 1, g.id, ...ops);

  return { world: w, group: g.id };
}

/** What the bake pays for a span, and how far it is from the truth at nine
 * hundred instants that are not the ones it checked itself at. */
function cost(w: World): string {
  const span: Span = run(bakeSpan(w, 0, TOLERANCE, EXACT_GAP));
  const stretches = span.tracks.reduce((n, t) => n + t.stretches.length, 0);
  const jumps = span.tracks.reduce((n, t) => n + t.jumps.length, 0);
  let worst = 0, at = 0;

  for (let i = 0; i <= 900; i++) {
    const t = i / 900;
    const d = apart(sample(span, t), truth(w, 0, t));

    if (isFinite(d) && d > worst) {
      worst = d;
      at = t;
    }
  }

  return `${String(stretches).padStart(3)} stretches ${String(jumps).padStart(3)} jumps   `
    + `worst ${worst.toFixed(4).padStart(9)} at t ${at.toFixed(3)}`;
}

describe.skipIf(!process.env.EXPERIMENT)('experiment: a group\'s fades', () => {
  const lines: string[] = [];

  // One order per process: `shapedFold` is `remembered`, so a switch flipped
  // between two runs in the same process would be answered from the cache.
  const order = 'erd';

  const cases: { name: string, bevel: number, first: Writing[], ops: Writing[] }[] = [
    { name: 'deform up from nothing', bevel: 20, first: [], ops: [deform(6)] },
    { name: 'deform up, deeper bevel', bevel: 40, first: [], ops: [deform(6)] },
    { name: 'deform there, growing', bevel: 20, first: [deform(6)], ops: [deform(12)] },
    { name: 'deform up while eroding', bevel: 20, first: [], ops: [deform(6), erode(12)] },
  ];

  for (const c of cases) {
    it(`${c.name}, order ${order}`, () => {
      const built = world(c.bevel, c.first, c.ops);

      lines.push(`${c.name.padEnd(28)} ${order}  ${cost(built.world)}`);
      expect(lines.length).toBeGreaterThan(0);
    }, 300_000);
  }

  it('prints', () => console.log(`\n${lines.join('\n')}\n`));
});
