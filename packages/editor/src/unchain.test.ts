import { describe, expect, test } from 'vitest';
import { Point } from '@ce/game/world';
import {
  TOP,
  addArtefact,
  addPolygon,
  addVertex,
  csg,
  depths,
  grouped,
  keyed,
  landing,
  placeAt,
  rechainable,
  rechained,
  removeAt,
  removeVertices,
  resolveAt,
  rigOf,
  unchainable,
  unchained,
  unchainedAt,
  withRig,
} from './scene';
import { cornerRounded, nudged as nudging, repeating, stateAt } from './rig';
import { Writing, erode, move, turned as turning, wrote } from './testing';
import {
  ArtefactId,
  PolygonId,
  FLOOR,
  PolygonKind,
  KeyframeId,
  World,
  emptyWorld,
  initialState,
} from './types';
import { restored, saved } from './save';
import { Frame, bakeSpan, sample } from './bake';

/**
 * A polygon kind by the short name these tests call it: a room, a pillar, a
 * floor, and a hole cut in a floor.
 *
 * Three of them are the kind's own name. `hole` is a void over the floors,
 * which is what a hole in one is. See `PolygonKind`.
 */
type Named = 'level' | 'solid' | 'floor' | 'hole';

const kind = (k: Named): PolygonKind =>
  k === 'hole' ? { type: 'void', from: FLOOR } : { type: k };

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

/** A move, a turn about the origin, and a depth stated outright rather than
 * added, as the operations that say them, at the end of `v`'s list. */
function transformed(
  world: World,
  v: KeyframeId,
  id: number,
  t: { translation?: Point, rotation?: number, erosion?: number },
): World {
  const ops: Writing[] = [];

  if (t.rotation !== undefined) ops.push(turning(t.rotation));
  if (t.translation !== undefined) ops.push(move(t.translation.x, t.translation.y));

  if (t.erosion !== undefined) {
    ops.push((w, k, of) => erode(
      t.erosion! - (resolveAt(w, k).find(r => r.id === of)?.erosion ?? depths(w, k).get(of) ?? 0),
    ));
  }

  return wrote(world, v, id, ...ops);
}

function nudged(world: World, v: KeyframeId, id: number, vertex: number, by: Point): World {
  return withRig(world, id, nudging(rigOf(world, id), vertex, v, by));
}

/** Where a polygon's corners are at a version, as one comparable thing. */
function at(world: World, v: KeyframeId, id: PolygonId): string {
  const it = resolveAt(world, v).find(r => r.id === id);

  if (it === undefined) return 'gone';

  return it.source.map(p => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(' ');
}

/** One square, drawn at v0, with a couple of versions of nothing after it. */
function square(): { world: World, id: PolygonId } {
  const { world, ids } = drawn(['level', rect(0, 0, 100, 100)]);

  return { world, id: ids[0] };
}

describe('unchaining', () => {
  test('changes nothing at the moment it is done', () => {
    const { world, id } = square();

    // Something upstream worth hearing, so that the stand is not a copy of
    // nothing.
    const moved = transformed(world, 1, id, { translation: { x: 25, y: -10 } });
    const before = [0, 1, 2, 3, 4].map(v => at(moved, v, id));

    const loose = unchained(moved, 3, [id]);

    expect([0, 1, 2, 3, 4].map(v => at(loose, v, id))).toEqual(before);
  });

  test('an upstream move stops arriving, from the unchain point on', () => {
    const { world, id } = square();
    const loose = unchained(world, 3, [id]);
    const moved = transformed(loose, 1, id, { translation: { x: 40, y: 0 } });

    // Before the cut it moves, exactly as it always did.
    expect(at(moved, 0, id)).toEqual(at(world, 0, id));
    expect(at(moved, 1, id)).not.toEqual(at(world, 1, id));
    expect(at(moved, 2, id)).not.toEqual(at(world, 2, id));

    // From it on, nothing.
    expect(at(moved, 3, id)).toEqual(at(world, 3, id));
    expect(at(moved, 4, id)).toEqual(at(world, 4, id));
  });

  test('what is written at and after the unchain point still applies', () => {
    const { world, id } = square();
    const loose = unchained(world, 3, [id]);

    const by = { translation: { x: 10, y: 0 } };
    const here = transformed(loose, 3, id, by);
    const later = transformed(here, 5, id, { translation: { x: 0, y: 7 } });

    // The same move written into a world nobody unchained anything in.
    expect(at(later, 3, id)).toEqual(at(transformed(world, 3, id, by), 3, id));
    expect(at(later, 5, id)).not.toEqual(at(later, 4, id));
  });

  test('an upstream nudge stops arriving', () => {
    const { world, id } = square();
    const corner = world.polygons.get(id)!.points[0].id;

    const loose = unchained(world, 2, [id]);
    const bent = nudged(loose, 0, id, corner, { x: 30, y: 30 });

    expect(at(bent, 0, id)).not.toEqual(at(world, 0, id));
    expect(at(bent, 2, id)).toEqual(at(world, 2, id));
  });

  test('an upstream erosion stops arriving, and the depth it was under is kept', () => {
    const { world, id } = square();
    const eroded = transformed(world, 1, id, { erosion: 6 });
    const loose = unchained(eroded, 3, [id]);

    expect(resolveAt(loose, 3).find(r => r.id === id)!.erosion).toBe(6);

    const deeper = transformed(loose, 1, id, { erosion: 20 });

    expect(resolveAt(deeper, 1).find(r => r.id === id)!.erosion).toBe(20);
    expect(resolveAt(deeper, 3).find(r => r.id === id)!.erosion).toBe(6);
  });

  test('so do upstream rounds and deforms, and the amounts they came to are kept', () => {
    const { world, id } = square();
    const corner = world.polygons.get(id)!.points[0].id;
    let shaped = wrote(world, 1, id, { kind: 'round', by: 4 }, { kind: 'deform', by: 2 });

    shaped = withRig(shaped, id, cornerRounded(rigOf(shaped, id), corner, 1, 3));

    const loose = unchained(shaped, 3, [id]);
    const later = wrote(loose, 1, id, { kind: 'round', by: 10 });

    for (const w of [loose, later]) {
      const state = stateAt(w, id, 3);

      expect([state.radius, state.amplitude, state.radii.get(corner)]).toEqual([4, 2, 3]);
    }

    expect(stateAt(later, id, 1).radius).toBe(14);
  });

  test('a corner an upstream version deletes afterwards stays', () => {
    const { world, id } = square();
    const corner = world.polygons.get(id)!.points[0].id;

    const loose = unchained(world, 4, [id]);
    const cut = removeVertices(loose, 1, [corner]);

    expect(resolveAt(cut, 1).find(r => r.id === id)!.corners).toHaveLength(3);
    expect(resolveAt(cut, 4).find(r => r.id === id)!.corners).toHaveLength(4);
  });

  test('a corner an upstream version adds afterwards does not appear', () => {
    const { world, id } = square();
    const loose = unchained(world, 4, [id]);

    const it = resolveAt(loose, 1).find(r => r.id === id)!;
    const grown = addVertex(loose, 1, it, 0, { x: 50, y: 0 }).world;

    expect(resolveAt(grown, 1).find(r => r.id === id)!.corners).toHaveLength(5);
    expect(resolveAt(grown, 4).find(r => r.id === id)!.corners).toHaveLength(4);
  });

  test('a corner added at or after the unchain point does appear', () => {
    const { world, id } = square();
    const loose = unchained(world, 4, [id]);

    const it = resolveAt(loose, 4).find(r => r.id === id)!;
    const grown = addVertex(loose, 4, it, 0, { x: 50, y: 0 }).world;

    expect(resolveAt(grown, 3).find(r => r.id === id)!.corners).toHaveLength(4);
    expect(resolveAt(grown, 4).find(r => r.id === id)!.corners).toHaveLength(5);
  });

  test('a corner removed at or after the unchain point goes', () => {
    const { world, id } = square();
    const corner = world.polygons.get(id)!.points[0].id;

    const loose = unchained(world, 2, [id]);
    const cut = removeVertices(loose, 4, [corner]);

    expect(resolveAt(cut, 3).find(r => r.id === id)!.corners).toHaveLength(4);
    expect(resolveAt(cut, 4).find(r => r.id === id)!.corners).toHaveLength(3);
  });

  test('existence is not unchained: an upstream delete still deletes', () => {
    const { world, id } = square();
    const loose = unchained(world, 3, [id]);
    const gone = removeAt(loose, 1, [id]);

    expect(at(gone, 0, id)).not.toEqual('gone');
    expect(at(gone, 3, id)).toEqual('gone');
  });

  test('the first keyframe has nothing to unchain from', () => {
    const { world, id } = square();

    expect(unchainable(world, 0, [id])).toBe(false);
    expect(unchained(world, 0, [id])).toBe(world);
  });

  test('a thing born at the keyframe has nothing to unchain from either', () => {
    const { world } = drawn();
    const added = addPolygon(world, kind('level'), rect(0, 0, 10, 10), 3, TOP);

    expect(unchainable(added.world, 3, [added.id])).toBe(false);
    expect(unchained(added.world, 3, [added.id])).toBe(added.world);
  });

  test('unchaining twice at the same keyframe says nothing the second time', () => {
    const { world, id } = square();
    const once = unchained(world, 3, [id]);

    expect(unchainable(once, 3, [id])).toBe(false);
    expect(unchained(once, 3, [id])).toBe(once);
  });

  test('a repeat written upstream goes on through the point, and nothing moves', () => {
    // It is something the room is doing rather than somewhere it got to, so
    // holding it back would change what is on screen from the keyframe after.
    const { world, id } = square();
    const going = keyed(world, 1, id, [repeating(move(10, 0), null)]);
    const before = [0, 1, 2, 3, 4, 5].map(v => at(going, v, id));

    const loose = unchained(going, 3, [id]);

    expect([0, 1, 2, 3, 4, 5].map(v => at(loose, v, id))).toEqual(before);

    // And a move that does not repeat is still held back.
    const moved = transformed(loose, 1, id, { translation: { x: 0, y: 500 } });

    expect(at(moved, 4, id)).toEqual(at(loose, 4, id));
  });

  test('two unchain points, each holding back only what is above it', () => {
    const { world, id } = square();
    const loose = unchained(unchained(world, 2, [id]), 5, [id]);

    // A move written between the two points reaches the first stretch and
    // stops at the second.
    const moved = transformed(loose, 3, id, { translation: { x: 40, y: 0 } });

    expect(at(moved, 3, id)).not.toEqual(at(loose, 3, id));
    expect(at(moved, 4, id)).not.toEqual(at(loose, 4, id));
    expect(at(moved, 5, id)).toEqual(at(loose, 5, id));
  });
});

describe('rechaining', () => {
  test('puts back exactly the world that never unchained', () => {
    const { world, id } = square();
    const moved = transformed(world, 1, id, { translation: { x: 25, y: -10 } });

    const loose = unchained(moved, 3, [id]);
    const back = rechained(loose, 3, [id]);

    expect([0, 1, 2, 3, 4].map(v => at(back, v, id)))
      .toEqual([0, 1, 2, 3, 4].map(v => at(moved, v, id)));
  });

  test('lets through what was suppressed while it was unchained', () => {
    const { world, id } = square();

    const loose = unchained(world, 3, [id]);
    const moved = transformed(loose, 1, id, { translation: { x: 40, y: 0 } });
    const back = rechained(moved, 3, [id]);

    expect(at(back, 3, id)).toEqual(at(back, 1, id));
  });

  test('only the point it is asked at', () => {
    const { world, id } = square();
    const loose = unchained(unchained(world, 2, [id]), 5, [id]);
    const back = rechained(loose, 2, [id]);

    expect(unchainedAt(back, 2, id)).toBe(false);
    expect(unchainedAt(back, 5, id)).toBe(true);
  });

  test('says nothing where nothing is unchained', () => {
    const { world, id } = square();

    expect(rechainable(world, 3, [id])).toBe(false);
    expect(rechained(world, 3, [id])).toBe(world);
  });
});

describe('unchaining a group', () => {
  function pair(): { world: World, a: PolygonId, b: PolygonId, group: number } {
    const { world, ids } = drawn(
      ['level', rect(0, 0, 100, 100)],
      ['level', rect(60, 0, 100, 100)],
    );

    const made = grouped(world, 0, ids, landing(world, 0, null))!;

    return { world: made.world, a: ids[0], b: ids[1], group: made.id };
  }

  test('takes its members with it', () => {
    const { world, a, b, group } = pair();
    const loose = unchained(world, 3, [group]);

    expect(unchainedAt(loose, 3, group)).toBe(true);
    expect(unchainedAt(loose, 3, a)).toBe(true);
    expect(unchainedAt(loose, 3, b)).toBe(true);
  });

  test('an upstream move of the group stops arriving', () => {
    const { world, a, group } = pair();
    const loose = unchained(world, 3, [group]);
    const moved = transformed(loose, 1, group, { translation: { x: 40, y: 0 } });

    expect(at(moved, 1, a)).not.toEqual(at(world, 1, a));
    expect(at(moved, 3, a)).toEqual(at(world, 3, a));
  });

  test('an upstream move of one member stops arriving', () => {
    const { world, a, group } = pair();
    const loose = unchained(world, 3, [group]);
    const moved = transformed(loose, 1, a, { translation: { x: 0, y: 40 } });

    expect(at(moved, 1, a)).not.toEqual(at(world, 1, a));
    expect(at(moved, 3, a)).toEqual(at(world, 3, a));
  });

  test('the group keeps the depth it was under, and stops inheriting a new one', () => {
    const { world, group } = pair();
    const eroded = transformed(world, 1, group, { erosion: 5 });
    const loose = unchained(eroded, 3, [group]);

    expect(depths(loose, 3).get(group)).toBe(5);

    const deeper = transformed(loose, 1, group, { erosion: 25 });

    expect(depths(deeper, 1).get(group)).toBe(25);
    expect(depths(deeper, 3).get(group)).toBe(5);
  });

  test('a member unchained on its own still goes where its group goes', () => {
    // Its own past stops arriving, and the group's does not: to hold a member
    // still in the world, it is the group that is unchained.
    const { world, a, group } = pair();
    const loose = unchained(world, 3, [a]);

    expect(unchainedAt(loose, 3, group)).toBe(false);

    const moved = transformed(loose, 1, group, { translation: { x: 40, y: 0 } });

    expect(at(moved, 3, a)).not.toEqual(at(world, 3, a));
    expect(at(transformed(loose, 1, a, { translation: { x: 40, y: 0 } }), 3, a)).toEqual(at(world, 3, a));
  });

  test('a member moved at or after the point still moves', () => {
    const { world, a, group } = pair();
    const loose = unchained(world, 3, [group]);
    const moved = transformed(loose, 4, a, { translation: { x: 0, y: 40 } });

    expect(at(moved, 4, a)).not.toEqual(at(moved, 3, a));
  });
});

describe('unchaining an artefact', () => {
  function placed(): { world: World, id: ArtefactId } {
    const added = addArtefact(emptyWorld(), 'key', { x: 10, y: 20 }, 0, TOP);

    return { world: added.world, id: added.id };
  }

  test('stops hearing an upstream move', () => {
    const { world, id } = placed();
    const loose = unchained(world, 3, [id]);
    const moved = transformed(loose, 1, id, { translation: { x: 100, y: 0 } });

    expect(placeAt(moved, id, 1)).toEqual({ x: 110, y: 20 });
    expect(placeAt(moved, id, 3)).toEqual({ x: 10, y: 20 });
  });

  test('still hears one written at or after the point', () => {
    const { world, id } = placed();
    const loose = unchained(world, 3, [id]);
    const moved = transformed(loose, 3, id, { translation: { x: 5, y: 0 } });

    expect(placeAt(moved, id, 3)).toEqual({ x: 15, y: 20 });
  });
});

describe('a stand in a file', () => {
  test('comes back saying the same thing', () => {
    const { world, id } = square();
    const moved = transformed(world, 1, id, { translation: { x: 25, y: -10 } });
    const loose = unchained(moved, 3, [id]);

    const back = restored(JSON.parse(JSON.stringify(saved(initialState(loose))))).world;

    expect([0, 1, 2, 3, 4].map(v => at(back, v, id)))
      .toEqual([0, 1, 2, 3, 4].map(v => at(loose, v, id)));

    expect(unchainedAt(back, 3, id)).toBe(true);
  });

  test('a file with none reads as a world where everything is chained', () => {
    const { world, id } = square();
    const file = saved(initialState(world));

    expect(file.world.rigs).toEqual([]);

    const back = restored(JSON.parse(JSON.stringify(file))).world;

    expect(back.keyframes.some(k => unchainedAt(back, k.id, id))).toBe(false);
    expect(at(back, 3, id)).toEqual(at(world, 3, id));
  });
});

// -----------------------------------------------------------------------------
// The span across an unchain point
//
// A stand is a copy of what its keyframe was handed, so the two ends of the leg
// it sits at the far end of agree until an upstream edit pulls them apart. Once
// one does, the leg is a leg like any other — it starts where the editor draws
// the near keyframe and lands where it draws the far one. Which is the whole of
// what has to be true here: the bake and the editor must not disagree about
// where an unchained room is.
// -----------------------------------------------------------------------------

/** The generator run to the end, which is what a test wants. */
function run<T>(g: Generator<number, T, void>): T {
  let step = g.next();

  while (!step.done) step = g.next();

  return step.value;
}

function length(frame: Frame): number {
  let out = 0;

  for (const it of frame) {
    for (let i = 1; i < it.points.length; i++) {
      out += Math.hypot(
        it.points[i].x - it.points[i - 1].x,
        it.points[i].y - it.points[i - 1].y,
      );
    }
  }

  return out;
}

/** Where a frame sits, which is what a jump is about. */
function middle(frame: Frame): Point {
  let minX = Infinity, maxX = -Infinity;

  for (const it of frame) {
    for (const p of it.points) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
    }
  }

  return { x: (minX + maxX) / 2, y: 0 };
}

function editorAt(world: World, v: KeyframeId): number {
  return length(csg(world, v).map(points => ({
    id: 0,
    points,
    corner: points.map(() => true),
    whence: points.map((_p, i) => ({ kind: 'vertex' as const, at: { id: 0, ring: 0, index: i } })),
    fill: false,
  })));
}

describe('the span across an unchain point', () => {
  /** A square unchained at v1, and then moved a long way at v0 — so the two
   * ends of the first leg are nowhere near each other. */
  function apart(): World {
    const { world, id } = square();

    return transformed(unchained(world, 1, [id]), 0, id, { translation: { x: 400, y: 0 } });
  }

  test('ends where the editor draws both versions', () => {
    const world = apart();
    const span = run(bakeSpan(world, 0));

    expect(length(sample(span, 0))).toBeCloseTo(editorAt(world, 0), 6);
    expect(length(sample(span, 1))).toBeCloseTo(editorAt(world, 1), 6);
  });

  test('walks across the jump rather than sitting at one end of it', () => {
    const world = apart();
    const span = run(bakeSpan(world, 0));

    expect(middle(sample(span, 0)).x).toBeCloseTo(450, 6);
    expect(middle(sample(span, 1)).x).toBeCloseTo(50, 6);
    expect(middle(sample(span, 0.5)).x).toBeCloseTo(250, 6);
  });

  test('a leg either side of the point is unremarkable', () => {
    const world = apart();

    for (const from of [1, 2]) {
      const span = run(bakeSpan(world, from));

      expect(length(sample(span, 0))).toBeCloseTo(editorAt(world, from), 6);
      expect(length(sample(span, 1))).toBeCloseTo(editorAt(world, from + 1), 6);
    }
  });
});
