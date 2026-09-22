import { describe, expect, test } from 'vitest';
import { Point } from '@ce/game/world';
import { rounded, shapeArea } from './geometry';
import { Resolved, TOP, addPolygon, contributing, copied, csg, grouped, imagesOf, pasted, resolveAt, rigOf, sealing, withRig } from './scene';
import { Span, spanAt, stamp } from './bake';
import { cornerRounded, stateAt } from './rig';
import { resolveGroup } from './resolve';
import {
  applies,
  cornerRounding,
  cornersAmounted,
  cornersInheriting,
  cornersOptioned,
  cornersSwitched,
  edgeRun,
  edgesBetween,
  edgesWithinBox,
  endsOf,
  switchedOff,
  switchedOn,
} from './effects';
import { erode, inSegments, move, scaled, turned, wrote } from './testing';
import { Effects, Id, PolygonId, REMEMBERED, World, emptyWorld } from './types';

function rect(x: number, y: number, w: number, h: number): Point[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

function room(world: World = emptyWorld(), at: Point[] = rect(0, 0, 100, 100)): { world: World, id: PolygonId } {
  return addPolygon(world, { level: 'hollow' }, at, 0, TOP);
}

function withEffects(world: World, id: Id, fx: Effects): World {
  return { ...world, effects: new Map(world.effects).set(id, fx) };
}

const round = (by: number) => ({ kind: 'round' as const, by });
const deform = (by: number) => ({ kind: 'deform' as const, by });

/** A `w` by `h` rectangle's area with its four corners rounded `r` deep in
 * `segments`, as the geometry rounds a ring on its own. */
function roundedRect(w: number, h: number, r: number, segments: number): number {
  return shapeArea([rounded(rect(0, 0, w, h), () => r, segments)]);
}

function shapeOf(world: World, id: Id) {
  return resolveAt(world, 0).find(it => it.id === id)!.shape;
}

const ROUND: Effects = { round: inSegments(8, 5) };

describe('a polygon\'s effects', () => {
  test('a rounded room is its arcs, eroded: held, the bevel it asked for', () => {
    const { world, id } = room();
    const held = wrote(withEffects(world, id, ROUND), 0, id, erode(10), round(5));

    // Drawn fifteen deep and eroded ten: a round five deep, near enough — an
    // offset curve is not the curve again at a smaller size, and is some two
    // square units off it a corner.
    expect(shapeOf(held, id)).toHaveLength(1);
    expect(Math.abs(shapeArea(shapeOf(held, id)) - roundedRect(80, 80, 5, 8))).toBeLessThan(16);

    // And not held, the same round drawn five deep: eroded past it, it is
    // square again.
    const unheld = wrote(withEffects(world, id, { round: { ...ROUND.round!, held: false } }), 0, id, erode(10), round(5));

    expect(shapeArea(shapeOf(unheld, id))).toBeCloseTo(80 * 80, 6);

    // With no erosion, held or not, it is its arcs.
    const plain = wrote(withEffects(world, id, ROUND), 0, id, round(5));

    expect(shapeOf(plain, id)[0]).toHaveLength(4 * 9);
    expect(shapeArea(shapeOf(plain, id))).toBeCloseTo(roundedRect(100, 100, 5, 8), 6);
  });

  test('with nothing to them, the projection is the erosion alone', () => {
    const { world, id } = room();
    const plain = wrote(world, 0, id, erode(10));

    expect(shapeOf(withEffects(plain, id, ROUND), id)).toEqual(shapeOf(plain, id));
    expect(shapeOf(wrote(plain, 0, id, round(5)), id)).toEqual(shapeOf(plain, id));
  });

  test('a bevel is a length at the room\'s own scale, as a depth is, however the room is carried', () => {
    const { world, id } = room();
    const w = wrote(withEffects(world, id, ROUND), 0, id, round(5), scaled(2, 2), turned(0.3), move(40, -7));

    expect(shapeArea(shapeOf(w, id))).toBeCloseTo(roundedRect(200, 200, 10, 8), 6);

    // And squashed, where the projection is taken in the world instead, by
    // the square root of what the squash does to area.
    const squashed = wrote(withEffects(world, id, ROUND), 0, id, round(5), scaled(2, 1));

    expect(shapeArea(shapeOf(squashed, id))).toBeCloseTo(roundedRect(200, 100, 5 * Math.SQRT2, 8), 6);
  });

  test('a corner rounds on its own, over its room\'s', () => {
    const { world, id } = room();
    const corner = world.polygons.get(id)!.points[2].id;
    const w = withRig(withEffects(world, id, { round: inSegments(4, 10) }), id, cornerRounded(rigOf(world, id), corner, 0, 10));
    const shape = shapeOf(w, id);

    expect(shape[0]).toHaveLength(3 + 5);
    expect(shape[0]).toContainEqual({ x: 90, y: 100 });
    expect(shape[0]).toContainEqual({ x: 100, y: 90 });
  });

  test('a corner\'s own options are over its room\'s', () => {
    const { world, id } = room();
    const corner = world.polygons.get(id)!.points[0].id;
    let w = wrote(withEffects(world, id, ROUND), 0, id, round(5));

    w = { ...w, cornerEffects: new Map([[corner, { round: inSegments(2, 5) }]]) };

    expect(shapeOf(w, id)[0]).toHaveLength(3 * 9 + 3);
  });

  test('a deform puts its points into every edge, off the line by its amplitude', () => {
    const { world, id } = room();
    // Out, a zigzag is teeth: out, on the line, out — every twenty along each
    // wall from wherever the seed starts it, those near a corner shorter.
    const fx: Effects = { deform: { spacing: 20, pattern: 'zigzag', seed: 0, sides: 'out', jitter: 0 } };
    const w = wrote(withEffects(world, id, fx), 0, id, deform(2));
    const ring = shapeOf(w, id)[0];
    const out = ring.map(p => Math.max(-p.x, p.x - 100, -p.y, p.y - 100)).filter(d => d > 1e-9);

    // Two out on every wall at least, none further than the amplitude, and
    // some the whole of it.
    expect(out.length).toBeGreaterThanOrEqual(4 * 2);
    out.forEach(d => expect(d).toBeLessThanOrEqual(2 + 1e-9));
    expect(out.filter(d => Math.abs(d - 2) < 1e-9).length).toBeGreaterThanOrEqual(4);
  });

  test('a pasted room comes with its effects and its corners\' own', () => {
    const { world, id } = room();
    const corner = world.polygons.get(id)!.points[0].id;
    let w = wrote(withEffects(world, id, ROUND), 0, id, round(5));

    w = { ...w, cornerEffects: new Map([[corner, { round: inSegments(2, 5) }]]) };

    const after = pasted(w, 0, copied(w, 0, [id]), { x: 300, y: 0 }, TOP);
    const copy = after.ids[0];

    expect(after.world.effects.get(copy)).toEqual(ROUND);
    expect(shapeArea(shapeOf(after.world, copy))).toBeCloseTo(shapeArea(shapeOf(w, id)), 9);
  });
});

describe('a group\'s effects', () => {
  /** Two rooms side by side, sealed into one, rounded as one. */
  function corridor() {
    const a = room(emptyWorld(), rect(0, 0, 100, 100));
    const b = room(a.world, rect(60, 0, 140, 100));
    const g = grouped(b.world, 0, [a.id, b.id], TOP)!;
    const world = wrote(withEffects(sealing(g.world, g.id, true), g.id, { round: inSegments(8, 10) }), 0, g.id, round(10));

    return { world, id: g.id };
  }

  test('they apply to the union, so the join between rooms is not rounded', () => {
    const { world } = corridor();
    const set = csg(world, 0);

    // A run closes on its first point.
    expect(set).toHaveLength(1);
    expect(set[0]).toHaveLength(4 * 9 + 1);
    expect(shapeArea(set)).toBeCloseTo(roundedRect(200, 100, 10, 8), 6);
  });

  test('its round leaves its members\' deformed geometry square, and its own deform\'s', () => {
    const zigzag = { spacing: 20, pattern: 'zigzag' as const, seed: 0, sides: 'out' as const, jitter: 0 };
    const a = room(emptyWorld(), rect(0, 0, 100, 100));
    const b = room(a.world, rect(60, 0, 140, 100));
    const g = grouped(b.world, 0, [a.id, b.id], TOP)!;
    const sealed = wrote(withEffects(sealing(g.world, g.id, true), g.id, { round: inSegments(8, 10) }), 0, g.id, round(10));
    const vertices = (w: World) => new Set(csg(w, 0).flat().map(p => `${p.x.toFixed(6)},${p.y.toFixed(6)}`));
    const teethOf = (w: World, id: Id) => {
      const it = resolveAt(w, 0).find(r => r.id === id)!;

      // Those standing off the wall: the rest are on its line, and the union,
      // an arrangement, drops them.
      return it.source.filter((p, i) => it.corners[i].root !== undefined && p.y > 100 + 1e-9);
    };

    // One edge of a room deformed: its teeth and its ends are where they are
    // in the union, square, and the rest of the union rounded as before.
    const top = (world: World) => cornersAmounted(withEffects(world, a.id, { deform: zigzag }), 0, a.id, 'deform', new Set([a.world.polygons.get(a.id)!.points[2].id]), 4);
    const one = top(sealed);
    const teeth = teethOf(one, a.id);

    expect(teeth.length).toBeGreaterThan(0);
    teeth.forEach(p => expect(vertices(one).has(`${p.x.toFixed(6)},${p.y.toFixed(6)}`)).toBe(true));
    expect(vertices(one).has('0.000000,100.000000')).toBe(true);
    expect(vertices(one).has('0.000000,0.000000')).toBe(false);

    // Deformed by the group itself, the same.
    const whole = wrote(withEffects(sealed, g.id, { round: inSegments(8, 10), deform: zigzag }), 0, g.id, deform(4));

    // Every vertex of the union a point of its rooms', and none of an arc.
    const drawn = new Set(resolveAt(whole, 0).flatMap(it => it.source).map(p => `${p.x.toFixed(6)},${p.y.toFixed(6)}`));

    vertices(whole).forEach(p => expect(drawn.has(p)).toBe(true));
  });

  test('its round is after its solids cut its level, so the corners they cut are rounded too', () => {
    const a = room(emptyWorld(), rect(0, 0, 100, 100));
    const s = addPolygon(a.world, { level: 'solid' }, rect(80, 40, 40, 20), 0, TOP);
    const g = grouped(s.world, 0, [a.id, s.id], TOP)!;
    const w = wrote(withEffects(sealing(g.world, g.id, true), g.id, { round: inSegments(8, 5) }), 0, g.id, round(5));
    const vertices = new Set(csg(w, 0).flat().map(p => `${p.x.toFixed(6)},${p.y.toFixed(6)}`));

    // Where the solid crosses the wall, and its own corners in the room: none
    // of them a point any more, each an arc.
    ['100,40', '100,60', '80,40', '80,60', '0,0'].forEach(p => {
      const [x, y] = p.split(',').map(Number);

      expect(vertices.has(`${x.toFixed(6)},${y.toFixed(6)}`)).toBe(false);
    });

    expect(csg(w, 0).flat().length).toBe(8 * 9 + 1);
  });

  test('a loose group has none to give', () => {
    const { world, id } = corridor();

    expect(shapeArea(csg(sealing(world, id, false), 0))).toBeCloseTo(200 * 100, 9);
  });

  test('its union\'s noise belongs to its members\' edges, whatever else joins it', () => {
    const noise: Effects = { deform: { spacing: 15, pattern: 'noise', seed: 3, sides: 'both', jitter: 0 } };
    const top = (w: World) => csg(w, 0).flat().filter(p => p.y > 95 && p.x > 5 && p.x < 150);
    const build = (extra: boolean) => {
      const a = room(emptyWorld(), rect(0, 0, 100, 100));
      const b = room(a.world, rect(60, 0, 140, 100));
      const ids = [a.id, b.id];
      let w = b.world;

      if (extra) {
        const c = room(w, rect(190, 30, 40, 40));

        w = c.world;
        ids.push(c.id);
      }

      const g = grouped(w, 0, ids, TOP)!;

      return wrote(withEffects(sealing(g.world, g.id, true), g.id, noise), 0, g.id, deform(4));
    };

    // A room joined on the right comes before the top in the union's ring,
    // and the teeth along the top do not notice.
    expect(top(build(true))).toEqual(top(build(false)));
    expect(top(build(false)).length).toBeGreaterThan(8);
  });

  test('resolved, its rings take the effects and the amounts with them', () => {
    const { world, id } = corridor();
    const out = resolveGroup(world, 0, id)!;
    const made = out.ids[0];

    expect(out.world.effects.get(made)).toEqual({ round: inSegments(8, 10) });
    expect(stateAt(out.world, made, 0).bevel).toBe(10);
    expect(shapeArea(csg(out.world, 0))).toBeCloseTo(shapeArea(csg(world, 0)), 6);
  });
});

describe('editing effects', () => {
  const DEFORM: Effects = { deform: { spacing: 20, pattern: 'zigzag', seed: 0, sides: 'out', jitter: 0 } };

  test('switched on, an effect keeps the options a thing already had', () => {
    const { world, id } = room();
    const other = room(world, rect(200, 0, 50, 50));
    const w = switchedOn(withEffects(other.world, id, { round: inSegments(2, 5) }), [id, other.id], 'round', REMEMBERED);

    expect(w.effects.get(id)).toEqual({ round: inSegments(2, 5) });
    expect(w.effects.get(other.id)).toEqual({ round: REMEMBERED.round });
  });

  test('switched off, an effect does nothing and keeps everything, and switched on is as it was', () => {
    const { world, id } = room();
    const corner = world.polygons.get(id)!.points[0].id;
    let w = wrote(withEffects(world, id, { ...ROUND, ...DEFORM }), 0, id, erode(3), round(5), deform(2));

    w = cornersAmounted(w, 0, id, 'round', new Set([corner]), 4);

    const off = switchedOff(w, [id], 'round');

    expect(applies(off, id, 'round')).toBe(false);
    expect(rigOf(off, id)).toBe(rigOf(w, id));
    expect(shapeOf(off, id)).toEqual(shapeOf(wrote(withEffects(world, id, DEFORM), 0, id, erode(3), deform(2)), id));
    expect(shapeOf(switchedOn(off, [id], 'round', REMEMBERED), id)).toEqual(shapeOf(w, id));
  });

  test('erosion switched off stands the thing at its outline, its timeline kept', () => {
    const { world, id } = room();
    const corner = world.polygons.get(id)!.points[0].id;
    const w = cornersAmounted(wrote(world, 0, id, erode(5)), 0, id, 'erode', new Set([corner]), 2);

    expect(applies(w, id, 'erode')).toBe(true);

    const off = switchedOff(w, [id], 'erode');

    expect(shapeOf(off, id)).toEqual(shapeOf(world, id));
    expect(stateAt(off, id, 0).erosion).toBe(5);
    expect(shapeOf(switchedOn(off, [id], 'erode', REMEMBERED), id)).toEqual(shapeOf(w, id));
    expect(switchedOn(off, [id], 'erode', REMEMBERED).effects.has(id)).toBe(false);
  });

  test('a corner left square on a rounded room, and rounded its own way', () => {
    const { world, id } = room();
    const [a, b] = world.polygons.get(id)!.points;
    const w = wrote(withEffects(world, id, { round: inSegments(8, 10) }), 0, id, round(10));
    const ring = () => shapeOf(w, id)[0].length;

    const square = cornersSwitched(w, [a.id], false, REMEMBERED);

    expect(cornerRounding(square, a.id)).toBe(false);
    expect(cornerRounding(square, b.id)).toBe(true);
    expect(shapeOf(square, id)[0]).toHaveLength(ring() - 8);

    const back = cornersSwitched(square, [a.id], true, REMEMBERED);

    expect(shapeOf(back, id)).toEqual(shapeOf(w, id));

    const finer = cornersOptioned(w, [a.id], { precision: inSegments(12, 10).precision }, REMEMBERED);

    expect(finer.cornerEffects.get(a.id)!.round).toEqual(inSegments(12, 10));
    expect(shapeOf(finer, id)[0]).toHaveLength(ring() + 4);
    expect(shapeOf(cornersInheriting(finer, [a.id]), id)).toEqual(shapeOf(w, id));

    // The room's round switched off leaves every corner square, its own too.
    expect(shapeOf(switchedOff(finer, [id], 'round'), id)[0]).toHaveLength(4);
  });

  test('an edge\'s amplitude is its own, over its polygon\'s', () => {
    const { world, id } = room();
    const [a] = world.polygons.get(id)!.points;
    const w = cornersAmounted(wrote(withEffects(world, id, DEFORM), 0, id, deform(1)), 0, id, 'deform', new Set([a.id]), 3);

    expect(rigOf(w, id).deforms.get(a.id)!.get(0)!.op.by).toBe(3);
    expect(stateAt(w, id, 0).amplitudes.get(a.id)).toBe(3);
  });

  test('an edge runs from its drawn corner to the next, through its teeth', () => {
    const { world, id } = room();
    const points = world.polygons.get(id)!.points;
    const w = wrote(withEffects(world, id, DEFORM), 0, id, deform(2));
    const it = resolveAt(w, 0).find(r => r.id === id)!;
    const run = edgeRun(it, points[0].id);

    expect(it.corners[run[0]].id).toBe(points[0].id);
    expect(it.corners[run[run.length - 1]].id).toBe(points[1].id);
    expect(run.slice(1, -1).every(i => it.corners[i].root === points[0].id)).toBe(true);
    expect(run.length).toBeGreaterThan(2);

    expect(endsOf([it], [points[3].id]).sort()).toEqual([points[3].id, points[0].id].sort());
    expect(edgesBetween([it], [points[0].id, points[1].id, points[3].id]).sort()).toEqual([points[0].id, points[3].id].sort());

    // The top edge alone lies wholly inside a box round it, teeth and all.
    expect(edgesWithinBox([it], { x: -10, y: -10 }, { x: 110, y: 10 })).toEqual([points[0].id]);
  });

  test('one edge deformed leaves the others straight, and their corners\' bevels whole', () => {
    const { world, id } = room();
    const [a, b, c, d] = world.polygons.get(id)!.points;
    const rounded = wrote(withEffects(world, id, { round: inSegments(8, 30), ...DEFORM }), 0, id, round(30));
    const w = cornersAmounted(rounded, 0, id, 'deform', new Set([a.id]), 3);
    const it = resolveAt(w, 0).find(r => r.id === id)!;

    expect(edgeRun(it, a.id).length).toBeGreaterThan(2);
    [b, c, d].forEach(p => expect(edgeRun(it, p.id)).toHaveLength(2));

    // The corner the deformed edge does not touch is rounded as it was.
    const arc = (at: typeof it) => imagesOf(at)!.corners[at.corners.findIndex(q => q.id === c.id)];

    expect(arc(it)).toEqual(arc(resolveAt(rounded, 0).find(r => r.id === id)!));
  });

  test('a polygon\'s teeth stop short of its corners\' arcs, and are never rounded', () => {
    const { world, id } = room();
    const [a, b] = world.polygons.get(id)!.points;
    const fx = { round: inSegments(8, 30), deform: DEFORM.deform! };
    const it = resolveAt(wrote(withEffects(world, id, fx), 0, id, round(30), deform(3)), 0).find(r => r.id === id)!;
    const teeth = edgeRun(it, a.id).slice(1, -1).map(i => it.source[i]);
    const from = (p: Point, q: Point) => Math.hypot(p.x - q.x, p.y - q.y);

    expect(teeth.length).toBeGreaterThan(0);
    expect(teeth.every(p => from(p, a.at) > 30 && from(p, b.at) > 30)).toBe(true);

    // A square corner's arc is the one point; a drawn corner's is its nine.
    const arcs = imagesOf(it)!.corners.map(r => r?.length);
    const at = (vertex: number) => arcs[it.corners.findIndex(q => q.id === vertex)];

    edgeRun(it, a.id).slice(1, -1).forEach(i => expect(arcs[i] ?? 1).toBe(1));
    expect(at(a.id)).toBe(9);
    expect(at(b.id)).toBe(9);
  });

  test('a polygon\'s arcs take teeth of their own, along the curve, laid as its edges\' are', () => {
    const { world, id } = room();
    const fx = { round: inSegments(8, 30), deform: { ...DEFORM.deform!, spacing: 10 } };
    const plain = resolveAt(wrote(withEffects(world, id, { round: fx.round }), 0, id, round(30)), 0).find(r => r.id === id)!;
    const toothed = resolveAt(wrote(withEffects(world, id, fx), 0, id, round(30), deform(3)), 0).find(r => r.id === id)!;
    const im = imagesOf(toothed)!;

    // An arc thirty deep is some forty long: a tooth every ten of it, less
    // those within a spacing of its ends, which are flat there and not laid.
    expect(im.teeth!.length).toBeGreaterThanOrEqual(4 * 2);

    // Each arc is still its nine points, from where it leaves one edge to
    // where it joins the next: the teeth push its points off the curve
    // between them, as an edge's teeth push its straight between them, and
    // leave its ends where they were.
    const arcsOf = (it: Resolved) => imagesOf(it)!.corners.filter((r): r is Point[] => r !== null && r.length > 1);

    expect(arcsOf(toothed)).toHaveLength(4);
    arcsOf(toothed).forEach((run, k) => {
      expect(run).toHaveLength(9);
      expect(run[0]).toEqual(arcsOf(plain)[k][0]);
      expect(run[8]).toEqual(arcsOf(plain)[k][8]);
    });

    // And every point of them, teeth and all, off the curve by no more than
    // the amplitude, near enough: the plain arc's facets are a little off it.
    const offCurve = (p: Point) => Math.min(...arcsOf(plain).flat().map(q => Math.hypot(p.x - q.x, p.y - q.y)));

    [...im.teeth!, ...arcsOf(toothed).flat()].forEach(p => expect(offCurve(p)).toBeLessThan(3 + 10));
  });
});

describe('the bake hears of effects', () => {
  test('an effect changed, or switched off, is a span gone stale', () => {
    const { world, id } = room();
    const w = wrote(withEffects(world, id, ROUND), 0, id, round(5));
    const bake = { spans: new Map([[0, { stamp: stamp(w, 0) } as Span]]), progress: null };

    expect(spanAt(bake, w, 0)).not.toBeNull();
    expect(spanAt(bake, withEffects(w, id, { round: inSegments(9, 5) }), 0)).toBeNull();
    expect(spanAt(bake, switchedOff(w, [id], 'round'), 0)).toBeNull();
  });
});
