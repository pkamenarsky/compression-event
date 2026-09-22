// -----------------------------------------------------------------------------
// Experiment: one pipeline for a group
//
// Today a sealed group runs a pipeline of its own: every member rounds,
// deforms and erodes; the fold is taken of what they came to; and the group
// rounds, deforms and erodes that again. A polygon runs one pass — round,
// deform, erode — and two pipelines drift.
//
// The other way is to fold the members *before* any erosion and run the one
// pass over that ring, each corner and edge carrying whichever round, deform
// and depth it inherits. Then a group is a polygon, and there is nothing to
// drift.
//
// This asks what that would change: how far the two pictures are apart, case
// by case, and what the bake pays for each. Run with EXPERIMENT=1.
// -----------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { Point } from '@ce/game/world';
import { Ring, Shape, unionAll } from '../geometry';
import { TOP, addPolygon, csg, deepen, grouped, sealing } from '../scene';
import { cornersAmounted } from '../effects';
import { bakeSpan } from '../bake';
import { Writing, erode, inSegments, wrote } from '../testing';
import { Effects, PolygonId, VertexId, World, emptyWorld } from '../types';

const round = (by: number): Writing => ({ kind: 'round', by });
const deform = (by: number): Writing => ({ kind: 'deform', by });
const ZIGZAG = { spacing: 20, pattern: 'zigzag' as const, seed: 0, sides: 'both' as const, jitter: 0 };

function rect(x: number, y: number, w: number, h: number): Point[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

function run<T>(g: Generator<number, T, void>): T {
  let step = g.next();

  while (!step.done) step = g.next();

  return step.value;
}

/** How far the two outlines are apart: the furthest either has to go to find
 * a point of the other, sampled along their edges. */
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

interface Case {
  name: string
  /** The group's own amounts. */
  bevel: number
  amplitude: number
  depth: number
  /** What the first room has of its own. */
  mine: { bevel?: number, amplitude?: number, depth?: number }
  /** How far the second room is from the first: overlapping, or apart. */
  overlap: boolean
}

describe.skipIf(!process.env.EXPERIMENT)('experiment: one pipeline for a group', () => {
  const lines: string[] = [];
  const A = rect(0, 0, 200, 140);
  const near = rect(160, 0, 200, 140);
  const far = rect(260, 0, 200, 140);

  /** Today: two rooms sealed into a group, each with what it has of its own,
   * and the group with its own. */
  function today(c: Case): { world: World, group: PolygonId, rooms: PolygonId[] } {
    const a = addPolygon(emptyWorld(), { level: 'hollow' }, A, 0, TOP);
    const b = addPolygon(a.world, { level: 'hollow' }, c.overlap ? near : far, 0, TOP);
    const g = grouped(b.world, 0, [a.id, b.id], TOP)!;
    const fx: Effects = {
      ...(c.bevel > 0 ? { round: inSegments(8, c.bevel) } : {}),
      ...(c.amplitude > 0 ? { deform: ZIGZAG } : {}),
    };
    let w = sealing(g.world, g.id, true);

    w = { ...w, effects: new Map(w.effects).set(g.id, fx) };

    if (c.mine.bevel !== undefined || c.mine.amplitude !== undefined) {
      w = {
        ...w,
        effects: new Map(w.effects).set(a.id, {
          ...(c.mine.bevel === undefined ? {} : { round: inSegments(8, c.mine.bevel) }),
          ...(c.mine.amplitude === undefined ? {} : { deform: ZIGZAG }),
        }),
      };
    }

    const ops: Writing[] = [];

    if (c.mine.bevel !== undefined) ops.push(round(c.mine.bevel));
    if (c.mine.amplitude !== undefined) ops.push(deform(c.mine.amplitude));
    if (c.mine.depth !== undefined) ops.push(erode(c.mine.depth));

    if (ops.length > 0) w = wrote(w, 0, a.id, ...ops);

    const his: Writing[] = [];

    if (c.bevel > 0) his.push(round(c.bevel));
    if (c.amplitude > 0) his.push(deform(c.amplitude));
    if (c.depth > 0) his.push(erode(c.depth));

    if (his.length > 0) w = wrote(w, 0, g.id, ...his);

    return { world: w, group: g.id, rooms: [a.id, b.id] };
  }

  /** One pipeline: the members folded before any erosion, as one polygon,
   * with the group's effects on the ring and the first room's own carried
   * onto the corners that came from it. */
  function planned(c: Case): World {
    // One polygon per ring of the fold: members that do not touch are not one
    // polygon, and nothing about one pipeline says they are.
    const rings = unionAll([[A], [c.overlap ? near : far]]);
    const ring: Ring = rings.reduce((best, r) => (r.length > best.length ? r : best));
    const added = addPolygon(emptyWorld(), { level: 'hollow' }, ring, 0, TOP);
    const others = rings.filter(r => r !== ring);
    const fx: Effects = {
      ...(c.bevel > 0 || c.mine.bevel !== undefined ? { round: inSegments(8, Math.max(c.bevel, c.mine.bevel ?? 0)) } : {}),
      ...(c.amplitude > 0 || c.mine.amplitude !== undefined ? { deform: ZIGZAG } : {}),
    };
    let w: World = { ...added.world, effects: new Map([[added.id as PolygonId, fx]]) };

    // Which corners of the ring are the first room's: those on its outline.
    const vertices = added.world.polygons.get(added.id)!.points;
    const on = (p: Point) => p.x <= 200 + 1e-9 && p.y >= -1e-9 && p.y <= 140 + 1e-9 && p.x >= -1e-9;
    const mine = new Set<VertexId>(vertices.filter(v => on(v.at)).map(v => v.id));
    const rest = new Set<VertexId>(vertices.filter(v => !mine.has(v.id)).map(v => v.id));

    w = wrote(w, 0, added.id, ...(c.bevel > 0 ? [round(c.bevel)] : []), ...(c.amplitude > 0 ? [deform(c.amplitude)] : []));

    // The first room's own, on its corners: over the group's where it has
    // one, since a corner takes what it inherits.
    if (c.mine.bevel !== undefined) {
      w = cornersAmounted(w, 0, added.id, 'round', mine, c.mine.bevel - c.bevel);
    }

    if (c.mine.amplitude !== undefined) {
      w = cornersAmounted(w, 0, added.id, 'deform', mine, c.mine.amplitude - c.amplitude);
    }

    // Its depth is its own edges', and the group's is everybody's: one
    // erosion, with each corner at the depth it inherits.
    if (c.mine.depth !== undefined) w = deepen(w, 0, added.id, mine, c.mine.depth);
    if (c.depth > 0) w = deepen(w, 0, added.id, rest, c.depth);
    if (c.depth > 0) w = deepen(w, 0, added.id, mine, c.depth + (c.mine.depth ?? 0));

    for (const r of others) {
      const more = addPolygon(w, { level: 'hollow' }, r, 0, TOP);

      w = { ...more.world, effects: new Map(more.world.effects).set(more.id, fx) };
      w = wrote(w, 0, more.id, ...(c.bevel > 0 ? [round(c.bevel)] : []), ...(c.amplitude > 0 ? [deform(c.amplitude)] : []));

      if (c.depth > 0) w = wrote(w, 0, more.id, erode(c.depth));
    }

    return w;
  }

  const cases: Case[] = [
    { name: 'group round, plain members', bevel: 20, amplitude: 0, depth: 0, mine: {}, overlap: true },
    { name: 'group round + deform', bevel: 20, amplitude: 6, depth: 0, mine: {}, overlap: true },
    { name: 'group round + deform + erode', bevel: 20, amplitude: 6, depth: 10, mine: {}, overlap: true },
    { name: 'rooms apart, group round + deform', bevel: 20, amplitude: 6, depth: 0, mine: {}, overlap: false },
    { name: 'member rounds, group deforms', bevel: 0, amplitude: 6, depth: 0, mine: { bevel: 20 }, overlap: true },
    { name: 'member rounds, group deforms + erodes', bevel: 0, amplitude: 6, depth: 10, mine: { bevel: 20 }, overlap: true },
    { name: 'member erodes, group rounds', bevel: 20, amplitude: 0, depth: 0, mine: { depth: 10 }, overlap: true },
    { name: 'member deforms, group rounds', bevel: 20, amplitude: 0, depth: 0, mine: { amplitude: 6 }, overlap: true },
    // Twice the amplitude: if the gap doubles with it, the gap is the
    // pattern's phase and not the pipeline.
    { name: 'group round + deform, amplitude 12', bevel: 20, amplitude: 12, depth: 0, mine: {}, overlap: true },
    { name: 'group round + erode, no deform', bevel: 20, amplitude: 0, depth: 10, mine: {}, overlap: true },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const now = csg(today(c).world, 0);
      const one = csg(planned(c), 0);

      lines.push(`${c.name.padEnd(38)} apart ${apart(now, one).toFixed(2).padStart(7)}  `
        + `points ${now.flat().length} vs ${one.flat().length}  rings ${now.length} vs ${one.length}`);

      expect(now.length).toBeGreaterThan(0);
    });
  }

  it('what each costs the bake', () => {
    const count = (s: { tracks: { stretches: unknown[], jumps: unknown[] }[] }) =>
      `${s.tracks.reduce((n, t) => n + t.stretches.length, 0)} stretches, ${s.tracks.reduce((n, t) => n + t.jumps.length, 0)} jumps`;

    // The group eroding over a span, both ways, with teeth and without.
    for (const amplitude of [0, 6]) {
      const c: Case = { name: 'span', bevel: 20, amplitude, depth: 0, mine: {}, overlap: true };
      const built = today(c);
      const nowSpan = run(bakeSpan(wrote(built.world, 1, built.group, erode(20)), 0));
      const oneSpan = run(bakeSpan(wrote(planned(c), 1, 0 as PolygonId, erode(20)), 0));

      lines.push(`\neroding 0 → 20, amplitude ${amplitude}: today ${count(nowSpan)} | one pipeline ${count(oneSpan)}`);
    }
  });

  it('prints', () => console.log(`\n${lines.join('\n')}\n`));
});
