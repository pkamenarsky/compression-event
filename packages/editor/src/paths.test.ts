import { describe, expect, test } from 'vitest';
import {
  PACE,
  addPath,
  hitPath,
  hitPathEdge,
  hitPathPoint,
  inFrame,
  pathsWithinBox,
  seconds,
  setPath,
  timings,
} from './paths';
import {
  TOP,
  addPolygon,
  editAt,
  grouped,
  landing,
  pathAt,
  pathsAt,
  pathsIn,
  removeAt,
  starting,
  withEdit,
} from './scene';
import { EMPTY_TRANSFORM, PathId, Point, VersionId, World, emptyWorld, PolygonKind } from './types';

/**
 * A polygon kind by the short name these tests call it: a room, a pillar, a
 * floor, and a hole cut in a floor.
 *
 * The four are two questions — which set, and which way — and writing the pair
 * out at every call would bury what each test is about. See `PolygonKind`.
 */
type Named = 'level' | 'solid' | 'floor' | 'hole';

const kind = (k: Named): PolygonKind => ({
  type: k === 'floor' || k === 'hole' ? 'floor' : 'level',
  op: k === 'solid' || k === 'hole' ? 'subtract' : 'add',
});

describe('timings', () => {
  test('start at zero and add up along the legs', () => {
    const t = timings([{ x: 0, y: 0 }, { x: PACE, y: 0 }, { x: PACE, y: PACE * 2 }]);

    expect(t[0]).toBe(0);
    expect(t[1]).toBeCloseTo(1);
    expect(t[2]).toBeCloseTo(3);
  });

  test('one point takes no time, and no points is no answer', () => {
    expect(timings([{ x: 5, y: 5 }])).toEqual([0]);
    expect(timings([])).toEqual([]);
  });

  test('are written to a tenth', () => {
    expect(seconds(1.234)).toBe('1.2s');
  });
});

/** A path at the root version, out at the top level. */
function laid(points: readonly Point[]): { world: World, id: number } {
  return addPath(emptyWorld(), points, 0, TOP);
}

describe('editing', () => {
  test('a path is added under its own id and read back', () => {
    const { world, id } = laid([{ x: 0, y: 0 }, { x: 10, y: 0 }]);

    expect(world.paths.get(id)!.points).toHaveLength(2);
  });

  test('it is born into the version it was drawn in, and stands from there', () => {
    const { world, id } = addPath(emptyWorld(), [{ x: 0, y: 0 }, { x: 10, y: 0 }], 3, TOP);

    expect(world.paths.get(id)).toMatchObject({ birth: 3, death: null });
    expect(pathAt(world, id, 2)).toBe(null);
    expect(pathAt(world, id, 5)).not.toBe(null);
  });

  test('what is left of a walk that is not one any more is nothing', () => {
    const { world, id } = laid([{ x: 0, y: 0 }, { x: 10, y: 0 }]);

    expect(setPath(world, id, [{ x: 0, y: 0 }]).paths.has(id)).toBe(false);
    expect(setPath(world, id, []).paths.has(id)).toBe(false);
  });

  test('the world it came from is untouched', () => {
    const { world, id } = laid([{ x: 0, y: 0 }, { x: 10, y: 0 }]);

    setPath(world, id, []);

    expect(world.paths.has(id)).toBe(true);
  });

  test('a delete at a version takes it from there on and leaves it before', () => {
    const { world, id } = laid([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
    const gone = removeAt(world, 4, [id]);

    expect(pathAt(gone, id, 3)).not.toBe(null);
    expect(pathAt(gone, id, 4)).toBe(null);
  });
});

describe('the chain', () => {
  test('a version that moves it moves it, and the versions before it do not', () => {
    const { world, id } = laid([{ x: 0, y: 0 }, { x: 10, y: 0 }]);

    const moved = withEdit(world, 2, id, {
      ...editAt(world, 2, id, 0),
      transform: { ...EMPTY_TRANSFORM, translation: { x: 100, y: 0 } },
    });

    expect(pathAt(moved, id, 1)).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
    expect(pathAt(moved, id, 2)).toEqual([{ x: 100, y: 0 }, { x: 110, y: 0 }]);

    // And it flows forward, the way a polygon's does.
    expect(pathAt(moved, id, 5)).toEqual([{ x: 100, y: 0 }, { x: 110, y: 0 }]);
  });

  test('a group carries the path in it', () => {
    const room = addPolygon(
      emptyWorld(),
      kind('level'),
      [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }],
      0,
      TOP,
    );
    const walk = addPath(room.world, [{ x: 0, y: 0 }, { x: 10, y: 0 }], 0, TOP);
    const made = grouped(walk.world, 0, [room.id, walk.id], TOP)!;

    const moved = withEdit(made.world, 1, made.id, {
      ...editAt(made.world, 1, made.id, 0),
      transform: { ...EMPTY_TRANSFORM, translation: { x: 0, y: 40 } },
    });

    expect(pathAt(moved, walk.id, 0)).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
    expect(pathAt(moved, walk.id, 1)).toEqual([{ x: 0, y: 40 }, { x: 10, y: 40 }]);
  });

  test('a path laid inside an open group runs where it was drawn', () => {
    const room = addPolygon(
      emptyWorld(),
      kind('level'),
      [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }],
      0,
      TOP,
    );
    const other = addPolygon(room.world, kind('level'), [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ], 0, TOP);
    const made = grouped(other.world, 0, [room.id, other.id], TOP)!;

    // The group turned and moved, so its own frame is nothing like the world's.
    const turned = withEdit(made.world, 0, made.id, {
      ...editAt(made.world, 0, made.id, 0),
      transform: { ...EMPTY_TRANSFORM, rotation: Math.PI / 2, translation: { x: 7, y: 3 } },
    });

    const where = landing(turned, 0, made.id);
    const walk = addPath(turned, [{ x: 20, y: 20 }, { x: 30, y: 20 }], 0, where);

    const back = pathAt(walk.world, walk.id, 0)!;

    expect(back[0].x).toBeCloseTo(20);
    expect(back[0].y).toBeCloseTo(20);
    expect(back[1].x).toBeCloseTo(30);
    expect(back[1].y).toBeCloseTo(20);
  });

  test('a gesture over a group reaches the paths under it, and starts an edit for one', () => {
    const room = addPolygon(
      emptyWorld(),
      kind('level'),
      [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }],
      0,
      TOP,
    );
    const walk = addPath(room.world, [{ x: 0, y: 0 }, { x: 10, y: 0 }], 0, TOP);
    const made = grouped(walk.world, 0, [room.id, walk.id], TOP)!;

    expect(pathsIn(made.world, [made.id])).toEqual([walk.id]);

    // And a transform gesture can write into a path's own layer: no depth on
    // it, the way an artefact has none.
    const from = starting(made.world, 0, [walk.id]);

    expect(from.get(walk.id)!.transform.erosion).toBe(0);
  });
});


describe('writing a point back', () => {
  /**
   * The frame a point is written in is the one it was read out of, which is
   * the whole chain rather than the frame the path's own transform is read in.
   * Getting that wrong is invisible until something has been transformed, and
   * then every drag lands where the path used to be.
   */
  function roundTrip(world: World, id: PathId, v: VersionId): void {
    const there = pathAt(world, id, v)!;
    const back = inFrame(world, v, id, there);

    expect(pathAt(setPath(world, id, back), id, v)!).toEqual(there);
  }

  test('a point dragged to where it already is does not move', () => {
    const { world, id } = laid([{ x: 0, y: 0 }, { x: 10, y: 0 }]);

    const moved = withEdit(world, 0, id, {
      ...editAt(world, 0, id, 0),
      transform: { ...EMPTY_TRANSFORM, translation: { x: 250, y: -30 } },
    });

    roundTrip(moved, id, 0);

    // And the drag itself: the end put under the cursor at (300, -30) is
    // there afterwards, rather than 250 short of it.
    const points = [...moved.paths.get(id)!.points];

    points[1] = inFrame(moved, 0, id, [{ x: 300, y: -30 }])[0];

    expect(pathAt(setPath(moved, id, points), id, 0)![1]).toEqual({ x: 300, y: -30 });
  });

  test('the same through a turn, and through a group as well as its own layer', () => {
    const room = addPolygon(
      emptyWorld(),
      kind('level'),
      [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }],
      0,
      TOP,
    );
    const walk = addPath(room.world, [{ x: 10, y: 10 }, { x: 40, y: 10 }], 0, TOP);
    const made = grouped(walk.world, 0, [room.id, walk.id], TOP)!;

    const turned = withEdit(made.world, 0, made.id, {
      ...editAt(made.world, 0, made.id, 0),
      transform: { ...EMPTY_TRANSFORM, rotation: 0.7, translation: { x: 5, y: 9 } },
    });

    // A layer of the path's own on top of the group's, which is the pair that
    // `under` alone cannot see.
    const both = withEdit(turned, 1, walk.id, {
      ...editAt(turned, 1, walk.id, 0),
      transform: { ...EMPTY_TRANSFORM, scale: { x: 2, y: 3 }, translation: { x: -4, y: 1 } },
    });

    const points = [...both.paths.get(walk.id)!.points];

    points[0] = inFrame(both, 1, walk.id, [{ x: 123, y: -45 }])[0];

    const there = pathAt(setPath(both, walk.id, points), walk.id, 1)!;

    expect(there[0].x).toBeCloseTo(123, 9);
    expect(there[0].y).toBeCloseTo(-45, 9);
  });
});


describe('hit testing', () => {
  const { world, id } = laid([
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ]);

  const shown = pathsAt(world, 0);

  test('a point is found within reach and not beyond it', () => {
    expect(hitPathPoint(shown, { x: 98, y: 2 }, 5)).toEqual({ id, index: 1 });
    expect(hitPathPoint(shown, { x: 50, y: 50 }, 5)).toBe(null);
  });

  test('a leg is found by its first point, with the place on it', () => {
    const on = hitPathEdge(shown, { x: 40, y: 3 }, 5)!;

    expect(on.index).toBe(0);
    expect(on.at).toEqual({ x: 40, y: 0 });
  });

  test('past the end of a leg is not on it', () => {
    expect(hitPathEdge(shown, { x: -20, y: 0 }, 5)).toBe(null);
  });

  test('a click anywhere along the tape picks the whole walk', () => {
    expect(hitPath(shown, { x: 40, y: 3 }, 5)).toBe(id);
    expect(hitPath(shown, { x: 40, y: 30 }, 5)).toBe(null);
  });

  test('a box takes a path with any point inside it', () => {
    expect(pathsWithinBox(shown, { x: -5, y: -5 }, { x: 5, y: 5 })).toEqual([id]);
    expect(pathsWithinBox(shown, { x: 200, y: 200 }, { x: 300, y: 300 })).toEqual([]);
  });

  test('it hits where the version puts it, not where it was drawn', () => {
    const moved = withEdit(world, 0, id, {
      ...editAt(world, 0, id, 0),
      transform: { ...EMPTY_TRANSFORM, translation: { x: 1000, y: 0 } },
    });

    const there = pathsAt(moved, 0);

    expect(hitPathPoint(there, { x: 98, y: 2 }, 5)).toBe(null);
    expect(hitPathPoint(there, { x: 1098, y: 2 }, 5)).toEqual({ id, index: 1 });
  });
});
