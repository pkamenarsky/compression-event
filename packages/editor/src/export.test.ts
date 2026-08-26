// -----------------------------------------------------------------------------
// The flattening does not change what the span means
//
// `divergence.test.ts` holds `sample` against `truth` — the replay against the
// world resolved outright. This holds `outline` against `sample` — the buffers
// the game gets against the replay they were flattened from. Between the two,
// what a shader written from `baked.ts` draws is tied all the way back to the
// CSG, and the shader itself only has to be checked against `outline`.
//
// The tolerance here is not the bake's. Nothing about the flattening is
// approximate; the only thing that moves is that the buffers are `Float32Array`
// and the replay is doubles, so what is being allowed for is seven digits on
// coordinates that run to a few hundred.
// -----------------------------------------------------------------------------

import { describe, expect, test } from 'vitest';
import { Point } from '@ce/game/world';
import { BakedSpan, CROSSING, FRAME_STRIDE, Hulls, outline, placeAt, signedArea } from '@ce/game';
import { Frame, artefactsDuring, bakeSpan, riding, sample, stretchAt, truth } from './bake';
import { artefactsShipped, bakedSpan, versionOf } from './export';
import {
  TOP,
  Affine,
  addArtefact,
  addPolygon,
  addVertex,
  EMPTY_LIVE,
  affine,
  compose,
  contributing,
  editAt,
  grouped,
  live,
  sourced,
  removeVertices,
  resolveAt,
  withEdit,
} from './scene';
import { ArtefactId, EMPTY_TRANSFORM, Id, PolygonId, PolygonType, Transform, VersionId, World, emptyWorld } from './types';

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

function transformed(world: World, v: VersionId, id: PolygonId, t: Partial<Transform>): World {
  const it = resolveAt(world, v).find(r => r.id === id)!;
  const edit = editAt(world, v, id, it.erosion);

  return withEdit(world, v, id, { ...edit, transform: { ...edit.transform, ...t } });
}

/** A layer on anything at all, group or polygon. `transformed` reads the
 * polygon's own erosion back first, which a group does not have. */
function moved(world: World, v: VersionId, id: Id, t: Partial<Transform>): World {
  const edit = editAt(world, v, id, 0);

  return withEdit(world, v, id, { ...edit, transform: { ...edit.transform, ...t } });
}

function eroded(world: World, v: VersionId, id: PolygonId, depth: number): World {
  return withEdit(world, v, id, {
    ...editAt(world, v, id, depth),
    transform: { ...editAt(world, v, id, depth).transform, erosion: depth },
  });
}

function run<T>(g: Generator<number, T, void>): T {
  let s = g.next();

  while (!s.done) s = g.next();

  return s.value;
}

/** The furthest any point of the flattened span sits from where the replay puts
 * it, or `Infinity` if the two do not even agree about what there is. */
function apart(a: Frame, b: Point[][]): number {
  if (a.length !== b.length) return Infinity;

  let worst = 0;

  for (let r = 0; r < a.length; r++) {
    if (a[r].points.length !== b[r].length) return Infinity;

    for (let i = 0; i < b[r].length; i++) {
      worst = Math.max(
        worst,
        Math.hypot(a[r].points[i].x - b[r][i].x, a[r].points[i].y - b[r][i].y),
      );
    }
  }

  return worst;
}

/** Single precision on coordinates of a few hundred units. */
const SLACK = 1e-3;

/** Instants that are deliberately not the ones the bake looked at. */
const INSTANTS = Array.from({ length: 101 }, (_unused, i) => i / 100);

function agrees(world: World, from: VersionId): number {
  const span = run(bakeSpan(world, from));
  const flat = bakedSpan(span);

  let worst = 0;

  for (const t of INSTANTS) {
    worst = Math.max(worst, apart(sample(span, t), outline(flat, t)));
  }

  return worst;
}

describe('a flattened span replays as its span does', () => {
  test('a room eroding', () => {
    const { world, ids } = drawn(['level', rect(0, 0, 200, 160)]);

    expect(agrees(eroded(world, 1, ids[0], 30), 0)).toBeLessThan(SLACK);
  });

  test('a room turning, which is what the frames are kept in components for', () => {
    const { world, ids } = drawn(['level', rect(0, 0, 200, 160)]);

    expect(agrees(transformed(world, 1, ids[0], { rotation: 0.8 }), 0)).toBeLessThan(SLACK);
  });

  test('a room turning about a corner rather than about the origin', () => {
    const { world, ids } = drawn(['level', rect(40, 40, 200, 160)]);
    const turned = transformed(world, 1, ids[0], {
      rotation: 0.6,
      translation: { x: 120, y: -40 },
    });

    expect(agrees(turned, 0)).toBeLessThan(SLACK);
  });

  test('a squash, which is where a version may be non-uniform at all', () => {
    const { world, ids } = drawn(['level', rect(0, 0, 200, 160)]);

    expect(agrees(transformed(world, 1, ids[0], { scale: { x: 0.4, y: 1.3 } }), 0))
      .toBeLessThan(SLACK);
  });

  test('a pillar turning inside a wall, where every crossing slides', () => {
    const { world, ids } = drawn(
      ['level', rect(0, 0, 300, 200)],
      ['solid', rect(120, 80, 60, 60)],
    );

    expect(agrees(transformed(world, 1, ids[1], { rotation: 1.1 }), 0)).toBeLessThan(SLACK);
  });

  // The one case where a slot's own frame is not the whole answer: the group's
  // layer is in flight too, and it is a link further up the chain rather than
  // anything in the polygon's own row of the table.
  test('a room inside a group that turns', () => {
    const { world, ids } = drawn(
      ['level', rect(0, 0, 200, 160)],
      ['level', rect(220, 40, 120, 120)],
    );

    const made = grouped(world, 0, [ids[0], ids[1]], TOP)!;

    expect(agrees(moved(made.world, 1, made.id, { rotation: 0.7 }), 0)).toBeLessThan(SLACK);
  });

  test('a room in a group inside a group, both turning', () => {
    const { world, ids } = drawn(
      ['level', rect(0, 0, 200, 160)],
      ['level', rect(220, 40, 120, 120)],
      ['level', rect(60, 220, 140, 100)],
    );

    const inner = grouped(world, 0, [ids[0], ids[1]], TOP)!;
    const outer = grouped(inner.world, 0, [inner.id, ids[2]], TOP)!;

    let w = moved(outer.world, 1, inner.id, { rotation: 0.5 });

    w = moved(w, 1, outer.id, { rotation: -0.4, translation: { x: 30, y: 10 } });

    expect(agrees(w, 0)).toBeLessThan(SLACK);
  });

  test('several rooms joining as they erode', () => {
    const { world, ids } = drawn(
      ['level', rect(0, 0, 200, 200)],
      ['level', rect(150, 60, 200, 90)],
      ['solid', rect(80, 80, 70, 70)],
    );

    let w = eroded(world, 1, ids[0], 20);
    w = eroded(w, 1, ids[1], 12);
    w = transformed(w, 1, ids[2], { rotation: 0.5, scale: { x: 1.4, y: 1.4 } });

    expect(agrees(w, 0)).toBeLessThan(SLACK);
  });
});

// -----------------------------------------------------------------------------
// The seam
//
// The 3D view draws two things: the boundary as the editor keeps it, while
// anyone is editing, and the baked span, while a transition plays. It crosses
// between them at the moment a switch starts and again when it ends, and
// anything that differs across that crossing is a flicker in the one place a
// viewer is looking hardest.
//
// The bake argues the two are the same answer — same members, same ranks, same
// tolerances — and `divergence.test.ts` holds the replay to `TOLERANCE` in the
// middle of a span, which is a width the eye can see. Neither says the ends
// land exactly on what the editor draws. This does.
// -----------------------------------------------------------------------------

/** Nothing about either end of a span is approximate, so the only thing being
 * allowed for is that the buffers are single precision. */
const EXACT = 1e-3;

describe('an artefact rides the frame table like everything else', () => {
  /** A key put exactly on a corner of a room, and the room made to move. */
  function corner(layer: Partial<Transform>): { world: World, key: ArtefactId } {
    const at = { x: 200, y: 0 };
    const drew = addPolygon(emptyWorld(), 'level', [{ x: 0, y: 0 }, at, { x: 200, y: 200 }], 0, TOP);
    const put = addArtefact(drew.world, 'key', at, 0, TOP);
    const made = grouped(put.world, 0, [drew.id, put.id], TOP)!;

    return { world: moved(made.world, 1, made.id, layer), key: put.id };
  }

  /** Instants strictly inside the span: both ends agree however it is read. */
  const INSIDE = [0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9];

  function shipped(world: World, key: ArtefactId): { flat: BakedSpan, at: Point, places: (Point | null)[] } {
    const flat = bakedSpan(run(bakeSpan(world, 0)), [key]);
    const all = artefactsShipped(world);

    return { flat, at: all[0].at, places: all[0].places };
  }

  test('a key on a corner is on that corner at every instant of the span', () => {
    const { world, key } = corner({
      rotation: Math.PI / 3,
      translation: { x: 40, y: -25 },
      scale: { x: 1.4, y: 0.8 },
    });

    const { flat, at } = shipped(world, key);

    for (const t of INSIDE) {
      const here = placeAt(flat, flat.artefacts[0], at, t);
      const wall = outline(flat, t).flat();
      const near = Math.min(...wall.map(p => Math.hypot(p.x - here.x, p.y - here.y)));

      expect(near).toBeLessThan(SLACK);
    }
  });

  test('and the buffers put it where the editor draws it', () => {
    const { world, key } = corner({ rotation: -0.9, translation: { x: 15, y: 60 } });
    const { flat, at } = shipped(world, key);

    for (const t of INSIDE) {
      const here = placeAt(flat, flat.artefacts[0], at, t);
      const there = artefactsDuring(world, 0, 1, t)[0].at;

      expect(here.x).toBeCloseTo(there.x, 3);
      expect(here.y).toBeCloseTo(there.y, 3);
    }
  });

  test('the arc is not the chord, which is the whole reason the slot is there', () => {
    const { world, key } = corner({ rotation: Math.PI / 2 });
    const { flat, at, places } = shipped(world, key);

    const here = placeAt(flat, flat.artefacts[0], at, 0.5);
    const a = places[0]!, b = places[1]!;
    const chord = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

    expect(Math.hypot(here.x - chord.x, here.y - chord.y)).toBeGreaterThan(10);
  });

  test('one the span has never heard of gets no slot in it', () => {
    const drew = addPolygon(emptyWorld(), 'level', rect(0, 0, 200, 160), 0, TOP);
    const put = addArtefact(drew.world, 'key', { x: 40, y: 40 }, 2, TOP);

    const flat = bakedSpan(run(bakeSpan(put.world, 0)), [put.id]);

    expect([...flat.artefacts]).toEqual([-1]);
  });
});

describe('a span begins and ends on what the editor draws', () => {
  const cases: [string, () => World][] = [
    ['a room eroding', () => {
      const { world, ids } = drawn(['level', rect(0, 0, 200, 160)]);

      return eroded(world, 1, ids[0], 30);
    }],
    ['a pillar turning in a wall', () => {
      const { world, ids } = drawn(
        ['level', rect(0, 0, 300, 200)],
        ['solid', rect(120, 80, 60, 60)],
      );

      return transformed(world, 1, ids[1], { rotation: 1.1 });
    }],
    ['rooms joining as they erode', () => {
      const { world, ids } = drawn(
        ['level', rect(0, 0, 200, 200)],
        ['level', rect(150, 60, 200, 90)],
        ['solid', rect(80, 80, 70, 70)],
      );

      let w = eroded(world, 1, ids[0], 20);

      w = eroded(w, 1, ids[1], 12);

      return transformed(w, 1, ids[2], { rotation: 0.5 });
    }],
  ];

  for (const [name, build] of cases) {
    test(name, () => {
      const world = build();
      const flat = bakedSpan(run(bakeSpan(world, 0)));

      // `truth` is the CSG run outright at an instant — the same path the
      // editor's own drawing goes through, which is what the still source will
      // be handed.
      expect(apart(truth(world, 0, 0), outline(flat, 0))).toBeLessThan(EXACT);
      expect(apart(truth(world, 0, 1), outline(flat, 1))).toBeLessThan(EXACT);
    });
  }
});

describe('what the buffers are', () => {
  test('a lone room has no crossings to solve', () => {
    const { world, ids } = drawn(['level', rect(0, 0, 200, 160)]);
    const flat = bakedSpan(run(bakeSpan(eroded(world, 1, ids[0], 30), 0)));

    expect(flat.kinds.every(k => k !== CROSSING)).toBe(true);
    expect(flat.entries.length).toBe(0);
  });

  test('a pillar in a wall is solved rather than interpolated', () => {
    const { world, ids } = drawn(
      ['level', rect(0, 0, 300, 200)],
      ['solid', rect(120, 80, 60, 60)],
    );
    const flat = bakedSpan(run(bakeSpan(transformed(world, 1, ids[1], { rotation: 1.1 }), 0)));

    expect([...flat.kinds].filter(k => k === CROSSING).length).toBeGreaterThan(0);

    // Every crossing names four entries, and every entry is one that exists.
    for (let i = 0; i < flat.kinds.length; i++) {
      if (flat.kinds[i] !== CROSSING) continue;

      for (let j = 0; j < 4; j++) {
        const e = flat.crossings[i * 4 + j];

        expect(e).toBeGreaterThanOrEqual(0);
        expect(e).toBeLessThan(flat.entries.length / 8);
      }
    }
  });

  test('one frame slot per polygon, whatever it does', () => {
    const { world, ids } = drawn(
      ['level', rect(0, 0, 300, 200)],
      ['solid', rect(120, 80, 60, 60)],
    );
    const flat = bakedSpan(run(bakeSpan(transformed(world, 1, ids[1], { rotation: 1.1 }), 0)));

    expect(flat.frames.length / 16).toBe(2);
    expect([...flat.slots].every(s => s === 0 || s === 1)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// The union, which is what collision runs on
//
// The bug this was written for: hulls built from the authored rings stop the
// player at walls the set does not have. Two rooms overlapping is the ordinary
// way to author a level here, and the seam between them was a wall you could
// see through and not walk through.
// -----------------------------------------------------------------------------

/** One world unit per editor unit, so every number below is both. */
const ONE = 1;

function hullsAt(world: World, v: VersionId): Hulls {
  return new Hulls(versionOf(world, v).polygons, ONE);
}

describe('a seam between two rooms is not a wall', () => {
  const overlapping = drawn(
    ['level', rect(0, 0, 100, 100)],
    ['level', rect(60, 20, 100, 60)],
  ).world;

  test('the two rooms come out as one ring', () => {
    const version = versionOf(overlapping, 0);

    expect(version.polygons.length).toBe(1);
  });

  test('the player walks across it', () => {
    const at = hullsAt(overlapping, 0).trace({ x: 80, y: 50 }, { x: 40, y: 0 });

    // Where the source rings were used this stopped at 99.7, against the first
    // room's east wall — in the middle of the second room's floor.
    expect(at.x).toBeCloseTo(120, 6);
    expect(at.y).toBeCloseTo(50, 6);
  });

  test('and can stand on it', () => {
    expect(hullsAt(overlapping, 0).standable({ x: 99.9, y: 50 })).toBe(true);
  });

  test('while the outer wall of the union still stops them', () => {
    const at = hullsAt(overlapping, 0).trace({ x: 120, y: 50 }, { x: 100, y: 0 });

    expect(at.x).toBeGreaterThan(160 - 0.3 - 1e-2);
    expect(at.x).toBeLessThan(160 - 0.3 + 1e-2);
  });
});

describe('a solid becomes a hole, and a hole is one by its winding', () => {
  const pillared = drawn(
    ['level', rect(0, 0, 200, 200)],
    ['solid', rect(80, 80, 40, 40)],
  ).world;

  test('an outer ring and a hole, wound against each other', () => {
    const rings = versionOf(pillared, 0).polygons;

    expect(rings.length).toBe(2);

    const areas = rings.map(r => signedArea(r.points));

    expect(areas.some(a => a > 0)).toBe(true);
    expect(areas.some(a => a < 0)).toBe(true);
  });

  test('the hole is not somewhere to stand', () => {
    const hulls = hullsAt(pillared, 0);

    expect(hulls.standable({ x: 100, y: 100 })).toBe(false);
    expect(hulls.standable({ x: 30, y: 30 })).toBe(true);
  });

  test('and stops the player a radius short of its face', () => {
    const at = hullsAt(pillared, 0).trace({ x: 40, y: 100 }, { x: 100, y: 0 });

    expect(at.x).toBeGreaterThan(80 - 0.3 - 1e-2);
    expect(at.x).toBeLessThan(80 - 0.3 + 1e-2);
  });
});

describe('floors come along without taking part', () => {
  const drawing = drawn(
    ['level', rect(0, 0, 200, 200)],
    ['floor', rect(50, 50, 60, 60)],
  );

  const withFloor = drawing.world;

  test('kept, and kept apart', () => {
    const version = versionOf(withFloor, 0);

    // In a list of its own rather than a ring the collision would have to know
    // to skip. The room is the only thing in the set.
    expect(version.polygons.length).toBe(1);
    expect(version.floors.length).toBe(1);
  });

  test('a floor carries points and nothing else', () => {
    // No normals: they are for deciding which side of a ring is material, and
    // a shape that is only ever filled has no such side.
    const floor = versionOf(withFloor, 0).floors[0];

    expect(floor.points.map(p => ({ x: p.x, y: p.y })))
      .toEqual(floor.points.map(p => ({ ...p })));
  });

  test('and nothing walks into one', () => {
    const at = hullsAt(withFloor, 0).trace({ x: 20, y: 80 }, { x: 60, y: 0 });

    expect(at.x).toBeCloseTo(80, 6);
  });

  test('a level that is only floors is nothing to walk in', () => {
    const only = drawn(['floor', rect(0, 0, 100, 100)]).world;
    const version = versionOf(only, 0);

    expect(version.polygons).toEqual([]);
    expect(version.floors.length).toBe(1);
  });

  test('but it morphs across a span, and says so in the buffers', () => {
    // Taking no part in the set is not the same as standing still. The floor
    // rides its own chain like everything else; what the flag says is what is
    // built on the points at the other end — a fill rather than walls.
    const moved = transformed(withFloor, 1, drawing.ids[1], {
      translation: { x: 40, y: 25 },
      rotation: 0.4,
    });

    const flat = bakedSpan(run(bakeSpan(moved, 0)));
    const fills = flat.tracks.filter(t => t.fill);

    expect(fills.length).toBe(1);
    expect(flat.tracks.filter(t => !t.fill).length).toBe(1);

    // Closed, and every point a corner of its own outline — a floor is under
    // the walls, never cut by them.
    for (const s of fills[0].stretches) {
      for (const r of s.runs) {
        expect(r.count).toBeGreaterThan(3);

        for (let i = r.first; i < r.first + r.count; i++) {
          expect(flat.kinds[i]).not.toEqual(CROSSING);
        }
      }
    }

    expect(agrees(moved, 0)).toBeLessThan(SLACK);
  });
});

// -----------------------------------------------------------------------------
// lineOpacity
//
// Both ends of a span are written over the same corners or the rings cannot
// interpolate, so a corner that dies at the far end is carried the whole way
// and placed on the edge between its ring-neighbours at the end that lacks it.
// The shape is unchanged, which is the point — but it is not a corner there,
// and a wall that draws a vertical line at it says it is.
// -----------------------------------------------------------------------------

describe('a corner that is not there does not draw a line', () => {
  /** A room with a corner added mid-wall at v0 and taken out at v1. */
  function dying(): { world: World, vertex: number } {
    const { world, ids } = drawn(['level', rect(0, 0, 300, 200)]);
    const at0 = resolveAt(world, 0).find(r => r.id === ids[0])!;
    const added = addVertex(world, 0, at0, 0, { x: 150, y: 0 });

    return { world: removeVertices(added.world, 1, [added.vertex]), vertex: added.vertex };
  }

  test('it is solid where it is a corner and gone where it is not', () => {
    const flat = bakedSpan(run(bakeSpan(dying().world, 0)));

    // Somewhere in the span a point draws nothing. Everywhere else the corner
    // is part way out of the wall and turns like any other, so it draws.
    expect(Math.min(...flat.opacityB)).toBeCloseTo(0, 9);

    for (let i = 0; i < flat.opacityA.length; i++) {
      expect(flat.opacityA[i]).toBeGreaterThanOrEqual(0);
      expect(flat.opacityA[i]).toBeLessThanOrEqual(1);
      expect(flat.opacityB[i]).toBeGreaterThanOrEqual(0);
      expect(flat.opacityB[i]).toBeLessThanOrEqual(1);
    }
  });

  test('and it is exactly gone at the version that took it out', () => {
    const track = run(bakeSpan(dying().world, 0)).tracks[0];

    // Asked for the ends themselves rather than for the first and last
    // stretches, because the two are not always the same thing: where the
    // corner goes exactly at a version, that version is a jump, and a jump is
    // not in the cover. `stretchAt` is what the reader asks either way.
    const end = stretchAt(track, 1)!;

    expect(Math.min(...end.opacity[1].flat())).toBeCloseTo(0, 9);

    const start = stretchAt(track, 0)!;

    expect(Math.min(...start.opacity[0].flat())).toBeCloseTo(1, 9);

    // And the cover really does run end to end.
    expect(track.stretches[0].t0).toBeCloseTo(0, 9);
    expect(track.stretches[track.stretches.length - 1].t1).toBeCloseTo(1, 9);
  });

  test('a room whose corners never change fades nothing', () => {
    const { world, ids } = drawn(['level', rect(0, 0, 300, 200)]);
    const flat = bakedSpan(run(bakeSpan(eroded(world, 1, ids[0], 30), 0)));

    expect([...flat.opacityA].every(a => a === 1)).toBe(true);
    expect([...flat.opacityB].every(b => b === 1)).toBe(true);
  });
});

describe('the source rings a version resolves to', () => {
  test('come out wound and normalled', () => {
    const { world, ids } = drawn(['level', rect(0, 0, 200, 160)]);
    const version = versionOf(eroded(world, 1, ids[0], 30), 1);

    expect(version.polygons.length).toBe(1);

    const points = version.polygons[0].points;

    expect(points.length).toBe(4);

    // The erosion took thirty units off every side of a 200 by 160 room.
    const xs = points.map(p => p.x), ys = points.map(p => p.y);

    expect(Math.min(...xs)).toBeCloseTo(30, 6);
    expect(Math.max(...xs)).toBeCloseTo(170, 6);
    expect(Math.min(...ys)).toBeCloseTo(30, 6);
    expect(Math.max(...ys)).toBeCloseTo(130, 6);

    // Every edge normal is a unit vector, and every bisector reaches at least
    // as far as one — it is the unit bisector over the cosine of the half angle.
    for (const p of points) {
      expect(Math.hypot(p.enx, p.eny)).toBeCloseTo(1, 6);
      expect(Math.hypot(p.bnx, p.bny)).toBeGreaterThanOrEqual(1 - 1e-9);
    }
  });

  test('a room eroded until it pinches in two comes out as two rings', () => {
    const { world, ids } = drawn(
      ['level', [
        { x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 },
        { x: 110, y: 100 }, { x: 200, y: 400 }, { x: 0, y: 400 },
      ]],
    );

    const version = versionOf(eroded(world, 1, ids[0], 44), 1);

    expect(version.polygons.length).toBe(2);
  });
});

// -----------------------------------------------------------------------------
// The frame table, read the way the shader reads it
// -----------------------------------------------------------------------------

/**
 * `frameAt` out of `morph.ts`, in TypeScript: one slot's own frame, then up the
 * chain by the parent the table names, `depth` links at most.
 *
 * Transcribed rather than shared, deliberately. What is being checked is that
 * the table says what the shader will read out of it — the slot a group landed
 * in, the parent index beside every polygon, and the depth the loop is built
 * to. A helper both sides called would agree with itself.
 */
function shaderFrame(frames: Float32Array, depth: number, slot: number, t: number): Affine {
  const link = (at: number): Affine => {
    const o = at * FRAME_STRIDE;
    const base: Affine = {
      a: frames[o], b: frames[o + 1], c: frames[o + 2],
      d: frames[o + 3], tx: frames[o + 4], ty: frames[o + 5],
    };

    const layer: Transform = {
      translation: { x: frames[o + 6], y: frames[o + 7] },
      rotation: frames[o + 8],
      scale: { x: frames[o + 9], y: frames[o + 10] },
      erosion: 0,
    };

    const rot = layer.rotation * t;
    const sx = 1 + (layer.scale.x - 1) * t;
    const sy = 1 + (layer.scale.y - 1) * t;
    const cos = Math.cos(rot), sin = Math.sin(rot);
    const m = { a: cos * sx, b: sin * sx, c: -sin * sy, d: cos * sy, tx: 0, ty: 0 };

    const fixed = frames[o + 11] !== 0 && t !== 0 && t !== 1;
    const p = { x: frames[o + 12], y: frames[o + 13] };

    const tr = fixed
      ? { x: p.x - (m.a * p.x + m.c * p.y), y: p.y - (m.b * p.x + m.d * p.y) }
      : { x: layer.translation.x * t, y: layer.translation.y * t };

    return compose({ ...m, tx: tr.x, ty: tr.y }, base);
  };

  let out = link(slot);

  for (let i = 1; i < depth; i++) {
    slot = frames[slot * FRAME_STRIDE + 14];

    if (slot < 0) break;

    out = compose(link(slot), out);
  }

  return out;
}

/** To three places, because the table is `Float32Array` and the walk is the
 * one thing here that reads it back through that. */
function near(a: Affine, b: Affine): void {
  for (const k of ['a', 'b', 'c', 'd', 'tx', 'ty'] as const) {
    expect(a[k]).toBeCloseTo(b[k], 3);
  }
}

describe('the chain a vertex rides', () => {
  /** Two rooms in a group, the group in another group, and every level of it
   * doing something at v1 that does not commute with the others. */
  function nested(): { world: World, ids: PolygonId[] } {
    const { world, ids } = drawn(
      ['level', rect(-200, -60, 400, 120)],
      ['level', rect(-40, -200, 80, 400)],
      ['level', rect(150, 150, 120, 120)],
    );

    const inner = grouped(world, 0, [ids[0], ids[1]], TOP)!;
    const outer = grouped(inner.world, 0, [inner.id, ids[2]], TOP)!;

    const turned = withEdit(outer.world, 1, inner.id, {
      transform: { ...EMPTY_TRANSFORM, rotation: Math.PI / 5 },
      vertices: new Map(),
    });

    const squashed = withEdit(turned, 1, outer.id, {
      transform: { ...EMPTY_TRANSFORM, scale: { x: 1.6, y: 0.7 } },
      vertices: new Map(),
    });

    return {
      world: transformed(squashed, 1, ids[0], { translation: { x: 30, y: 0 } }),
      ids,
    };
  }

  test('the table says how deep it goes, and the groups have slots of their own', () => {
    const span = run(bakeSpan(nested().world, 0));
    const flat = bakedSpan(span);

    // Three polygons, two groups, and a walk of three links from the deepest.
    expect(flat.frames.length / FRAME_STRIDE).toEqual(5);
    expect(flat.depth).toEqual(3);

    // Nothing grouped is one link and no parents at all.
    const plain = bakedSpan(run(bakeSpan(
      transformed(drawn(['level', rect(0, 0, 100, 100)]).world, 1, 0, { rotation: 1 }),
      0,
    )));

    expect(plain.depth).toEqual(1);
    expect(plain.frames[14]).toEqual(-1);
  });

  test('walking it gives what the bake places the polygon by', () => {
    const { world, ids } = nested();
    const span = run(bakeSpan(world, 0));
    const flat = bakedSpan(span);

    // The slots are the riders and their holders, by id in order.
    const slots = new Map(
      [...new Set([
        ...span.riders.keys(),
        ...[...span.riders.values()].flatMap(r => r.holders.map(h => h.id)),
      ])].sort((a, b) => a - b).map((id, i) => [id, i]),
    );

    for (const t of [0, 0.13, 0.5, 0.77, 1]) {
      for (const id of ids) {
        near(
          shaderFrame(flat.frames, flat.depth, slots.get(id)!, t),
          riding(span.riders.get(id)!, t),
        );
      }
    }
  });

});

/**
 * The two sources of geometry have to draw the same verticals.
 *
 * `still` builds its walls from the boundary the editor already keeps; the
 * morph builds them from the bake. The editor crosses between the two at the
 * start and the end of every transition, so a vertical either of them stands
 * alone appears or vanishes at that crossing — see the header of `walls.ts`.
 *
 * This holds one against the other at the version the span starts from, which
 * is the instant the crossing happens at. Both get the answer from
 * `boundaryRuns`, but by different routes — the editor's side through the whole
 * incremental set, the bake's through one polygon's share of it — and the two
 * have to arrive at the same place. The abutting pair is the case that says so:
 * neither polygon could answer for the join out of its own runs.
 */
describe('the standing walls and the bake agree about every vertical', () => {
  function same(world: World): void {
    const items = contributing(world, 0, resolveAt(world, 0));
    const standing = sourced(live(EMPTY_LIVE, items));

    const flat = bakedSpan(run(bakeSpan(world, 0)));

    // The A end of the first stretch of every track, which is the span's
    // start: the same boundary `still` was handed. The still side reads world
    // units and the bake each polygon's own frame; nothing here is transformed,
    // so the two coincide and a run is found by the points it is made of.
    const baked = new Map<string, number[]>();

    for (const track of flat.tracks) {
      for (const r of track.stretches[0].runs) {
        const where: string[] = [], flags: number[] = [];

        for (let i = 0; i < r.count; i++) {
          const at = r.first + i;

          where.push(`${flat.pointsA[at * 2]},${flat.pointsA[at * 2 + 1]}`);
          flags.push(flat.opacityA[at]);
        }

        baked.set(where.join(' '), flags);
      }
    }

    standing.forEach(r => {
      const where = r.points.map(p => `${p.x},${p.y}`).join(' ');

      expect([where, baked.get(where)])
        .toEqual([where, r.corner.map(t => (t ? 1 : 0))]);
    });
  }

  test('two rooms abutting on a flat wall', () => {
    same(drawn(
      ['level', rect(0, 0, 100, 100)],
      ['level', rect(100, 0, 100, 100)],
    ).world);
  });

  test('a room with a solid cutting a notch out of one wall', () => {
    same(drawn(
      ['level', rect(0, 0, 200, 100)],
      ['solid', rect(60, -20, 40, 40)],
    ).world);
  });

  test('two rooms overlapping', () => {
    same(drawn(
      ['level', rect(0, 0, 100, 100)],
      ['level', rect(60, 20, 100, 60)],
    ).world);
  });
});
