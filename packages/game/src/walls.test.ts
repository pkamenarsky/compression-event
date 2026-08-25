import { describe, expect, test } from 'vitest';

import { corners, turns } from './walls';

describe('what counts as a corner', () => {
  test('a point the boundary runs straight through is not one', () => {
    expect(turns({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 })).toBe(false);
    expect(turns({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 })).toBe(true);
  });

  test('the ends of a run nothing meets get the benefit of the doubt', () => {
    // The boundary carries on into a run that is not in hand, and nothing here
    // says it does not turn there.
    const run = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }];

    expect(corners([run])).toEqual([[true, false, true]]);
  });

  test('two runs meeting in a straight stretch stand no vertical', () => {
    // The case out of world-2026-08-25T17-46-44Z: two polygons abutting, so
    // the union's boundary is cut where they meet and carries straight on. A
    // vertical there is a line down the middle of a flat wall.
    const one = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }];
    const two = [{ x: 2, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 1 }];

    expect(corners([one, two])).toEqual([
      [true, false, false],
      [false, true, true],
    ]);
  });

  test('a T where three runs meet is a corner in all of them', () => {
    const one = [{ x: 0, y: 0 }, { x: 2, y: 0 }];
    const two = [{ x: 2, y: 0 }, { x: 4, y: 0 }];
    const three = [{ x: 2, y: 0 }, { x: 2, y: 2 }];

    expect(corners([one, two, three]).map(r => r[r.length - 1] || r[0]))
      .toEqual([true, true, true]);
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

    expect(corners([ring])).toEqual([[false, true, true, true, true, false]]);
  });

  test('a ring cut at a real corner keeps its vertical', () => {
    const ring = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
      { x: 0, y: 2 },
      { x: 0, y: 0 },
    ];

    const at = corners([ring])[0];

    expect(at[0]).toBe(true);
    expect(at[at.length - 1]).toBe(true);
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
    expect(corners([ring])).toEqual([[false, true, true, true, false, true, false]]);
  });
});
