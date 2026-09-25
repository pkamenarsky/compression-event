// -----------------------------------------------------------------------------
// Experiment: do two rounds at one corner add?
//
// PLAN-bevel 4.4 step 2 is the piece the erosion-first ordering is for: with
// the depth in front of the fold, everything after it is one round and one
// deform whose amounts are summed per run, so a member with a bevel of its own
// inside a group with one gets the two added at every corner it owns.
//
// Nothing measures that yet. Today the group's round is laid over a corner the
// member has already rounded, which is a composition and not a sum — so this
// asks how far apart the two are, and whether some other law (the larger of
// the two, say) is nearer what ships.
//
// The comparison is against a plain polygon drawn with the answer outright,
// which is what the ordering promises a group will become. Run with
// EXPERIMENT=1.
// -----------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { Point } from '@ce/game/world';
import { EXACT_GAP, Frame, Span, TOLERANCE, bakeSpan, limitsFrom, sample, truth } from '../bake';
import { Shape } from '../geometry';
import { TOP, addPolygon, csg, grouped, sealing } from '../scene';
import { Writing, inSegments, round, withEffects, wrote } from '../testing';
import { World, emptyWorld } from '../types';


/** A room, and a second far enough away to have nothing to do with it: what a
 * group needs two of. Only the first is measured. */
const AWAY: Point[] = [{ x: 900, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 100 }, { x: 900, y: 100 }];

/** How far the two outlines are apart, sampled along their edges. */
function apart(a: Shape, b: Shape): number {
  const along = (s: Shape): Point[] => s.flatMap(ring => ring.flatMap((p, i) => {
    const q = ring[(i + 1) % ring.length];

    return [0, 0.25, 0.5, 0.75].map(f => ({ x: p.x + (q.x - p.x) * f, y: p.y + (q.y - p.y) * f }));
  }));
  const near = (p: Point, s: Shape) => Math.min(...s.flatMap(ring => ring.map((q, i) => {
    const r = ring[(i + 1) % ring.length];
    const dx = r.x - q.x, dy = r.y - q.y, l2 = dx * dx + dy * dy;
    const u = l2 === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - q.x) * dx + (p.y - q.y) * dy) / l2));

    return Math.hypot(p.x - q.x - dx * u, p.y - q.y - dy * u);
  })));

  if (a.length === 0 || b.length === 0) return Infinity;

  return Math.max(...along(a).map(p => near(p, b)), ...along(b).map(p => near(p, a)));
}

/** Only the ring the measured room came to: the one nearest the origin. */
function mine(s: Shape): Shape {
  if (s.length === 0) return s;

  const home = (r: Point[]) => Math.min(...r.map(p => Math.hypot(p.x, p.y)));

  return [s.reduce((best, r) => (home(r) < home(best) ? r : best))];
}

/** Today: the room rounded by `member` inside a sealed group rounded by
 * `group`, which lays its round over what the member came to. */
function composed(room: Point[], member: number, group: number): World {
  const a = addPolygon(emptyWorld(), { level: 'hollow' }, room, 0, TOP);
  const b = addPolygon(a.world, { level: 'hollow' }, AWAY, 0, TOP);
  const g = grouped(b.world, 0, [a.id, b.id], TOP)!;
  let w = sealing(g.world, g.id, true);

  w = withEffects(w, g.id, { round: inSegments(8, group) });
  w = withEffects(w, a.id, { round: inSegments(8, member) });
  w = wrote(w, 0, a.id, round(member));
  w = wrote(w, 0, g.id, round(group));

  return w;
}

/** What the ordering promises it becomes: one polygon, one round, one amount. */
function outright(room: Point[], bevel: number): World {
  const a = addPolygon(emptyWorld(), { level: 'hollow' }, room, 0, TOP);
  let w: World = withEffects(a.world, a.id, { round: inSegments(8, bevel) });

  w = wrote(w, 0, a.id, round(bevel));

  return w;
}

function run<T>(g: Generator<number, T, void>): T {
  let step = g.next();

  while (!step.done) step = g.next();

  return step.value;
}

/** The same as `apart`, over what the bake hands the game. */
function apartRuns(a: Frame, b: Frame): number {
  return apart(a.map(r => r.points), b.map(r => r.points));
}

describe.skipIf(!process.env.EXPERIMENT)('experiment: two rounds at one corner', () => {
  const lines: string[] = [];

  /** A square corner, a shallow one and a sharp one, so the law is asked at
   * more than one angle. */
  const rooms: { name: string, points: Point[] }[] = [
    { name: 'square', points: [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 200 }, { x: 0, y: 200 }] },
    { name: 'shallow', points: [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 340, y: 200 }, { x: -40, y: 200 }] },
    { name: 'sharp', points: [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 180, y: 200 }, { x: 120, y: 200 }] },
  ];

  // The ladder near nought is the interesting part: a member's round of a
  // hundredth of a unit is enough to decide the corner. See PLAN-bevel 4.9.
  const pairs: [number, number][] = [[0, 30], [0.01, 30], [1, 30], [30, 0], [10, 10], [10, 30], [30, 10], [20, 40], [40, 40], [5, 60]];

  for (const r of rooms) {
    for (const [member, group] of pairs) {
      it(`${r.name} ${member}+${group}`, () => {
        const now = mine(csg(composed(r.points, member, group), 0));
        const sum = mine(csg(outright(r.points, member + group), 0));
        const big = mine(csg(outright(r.points, Math.max(member, group)), 0));
        const one = mine(csg(outright(r.points, group), 0));
        const own = mine(csg(outright(r.points, member), 0));

        lines.push(`${r.name.padEnd(8)} member ${String(member).padStart(2)} + group ${String(group).padStart(2)}`
          + `   sum ${apart(now, sum).toFixed(3).padStart(8)}`
          + `   larger ${apart(now, big).toFixed(3).padStart(8)}`
          + `   group alone ${apart(now, one).toFixed(3).padStart(8)}`
          + `   member alone ${apart(now, own).toExponential(2).padStart(9)}`
          + `   points ${now.flat().length} vs ${sum.flat().length}`);

        expect(now.length).toBeGreaterThan(0);
      });
    }
  }

  /** What the cliff costs a span: a member's own round coming up from nought
   * inside a group that has one, which today takes the outline from the
   * group's bevel to the member's at the first instant. */
  it('a member\'s round coming up from nought', () => {
    const room = rooms[0].points;
    const a = addPolygon(emptyWorld(), { level: 'hollow' }, room, 0, TOP);
    const b = addPolygon(a.world, { level: 'hollow' }, AWAY, 0, TOP);
    const g = grouped(b.world, 0, [a.id, b.id], TOP)!;
    let w: World = sealing(g.world, g.id, true);

    w = withEffects(w, g.id, { round: inSegments(8, 30) });
    w = withEffects(w, a.id, { round: inSegments(8, 10) });
    w = wrote(w, 0, g.id, round(30));
    w = wrote(w, 1, a.id, round(10));

    const span: Span = run(bakeSpan(w, 0, TOLERANCE, limitsFrom(EXACT_GAP)));
    const stretches = span.tracks.reduce((n, t) => n + t.stretches.length, 0);
    const jumps = span.tracks.reduce((n, t) => n + t.jumps.length, 0);
    let worst = 0, at = 0;

    for (let i = 0; i <= 900; i++) {
      const t = i / 900;
      const d = apartRuns(sample(span, t), truth(w, 0, t));

      if (isFinite(d) && d > worst) {
        worst = d;
        at = t;
      }
    }

    // And how far the outline moves over the first hundredth of the span.
    const early = apartRuns(truth(w, 0, 0), truth(w, 0, 0.01));

    lines.push(`\nmember's round 0 → 10 inside a group's 30: ${stretches} stretches, ${jumps} jumps, `
      + `worst ${worst.toFixed(4)} at t ${at.toFixed(3)}; the first hundredth moves ${early.toFixed(4)}`);
    expect(stretches).toBeGreaterThan(0);
  }, 300_000);

  it('prints', () => console.log(`\n${lines.join('\n')}\n`));
});
