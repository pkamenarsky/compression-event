import { describe, expect, test } from 'vitest';
import {
  Point,
  Ring,
  Shape,
  area,
  contains,
  decompose,
  intersect,
  isCCW,
  shapeArea,
  signedArea2,
  simplify,
  subtract,
  union,
  winding,
  xor,
} from './geometry';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function rect(x: number, y: number, w: number, h: number): Ring {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

function reversed(ring: Ring): Ring {
  return [...ring].reverse();
}

/** Rings as a canonical string, so tests can compare shapes regardless of
 * where a loop happens to start or which order the loops came out in. */
function canonical(shape: Shape): string[] {
  return shape
    .map(ring => {
      const keys = ring.map(p => `${round(p.x)},${round(p.y)}`);
      let at = 0;
      for (let i = 1; i < keys.length; i++) {
        if (keys[i] < keys[at]) at = i;
      }

      return [...keys.slice(at), ...keys.slice(0, at)].join(' ');
    })
    .sort();
}

function round(n: number): number {
  return Math.abs(n) < 1e-9 ? 0 : Math.round(n * 1e6) / 1e6;
}

/** Sample the plane and compare membership against a reference predicate. */
function sampled(shape: Shape, want: (p: Point) => boolean, box = 12, step = 0.5): void {
  for (let x = -box; x <= box; x += step) {
    for (let y = -box; y <= box; y += step) {
      const p = { x: x + 0.123, y: y + 0.077 };
      expect([p.x, p.y, contains(shape, p)]).toEqual([p.x, p.y, want(p)]);
    }
  }
}

const inRect = (x: number, y: number, w: number, h: number) => (p: Point) =>
  p.x > x && p.x < x + w && p.y > y && p.y < y + h;

// -----------------------------------------------------------------------------
// Ring arithmetic
// -----------------------------------------------------------------------------

describe('ring arithmetic', () => {
  test('signed area follows the winding', () => {
    expect(signedArea2(rect(0, 0, 2, 3))).toBe(12);
    expect(signedArea2(reversed(rect(0, 0, 2, 3)))).toBe(-12);
    expect(area(reversed(rect(0, 0, 2, 3)))).toBe(6);
    expect(isCCW(rect(0, 0, 1, 1))).toBe(true);
    expect(isCCW(reversed(rect(0, 0, 1, 1)))).toBe(false);
  });

  test('winding counts loops, and a hole cancels one', () => {
    const square = rect(0, 0, 10, 10);
    expect(winding([square], { x: 5, y: 5 })).toBe(1);
    expect(winding([square], { x: 20, y: 5 })).toBe(0);
    expect(winding([square, reversed(rect(3, 3, 4, 4))], { x: 5, y: 5 })).toBe(0);
    expect(winding([square, rect(3, 3, 4, 4)], { x: 5, y: 5 })).toBe(2);
  });

  test('shape area takes out holes', () => {
    expect(shapeArea([rect(0, 0, 10, 10), reversed(rect(2, 2, 3, 3))])).toBe(91);
  });
});

// -----------------------------------------------------------------------------
// Union
// -----------------------------------------------------------------------------

describe('union', () => {
  test('disjoint squares stay two rings', () => {
    const r = union([rect(0, 0, 2, 2)], [rect(5, 5, 2, 2)]);

    expect(r).toHaveLength(2);
    expect(shapeArea(r)).toBeCloseTo(8);
    sampled(r, p => inRect(0, 0, 2, 2)(p) || inRect(5, 5, 2, 2)(p));
  });

  test('overlapping squares merge into one ring', () => {
    const r = union([rect(0, 0, 4, 4)], [rect(2, 2, 4, 4)]);

    expect(r).toHaveLength(1);
    expect(shapeArea(r)).toBeCloseTo(28);
    expect(isCCW(r[0])).toBe(true);
    sampled(r, p => inRect(0, 0, 4, 4)(p) || inRect(2, 2, 4, 4)(p));
  });

  test('a contained square disappears into its container', () => {
    const r = union([rect(0, 0, 10, 10)], [rect(3, 3, 2, 2)]);

    expect(canonical(r)).toEqual(canonical([rect(0, 0, 10, 10)]));
  });

  test('input winding does not matter', () => {
    const cw = union([reversed(rect(0, 0, 4, 4))], [reversed(rect(2, 2, 4, 4))]);
    const ccw = union([rect(0, 0, 4, 4)], [rect(2, 2, 4, 4)]);

    expect(canonical(cw)).toEqual(canonical(ccw));
  });

  test('shared edges do not double up', () => {
    const r = union([rect(0, 0, 2, 2)], [rect(2, 0, 2, 2)]);

    expect(r).toHaveLength(1);
    expect(shapeArea(r)).toBeCloseTo(8);
    sampled(r, inRect(0, 0, 4, 2));
  });

  test('a concave L absorbs the square in its notch', () => {
    const el: Ring = [
      { x: 0, y: 0 },
      { x: 6, y: 0 },
      { x: 6, y: 2 },
      { x: 2, y: 2 },
      { x: 2, y: 6 },
      { x: 0, y: 6 },
    ];

    const r = union([el], [rect(2, 2, 4, 4)]);

    expect(r).toHaveLength(1);
    expect(shapeArea(r)).toBeCloseTo(36);
    sampled(r, inRect(0, 0, 6, 6));
  });

  test('a ring closed by a bridge leaves the hole alone', () => {
    const donut = [rect(0, 0, 10, 10), reversed(rect(3, 3, 4, 4))];
    const r = union(donut, [rect(11, 11, 1, 1)]);

    expect(shapeArea(r)).toBeCloseTo(85);
    sampled(r, p => (inRect(0, 0, 10, 10)(p) && !inRect(3, 3, 4, 4)(p)) || inRect(11, 11, 1, 1)(p));
  });
});

// -----------------------------------------------------------------------------
// Subtraction
// -----------------------------------------------------------------------------

describe('subtract', () => {
  test('a bite out of a corner', () => {
    const r = subtract([rect(0, 0, 4, 4)], [rect(2, 2, 4, 4)]);

    expect(r).toHaveLength(1);
    expect(shapeArea(r)).toBeCloseTo(12);
    sampled(r, p => inRect(0, 0, 4, 4)(p) && !inRect(2, 2, 4, 4)(p));
  });

  test('a hole punched in the middle comes back wound the other way', () => {
    const r = subtract([rect(0, 0, 10, 10)], [rect(3, 3, 4, 4)]);

    expect(r).toHaveLength(2);
    expect(shapeArea(r)).toBeCloseTo(84);

    const outer = r.find(ring => area(ring) > 50)!;
    const hole = r.find(ring => area(ring) < 50)!;

    expect(isCCW(outer)).toBe(true);
    expect(isCCW(hole)).toBe(false);
    sampled(r, p => inRect(0, 0, 10, 10)(p) && !inRect(3, 3, 4, 4)(p));
  });

  test('a cut clean through splits the shape in two', () => {
    const r = subtract([rect(0, 0, 10, 4)], [rect(4, -1, 2, 6)]);

    expect(r).toHaveLength(2);
    expect(shapeArea(r)).toBeCloseTo(32);
    sampled(r, p => inRect(0, 0, 10, 4)(p) && !inRect(4, -1, 2, 6)(p));
  });

  test('subtracting everything leaves nothing', () => {
    expect(subtract([rect(2, 2, 3, 3)], [rect(0, 0, 10, 10)])).toEqual([]);
    expect(subtract([rect(0, 0, 4, 4)], [rect(0, 0, 4, 4)])).toEqual([]);
  });

  test('subtracting a disjoint shape changes nothing', () => {
    const r = subtract([rect(0, 0, 4, 4)], [rect(9, 9, 2, 2)]);

    expect(canonical(r)).toEqual(canonical([rect(0, 0, 4, 4)]));
  });

  test('a shape that only touches along an edge takes nothing away', () => {
    const r = subtract([rect(0, 0, 4, 4)], [rect(4, 0, 4, 4)]);

    expect(shapeArea(r)).toBeCloseTo(16);
    sampled(r, inRect(0, 0, 4, 4));
  });

  test('subtracting from a concave shape', () => {
    const el: Ring = [
      { x: 0, y: 0 },
      { x: 8, y: 0 },
      { x: 8, y: 3 },
      { x: 3, y: 3 },
      { x: 3, y: 8 },
      { x: 0, y: 8 },
    ];

    const r = subtract([el], [rect(-1, -1, 2, 20)]);

    expect(shapeArea(r)).toBeCloseTo(8 * 3 + 3 * 5 - (1 * 8 + 0));
    sampled(r, p => contains([el], p) && !inRect(-1, -1, 2, 20)(p));
  });

  test('the hole of a donut can be widened', () => {
    const donut = [rect(0, 0, 10, 10), reversed(rect(3, 3, 4, 4))];
    const r = subtract(donut, [rect(2, 2, 6, 6)]);

    expect(shapeArea(r)).toBeCloseTo(64);
    sampled(r, p => inRect(0, 0, 10, 10)(p) && !inRect(2, 2, 6, 6)(p));
  });
});

// -----------------------------------------------------------------------------
// Intersection and xor
// -----------------------------------------------------------------------------

describe('intersect', () => {
  test('the overlap of two squares', () => {
    const r = intersect([rect(0, 0, 4, 4)], [rect(2, 2, 4, 4)]);

    expect(canonical(r)).toEqual(canonical([rect(2, 2, 2, 2)]));
  });

  test('disjoint squares intersect in nothing', () => {
    expect(intersect([rect(0, 0, 2, 2)], [rect(5, 5, 2, 2)])).toEqual([]);
  });

  test('a cross meets a bar in two pieces', () => {
    const cross: Shape = [rect(0, -1, 10, 2)];
    const bars: Shape = [rect(1, -5, 2, 10), rect(6, -5, 2, 10)];
    const r = intersect(cross, bars);

    expect(r).toHaveLength(2);
    expect(shapeArea(r)).toBeCloseTo(8);
  });
});

describe('xor', () => {
  test('the symmetric difference of two squares', () => {
    const r = xor([rect(0, 0, 4, 4)], [rect(2, 2, 4, 4)]);

    expect(shapeArea(r)).toBeCloseTo(24);
    sampled(r, p => inRect(0, 0, 4, 4)(p) !== inRect(2, 2, 4, 4)(p));
  });
});

// -----------------------------------------------------------------------------
// Self-intersection
// -----------------------------------------------------------------------------

describe('simplify', () => {
  test('a shape that is already simple survives unchanged', () => {
    expect(canonical(simplify([rect(0, 0, 4, 4)]))).toEqual(canonical([rect(0, 0, 4, 4)]));
  });

  test('a clockwise ring comes back counter-clockwise', () => {
    const r = simplify([reversed(rect(0, 0, 4, 4))]);

    expect(r).toHaveLength(1);
    expect(isCCW(r[0])).toBe(true);
    expect(canonical(r)).toEqual(canonical([rect(0, 0, 4, 4)]));
  });

  test('a bowtie becomes two triangles', () => {
    const bowtie: Ring = [
      { x: 0, y: 0 },
      { x: 4, y: 4 },
      { x: 4, y: 0 },
      { x: 0, y: 4 },
    ];

    const r = decompose(bowtie);

    expect(r).toHaveLength(2);
    expect(shapeArea(r)).toBeCloseTo(8);

    for (const ring of r) {
      expect(ring).toHaveLength(3);
      expect(isCCW(ring)).toBe(true);
    }

    sampled(r, p => {
      const t = Math.abs(p.x - 2);

      return p.y > 2 - t && p.y < 2 + t && p.x > 0 && p.x < 4;
    });
  });

  test('a doubled-back loop keeps the area it covers once', () => {
    // A square whose top edge dips down and back up, crossing its own side.
    const spiky: Ring = [
      { x: 0, y: 0 },
      { x: 6, y: 0 },
      { x: 6, y: 6 },
      { x: 3, y: -3 },
      { x: 0, y: 6 },
    ];

    const r = simplify([spiky]);

    expect(r.length).toBeGreaterThan(0);
    sampled(r, p => contains([spiky], p));
  });

  test('two overlapping loops in one shape merge under the nonzero rule', () => {
    const r = simplify([rect(0, 0, 4, 4), rect(2, 2, 4, 4)]);

    expect(r).toHaveLength(1);
    expect(shapeArea(r)).toBeCloseTo(28);
    expect(canonical(r)).toEqual(canonical(union([rect(0, 0, 4, 4)], [rect(2, 2, 4, 4)])));
  });

  test('opposed overlapping loops leave a hole, not an overlap', () => {
    const r = simplify([rect(0, 0, 10, 10), reversed(rect(3, 3, 4, 4))]);

    expect(shapeArea(r)).toBeCloseTo(84);
    sampled(r, p => inRect(0, 0, 10, 10)(p) && !inRect(3, 3, 4, 4)(p));
  });

  test('a self-intersecting shape can then be used in a boolean', () => {
    const bowtie: Ring = [
      { x: 0, y: 0 },
      { x: 4, y: 4 },
      { x: 4, y: 0 },
      { x: 0, y: 4 },
    ];

    const r = subtract(simplify([bowtie]), [rect(-1, 2, 10, 10)]);

    expect(shapeArea(r)).toBeCloseTo(4);
    sampled(r, p => contains(simplify([bowtie]), p) && !inRect(-1, 2, 10, 10)(p));
  });

  test('a five-pointed star keeps only its outline', () => {
    const star: Ring = [];
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + (i * 4 * Math.PI) / 5;
      star.push({ x: Math.cos(a) * 5, y: Math.sin(a) * 5 });
    }

    const r = simplify([star]);

    expect(r).toHaveLength(1);
    expect(r[0]).toHaveLength(10);
    expect(isCCW(r[0])).toBe(true);
    // Ten triangles between circumradius 5 and the inradius of the points —
    // strictly less than the shoelace area of the crossing loop, which counts
    // the pentagon in the middle twice.
    const deg = Math.PI / 180;
    const inner = 5 * Math.sin(18 * deg) / Math.sin(126 * deg);

    expect(shapeArea(r)).toBeCloseTo(10 * 0.5 * 5 * inner * Math.sin(36 * deg), 6);
    expect(shapeArea(r)).toBeLessThan(area(star));
    sampled(r, p => contains([star], p), 6, 0.25);
  });
});

// -----------------------------------------------------------------------------
// Degenerate input
// -----------------------------------------------------------------------------

describe('degenerate input', () => {
  test('empty operands', () => {
    expect(union([], [])).toEqual([]);
    expect(union([], [rect(0, 0, 2, 2)])).toHaveLength(1);
    expect(subtract([], [rect(0, 0, 2, 2)])).toEqual([]);
    expect(intersect([], [rect(0, 0, 2, 2)])).toEqual([]);
  });

  test('a zero-area ring contributes nothing', () => {
    const sliver: Ring = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 0 }, { x: 4, y: 0 }];

    expect(union([sliver], [])).toEqual([]);
    expect(canonical(union([rect(0, 0, 2, 2)], [sliver]))).toEqual(canonical([rect(0, 0, 2, 2)]));
  });

  test('repeated points are dropped', () => {
    const dup: Ring = [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
    ];

    expect(canonical(simplify([dup]))).toEqual(canonical([rect(0, 0, 4, 4)]));
  });

  test('coordinates far from the origin behave the same as at it', () => {
    const at = (x: number, y: number): Shape =>
      [rect(x, y, 4, 4)];

    const near = shapeArea(union(at(0, 0), at(2, 2)));
    const far = shapeArea(union(at(100000, 100000), at(100002, 100002)));

    expect(far).toBeCloseTo(near, 6);
  });
});
