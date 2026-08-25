import { describe, expect, test } from 'vitest';

import { Span, extrude } from './walls';

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
