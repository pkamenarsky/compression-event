import { Point } from '@ce/game/world';
import { describe, expect, test } from 'vitest';
import { Rider, riding } from './bake';
import { Moving, affineAt, alongAt, breaksIn, frameOn, incidentAt } from './incident';
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
      const cuts = [0, ...breaksIn({ rider: it, from: point(r), to: point(r) }), 1];

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
