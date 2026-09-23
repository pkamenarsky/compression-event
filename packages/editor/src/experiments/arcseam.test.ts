// -----------------------------------------------------------------------------
// Experiment: does a tooth crossing from an edge to an arc pop?
//
// An edge's teeth stop short of its corners' bevels (`patternRun`'s `clear`)
// and an arc's teeth are a run of their own, keyed by the arc and anchored at
// its middle. So as a bevel grows, the edge shortens, the arc lengthens, and a
// tooth is handed from one run to the other — changing which name it belongs
// to, at a threshold rather than at an event.
//
// That is the shape of the thing PLAN-bevel's property 2 forbids, so it wants
// measuring rather than reasoning about: sweep the bevel with teeth on, rank
// the steps, and refine to tell a discontinuity from a figure moving.
//
// Run with EXPERIMENT=1.
// -----------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { Point } from '@ce/game/world';
import { Frame, truth } from '../bake';
import { TOP, addPolygon } from '../scene';
import { Writing, erode, inSegments, wrote } from '../testing';
import { World, emptyWorld } from '../types';

const round = (by: number): Writing => ({ kind: 'round', by });
const deform = (by: number): Writing => ({ kind: 'deform', by });
const ZIGZAG = { spacing: 20, pattern: 'zigzag' as const, seed: 0, sides: 'both' as const, jitter: 0 };
const ROOM: Point[] = [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 200 }, { x: 0, y: 200 }];

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

/** A room whose bevel runs from `from` to `to` over the span, with teeth of
 * `amplitude` on it throughout, and optionally eroding as well. */
function world(from: number, to: number, amplitude: number, depth = 0): World {
  const a = addPolygon(emptyWorld(), { level: 'hollow' }, ROOM, 0, TOP);
  let w: World = { ...a.world, effects: new Map(a.world.effects).set(a.id, { round: inSegments(8, Math.max(from, to)), deform: ZIGZAG }) };

  w = wrote(w, 0, a.id, round(from), ...(amplitude > 0 ? [deform(amplitude)] : []));
  w = wrote(w, 1, a.id, round(to - from), ...(depth > 0 ? [erode(depth)] : []));

  return w;
}

/** The worst and median step of the outline over `steps` of the span, and
 * where the worst is. */
function profile(w: World, steps: number): { worst: number, at: number, median: number, rings: string } {
  let was = truth(w, 0, 0);
  const ds: number[] = [];
  let worst = 0, at = 0, rings = '';

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const now = truth(w, 0, t);
    const d = apart(was, now);

    ds.push(d);

    if (d > worst) {
      worst = d;
      at = t;
      rings = `${was.reduce((n, r) => n + r.points.length, 0)} → ${now.reduce((n, r) => n + r.points.length, 0)}`;
    }

    was = now;
  }

  ds.sort((x, y) => x - y);

  return { worst, at, median: ds[Math.floor(ds.length / 2)], rings };
}

describe.skipIf(!process.env.EXPERIMENT)('experiment: a tooth crossing onto an arc', () => {
  const lines: string[] = [];

  const cases: { name: string, w: World }[] = [
    { name: 'bevel 4 → 14, no teeth', w: world(4, 14, 0) },
    { name: 'bevel 4 → 14, amplitude 6', w: world(4, 14, 6) },
    { name: 'bevel 0 → 60, no teeth', w: world(0, 60, 0) },
    { name: 'bevel 0 → 60, amplitude 6', w: world(0, 60, 6) },
    { name: 'bevel 0 → 60, amplitude 14', w: world(0, 60, 14) },
    { name: 'bevel 0 → 60 and eroding 20', w: world(0, 60, 6, 20) },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const out = [400, 1600].map(n => profile(c.w, n));

      lines.push(`${c.name.padEnd(30)} `
        + out.map((p, i) => `${[400, 1600][i]}: median ${p.median.toFixed(4)} worst ${p.worst.toFixed(4)}`).join('  |  ')
        + `   at t ${out[1].at.toFixed(4)}, ring ${out[1].rings}`);
      expect(out[0].worst).toBeGreaterThanOrEqual(0);
    }, 600_000);
  }

  it('prints', () => console.log(`\n${lines.join('\n')}\n`));
});
