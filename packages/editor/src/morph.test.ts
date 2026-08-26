// -----------------------------------------------------------------------------
// What the span's buffers build
//
// `export.test.ts` holds the buffers against the replay they were flattened
// from; this holds against them the meshes the renderer actually draws — how
// many vertices each kind claims, and which points they stand on. A floor is
// the case that needs it: it comes out of the same buffers as the walls and is
// built into something else entirely, so a track's `fill` reaching the wrong
// half is a level with holes in the ground and floors standing up as walls.
//
// Nothing here needs a GL context: a geometry is arithmetic.
// -----------------------------------------------------------------------------

import { describe, expect, test } from 'vitest';
import { Point } from '@ce/game/world';
import { morph } from '@ce/game';
import { WallOptions } from '@ce/game';
import { bakeSpan } from './bake';
import { bakedSpan } from './export';
import { TOP, addPolygon, editAt, resolveAt, withEdit } from './scene';
import { PolygonId, PolygonType, VersionId, World, emptyWorld } from './types';

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

function moved(world: World, v: VersionId, id: PolygonId, to: Point): World {
  const it = resolveAt(world, v).find(r => r.id === id)!;
  const edit = editAt(world, v, id, it.erosion);

  return withEdit(world, v, id, {
    ...edit,
    transform: { ...edit.transform, translation: to, rotation: 0.6 },
  });
}

function run<T>(g: Generator<number, T, void>): T {
  let step = g.next();

  while (!step.done) step = g.next();

  return step.value;
}

const OPTIONS: WallOptions = {
  scale: 1 / 25,
  wallHeight: 7,
  wallColor: 0xffffff,
  lineColor: 0x000000,
  fillColor: 0x000000,
  fillHeight: -0.005,
};

describe('the meshes a span builds', () => {
  test('a floor becomes triangles and no walls', () => {
    const { world, ids } = drawn(
      ['level', rect(-200, -200, 400, 400)],
      ['floor', rect(-50, -50, 100, 100)],
    );

    const span = bakedSpan(run(bakeSpan(moved(world, 1, ids[1], { x: 90, y: 30 }), 0)));
    const it = morph(span, OPTIONS);

    const point = it.fill.geometry.getAttribute('aPointA');
    const track = span.tracks.find(t => t.fill)!;
    const ring = track.stretches[0].runs[0];

    // A closed ring of n + 1 points is n corners, which fans into n - 2
    // triangles and so three times that many vertices.
    expect(point.count).toEqual((ring.count - 1 - 2) * 3);

    // On the ground, under the walls standing on it.
    expect(it.fill.position.y).toBeCloseTo(OPTIONS.fillHeight, 9);

    // And every one of them stands on a point of that ring, never on a wall's.
    const from = new Set<string>();

    for (let i = ring.first; i < ring.first + ring.count; i++) {
      from.add(`${span.pointsA[i * 2]},${span.pointsA[i * 2 + 1]}`);
    }

    for (let i = 0; i < point.count; i++) {
      expect(from.has(`${point.getX(i)},${point.getY(i)}`)).toBe(true);
    }

    it.dispose();
  });

  test('and the walls are built from everything that is not one', () => {
    const bare = drawn(['level', rect(-200, -200, 400, 400)]);
    const withFloor = drawn(
      ['level', rect(-200, -200, 400, 400)],
      ['floor', rect(-50, -50, 100, 100)],
    );

    const one = morph(bakedSpan(run(bakeSpan(bare.world, 0))), OPTIONS);
    const two = morph(bakedSpan(run(bakeSpan(withFloor.world, 0))), OPTIONS);

    // The floor adds triangles to the fill and nothing at all to the walls.
    expect(two.walls.geometry.getAttribute('aPointA').count)
      .toEqual(one.walls.geometry.getAttribute('aPointA').count);

    expect(one.fill.geometry.getAttribute('aPointA').count).toEqual(0);
    expect(two.fill.geometry.getAttribute('aPointA').count).toBeGreaterThan(0);

    one.dispose();
    two.dispose();
  });

  test('a floor is alive for exactly its own stretch', () => {
    // The gate the shader draws by, and the reason the fill is built from
    // `stretches` alone: what a vertex claims is the span its stretch owns.
    const { world, ids } = drawn(
      ['level', rect(-200, -200, 400, 400)],
      ['floor', rect(-50, -50, 100, 100)],
    );

    const span = bakedSpan(run(bakeSpan(moved(world, 1, ids[1], { x: 90, y: 30 }), 0)));
    const it = morph(span, OPTIONS);
    const range = it.fill.geometry.getAttribute('aRange');

    for (let i = 0; i < range.count; i++) {
      expect(range.getX(i)).toEqual(0);
      expect(range.getY(i)).toEqual(1);
    }

    it.dispose();
  });
});
