import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { Iv, at, cos, holdsZero, mul, sin, sub } from './interval';
import { Frame, Moving, collinear, edgesMeet, events, place, swept, vertexOnEdge } from './events';
import { Point } from '@ce/game/world';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const still: Frame = { translation: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } };

/** A point that does not move. */
function fixed(p: Point): Moving {
  return {
    local: [p, p],
    bisector: { x: 0, y: 0 },
    erosion: [0, 0],
    frames: [still, still],
  };
}

/** Where a scan of `n` samples sees `f` change sign. */
function signChanges(f: (t: Iv) => Iv, n: number): number[] {
  const out: number[] = [];
  let prev = f(at(0)).lo;

  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const now = f(at(t)).lo;

    if ((prev < 0 && now > 0) || (prev > 0 && now < 0)) out.push(t - 0.5 / n);
    prev = now;
  }

  return out;
}

const near = (xs: number[], x: number) =>
  xs.length > 0 && Math.min(...xs.map(y => Math.abs(y - x)));

// -----------------------------------------------------------------------------
// Interval arithmetic
// -----------------------------------------------------------------------------

/**
 * On a grid, the way a level is actually authored. Quantising also keeps the
 * generator clear of denormals — `fc.double` reaches for 3e-323 given half a
 * chance, and a world coordinate that small is not geometry, it is noise.
 */
const q = (min: number, max: number, step: number) =>
  fc.integer({ min: Math.round(min / step), max: Math.round(max / step) })
    .map(n => n * step);

const arbIv = fc
  .tuple(q(-20, 20, 0.25), q(0, 8, 0.25))
  .map(([lo, w]) => ({ lo, hi: lo + w }));

describe('interval', () => {
  test('cos and sin enclose every value they take', () => {
    fc.assert(
      fc.property(arbIv, q(0, 1, 1 / 64), (a, u) => {
        const t = a.lo + (a.hi - a.lo) * u;
        const c = cos(a), s = sin(a);

        expect(Math.cos(t)).toBeGreaterThanOrEqual(c.lo - 1e-12);
        expect(Math.cos(t)).toBeLessThanOrEqual(c.hi + 1e-12);
        expect(Math.sin(t)).toBeGreaterThanOrEqual(s.lo - 1e-12);
        expect(Math.sin(t)).toBeLessThanOrEqual(s.hi + 1e-12);

        return true;
      }),
      { numRuns: 500 },
    );
  });

  test('a product encloses every product', () => {
    fc.assert(
      fc.property(
        arbIv, arbIv, q(0, 1, 1 / 64), q(0, 1, 1 / 64),
        (a, b, u, v) => {
          const x = a.lo + (a.hi - a.lo) * u, y = b.lo + (b.hi - b.lo) * v;
          const m = mul(a, b);

          expect(x * y).toBeGreaterThanOrEqual(m.lo - 1e-9);
          expect(x * y).toBeLessThanOrEqual(m.hi + 1e-9);

          return true;
        },
      ),
      { numRuns: 500 },
    );
  });
});

// -----------------------------------------------------------------------------
// The search
// -----------------------------------------------------------------------------

describe('events', () => {
  test('an ordinary crossing is found', () => {
    const f = (t: Iv) => sub(t, at(0.375));
    expect(events(f).at.length).toBe(1);
    expect(events(f).at[0]).toBeCloseTo(0.375, 8);
  });

  test('a root at either end is still a root', () => {
    expect(events((t: Iv) => sub(t, at(0))).at[0]).toBeCloseTo(0, 8);
    expect(events((t: Iv) => sub(t, at(1))).at[0]).toBeCloseTo(1, 8);
  });

  test('a graze is found, and sampling cannot see it at all', () => {
    // (t - 0.4)², which touches zero without ever changing sign.
    const f = (t: Iv) => mul(sub(t, at(0.4)), sub(t, at(0.4)));

    expect(signChanges(f, 100_000)).toEqual([]);

    const found = events(f, { tol: 1e-7 });
    expect(found.coarse).toBe(false);
    expect(near(found.at, 0.4)).toBeLessThan(1e-5);
  });

  test('a close pair is found, where sampling sees neither', () => {
    // Two roots 1e-5 apart: a scan steps straight over the gap between them.
    const f = (t: Iv) => mul(sub(t, at(0.5)), sub(t, at(0.50001)));

    expect(signChanges(f, 2000)).toEqual([]);

    const found = events(f, { tol: 1e-9 });
    expect(found.at.length).toBe(2);
    expect(found.at[0]).toBeCloseTo(0.5, 8);
    expect(found.at[1]).toBeCloseTo(0.50001, 8);
  });

  test('a function that never vanishes yields nothing', () => {
    expect(events(t => sub(mul(t, t), at(-1))).at).toEqual([]);
  });

  test('sitting on zero costs precision, never coverage', () => {
    const flatline = () => ({ lo: -1e-18, hi: 1e-18 });

    // Hunting for an instant in a function that is zero everywhere burns the
    // budget, and the answer goes coarse rather than wrong.
    const hunted = events(flatline, { tol: 1e-9, budget: 500 });
    expect(hunted.coarse).toBe(true);
    expect(hunted.at.length).toBeGreaterThan(0);

    // Told what counts as zero, it says so at once.
    const told = events(flatline, { tol: 1e-9, flat: 1e-12 });
    expect(told.coarse).toBe(false);
    expect(told.at).toEqual([0.5]);
  });

  test('the pillar corner reaches the wall at atan(5)', () => {
    // The room's top edge, and a pillar corner turning half a circle about the
    // point the edge runs through.
    const a = fixed({ x: 0, y: 0 });
    const b = fixed({ x: 400, y: 0 });

    const corner: Moving = {
      local: [{ x: 20, y: -100 }, { x: 20, y: -100 }],
      bisector: { x: 0, y: 0 },
      erosion: [0, 0],
      frames: [
        { translation: { x: 120, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
        { translation: { x: 120, y: 0 }, rotation: Math.PI, scale: { x: 1, y: 1 } },
      ],
    };

    const found = events(vertexOnEdge(a, b, corner));

    expect(found.coarse).toBe(false);
    expect(found.at.length).toBe(1);
    expect(found.at[0]).toBeCloseTo(Math.atan(5) / Math.PI, 8);
  });
});

// -----------------------------------------------------------------------------
// Completeness
// -----------------------------------------------------------------------------

const arbFrame = fc.record({
  translation: fc.record({ x: q(-80, 80, 0.5), y: q(-80, 80, 0.5) }),
  rotation: fc.integer({ min: -180, max: 180 }).map(d => d * Math.PI / 180),
  scale: fc.record({ x: q(0.6, 1.6, 0.05), y: q(0.6, 1.6, 0.05) }),
});

const arbPoint = fc.record({ x: q(-60, 60, 0.5), y: q(-60, 60, 0.5) });

const arbMoving: fc.Arbitrary<Moving> = fc.record({
  local: fc.tuple(arbPoint, arbPoint),
  bisector: fc.record({ x: q(-1, 1, 0.05), y: q(-1, 1, 0.05) }),
  erosion: fc.tuple(q(-6, 6, 0.25), q(-6, 6, 0.25)),
  frames: fc.tuple(arbFrame, arbFrame),
});

// `f` is twice a signed area over coordinates of order 100, so it runs to
// roughly 1e4. A millionth is far below anything a real crossing produces.
const FLAT = 1e-6;

describe('completeness', () => {
  test('nothing a dense scan finds is ever missed', () => {
    let sawRoots = 0;

    fc.assert(
      fc.property(arbMoving, arbMoving, arbMoving, (a, b, v) => {
        const f = vertexOnEdge(a, b, v);
        const found = events(f, { tol: 1e-7, flat: FLAT });

        // A scan brackets each root it notices to within half a step; anything
        // it saw has to appear in the answer.
        for (const t of signChanges(f, 3000)) {
          expect(near(found.at, t)).toBeLessThan(1e-3);
          sawRoots++;
        }

        return true;
      }),
      { numRuns: 400 },
    );

    // Guard against a run where the scan never found anything to check.
    expect(sawRoots).toBeGreaterThan(100);
  });

  test('degenerate geometry is answered cheaply, not hunted for ever', () => {
    fc.assert(
      fc.property(arbMoving, arbMoving, arbMoving, (a, b, v) => {
        const found = events(vertexOnEdge(a, b, v), { tol: 1e-7, flat: FLAT });

        expect(found.coarse).toBe(false);

        return true;
      }),
      { numRuns: 400 },
    );
  });

  test('every root reported is somewhere the function really does vanish', () => {
    // The answer is a superset, so this is not exact — but a reported root
    // should have the function reaching zero in its neighbourhood, or sitting
    // inside the flat band, or the over-approximation is uselessly loose.
    fc.assert(
      fc.property(arbMoving, arbMoving, arbMoving, (a, b, v) => {
        const f = vertexOnEdge(a, b, v);

        for (const t of events(f, { tol: 1e-9, flat: FLAT }).at) {
          const round = f({ lo: Math.max(0, t - 1e-4), hi: Math.min(1, t + 1e-4) });
          const flat = Math.max(Math.abs(round.lo), Math.abs(round.hi)) <= FLAT;

          expect(holdsZero(round) || flat).toBe(true);
        }

        return true;
      }),
      { numRuns: 300 },
    );
  });
});

describe('collinear', () => {
  const still = (x: number, y: number): Frame => ({
    translation: { x, y },
    rotation: 0,
    scale: { x: 1, y: 1 },
  });

  const move = (
    local: Point,
    frames: [Frame, Frame],
    erosion: [number, number] = [0, 0],
    bisector: Point = { x: 0, y: 0 },
    to: Point = local,
  ): Moving => ({ local: [local, to], bisector, erosion, frames });

  test('the closed form and the search find the same moments', () => {
    // A corner sliding across a static edge, driven three ways — by the
    // translation, by the erosion depth, and by both at once. None of them
    // turns, so `collinear` takes the closed form while `events` searches.
    const cases: [string, Moving][] = [
      [
        'translating',
        move({ x: 0, y: 0 }, [still(50, -60), still(50, 140)]),
      ],
      [
        'eroding',
        move({ x: 0, y: -60 }, [still(50, 0), still(50, 0)], [0, 200], { x: 0, y: 1 }),
      ],
      [
        'both',
        move({ x: 0, y: -40 }, [still(50, -30), still(50, 90)], [0, 60], { x: 0, y: 1 }),
      ],
    ];

    for (const [what, v] of cases) {
      const a = move({ x: 0, y: 0 }, [still(0, 0), still(0, 0)]);
      const b = move({ x: 200, y: 0 }, [still(0, 0), still(0, 0)]);

      const exact = collinear(a, b, v);
      const searched = events(vertexOnEdge(a, b, v), { tol: 1e-9 });

      expect(exact.at.length, what).toBe(searched.at.length);
      exact.at.forEach((t, i) => expect(t, what).toBeCloseTo(searched.at[i], 7));
      expect(exact.coarse, what).toBe(false);
    }
  });

  test('a turning frame falls back to the search', () => {
    const a = move({ x: 0, y: -80 }, [still(30, 0), still(30, 0)]);
    const b = move({ x: 0, y: 80 }, [still(30, 0), still(30, 0)]);
    const spun = move({ x: 50, y: 0 }, [
      { translation: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      { translation: { x: 0, y: 0 }, rotation: Math.PI, scale: { x: 1, y: 1 } },
    ]);

    const found = collinear(a, b, spun, { tol: 1e-9 });

    expect(found.at.length).toBeGreaterThan(0);
    expect(found.at).toEqual(events(vertexOnEdge(a, b, spun), { tol: 1e-9 }).at);
  });

  test('a corner that never reaches the line has no moments', () => {
    const a = move({ x: 0, y: 0 }, [still(0, 0), still(0, 0)]);
    const b = move({ x: 200, y: 0 }, [still(0, 0), still(0, 0)]);
    const clear = move({ x: 50, y: 60 }, [still(0, 0), still(0, 20)]);

    expect(collinear(a, b, clear).at).toEqual([]);
  });
});

describe('swept', () => {
  const at2 = (x: number, y: number, rot = 0): Frame =>
    ({ translation: { x, y }, rotation: rot, scale: { x: 1, y: 1 } });

  const corner = (lx: number, ly: number, f: Frame, g: Frame): Moving =>
    ({
      local: [{ x: lx, y: ly }, { x: lx, y: ly }],
      bisector: { x: 0, y: 0 },
      erosion: [0, 0],
      frames: [f, g],
    });

  /** Where a vertex actually is, sampled — the truth the box has to contain. */
  function sample(m: Moving, t: number): { x: number, y: number } {
    const [f, g] = m.frames;
    const th = f.rotation + (g.rotation - f.rotation) * t;
    const kx = f.scale.x + (g.scale.x - f.scale.x) * t;
    const ky = f.scale.y + (g.scale.y - f.scale.y) * t;
    const c = Math.cos(th), s = Math.sin(th);

    const lx = (m.local[0].x + (m.local[1].x - m.local[0].x) * t) * kx;
    const ly = (m.local[0].y + (m.local[1].y - m.local[0].y) * t) * ky;

    return {
      x: f.translation.x + (g.translation.x - f.translation.x) * t + lx * c - ly * s,
      y: f.translation.y + (g.translation.y - f.translation.y) * t + lx * s + ly * c,
    };
  }

  test('the box contains the whole path, translating and turning', () => {
    const square = [[50, 50], [-50, 50], [-50, -50], [50, -50]];

    for (const [what, g] of [
      ['translating', at2(300, -120)],
      ['turning', at2(0, 0, Math.PI * 0.75)],
      ['both', at2(300, -120, Math.PI * 1.5)],
    ] as [string, Frame][]) {
      const vs = square.map(([x, y]) => corner(x, y, at2(0, 0), g));
      const b = swept(vs);

      for (const m of vs) {
        for (let i = 0; i <= 200; i++) {
          const p = sample(m, i / 200);

          expect(p.x >= b.minX && p.x <= b.maxX, what).toBe(true);
          expect(p.y >= b.minY && p.y <= b.maxY, what).toBe(true);
        }
      }
    }
  });

  test('a polygon that stays put is bounded tightly', () => {
    const still = [[10, 10], [-10, 10], [-10, -10], [10, -10]]
      .map(([x, y]) => corner(x, y, at2(0, 0), at2(0, 0)));
    const b = swept(still);

    expect(b.minX).toBeCloseTo(-10, 9);
    expect(b.maxX).toBeCloseTo(10, 9);
    expect(b.minY).toBeCloseTo(-10, 9);
    expect(b.maxY).toBeCloseTo(10, 9);
  });
});

// -----------------------------------------------------------------------------
// What the version model asks for
// -----------------------------------------------------------------------------

describe('the layer, as a version writes one', () => {
  const layer = (
    translation: Point,
    rotation: number,
    scale: Point,
  ): Frame => ({ translation, rotation, scale });

  const rides = (local: Point, frames: [Frame, Frame], to: Point = local): Moving =>
    ({ local: [local, to], bisector: { x: 0, y: 0 }, erosion: [0, 0], frames });

  const flat = layer({ x: 0, y: 0 }, 0, { x: 1, y: 1 });

  test('a scale that is not uniform still solves rather than searching', () => {
    // Nothing turns, so the path is straight and the closed form applies —
    // which is the whole reason the two axes were allowed to come apart.
    const a = rides({ x: -100, y: 0 }, [flat, flat]);
    const b = rides({ x: 100, y: 0 }, [flat, flat]);

    const squashed = rides({ x: 0, y: 40 }, [
      flat,
      layer({ x: 0, y: 0 }, 0, { x: 3, y: -0.5 }),
    ]);

    const found = collinear(a, b, squashed);

    expect(found.coarse).toBe(false);

    // `y` runs 40 down to -20, so it reaches the edge two thirds of the way.
    expect(found.at).toHaveLength(1);
    expect(found.at[0]).toBeCloseTo(2 / 3, 9);
  });

  test('the two axes are not the same axis', () => {
    const wide = rides({ x: 10, y: 10 }, [flat, layer({ x: 0, y: 0 }, 0, { x: 4, y: 1 })]);
    const tall = rides({ x: 10, y: 10 }, [flat, layer({ x: 0, y: 0 }, 0, { x: 1, y: 4 })]);

    const box = (m: Moving) => swept([m]);

    expect(box(wide).maxX).toBeCloseTo(40, 6);
    expect(box(wide).maxY).toBeCloseTo(10, 6);
    expect(box(tall).maxX).toBeCloseTo(10, 6);
    expect(box(tall).maxY).toBeCloseTo(40, 6);
  });

  test('a vertex nudge moves the vertex, not just the polygon around it', () => {
    const a = rides({ x: -100, y: 0 }, [flat, flat]);
    const b = rides({ x: 100, y: 0 }, [flat, flat]);

    // Held still by its frame, and moved across the edge by its own two ends.
    const nudged = rides({ x: 0, y: 30 }, [flat, flat], { x: 0, y: -10 });

    const found = collinear(a, b, nudged);

    expect(found.at).toHaveLength(1);
    expect(found.at[0]).toBeCloseTo(0.75, 9);
  });
});

describe('edgesMeet', () => {
  const flat: Frame = { translation: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } };

  const going = (from: Point, to: Point): Moving => ({
    local: [from, to],
    bisector: { x: 0, y: 0 },
    erosion: [0, 0],
    frames: [flat, flat],
  });

  const held = (p: Point): Moving => going(p, p);

  test('finds the instant a third edge arrives at a crossing', () => {
    // Two fixed edges crossing at the origin, and a horizontal line sliding
    // down through it. Nothing is at an endpoint, so no signed area over three
    // vertices ever vanishes and `collinear` cannot see this at all.
    const one = [held({ x: -100, y: -100 }), held({ x: 100, y: 100 })] as const;
    const two = [held({ x: -100, y: 100 }), held({ x: 100, y: -100 })] as const;

    const sliding = [
      going({ x: -100, y: 50 }, { x: -100, y: -50 }),
      going({ x: 100, y: 50 }, { x: 100, y: -50 }),
    ] as const;

    const found = events(edgesMeet(one, two, sliding), { tol: 1e-9 });

    expect(found.coarse).toBe(false);
    expect(found.at).toHaveLength(1);
    expect(found.at[0]).toBeCloseTo(0.5, 7);

    // And the thing it is blind to, for contrast.
    expect(collinear(one[0], one[1], sliding[0]).at).toEqual([]);
  });

  test('says nothing when the third edge never reaches the crossing', () => {
    const one = [held({ x: -100, y: -100 }), held({ x: 100, y: 100 })] as const;
    const two = [held({ x: -100, y: 100 }), held({ x: 100, y: -100 })] as const;

    const clear = [
      going({ x: -100, y: 90 }, { x: -100, y: 60 }),
      going({ x: 100, y: 90 }, { x: 100, y: 60 }),
    ] as const;

    expect(events(edgesMeet(one, two, clear), { tol: 1e-9 }).at).toEqual([]);
  });

  test('reports a stretch that is concurrent throughout once, rather than for ever', () => {
    // Three lines through the origin the whole way: the determinant is zero at
    // every instant, and without `flat` the search would subdivide looking for
    // the moment it happens.
    const through = (dx: number, dy: number) =>
      [held({ x: -dx, y: -dy }), held({ x: dx, y: dy })] as const;

    const found = events(
      edgesMeet(through(100, 0), through(0, 100), through(70, 70)),
      { tol: 1e-6, flat: 1e-3 },
    );

    expect(found.at).toHaveLength(1);
    expect(found.coarse).toBe(false);
  });
});
