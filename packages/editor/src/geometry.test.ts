import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  Member,
  Op,
  OpIntersect,
  OpSubtract,
  OpUnion,
  Point,
  Ring,
  Shape,
  SourceRef,
  Tag,
  TaggedShape,
  area,
  combineTagged,
  contains,
  decompose,
  erode,
  intersect,
  isCCW,
  shapeArea,
  signedArea2,
  boundaryRuns,
  ground,
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

// -----------------------------------------------------------------------------
// Provenance
// -----------------------------------------------------------------------------

/** Where a tag says its point is, computed from the input alone. */
function reconstruct(a: Shape, b: Shape, tag: Tag): Point {
  const shape = (r: SourceRef) => (r.shape === 0 ? a : b)[r.ring];

  if (tag.kind === 'vertex') return shape(tag.at)[tag.at.index];

  const edge = (r: SourceRef): [Point, Point] => {
    const ring = shape(r);
    return [ring[r.index], ring[(r.index + 1) % ring.length]];
  };

  const [p, q] = edge(tag.a), [u, v] = edge(tag.b);
  const rx = q.x - p.x, ry = q.y - p.y;
  const sx = v.x - u.x, sy = v.y - u.y;
  const d = rx * sy - ry * sx;
  const t = ((u.x - p.x) * sy - (u.y - p.y) * sx) / d;

  return { x: p.x + rx * t, y: p.y + ry * t };
}

function tagKeys(r: TaggedShape): string[][] {
  const key = (t: Tag) => t.kind === 'vertex'
    ? `V${t.at.shape}.${t.at.ring}.${t.at.index}`
    : `X(${t.a.shape}.${t.a.ring}.${t.a.index},${t.b.shape}.${t.b.ring}.${t.b.index})`;

  return r.rings.map((_ring, i) => r.tags[i].map(key));
}

function rotated(ring: Ring, deg: number, c: Point): Ring {
  const a = deg * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a);

  return ring.map(p => ({
    x: c.x + (p.x - c.x) * cs - (p.y - c.y) * sn,
    y: c.y + (p.x - c.x) * sn + (p.y - c.y) * cs,
  }));
}

/** The room and the pillar straddling its top edge, from docs/versioning.md. */
const room = rect(0, -200, 400, 200);
const pillar = (deg: number) => rotated(rect(100, -100, 40, 200), deg, { x: 120, y: 0 });

describe('a vertex landing on a wall', () => {
  // The thing an author does all the time, and the arrangement's worst case. A
  // corner exactly on a wall has always been fine; a corner a rounding or two
  // off one was not, and the failure was not subtle — the cut called the corner
  // and the crossing it makes two points, the weld further down called them one,
  // and between those two answers a room came back as two triangles with half
  // its ground missing. See `NEARBY`.

  /** A room, and a slab whose corner sits `gap` above the room's top wall while
   * its lower edge crosses that wall at a very shallow angle. */
  function grazing(gap: number, k: number): { room: Shape, slab: Shape } {
    return {
      room: simplify([[
        { x: 0, y: -200 * k }, { x: 400 * k, y: -200 * k },
        { x: 400 * k, y: 0 }, { x: 0, y: 0 },
      ]]),
      slab: simplify([[
        { x: 200 * k, y: gap }, { x: 400 * k, y: -1 * k },
        { x: 400 * k, y: 60 * k }, { x: 200 * k, y: 60 * k },
      ]]),
    };
  }

  /** The room, less the wedge of slab below the wall. The slab's lower edge
   * crosses `y = 0` at `x0`, and the wedge is the triangle from there to the
   * room's far corner. */
  function less(gap: number, k: number): number {
    const x0 = 200 * k + 200 * k * gap / (gap + k);

    return 400 * k * 200 * k - (400 * k - x0) * k / 2;
  }

  test('is exact when it lands exactly', () => {
    for (const k of [1, 10, 100]) {
      const { room, slab } = grazing(0, k);

      expect(shapeArea(subtract(room, slab))).toBeCloseTo(less(0, k), 6);
    }
  });

  test('and is no worse for landing a hair off, at any distance or scale', () => {
    // Swept rather than sampled: the band that used to break is narrow, it sits
    // wherever the tolerances happen to put it, and nobody would have guessed
    // where. Fourteen decades of gap covers it several times over.
    let worst = 0;

    for (const k of [1, 10, 100]) {
      for (let e = -14; e <= 0; e += 0.125) {
        const gap = 10 ** e * k;
        const { room, slab } = grazing(gap, k);
        const whole = 400 * k * 200 * k;

        worst = Math.max(worst, Math.abs(shapeArea(subtract(room, slab)) - less(gap, k)) / whole);
      }
    }

    // What is left is the snapping itself, which moves a vertex by at most a few
    // `snap` and moves the answer by no more. It used to be half the room.
    expect(worst).toBeLessThan(1e-6);
  });

  test('and a corner sweeping through a wall keeps the room whole', () => {
    // The case as it was reported: a slab turning until one of its corners
    // grazes the wall, at the one angle where it does. Bisection in `provenance`
    // finds that angle; this walks across it.
    const room = rect(0, -200, 400, 200);
    const pillar = (deg: number): Ring => {
      const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);

      return rect(100, -100, 40, 200).map(p => ({
        x: 120 + (p.x - 120) * c - p.y * s,
        y: (p.x - 120) * s + p.y * c,
      }));
    };

    const want = Math.atan2(100, 20) * 180 / Math.PI;

    for (const step of [1e-9, 1e-8, 1e-7, 1e-6, 1e-5]) {
      for (let k = -60; k <= 60; k++) {
        expect(shapeArea(subtract([room], [pillar(want + k * step)]))).toBeCloseTo(76000, 3);
      }
    }
  });
});

describe('provenance', () => {
  test('every point has exactly one tag', () => {
    const r = combineTagged([rect(0, 0, 10, 10)], [rect(5, 5, 10, 10)], OpUnion);

    expect(r.tags.length).toBe(r.rings.length);
    r.rings.forEach((ring, i) => expect(r.tags[i].length).toBe(ring.length));
  });

  test('a tag reconstructs its point from the input alone', () => {
    const cases: [Shape, Shape, Op][] = [
      [[rect(0, 0, 10, 10)], [rect(5, 5, 10, 10)], OpUnion],
      [[rect(0, 0, 10, 10)], [rect(5, 5, 10, 10)], OpSubtract],
      [[rect(0, 0, 10, 10)], [rect(5, 5, 10, 10)], OpIntersect],
      [[rect(0, 0, 10, 10)], [rect(3, 3, 4, 4)], OpSubtract],
      [[rect(0, 0, 10, 10), rect(20, 0, 10, 10)], [rect(5, 5, 20, 2)], OpSubtract],
      [[room], [pillar(0)], OpSubtract],
      [[room], [pillar(37)], OpSubtract],
      [[room], [pillar(90)], OpSubtract],
    ];

    for (const [a, b, op] of cases) {
      const r = combineTagged(a, b, op);

      r.rings.forEach((ring, i) => ring.forEach((p, k) => {
        const q = reconstruct(a, b, r.tags[i][k]);
        expect([round(q.x), round(q.y)]).toEqual([round(p.x), round(p.y)]);
      }));
    }
  });

  test('tags name the input, so they survive the geometry moving', () => {
    // Sliding the second rect leaves the arrangement's topology alone, so the
    // same points are the same points however far they have travelled.
    const at = (dx: number) =>
      tagKeys(combineTagged([rect(0, 0, 10, 10)], [rect(5 + dx, 5, 10, 10)], OpUnion));

    expect(at(0)).toEqual(at(2));
    expect(at(0)).toEqual(at(-1.5));
  });

  test('the same input always gives the same tags', () => {
    const once = () => tagKeys(combineTagged([room], [pillar(37)], OpSubtract));
    expect(once()).toEqual(once());
  });

  test('a crossing is named by the two edges that make it', () => {
    // Two unit-offset rects: one crossing on each operand's edge pair.
    const r = combineTagged([rect(0, 0, 10, 10)], [rect(5, 5, 10, 10)], OpUnion);

    expect(tagKeys(r)).toEqual([[
      'V0.0.0', 'V0.0.1',
      'X(0.0.1,1.0.0)',
      'V1.0.1', 'V1.0.2', 'V1.0.3',
      'X(0.0.2,1.0.3)',
      'V0.0.3',
    ]]);
  });

  test('a pillar turning through a wall hands its crossings from edge to edge', () => {
    // The wall is cut by exactly two crossings at every angle, but not always
    // by the same two edges: each corner sweeping through the wall retires one
    // crossing and starts another.
    const crossings = (deg: number) =>
      tagKeys(combineTagged([room], [pillar(deg)], OpSubtract))[0]
        .filter(k => k.startsWith('X'))
        .sort();

    const before = ['X(0.0.2,1.0.1)', 'X(0.0.2,1.0.3)'];
    const during = ['X(0.0.2,1.0.0)', 'X(0.0.2,1.0.2)'];

    expect(crossings(0)).toEqual(before);
    expect(crossings(45)).toEqual(before);
    expect(crossings(78)).toEqual(before);
    expect(crossings(80)).toEqual(during);
    expect(crossings(90)).toEqual(during);
    expect(crossings(101)).toEqual(during);
    expect(crossings(103)).toEqual(before);
    expect(crossings(180)).toEqual(before);
  });

  test('the handoff is a real event, and bisection finds it', () => {
    // A corner of the pillar reaches the wall at atan(100/20).
    const want = Math.atan2(100, 20) * 180 / Math.PI;

    const moved = (deg: number) =>
      tagKeys(combineTagged([room], [pillar(deg)], OpSubtract))[0]
        .includes('X(0.0.2,1.0.0)');

    let lo = 45, hi = 90;
    while (hi - lo > 1e-9) {
      const mid = (lo + hi) / 2;
      if (moved(mid)) hi = mid;
      else lo = mid;
    }

    // The handoff has moved, by design and by exactly the designed amount. A
    // corner within a few `snap` of the wall is read as touching it rather than
    // crossing it — see `NEARBY` — so the crossing this bisects for holds off
    // until the corner is that much clear of the wall. The corner swings on a
    // radius of hypot(100, 20) and the scene is about 600 across, which puts the
    // shift a shade over a millionth of a degree: measured here rather than
    // waved at, so that widening the tolerance cannot quietly widen this too.
    const slack = 3 * 600e-9 / Math.hypot(100, 20) * 180 / Math.PI;

    expect(Math.abs(lo - want)).toBeLessThan(slack * 1.5);
  });

  test('comparing only the endpoints invents a swap that never happens', () => {
    // Half a turn leaves the pillar looking identical and the tag set
    // unchanged, but with the two crossings on opposite sides of the hole — the
    // ordering conflict docs/versioning.md is built around. The path between
    // them contains no swap at all: the tags die and are reborn twice.
    const ring = (deg: number) =>
      tagKeys(combineTagged([room], [pillar(deg)], OpSubtract))[0]
        .filter(k => k.startsWith('X'));

    expect(ring(0)).toEqual(['X(0.0.2,1.0.1)', 'X(0.0.2,1.0.3)']);
    expect(ring(180)).toEqual(['X(0.0.2,1.0.3)', 'X(0.0.2,1.0.1)']);

    const survives = (k: string) =>
      [0, 45, 78, 90, 101, 135, 180].every(d => ring(d).includes(k));

    expect(survives('X(0.0.2,1.0.1)')).toBe(false);
    expect(survives('X(0.0.2,1.0.3)')).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Erosion
// -----------------------------------------------------------------------------

describe('erode', () => {
  test('every edge stays exactly parallel to where it started', () => {
    // The one thing a true offset promises, and the thing freezing bisectors at
    // a clamp could never keep: a 100 square eroded by 10 is an 80 square, not
    // an 80-ish one.
    expect(shapeArea(erode(simplify([rect(0, 0, 100, 100)]), 10))).toBeCloseTo(6400, 9);
  });

  test('a room eroded past its own middle is gone', () => {
    // Both axes collapse at once, which under the old per-vertex walk turned
    // the winding over twice and left a smaller square of ground standing.
    expect(erode(simplify([rect(0, 0, 100, 100)]), 60)).toEqual([]);
  });

  test('a strip closes from its short side', () => {
    expect(erode(simplify([rect(0, 0, 300, 100)]), 60)).toEqual([]);
  });

  test('a room with a neck splits in two', () => {
    // The author wants exactly this — erode a room until it becomes two rooms
    // and trap the player in one — so the erosion goes through the split rather
    // than stopping at it. Nothing needs a name on the far side: the pieces are
    // in the projection, and a projection has no handles.
    const dumbbell: Ring = [
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }, { x: 200, y: 80 },
      { x: 200, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 200 }, { x: 200, y: 200 },
      { x: 200, y: 120 }, { x: 100, y: 120 }, { x: 100, y: 200 }, { x: 0, y: 200 },
    ];

    expect(erode(simplify([dumbbell]), 10).length).toBe(1);
    expect(erode(simplify([dumbbell]), 25).length).toBe(2);
  });

  test('a hole opens up as the material around it shrinks', () => {
    // The hole is wound against its container, and left is the material side
    // for both, so the same offset moves one in and the other out with no
    // special case for it.
    const withHole: Shape = [
      rect(0, 0, 200, 200),
      [...rect(50, 50, 100, 100)].reverse(),
    ];

    expect(shapeArea(erode(simplify(withHole), 10))).toBeCloseTo(180 * 180 - 120 * 120, 6);
  });

  test('a negative depth grows the shape instead', () => {
    expect(shapeArea(erode(simplify([rect(0, 0, 100, 100)]), -10))).toBeCloseTo(120 * 120, 6);
  });

  test('depths do not accumulate', () => {
    // Eroding by 3 and then by 4 is not eroding by 7 — an event may fall between
    // them — which is why a version states its own depth rather than adding one.
    const once = shapeArea(erode(simplify([rect(0, 0, 100, 100)]), 7));
    const twice = shapeArea(erode(erode(simplify([rect(0, 0, 100, 100)]), 3), 4));

    expect(once).toBeCloseTo(86 * 86, 6);
    expect(twice).toBeCloseTo(86 * 86, 6);
  });

  test('a reflex corner keeps its mitre', () => {
    // An L eroded by 10: every edge in by 10, and the inner corner goes where
    // its two moved lines meet rather than being rounded off or cut square.
    const ell: Ring = [
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 40 },
      { x: 40, y: 40 }, { x: 40, y: 100 }, { x: 0, y: 100 },
    ];

    const shape = erode(simplify([ell]), 10);

    expect(shape.length).toBe(1);
    expect(shape[0].some(p => Math.abs(p.x - 30) < 1e-6 && Math.abs(p.y - 30) < 1e-6))
      .toBe(true);

    // The two arms, each in by 10 on every side: 80x20 and 20x60, meeting at
    // that corner. The mitre is what makes the sum exact rather than close.
    expect(shapeArea(shape)).toBeCloseTo(80 * 20 + 20 * 60, 6);
  });

  test('a corner that has almost stopped turning loses no ground', () => {
    // A wall folding flat over a span passes through every shallow angle on its
    // way, and two edges meeting at one cross their offsets at that same shallow
    // angle. The stub each leaves past the crossing lies nearer to the other
    // edge than the step `arranged` takes to read which side is which, so both
    // readings used to land in the same face, the stub was kept as a boundary,
    // and the chain ran into a dead end and closed the ring across the shape —
    // two rings and a triangle of missing ground where there was one room.
    //
    // Swept rather than sampled, because the angle it went wrong at was not one
    // anybody would have thought to write down.
    // Two corners of a notch sliding onto the straight line between their
    // neighbours, which is what `spanning` has them do over the last span of the
    // level this came out of.
    const mix = (a: number, b: number, u: number): number => a + (b - a) * u;

    const folding = (u: number): Ring => [
      { x: 544, y: -64 }, { x: 544, y: 32 }, { x: 160, y: 32 },
      { x: mix(160, 160 - 64 / 3, u), y: mix(64, 32 - 96 / 3, u) },
      { x: mix(96, 160 - 128 / 3, u), y: mix(64, 32 - 192 / 3, u) },
      { x: 96, y: -64 },
    ];

    let last: number | null = null;

    for (let k = 0; k <= 2000; k++) {
      const shape = erode(simplify([folding(k / 2000)]), -16.1953125);
      const area = shapeArea(shape);

      expect(shape.length).toBe(1);

      // The fold takes ground away steadily, a few units of area at a time. The
      // triangle that used to go missing is three and a half thousand.
      if (last !== null) expect(Math.abs(area - last)).toBeLessThan(100);

      last = area;
    }
  });
});

// -----------------------------------------------------------------------------
// The morph property
//
// What the bake promises the vertex shader: inside a stretch where the
// arrangement has not changed, the tags taken once at the stretch's start are
// enough to rebuild the whole result at any moment inside it, from the input
// alone. That is the shader's entire job, so it is the property worth holding.
// -----------------------------------------------------------------------------

interface Tr {
  tx: number
  ty: number
  rot: number
  scale: number
  erosion: number
}

/** Every vertex along its bisector, scaled so each edge stays parallel to
 * where it was. Bisectors come off the base ring and never move: the editor's
 * erode, per-vertex and linear in depth. */
function eroded(ring: Ring, d: number): Ring {
  const n = ring.length;

  const normal = (i: number): Point => {
    const a = ring[i], b = ring[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y;
    const l = Math.hypot(dx, dy);

    return { x: dy / l, y: -dx / l };
  };

  return ring.map((p, i) => {
    const m = normal((i - 1 + n) % n), q = normal(i);
    const k = 1 + m.x * q.x + m.y * q.y;

    return { x: p.x + d * (m.x + q.x) / k, y: p.y + d * (m.y + q.y) / k };
  });
}

/** `p(t) = apply(transform, local + erosion * bisector)`, straight out of the
 * bake section of docs/versioning.md. */
function place(base: Ring, tr: Tr): Ring {
  const a = tr.rot * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);

  return eroded(base, tr.erosion).map(p => ({
    x: tr.tx + tr.scale * (p.x * c - p.y * s),
    y: tr.ty + tr.scale * (p.x * s + p.y * c),
  }));
}

/** Components, not positions: rotation turns rather than cutting the corner. */
function lerpTr(u: Tr, v: Tr, t: number): Tr {
  const at = (x: number, y: number) => x + (y - x) * t;

  return {
    tx: at(u.tx, v.tx),
    ty: at(u.ty, v.ty),
    rot: at(u.rot, v.rot),
    scale: at(u.scale, v.scale),
    erosion: at(u.erosion, v.erosion),
  };
}

const bases: Ring[] = [
  rect(-45, -30, 90, 60),
  [{ x: -40, y: -40 }, { x: 40, y: -40 }, { x: 40, y: -10 }, { x: -10, y: -10 },
   { x: -10, y: 40 }, { x: -40, y: 40 }],
  [{ x: -45, y: -40 }, { x: 45, y: -40 }, { x: 45, y: 40 }, { x: 15, y: 40 },
   { x: 15, y: -10 }, { x: -15, y: -10 }, { x: -15, y: 40 }, { x: -45, y: 40 }],
  [{ x: -15, y: -45 }, { x: 15, y: -45 }, { x: 15, y: -15 }, { x: 45, y: -15 },
   { x: 45, y: 15 }, { x: 15, y: 15 }, { x: 15, y: 45 }, { x: -15, y: 45 },
   { x: -15, y: 15 }, { x: -45, y: 15 }, { x: -45, y: -15 }, { x: -15, y: -15 }],
];

const arbTr = fc.record({
  tx: fc.double({ min: -60, max: 60, noNaN: true }),
  ty: fc.double({ min: -60, max: 60, noNaN: true }),
  rot: fc.double({ min: -180, max: 180, noNaN: true }),
  scale: fc.double({ min: 0.6, max: 1.6, noNaN: true }),
  erosion: fc.double({ min: -6, max: 6, noNaN: true }),
});

const arbBase = fc.constantFrom(...bases);
const arbOp = fc.constantFrom(OpUnion, OpSubtract, OpIntersect);

describe('morph', () => {
  test('tags rebuild the result anywhere inside a stable stretch', () => {
    let checked = 0;

    fc.assert(
      fc.property(
        arbBase,
        arbBase,
        arbOp,
        arbTr,
        arbTr,
        fc.double({ min: 0, max: 1, noNaN: true }),
        (baseA, baseB, op, u, v, t) => {
          const a: Shape = [baseA];
          const at = (tr: Tr): Shape => [place(baseB, tr)];

          const start = combineTagged(a, at(u), op);
          const tr = lerpTr(u, v, t);
          const now = combineTagged(a, at(tr), op);

          // Anywhere the arrangement changed is an event, and the bake would
          // have ended the stretch there rather than spanning it.
          fc.pre(
            JSON.stringify(tagKeys(start)) === JSON.stringify(tagKeys(now)),
          );

          const src = at(tr);

          start.tags.forEach((ring, i) => ring.forEach((tag, k) => {
            const p = reconstruct(a, src, tag);
            const q = now.rings[i][k];

            expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeLessThan(1e-6);
          }));

          checked++;

          return true;
        },
      ),
      { numRuns: 600 },
    );

    // Guard against the precondition quietly eating the whole run.
    expect(checked).toBeGreaterThan(60);
  });

  test('tags name combinatorics, so moving the whole scene leaves them alone', () => {
    fc.assert(
      fc.property(arbBase, arbBase, arbOp, arbTr, arbTr, (baseA, baseB, op, b, move) => {
        const rigid: Tr = { ...move, scale: 1, erosion: 0 };

        const plain = combineTagged([baseA], [place(baseB, b)], op);

        const shifted = combineTagged(
          [place(baseA, rigid)],
          [place(place(baseB, b), rigid)],
          op,
        );

        expect(tagKeys(shifted)).toEqual(tagKeys(plain));

        return true;
      }),
      { numRuns: 300 },
    );
  });
});

// -----------------------------------------------------------------------------
// boundaryRuns
// -----------------------------------------------------------------------------

const member = (id: number, kind: 'level' | 'solid', r: Ring): Member =>
  ({ id, kind, shape: [r] });

const lv = (id: number, r: Ring): Member => member(id, 'level', r);
const sd = (id: number, r: Ring): Member => member(id, 'solid', r);

/** Total length of a set of open runs. */
const runLength = (runs: readonly { points: Point[] }[]) =>
  runs.reduce((t, { points: r }) => t + r.slice(1).reduce(
    (u, p, i) => u + Math.hypot(p.x - r[i].x, p.y - r[i].y), 0), 0);

const perimeter = (r: Ring) =>
  r.reduce((t, p, i) => t + Math.hypot(
    p.x - r[(i + 1) % r.length].x, p.y - r[(i + 1) % r.length].y), 0);

/** Every member's share, added up: the whole outline, each piece once. */
const wholeOutline = (ms: Member[]) => ms.reduce(
  (t, m) => t + runLength(boundaryRuns(m, ms.filter(o => o.id !== m.id))), 0);

describe('boundaryRuns', () => {
  test('a lone polygon keeps its whole boundary', () => {
    expect(runLength(boundaryRuns(lv(0, rect(0, 0, 10, 10)), []))).toBeCloseTo(40, 6);
  });

  test('a polygon swallowed whole contributes nothing', () => {
    const inner = lv(1, rect(2, 2, 2, 2)), outer = lv(0, rect(0, 0, 10, 10));

    expect(runLength(boundaryRuns(inner, [outer]))).toBeCloseTo(0, 6);
    expect(runLength(boundaryRuns(outer, [inner]))).toBeCloseTo(40, 6);
  });

  test('overlapping squares split the outline between them, once each', () => {
    // Sharing the y=0 and y=10 edges over the overlap, which is exactly the
    // case where both could claim the same segment.
    const ms = [lv(0, rect(0, 0, 10, 10)), lv(1, rect(5, 0, 10, 10))];

    expect(wholeOutline(ms)).toBeCloseTo(perimeter(simplify(ms.map(m => m.shape[0]))[0]), 6);
  });

  test('the far side of a chain does not change the answer', () => {
    // A-B-C in a row: A meets B, B meets C, A never meets C. A's share has to
    // come out the same whether or not C is mentioned — the locality claim.
    const a = lv(0, rect(0, 0, 10, 10));
    const b = lv(1, rect(8, 0, 10, 10));
    const c = lv(2, rect(16, 0, 10, 10));

    expect(runLength(boundaryRuns(a, [b, c]))).toBeCloseTo(runLength(boundaryRuns(a, [b])), 6);
  });

  test('every share together rebuilds the whole outline', () => {
    const ms = [
      lv(0, rect(0, 0, 10, 10)),
      lv(1, rect(8, 0, 10, 10)),
      lv(2, rect(16, 0, 10, 10)),
      lv(3, rect(4, 6, 10, 10)),
    ];

    const whole = simplify(ms.map(m => m.shape[0]));

    expect(wholeOutline(ms)).toBeCloseTo(whole.reduce((t, r) => t + perimeter(r), 0), 4);
  });

  test('a solid cuts the level that contains it', () => {
    const room = lv(0, rect(0, 0, 20, 20)), pillar = sd(1, rect(8, 8, 4, 4));

    expect(runLength(boundaryRuns(room, [pillar]))).toBeCloseTo(80, 6);
    expect(runLength(boundaryRuns(pillar, [room]))).toBeCloseTo(16, 6);
  });

  test('a solid outside every level contributes nothing', () => {
    const room = lv(0, rect(0, 0, 20, 20)), away = sd(1, rect(50, 50, 4, 4));

    expect(runLength(boundaryRuns(away, [room]))).toBeCloseTo(0, 6);
  });

  test('id order decides a shared edge, not argument order', () => {
    // Two squares meeting exactly along x=10. Whichever is asked first, the
    // shared edge belongs to the same one of them.
    const a = lv(0, rect(0, 0, 10, 10)), b = lv(1, rect(10, 0, 10, 10));

    expect(runLength(boundaryRuns(a, [b])) + runLength(boundaryRuns(b, [a]))).toBeCloseTo(60, 6);
  });

  test('two polygons on exactly the same ground are counted once', () => {
    // Every edge of one lies along an edge of the other, so every edge is
    // claimed twice unless rank settles it. The lower id takes the lot.
    const a = lv(3, rect(0, 0, 10, 10)), b = lv(7, rect(0, 0, 10, 10));

    expect(runLength(boundaryRuns(a, [b]))).toBeCloseTo(40, 6);
    expect(runLength(boundaryRuns(b, [a]))).toBeCloseTo(0, 6);
  });

  test('a shared ground gives the same answer as a private one', () => {
    const ms = [
      lv(0, rect(0, 0, 10, 10)),
      lv(1, rect(6, 2, 10, 10)),
      lv(2, rect(12, 4, 10, 10)),
      sd(3, rect(7, 5, 3, 3)),
      sd(4, rect(1, 1, 2, 2)),
    ];

    const on = ground(ms);

    for (const m of ms) {
      const others = ms.filter(o => o.id !== m.id);

      expect(runLength(boundaryRuns(m, others, on)))
        .toBeCloseTo(runLength(boundaryRuns(m, others)), 6);
    }
  });
});


describe('a crossing reached by two routes is one point', () => {
  // The two edges through a crossing each work it out for themselves, and the
  // answers differ in the last bits. Rounding to a cell reunites them except
  // when the pair straddles a cell boundary — and the coordinates an editor
  // makes, snapped to a grid and dragged in whole pixels, land on one exactly.
  // A crossing split in two cannot be stitched through, so the ring comes back
  // a corner short, or does not come back at all.
  const quad = [
    { x: 352, y: -160 }, { x: 608, y: 256 },
    { x: 32, y: 256 }, { x: 128, y: -192 },
  ];

  const sig = (s: Shape) => s.map(r => r.length).join('+');

  test('an exactly representable erosion depth is no different from any other', () => {
    const base = simplify([quad]);

    // A depth that divides into the snapping cell exactly, so that the two
    // copies of a crossing sit either side of a rounding boundary.
    expect(sig(erode(base, 136.28125))).toEqual('4');
    expect(sig(erode(base, 125.71875))).toEqual('4');
  });

  test('nothing about the depth changes the answer it is a hair away from', () => {
    const base = simplify([quad]);
    const wrong: string[] = [];

    // Every thirty-second, which is the granularity a slider hands over. The
    // truth is continuous, so a depth and the same depth nudged by an ulp have
    // to agree; where they do not, one of the two is wrong.
    for (let k = 1; k < 160 * 32; k++) {
      const d = k / 32;
      const here = sig(erode(base, d));
      const near = sig(erode(base, d * (1 + 1e-11)));

      if (here !== near) wrong.push(`${d}: ${here} against ${near}`);
    }

    expect(wrong).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Which points carry a vertical
//
// These moved here from `walls.test.ts` when the answer did. A corner is a
// question about the boundary, and the boundary is a question about a polygon
// and the ones it overlap — so it is answered where both are in hand, and every
// caller gets the same answer rather than the best one its own share of the
// runs could support. See `cornering`.
// -----------------------------------------------------------------------------

/** The flags for one member's share, run by run. */
const cornersOf = (m: Member, others: Member[] = []) =>
  boundaryRuns(m, others).map(r => r.corner);

describe('what counts as a corner', () => {
  test('a lone room turns at every point of it', () => {
    // Its ring comes back whole, cut at one of its own corners and with that
    // corner written down twice. Both copies are the corner it is.
    expect(cornersOf(lv(0, rect(0, 0, 10, 10)))).toEqual([[true, true, true, true, true]]);
  });

  test('a redundant point along a flat wall is not one', () => {
    // What a dilation leaves behind: a vertex half way down an edge that the
    // boundary runs straight through. A vertical there is a line drawn down
    // the middle of a flat wall.
    const pillar = sd(1, [
      { x: 60, y: 40 }, { x: 60, y: 60 }, { x: 40, y: 60 },
      { x: 40, y: 50 }, { x: 40, y: 40 },
    ]);

    expect(cornersOf(pillar, [lv(0, rect(0, 0, 100, 100))]))
      .toEqual([[true, true, true, false, true, true]]);
  });

  test('two rooms abutting stand no vertical where they meet', () => {
    // The case out of world-2026-08-25T17-46-44Z. One flat wall made of two
    // polygons\' runs, and the join is not a corner — which neither of them
    // could tell on its own. Each answers the same about the shared ends,
    // which is the whole reason this is asked here rather than of the runs.
    const a = lv(0, rect(0, 0, 100, 100));
    const b = lv(1, rect(100, 0, 100, 100));

    expect(cornersOf(a, [b])).toEqual([[false, true, true, false]]);
    expect(cornersOf(b, [a])).toEqual([[false, true, true, false]]);
  });

  test('and one does where the wall really turns', () => {
    // The same pair with the second room shallower, so one join is a step and
    // the other is still flat. The two ends of the one run answer differently.
    const a = lv(0, rect(0, 0, 100, 100));
    const b = lv(1, rect(100, 0, 100, 60));

    // From (100, 60) — where the step is — round to (100, 0), where it is not.
    expect(cornersOf(a, [b])).toEqual([[true, true, true, true, false]]);
  });

  test('a T where three runs meet is a corner in all of them', () => {
    // A corridor off the side of a room: the boundary branches where it joins,
    // and a branch is a corner however flat the wall through it is.
    const room = lv(0, rect(0, 0, 100, 100));
    const spur = lv(1, rect(100, 20, 60, 40));

    for (const [m, others] of [[room, [spur]], [spur, [room]]] as [Member, Member[]][]) {
      const ends = boundaryRuns(m, others)
        .map(r => [r.corner[0], r.corner[r.corner.length - 1]]);

      expect(ends.flat()).toEqual(ends.flat().map(() => true));
    }
  });

  test('the solid out of world-2026-08-25T20-25-12Z', () => {
    // Two rooms overlapping with a solid triangle across the pair, to the
    // digit. Its edges cross the rooms' walls at glancing angles — the worst
    // about eight degrees — and every one of those crossings came back a
    // corner.
    //
    // Stepping along a direction and looking to either side of it, which is
    // what this did first, lands both samples on either side of the *solid's*
    // edge when the two are that nearly parallel. The buried wall then reads
    // as a boundary it is no part of, the point has four directions instead of
    // two, and a flat wall gets a line down the middle of it.
    const rooms = [
      lv(0, [
        { x: -160, y: -128 }, { x: -224, y: 64 },
        { x: -480, y: 64 }, { x: -480, y: -288 },
      ]),
      lv(1, [
        { x: -128, y: -352 }, { x: -128, y: -96 },
        { x: -352, y: -160 }, { x: -288, y: -320 },
      ]),
    ];

    const solid = sd(2, [
      { x: -159.984375, y: -133.96875 },
      { x: -351.984375, y: -37.96875 },
      { x: -351.984375, y: -197.96875 },
    ]);

    const at = boundaryRuns(solid, rooms);

    // A triangle has three corners, however many times the rooms cut its ring
    // on the way round. Ten points came back, and seven of them are flat.
    expect(at.flatMap(r => r.corner).filter(c => c).length).toEqual(3);
    expect(at.flatMap(r => r.corner).length).toEqual(10);
  });

  test('the pillar out of world-2026-08-25T10-05-38Z', () => {
    // The reported case, to the digit: a dilated solid inside a room, with a
    // collinear point the dilation left on its left edge. That one point is
    // the only one of the six that is not a corner.
    const pillar = sd(1, [
      { x: 63.453125, y: -96.546875 },
      { x: 63.453125, y: -223.453125 },
      { x: -95.453125, y: -223.453125 },
      { x: -95.453125, y: -174.16145833333331 },
      { x: -95.453125, y: -96.546875 },
    ]);

    expect(cornersOf(pillar, [lv(0, rect(-200, -300, 400, 400))]))
      .toEqual([[true, true, true, false, true, true]]);
  });
});
