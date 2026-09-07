import { describe, expect, test } from 'vitest';

import { Span, extrude, fan, looped, nesting } from './walls';
import { Point } from './world';

/**
 * What counts as a corner is not decided here any more — it rides in on the
 * run, out of `cornering` in the editor's `geometry.ts`, which is the only
 * place that sees a polygon and its neighbours at once. Those tests moved
 * there with it.
 */
describe('the wall topology', () => {
  test('one run of n points is n - 1 walls and n verticals', () => {
    const spans: Span[] = [{ first: 0, count: 4 }];
    const out = extrude(spans);

    // Two triangles a wall, and four line vertices a wall plus two a vertical.
    expect(out.index.length).toEqual(3 * 6);
    expect(out.lineVertical.filter(v => v === 1).length).toEqual(4 * 2);
  });

  test('two runs are extruded apart, never across the gap between them', () => {
    const one = extrude([{ first: 0, count: 3 }, { first: 3, count: 3 }]);
    const two = extrude([{ first: 0, count: 6 }]);

    // The joined-up version has one wall more: the one that would bridge them.
    expect(one.index.length).toEqual(2 * 2 * 6);
    expect(two.index.length).toEqual(5 * 6);
  });
});

/**
 * A floor is a set now, so it can have a hole in it, and a hole is the one
 * thing a triangulator cannot work out for itself: told a ring, it fills it,
 * and a hole filled as an outline in its own right fills exactly the part that
 * is supposed to be gone. `nesting` decides which is which and `fan` is told.
 *
 * By area, because which diagonals it takes is its own business and the only
 * thing that has to be true is what ends up covered.
 */
describe('the floor topology', () => {
  const at = (pts: readonly Point[]) => (i: number) => pts[i];

  const covered = (face: Int32Array, pts: readonly Point[]): number => {
    let out = 0;

    for (let i = 0; i < face.length; i += 3) {
      const a = pts[face[i]], b = pts[face[i + 1]], c = pts[face[i + 2]];

      out += Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
    }

    return out;
  };

  const square = (x: number, y: number, w: number): Point[] =>
    [{ x, y }, { x: x + w, y }, { x: x + w, y: y + w }, { x, y: y + w }];

  test('a ring with a hole fills the ring less the hole', () => {
    // The hole wound against the outline, which is how an arrangement hands
    // one back and what `nesting` reads.
    const pts = [...square(0, 0, 10), ...square(3, 3, 4).reverse()];
    const face = fan([{ outer: [0, 1, 2, 3], holes: [[4, 5, 6, 7]] }], at(pts));

    expect(covered(face, pts)).toBeCloseTo(100 - 16, 9);
  });

  test('and the same rings unsorted fill the whole ring, which is the bug', () => {
    // What filling a hole as an outline of its own comes to, so that the line
    // above is measuring something. The hole is covered twice over.
    const pts = [...square(0, 0, 10), ...square(3, 3, 4).reverse()];
    const face = fan(
      [{ outer: [0, 1, 2, 3], holes: [] }, { outer: [4, 5, 6, 7], holes: [] }],
      at(pts),
    );

    expect(covered(face, pts)).toBeCloseTo(100 + 16, 9);
  });

  test('nesting gives each hole the tightest outline that contains it', () => {
    // A room with a courtyard, an island standing in the courtyard, and a well
    // sunk in the island. The well is inside the room's outline too, and it
    // belongs to the island: tightest wins, or the fill puts the courtyard
    // back and takes the island away.
    const pts = [
      ...square(0, 0, 20),
      ...square(2, 2, 16).reverse(),
      ...square(5, 5, 6),
      ...square(6, 6, 4).reverse(),
    ];

    const rings = [pts.slice(0, 4), pts.slice(4, 8), pts.slice(8, 12), pts.slice(12, 16)];

    expect(nesting(rings)).toEqual([
      { outer: 0, holes: [1] },
      { outer: 2, holes: [3] },
    ]);
  });

  test('open runs are stitched back into the ring they came off', () => {
    // Two polygons' shares of one boundary, each an open arc, meeting at two
    // junctions — which is what a span hands over and what a fill cannot use
    // until it is a loop again.
    const pts = [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 },
      { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 0 },
    ];

    const rings = looped([[0, 1, 2], [3, 4, 5]], at(pts), 1e-6);

    expect(rings).toEqual([[0, 1, 3, 4]]);
  });

  test('and a run that closes on itself is already a ring', () => {
    const pts = [...square(0, 0, 10), { x: 0, y: 0 }];
    const rings = looped([[0, 1, 2, 3, 4]], at(pts), 1e-6);

    expect(rings).toEqual([[0, 1, 2, 3]]);
  });

  test('anything that does not close is dropped rather than filled', () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];

    expect(looped([[0, 1, 2]], at(pts), 1e-6)).toEqual([]);
  });
});
