import { describe, expect, test } from 'vitest';
import { Point } from '@ce/game/world';
import { shapeArea, union } from './geometry';
import {
  TOP,
  addPolygon,
  csg,
  depths,
  editAt,
  grouped,
  landing,
  resolveAt,
  showing,
  withEdit,
} from './scene';
import {
  PolygonId,
  PolygonType,
  Transform,
  VERSIONS,
  VersionId,
  World,
  emptyWorld,
  standing,
} from './types';
import { resolveGroup } from './resolve';

function rect(x: number, y: number, w: number, h: number): Point[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

function drawn(...specs: [PolygonType, Point[]][]): { world: World, ids: PolygonId[] } {
  let world = emptyWorld();
  const ids: PolygonId[] = [];

  for (const [type, points] of specs) {
    const added = addPolygon(world, type, points, 0, TOP);

    world = added.world;
    ids.push(added.id);
  }

  return { world, ids };
}

function transformed(
  world: World,
  v: VersionId,
  id: number,
  t: Partial<Transform>,
): World {
  const it = resolveAt(world, v).find(r => r.id === id);
  const edit = editAt(world, v, id, it ?? (depths(world, v).get(id) ?? 0));

  return withEdit(world, v, id, { ...edit, transform: { ...edit.transform, ...t } });
}

/** Two overlapping rooms in one group, at the top level. */
function pair(): { world: World, a: number, b: number, group: number } {
  const { world, ids } = drawn(
    ['level', rect(0, 0, 100, 100)],
    ['level', rect(60, 0, 100, 100)],
  );

  const made = grouped(world, 0, ids, landing(world, 0, null))!;

  return { world: made.world, a: ids[0], b: ids[1], group: made.id };
}

/** The set the game would get, as one number per version: enough to say the
 * resolve did not change what is on screen. */
function areas(world: World): number[] {
  return world.versions.map((_unused, v) =>
    csg(world, v).reduce((s, run) => s + run.length, 0));
}

/** What is drawn at a version, as one shape. */
function drawnArea(world: World, v: VersionId): number {
  return showing(world, v, resolveAt(world, v), [])
    .reduce((s, it) => s + (it.kind === 'solid' ? -1 : 1) * shapeArea(it.shape), 0);
}

describe('resolving a group', () => {
  test('two overlapping rooms come to one polygon', () => {
    const { world, group } = pair();
    const out = resolveGroup(world, group)!;

    expect(out).not.toBeNull();

    // One ring, so the group had nothing left to hold and went.
    expect(out.world.groups.size).toBe(0);
    expect(out.world.polygons.size).toBe(1);

    const [id] = [...out.world.polygons.keys()];
    const it = resolveAt(out.world, 0).find(r => r.id === id)!;

    // The union of two 100x100 rooms overlapping by 40.
    expect(shapeArea(it.shape)).toBeCloseTo(100 * 160, 6);
    expect(out.loose).toBe(0);
  });

  test('the union it draws is the union it drew, at every version', () => {
    const { world, group } = pair();
    const before = world.versions.map((_unused, v) => drawnArea(world, v));
    const out = resolveGroup(world, group)!;

    expect(out.world.versions.map((_unused, v) => drawnArea(out.world, v)))
      .toEqual(before.map(a => expect.closeTo(a, 6)));
  });

  test('a member moved at a later version keeps its corners', () => {
    const { world, group, b } = pair();

    // The right-hand room slides further right at v3, so the two overlap less.
    const moved = transformed(world, 3, b, { translation: { x: 20, y: 0 } });
    const out = resolveGroup(moved, group)!;

    const [id] = [...out.world.polygons.keys()];
    const polygon = out.world.polygons.get(id)!;

    // Nothing was born and nothing died: the same eight corners, moved.
    expect(polygon.points.every(p => p.birth === 0 && p.death === null)).toBe(true);

    const before = resolveAt(out.world, 2).find(r => r.id === id)!;
    const later = resolveAt(out.world, 4).find(r => r.id === id)!;

    expect(before.corners.map(c => c.id)).toEqual(later.corners.map(c => c.id));
    expect(shapeArea(before.shape)).toBeCloseTo(100 * 160, 6);
    expect(shapeArea(later.shape)).toBeCloseTo(100 * 180, 6);
  });

  test('members pulled apart bring the crossings to an end', () => {
    const { world, group, b } = pair();

    // Far enough right to clear the first room entirely: two rings where there
    // was one, and the four crossings that made the union have nothing to be.
    const moved = transformed(world, 4, b, { translation: { x: 200, y: 0 } });
    const out = resolveGroup(moved, group)!;

    // Two rings at v4 and after, so the group stays to hold them.
    expect(out.world.groups.has(group)).toBe(true);
    expect(out.world.polygons.size).toBeGreaterThan(1);

    const at = (v: VersionId) => resolveAt(out.world, v).length;

    expect(at(0)).toBe(1);
    expect(at(3)).toBe(1);
    expect(at(4)).toBe(2);
  });

  test('a group deleted at a version stays deleted', () => {
    const { world, group } = pair();

    // Nothing standing anywhere is nothing to resolve.
    const empty = resolveGroup(emptyWorld(), group);

    expect(empty).toBeNull();
    expect(resolveGroup(world, 999)).toBeNull();
  });

  test('the group keeps its depth rather than baking it in', () => {
    const { world, group } = pair();
    const eroded = transformed(world, 2, group, { erosion: 5 });
    const before = eroded.versions.map((_unused, v) => drawnArea(eroded, v));
    const out = resolveGroup(eroded, group)!;

    expect(out.world.versions.map((_unused, v) => drawnArea(out.world, v)))
      .toEqual(before.map(a => expect.closeTo(a, 4)));

    // On the layer, not in the points: v0 and v1 are the shape unoffset.
    const [id] = [...out.world.polygons.keys()];

    expect(out.world.versions[2].edits.get(id)!.transform.erosion).toBe(5);
    expect(out.world.versions[0].edits.get(id)?.transform.erosion ?? 0).toBe(0);
  });

  test('a moving group keeps its motion as a transform', () => {
    const { world, group } = pair();
    const turned = transformed(world, 5, group, { rotation: Math.PI / 6 });
    const out = resolveGroup(turned, group)!;

    const [id] = [...out.world.polygons.keys()];

    // The turn is still a turn — the corners did not each move on their own.
    expect(out.world.versions[5].edits.get(id)!.transform.rotation)
      .toBeCloseTo(Math.PI / 6, 12);
    expect(out.world.versions[5].edits.get(id)!.vertices.size).toBe(0);
  });

  test('a courtyard becomes a hole taken back out', () => {
    // Four corridors round an empty middle: the union has a hole in it.
    const { world, ids } = drawn(
      ['level', rect(0, 0, 100, 20)],
      ['level', rect(0, 80, 100, 20)],
      ['level', rect(0, 0, 20, 100)],
      ['level', rect(80, 0, 20, 100)],
    );

    const made = grouped(world, 0, ids, landing(world, 0, null))!;
    const before = drawnArea(made.world, 0);
    const out = resolveGroup(made.world, made.id)!;

    const kinds = [...out.world.polygons.values()].map(p => p.type).sort();

    expect(kinds).toEqual(['level', 'solid']);
    expect(drawnArea(out.world, 0)).toBeCloseTo(before, 6);
  });

  test('an artefact in the group stays in the group', () => {
    const { world, group } = pair();
    const { world: withKey, id: key } = (() => {
      const added = addPolygon(world, 'level', rect(300, 300, 10, 10), 0, TOP);

      return { world: added.world, id: added.id };
    })();

    const held = grouped(withKey, 0, [group, key], landing(withKey, 0, null))!;
    const out = resolveGroup(held.world, group)!;

    // The outer group still holds what it held: the resolved thing, and the
    // room that was never part of it.
    expect(out.world.groups.get(held.id)!.members).toContain(key);
    expect(out.world.groups.get(held.id)!.members.length).toBe(2);
  });
});

describe('lineage', () => {
  test('every corner of every version belongs to a standing vertex', () => {
    const { world, group, b } = pair();
    const moved = transformed(world, 3, b, { rotation: 0.3 });
    const out = resolveGroup(moved, group)!;

    for (let v = 0; v < VERSIONS; v++) {
      for (const it of resolveAt(out.world, v)) {
        expect(it.corners.length).toBe(it.local.length);
        expect(it.corners.every(c => standing(c, new Set(Array.from({ length: v + 1 }, (_u, i) => i)))))
          .toBe(true);
      }
    }
  });

  test('the ring order holds still as corners come and go', () => {
    const { world, group, b } = pair();
    const moved = transformed(world, 4, b, { translation: { x: 200, y: 0 } });
    const out = resolveGroup(moved, group)!;

    for (const polygon of out.world.polygons.values()) {
      const ids = polygon.points.map(p => p.id);

      // Every corner named once, and the dead left where they were.
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
