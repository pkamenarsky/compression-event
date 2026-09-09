// -----------------------------------------------------------------------------
// When a corner reaches an edge
//
// The bake cuts a span by measuring: build a stretch, compare it against the CSG
// in the middle, split until it agrees. That is answerable and it is honest, and
// what it cannot do is *prove* an interval empty — see *Cutting the span* in
// `bake.ts`, which is also where the analytic search that used to live here is
// buried, and why.
//
// One of the two reasons it is buried was the shape of the question. With a
// linearly eased angle, a corner reaching an edge reads
//
//   A(t) + B(t) cos(phi t) + C(t) sin(psi t) = 0
//
// with two frequencies where the corner and the edge belong to polygons turning
// at different rates, and that is not a thing anybody solves. Ease the rotation
// rationally instead — `arc.ts` — and every coordinate in the span is a ratio of
// polynomials in `t`. The incidence is then one polynomial, of a degree known in
// advance, and its roots are every instant the corner is on the edge's line.
// Nothing is sampled and nothing is hoped for.
//
// What this is not
// ----------------
// The other reason the search was buried stands untouched, and this does not
// pretend otherwise: *not every change in the output is a change in the
// geometry*. Where several boundary runs meet, which one carries on through the
// junction is decided by a walk, and that can change with no corner near any
// edge. No event solver of any kind sees it. So this is a source of cuts the
// bake can trust and place for nothing, not a replacement for the measuring —
// the intended use is to seed the bisection with the instants it would otherwise
// have to find by halving, and to leave `Span.worst` doing its job.
//
// The one assumption
// ------------------
// A vertex is a straight line in its own frame across the span. That covers the
// nudge, which lerps, and it covers erosion, which moves a corner along a mitre
// whose direction is fixed by the ring's shape — so a depth eased linearly puts
// the corner at exactly the lerp of where it starts and where it lands. It is
// the same model `entryAt` in `baked.ts` already plays back.
//
// It stops covering when both happen at once. A nudge in flight turns the corner
// angle, the mitre turns with it, and the corner's own path bends. That path is
// still algebraic — the mitre is a normalised bisector, so it is rational in `t`
// and in two square roots, and squaring out gives a polynomial of a much less
// pleasant degree — but it is not this, and `Moving` is the honest statement of
// where the line is drawn.
// -----------------------------------------------------------------------------

import { breaksOf, piecesOf } from '@ce/game/arc';
import { Point } from '@ce/game/world';
import { Rider, pivot, riding } from './bake';
import { Ring, erodedCorners, isCCW } from './geometry';
import { Poly, add, at, constant, linear, mul, ratAt, roots, scale, sub } from './poly';
import { Affine, place } from './scene';
import {
  Basis,
  Surd,
  add as add2,
  basis,
  flat,
  mul as mulS,
  radicand,
  rooted,
  roots as rootsS,
  sub as subS,
} from './surd';
import { Transform } from './types';

/**
 * An affine whose six entries are polynomials in `s` over one shared
 * denominator.
 *
 * Shared because they all come by the same route: a rotation written as
 * `(1 - u²) / (1 + u²)` and `2u / (1 + u²)` hands the same `1 + u²` to every
 * entry, and composing two of these multiplies the two. Keeping one denominator
 * for the six is the difference between a tidy degree and six of them.
 *
 * `w` is a product of `1 + u²` terms and is therefore positive everywhere on the
 * real line, which is what lets the incidence throw its denominator away.
 */
export interface AffineP {
  a: Poly
  b: Poly
  c: Poly
  d: Poly
  tx: Poly
  ty: Poly
  w: Poly
}

/** A point of some polygon, and the frame it rides. Straight in its own frame
 * across the span — see *The one assumption*. */
export interface Moving {
  rider: Rider
  from: Point
  to: Point
}

/**
 * Where the pieces of every turn in a chain meet, over the whole span.
 *
 * A rational turn is one polynomial per piece and not one for the turn, so an
 * interval handed to `incidenceOn` has to lie inside a single piece of every
 * layer that acts on it. These are the cuts that makes necessary, and they are
 * known from the layer chain without evaluating anything — the cheap kind.
 */
export function breaksIn(...movers: { rider: Rider }[]): number[] {
  const out = new Set<number>();

  for (const m of movers) {
    for (const b of breaksOf(m.rider.layer.rotation)) out.add(b);

    for (const h of m.rider.holders) {
      for (const b of breaksOf(h.layer.rotation)) out.add(b);
    }
  }

  return [...out].sort((p, q) => p - q);
}

/** `t` over `[lo, hi]` as a polynomial in `s` over `[0, 1]`. */
function span(lo: number, hi: number): Poly {
  return linear(lo, hi - lo);
}

/**
 * One layer easing on, over `[lo, hi]`, as polynomials in `s`.
 *
 * This is `easing` followed by `affine`, written out. It is only right where the
 * interval sits inside one piece of the turn, which is what `breaksIn` is for —
 * the piece index is read once, from the middle.
 */
function layerOn(layer: Transform, lo: number, hi: number): AffineP {
  const t = span(lo, hi);
  const k = piecesOf(layer.rotation);
  const phi = layer.rotation / k;
  const piece = Math.min(Math.max(Math.floor(((lo + hi) / 2) * k), 0), k - 1);

  // How far through its own piece, which is `t k - piece` and is linear.
  const on = sub(scale(t, k), constant(piece));
  const u = scale(on, Math.tan(phi / 2));
  const uu = mul(u, u);

  // The turn within the piece, over `w`, then carried round by the pieces
  // already behind it.
  const w = add(constant(1), uu);
  const cn = sub(constant(1), uu), sn = scale(u, 2);

  const bc = Math.cos(piece * phi), bs = Math.sin(piece * phi);
  const co = sub(scale(cn, bc), scale(sn, bs));
  const si = add(scale(cn, bs), scale(sn, bc));

  const sx = add(constant(1), scale(t, layer.scale.x - 1));
  const sy = add(constant(1), scale(t, layer.scale.y - 1));

  const a = mul(co, sx), b = mul(si, sx);
  const c = scale(mul(si, sy), -1), d = mul(co, sy);

  const held = pivot(layer);

  // `T(t) = f - A(t) f`, over the same `w`; and a straight line for a layer with
  // no fixed point to hold, put over `w` so the six share a denominator.
  const tx = held === null
    ? mul(scale(t, layer.translation.x), w)
    : sub(scale(w, held.x), add(scale(a, held.x), scale(c, held.y)));
  const ty = held === null
    ? mul(scale(t, layer.translation.y), w)
    : sub(scale(w, held.y), add(scale(b, held.x), scale(d, held.y)));

  return { a, b, c, d, tx, ty, w };
}

/** A constant affine, or the walk between two of them. `walked` in `bake.ts`. */
function baseOn(base: Affine, into: Affine | undefined, lo: number, hi: number): AffineP {
  const t = span(lo, hi);
  const lerp = (p: number, q: number): Poly =>
    into === undefined ? constant(p) : add(constant(p), scale(t, q - p));

  return {
    a: lerp(base.a, into?.a ?? 0),
    b: lerp(base.b, into?.b ?? 0),
    c: lerp(base.c, into?.c ?? 0),
    d: lerp(base.d, into?.d ?? 0),
    tx: lerp(base.tx, into?.tx ?? 0),
    ty: lerp(base.ty, into?.ty ?? 0),
    w: constant(1),
  };
}

/** `outer` after `inner`, which is `compose` in `scene.ts` with the two
 * denominators multiplied through. */
function onto(outer: AffineP, inner: AffineP): AffineP {
  const w = mul(outer.w, inner.w);

  return {
    a: add(mul(outer.a, inner.a), mul(outer.c, inner.b)),
    b: add(mul(outer.b, inner.a), mul(outer.d, inner.b)),
    c: add(mul(outer.a, inner.c), mul(outer.c, inner.d)),
    d: add(mul(outer.b, inner.c), mul(outer.d, inner.d)),
    tx: add(add(mul(outer.a, inner.tx), mul(outer.c, inner.ty)), mul(outer.tx, inner.w)),
    ty: add(add(mul(outer.b, inner.tx), mul(outer.d, inner.ty)), mul(outer.ty, inner.w)),
    w,
  };
}

/**
 * The frame a polygon rides over `[lo, hi]`, as polynomials in `s`.
 *
 * `riding` in `bake.ts`, one stage at a time and in the same order — the chain
 * stays a chain here for the same reason it does there.
 */
export function frameOn(r: Rider, lo: number, hi: number): AffineP {
  let m = onto(layerOn(r.layer, lo, hi), baseOn(r.base, r.into, lo, hi));

  for (const h of r.holders) m = onto(layerOn(h.layer, lo, hi), m);

  return m;
}

/** The frame read back at one instant, for tying this to `riding`. */
export function affineAt(m: AffineP, s: number): Affine {
  const w = at(m.w, s);

  return {
    a: at(m.a, s) / w,
    b: at(m.b, s) / w,
    c: at(m.c, s) / w,
    d: at(m.d, s) / w,
    tx: at(m.tx, s) / w,
    ty: at(m.ty, s) / w,
  };
}

/** A point of the span, placed: numerators over the frame's own `w`. */
interface PointP {
  x: Poly
  y: Poly
  w: Poly
}

function placedOn(p: Moving, lo: number, hi: number): PointP {
  const m = frameOn(p.rider, lo, hi);
  const t = span(lo, hi);

  const x = add(constant(p.from.x), scale(t, p.to.x - p.from.x));
  const y = add(constant(p.from.y), scale(t, p.to.y - p.from.y));

  return {
    x: add(add(mul(m.a, x), mul(m.c, y)), m.tx),
    y: add(add(mul(m.b, x), mul(m.d, y)), m.ty),
    w: m.w,
  };
}

/**
 * `cross(q2 - q1, p - q1)`, as one polynomial in `s` over `[0, 1]`.
 *
 * The denominators are dropped, and that is the whole trick: each of them is a
 * product of `1 + u²` terms, so each is positive everywhere, so the sign of this
 * is the sign of the incidence and its roots are the incidence's roots. What is
 * left is a polynomial of degree twelve for two ungrouped polygons, and four
 * more for each group holding one of them.
 *
 * Zero means the corner is on the edge's *line*. Whether it is on the segment is
 * `alongAt`, which the caller asks at each root rather than solving for — it is
 * a ratio of the same two numbers and there is nothing to search.
 */
export function incidenceOn(p: Moving, q1: Moving, q2: Moving, lo: number, hi: number): Poly {
  const P = placedOn(p, lo, hi);
  const A = placedOn(q1, lo, hi);
  const B = placedOn(q2, lo, hi);

  // Over a common denominator each, which is then thrown away.
  const ex = sub(mul(B.x, A.w), mul(A.x, B.w));
  const ey = sub(mul(B.y, A.w), mul(A.y, B.w));

  const fx = sub(mul(P.x, A.w), mul(A.x, P.w));
  const fy = sub(mul(P.y, A.w), mul(A.y, P.w));

  return sub(mul(ex, fy), mul(ey, fx));
}

/**
 * Every instant in `[0, 1]` at which `p` is on the line through `q1` and `q2`,
 * piece by piece and put back in `t`.
 *
 * Complete, which is the point: an interval that does not come back is one whose
 * incidence kept a strict sign across its whole Bernstein hull, and that is a
 * proof rather than a search that found nothing.
 */
export function incidentAt(p: Moving, q1: Moving, q2: Moving, eps = 1e-9): number[] {
  const cuts = [0, ...breaksIn(p, q1, q2), 1];
  const out: number[] = [];

  for (let i = 0; i + 1 < cuts.length; i++) {
    const lo = cuts[i], hi = cuts[i + 1];

    if (hi - lo <= 0) continue;

    for (const s of roots(incidenceOn(p, q1, q2, lo, hi), eps / (hi - lo))) {
      const t = lo + s * (hi - lo);

      if (out.length === 0 || t - out[out.length - 1] > eps) out.push(t);
    }
  }

  return out;
}

/**
 * How far along `q1 -> q2` the foot of `p` sits at `t`, which says whether an
 * incidence is on the segment or off the end of it.
 *
 * Evaluated rather than solved, at a root that is already in hand. Both terms
 * are the same rationals the incidence was built from.
 */
export function alongAt(p: Moving, q1: Moving, q2: Moving, t: number): number {
  const cuts = [0, ...breaksIn(p, q1, q2), 1];

  let i = 0;
  while (i + 2 < cuts.length && t > cuts[i + 1]) i++;

  const lo = cuts[i], hi = cuts[i + 1];
  const s = hi > lo ? (t - lo) / (hi - lo) : 0;

  const P = placedOn(p, lo, hi), A = placedOn(q1, lo, hi), B = placedOn(q2, lo, hi);

  const px = ratAt({ n: P.x, d: P.w }, s), py = ratAt({ n: P.y, d: P.w }, s);
  const ax = ratAt({ n: A.x, d: A.w }, s), ay = ratAt({ n: A.y, d: A.w }, s);
  const bx = ratAt({ n: B.x, d: B.w }, s), by = ratAt({ n: B.y, d: B.w }, s);

  const ux = bx - ax, uy = by - ay;
  const len = ux * ux + uy * uy;

  return len === 0 ? 0 : ((px - ax) * ux + (py - ay) * uy) / len;
}

// -----------------------------------------------------------------------------
// When three edges pass through one point
//
// The other condition, and the one the probe found by counting: a crossing does
// not only come and go by running off the end of one of its two edges. It can
// stay a crossing and stop being on the *outline*, because a third polygon's
// edge arrives over it and buries it — or leaves and exposes it. That is three
// edges through one point, and it is one change in six on the levels measured.
// `probe.test.ts` is where the counting is.
//
// It is a determinant, not a cross product. A point of the span is already
// homogeneous — `PointP` carries its own denominator — so the line through two
// of them is their cross product, and three lines meet exactly where the
// determinant of the three vanishes:
//
//   L_i = A_i x B_i,   det [L_1; L_2; L_3] = 0
//
// Nothing is divided anywhere in that, which is the whole reason to work in
// homogeneous coordinates here: the denominators the incidence had to be careful
// to cancel never appear, and a point at infinity — two edges going parallel,
// which is exactly the configuration that sends a crossing off at any speed —
// is an ordinary value rather than a division by nothing.
//
// The degree is 24 against the incidence's 12, and it is 24 for the same reason
// either is what it is: a line's first two coefficients carry one denominator
// and its third carries two, so every term of the determinant sums to the same
// 7 + 7 + 10. That is high enough to be worth checking rather than assuming, and
// `incident.test.ts` checks it the same way it checks the incidence — against a
// scan fine enough to have found anything that was missed.
// -----------------------------------------------------------------------------

/** Two ends of one moving edge. `Span` is taken, and means the whole interval
 * between two versions. */
export type Edge = [Moving, Moving];

/**
 * A line, homogeneous: `a x + b y + c w = 0`.
 *
 * Up to scale, like any homogeneous quantity, and nothing here depends on which
 * scale — the determinant vanishes or it does not.
 */
interface LineP {
  a: Poly
  b: Poly
  c: Poly
}

/** The line through two points of the span, as their cross product. */
function lineOn(p: PointP, q: PointP): LineP {
  return {
    a: sub(mul(p.y, q.w), mul(p.w, q.y)),
    b: sub(mul(p.w, q.x), mul(p.x, q.w)),
    c: sub(mul(p.x, q.y), mul(p.y, q.x)),
  };
}

/**
 * `det [e1; e2; e3]`, as one polynomial in `s` over `[0, 1]`: zero exactly where
 * the three edges' lines pass through one point.
 *
 * Their *lines*. Whether the meeting is inside all three segments is
 * `meetingWithin`, asked at each root rather than solved for — the same division
 * of labour `incidenceOn` and `alongAt` have.
 */
export function concurrenceOn(e1: Edge, e2: Edge, e3: Edge, lo: number, hi: number): Poly {
  const l = [e1, e2, e3].map(e => lineOn(placedOn(e[0], lo, hi), placedOn(e[1], lo, hi)));

  const minor = (i: number, j: number): Poly => {
    const rows = [0, 1, 2].filter(r => r !== i);
    const cols: ('a' | 'b' | 'c')[] = (['a', 'b', 'c'] as const).filter((_c, k) => k !== j);

    return sub(
      mul(l[rows[0]][cols[0]], l[rows[1]][cols[1]]),
      mul(l[rows[0]][cols[1]], l[rows[1]][cols[0]]),
    );
  };

  return add(
    sub(mul(l[0].a, minor(0, 0)), mul(l[0].b, minor(0, 1))),
    mul(l[0].c, minor(0, 2)),
  );
}

/**
 * Every instant in `[0, 1]` at which the three edges' lines pass through one
 * point, piece by piece and put back in `t`.
 *
 * Complete on the same terms as `incidentAt`: an interval that does not come
 * back kept a strict sign across its whole Bernstein hull, which is a proof.
 */
export function concurrentAt(e1: Edge, e2: Edge, e3: Edge, eps = 1e-9): number[] {
  const cuts = [0, ...breaksIn(...e1, ...e2, ...e3), 1];
  const out: number[] = [];

  for (let i = 0; i + 1 < cuts.length; i++) {
    const lo = cuts[i], hi = cuts[i + 1];

    if (hi - lo <= 0) continue;

    for (const s of roots(concurrenceOn(e1, e2, e3, lo, hi), eps / (hi - lo))) {
      const t = lo + s * (hi - lo);

      if (out.length === 0 || t - out[out.length - 1] > eps) out.push(t);
    }
  }

  return out;
}

/** Where a point of the span stands at one instant, by the route the
 * polynomials take rather than by `riding` — so a test can hold the two
 * against each other. */
export function pointAt(m: Moving, t: number): Point {
  const cuts = [0, ...breaksIn(m), 1];

  let i = 0;
  while (i + 2 < cuts.length && t > cuts[i + 1]) i++;

  const lo = cuts[i], hi = cuts[i + 1];
  const s = hi > lo ? (t - lo) / (hi - lo) : 0;
  const p = placedOn(m, lo, hi);

  return { x: ratAt({ n: p.x, d: p.w }, s), y: ratAt({ n: p.y, d: p.w }, s) };
}

/**
 * Whether three concurrent lines meet inside all three of their segments, and
 * where.
 *
 * Evaluated at a root that is already in hand. Null where the first two are
 * parallel, which at a root means all three are and there is no one point to be
 * inside anything.
 */
export function meetingWithin(e1: Edge, e2: Edge, e3: Edge, t: number): Point | null {
  const at = (e: Edge): [Point, Point] => [pointAt(e[0], t), pointAt(e[1], t)];
  const [a, b] = at(e1), [c, d] = at(e2);

  const ux = b.x - a.x, uy = b.y - a.y;
  const vx = d.x - c.x, vy = d.y - c.y;
  const det = ux * vy - uy * vx;

  if (det === 0) return null;

  const s = ((c.x - a.x) * vy - (c.y - a.y) * vx) / det;
  const p = { x: a.x + ux * s, y: a.y + uy * s };

  const inside = (e: Edge): boolean => {
    const [f, g] = at(e);
    const wx = g.x - f.x, wy = g.y - f.y;
    const len = wx * wx + wy * wy;

    if (len === 0) return false;

    const u = ((p.x - f.x) * wx + (p.y - f.y) * wy) / len;

    return u >= 0 && u <= 1;
  };

  return inside(e1) && inside(e2) && inside(e3) ? p : null;
}

// -----------------------------------------------------------------------------
// A corner whose ring is changing shape under it
//
// `Moving` says a vertex is a straight line in its own frame, and that covers a
// nudge alone and an erosion alone. Both at once it does not: the nudge turns the
// corner angle, the mitre turns with it, and the corner's path bends. That is the
// case `bake.ts` files under *Between events the geometry is not straight*, and
// nudging while eroding is the ordinary way to author.
//
// The bend is algebraic. A mitre corner is where the two offset lines meet, and
// scaling each row by the length it was divided by leaves `sqrt(e . e)` as the
// only irrational thing in it — one per edge, entering linearly. `surd.ts` is the
// arithmetic; this is the construction.
//
// What it costs is the term count. A corner carries two roots, an incidence
// touches three corners and so up to five distinct roots, and a cross product of
// those reaches every subset of them. So this is not the road for a ring that is
// holding still: `Moving` stays, and is what `seedsFor` reaches for wherever the
// two ends of the span have the same ring.
// -----------------------------------------------------------------------------

/**
 * One corner of a ring that is itself changing shape across the span.
 *
 * The whole ring rather than the corner, because a mitre is a fact about three
 * vertices — the corner and its two neighbours — and about the two edge lengths
 * between them. `at` picks which corner of it this is.
 */
export interface Turning {
  rider: Rider
  /** The source ring at each end of the span, index for index. */
  ring: [Ring, Ring]
  at: number
  /** The depth at that corner at each end. */
  depth: [number, number]
}

/** A point of the span with roots in it: homogeneous, so that a mitre whose two
 * edges have gone parallel is a point at infinity rather than a division by
 * nothing. */
export interface Bent {
  x: Surd
  y: Surd
  w: Surd
}

function by(base: Basis, s: Surd, p: Poly): Surd {
  return mulS(base, s, flat(p));
}

/**
 * Where a turning corner stands over `[lo, hi]`, homogeneous and with its two
 * roots in it.
 *
 * Cramer on
 *
 *   m_{i-1} . x = m_{i-1} . v + d L_{i-1}      m_i . x = m_i . v + d L_i
 *
 * which is the pair of offset lines with the normalisation multiplied back out.
 * `D` is the determinant of that pair and is the homogeneous weight — zero
 * exactly where the two edges are parallel, which is where the corner has no
 * mitre and `corners` in `geometry.ts` falls back to the wall's own normal.
 *
 * The winding is settled the way `erodedCorners` settles it, and has to be: the
 * inward normal of a clockwise ring is the other one, and a corner built off the
 * wrong one erodes outwards.
 */
export function bendingOn(c: Turning, lo: number, hi: number, base: Basis): Bent {
  const t = span(lo, hi);
  const n = c.ring[0].length;
  const flip = !isCCW(c.ring[0]);

  // Index into the ring as `erodedCorners` reads it, which is reversed where the
  // ring is clockwise. Corner `i` is still corner `i` at both ends of that.
  const k = (j: number): number => {
    const w = ((j % n) + n) % n;

    return flip ? n - 1 - w : w;
  };

  const px = (j: number): Poly =>
    add(constant(c.ring[0][k(j)].x), scale(t, c.ring[1][k(j)].x - c.ring[0][k(j)].x));
  const py = (j: number): Poly =>
    add(constant(c.ring[0][k(j)].y), scale(t, c.ring[1][k(j)].y - c.ring[0][k(j)].y));

  // The edge out of corner `j`, a quarter turn on, which is the inward normal
  // before it is divided by its own length.
  const turn = (j: number): { x: Poly, y: Poly, l: number } => {
    const ex = sub(px(j + 1), px(j)), ey = sub(py(j + 1), py(j));

    return {
      x: scale(ey, -1),
      y: ex,
      l: radicand(base, add(mul(ex, ex), mul(ey, ey))),
    };
  };

  const i = flip ? n - 1 - c.at : c.at;
  const a = turn(i - 1), b = turn(i);
  const vx = px(i), vy = py(i);

  const det = sub(mul(a.x, b.y), mul(a.y, b.x));
  // In `t` and not in `s`: the depth eases over the whole span, and a piece is
  // only part of it.
  const d = add(constant(c.depth[0]), scale(t, c.depth[1] - c.depth[0]));

  // The right-hand side, which is where the roots come in and the only place
  // they do.
  const r1 = add2(flat(add(mul(a.x, vx), mul(a.y, vy))), rooted(d, a.l));
  const r2 = add2(flat(add(mul(b.x, vx), mul(b.y, vy))), rooted(d, b.l));

  const x1 = subS(by(base, r1, b.y), by(base, r2, a.y));
  const x2 = subS(by(base, r2, a.x), by(base, r1, b.x));

  // Out to the world, which is rational and so joins as an ordinary coefficient.
  const f = frameOn(c.rider, lo, hi);

  return {
    x: add2(add2(by(base, x1, f.a), by(base, x2, f.c)), flat(mul(f.tx, det))),
    y: add2(add2(by(base, x1, f.b), by(base, x2, f.d)), flat(mul(f.ty, det))),
    w: flat(mul(f.w, det)),
  };
}

/**
 * `cross(q2 - q1, p - q1)`, with the roots kept.
 *
 * The same statement `incidenceOn` makes, in the arithmetic that can carry a
 * bending corner. The denominators are cleared the same way and dropped for the
 * same reason — each is a product of `1 + u²` terms and a mitre determinant, and
 * a determinant *can* vanish, which puts a root of its own here. Those are the
 * instants a corner has no mitre; `withinBent` throws them out by asking where
 * the corner actually is, which at one of them is nowhere.
 */
function bentIncidenceOn(
  p: Turning,
  q1: Turning,
  q2: Turning,
  lo: number,
  hi: number,
  base: Basis,
): Surd {
  const P = bendingOn(p, lo, hi, base);
  const A = bendingOn(q1, lo, hi, base);
  const B = bendingOn(q2, lo, hi, base);

  const cross = (ux: Surd, uy: Surd, vx: Surd, vy: Surd): Surd =>
    subS(mulS(base, ux, vy), mulS(base, uy, vx));

  const over = (u: Bent, v: Bent, which: 'x' | 'y'): Surd =>
    subS(mulS(base, u[which], v.w), mulS(base, v[which], u.w));

  return cross(
    over(B, A, 'x'), over(B, A, 'y'),
    over(P, A, 'x'), over(P, A, 'y'),
  );
}

/**
 * Every instant in `[0, 1]` at which a bending corner is on the line through two
 * others, piece by piece and put back in `t`.
 *
 * Complete on the same terms as `incidentAt`, and looser: the bound a sum of
 * terms carries overestimates, so more intervals survive to be split. What comes
 * back is still every root and never a claim that an interval is empty when it is
 * not.
 *
 * Not wired into `seedsFor`, and this is the reason rather than an oversight.
 * Steering the bisection by these roots does cut the work — a nudged polygon
 * eroding into a neighbour went from 136 stretches and 582 evaluations to 94 and
 * 414 — and it took `worst` from 0.0193 to 0.3952, which is eight times
 * `TOLERANCE`. Filtering the roots that are not incidences at all (`withinBent`)
 * recovered most of the stretches and none of the error: `worst` came back at
 * 0.39517031766278166 to every digit under three different gates, so it is one
 * fixed instant rather than a sampling accident, and it is not the acceptance
 * check either — raising its samples twenty-fold moved nothing.
 *
 * Which is a mechanism nobody has found yet, so the roots stay unused. They are
 * right: `incident.test.ts` holds them against a scan of twenty thousand steps,
 * and holds the corner they are taken of against `erodedCorners` itself. What is
 * missing is an account of what goes wrong downstream of them.
 */
export function bentAt(p: Turning, q1: Turning, q2: Turning, eps = 1e-9): number[] {
  const cuts = [0, ...breaksIn(p, q1, q2), 1];
  const out: number[] = [];

  for (let i = 0; i + 1 < cuts.length; i++) {
    const lo = cuts[i], hi = cuts[i + 1];

    if (hi - lo <= 0) continue;

    const base = basis();
    const f = bentIncidenceOn(p, q1, q2, lo, hi, base);

    for (const s of rootsS(base, f, eps / (hi - lo))) {
      const t = lo + s * (hi - lo);

      if (out.length === 0 || t - out[out.length - 1] > eps) out.push(t);
    }
  }

  return out;
}

/**
 * Where a turning corner stands at one instant, by the route the bake and the
 * game take.
 *
 * `erodedCorners` and not the mitre written out again: it is the authority on
 * where an eroded corner goes, winding and hairpins and all, and holding the
 * algebra against it is the only way to know the algebra is the same corner.
 */
export function turningAt(c: Turning, t: number): Point {
  const lerp = (u: number, v: number): number => u + (v - u) * t;

  const ring = c.ring[0].map((p, i) => ({
    x: lerp(p.x, c.ring[1][i].x),
    y: lerp(p.y, c.ring[1][i].y),
  }));

  const moved = erodedCorners(ring, lerp(c.depth[0], c.depth[1]));

  return place(riding(c.rider, t), [moved[c.at]])[0];
}

/**
 * How far along `q1 -> q2` the foot of `p` sits, for three bending corners — or
 * null where this root is not an incidence at all.
 *
 * Two ways it might not be. The determinant of a corner's own mitre is a factor
 * of the condition, so an instant where a corner's two edges go parallel and it
 * has no mitre is a root of the polynomial and nothing at all on the ground; and
 * `roots` reports an interval it could not clear rather than dropping it, so a
 * bound too loose to settle comes back as a root too. Both are thrown out the
 * same way: by asking what the incidence actually *is* here.
 *
 * That check is the one thing between the algebra and the bake. Left out, these
 * came through as seeds, the bisection was steered to instants where nothing was
 * happening, and a nudged polygon eroding into a neighbour came back with a
 * `worst` of 0.40 against the 0.02 that halving alone gave it.
 */
export function withinBent(p: Turning, q1: Turning, q2: Turning, t: number): number | null {
  const a = turningAt(p, t), b = turningAt(q1, t), c = turningAt(q2, t);

  if (![a, b, c].every(v => Number.isFinite(v.x) && Number.isFinite(v.y))) return null;

  const ux = c.x - b.x, uy = c.y - b.y;
  const len = Math.hypot(ux, uy);

  if (len === 0) return null;

  // How far off the line the corner actually is, as a distance rather than as an
  // area, so it is comparable with the geometry it came from.
  const off = Math.abs(ux * (a.y - b.y) - uy * (a.x - b.x)) / len;
  const reach = Math.max(len, Math.hypot(a.x - b.x, a.y - b.y));

  if (off > reach * 1e-6) return null;

  return ((a.x - b.x) * ux + (a.y - b.y) * uy) / (len * len);
}
