import { describe, expect, test } from 'vitest';
import { Point } from '@ce/game/world';
import { shapeArea } from './geometry';
import { Resolved, csg, resolve } from './scene';
import { EMPTY_TRANSFORM, Polygon, PolygonType, Transform } from './types';

function rect(x: number, y: number, w: number, h: number): Point[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

function make(
  id: number,
  type: PolygonType,
  points: Point[],
  transform: Transform = EMPTY_TRANSFORM,
): Resolved {
  const polygon: Polygon = { type, points, transform };

  return { id, polygon, ring: resolve(polygon) };
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

describe('csg', () => {
  test('overlapping rooms merge whichever way round they were drawn', () => {
    // 10x10 and 10x10 overlapping by 5x5: 100 + 100 - 25.
    for (const [a, b] of everyWinding(rect(0, 0, 10, 10), rect(5, 5, 10, 10))) {
      const shape = csg([make(0, 'level', a), make(1, 'level', b)]);

      expect(shapeArea(shape)).toBeCloseTo(175, 6);

      // One ring, not two. The wall between them would show up as an extra.
      expect(shape.length).toBe(1);
    }
  });

  test('a solid subtracts whichever way round it was drawn', () => {
    for (const [a, b] of everyWinding(rect(0, 0, 10, 10), rect(5, 5, 10, 10))) {
      expect(shapeArea(csg([make(0, 'level', a), make(1, 'solid', b)])))
        .toBeCloseTo(75, 6);
    }
  });

  test('winding comes off the points as drawn, not off the ring on screen', () => {
    // Eroding a 30x10 strip by 8 takes it through itself the short way, and the
    // ring comes out inside-out. Reading the winding off that ring would turn it
    // back to agreeing with its neighbour and *add* ground where the strip
    // collapsed; reading it off the points keeps the inversion.
    const room = make(0, 'level', rect(0, 0, 40, 40));
    const gone = make(1, 'level', rect(5, 15, 30, 10), { ...EMPTY_TRANSFORM, erosion: 8 });

    expect(shapeArea(csg([room]))).toBeCloseTo(1600, 6);
    expect(shapeArea(csg([room, gone]))).toBeLessThan(1600);
  });

  test('collapsing in both directions at once does not invert', () => {
    // A square eroded past its own middle crosses on both axes, which turns the
    // winding over twice and leaves it as it was, so what comes back is a
    // smaller square of ground rather than nothing. Unclamped erosion has no
    // opinion about this; clamping each vertex at its own collapse depth is
    // what stops it, and that is not built yet.
    const inverted = make(0, 'level', rect(0, 0, 10, 10), { ...EMPTY_TRANSFORM, erosion: 8 });

    expect(shapeArea(csg([inverted]))).toBeCloseTo(36, 6);
  });

  test('two triangles wound against each other still merge', () => {
    // Drawn in the editor, one clicked round the other way. Before the winding
    // was normalised this came out as two rings — the overlap cancelling to a
    // hole — and the wall between them stayed on screen.
    const a = [{ x: -320, y: -128 }, { x: 96, y: -128 }, { x: -128, y: 192 }];
    const b = [{ x: 96, y: 224 }, { x: 288, y: -64 }, { x: -128, y: -64 }];

    const apart = shapeArea(csg([make(0, 'level', a)]))
      + shapeArea(csg([make(1, 'level', b)]));

    const shape = csg([make(0, 'level', a), make(1, 'level', b)]);

    expect(apart).toBeCloseTo(126464, 6);

    // One ring: a second would be the hole the cancellation used to punch.
    expect(shape.length).toBe(1);

    // And they do overlap, so the union is smaller than the two of them.
    expect(shapeArea(shape)).toBeLessThan(apart);
    expect(shapeArea(shape)).toBeGreaterThan(66560);
  });

  test('a transform moves what the set is computed from', () => {
    const shifted = make(0, 'level', rect(0, 0, 10, 10), {
      ...EMPTY_TRANSFORM,
      translation: { x: 100, y: 0 },
    });

    const shape = csg([make(1, 'level', rect(0, 0, 10, 10)), shifted]);

    // Far enough apart to stay two rooms, and no area lost in the move.
    expect(shape.length).toBe(2);
    expect(shapeArea(shape)).toBeCloseTo(200, 6);
  });
});
