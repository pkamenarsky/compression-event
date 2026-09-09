import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { Point } from '@ce/game/world';
import { nextOf, shapeArea } from './geometry';
import {
  TOP,
  Contributed,
  addArtefact,
  addPolygon,
  addVertex,
  contributing,
  csg,
  depths,
  editAt,
  grouped,
  sealing,
  hitEdge,
  hitPolygon,
  landing,
  middle,
  outlining,
  placeAt,
  removeVertices,
  resolveAt,
  showing,
  sidedWith,
  underfoot,
  withEdit,
} from './scene';
import {
  PolygonId,
  FLOOR,
  SOLID,
  PolygonKind,
  Transform,
  VERSIONS,
  VersionId,
  World,
  GroupId,
  emptyWorld,
  enclosing,
  initialState,
  ringsOf,
  standing,
} from './types';
import { Frame, truth } from './bake';
import { FORMAT, Saved, restored, saved } from './save';
import { resolveGroup, resolveInto, rings } from './resolve';

/**
 * A polygon kind by the short name these tests call it: a room, a pillar, a
 * floor, and a hole cut in a floor.
 *
 * Three of them are the kind's own name. `hole` is a void over the floors,
 * which is what a hole in one is. See `PolygonKind`.
 */
type Named = 'level' | 'solid' | 'floor' | 'hole' | 'void';

const kind = (k: Named): PolygonKind =>
  k === 'hole' ? { type: 'void', from: FLOOR }
    : k === 'void' ? { type: 'void', from: SOLID }
      : { type: k };

function rect(x: number, y: number, w: number, h: number): Point[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

function drawn(...specs: [Named, Point[]][]): { world: World, ids: PolygonId[] } {
  let world = emptyWorld();
  const ids: PolygonId[] = [];

  for (const [type, points] of specs) {
    const added = addPolygon(world, kind(type), points, 0, TOP);

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

  const made = sealed(world, 0, ids, landing(world, 0, null))!;

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
    .reduce((s, it) => s + (it.kind.type === 'solid' ? -1 : 1) * shapeArea(it.shape), 0);
}


/**
 * A group that is a scope.
 *
 * Grouping produces a loose one now — a handle and nothing else — so every
 * test about what a group *does* to the set has to say so. See `Group.sealed`.
 */
function sealed(
  ...args: Parameters<typeof grouped>
): { world: World, id: number } | null {
  const made = grouped(...args);

  return made === null ? null : { id: made.id, world: sealing(made.world, made.id, true) };
}

describe('resolving a group', () => {
  test('two overlapping rooms come to one polygon', () => {
    const { world, group } = pair();
    const out = resolveGroup(world, 0, group)!;

    expect(out).not.toBeNull();

    // One ring, so the group had nothing left to hold and went.
    expect(out.world.groups.size).toBe(0);
    expect(out.world.polygons.size).toBe(1);

    const [id] = [...out.world.polygons.keys()];
    const it = resolveAt(out.world, 0).find(r => r.id === id)!;

    // The union of two 100x100 rooms overlapping by 40.
    expect(shapeArea(it.shape)).toBeCloseTo(100 * 160, 6);

    // Nothing was animating it, so nothing is being dropped.
    expect(out.losing).toEqual([]);
  });

  test('the union it draws is the union it drew, at every version', () => {
    const { world, group } = pair();
    const before = world.versions.map((_unused, v) => drawnArea(world, v));
    const out = resolveGroup(world, 0, group)!;

    expect(out.world.versions.map((_unused, v) => drawnArea(out.world, v)))
      .toEqual(before.map(a => expect.closeTo(a, 6)));
  });

  test('a member moved at a later version is named as being lost', () => {
    const { world, group, b } = pair();

    // The right-hand room slides further right at v3, so the two overlap less.
    const moved = transformed(world, 3, b, { translation: { x: 20, y: 0 } });
    const out = resolveGroup(moved, 0, group)!;

    // Read at v0, and v0 is what every version becomes. Which is exactly what
    // `losing` is for: the shape at v4 was 100x180 and is now 100x160, and
    // nothing about the result says so.
    expect(out.losing).toEqual([3]);

    const [id] = [...out.world.polygons.keys()];

    for (const v of [0, 3, 4]) {
      const it = resolveAt(out.world, v).find(r => r.id === id)!;

      expect(shapeArea(it.shape)).toBeCloseTo(100 * 160, 6);
    }
  });

  test('read at a later version, that version is what it becomes', () => {
    const { world, group, b } = pair();
    const moved = transformed(world, 3, b, { translation: { x: 20, y: 0 } });
    const out = resolveGroup(moved, 3, group)!;

    // Nothing after v3 said anything, and v3 is where it was read, so v0 to v2
    // are the versions that change — and they are the ones named.
    expect(out.losing).toEqual([]);

    const [id] = [...out.world.polygons.keys()];
    const it = resolveAt(out.world, 0).find(r => r.id === id)!;

    expect(shapeArea(it.shape)).toBeCloseTo(100 * 180, 6);
  });

  test('a member is not left in the world with layers still naming it', () => {
    const { world, group, a, b } = pair();
    const moved = transformed(world, 3, b, { translation: { x: 20, y: 0 } });
    const out = resolveGroup(moved, 0, group)!;

    expect(out.world.polygons.has(a)).toBe(false);
    expect(out.world.polygons.has(b)).toBe(false);

    for (const version of out.world.versions) {
      expect(version.edits.has(a)).toBe(false);
      expect(version.edits.has(b)).toBe(false);
    }
  });

  test('a group deleted at a version stays deleted', () => {
    const { world, group } = pair();

    // Nothing standing anywhere is nothing to resolve.
    const empty = resolveGroup(emptyWorld(), 0, group);

    expect(empty).toBeNull();
    expect(resolveGroup(world, 0, 999)).toBeNull();
  });

  test('the group keeps its depth rather than baking it in', () => {
    const { world, group } = pair();
    const eroded = transformed(world, 2, group, { erosion: 5 });
    const before = eroded.versions.map((_unused, v) => drawnArea(eroded, v));
    const out = resolveGroup(eroded, 0, group)!;

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
    const out = resolveGroup(turned, 0, group)!;

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

    const made = sealed(world, 0, ids, landing(world, 0, null))!;
    const before = drawnArea(made.world, 0);
    const out = resolveGroup(made.world, 0, made.id)!;

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

    const made = sealed(world, 0, ids, landing(world, 0, null))!;
    const eroded = transformed(made.world, 3, made.id, { erosion: 4 });
    const before = eroded.versions.map((_unused, v) => drawnArea(eroded, v));
    const out = resolveGroup(eroded, 0, made.id)!;

    expect(out.world.versions.map((_unused, v) => drawnArea(out.world, v)))
      .toEqual(before.map(a => expect.closeTo(a, 4)));

    // The courtyard got bigger as the walls came in, rather than smaller.
    expect(before[3]).toBeLessThan(before[0]);
  });

  test('an artefact in the group stays in the group', () => {
    const { world, group } = pair();
    const { world: withKey, id: key } = (() => {
      const added = addPolygon(world, kind('level'), rect(300, 300, 10, 10), 0, TOP);

      return { world: added.world, id: added.id };
    })();

    const held = sealed(withKey, 0, [group, key], landing(withKey, 0, null))!;
    const out = resolveGroup(held.world, 0, group)!;

    // The outer group still holds what it held: the resolved thing, and the
    // room that was never part of it.
    expect(out.world.groups.get(held.id)!.members).toContain(key);
    expect(out.world.groups.get(held.id)!.members.length).toBe(2);
  });
});

describe('what one reading costs', () => {
  test('every corner stands for the whole of the polygon it is in', () => {
    const { world, group, b } = pair();
    const moved = transformed(world, 3, b, { rotation: 0.3 });
    const out = resolveGroup(moved, 0, group)!;

    // One reading means one shape: no corner is born and none dies, at any
    // version, because there is no version at which anything is different.
    for (const polygon of out.world.polygons.values()) {
      expect(polygon.points.every(p => p.birth === polygon.birth)).toBe(true);
      expect(polygon.points.every(p => p.death === polygon.death)).toBe(true);
    }

    for (let v = 0; v < VERSIONS; v++) {
      const it = resolveAt(out.world, v)[0];

      expect(it.corners.length).toBe(it.local.length);
    }
  });

  test('no layer displaces a corner, so the group\'s motion is still motion', () => {
    const { world, group } = pair();
    const turned = transformed(world, 5, group, { rotation: Math.PI / 6 });
    const out = resolveGroup(turned, 0, group)!;
    const [id] = [...out.world.polygons.keys()];

    for (const version of out.world.versions) {
      expect(version.edits.get(id)?.vertices.size ?? 0).toBe(0);
    }

    expect(out.world.versions[5].edits.get(id)!.transform.rotation)
      .toBeCloseTo(Math.PI / 6, 12);
  });
});

describe('a group made later than what is in it', () => {
  /**
   * A pair of rooms drawn at v0 and grouped at v1, with one of them turned by
   * the group's own layer. Off disk rather than built here, because what it is
   * a regression against is a shape of history the editor makes and the tests
   * above did not: the geometry outlives the handle on it.
   */
  const loaded = restored(
    JSON.parse(
      readFileSync(
        new URL('../../../scratch/world-2026-09-06T15-01-45Z.json', import.meta.url),
        'utf8',
      ),
    ) as Saved,
  ).world;

  const group = 10;

  // The file predates sealing, so its group opens loose — which is what keeps
  // every world written before the question existed looking exactly as it did.
  // Resolving is a thing done to a scope, so this seals it first, which is
  // what an author reaching for the gesture would have done.
  const world = sealing(loaded, group, true);

  test('the rooms it was made of stand before it did', () => {
    expect(world.groups.get(group)!.birth).toBe(1);
    expect(resolveAt(world, 0).length).toBe(2);
  });

  test('resolving leaves v0 exactly as full as it was', () => {
    const before = drawnArea(world, 0);
    const out = resolveGroup(world, 0, group)!;

    expect(drawnArea(out.world, 0)).toBeCloseTo(before, 4);

    // v1 turns one of the rooms, which is the layer that cannot survive — and
    // it is the one version named.
    expect(out.losing).toEqual([1]);
    expect(drawnArea(out.world, 1)).toBeCloseTo(before, 4);
  });

  test('the ring itself is born where the rooms were, not where the group was', () => {
    const out = resolveGroup(world, 0, group)!;

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

  const made = sealed(world, 0, ids, landing(world, 0, null))!;
  const out = resolveGroup(made.world, 0, made.id)!;

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

// -----------------------------------------------------------------------------
// What comes out is what can be picked
// -----------------------------------------------------------------------------

describe('the group does not survive being resolved', () => {
  test('a pillar inside a room becomes a hole in it, and nothing else', () => {
    const { world, ids } = drawn(
      ['level', rect(0, 0, 100, 100)],
      ['solid', rect(40, 40, 20, 20)],
    );

    const made = sealed(world, 0, ids, landing(world, 0, null))!;
    const before = drawnArea(made.world, 0);
    const out = resolveGroup(made.world, 0, made.id)!;

    // What the group put into the level was `level - solid`, and that is one
    // shape. The pillar was never anywhere but inside the room, so there is
    // nothing of it left to be a solid.
    expect(out.world.groups.size).toBe(0);
    expect(out.ids.length).toBe(1);
    expect(out.world.polygons.get(out.ids[0])!.type).toBe('level');

    const it = resolveAt(out.world, 0)[0];

    expect(it.rings.length).toBe(2);
    expect(shapeArea(it.shape)).toBeCloseTo(100 * 100 - 20 * 20, 6);
    expect(drawnArea(out.world, 0)).toBeCloseTo(before, 6);
  });

  test('a pillar half out of its room goes with the half that was in it', () => {
    // The case off disk: a room and a solid overlapping at one corner.
    const { world, ids } = drawn(
      ['level', rect(0, 0, 100, 100)],
      ['solid', rect(60, 60, 100, 100)],
    );

    const made = sealed(world, 0, ids, landing(world, 0, null))!;
    const out = resolveGroup(made.world, 0, made.id)!;

    // One thing, and it is the room with the corner bitten out. What the
    // pillar was doing to the rooms *around* the group goes with it, which is
    // what resolving to one shape costs.
    expect(out.world.groups.size).toBe(0);
    expect(out.ids.length).toBe(1);
    expect(out.world.polygons.get(out.ids[0])!.type).toBe('level');

    const it = resolveAt(out.world, 0)[0];

    expect(shapeArea(it.shape)).toBeCloseTo(100 * 100 - 40 * 40, 6);
    expect(it.corners.length).toBe(6);
  });

  test('a group of pillars alone resolves to nothing, and goes', () => {
    const { world, ids } = drawn(
      ['solid', rect(0, 0, 100, 100)],
      ['solid', rect(60, 0, 100, 100)],
    );

    const made = sealed(world, 0, ids, landing(world, 0, null))!;
    const out = resolveGroup(made.world, 0, made.id)!;

    // A pillar is a hole in something, and there is nothing here for it to be
    // a hole in — so the set it makes is empty and that is what it becomes.
    // The alternative is a gesture that does what it says on some groups and
    // quietly declines on others.
    expect(out.ids).toEqual([]);
    expect(out.world.polygons.size).toBe(0);
    expect(out.world.groups.size).toBe(0);
  });

  test('a solid that swallows its room takes the room with it', () => {
    const { world, ids } = drawn(
      ['level', rect(40, 40, 20, 20)],
      ['solid', rect(0, 0, 100, 100)],
    );

    const made = sealed(world, 0, ids, landing(world, 0, null))!;
    const out = resolveGroup(made.world, 0, made.id)!;

    expect(out.ids).toEqual([]);
    expect(out.world.polygons.size).toBe(0);
  });

  test('an artefact still comes out of a group that resolved to nothing', () => {
    const { world, ids } = drawn(['solid', rect(0, 0, 100, 100)]);
    const dropped = addArtefact(world, 'key', { x: 50, y: 50 }, 0, TOP);
    const made = sealed(dropped.world, 0, [ids[0], dropped.id], landing(dropped.world, 0, null))!;
    const out = resolveGroup(made.world, 0, made.id)!;

    expect(out.world.polygons.size).toBe(0);
    expect(out.world.groups.size).toBe(0);
    expect(placeAt(out.world, dropped.id, 0)).toEqual({ x: 50, y: 50 });
  });

  test('rooms that do not touch come to one polygon each', () => {
    const { world, ids } = drawn(
      ['level', rect(0, 0, 100, 100)],
      ['level', rect(300, 0, 100, 100)],
      ['level', rect(60, 0, 100, 100)],
    );

    const made = sealed(world, 0, ids, landing(world, 0, null))!;
    const out = resolveGroup(made.world, 0, made.id)!;

    // Two of them overlap and merge; the third is nowhere near either.
    expect(out.world.groups.size).toBe(0);
    expect(out.ids.length).toBe(2);

    const areas = out.ids
      .map(id => shapeArea(resolveAt(out.world, 0).find(r => r.id === id)!.shape))
      .sort((a, b) => a - b);

    expect(areas).toEqual([
      expect.closeTo(100 * 100, 6),
      expect.closeTo(100 * 160, 6),
    ]);

    // And each is its own thing: picking one is picking one.
    for (const id of out.ids) expect(enclosing(out.world, id)).toEqual([]);
  });

  test('the group is left standing only where it cannot come apart', () => {
    const { world, group } = pair();
    const dropped = addArtefact(world, 'key', { x: 50, y: 50 }, 0, TOP);
    const held = sealed(dropped.world, 0, [group, dropped.id], landing(dropped.world, 0, null))!;

    // A squash on the outer group and a turn on the artefact under it: squash,
    // turn, squash is a shear, and no layer says shear. See `composed`.
    const squashed = transformed(held.world, 1, held.id, { scale: { x: 3, y: 1 } });
    const turned = transformed(squashed, 1, dropped.id, { rotation: 0.5 });

    const out = resolveInto(turned, 0, [held.id], landing(turned, 0, null))!;

    expect(out.world.groups.has(held.id)).toBe(true);
    expect(out.ids).toEqual([held.id]);
  });

  test("an artefact's own moves are none of a resolve's business", () => {
    const { world, group } = pair();
    const dropped = addArtefact(world, 'key', { x: 50, y: 50 }, 0, TOP);
    const held = sealed(dropped.world, 0, [group, dropped.id], landing(dropped.world, 0, null))!;
    const moved = transformed(held.world, 2, dropped.id, { translation: { x: 7, y: 11 } });

    const out = resolveInto(moved, 0, [held.id], landing(moved, 0, null))!;

    // Nothing it did went into the union, so nothing it did is lost by taking
    // one — and the version that moved it is not one of the versions being
    // warned about.
    expect(out.losing).toEqual([]);
    expect(out.world.versions[2].edits.get(dropped.id)!.transform.translation)
      .toEqual({ x: 7, y: 11 });

    for (const v of [0, 2]) {
      const was = placeAt(moved, dropped.id, v)!;
      const now = placeAt(out.world, dropped.id, v)!;

      expect(now.x).toBeCloseTo(was.x, 9);
      expect(now.y).toBeCloseTo(was.y, 9);
    }
  });

  test('an artefact under it comes out where it stood', () => {
    const { world, group } = pair();
    const dropped = addArtefact(world, 'key', { x: 50, y: 50 }, 0, TOP);
    const held = sealed(dropped.world, 0, [group, dropped.id], landing(dropped.world, 0, null))!;
    const turned = transformed(held.world, 1, held.id, { rotation: 0.5 });

    const was = [0, 1, 2].map(v => placeAt(turned, dropped.id, v)!);
    const out = resolveInto(turned, 0, [held.id], landing(turned, 0, null))!;

    expect(out.world.groups.size).toBe(0);

    for (const v of [0, 1, 2]) {
      const now = placeAt(out.world, dropped.id, v)!;

      expect(now.x).toBeCloseTo(was[v].x, 9);
      expect(now.y).toBeCloseTo(was[v].y, 9);
    }
  });
});

describe('a plain selection resolves the same way a group does', () => {
  test('two picked rooms are one shape, with no group left behind', () => {
    const { world, ids } = drawn(
      ['level', rect(0, 0, 100, 100)],
      ['level', rect(60, 0, 100, 100)],
    );

    const out = resolveInto(world, 0, ids, TOP)!;

    expect(out.world.groups.size).toBe(0);
    expect(out.ids.length).toBe(1);
    expect(out.world.polygons.size).toBe(1);
    expect(shapeArea(resolveAt(out.world, 0)[0].shape)).toBeCloseTo(100 * 160, 6);
  });

  test('it is the same answer as grouping them and resolving that', () => {
    const { world, ids } = drawn(
      ['level', rect(0, 0, 100, 100)],
      ['level', rect(60, 0, 100, 100)],
      ['solid', rect(40, 40, 20, 20)],
    );

    const loose = resolveInto(world, 0, ids, TOP)!;
    const made = sealed(world, 0, ids, landing(world, 0, null))!;
    const held = resolveGroup(made.world, 0, made.id)!;

    const shapes = (w: World) => resolveAt(w, 0)
      .map(it => `${it.polygon.type}:${shapeArea(it.shape).toFixed(6)}`)
      .sort();

    expect(shapes(loose.world)).toEqual(shapes(held.world));
    expect(loose.world.groups.size).toBe(0);
    expect(held.world.groups.size).toBe(0);
  });

  test('a selection inside an open group stays inside it', () => {
    const { world, ids } = drawn(
      ['level', rect(0, 0, 100, 100)],
      ['level', rect(60, 0, 100, 100)],
      ['level', rect(400, 0, 10, 10)],
    );

    const made = sealed(world, 0, ids, landing(world, 0, null))!;
    const where = landing(made.world, 0, made.id);
    const out = resolveInto(made.world, 0, [ids[0], ids[1]], where)!;

    // The group is still there, holding what it held: the room the two came to,
    // and the one that was not picked.
    const group = out.world.groups.get(made.id)!;

    expect(group.members.length).toBe(2);
    expect(group.members).toContain(ids[2]);
    expect(out.ids.every(id => group.members.includes(id))).toBe(true);
  });

  test('a moving group holding the selection still moves it', () => {
    const { world, ids } = drawn(
      ['level', rect(0, 0, 100, 100)],
      ['level', rect(60, 0, 100, 100)],
      ['level', rect(400, 0, 10, 10)],
    );

    const made = sealed(world, 0, ids, landing(world, 0, null))!;
    const turned = transformed(made.world, 1, made.id, { rotation: 0.4 });
    const before = [0, 1, 2].map(v => drawnArea(turned, v));

    const out = resolveInto(turned, 0, [ids[0], ids[1]], landing(turned, 0, made.id))!;

    // Read in the frame a member is read in at every version, not only at this
    // one — so the group goes on turning what came out.
    expect([0, 1, 2].map(v => drawnArea(out.world, v)))
      .toEqual(before.map(a => expect.closeTo(a, 4)));
  });

  test('nothing where there is no geometry to union', () => {
    const dropped = addArtefact(emptyWorld(), 'key', { x: 0, y: 0 }, 0, TOP);

    expect(resolveInto(dropped.world, 0, [], TOP)).toBeNull();
    expect(resolveInto(dropped.world, 0, [dropped.id], TOP)).toBeNull();
  });

  test('what it is about to drop is named for a selection too', () => {
    const { world, ids } = drawn(
      ['level', rect(0, 0, 100, 100)],
      ['level', rect(60, 0, 100, 100)],
    );

    const moved = transformed(world, 3, ids[1], { translation: { x: 20, y: 0 } });

    expect(resolveInto(moved, 0, ids, TOP)!.losing).toEqual([3]);
    expect(resolveInto(moved, 3, ids, TOP)!.losing).toEqual([]);
  });
});

describe('floors are clipped to the ground', () => {
  test('a floor larger than its room comes back the size of the room', () => {
    const { world, ids } = drawn(
      ['level', rect(0, 0, 100, 100)],
      ['floor', rect(-50, -50, 300, 300)],
    );

    const made = sealed(world, 0, ids, landing(world, 0, null))!;
    const out = resolveGroup(made.world, 0, made.id)!;

    const floor = resolveAt(out.world, 0).find(r => r.polygon.type === 'floor')!;

    expect(shapeArea(floor.shape)).toBeCloseTo(100 * 100, 6);
  });

  test('a pillar shows through the floor as well as through the walls', () => {
    const { world, ids } = drawn(
      ['level', rect(0, 0, 100, 100)],
      ['solid', rect(40, 40, 20, 20)],
      ['floor', rect(0, 0, 100, 100)],
    );

    const made = sealed(world, 0, ids, landing(world, 0, null))!;
    const out = resolveGroup(made.world, 0, made.id)!;

    // `floor and (level - solid)`, so the floor has the courtyard in it too.
    // A floor drawn across a pillar is a floor where there is no room, and it
    // was only ever invisible because a wall stood in front of it.
    expect(out.ids.length).toBe(2);

    for (const kind of ['level', 'floor'] as const) {
      const it = resolveAt(out.world, 0).find(r => r.polygon.type === kind)!;

      expect(it.rings.length).toBe(2);
      expect(shapeArea(it.shape)).toBeCloseTo(100 * 100 - 20 * 20, 6);
    }
  });

  test('a floor with no room under it is not ground and does not survive', () => {
    const { world, ids } = drawn(
      ['level', rect(0, 0, 100, 100)],
      ['floor', rect(400, 400, 50, 50)],
    );

    const made = sealed(world, 0, ids, landing(world, 0, null))!;
    const out = resolveGroup(made.world, 0, made.id)!;

    expect(out.ids.length).toBe(1);
    expect(out.world.polygons.get(out.ids[0])!.type).toBe('level');
  });

  test('what the floor is clipped to is the set, not the rooms', () => {
    // Two rooms meeting, a floor over both, and a pillar across the join.
    const { world, ids } = drawn(
      ['level', rect(0, 0, 100, 100)],
      ['level', rect(90, 0, 100, 100)],
      ['solid', rect(80, 40, 30, 20)],
      ['floor', rect(0, 0, 190, 100)],
    );

    const made = sealed(world, 0, ids, landing(world, 0, null))!;
    const out = resolveGroup(made.world, 0, made.id)!;

    const level = resolveAt(out.world, 0).find(r => r.polygon.type === 'level')!;
    const floor = resolveAt(out.world, 0).find(r => r.polygon.type === 'floor')!;

    expect(shapeArea(floor.shape)).toBeCloseTo(shapeArea(level.shape), 6);
    expect(shapeArea(floor.shape)).toBeCloseTo(190 * 100 - 30 * 20, 6);
  });
});

describe('resolving does not move where a gesture turns about', () => {
  /** What a transform gesture takes as its pivot: see `middle` and the turn in
   * `canvas.ts`, which builds this out of exactly these points. */
  const pivotOf = (world: World, v: VersionId, path: GroupId[] = []) =>
    middle(outlining(world, v, resolveAt(world, v), path));

  test('a group turns about its room, not about the pillar sticking out of it', () => {
    // The pillar reaches a long way past the room, and takes a corner off it.
    // What the group puts into the level is the room less that corner, and
    // that is where the group is — the rest of the pillar is a hole in
    // nothing. Over both it would be the middle of a 460 square.
    const { world, ids } = drawn(
      ['level', rect(0, 0, 100, 100)],
      ['solid', rect(60, 60, 400, 400)],
    );

    const made = sealed(world, 0, ids, landing(world, 0, null))!;

    expect(pivotOf(made.world, 0)).toEqual({ x: 50, y: 50 });
    expect(middle(resolveAt(made.world, 0).flatMap(it => it.source)))
      .toEqual({ x: 230, y: 230 });

    // And resolving it does not move that: the shape it comes to is the shape
    // it was already drawing.
    const out = resolveGroup(made.world, 0, made.id)!;

    expect(pivotOf(out.world, 0)).toEqual({ x: 50, y: 50 });
  });

  test('a group of nothing but pillars is still somewhere', () => {
    const { world, ids } = drawn(
      ['solid', rect(0, 0, 100, 100)],
      ['solid', rect(100, 100, 100, 100)],
    );

    const made = sealed(world, 0, ids, landing(world, 0, null))!;

    // No level side to take them out of, so the walls are what it draws and
    // the walls are where it is. See `occupied`.
    expect(pivotOf(made.world, 0)).toEqual({ x: 100, y: 100 });
  });

  test('drilled into it, a member is where the member is', () => {
    const { world, ids } = drawn(
      ['level', rect(0, 0, 100, 100)],
      ['solid', rect(60, 60, 400, 400)],
    );

    const made = sealed(world, 0, ids, landing(world, 0, null))!;
    const inside = resolveAt(made.world, 0).filter(it => it.id === ids[1]);

    // The group is open, so nothing is drawing for the pillar and the pillar
    // is a thing on screen in its own right.
    expect(middle(outlining(made.world, 0, inside, [made.id])))
      .toEqual({ x: 260, y: 260 });
  });

  test('the same ground written another way turns about the same point', () => {
    // The small room sits inside the big one and shares its bottom edge, so
    // the set is exactly the big room — but the union walks that edge through
    // two extra corners, and the polygon comes out with six.
    const { world, ids } = drawn(
      ['level', rect(0, 0, 100, 100)],
      ['level', rect(60, 0, 20, 20)],
    );

    const before = pivotOf(world, 0);
    const out = resolveInto(world, 0, ids, TOP)!;

    expect(resolveAt(out.world, 0)[0].corners.length).toBe(6);
    expect(shapeArea(resolveAt(out.world, 0)[0].shape)).toBeCloseTo(100 * 100, 6);

    expect(before).toEqual({ x: 50, y: 50 });
    expect(pivotOf(out.world, 0)).toEqual(before);
  });

  test('a corner sitting on a straight edge does not drag it', () => {
    const { world, ids } = drawn(['level', rect(0, 0, 100, 100)]);
    const it = resolveAt(world, 0)[0];

    const before = pivotOf(world, 0);
    const grown = addVertex(world, 0, it, 0, { x: 90, y: 0 }).world;

    // Seven corners against four, six of them along the bottom: an average
    // would have slid a long way down and to the right.
    const more = [1, 2, 3, 4].reduce(
      (w, i) => addVertex(w, 0, resolveAt(w, 0)[0], i, { x: 10 * i + 20, y: 0 }).world,
      grown,
    );

    expect(resolveAt(more, 0)[0].corners.length).toBe(9);
    expect(pivotOf(more, 0)).toEqual(before);
  });
});

describe('the two ways to a scope agree', () => {
  /**
   * A scope's set is computed twice by two different routes, and they have to
   * be one answer.
   *
   * `contributed` folds it out of shapes — each slot unioned, then
   * `level - (solid - void)` by boolean — because that is what the CSG and the
   * bake ask for and they ask per instant. `resolve` walks it out of
   * `boundaryRuns` per member and stitches the runs, because it needs every
   * point *named* to give the polygons it produces corners with identity, and
   * a name is not recoverable from a shape.
   *
   * So the two cannot be one function without one of them paying for what the
   * other needs. Measured on a room with pillars in it, the named walk is
   * about half the cost at four members and about half again *more* at twenty
   * — it goes as members times neighbours where the fold goes as slots — and
   * the bake's scopes are the large ones. What they share is the rule:
   * `settled` folds the slots and `underfoot` cuts the floor, and both call
   * those.
   *
   * What is left is two routes to one set, which is exactly the shape of thing
   * that drifts. This is what stops it.
   */
  const both = (world: World, id: number): [number, number][] => {
    const items = resolveAt(world, 0);
    const mine = contributing(world, 0, items);

    /** What the scope put into `set`, by the id its side goes by. */
    const at = (set: 'level' | 'floor') => shapeArea(
      mine.filter(c => (sidedWith(c.id) ?? c.id) === id && c.kind.type === set)
        .flatMap(c => c.shape),
    );

    // The same members, as `readingAt` hands them over: the scope transparent,
    // so what comes back is what is under it rather than what it offers.
    const inner: Contributed[] = items.map(it => ({
      id: it.id,
      kind: it.polygon,
      shape: it.shape,
      frame: it.frame,
      simple: false,
    }));

    const walls = rings(inner, 'level').map(r => r.map(p => p.at));
    const floor = underfoot(rings(inner, 'floor').map(r => r.map(p => p.at)), [...walls]);

    return [[at('level'), shapeArea([...walls])], [at('floor'), shapeArea(floor)]];
  };

  const cases: [string, ['level' | 'solid' | 'floor' | 'hole' | 'void', number[]][]][] = [
    ['a room with a pillar', [['level', [0, 0, 100, 100]], ['solid', [40, 40, 20, 20]]]],
    ['a pillar with a void across it', [
      ['level', [0, 0, 100, 100]],
      ['solid', [20, 20, 40, 40]],
      ['void', [30, 30, 40, 20]],
    ]],
    ['a floor running past the walls', [
      ['level', [0, 0, 100, 100]],
      ['floor', [50, 50, 200, 200]],
    ]],
    ['a floor with a hole, inside a room', [
      ['level', [0, 0, 100, 100]],
      ['floor', [0, 0, 100, 100]],
      ['hole', [40, 40, 20, 20]],
    ]],
    ['two rooms over one pillar', [
      ['level', [0, 0, 100, 100]],
      ['level', [50, 0, 100, 100]],
      ['solid', [60, 20, 20, 20]],
    ]],
  ];

  for (const [name, specs] of cases) {
    test(name, () => {
      const { world, ids } = drawn(...specs.map(([k, r]) =>
        [k, rect(r[0], r[1], r[2], r[3])] as [typeof k, Point[]]));

      const made = sealed(world, 0, ids, TOP)!;

      for (const [fold, walk] of both(made.world, made.id)) {
        expect(fold).toBeCloseTo(walk, 4);
      }
    });
  }
});
