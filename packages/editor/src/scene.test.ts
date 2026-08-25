import { describe, expect, test } from 'vitest';
import { Point } from '@ce/game/world';
import { OpSubtract, Shape, combine, shapeArea, simplify } from './geometry';
import {
  Resolved,
  addPolygon,
  composed,
  contributing,
  grouped,
  occupying,
  reachable,
  reaching,
  showing,
  sidedWith,
  swallowed,
  solidSide,
  polygonsIn,
  ungrouped,
  without,
  addVertex,
  hitPolygons,
  affine,
  copied,
  csg,
  editAt,
  hitEdge,
  hitVertex,
  pasted,
  placeVertex,
  place,
  removeVertices,
  resolveAt,
  unplace,
  withEdit,
} from './scene';
import {
  EMPTY_TRANSFORM,
  GroupId,
  Id,
  PolygonId,
  PolygonType,
  Transform,
  VersionId,
  World,
  emptyWorld,
  opened,
} from './types';

function rect(x: number, y: number, w: number, h: number): Point[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

/** A world with these polygons drawn in v0, and the ids they were given. */
function drawn(...specs: [PolygonType, Point[]][]): { world: World, ids: PolygonId[] } {
  let world = emptyWorld();
  const ids: PolygonId[] = [];

  for (const [type, points] of specs) {
    const added = addPolygon(world, type, points, 0);

    world = added.world;
    ids.push(added.id);
  }

  return { world, ids };
}

function only(world: World, v: VersionId, id: PolygonId): Resolved {
  return resolveAt(world, v).find(it => it.id === id)!;
}

/** Whatever this version already said about the polygon, with these components
 * of the transform replaced. */
function transformed(
  world: World,
  v: VersionId,
  id: PolygonId,
  t: Partial<Transform>,
): World {
  const edit = editAt(world, v, id, only(world, v, id).erosion);

  return withEdit(world, v, id, { ...edit, transform: { ...edit.transform, ...t } });
}

const reversed = (points: Point[]) => [...points].reverse();

/** The same two polygons, drawn each of the four ways round. */
function everyWinding(a: Point[], b: Point[]): [Point[], Point[]][] {
  return [
    [a, b],
    [reversed(a), b],
    [a, reversed(b)],
    [reversed(a), reversed(b)],
  ];
}

/** Total length of a set of open runs. */
const runLength = (runs: Point[][]) =>
  runs.reduce((t, r) => t + r.slice(1).reduce(
    (u, p, i) => u + Math.hypot(p.x - r[i].x, p.y - r[i].y), 0), 0);

/** The perimeter the outline ought to have, taken the ring way round. */
function outlineOf(items: Resolved[]): number {
  const level = items.filter(i => i.polygon.type === 'level').flatMap(i => i.shape);
  const solid = items.filter(i => i.polygon.type === 'solid').flatMap(i => i.shape);
  const shape: Shape = solid.length === 0
    ? simplify(level)
    : combine(level, solid, OpSubtract);

  return shape.reduce((t, r) => t + r.reduce(
    (u, p, i) => u + Math.hypot(
      p.x - r[(i + 1) % r.length].x, p.y - r[(i + 1) % r.length].y), 0), 0);
}

describe('csg', () => {
  test('overlapping rooms merge whichever way round they were drawn', () => {
    // 10x10 and 10x10 overlapping by 5x5: 100 + 100 - 25.
    for (const [a, b] of everyWinding(rect(0, 0, 10, 10), rect(5, 5, 10, 10))) {
      const { world } = drawn(['level', a], ['level', b]);
      const items = resolveAt(world, 0);

      // The runs add up to the union's outline and no more. A wall left
      // standing between the two rooms would show up as extra length.
      expect(runLength(csg(world, 0))).toBeCloseTo(outlineOf(items), 6);
      expect(shapeArea(simplify(items.flatMap(i => i.shape)))).toBeCloseTo(175, 6);
    }
  });

  test('a solid subtracts whichever way round it was drawn', () => {
    for (const [a, b] of everyWinding(rect(0, 0, 10, 10), rect(5, 5, 10, 10))) {
      const { world } = drawn(['level', a], ['solid', b]);

      expect(shapeArea(csg(world, 0))).toBeCloseTo(75, 6);
    }
  });

  test('two triangles wound against each other still merge', () => {
    // Drawn in the editor, one clicked round the other way. Before the winding
    // was normalised this came out as two rings — the overlap cancelling to a
    // hole — and the wall between them stayed on screen.
    const a = [{ x: -320, y: -128 }, { x: 96, y: -128 }, { x: -128, y: 192 }];
    const b = [{ x: 96, y: 224 }, { x: 288, y: -64 }, { x: -128, y: -64 }];

    const only = (r: Point[]) => resolveAt(drawn(['level', r]).world, 0);
    const pair = drawn(['level', a], ['level', b]).world;
    const both = resolveAt(pair, 0);

    const apart = shapeArea(simplify(only(a).flatMap(i => i.shape)))
      + shapeArea(simplify(only(b).flatMap(i => i.shape)));

    expect(apart).toBeCloseTo(126464, 6);

    // The outline is the union's, with nothing left over: the hole the
    // cancellation used to punch would carry its own runs.
    expect(runLength(csg(pair, 0))).toBeCloseTo(outlineOf(both), 6);

    // And they do overlap, so the union is smaller than the two of them.
    const together = shapeArea(simplify(both.flatMap(i => i.shape)));

    expect(together).toBeLessThan(apart);
    expect(together).toBeGreaterThan(66560);
  });

  test('a room eroded past its own middle is gone, not inside out', () => {
    // The old per-vertex erosion walked each corner along its bisector and let
    // them cross: a square taken past its own middle came back a smaller square
    // wound the same way it started, so it read as ground rather than as
    // nothing. Subtracting the swept band has no such state.
    const { world, ids } = drawn(['level', rect(0, 0, 10, 10)]);
    const gone = transformed(world, 0, ids[0], { erosion: 8 });

    expect(shapeArea(csg(gone, 0))).toBeCloseTo(0, 6);
  });

  test('an eroded strip takes its ground with it', () => {
    const { world, ids } = drawn(['level', rect(0, 0, 40, 40)], ['level', rect(5, 15, 30, 10)]);
    const eroded = transformed(world, 0, ids[1], { erosion: 8 });

    // The strip is inside the room, so it never added anything; eroding it flat
    // must not add any either.
    expect(shapeArea(csg(eroded, 0))).toBeCloseTo(1600, 6);
  });

  test('a transform moves what the set is computed from', () => {
    const { world, ids } = drawn(['level', rect(0, 0, 10, 10)], ['level', rect(0, 0, 10, 10)]);
    const moved = transformed(world, 0, ids[1], { translation: { x: 100, y: 0 } });

    const shape = csg(moved, 0);

    // Far enough apart to stay two rooms, and no area lost in the move.
    expect(shape.length).toBe(2);
    expect(shapeArea(shape)).toBeCloseTo(200, 6);
  });
});

describe('transforms', () => {
  const turned: Transform = {
    translation: { x: 40, y: -15 },
    rotation: Math.PI / 4,
    scale: { x: 1.3, y: 0.6 },
    erosion: 0,
  };

  test('a squash and a turn come apart again exactly', () => {
    for (const p of rect(-30, 20, 70, 45)) {
      const back = unplace(affine(turned), place(affine(turned), [p])[0]);

      expect(back.x).toBeCloseTo(p.x, 9);
      expect(back.y).toBeCloseTo(p.y, 9);
    }
  });

  test('the axes scale independently', () => {
    const ring = place(
      affine({ ...EMPTY_TRANSFORM, scale: { x: 2, y: 0.5 } }),
      rect(0, 0, 10, 10),
    );

    expect(ring[1].x - ring[0].x).toBeCloseTo(20, 9);
    expect(ring[2].y - ring[1].y).toBeCloseTo(5, 9);
  });

  test('a squashed room erodes to a constant width, not a squashed one', () => {
    // Erosion is the projection and comes last, so it offsets whatever the
    // transform chain produced. A 10x10 room scaled to 40x10 and eroded by 2 is
    // 36x6 — the offset does not get stretched along with the room.
    const { world, ids } = drawn(['level', rect(0, 0, 10, 10)]);
    const squashed = transformed(world, 0, ids[0], { scale: { x: 4, y: 1 }, erosion: 2 });

    expect(shapeArea(csg(squashed, 0))).toBeCloseTo(36 * 6, 6);
  });
});

describe('versions', () => {
  test('a fresh version renders exactly as its base did', () => {
    const { world, ids } = drawn(['level', rect(0, 0, 100, 100)]);
    const eroded = transformed(world, 1, ids[0], { erosion: 10 });

    // v1 states a depth; v2 and v3 state nothing at all, so they inherit it
    // rather than dropping back to the unshrunk shape.
    for (const v of [1, 2, 3, 4]) {
      expect(only(eroded, v, ids[0]).erosion).toBe(10);
      expect(shapeArea(csg(eroded, v))).toBeCloseTo(6400, 6);
    }

    expect(shapeArea(csg(eroded, 0))).toBeCloseTo(10000, 6);
  });

  test('an edit made in an early version flows forward into every later one', () => {
    // The thing the whole layer model exists for: v0 is edited once and v4
    // moves too, without the edit being replayed by hand into v1, v2 or v3.
    const { world, ids } = drawn(['level', rect(0, 0, 100, 100)]);
    const shrunk = transformed(world, 3, ids[0], { erosion: 20 });
    const moved = transformed(shrunk, 0, ids[0], { translation: { x: 500, y: 0 } });

    const late = only(moved, 4, ids[0]);

    expect(late.source[0].x).toBeCloseTo(500, 9);

    // And v3's own erosion is still on top of it, so the two compose.
    expect(late.erosion).toBe(20);
    expect(shapeArea(csg(moved, 4))).toBeCloseTo(60 * 60, 6);
  });

  test('an edit lands in the version it was made in and no earlier one', () => {
    const { world, ids } = drawn(['level', rect(0, 0, 100, 100)]);
    const moved = transformed(world, 2, ids[0], { translation: { x: 500, y: 0 } });

    expect(only(moved, 1, ids[0]).source[0].x).toBeCloseTo(0, 9);
    expect(only(moved, 2, ids[0]).source[0].x).toBeCloseTo(500, 9);
  });

  test('a polygon does not exist before the version it was drawn in', () => {
    let { world, ids } = drawn(['level', rect(0, 0, 10, 10)]);
    const added = addPolygon(world, 'level', rect(50, 0, 10, 10), 2);

    expect(resolveAt(added.world, 1).map(it => it.id)).toEqual(ids);
    expect(resolveAt(added.world, 2).map(it => it.id)).toEqual([...ids, added.id]);
  });

  test('erosion is a projection, so a later version erodes the source', () => {
    // Not the shape the version before it drew. Depths do not accumulate: v1
    // says 10 and v2 says 20, and v2 is the source offset by 20 rather than by
    // 30 or by 20 on top of 10.
    const { world, ids } = drawn(['level', rect(0, 0, 100, 100)]);
    const a = transformed(world, 1, ids[0], { erosion: 10 });
    const b = transformed(a, 2, ids[0], { erosion: 20 });

    expect(shapeArea(csg(b, 2))).toBeCloseTo(60 * 60, 6);

    // And the source is untouched by either of them, at every version.
    for (const v of [0, 1, 2, 3, 4]) {
      expect(only(b, v, ids[0]).source).toEqual(rect(0, 0, 100, 100));
    }
  });

  test('scrubbing a depth back brings the shape back', () => {
    const { world, ids } = drawn(['level', rect(0, 0, 100, 100)]);
    const gone = transformed(world, 2, ids[0], { erosion: 80 });

    expect(shapeArea(csg(gone, 2))).toBeCloseTo(0, 6);

    const back = transformed(gone, 2, ids[0], { erosion: 0 });

    expect(shapeArea(csg(back, 2))).toBeCloseTo(10000, 6);
  });
});

describe('placeVertex', () => {
  const turned: Transform = {
    translation: { x: 40, y: -15 },
    rotation: Math.PI / 4,
    scale: { x: 1.3, y: 0.6 },
    erosion: 0,
  };

  /** The drag, as the canvas does it: resolve, take this version's edit, write. */
  function drag(
    world: World,
    v: VersionId,
    id: PolygonId,
    index: number,
    to: Point,
  ): World {
    const it = only(world, v, id);

    return withEdit(world, v, id, placeVertex(it, editAt(world, v, id, it.erosion), index, to));
  }

  test('a source vertex lands under the cursor and takes nothing with it', () => {
    // The bug this is here for: the frame used to be `centroid(points)`, so
    // moving one vertex moved the pivot and swung every other vertex by
    // `(I - M)·Δcentroid` — zero until the polygon was turned or scaled, and a
    // visible smear afterwards.
    for (const erosion of [0, 3, 8]) {
      const { world, ids } = drawn(['level', rect(0, 0, 100, 100)]);
      const set = transformed(world, 0, ids[0], { ...turned, erosion });

      const before = only(set, 0, ids[0]).source;
      const to = { x: before[0].x + 17, y: before[0].y - 9 };
      const after = only(drag(set, 0, ids[0], 0, to), 0, ids[0]).source;

      expect(after[0].x).toBeCloseTo(to.x, 9);
      expect(after[0].y).toBeCloseTo(to.y, 9);

      for (let i = 1; i < before.length; i++) {
        expect(after[i].x).toBeCloseTo(before[i].x, 9);
        expect(after[i].y).toBeCloseTo(before[i].y, 9);
      }
    }
  });

  test('dragging the same vertex twice is not cumulative', () => {
    const { world, ids } = drawn(['level', rect(0, 0, 100, 100)]);
    const set = transformed(world, 0, ids[0], turned);

    const once = drag(set, 0, ids[0], 0, { x: 12, y: 34 });
    const twice = drag(once, 0, ids[0], 0, { x: 12, y: 34 });

    expect(only(twice, 0, ids[0]).source[0].x).toBeCloseTo(12, 9);
    expect(only(twice, 0, ids[0]).source[0].y).toBeCloseTo(34, 9);
  });

  test('an edit is carried by its own version\'s transform', () => {
    // It is held before that transform, so turning the version it lives in
    // carries it round rather than leaving it behind on screen.
    const { world, ids } = drawn(['level', rect(0, 0, 100, 100)]);
    const nudged = drag(world, 1, ids[0], 0, { x: 20, y: 0 });

    const was = only(nudged, 1, ids[0]).source[0];
    const spun = transformed(nudged, 1, ids[0], { rotation: Math.PI / 2 });

    // A quarter turn about the origin sends (x, y) to (-y, x).
    expect(only(spun, 1, ids[0]).source[0].x).toBeCloseTo(-was.y, 9);
    expect(only(spun, 1, ids[0]).source[0].y).toBeCloseTo(was.x, 9);
  });

  test('an upstream turn carries an edit round with the rest of the ring', () => {
    // The bug this is here for: the displacement used to be written against the
    // world geometry the base handed over, so it kept its screen direction
    // while the polygon turned underneath it. A corner nudged at v3 walked out
    // of the ring the moment v0 was rotated, and the polygon was a different
    // shape at every upstream angle.
    const { world, ids } = drawn(['level', rect(0, 0, 100, 100)]);
    const nudged = drag(world, 3, ids[0], 0, { x: -30, y: 40 });

    const before = only(nudged, 3, ids[0]).source;
    const spun = transformed(nudged, 0, ids[0], { rotation: Math.PI / 2 });
    const after = only(spun, 3, ids[0]).source;

    // A quarter turn about the origin sends (x, y) to (-y, x) — every point of
    // the ring, the nudged one included. The shape is rigid under it.
    before.forEach((p, i) => {
      expect(after[i].x).toBeCloseTo(-p.y, 9);
      expect(after[i].y).toBeCloseTo(p.x, 9);
    });
  });

  test('an upstream squash carries an edit too, and only squashes once', () => {
    // The same property under a transform that is not rigid: a corner nudged at
    // v2 is scaled by v0's squash exactly as its neighbours are.
    const { world, ids } = drawn(['level', rect(0, 0, 100, 100)]);
    const nudged = drag(world, 2, ids[0], 0, { x: -30, y: 40 });

    const before = only(nudged, 2, ids[0]).source;
    const squashed = transformed(nudged, 0, ids[0], { scale: { x: 3, y: 0.5 } });
    const after = only(squashed, 2, ids[0]).source;

    before.forEach((p, i) => {
      expect(after[i].x).toBeCloseTo(p.x * 3, 9);
      expect(after[i].y).toBeCloseTo(p.y * 0.5, 9);
    });
  });

  test('a drag lands on the cursor whatever the chain above it is doing', () => {
    // Which is what makes the frame change safe: the displacement is written
    // through the inverse of the whole composed chain, so the corner is under
    // the cursor at the version being edited however turned or squashed the
    // versions above it have left the polygon.
    const { world, ids } = drawn(['level', rect(0, 0, 100, 100)]);

    const chained = transformed(
      transformed(world, 0, ids[0], { rotation: 0.7, scale: { x: 2.5, y: 0.4 } }),
      1,
      ids[0],
      { rotation: -1.2, translation: { x: 60, y: 15 }, erosion: 6 },
    );

    const after = drag(chained, 3, ids[0], 2, { x: 123, y: -45 });

    expect(only(after, 3, ids[0]).source[2].x).toBeCloseTo(123, 9);
    expect(only(after, 3, ids[0]).source[2].y).toBeCloseTo(-45, 9);
  });

  test('the handles are on the source, whatever the erosion is doing', () => {
    // There is nothing to invert: the depth never touched the source, so the
    // drag is the same operation at every depth and lands exactly.
    const { world, ids } = drawn(['level', rect(0, 0, 100, 100)]);
    const eroded = transformed(world, 0, ids[0], { erosion: 20 });
    const after = drag(eroded, 0, ids[0], 0, { x: -50, y: -50 });

    expect(only(after, 0, ids[0]).source[0]).toEqual({ x: -50, y: -50 });
  });
});

describe('corners added and taken away', () => {
  const ring = (world: World, v: VersionId, id: PolygonId) =>
    only(world, v, id).source.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) }));

  function drag(world: World, v: VersionId, id: PolygonId, index: number, to: Point): World {
    const it = only(world, v, id);

    return withEdit(world, v, id, placeVertex(it, editAt(world, v, id, it.erosion), index, to));
  }

  test('a click on an edge puts a corner exactly where it was clicked', () => {
    const { world, ids } = drawn(['level', rect(0, 0, 100, 100)]);
    const it = only(world, 0, ids[0]);
    const hit = hitEdge([it], { x: 40, y: 3 }, 9)!;

    expect(hit.id).toEqual(ids[0]);
    expect(hit.at).toEqual({ x: 40, y: 0 });

    const after = addVertex(world, 0, it, hit.index, hit.at);

    expect(ring(after.world, 0, ids[0])).toEqual([
      { x: 0, y: 0 }, { x: 40, y: 0 }, { x: 100, y: 0 },
      { x: 100, y: 100 }, { x: 0, y: 100 },
    ]);
  });

  test('a corner goes in between the two it was clicked between, not at the end', () => {
    // The ring is ordered and winding matters, so an insert that appends would
    // put a spike through the polygon rather than a corner on its edge.
    const { world, ids } = drawn(['level', rect(0, 0, 100, 100)]);
    const it = only(world, 0, ids[0]);
    const hit = hitEdge([it], { x: 103, y: 60 }, 9)!;
    const after = addVertex(world, 0, it, hit.index, hit.at);

    expect(shapeArea(only(after.world, 0, ids[0]).shape)).toBeCloseTo(10000, 6);
  });

  test('adding one where an upstream layer bent the edge still lands on the cursor', () => {
    // The resting place is the fraction along the edge as the polygon was
    // drawn, which is off the line once a layer has moved one of its ends. This
    // version's own displacement is what makes up the difference.
    const { world, ids } = drawn(['level', rect(0, 0, 100, 100)]);
    const bent = drag(world, 0, ids[0], 1, { x: 160, y: -40 });
    const at = { x: 70, y: 12 };

    const after = addVertex(bent, 1, only(bent, 1, ids[0]), 0, at);
    const now = only(after.world, 1, ids[0]);
    const where = now.corners.findIndex(c => c.id === after.vertex);

    expect(now.source[where].x).toBeCloseTo(at.x, 9);
    expect(now.source[where].y).toBeCloseTo(at.y, 9);
  });

  test('a corner added at one version is not there at the versions before it', () => {
    // The rule the whole design rests on: nothing a layer does reaches back
    // past itself. A corner is not an exception to it.
    const { world, ids } = drawn(['level', rect(0, 0, 100, 100)]);
    const after = addVertex(world, 2, only(world, 2, ids[0]), 0, { x: 50, y: 0 }).world;

    expect(only(after, 0, ids[0]).corners.length).toEqual(4);
    expect(only(after, 1, ids[0]).corners.length).toEqual(4);
    expect(only(after, 2, ids[0]).corners.length).toEqual(5);
    expect(only(after, 3, ids[0]).corners.length).toEqual(5);
  });

  test('a corner taken out at one version is still there at the versions before it', () => {
    const { world, ids } = drawn(['level', rect(0, 0, 100, 100)]);
    const going = world.polygons.get(ids[0])!.points[2].id;
    const after = removeVertices(world, 2, [going]);

    expect(ring(after, 1, ids[0])).toEqual([
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
    ]);
    expect(ring(after, 2, ids[0])).toEqual([
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 },
    ]);
  });

  test('a corner keeps the displacements written against it where it still stands', () => {
    // Dropping them on the way out would quietly edit the past: the layer that
    // moved the corner still moved it, at the versions that still have it.
    const { world, ids } = drawn(['level', rect(0, 0, 100, 100)]);
    const nudged = drag(world, 1, ids[0], 2, { x: 130, y: 130 });
    const going = nudged.polygons.get(ids[0])!.points[2].id;
    const after = removeVertices(nudged, 2, [going]);

    expect(ring(after, 1, ids[0])[2]).toEqual({ x: 130, y: 130 });
    expect(ring(after, 2, ids[0]).length).toEqual(3);
  });

  test('a corner added and taken out at the same version leaves no trace', () => {
    const { world, ids } = drawn(['level', rect(0, 0, 100, 100)]);
    const added = addVertex(world, 1, only(world, 1, ids[0]), 0, { x: 50, y: 0 });
    const after = removeVertices(added.world, 1, [added.vertex]);

    expect(after.polygons.get(ids[0])!.points.length).toEqual(4);
  });

  test('the last three corners stay: below that there is no ring to talk about', () => {
    const { world, ids } = drawn(['level', [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }]]);
    const all = world.polygons.get(ids[0])!.points.map(p => p.id);

    expect(removeVertices(world, 0, [all[0]])).toBe(world);
  });

  test('a corner beats the edges it lies on', () => {
    // Every corner is on two edges, so a click on one would otherwise insert a
    // corner a hair away from the one being reached for.
    const { world, ids } = drawn(['level', rect(0, 0, 100, 100)]);
    const items = resolveAt(world, 0);

    expect(hitVertex(items, { x: 2, y: 2 }, 9)).not.toEqual(null);
  });
});

describe('copy and paste', () => {
  test('what comes back looks exactly like what was taken, offset', () => {
    const { world, ids } = drawn(['solid', rect(0, 0, 100, 100)]);
    const eroded = transformed(world, 0, ids[0], { erosion: 12 });

    const clips = copied(resolveAt(eroded, 0), [ids[0]]);
    const after = pasted(eroded, 0, clips, { x: 32, y: 32 });
    const copy = only(after.world, 0, after.ids[0]);

    expect(copy.polygon.type).toEqual('solid');
    expect(copy.erosion).toEqual(12);
    expect(shapeArea(copy.shape))
      .toBeCloseTo(shapeArea(only(eroded, 0, ids[0]).shape), 6);
    expect(copy.source[0]).toEqual({ x: 32, y: 32 });
  });

  test('a paste survives the original being deleted', () => {
    // A clipping is geometry, not a reference: it has to outlive what it came
    // from, since that is most of what a clipboard is for.
    const { world, ids } = drawn(['level', rect(0, 0, 100, 100)]);
    const clips = copied(resolveAt(world, 0), [ids[0]]);

    const polygons = new Map(world.polygons);
    polygons.delete(ids[0]);

    const after = pasted({ ...world, polygons }, 0, clips, { x: 0, y: 0 });

    expect(shapeArea(only(after.world, 0, after.ids[0]).shape)).toBeCloseTo(10000, 6);
  });
});

describe('clicking through a stack of polygons', () => {
  test('what is under the cursor comes back topmost first', () => {
    // Later polygons draw over earlier ones, so that is the order a click has
    // to walk: the top one first, and down from there.
    const { world, ids } = drawn(
      ['level', rect(0, 0, 100, 100)],
      ['level', rect(50, 50, 100, 100)],
      ['level', rect(60, 60, 10, 10)],
    );
    const items = resolveAt(world, 0);

    expect(hitPolygons(items, { x: 65, y: 65 })).toEqual([ids[2], ids[1], ids[0]]);
    expect(hitPolygons(items, { x: 120, y: 120 })).toEqual([ids[1]]);
    expect(hitPolygons(items, { x: 10, y: 10 })).toEqual([ids[0]]);
    expect(hitPolygons(items, { x: 400, y: 400 })).toEqual([]);
  });

  test('a hole is not something to click through to', () => {
    // `contains` is the nonzero fill of the projection, so what a click finds
    // is what is actually drawn there rather than what a bounding box suggests.
    const { world, ids } = drawn(['level', rect(0, 0, 100, 100)], ['solid', rect(20, 20, 60, 60)]);
    const items = resolveAt(world, 0);

    expect(hitPolygons(items, { x: 10, y: 10 })).toEqual([ids[0]]);
    expect(hitPolygons(items, { x: 50, y: 50 })).toEqual([ids[1], ids[0]]);
  });
});

// -----------------------------------------------------------------------------
// Groups
// -----------------------------------------------------------------------------

/** Two rooms side by side, and the group over both. */
function pair(): { world: World, ids: PolygonId[], group: GroupId } {
  const { world, ids } = drawn(
    ['level', rect(0, 0, 10, 10)],
    ['level', rect(20, 0, 10, 10)],
  );

  const made = grouped(world, 0, ids)!;

  return { world: made.world, ids, group: made.id };
}

/** Where a polygon's corners actually are at a version. */
function at(world: World, v: VersionId, id: PolygonId): Point[] {
  return only(world, v, id).source;
}

function moved(world: World, v: VersionId, id: Id, t: Partial<Transform>): World {
  const edit = editAt(world, v, id, 0);

  return withEdit(world, v, id, { ...edit, transform: { ...edit.transform, ...t } });
}

describe('a group moves what is in it', () => {
  test('a member takes its group\'s transform on top of its own', () => {
    const { world, ids, group } = pair();

    const shifted = moved(world, 0, group, { translation: { x: 100, y: 0 } });

    expect(at(shifted, 0, ids[0])[0]).toEqual({ x: 100, y: 0 });
    expect(at(shifted, 0, ids[1])[0]).toEqual({ x: 120, y: 0 });

    // And on top of the member's own, which is applied first.
    const both = moved(shifted, 0, ids[0], { translation: { x: 0, y: 5 } });

    expect(at(both, 0, ids[0])[0]).toEqual({ x: 100, y: 5 });
  });

  test('the group turns the whole of it about the world origin', () => {
    const { world, ids, group } = pair();
    const turned = moved(world, 0, group, { rotation: Math.PI / 2 });

    // The far room swings round with the near one rather than turning in
    // place: a group is a frame its members sit in.
    const p = at(turned, 0, ids[1])[0];

    expect(p.x).toBeCloseTo(0, 9);
    expect(p.y).toBeCloseTo(20, 9);
  });

  test('a group inside a group composes outwards', () => {
    const { world, ids, group } = pair();
    const { world: outer, ids: more } = (() => {
      const added = addPolygon(world, 'level', rect(40, 0, 10, 10), 0);

      return { world: added.world, ids: [added.id] };
    })();

    const top = grouped(outer, 0, [group, more[0]])!;

    const w = moved(
      moved(top.world, 0, group, { translation: { x: 1, y: 0 } }),
      0,
      top.id,
      { translation: { x: 0, y: 2 } },
    );

    // Inner then outer, for a member of both; outer only, for the newcomer.
    expect(at(w, 0, ids[0])[0]).toEqual({ x: 1, y: 2 });
    expect(at(w, 0, more[0])[0]).toEqual({ x: 40, y: 2 });
  });

  test('a group made at one version holds its members at every version', () => {
    // Structure is global; the transform is versioned. A group made while
    // standing at v2 is a fact about the world, so it can be moved at v0 like
    // anything else — and until it is moved, it changes nothing anywhere.
    const { world, ids } = drawn(
      ['level', rect(0, 0, 10, 10)],
      ['level', rect(20, 0, 10, 10)],
    );

    const made = grouped(world, 2, ids)!;

    for (let v = 0; v < 4; v++) {
      expect(at(made.world, v as VersionId, ids[0])[0]).toEqual({ x: 0, y: 0 });
    }

    const w = moved(made.world, 0, made.id, { translation: { x: 100, y: 0 } });

    // And moving it at v0 carries down the chain, the way every edit does.
    expect(at(w, 0, ids[0])[0]).toEqual({ x: 100, y: 0 });
    expect(at(w, 1, ids[1])[0]).toEqual({ x: 120, y: 0 });
  });

  test('the version chain still runs one stage at a time under a group', () => {
    const { world, ids, group } = pair();

    const w = moved(
      moved(world, 0, group, { translation: { x: 10, y: 0 } }),
      1,
      group,
      { rotation: Math.PI / 2, translation: { x: 0, y: 0 } },
    );

    // v1 turns what v0 left, rather than turning the drawing and then moving.
    const p = at(w, 1, ids[0])[0];

    expect(p.x).toBeCloseTo(0, 9);
    expect(p.y).toBeCloseTo(10, 9);
  });
});

describe('making and taking apart', () => {
  test('a group of fewer than two things is not a group', () => {
    const { world, ids } = pair();

    expect(grouped(world, 0, [ids[0]])).toEqual(null);

    // Nor is grouping something with what already holds it.
    expect(grouped(world, 0, ids)).toEqual(null);
  });

  test('members leave exactly where they stood, at every version', () => {
    const { world, ids, group } = pair();

    const w = moved(
      moved(world, 0, group, { translation: { x: 10, y: 4 }, rotation: 0.3 }),
      2,
      group,
      { translation: { x: -5, y: 0 }, scale: { x: 2, y: 2 } },
    );

    const apart = ungrouped(w, group)!;

    expect(apart.groups.size).toEqual(0);

    for (let v = 0; v < 4; v++) {
      for (const id of ids) {
        const before = at(w, v as VersionId, id);
        const after = at(apart, v as VersionId, id);

        after.forEach((p, i) => {
          expect(p.x).toBeCloseTo(before[i].x, 9);
          expect(p.y).toBeCloseTo(before[i].y, 9);
        });
      }
    }
  });

  test('what a version cannot hold is refused whole', () => {
    // Turn, squash, turn again is a shear, and no combination of a turn and
    // two scales says shear.
    const { world, ids, group } = pair();

    const w = moved(
      moved(world, 0, ids[0], { rotation: 0.4 }),
      0,
      group,
      { scale: { x: 2, y: 1 } },
    );

    expect(composed(
      { ...EMPTY_TRANSFORM, scale: { x: 2, y: 1 } },
      { ...EMPTY_TRANSFORM, rotation: 0.4 },
    )).toEqual(null);

    // A squash outside a turn is the shear. Either on its own composes, and so
    // does a turn outside anything at all.
    expect(composed(
      { ...EMPTY_TRANSFORM, rotation: 0.7 },
      { ...EMPTY_TRANSFORM, rotation: 0.4, scale: { x: 2, y: 1 } },
    )).not.toEqual(null);

    expect(ungrouped(w, group)).toEqual(null);

    // And the world it refused is the world that stands.
    expect(w.groups.has(group)).toEqual(true);
  });

  test('a depth is nobody else\'s', () => {
    // Leaving a group does not take its erosion, and does not lose your own.
    const both = composed(
      { ...EMPTY_TRANSFORM, erosion: 5 },
      { ...EMPTY_TRANSFORM, erosion: 2 },
    );

    expect(both!.erosion).toEqual(2);
  });

  test('a group nested inside another takes its place in the holder', () => {
    const { world, ids, group } = pair();
    const added = addPolygon(world, 'level', rect(40, 0, 10, 10), 0);
    const top = grouped(added.world, 0, [group, added.id])!;

    const apart = ungrouped(top.world, group)!;

    expect(apart.groups.get(top.id)!.members).toEqual([...ids, added.id]);
  });
});

describe('what a selection reaches', () => {
  test('a group stands for the polygons under it', () => {
    const { world, ids, group } = pair();

    expect(polygonsIn(world, [group]).sort()).toEqual([...ids].sort());
    expect(polygonsIn(world, [ids[0]])).toEqual([ids[0]]);
  });

  test('taking a member out leaves no group of one', () => {
    const { world, ids, group } = pair();
    const w = without(world, new Set([ids[0]]));

    expect(w.groups.has(group)).toEqual(false);
  });
});

// -----------------------------------------------------------------------------
// Eroding a group
// -----------------------------------------------------------------------------

describe('a group erodes as one shape', () => {
  /** Two rectangles overlapping end to end: a corridor with a join in the
   * middle of it. */
  function corridor(): { world: World, ids: PolygonId[], group: GroupId } {
    const { world, ids } = drawn(
      ['level', rect(0, 0, 100, 40)],
      ['level', rect(80, 0, 100, 40)],
    );

    const made = grouped(world, 0, ids)!;

    return { world: made.world, ids, group: made.id };
  }

  test('the union pulls back at its outer boundary, not at the seam', () => {
    const { world, group } = corridor();
    const d = 15;
    const w = moved(world, 0, group, { erosion: d });

    // 180 x 40 eroded by 15 is 150 x 10, in one piece.
    const shape = csg(w, 0);

    expect(shapeArea(shape)).toBeCloseTo(150 * 10, 6);
    expect(shape.length).toEqual(1);
  });

  test('which is not what eroding each of them gives', () => {
    // The overlap is 20 and the depth is 15, so each member pulls back 15 from
    // its own end of it and the corridor breaks: two rooms where the author
    // drew one. That is the case the union exists for.
    const { world, ids } = corridor();

    let w = world;

    for (const id of ids) w = moved(w, 0, id, { erosion: 15 });

    const apart = csg(w, 0);

    expect(apart.length).toBeGreaterThan(1);
    expect(shapeArea(apart)).toBeLessThan(150 * 10);
  });

  test('a group at depth zero hands its members over one by one', () => {
    // Not a special case for speed: the union of a set is what the CSG does
    // with them anyway. It is what keeps an edit inside a plain group as cheap
    // as an edit outside one.
    const { world, ids, group } = corridor();

    expect(contributing(world, 0, resolveAt(world, 0)).map(c => c.id).sort())
      .toEqual([...ids].sort());

    expect(contributing(
      moved(world, 0, group, { erosion: 5 }),
      0,
      resolveAt(world, 0),
    ).map(c => c.id)).toEqual([group]);
  });

  test('the two kinds are unioned apart', () => {
    // A room and a pillar is one group, but the room's boundary and the
    // pillar's are not one boundary, and there is no shape that is the union
    // of a thing and a hole in it.
    const { world, ids } = drawn(
      ['level', rect(0, 0, 100, 100)],
      ['solid', rect(40, 40, 20, 20)],
    );

    const made = grouped(world, 0, ids)!;
    const w = moved(made.world, 0, made.id, { erosion: 5 });
    const out = contributing(w, 0, resolveAt(w, 0));

    expect(out.map(c => c.kind).sort()).toEqual(['level', 'solid']);

    // Each union pulls back by the depth in its own sense, which is what the
    // same depth on each of them separately would have done — the group only
    // changes what the offset is taken on.
    expect(shapeArea(out.find(c => c.kind === 'level')!.shape)).toBeCloseTo(90 * 90, 6);
    expect(shapeArea(out.find(c => c.kind === 'solid')!.shape)).toBeCloseTo(10 * 10, 6);
  });

  test('a group holding both kinds contributes to both sides of the set', () => {
    // One id names one contributor, and these are two boundaries: the level
    // union and the solid union take different tracks and are told apart
    // everywhere downstream by nothing but the number. The solid side gets one
    // of its own.
    const { world, ids } = drawn(
      ['level', rect(0, 0, 200, 120)],
      ['solid', rect(60, 40, 60, 40)],
    );

    const made = grouped(world, 0, ids)!;
    const d = 10;
    const w = moved(made.world, 0, made.id, { erosion: d });

    const out = contributing(w, 0, resolveAt(w, 0));

    expect(out.map(c => c.id)).toEqual([made.id, solidSide(made.id)]);
    expect(sidedWith(solidSide(made.id))).toEqual(made.id);

    // And the set is what those two say it is: the room pulled in by the depth
    // with the pillar, also pulled in, taken back out of it.
    expect(shapeArea(csg(w, 0)))
      .toBeCloseTo((200 - 2 * d) * (120 - 2 * d) - (60 - 2 * d) * (40 - 2 * d), 6);
  });

  test('a group nothing in hand belongs to is not answered for', () => {
    // The fold walks up from what it was given, never down from the top. Down
    // would reach a standing group by way of a transparent one holding it, with
    // none of that group's members in hand, and answer out of nothing.
    const { world, ids } = drawn(
      ['level', rect(0, 0, 100, 100)],
      ['level', rect(80, 0, 100, 100)],
      ['level', rect(400, 0, 100, 100)],
    );

    const inner = grouped(world, 0, [ids[0], ids[1]])!;
    const outer = grouped(inner.world, 0, [inner.id, ids[2]])!;
    const w = moved(outer.world, 0, inner.id, { erosion: 12 });

    // Handed only the far room, which is inside the transparent outer group and
    // nowhere near the eroding inner one.
    const far = resolveAt(w, 0).filter(it => it.id === ids[2]);

    expect(contributing(w, 0, far).map(c => c.id)).toEqual([ids[2]]);
  });

  test('a group inside an eroding group is projected first', () => {
    const { world, group: inner } = corridor();
    const third = addPolygon(world, 'level', rect(300, 0, 40, 40), 0);
    const outer = grouped(third.world, 0, [inner, third.id])!;

    const w = moved(moved(outer.world, 0, inner, { erosion: 15 }), 0, outer.id, { erosion: 2 });
    const out = contributing(w, 0, resolveAt(w, 0));

    // One contributor, and the inner group's own offset is inside the outer
    // one's rather than replaced by it.
    expect(out.map(c => c.id)).toEqual([outer.id]);
    expect(shapeArea(out[0].shape)).toBeCloseTo(146 * 6 + 36 * 36, 6);
  });
});

describe('going inside a group', () => {
  test('a shut group draws one outline and its members draw none', () => {
    const { world, ids, group } = pair();
    const items = resolveAt(world, 0);

    const shut = showing(world, 0, items, []);

    expect(shut.map(c => c.id)).toEqual([group]);
    expect(ids.every(id => swallowed(world, id, []))).toBe(true);

    // And with the group open, the members are back and it has no outline.
    const open = showing(world, 0, items, [group]);

    expect(open.map(c => c.id).sort()).toEqual([...ids].sort());
    expect(ids.some(id => swallowed(world, id, [group]))).toBe(false);
  });

  test('a group draws as one shape even at depth zero', () => {
    // The CSG only cares about groups that erode. Drawing cares about every
    // group, because a group is one thing to the hand whatever its depth.
    const { world, group } = pair();

    expect(contributing(world, 0, resolveAt(world, 0)).map(c => c.id)).toHaveLength(2);
    expect(showing(world, 0, resolveAt(world, 0), []).map(c => c.id)).toEqual([group]);
  });

  test('opening one level leaves the one inside it shut', () => {
    const { world, ids } = drawn(
      ['level', rect(0, 0, 10, 10)],
      ['level', rect(20, 0, 10, 10)],
      ['level', rect(40, 0, 10, 10)],
    );

    const inner = grouped(world, 0, [ids[0], ids[1]])!;
    const outer = grouped(inner.world, 0, [inner.id, ids[2]])!;
    const w = outer.world;

    // Shut: a click anywhere reaches the outer group.
    expect(reaching(w, ids[0], [])).toEqual(outer.id);

    // Inside it: the inner group and the loose room, which is one level down.
    const path = opened(w, outer.id);

    expect(path).toEqual([outer.id]);
    expect(reaching(w, ids[0], path)).toEqual(inner.id);
    expect(reaching(w, ids[2], path)).toEqual(ids[2]);

    // And inside that: the rooms themselves.
    expect(opened(w, inner.id)).toEqual([outer.id, inner.id]);
    expect(reaching(w, ids[0], opened(w, inner.id))).toEqual(ids[0]);
  });

  test('nothing outside the open group can be reached', () => {
    const { world, ids } = drawn(
      ['level', rect(0, 0, 10, 10)],
      ['level', rect(20, 0, 10, 10)],
      ['level', rect(40, 0, 10, 10)],
    );

    const made = grouped(world, 0, [ids[0], ids[1]])!;
    const w = made.world;

    expect(ids.map(id => reachable(w, id, null))).toEqual([true, true, true]);
    expect(ids.map(id => reachable(w, id, made.id))).toEqual([true, true, false]);
  });

  test('a path to a group that has been taken apart is no path at all', () => {
    // Being let out by an edit is the right failure: there is no longer a
    // group to be in, and a route to one would be a route to nowhere.
    const { world, ids, group } = pair();

    expect(opened(world, group)).toEqual([group]);
    expect(opened(ungrouped(world, group)!, group)).toEqual([]);

    // And it holds nothing in, rather than shutting everything out.
    expect(reachable(ungrouped(world, group)!, ids[0], group)).toBe(true);
  });

  test('a group takes its own walls out of its own rooms', () => {
    // The pillar's outline is exactly the internal geometry grouping is meant
    // to stop showing, so what is drawn is one boundary with the hole in it.
    const { world, ids } = drawn(
      ['level', rect(0, 0, 100, 100)],
      ['solid', rect(40, 40, 20, 20)],
    );

    const made = grouped(world, 0, ids)!;
    const out = occupying(made.world, 0, resolveAt(made.world, 0), []);

    expect(out).toHaveLength(1);
    expect(out[0].id).toEqual(made.id);
    expect(out[0].kind).toEqual('level');

    // Two rings — the room and the hole — and no third outline anywhere.
    expect(out[0].shape).toHaveLength(2);
    expect(shapeArea(out[0].shape)).toBeCloseTo(100 * 100 - 20 * 20, 6);
  });

  test('a group of nothing but walls is drawn as the walls', () => {
    // There is no level side to take them out of, and a group has to be
    // visible: it is the thing being picked and dragged.
    const { world, ids } = drawn(
      ['solid', rect(0, 0, 20, 20)],
      ['solid', rect(40, 0, 20, 20)],
    );

    const made = grouped(world, 0, ids)!;
    const out = occupying(made.world, 0, resolveAt(made.world, 0), []);

    expect(out).toHaveLength(1);
    expect(out[0].kind).toEqual('solid');
    expect(shapeArea(out[0].shape)).toBeCloseTo(2 * 20 * 20, 6);
  });

  test('an open group occupies nothing: its members draw for themselves', () => {
    const { world, ids } = drawn(
      ['level', rect(0, 0, 100, 100)],
      ['solid', rect(40, 40, 20, 20)],
    );

    const made = grouped(world, 0, ids)!;

    expect(occupying(made.world, 0, resolveAt(made.world, 0), [made.id])).toEqual([]);
  });

  test('the two sides stay apart for the CSG, which needs them apart', () => {
    const { world, ids } = drawn(
      ['level', rect(0, 0, 100, 100)],
      ['solid', rect(40, 40, 20, 20)],
    );

    const made = grouped(world, 0, ids)!;
    const shown = showing(made.world, 0, resolveAt(made.world, 0), []);

    // Two contributors under one group: there is no shape that is the union of
    // a room and the pillar standing in it.
    expect(shown.map(c => c.kind).sort()).toEqual(['level', 'solid']);
    expect(shown.map(c => sidedWith(c.id) ?? c.id)).toEqual([made.id, made.id]);
  });
});
