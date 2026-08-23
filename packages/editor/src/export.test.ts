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
import { CROSSING, outline } from '@ce/game';
import { Frame, bakeSpan, sample } from './bake';
import { bakedSpan, versionOf } from './export';
import { addPolygon, editAt, resolveAt, withEdit } from './scene';
import { PolygonId, PolygonType, Transform, VersionId, World, emptyWorld } from './types';

function rect(x: number, y: number, w: number, h: number): Point[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

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

function transformed(world: World, v: VersionId, id: PolygonId, t: Partial<Transform>): World {
  const it = resolveAt(world, v).find(r => r.id === id)!;
  const edit = editAt(world, v, id, it.erosion);

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
