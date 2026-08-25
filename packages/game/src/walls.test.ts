import { describe, expect, test } from 'vitest';

import { corner, turns } from './walls';

describe('what counts as a corner', () => {
  test('a point the boundary runs straight through is not one', () => {
    expect(turns({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 })).toBe(false);
    expect(turns({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 })).toBe(true);
  });

  test('the ends of an open run get the benefit of the doubt', () => {
    // The boundary carries on into a run that is not in hand, and nothing here
    // says it does not turn there.
    const run = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }];

    expect(corner(run, 0)).toBe(true);
    expect(corner(run, 2)).toBe(true);
    expect(corner(run, 1)).toBe(false);
  });

  test('a run that closes on itself has no open end', () => {
    // `boundaryRuns` gives a whole ring back as a run whose first point is
    // repeated at the last. Cut anywhere along a flat wall — which is where a
    // dilated pillar's ring is generally cut — the join is not a corner, and
    // both copies of it have to say so.
    const ring = [
      { x: 1, y: 0 },   // mid-edge, where the ring was cut open
      { x: 2, y: 0 },
      { x: 2, y: 2 },
      { x: 0, y: 2 },
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ];

    expect(corner(ring, 0)).toBe(false);
    expect(corner(ring, ring.length - 1)).toBe(false);

    // And the real corners still stand.
    expect([1, 2, 3, 4].map(i => corner(ring, i))).toEqual([true, true, true, true]);
  });

  test('a ring cut at a real corner keeps its vertical', () => {
    const ring = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
      { x: 0, y: 2 },
      { x: 0, y: 0 },
    ];

    expect(corner(ring, 0)).toBe(true);
    expect(corner(ring, ring.length - 1)).toBe(true);
  });

  test('the pillar out of world-2026-08-25T10-05-38Z', () => {
    // The reported case, to the digit: a dilated solid inside a group comes
    // back as a whole ring cut at a point in the middle of its top edge, plus
    // a collinear point the dilation left on the left edge.
    const ring = [
      { x: 22.935267857142854, y: -96.546875 },
      { x: 63.453125, y: -96.546875 },
      { x: 63.453125, y: -223.453125 },
      { x: -95.453125, y: -223.453125 },
      { x: -95.453125, y: -174.16145833333331 },
      { x: -95.453125, y: -96.546875 },
      { x: 22.935267857142854, y: -96.546875 },
    ];

    // Two verticals stood where the ring was cut, and one part way down the
    // left wall. None of the three is a corner.
    expect(ring.map((_, i) => corner(ring, i)))
      .toEqual([false, true, true, true, false, true, false]);
  });
});
