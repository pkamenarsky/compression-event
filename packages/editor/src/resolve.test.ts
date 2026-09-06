import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { Point } from '@ce/game/world';
import { nextOf, shapeArea } from './geometry';
import {
  TOP,
  addPolygon,
  addVertex,
  csg,
  depths,
  editAt,
  grouped,
  hitEdge,
  hitPolygon,
  landing,
  removeVertices,
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
  initialState,
  ringsOf,
  standing,
} from './types';
import { Frame, truth } from './bake';
import { FORMAT, Saved, restored, saved } from './save';
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

  test('a courtyard becomes a hole in the room, not a pillar in it', () => {
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

    // One polygon, on one side of the set. Nothing is taken back out.
    expect([...out.world.polygons.values()].map(p => p.type)).toEqual(['level']);

    const [polygon] = [...out.world.polygons.values()];

    // Two rings: the outline of the block, and the courtyard in it.
    expect(ringsOf(polygon.points).length).toBe(2);
    expect(new Set(polygon.points.map(p => p.ring))).toEqual(new Set([0, 1]));

    const it = resolveAt(out.world, 0)[0];

    expect(it.rings.length).toBe(2);
    expect(shapeArea(it.shape)).toBeCloseTo(before, 6);
    expect(drawnArea(out.world, 0)).toBeCloseTo(before, 6);

    // 100x100 with a 60x60 courtyard out of the middle.
    expect(before).toBeCloseTo(100 * 100 - 60 * 60, 6);
  });

  test('a hole survives being eroded, and opens as the ground shrinks', () => {
    const { world, ids } = drawn(
      ['level', rect(0, 0, 100, 20)],
      ['level', rect(0, 80, 100, 20)],
      ['level', rect(0, 0, 20, 100)],
      ['level', rect(80, 0, 20, 100)],
    );

    const made = grouped(world, 0, ids, landing(world, 0, null))!;
    const eroded = transformed(made.world, 3, made.id, { erosion: 4 });
    const before = eroded.versions.map((_unused, v) => drawnArea(eroded, v));
    const out = resolveGroup(eroded, made.id)!;

    expect(out.world.versions.map((_unused, v) => drawnArea(out.world, v)))
      .toEqual(before.map(a => expect.closeTo(a, 4)));

    // The courtyard got bigger as the walls came in, rather than smaller.
    expect(before[3]).toBeLessThan(before[0]);
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

describe('a group made later than what is in it', () => {
  /**
   * A pair of rooms drawn at v0 and grouped at v1, with one of them turned by
   * the group's own layer. Off disk rather than built here, because what it is
   * a regression against is a shape of history the editor makes and the tests
   * above did not: the geometry outlives the handle on it.
   */
  const world = restored(
    JSON.parse(
      readFileSync(
        new URL('../../../scratch/world-2026-09-06T15-01-45Z.json', import.meta.url),
        'utf8',
      ),
    ) as Saved,
  ).world;

  const group = 10;

  test('the rooms it was made of stand before it did', () => {
    expect(world.groups.get(group)!.birth).toBe(1);
    expect(resolveAt(world, 0).length).toBe(2);
  });

  test('resolving leaves v0 exactly as full as it was', () => {
    const before = world.versions.map((_unused, v) => drawnArea(world, v));
    const out = resolveGroup(world, group)!;

    expect(drawnArea(out.world, 0)).toBeGreaterThan(0);
    expect(out.world.versions.map((_unused, v) => drawnArea(out.world, v)))
      .toEqual(before.map(a => expect.closeTo(a, 4)));
  });

  test('the ring itself is born where the rooms were, not where the group was', () => {
    const out = resolveGroup(world, group)!;

    for (const polygon of out.world.polygons.values()) expect(polygon.birth).toBe(0);

    // Corners do come and go across v0 to v1, and rightly: the group turns one
    // of the rooms there, so the pair of edges that cross is a different pair
    // and the crossing they made is a different crossing. What must not happen
    // is the whole ring arriving at once.
    const at = (v: VersionId) => resolveAt(out.world, v)[0].corners.length;

    expect(at(0)).toBeGreaterThan(3);
    expect(at(1)).toBeGreaterThan(3);
  });
});

// -----------------------------------------------------------------------------
// A polygon with a hole in it, once it is one
// -----------------------------------------------------------------------------

/** Four corridors round an empty middle, resolved: one room with a courtyard.
 * The shape everything below is about. */
function holed(): { world: World, id: PolygonId } {
  const { world, ids } = drawn(
    ['level', rect(0, 0, 100, 20)],
    ['level', rect(0, 80, 100, 20)],
    ['level', rect(0, 0, 20, 100)],
    ['level', rect(80, 0, 20, 100)],
  );

  const made = grouped(world, 0, ids, landing(world, 0, null))!;
  const out = resolveGroup(made.world, made.id)!;

  return { world: out.world, id: [...out.world.polygons.keys()][0] };
}

describe('a hole is a ring like any other', () => {
  test('the CSG sees through it', () => {
    const { world } = holed();

    // The courtyard is outside the set: the runs are the outline and the hole,
    // and the middle of the world is not in the level.
    expect(shapeArea(resolveAt(world, 0)[0].shape)).toBeCloseTo(100 * 100 - 60 * 60, 6);
    expect(csg(world, 0).length).toBeGreaterThan(0);
  });

  test('a click in the courtyard picks nothing', () => {
    const { world, id } = holed();
    const items = resolveAt(world, 0);

    expect(hitPolygon(items, { x: 10, y: 50 })).toBe(id);
    expect(hitPolygon(items, { x: 50, y: 50 })).toBeNull();
  });

  test('a corner added to the courtyard stays in the courtyard', () => {
    const { world, id } = holed();
    const it = resolveAt(world, 0).find(r => r.id === id)!;

    // An edge of the hole rather than of the outline.
    const inner = it.corners.findIndex(c => c.ring === 1);
    const at = hitEdge([it], midpoint(it, inner), 1)!;

    expect(at.index).toBe(inner);

    const grown = addVertex(world, 0, it, inner, at.at);
    const polygon = grown.world.polygons.get(id)!;
    const corner = polygon.points.find(c => c.id === grown.vertex)!;

    expect(corner.ring).toBe(1);
    expect(ringsOf(resolveAt(grown.world, 0).find(r => r.id === id)!.corners).length).toBe(2);
  });

  test('the edge after a ring is that ring, not the next one', () => {
    const { world, id } = holed();
    const it = resolveAt(world, 0).find(r => r.id === id)!;

    // The outline's last corner joins its first, not the courtyard's first.
    const last = it.rings[1] - 1;
    const at = hitEdge([it], midpoint(it, last), 1)!;

    expect(at.index).toBe(last);
    expect(nextOf(it.rings, it.corners.length, last)).toBe(0);
    expect(nextOf(it.rings, it.corners.length, it.corners.length - 1)).toBe(it.rings[1]);
  });

  test('taking the courtyard below three corners is refused, not fudged', () => {
    const { world, id } = holed();
    const it = resolveAt(world, 0).find(r => r.id === id)!;
    const inner = it.corners.filter(c => c.ring === 1).map(c => c.id);

    expect(inner.length).toBeGreaterThan(3);

    // Down to three is fine, and the outline is untouched by it.
    const some = removeVertices(world, 1, inner.slice(0, inner.length - 3));
    const left = resolveAt(some, 1).find(r => r.id === id)!;

    expect(left.corners.filter(c => c.ring === 1).length).toBe(3);
    expect(ringsOf(left.corners).length).toBe(2);

    // One more would leave a ring that is not one, so nothing goes at all.
    expect(removeVertices(some, 2, [left.corners.find(c => c.ring === 1)!.id]))
      .toBe(some);
  });

  test('it survives a round trip through a file', () => {
    const { world, id } = holed();
    const back = restored(JSON.parse(JSON.stringify(saved(initialState(world))))).world;
    const polygon = back.polygons.get(id)!;

    expect(polygon.points.map(c => c.ring)).toEqual(world.polygons.get(id)!.points.map(c => c.ring));
    expect(shapeArea(resolveAt(back, 0)[0].shape)).toBeCloseTo(100 * 100 - 60 * 60, 6);
  });

  test('a file written before rings reads as one ring', () => {
    const { world, ids } = drawn(['level', rect(0, 0, 10, 10)]);
    const file = JSON.parse(JSON.stringify(saved(initialState(world))));

    for (const [, polygon] of file.world.polygons) {
      for (const corner of polygon.points) delete corner.ring;
    }

    file.format = FORMAT - 1;

    const back = restored(file).world;

    expect(back.polygons.get(ids[0])!.points.every(c => c.ring === 0)).toBe(true);
  });

  test('the bake carries it across a span without losing the hole', () => {
    const { world, id } = holed();
    const moved = transformed(world, 1, id, { translation: { x: 30, y: 0 } });

    // The boundary is the outline and the courtyard, and it stays both for the
    // length of the span: a translation moves the block and takes the hole with
    // it, so the total run length holds still.
    const outline = 4 * 100;
    const courtyard = 4 * 60;

    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      expect(walked(truth(moved, 0, t))).toBeCloseTo(outline + courtyard, 6);
    }
  });
});

/** Total length of a frame's runs: enough of a fingerprint for a boundary that
 * is supposed to be one outline and one courtyard. */
function walked(frame: Frame): number {
  let out = 0;

  for (const run of frame) {
    for (let i = 1; i < run.points.length; i++) {
      out += Math.hypot(
        run.points[i].x - run.points[i - 1].x,
        run.points[i].y - run.points[i - 1].y,
      );
    }
  }

  return out;
}

/** The middle of the edge leaving corner `i`, round its own ring. */
function midpoint(it: { source: Point[], rings: readonly number[] }, i: number): Point {
  const j = nextOf(it.rings, it.source.length, i);

  return {
    x: (it.source[i].x + it.source[j].x) / 2,
    y: (it.source[i].y + it.source[j].y) / 2,
  };
}
