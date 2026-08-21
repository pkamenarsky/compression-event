import { describe, expect, test } from 'vitest';
import { Point } from '@ce/game/world';
import { OpSubtract, Shape, combine, shapeArea, simplify } from './geometry';
import {
  Resolved,
  addPolygon,
  addVertex,
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
  PolygonId,
  PolygonType,
  Transform,
  VersionId,
  World,
  emptyWorld,
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
      expect(runLength(csg(items))).toBeCloseTo(outlineOf(items), 6);
      expect(shapeArea(simplify(items.flatMap(i => i.shape)))).toBeCloseTo(175, 6);
    }
  });

  test('a solid subtracts whichever way round it was drawn', () => {
    for (const [a, b] of everyWinding(rect(0, 0, 10, 10), rect(5, 5, 10, 10))) {
      const { world } = drawn(['level', a], ['solid', b]);

      expect(shapeArea(csg(resolveAt(world, 0)))).toBeCloseTo(75, 6);
    }
  });

  test('two triangles wound against each other still merge', () => {
    // Drawn in the editor, one clicked round the other way. Before the winding
    // was normalised this came out as two rings — the overlap cancelling to a
    // hole — and the wall between them stayed on screen.
    const a = [{ x: -320, y: -128 }, { x: 96, y: -128 }, { x: -128, y: 192 }];
    const b = [{ x: 96, y: 224 }, { x: 288, y: -64 }, { x: -128, y: -64 }];

    const only = (r: Point[]) => resolveAt(drawn(['level', r]).world, 0);
    const both = resolveAt(drawn(['level', a], ['level', b]).world, 0);

    const apart = shapeArea(simplify(only(a).flatMap(i => i.shape)))
      + shapeArea(simplify(only(b).flatMap(i => i.shape)));

    expect(apart).toBeCloseTo(126464, 6);

    // The outline is the union's, with nothing left over: the hole the
    // cancellation used to punch would carry its own runs.
    expect(runLength(csg(both))).toBeCloseTo(outlineOf(both), 6);

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

    expect(shapeArea(csg(resolveAt(gone, 0)))).toBeCloseTo(0, 6);
  });

  test('an eroded strip takes its ground with it', () => {
    const { world, ids } = drawn(['level', rect(0, 0, 40, 40)], ['level', rect(5, 15, 30, 10)]);
    const eroded = transformed(world, 0, ids[1], { erosion: 8 });

    // The strip is inside the room, so it never added anything; eroding it flat
    // must not add any either.
    expect(shapeArea(csg(resolveAt(eroded, 0)))).toBeCloseTo(1600, 6);
  });

  test('a transform moves what the set is computed from', () => {
    const { world, ids } = drawn(['level', rect(0, 0, 10, 10)], ['level', rect(0, 0, 10, 10)]);
    const moved = transformed(world, 0, ids[1], { translation: { x: 100, y: 0 } });

    const shape = csg(resolveAt(moved, 0));

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

    expect(shapeArea(csg(resolveAt(squashed, 0)))).toBeCloseTo(36 * 6, 6);
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
      expect(shapeArea(csg(resolveAt(eroded, v)))).toBeCloseTo(6400, 6);
    }

    expect(shapeArea(csg(resolveAt(eroded, 0)))).toBeCloseTo(10000, 6);
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
    expect(shapeArea(csg(resolveAt(moved, 4)))).toBeCloseTo(60 * 60, 6);
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

    expect(shapeArea(csg(resolveAt(b, 2)))).toBeCloseTo(60 * 60, 6);

    // And the source is untouched by either of them, at every version.
    for (const v of [0, 1, 2, 3, 4]) {
      expect(only(b, v, ids[0]).source).toEqual(rect(0, 0, 100, 100));
    }
  });

  test('scrubbing a depth back brings the shape back', () => {
    const { world, ids } = drawn(['level', rect(0, 0, 100, 100)]);
    const gone = transformed(world, 2, ids[0], { erosion: 80 });

    expect(shapeArea(csg(resolveAt(gone, 2)))).toBeCloseTo(0, 6);

    const back = transformed(gone, 2, ids[0], { erosion: 0 });

    expect(shapeArea(csg(resolveAt(back, 2)))).toBeCloseTo(10000, 6);
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
    const where = now.polygon.points.findIndex(c => c.id === after.vertex);

    expect(now.source[where].x).toBeCloseTo(at.x, 9);
    expect(now.source[where].y).toBeCloseTo(at.y, 9);

    // And the version before it keeps the straight edge it had.
    const before = only(after.world, 0, ids[0]);
    expect(before.source.length).toEqual(5);
  });

  test('a corner comes out of every version at once, with its displacements', () => {
    const { world, ids } = drawn(['level', rect(0, 0, 100, 100)]);
    const nudged = drag(world, 1, ids[0], 2, { x: 130, y: 130 });
    const going = nudged.polygons.get(ids[0])!.points[2].id;
    const after = removeVertices(nudged, [going]);

    expect(ring(after, 0, ids[0])).toEqual([
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 },
    ]);
    expect(ring(after, 1, ids[0]).length).toEqual(3);
    expect(after.versions[1].edits.get(ids[0])?.vertices.has(going)).toEqual(false);
  });

  test('the last three corners stay: below that there is no ring to talk about', () => {
    const { world, ids } = drawn(['level', [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }]]);
    const all = world.polygons.get(ids[0])!.points.map(p => p.id);

    expect(removeVertices(world, [all[0]])).toBe(world);
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
