import { describe, expect, test } from 'vitest';
import { Point } from '@ce/game/world';
import { shapeArea } from './geometry';
import { TOP, addPolygon, contributing, copied, csg, grouped, pasted, resolveAt, rigOf, sealing, withRig } from './scene';
import { Span, spanAt, stamp } from './bake';
import { cornerRounded, stateAt } from './rig';
import { resolveGroup } from './resolve';
import {
  amountWritten,
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
import { erode, move, scaled, turned, wrote } from './testing';
import { Effects, Id, PolygonId, REMEMBERED, World, emptyWorld } from './types';

function rect(x: number, y: number, w: number, h: number): Point[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

function room(world: World = emptyWorld(), at: Point[] = rect(0, 0, 100, 100)): { world: World, id: PolygonId } {
  return addPolygon(world, { type: 'level' }, at, 0, TOP);
}

function withEffects(world: World, id: Id, fx: Effects): World {
  return { ...world, effects: new Map(world.effects).set(id, fx) };
}

const round = (by: number) => ({ kind: 'round' as const, by });
const deform = (by: number) => ({ kind: 'deform' as const, by });

/** A square's area less its four corners rounded at `r`, as `segments` chords. */
function roundedSquare(side: number, r: number, segments: number): number {
  const sector = segments * r * r * Math.sin(Math.PI / 2 / segments) / 2;

  return side * side - 4 * (r * r - sector);
}

function shapeOf(world: World, id: Id) {
  return resolveAt(world, 0).find(it => it.id === id)!.shape;
}

const ROUND: Effects = { round: { segments: 8 } };

describe('a polygon\'s effects', () => {
  test('a rounded room is its arcs, after its erosion', () => {
    const { world, id } = room();
    const w = wrote(withEffects(world, id, ROUND), 0, id, erode(10), round(5));
    const shape = shapeOf(w, id);

    expect(shape).toHaveLength(1);
    expect(shape[0]).toHaveLength(4 * 9);
    expect(shapeArea(shape)).toBeCloseTo(roundedSquare(80, 5, 8), 6);
  });

  test('with nothing to them, the projection is the erosion alone', () => {
    const { world, id } = room();
    const plain = wrote(world, 0, id, erode(10));

    expect(shapeOf(withEffects(plain, id, ROUND), id)).toEqual(shapeOf(plain, id));
    expect(shapeOf(wrote(plain, 0, id, round(5)), id)).toEqual(shapeOf(plain, id));
  });

  test('a bevel is a length in the world, as a depth is, however the room is carried', () => {
    const { world, id } = room();
    const w = wrote(withEffects(world, id, ROUND), 0, id, round(5), scaled(2, 2), turned(0.3), move(40, -7));

    expect(shapeArea(shapeOf(w, id))).toBeCloseTo(roundedSquare(200, 5, 8), 6);

    // And squashed, where the projection is taken in the world instead.
    const squashed = wrote(withEffects(world, id, ROUND), 0, id, round(5), scaled(2, 1));

    expect(shapeArea(shapeOf(squashed, id))).toBeCloseTo(200 * 100 - 4 * (25 - 8 * 25 * Math.sin(Math.PI / 16) / 2), 6);
  });

  test('a corner rounds on its own, over its room\'s', () => {
    const { world, id } = room();
    const corner = world.polygons.get(id)!.points[2].id;
    const w = withRig(withEffects(world, id, { round: { segments: 4 } }), id, cornerRounded(rigOf(world, id), corner, 0, 10));
    const shape = shapeOf(w, id);

    expect(shape[0]).toHaveLength(3 + 5);
    expect(shape[0]).toContainEqual({ x: 90, y: 100 });
    expect(shape[0]).toContainEqual({ x: 100, y: 90 });
  });

  test('a corner\'s own options are over its room\'s', () => {
    const { world, id } = room();
    const corner = world.polygons.get(id)!.points[0].id;
    let w = wrote(withEffects(world, id, ROUND), 0, id, round(5));

    w = { ...w, cornerEffects: new Map([[corner, { round: { segments: 2 } }]]) };

    expect(shapeOf(w, id)[0]).toHaveLength(3 * 9 + 3);
  });

  test('a deform puts its points into every edge, off the line by its amplitude', () => {
    const { world, id } = room();
    // Out, a zigzag is teeth: out, on the line, out, on the line, out — every
    // twenty from the middle of each wall, the two at its ends half as tall.
    const fx: Effects = { deform: { spacing: 20, pattern: 'zigzag', seed: 0, sides: 'out', jitter: 0 } };
    const w = wrote(withEffects(world, id, fx), 0, id, deform(2));
    const ring = shapeOf(w, id)[0];

    expect(ring).toHaveLength(4 * 6);

    const out = ring.map(p => Math.max(-p.x, p.x - 100, -p.y, p.y - 100)).filter(d => d > 0);

    expect(out.sort()).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2]);
  });

  test('a pasted room comes with its effects and its corners\' own', () => {
    const { world, id } = room();
    const corner = world.polygons.get(id)!.points[0].id;
    let w = wrote(withEffects(world, id, ROUND), 0, id, round(5));

    w = { ...w, cornerEffects: new Map([[corner, { round: { segments: 2 } }]]) };

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
    const world = wrote(withEffects(sealing(g.world, g.id, true), g.id, ROUND), 0, g.id, round(10));

    return { world, id: g.id };
  }

  test('they apply to the union, so the join between rooms is not rounded', () => {
    const { world } = corridor();
    const set = csg(world, 0);

    // A run closes on its first point.
    expect(set).toHaveLength(1);
    expect(set[0]).toHaveLength(4 * 9 + 1);
    expect(shapeArea(set)).toBeCloseTo(200 * 100 - 4 * (100 - 8 * 100 * Math.sin(Math.PI / 16) / 2), 6);
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

    expect(out.world.effects.get(made)).toEqual(ROUND);
    expect(stateAt(out.world, made, 0).bevel).toBe(10);
    expect(shapeArea(csg(out.world, 0))).toBeCloseTo(shapeArea(csg(world, 0)), 6);
  });
});

describe('editing effects', () => {
  const DEFORM: Effects = { deform: { spacing: 20, pattern: 'zigzag', seed: 0, sides: 'out', jitter: 0 } };

  test('switched on, an effect keeps the options a thing already had', () => {
    const { world, id } = room();
    const other = room(world, rect(200, 0, 50, 50));
    const w = switchedOn(withEffects(other.world, id, { round: { segments: 2 } }), [id, other.id], 'round', REMEMBERED);

    expect(w.effects.get(id)).toEqual({ round: { segments: 2 } });
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
    const w = cornersAmounted(amountWritten(world, 0, id, 'erode', 5), 0, id, 'erode', new Set([corner]), 2);

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
    const w = wrote(withEffects(world, id, ROUND), 0, id, round(10));
    const ring = () => shapeOf(w, id)[0].length;

    const square = cornersSwitched(w, [a.id], false, REMEMBERED);

    expect(cornerRounding(square, a.id)).toBe(false);
    expect(cornerRounding(square, b.id)).toBe(true);
    expect(shapeOf(square, id)[0]).toHaveLength(ring() - 8);

    const back = cornersSwitched(square, [a.id], true, REMEMBERED);

    expect(shapeOf(back, id)).toEqual(shapeOf(w, id));

    const finer = cornersOptioned(w, [a.id], { segments: 12 }, REMEMBERED);

    expect(finer.cornerEffects.get(a.id)!.round).toEqual({ segments: 12 });
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
});

describe('the bake hears of effects', () => {
  test('an effect changed, or switched off, is a span gone stale', () => {
    const { world, id } = room();
    const w = wrote(withEffects(world, id, ROUND), 0, id, round(5));
    const bake = { spans: new Map([[0, { stamp: stamp(w, 0) } as Span]]), progress: null };

    expect(spanAt(bake, w, 0)).not.toBeNull();
    expect(spanAt(bake, withEffects(w, id, { round: { segments: 8 } }), 0)).toBeNull();
    expect(spanAt(bake, switchedOff(w, [id], 'round'), 0)).toBeNull();
  });
});
