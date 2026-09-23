// -----------------------------------------------------------------------------
// The erosion, as an effect
//
// Two things to hold it to, and they pull opposite ways. It has to draw exactly
// what `erode` draws — this is the existing offset wrapped, not a second one,
// and a wrapper that moved the outline by a hair would have replaced the thing
// it was meant to carry names through. And the names have to be the ones the
// construction gives: a corner that survives is itself, a corner pushed inwards
// is still itself, and a corner the erosion *made* is `born` of the two walls
// whose bands crossed to make it.
//
// The second is what the whole design turns on, so the tests for it are the
// cases where a corner is genuinely made and genuinely lost: a notch closing
// and taking the room with it into two rooms, and a shape eroded past its own
// middle.
// -----------------------------------------------------------------------------

import { describe, expect, test } from 'vitest';
import { Point } from '@ce/game/world';
import { OpSubtract, Shape, erode, shapeArea, simplify } from './geometry';
import { eroding } from './effect';
import { Drawn, combineIdentified, identify, shows } from './ids';

function rect(x: number, y: number, w: number, h: number): Point[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

const drawn = (shape: Shape, member: number): Drawn => ({ shape, ids: identify(shape, member) });
const names = (it: Drawn) => it.ids.map(ring => ring.map(shows));

/** A room with a slot cut into it from above, and the slot narrow enough that
 * an erosion closes it — which is where a corner is born and a ring dies. */
const notched = (): Drawn => combineIdentified(
  drawn([rect(0, 0, 200, 120)], 0),
  drawn([rect(80, 40, 40, 100)], 1),
  OpSubtract,
);

describe('it draws what the offset draws', () => {
  const cases: [string, Shape, number][] = [
    ['a room', [rect(0, 0, 200, 100)], 10],
    ['a room, grown', [rect(0, 0, 200, 100)], -10],
    ['a room with a hole in it', [rect(0, 0, 200, 200), rect(160, 60, 20, 80).reverse()], 8],
    ['a notch, open', notched().shape, 5],
    ['a notch, closed', notched().shape, 25],
    ['eroded away altogether', [rect(0, 0, 40, 40)], 30],
  ];

  for (const [what, shape, depth] of cases) {
    test(what, () => {
      const was = erode(simplify(shape), depth);
      const now = eroding(depth)(drawn(shape, 0));

      expect(now.shape.map(ring => ring.map(p => [p.x, p.y]))).toEqual(
        was.map(ring => ring.map(p => [p.x, p.y])),
      );
      expect(shapeArea(now.shape)).toBe(shapeArea(was));
    });
  }
});

describe('and names what it draws', () => {
  test('every point has exactly one name', () => {
    const r = eroding(25)(notched());

    expect(r.ids.length).toBe(r.shape.length);
    r.shape.forEach((ring, i) => expect(r.ids[i].length).toBe(ring.length));
  });

  test('a corner that only moves is the corner it was', () => {
    const r = eroding(10)(drawn([rect(0, 0, 200, 100)], 0));

    expect(names(r)).toEqual([['0.0', '0.1', '0.2', '0.3']]);
    expect(r.shape[0].map(p => [p.x, p.y])).toEqual([[10, 10], [190, 10], [190, 90], [10, 90]]);
  });

  test('and so is one that turns a concave corner', () => {
    // An L: six corners in and six out, the erosion having consumed none of
    // them and made none.
    const l: Shape = [[
      { x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 60 },
      { x: 80, y: 60 }, { x: 80, y: 160 }, { x: 0, y: 160 },
    ]];

    expect(names(eroding(12)(drawn(l, 1)))).toEqual([['1.0', '1.1', '1.2', '1.3', '1.4', '1.5']]);
  });

  test('a corner the erosion makes is born of the two walls that made it', () => {
    const it = notched();

    // Open, the notch is a notch and nothing is born of the erosion: the two
    // crossings are the ones the subtraction made, and they are the names the
    // shape came in with.
    expect(names(eroding(5)(it))).toEqual(names(it));

    // Closed, the room is two rooms, and each of the corners where they parted
    // knows which walls closed on each other to part them.
    expect(names(eroding(25)(it))).toEqual([
      ['((0.2×1.1)×0.0)', '0.1', '0.2', '(0.2×1.1)'],
      ['0.0', '(0.0×1.0)', '(0.2×1.3)', '0.3'],
    ]);
  });

  test('a name is of the construction, so the geometry may move', () => {
    const at = (dx: number, dy: number): Shape => notched().shape.map(
      ring => ring.map(p => ({ x: p.x + dx, y: p.y + dy })),
    );
    const said = (dx: number, dy: number) =>
      names(eroding(25)({ shape: at(dx, dy), ids: notched().ids }));

    expect(said(600, -250)).toEqual(said(0, 0));
  });

  test('a second erosion names off the first, as deep as it goes', () => {
    const once = eroding(12)(notched());
    const twice = eroding(13)(once);

    // 12 then 13 closes the same notch 25 did, and says so in the same names —
    // the second erosion having found the first's corners already named.
    expect(names(twice).flat().some(s => s.includes('×'))).toBe(true);
    expect(names(twice).flat()).toContain('(0.0×1.0)');
  });

  test('a growing erosion names its points too', () => {
    const r = eroding(-10)(drawn([rect(0, 0, 200, 100)], 0));

    expect(names(r)).toEqual([['0.0', '0.1', '0.2', '0.3']]);
    expect(r.shape[0].map(p => [p.x, p.y])).toEqual([[-10, -10], [210, -10], [210, 110], [-10, 110]]);
  });

  test('a shape eroded away has nothing to name', () => {
    expect(names(eroding(30)(drawn([rect(0, 0, 40, 40)], 0)))).toEqual([]);
  });
});
