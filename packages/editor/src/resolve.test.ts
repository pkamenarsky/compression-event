import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { Point } from '@ce/game/world';
import { nextOf, shapeArea } from './geometry';
import {
  TOP,
  addArtefact,
  addPolygon,
  addVertex,
  csg,
  depths,
  editAt,
  grouped,
  hitEdge,
  hitPolygon,
  landing,
  placeAt,
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
  enclosing,
  initialState,
  ringsOf,
  standing,
} from './types';
import { Frame, truth } from './bake';
import { FORMAT, Saved, restored, saved } from './save';
import { resolveGroup, resolveInto } from './resolve';

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

    const made = grouped(world, 0, ids, landing(world, 0, null))!;
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

    const made = grouped(world, 0, ids, landing(world, 0, null))!;
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
      const added = addPolygon(world, 'level', rect(300, 300, 10, 10), 0, TOP);

      return { world: added.world, id: added.id };
    })();

    const held = grouped(withKey, 0, [group, key], landing(withKey, 0, null))!;
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

  const made = grouped(world, 0, ids, landing(world, 0, null))!;
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

    const made = grouped(world, 0, ids, landing(world, 0, null))!;
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

  test('a pillar half out of its room keeps the half that was never in it', () => {
    // The case off disk: a room and a solid overlapping at one corner. What
    // the group put into the set is the room less the overlap; what is left of
    // the solid is still cutting whatever else it reaches.
    const { world, ids } = drawn(
      ['level', rect(0, 0, 100, 100)],
      ['solid', rect(60, 60, 100, 100)],
    );

    const made = grouped(world, 0, ids, landing(world, 0, null))!;
    const before = drawnArea(made.world, 0);
    const out = resolveGroup(made.world, 0, made.id)!;

    expect(out.world.groups.size).toBe(0);
    expect(out.ids.map(id => out.world.polygons.get(id)!.type).sort())
      .toEqual(['level', 'solid']);

    const level = resolveAt(out.world, 0).find(r => r.polygon.type === 'level')!;
    const solid = resolveAt(out.world, 0).find(r => r.polygon.type === 'solid')!;

    // The room with the corner bitten out, and the pillar with that same bite
    // missing: the two are disjoint, which is what makes the subtraction a
    // subtraction rather than a redrawing.
    expect(shapeArea(level.shape)).toBeCloseTo(100 * 100 - 40 * 40, 6);
    expect(shapeArea(solid.shape)).toBeCloseTo(100 * 100 - 40 * 40, 6);
    expect(drawnArea(out.world, 0)).toBeCloseTo(before, 6);
  });

  test('a group of pillars alone comes back as pillars', () => {
    const { world, ids } = drawn(
      ['solid', rect(0, 0, 100, 100)],
      ['solid', rect(60, 0, 100, 100)],
    );

    const made = grouped(world, 0, ids, landing(world, 0, null))!;
    const out = resolveGroup(made.world, 0, made.id)!;

    // Nothing to cut them out of, so they are the whole of what is left.
    expect(out.ids.length).toBe(1);
    expect(out.world.polygons.get(out.ids[0])!.type).toBe('solid');
    expect(shapeArea(resolveAt(out.world, 0)[0].shape)).toBeCloseTo(100 * 160, 6);
  });

  test('rooms that do not touch come to one polygon each', () => {
    const { world, ids } = drawn(
      ['level', rect(0, 0, 100, 100)],
      ['level', rect(300, 0, 100, 100)],
      ['level', rect(60, 0, 100, 100)],
    );

    const made = grouped(world, 0, ids, landing(world, 0, null))!;
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
    const held = grouped(dropped.world, 0, [group, dropped.id], landing(dropped.world, 0, null))!;

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
    const held = grouped(dropped.world, 0, [group, dropped.id], landing(dropped.world, 0, null))!;
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
    const held = grouped(dropped.world, 0, [group, dropped.id], landing(dropped.world, 0, null))!;
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
    const made = grouped(world, 0, ids, landing(world, 0, null))!;
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

    const made = grouped(world, 0, ids, landing(world, 0, null))!;
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

    const made = grouped(world, 0, ids, landing(world, 0, null))!;
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
