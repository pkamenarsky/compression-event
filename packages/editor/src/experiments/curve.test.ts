// -----------------------------------------------------------------------------
// Experiment: teeth on a curve that arrives as points
//
// PLAN-bevel 2.9 piece 4 has a group's deform run along a member's arc, which
// reaches the fold as facet points and not as the curve it was built from. So
// the curve has to be read back off the points: `on` by walking the polyline,
// `normal` off the segment, and `bend` — the one the tent's fold limit leans
// on — off three neighbours.
//
// The question is how far that moves the teeth. Run with EXPERIMENT=1.
// -----------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { Point } from '@ce/game/world';
import { ArcTeeth, Curved, Effecting, FALLOFF, facetsOf, outlineOf, teethAlong } from '../geometry';

const E: Effecting = { spacing: 20, pattern: 'zigzag', seed: 0, sides: 'both', jitter: 0, falloff: FALLOFF, offset: false };

/** The curve read back off the points it was laid as. */
function sampled(points: readonly Point[]): Curved {
  const n = points.length - 1;
  const lengths = [0];

  for (let k = 1; k <= n; k++) {
    lengths.push(lengths[k - 1] + Math.hypot(points[k].x - points[k - 1].x, points[k].y - points[k - 1].y));
  }

  const total = lengths[n];
  const at = (u: number): { k: number, f: number } => {
    const want = Math.min(1, Math.max(0, u)) * total;
    let k = 0;

    while (k < n - 1 && lengths[k + 1] < want) k++;

    return { k, f: (want - lengths[k]) / Math.max(lengths[k + 1] - lengths[k], 1e-300) };
  };
  const on = (u: number): Point => {
    const { k, f } = at(u);

    return { x: points[k].x + (points[k + 1].x - points[k].x) * f, y: points[k].y + (points[k + 1].y - points[k].y) * f };
  };
  const normal = (u: number): Point => {
    const { k } = at(u);
    const x = points[k + 1].x - points[k].x, y = points[k + 1].y - points[k].y, l = Math.hypot(x, y);

    return l === 0 ? { x: 0, y: 0 } : { x: y / l, y: -x / l };
  };

  // Off three points a step either side: twice the area they make over the
  // three sides, which is one over the radius of the circle through them.
  const bend = (u: number): number => {
    const h = 1 / (2 * n);
    const a = on(u - h), b = on(u), c = on(u + h);
    const la = Math.hypot(b.x - a.x, b.y - a.y), lb = Math.hypot(c.x - b.x, c.y - b.y), lc = Math.hypot(c.x - a.x, c.y - a.y);
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);

    return la === 0 || lb === 0 || lc === 0 ? 0 : 2 * cross / (la * lb * lc);
  };

  return { points: [...points], us: lengths.map(l => l / total), point: false, on, normal, bend };
}

describe.skipIf(!process.env.EXPERIMENT)('experiment: teeth on a curve given as points', () => {
  const report: string[] = [];

  /** A square whose corner at the origin is rounded `bevel` deep in `n`
   * facets, and what that corner's arc comes to with and without teeth. */
  function corner(bevel: number, n: number, amplitude: number, turn: 90 | 135 = 90) {
    const far = turn === 90 ? { x: -200, y: 200 } : { x: -280, y: 60 };
    const ring: Point[] = [{ x: 200, y: 0 }, { x: 0, y: 0 }, far, { x: 200, y: 400 }];
    const facets = facetsOf(n);
    const tt: ArcTeeth = { e: E, before: amplitude, after: amplitude, key: 7, seen: 1 };
    const plain = outlineOf(ring, [], () => false, i => (i === 1 ? facets : facetsOf(0)), i => (i === 1 ? bevel : 0), () => null);
    const withTeeth = outlineOf(ring, [], () => false, i => (i === 1 ? facets : facetsOf(0)), i => (i === 1 ? bevel : 0), i => (i === 1 ? tt : null));

    return { arc: plain.arcs[1].map(k => plain.ring[k]), built: withTeeth, tt };
  }

  for (const [bevel, n, amplitude, turn] of [
    [60, 16, 8, 90], [60, 16, 24, 90], [30, 8, 8, 90], [120, 24, 20, 90], [60, 16, 24, 135],
    // Coarse, where the polyline is furthest from the curve it was laid as,
    // and pushed hard inward, where the fold limit reads `bend`.
    [60, 4, 8, 90], [60, 3, 24, 90], [30, 8, 40, 90], [30, 6, 60, 90], [20, 8, 80, 90],
  ] as const) {
    it(`bevel ${bevel}, ${n} facets, amplitude ${amplitude}, ${turn}°`, () => {
      const { arc, built, tt } = corner(bevel, n, amplitude, turn);
      // The side `outlineOf` lays it by: out of the material is to the right
      // of the way round, and this ring is wound clockwise.
      const mine = teethAlong(sampled(arc), tt, -1);

      // The analytic answer, as `outlineOf` laid it: the arc's own run.
      const from = Math.min(...built.arcs[1]), to = Math.max(...built.arcs[1]);
      const theirs = built.ring.slice(from, to + 1);
      const tips = (points: readonly Point[], teeth: readonly number[]) => teeth.map(k => points[k]);
      const near = (p: Point, all: readonly Point[]) => Math.min(...all.map(q => Math.hypot(p.x - q.x, p.y - q.y)));
      const a = tips(mine.all, mine.teethAt);
      const b = built.teeth.filter(k => k >= from && k <= to).map(k => built.ring[k]);

      // Nothing folded back on itself: along the run, no step turns further
      // than a right angle back on the one before it.
      const folds = mine.all.slice(2).filter((p, k) => {
        const a = mine.all[k], b = mine.all[k + 1];

        return (b.x - a.x) * (p.x - b.x) + (b.y - a.y) * (p.y - b.y) < 0;
      }).length;
      const theirFolds = theirs.slice(2).filter((p, k) => {
        const a = theirs[k], b = theirs[k + 1];

        return (b.x - a.x) * (p.x - b.x) + (b.y - a.y) * (p.y - b.y) < 0;
      }).length;

      report.push(`bevel ${bevel} n ${n} amp ${amplitude} ${turn}°: tips ${a.length} vs ${b.length}, `
        + `tip off by ${Math.max(0, ...a.map(p => near(p, b))).toFixed(3)}, `
        + `points ${mine.all.length} vs ${theirs.length}, `
        + `outline off by ${Math.max(0, ...mine.all.map(p => near(p, theirs))).toFixed(3)}, `
        + `folds ${folds} vs ${theirFolds}`);

      expect(a.length).toBeGreaterThan(0);
    });
  }

  it('prints', () => console.log(`\n${report.join('\n')}\n`));
});
