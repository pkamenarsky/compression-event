import { Point } from '@ce/game/world';
import { describe, expect, test } from 'vitest';
import { Rider, riding } from './bake';
import {
  Edge,
  Moving,
  Turning,
  bentAt,
  bendingOn as bendingHomogeneous,
  turningAt,
  withinBent,
  affineAt,
  alongAt,
  breaksIn,
  concurrentAt,
  frameOn,
  incidentAt,
  meetingWithin,
  pointAt,
} from './incident';
import { at as surdAt, basis as surdBasis } from './surd';
import { Transform } from './types';

const rng = (seed: number) => {
  let s = seed >>> 0;

  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;

    return s / 4294967296;
  };
};

function transform(r: () => number): Transform {
  return {
    translation: { x: (r() - 0.5) * 40, y: (r() - 0.5) * 40 },
    rotation: (r() - 0.5) * 6,
    scale: { x: 0.5 + r(), y: 0.5 + r() },
    erosion: 0,
  };
}

function rider(r: () => number, holders: number): Rider {
  const a = (r() - 0.5) * 3;

  return {
    base: {
      a: Math.cos(a), b: Math.sin(a),
      c: -Math.sin(a) * 1.3, d: Math.cos(a) * 1.3,
      tx: (r() - 0.5) * 20, ty: (r() - 0.5) * 20,
    },
    layer: transform(r),
    holders: Array.from({ length: holders }, (_, i) => ({ id: i, layer: transform(r) })),
  };
}

function point(r: () => number): Point {
  return { x: (r() - 0.5) * 30, y: (r() - 0.5) * 30 };
}

function moving(r: () => number, holders: number): Moving {
  return { rider: rider(r, holders), from: point(r), to: point(r) };
}

/** Where a `Moving` actually is, by the route the bake and the game take. */
function placed(m: Moving, t: number): Point {
  const f = riding(m.rider, t);
  const x = m.from.x + (m.to.x - m.from.x) * t;
  const y = m.from.y + (m.to.y - m.from.y) * t;

  return { x: f.a * x + f.c * y + f.tx, y: f.b * x + f.d * y + f.ty };
}

// The one thing everything else rests on. If the polynomial frame is not the
// frame the span is played back with, its roots are about some other world.
describe('the polynomial frame', () => {
  test('is the frame `riding` walks, entry for entry', () => {
    const r = rng(7);

    for (let k = 0; k < 60; k++) {
      const it = rider(r, k % 3);
      const cuts = [0, ...breaksIn({ rider: it }), 1];

      for (let i = 0; i + 1 < cuts.length; i++) {
        const lo = cuts[i], hi = cuts[i + 1];
        const m = frameOn(it, lo, hi);

        for (let j = 0; j <= 8; j++) {
          const s = j / 8;
          const got = affineAt(m, s), want = riding(it, lo + s * (hi - lo));

          for (const key of ['a', 'b', 'c', 'd', 'tx', 'ty'] as const) {
            expect(got[key]).toBeCloseTo(want[key], 8);
          }
        }
      }
    }
  });
});

describe('a corner reaching an edge', () => {
  // Against a dense scan of the same condition, which is what the bake does
  // now — only far more finely than it could afford to.
  test('finds every sign change a fine scan sees', () => {
    const r = rng(11);
    const STEPS = 20000;

    for (let k = 0; k < 40; k++) {
      const p = moving(r, 0), q1 = moving(r, 0), q2 = moving(r, 0);

      const cross = (t: number): number => {
        const a = placed(p, t), b = placed(q1, t), c = placed(q2, t);

        return (c.x - b.x) * (a.y - b.y) - (c.y - b.y) * (a.x - b.x);
      };

      const scanned: number[] = [];

      for (let i = 0; i < STEPS; i++) {
        const lo = i / STEPS, hi = (i + 1) / STEPS;

        if (cross(lo) === 0 || cross(lo) * cross(hi) < 0) scanned.push((lo + hi) / 2);
      }

      const found = incidentAt(p, q1, q2, 1e-9);

      for (const t of scanned) {
        expect(found.some(f => Math.abs(f - t) < 2 / STEPS)).toBe(true);
      }

      // And nothing invented: every root it reports really is one.
      for (const t of found) {
        const size = Math.max(1, Math.abs(cross(0)), Math.abs(cross(1)));

        expect(Math.abs(cross(t)) / size).toBeLessThan(1e-6);
      }
    }
  });

  test('reports a crossing that is arranged rather than stumbled on', () => {
    const r = rng(3);
    const p = moving(r, 1), q1 = moving(r, 1), q2 = moving(r, 1);

    // Put the corner exactly on the edge's line at t = 0.4, by moving its
    // own-frame endpoint until it lands there.
    const t = 0.4;
    const f = riding(p.rider, t);
    const a = placed(q1, t), b = placed(q2, t);
    const want = { x: a.x + (b.x - a.x) * 0.5, y: a.y + (b.y - a.y) * 0.5 };

    const det = f.a * f.d - f.b * f.c;
    const dx = want.x - f.tx, dy = want.y - f.ty;
    const own = { x: (f.d * dx - f.c * dy) / det, y: (f.a * dy - f.b * dx) / det };

    // `from` and `to` lerp at `t`, so pin `to` and solve `from`.
    p.to = point(r);
    p.from = {
      x: (own.x - p.to.x * t) / (1 - t),
      y: (own.y - p.to.y * t) / (1 - t),
    };

    const found = incidentAt(p, q1, q2, 1e-10);

    expect(found.some(x => Math.abs(x - t) < 1e-6)).toBe(true);
    expect(alongAt(p, q1, q2, t)).toBeCloseTo(0.5, 6);
  });

  test('proves an interval empty rather than failing to find anything in it', () => {
    const r = rng(5);

    // A corner far off to one side of an edge that never reaches it: the hull
    // test returns nothing, and returning nothing here is a statement.
    const q1 = moving(r, 0);
    const q2: Moving = { rider: q1.rider, from: { x: 10, y: 0 }, to: { x: 12, y: 1 } };
    const p: Moving = { rider: q1.rider, from: { x: 0, y: 400 }, to: { x: 1, y: 420 } };

    q1.from = { x: 0, y: 0 };
    q1.to = { x: 1, y: 1 };

    expect(incidentAt(p, q1, q2)).toEqual([]);
  });
});

describe('three edges through one point', () => {
  // The determinant is degree 24, which is high enough that its roots are worth
  // holding against a scan rather than trusting.
  test('finds every sign change a fine scan sees', () => {
    const r = rng(23);
    const STEPS = 20000;

    for (let k = 0; k < 30; k++) {
      const e: Edge[] = [
        [moving(r, 0), moving(r, 0)],
        [moving(r, 0), moving(r, 0)],
        [moving(r, 0), moving(r, 0)],
      ];

      // `det [L1; L2; L3]` read straight off the placed points, which is the
      // same quantity the polynomials are a rewriting of.
      const det = (t: number): number => {
        const l = e.map(([a, b]) => {
          const p = placed(a, t), q = placed(b, t);

          return [p.y - q.y, q.x - p.x, p.x * q.y - p.y * q.x];
        });

        return l[0][0] * (l[1][1] * l[2][2] - l[1][2] * l[2][1])
          - l[0][1] * (l[1][0] * l[2][2] - l[1][2] * l[2][0])
          + l[0][2] * (l[1][0] * l[2][1] - l[1][1] * l[2][0]);
      };

      const scanned: number[] = [];

      for (let i = 0; i < STEPS; i++) {
        const lo = i / STEPS, hi = (i + 1) / STEPS;

        if (det(lo) * det(hi) < 0) scanned.push((lo + hi) / 2);
      }

      const found = concurrentAt(e[0], e[1], e[2], 1e-9);

      for (const t of scanned) {
        expect(found.some(f => Math.abs(f - t) < 2 / STEPS)).toBe(true);
      }

      // And nothing invented. Scaled against the size the determinant reaches
      // over the span, since a degree-24 quantity of world coordinates is a
      // very large number and an absolute threshold would say nothing.
      let size = 0;

      for (let i = 0; i <= 20; i++) size = Math.max(size, Math.abs(det(i / 20)));

      for (const t of found) expect(Math.abs(det(t)) / Math.max(size, 1)).toBeLessThan(1e-6);
    }
  });

  test('places the meeting where all three segments agree', () => {
    const r = rng(29);

    let seen = 0;

    for (let k = 0; k < 60 && seen < 4; k++) {
      const e: Edge[] = [
        [moving(r, 1), moving(r, 1)],
        [moving(r, 1), moving(r, 1)],
        [moving(r, 1), moving(r, 1)],
      ];

      for (const t of concurrentAt(e[0], e[1], e[2])) {
        const p = meetingWithin(e[0], e[1], e[2], t);

        if (p === null) continue;

        seen++;

        // On all three lines, which is what the root said and what the point
        // was solved from only two of.
        for (const [a, b] of e) {
          const f = pointAt(a, t), g = pointAt(b, t);
          const reach = Math.hypot(g.x - f.x, g.y - f.y);
          const off = Math.abs((g.x - f.x) * (p.y - f.y) - (g.y - f.y) * (p.x - f.x)) / reach;

          expect(off).toBeLessThan(1e-6 * Math.max(1, reach));
        }
      }
    }

    expect(seen).toBeGreaterThan(0);
  });

  test('agrees with `riding` about where a point is', () => {
    const r = rng(31);

    for (let k = 0; k < 40; k++) {
      const m = moving(r, k % 3);

      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        const got = pointAt(m, t), want = placed(m, t);

        expect(got.x).toBeCloseTo(want.x, 8);
        expect(got.y).toBeCloseTo(want.y, 8);
      }
    }
  });
});

// -----------------------------------------------------------------------------

/** A convex ring of `n` corners, and a nudged version of it. */
function turning(r: () => number, n: number, at: number): Turning {
  const ring = (jitter: number): Point[] =>
    Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2;
      const reach = 60 + jitter * (r() - 0.5) * 40;

      return { x: Math.cos(a) * reach, y: Math.sin(a) * reach };
    });

  return {
    rider: rider(r, 0),
    ring: [ring(0), ring(1)],
    at,
    depth: [2 + r() * 6, 2 + r() * 14],
  };
}

describe('a corner whose ring turns under it', () => {
  // The whole point of the algebra is that it is the same corner `erodedCorners`
  // produces. If it is not, nothing downstream of it means anything.
  test('is the corner `erodedCorners` puts there', () => {
    const r = rng(41);

    for (let k = 0; k < 40; k++) {
      const n = 3 + (k % 5);
      const c = turning(r, n, k % n);

      // Piece by piece: a rational turn is one polynomial per piece, and the
      // construction is only right inside one of them.
      const cuts = [0, ...breaksIn(c), 1];

      for (let j = 0; j + 1 < cuts.length; j++) {
        const lo = cuts[j], hi = cuts[j + 1];
        const base = surdBasis();
        const p = bendingHomogeneous(c, lo, hi, base);

        for (let i = 0; i <= 8; i++) {
          const u = i / 8;
          const want = turningAt(c, lo + u * (hi - lo));
          const w = surdAt(base, p.w, u);

          expect(Math.abs(w)).toBeGreaterThan(1e-9);
          expect(surdAt(base, p.x, u) / w).toBeCloseTo(want.x, 6);
          expect(surdAt(base, p.y, u) / w).toBeCloseTo(want.y, 6);
        }
      }
    }
  });

  test('bends, so the lerp of its two ends is not where it goes', () => {
    const r = rng(43);

    let bent = 0;

    for (let k = 0; k < 20; k++) {
      const c = turning(r, 5, 2);
      const a = turningAt(c, 0), b = turningAt(c, 1), m = turningAt(c, 0.5);
      const chord = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

      if (Math.hypot(m.x - chord.x, m.y - chord.y) > 1e-3) bent++;
    }

    // If these all travelled straight there would be nothing here to solve.
    expect(bent).toBeGreaterThan(15);
  });

  test('finds every sign change a fine scan sees', () => {
    const r = rng(47);
    const STEPS = 20000;

    for (let k = 0; k < 12; k++) {
      const p = turning(r, 4, 1), q1 = turning(r, 4, 0), q2 = turning(r, 4, 2);

      const cross = (t: number): number => {
        const a = turningAt(p, t), b = turningAt(q1, t), c = turningAt(q2, t);

        return (c.x - b.x) * (a.y - b.y) - (c.y - b.y) * (a.x - b.x);
      };

      const scanned: number[] = [];

      for (let i = 0; i < STEPS; i++) {
        const lo = i / STEPS, hi = (i + 1) / STEPS;

        if (cross(lo) * cross(hi) < 0) scanned.push((lo + hi) / 2);
      }

      const found = bentAt(p, q1, q2, 1e-9);

      for (const t of scanned) {
        expect(found.some(f => Math.abs(f - t) < 2 / STEPS)).toBe(true);
      }

      // Roots of the mitre determinants come through too — those are instants a
      // corner has no mitre, not incidences — so what is checked is that every
      // root the caller would keep really is one.
      for (const t of found) {
        if (withinBent(p, q1, q2, t) === null) continue;

        let size = 0;

        for (let i = 0; i <= 20; i++) size = Math.max(size, Math.abs(cross(i / 20)));

        expect(Math.abs(cross(t)) / Math.max(size, 1)).toBeLessThan(1e-5);
      }
    }
  });
});
