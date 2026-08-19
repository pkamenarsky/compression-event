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
import { AABB, box, empty, merge } from './aabb';
import { Iv, add, at, cos, holdsZero, iv, mul, sin, sub } from './interval';

/**
 * The one version in flight, at one end of a stretch — its own layer, never an
 * accumulation of the chain, which is what lets the scale be per axis.
 *
 * Every version boundary is a keyframe, so at most one layer is ever partway
 * applied. Everything before it is constant across the stretch and has already
 * been folded into `local` and `bisector` by the caller: a constant map is not
 * something to interpolate, which is exactly why `scene.ts` is free to keep it
 * as a general affine even though a general affine cannot be interpolated.
 */
export interface Frame {
  translation: Point
  rotation: number
  /**
   * Per axis, as a version's layer is. Nothing here has to commute with
   * eroding, so nothing forces this to be uniform.
   */
  scale: Point
}

/**
 * One vertex across one stretch: where it sits at either end in the frame the
 * layer applies to, which way it erodes, how deep at either end, and the layer
 * it rides.
 *
 * `local` has two ends rather than one because a vertex nudge interpolates too.
 * With it held constant a nudge could only pop at a version boundary; with it
 * moving, a nudge morphs like everything else — and the search has to watch the
 * trajectory the shader will actually draw, not a tidier one.
 */
export interface Moving {
  local: [Point, Point]
  /**
   * Where the vertex goes per unit of depth: the mitre direction, constant for
   * as long as the corner survives, and a corner not surviving is an event.
   */
  bisector: Point
  erosion: [number, number]
  frames: [Frame, Frame]
}

function lerp(u: number, v: number, t: Iv): Iv {
  return add(at(u), mul(at(v - u), t));
}

/**
 * A polygon's frame, worked out at one `t`. Every vertex riding that polygon
 * shares it, which is why it is separated out: a frame costs four `Math.cos`
 * calls, since `sin` is `cos` of a shifted angle and each looks at both ends,
 * and a vertex costs none.
 */
export interface Riding {
  translation: { x: Iv, y: Iv }
  cos: Iv
  sin: Iv
  scale: { x: Iv, y: Iv }
}

export function riding(m: Moving, t: Iv): Riding {
  const [f, g] = m.frames;
  const th = lerp(f.rotation, g.rotation, t);

  return {
    translation: {
      x: lerp(f.translation.x, g.translation.x, t),
      y: lerp(f.translation.y, g.translation.y, t),
    },
    cos: cos(th),
    sin: sin(th),
    scale: {
      x: lerp(f.scale.x, g.scale.x, t),
      y: lerp(f.scale.y, g.scale.y, t),
    },
  };
}

/**
 * `p(t) = apply(lerp(frames), local + lerp(erosion) * bisector)` — the bake's
 * formula, with the components interpolated rather than the positions.
 *
 * The frame arrives already worked out, because every vertex of a polygon rides
 * the same one. The erosion depth does not, and cannot: clamping makes it per
 * vertex, which is the whole reason it is a coefficient rather than a frame
 * component.
 */
export function place(m: Moving, r: Riding, t: Iv): { x: Iv, y: Iv } {
  const e = lerp(m.erosion[0], m.erosion[1], t);

  const qx = add(lerp(m.local[0].x, m.local[1].x, t), mul(e, at(m.bisector.x)));
  const qy = add(lerp(m.local[0].y, m.local[1].y, t), mul(e, at(m.bisector.y)));

  // Scale per axis, then turn, then move — the order `affine` builds a layer in.
  const sx = mul(qx, r.scale.x);
  const sy = mul(qy, r.scale.y);

  return {
    x: add(r.translation.x, sub(mul(sx, r.cos), mul(sy, r.sin))),
    y: add(r.translation.y, add(mul(sx, r.sin), mul(sy, r.cos))),
  };
}

/**
 * Twice the signed area of `a b v`, which vanishes exactly when `v` reaches
 * the line through `a` and `b`.
 *
 * `a` and `b` are the two ends of one edge and so ride one frame, which is
 * therefore worked out once rather than twice. That is most of what this costs:
 * a frame is four `Math.cos` calls and fifteen-odd intervals, a vertex is six.
 */
export function vertexOnEdge(a: Moving, b: Moving, v: Moving): (t: Iv) => Iv {
  return t => {
    const edge = riding(a, t), vert = riding(v, t);
    const p = place(a, edge, t), q = place(b, edge, t), w = place(v, vert, t);

    return sub(
      mul(sub(q.x, p.x), sub(w.y, p.y)),
      mul(sub(w.x, p.x), sub(q.y, p.y)),
    );
  };
}

/**
 * Three edges through one point.
 *
 * A crossing appearing or dying is a vertex reaching an edge, and `collinear`
 * finds those. It cannot find the other way an outline's combinatorics change:
 * three boundaries meeting at a single point, where two crossings arrive at the
 * same place and the runs either side of them join or part. Nothing is at an
 * endpoint there, so no signed area over three *vertices* vanishes — the point
 * is a crossing, and crossings are not in `collinear`'s vocabulary.
 *
 * Written as lines it is the standard condition. An edge from `p` to `q` is the
 * line `n . x = c` with `n = (p.y - q.y, q.x - p.x)` and `c = cross(p, q)`, and
 * three lines are concurrent exactly when the three of them, stacked, have no
 * volume:
 *
 * ```
 *     | n1x  n1y  c1 |
 * det | n2x  n2y  c2 | = 0
 *     | n3x  n3y  c3 |
 * ```
 *
 * Both ends of an edge ride the same polygon, so each edge costs one frame
 * rather than two — the same sharing `vertexOnEdge` does, and the reason
 * `riding` is separate.
 *
 * There is no closed form here, even when nothing turns. With every point
 * linear in `t` the normals are linear and the offsets quadratic, so the
 * determinant runs to a quartic, and a quartic solved in floating point is
 * worse company than a search that cannot miss. The search is the same one, on
 * the same footing.
 */
export function edgesMeet(
  e1: readonly [Moving, Moving],
  e2: readonly [Moving, Moving],
  e3: readonly [Moving, Moving],
): (t: Iv) => Iv {
  return t => {
    const [l1, l2, l3] = [e1, e2, e3].map(([p, q]) => {
      const r = riding(p, t);

      return line(place(p, r, t), place(q, r, t));
    });

    return sub(
      add(
        mul(l1.nx, sub(mul(l2.ny, l3.c), mul(l2.c, l3.ny))),
        mul(l1.c, sub(mul(l2.nx, l3.ny), mul(l2.ny, l3.nx))),
      ),
      mul(l1.ny, sub(mul(l2.nx, l3.c), mul(l2.c, l3.nx))),
    );
  };
}

interface Line {
  nx: Iv
  ny: Iv
  c: Iv
}

function line(p: { x: Iv, y: Iv }, q: { x: Iv, y: Iv }): Line {
  return {
    nx: sub(p.y, q.y),
    ny: sub(q.x, p.x),
    c: sub(mul(q.x, p.y), mul(q.y, p.x)),
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

// -----------------------------------------------------------------------------
// The closed form
//
// The search above is what a *general* `f` needs, and `f` is only general
// because two polygons can turn at different rates. That is what puts the sine
// and cosine of two unrelated angles into the expression and leaves it with no
// closed-form root.
//
// Take the turning away and the whole thing collapses. A vertex whose frame
// only translates travels in a straight line in `t`: the translation and the
// erosion depth both interpolate linearly, and a rotation that does not change
// is a constant matrix standing in front of the result. `f` is a cross product
// of two differences of such lines, so it is a quadratic, and a quadratic is
// solved rather than searched.
//
// This is the common case rather than a special one. A version that only erodes
// lands here, and so does one that only moves things about — which is to say the
// core mechanic and most of the authoring around it. Only genuine relative
// rotation pays for the search.
// -----------------------------------------------------------------------------

/**
 * Whether this vertex travels in a straight line over the stretch.
 *
 * The test is exact equality rather than a tolerance, because the question is
 * whether the version *touched* rotation or scale, not whether two numbers came
 * out close: a layer that left them alone wrote the same float at both ends.
 */
function steady(m: Moving): boolean {
  const [f, g] = m.frames;

  return f.rotation === g.rotation
    && f.scale.x === g.scale.x
    && f.scale.y === g.scale.y;
}

/** Where that straight line starts and ends. Only meaningful for a `steady` m. */
function ends(m: Moving): { x0: number, y0: number, x1: number, y1: number } {
  const [f, g] = m.frames;
  const c = Math.cos(f.rotation), s = Math.sin(f.rotation);

  const ax = (m.local[0].x + m.erosion[0] * m.bisector.x) * f.scale.x;
  const ay = (m.local[0].y + m.erosion[0] * m.bisector.y) * f.scale.y;
  const bx = (m.local[1].x + m.erosion[1] * m.bisector.x) * f.scale.x;
  const by = (m.local[1].y + m.erosion[1] * m.bisector.y) * f.scale.y;

  return {
    x0: f.translation.x + ax * c - ay * s,
    y0: f.translation.y + ax * s + ay * c,
    x1: g.translation.x + bx * c - by * s,
    y1: g.translation.y + bx * s + by * c,
  };
}

/**
 * Roots of `c2·t² + c1·t + c0` inside [0, 1], in order.
 *
 * Both roots come off one `q` rather than off the two branches of the quadratic
 * formula, which loses most of its digits to cancellation on whichever branch
 * has `c1` and the square root nearly agreeing. It also degrades on its own as
 * `c2` approaches zero: `q / c2` runs out of range and is dropped, and `c0 / q`
 * is the linear root that survives.
 */
function quadratic(c2: number, c1: number, c0: number, flat: number): number[] {
  // Zero throughout rather than zero somewhere — the same answer the search
  // gives for a stretch that never leaves the flat band.
  if (Math.abs(c2) <= flat && Math.abs(c1) <= flat && Math.abs(c0) <= flat) {
    return [0.5];
  }

  const out: number[] = [];

  const keep = (t: number) => {
    if (t >= 0 && t <= 1) out.push(t);
  };

  if (c2 === 0) {
    if (c1 !== 0) keep(-c0 / c1);
  }
  else {
    const d = c1 * c1 - 4 * c2 * c0;

    if (d === 0) {
      keep(-c1 / (2 * c2));
    }
    else if (d > 0) {
      const q = -(c1 + (c1 >= 0 ? 1 : -1) * Math.sqrt(d)) / 2;

      keep(q / c2);
      if (q !== 0) keep(c0 / q);
    }
  }

  return out.sort((p, q) => p - q);
}

/**
 * Every moment `v` reaches the line through `a` and `b`, by whichever route the
 * geometry allows — solved outright when nothing turns, searched when something
 * does.
 *
 * Both routes are complete. The closed form is also exact rather than pinned to
 * `tol`, and never goes `coarse`, so it does not need a budget.
 */
export function collinear(a: Moving, b: Moving, v: Moving, search: Search = {}): Found {
  if (!steady(a) || !steady(b) || !steady(v)) {
    return events(vertexOnEdge(a, b, v), search);
  }

  const p = ends(a), q = ends(b), w = ends(v);

  // Both differences are straight lines in `t`, held as `d0 + t·d1`.
  const ux0 = q.x0 - p.x0, uy0 = q.y0 - p.y0;
  const ux1 = q.x1 - p.x1 - ux0, uy1 = q.y1 - p.y1 - uy0;
  const zx0 = w.x0 - p.x0, zy0 = w.y0 - p.y0;
  const zx1 = w.x1 - p.x1 - zx0, zy1 = w.y1 - p.y1 - zy0;

  return {
    at: quadratic(
      ux1 * zy1 - zx1 * uy1,
      ux0 * zy1 + ux1 * zy0 - zx0 * uy1 - zx1 * uy0,
      ux0 * zy0 - zx0 * uy0,
      search.flat ?? 0,
    ),
    coarse: false,
  };
}

// -----------------------------------------------------------------------------
// The broad phase
//
// Everything above answers "when do these three points line up", and the bake
// has to ask it for every edge of every polygon against every vertex of every
// other. That is quadratic in polygons and the dominant cost of the whole
// search — far more than the choice of root finder inside it, which is why this
// matters more than either the closed form or any amount of tuning.
//
// Most of those questions have the same answer. Two polygons that never come
// near each other over the whole stretch cannot produce an event, and the box
// that proves it is already computable: evaluating `place` over `t` of [0, 1]
// returns intervals *guaranteed* to contain the vertex's entire path, which is
// exactly a swept bound. It is the same containment property the search rests
// on, used one level up.
//
// So the boxes are sound by construction — wider than the truth, never
// narrower — and a pair whose boxes miss each other has been proved to have no
// event, on the same footing as a discarded interval. `aabb.ts` takes it from
// there: `build` a tree over the swept boxes, `each` to find the pairs worth
// asking about.
//
// `worldset.ts` is the wrong tool for this despite looking close. It groups
// polygons into connected components of the overlap graph, which is what a CSG
// needs and the opposite of what this needs — a chain of touching polygons
// collapses into one cluster, when what is wanted is the individual pairs. It
// also maintains itself incrementally across edits, which a bake that runs once
// has no use for, and its boxes are of resolved geometry at an instant rather
// than of motion across a stretch.
// -----------------------------------------------------------------------------

/**
 * A box holding everywhere a polygon's vertices go over the whole stretch.
 *
 * One frame serves the lot, which is the same sharing `vertexOnEdge` does and
 * the reason `riding` is separate — here it pays off properly, since a polygon
 * is bounded once however many vertices it has.
 */
export function swept(vertices: readonly Moving[]): AABB {
  const t = iv(0, 1);
  let out = empty();

  for (const m of vertices) {
    const p = place(m, riding(m, t), t);

    out = merge(out, box(p.x.lo, p.y.lo, p.x.hi, p.y.hi));
  }

  return out;
}
