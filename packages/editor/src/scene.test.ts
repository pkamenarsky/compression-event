import { describe, expect, test } from 'vitest';
import { Point } from '@ce/game/world';
import { shapeArea } from './geometry';
import { Resolved, csg, placeVertex, resolve, sourcePolygon } from './scene';
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
  const polygon = { ...sourcePolygon(type, points), transform };

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

describe('placeVertex', () => {
  const turned: Transform = {
    translation: { x: 40, y: -15 },
    scale: 1.3,
    rotation: Math.PI / 4,
    erosion: 0,
  };

  function square(transform: Transform): Polygon {
    return { ...sourcePolygon('level', rect(0, 0, 100, 100)), transform };
  }

  test('a vertex lands under the cursor and takes nothing with it', () => {
    // The bug this is here for: the frame used to be `centroid(p.points)`, so
    // moving one vertex moved the pivot and swung every other vertex by
    // `(I - scale·R)·Δcentroid` — zero until the polygon was turned or scaled,
    // and a visible smear afterwards. Erosion missed the cursor on top of that,
    // by the erosion depth, since the drag wrote a point on the un-eroded ring.
    for (const erosion of [0, 3, 8]) {
      const p = square({ ...turned, erosion });

      const before = resolve(p);
      const to = { x: before[0].x + 17, y: before[0].y - 9 };
      const after = resolve(placeVertex(p, 0, to));

      expect(after[0].x).toBeCloseTo(to.x, 9);
      expect(after[0].y).toBeCloseTo(to.y, 9);

      for (let i = 1; i < before.length; i++) {
        expect(after[i].x).toBeCloseTo(before[i].x, 9);
        expect(after[i].y).toBeCloseTo(before[i].y, 9);
      }
    }
  });

  test('a nudge turns with its polygon rather than staying put on screen', () => {
    // It is held in the polygon's own frame, so turning afterwards carries it
    // round. A nudge in world units would leave its vertex behind.
    const eroded = square({ ...EMPTY_TRANSFORM, erosion: 5 });

    const at = resolve(eroded)[0];
    const nudged = placeVertex(eroded, 0, { x: at.x + 20, y: at.y });
    const spun = { ...nudged, transform: { ...nudged.transform, rotation: Math.PI / 2 } };

    // A quarter turn about the origin sends (x, y) to (-y, x).
    const was = resolve(nudged)[0];

    expect(resolve(spun)[0].x).toBeCloseTo(-was.y, 9);
    expect(resolve(spun)[0].y).toBeCloseTo(was.x, 9);
  });

  test('with nothing eroded the drag writes the point, so erosion reads it', () => {
    // A nudge does not feed the bisectors. If an ordinary edit left one behind,
    // eroding afterwards would erode the shape as first drawn.
    const moved = placeVertex(square(EMPTY_TRANSFORM), 0, { x: -50, y: -50 });

    expect(moved.points[0]).toEqual({ x: -50, y: -50 });
    expect(moved.nudges.every(n => n.x === 0 && n.y === 0)).toBe(true);
  });
});
