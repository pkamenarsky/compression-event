import { describe, expect, test } from 'vitest';
import { Point } from '@ce/game/world';
import { shapeArea } from './geometry';
import { TOP, addPolygon, copied, csg, grouped, pasted, resolveAt, rigOf, sealing, withRig } from './scene';
import { cornerRounded, stateAt } from './rig';
import { resolveGroup } from './resolve';
import { erode, move, scaled, turned, wrote } from './testing';
import { Effects, Id, PolygonId, World, emptyWorld } from './types';

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

const ROUND: Effects = { round: { segments: 8, verticals: true } };

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

  test('a radius is a length in the world, as a depth is, however the room is carried', () => {
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
    const w = withRig(withEffects(world, id, { round: { segments: 4, verticals: true } }), id, cornerRounded(rigOf(world, id), corner, 0, 10));
    const shape = shapeOf(w, id);

    expect(shape[0]).toHaveLength(3 + 5);
    expect(shape[0]).toContainEqual({ x: 90, y: 100 });
    expect(shape[0]).toContainEqual({ x: 100, y: 90 });
  });

  test('a corner\'s own options are over its room\'s', () => {
    const { world, id } = room();
    const corner = world.polygons.get(id)!.points[0].id;
    let w = wrote(withEffects(world, id, ROUND), 0, id, round(5));

    w = { ...w, cornerEffects: new Map([[corner, { round: { segments: 2, verticals: true } }]]) };

    expect(shapeOf(w, id)[0]).toHaveLength(3 * 9 + 3);
  });

  test('a deform puts its points into every edge, off the line by its amplitude', () => {
    const { world, id } = room();
    // Out, a zigzag is teeth: out, on the line, out, on the line, out — every
    // twenty from the middle of each wall, the two at its ends half as tall.
    const fx: Effects = { deform: { spacing: 20, pattern: 'zigzag', seed: 0, sides: 'out' } };
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

    w = { ...w, cornerEffects: new Map([[corner, { round: { segments: 2, verticals: true } }]]) };

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
    const noise: Effects = { deform: { spacing: 15, pattern: 'noise', seed: 3, sides: 'both' } };
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
    expect(stateAt(out.world, made, 0).radius).toBe(10);
    expect(shapeArea(csg(out.world, 0))).toBeCloseTo(shapeArea(csg(world, 0)), 6);
  });
});
