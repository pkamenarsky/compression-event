// -----------------------------------------------------------------------------
// Finding the moments a stretch has to be cut at
//
// Between two keyframes the shader reproduces the world exactly, but only for
// as long as the arrangement's combinatorics hold: the same crossings, in the
// same order around each ring. Both change at discrete moments, and those are
// what this finds.
//
// A crossing is born or dies exactly when an intersection parameter reaches the
// end of its edge — which is to say when a vertex lands on the line through
// another edge. So the quantity to watch is a signed area, and an event is
// where it vanishes.
//
// Sampling and bisecting would find most of them. It would also miss a pair of
// events close enough to share a sample interval, and it cannot see a corner
// that grazes an edge without going through, because that root never changes
// sign. Neither failure is visible until the geometry tears in the game.
//
// So the search is over intervals rather than points. A stretch of `t` is
// discarded only when the arithmetic has *proved* the function cannot reach
// zero inside it, and anything unproven is subdivided. What comes back is a
// superset: it may name a moment where nothing actually happens, and that costs
// one redundant keyframe. It cannot omit one.
// -----------------------------------------------------------------------------

import { Point } from '@ce/game/world';
import { Iv, add, at, cos, holdsZero, iv, mul, sin, sub } from './interval';

/** A polygon's coalesced transform at one end of a stretch. */
export interface Frame {
  translation: Point
  rotation: number
  /** Uniform. */
  scale: number
}

/**
 * One source vertex across one stretch: where it sits in its polygon's frame,
 * which way it erodes, how deep at either end, and the frames it rides.
 */
export interface Moving {
  local: Point
  bisector: Point
  erosion: [number, number]
  frames: [Frame, Frame]
}

function lerp(u: number, v: number, t: Iv): Iv {
  return add(at(u), mul(at(v - u), t));
}

/**
 * `p(t) = apply(lerp(frames), local + lerp(erosion) * bisector)` — the bake's
 * formula, with the components interpolated rather than the positions.
 */
export function place(m: Moving, t: Iv): { x: Iv, y: Iv } {
  const [f, g] = m.frames;
  const e = lerp(m.erosion[0], m.erosion[1], t);

  const qx = add(at(m.local.x), mul(e, at(m.bisector.x)));
  const qy = add(at(m.local.y), mul(e, at(m.bisector.y)));

  const th = lerp(f.rotation, g.rotation, t);
  const c = cos(th), s = sin(th);
  const k = lerp(f.scale, g.scale, t);

  return {
    x: add(
      lerp(f.translation.x, g.translation.x, t),
      mul(k, sub(mul(qx, c), mul(qy, s))),
    ),
    y: add(
      lerp(f.translation.y, g.translation.y, t),
      mul(k, add(mul(qx, s), mul(qy, c))),
    ),
  };
}

/** Twice the signed area of `a b v`, which vanishes exactly when `v` reaches
 * the line through `a` and `b`. */
export function vertexOnEdge(a: Moving, b: Moving, v: Moving): (t: Iv) => Iv {
  return t => {
    const p = place(a, t), q = place(b, t), w = place(v, t);

    return sub(
      mul(sub(q.x, p.x), sub(w.y, p.y)),
      mul(sub(w.x, p.x), sub(q.y, p.y)),
    );
  };
}

export interface Found {
  /** Every moment the function can vanish, in order. */
  at: number[]
  /**
   * The budget ran out, so `at` is coarser than `tol` — it still covers
   * everything, in fewer and wider places.
   */
  coarse: boolean
}

export interface Search {
  /** How closely to pin each root down. */
  tol?: number
  /**
   * An `f` confined to a band this narrow around zero counts as sitting on
   * zero. Without it, geometry that is degenerate for a whole stretch — three
   * points that stay collinear throughout — subdivides to `tol` everywhere
   * looking for a moment that never arrives. With it, such a stretch is
   * reported once, which is what it is: degenerate all the way across, not an
   * event at some particular instant.
   *
   * `f` is twice a signed area, so this scales as the square of the world
   * units in play. Zero, the default, turns it off.
   */
  flat?: number
  /** Interval splits allowed before the answer goes coarse. */
  budget?: number
}

/**
 * Every root of `f` in [0, 1], to within `tol`, with nothing missed.
 *
 * Completeness rests on `f`'s interval form containing its true range: a root
 * lives in some interval whose enclosure holds zero, and those are exactly the
 * intervals that are never discarded. It is complete up to the rounding of the
 * bounds themselves, which are computed in ordinary floating point rather than
 * with directed rounding — an ulp of slack at the far end of a `tol` that is
 * already many orders of magnitude coarser.
 *
 * The answer is a superset. Because the arithmetic cannot know that the several
 * appearances of `t` in an expression move together, it reports ranges wider
 * than the truth, and so may name a moment where nothing actually happens. That
 * costs one redundant keyframe, which is a stretch across which the topology
 * happens not to change — harmless. Missing one would tear the geometry.
 */
export function events(f: (t: Iv) => Iv, search: Search = {}): Found {
  const tol = search.tol ?? 1e-9;
  const flat = search.flat ?? 0;

  const out: number[] = [];
  const stack: Iv[] = [iv(0, 1)];

  let left = search.budget ?? 200_000;

  while (stack.length > 0) {
    const s = stack.pop()!;
    const f0 = f(s);

    if (!holdsZero(f0)) continue;

    // Zero throughout, rather than zero somewhere. The test is on how big `f`
    // gets, not on how narrow the enclosure is: enclosures narrow under
    // subdivision for every function, so a width test would cut every search
    // short. A genuine root has `f` steep around it and reaches this band only
    // well inside `tol`.
    if (Math.max(Math.abs(f0.lo), Math.abs(f0.hi)) <= flat) {
      out.push((s.lo + s.hi) / 2);
      continue;
    }

    if (s.hi - s.lo <= tol) {
      out.push((s.lo + s.hi) / 2);
      continue;
    }

    if (left-- <= 0) {
      // Out of budget, and this interval is still live. Reporting its middle
      // keeps the guarantee and loses only precision.
      out.push((s.lo + s.hi) / 2);
      continue;
    }

    const mid = (s.lo + s.hi) / 2;
    stack.push(iv(s.lo, mid), iv(mid, s.hi));
  }

  out.sort((p, q) => p - q);

  // Neighbouring survivors are one root seen from both sides.
  const merged = out.filter((x, i) => i === 0 || x - out[i - 1] > tol * 4);

  return { at: merged, coarse: left <= 0 };
}
