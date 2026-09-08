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
import { Rider, pivot } from './bake';
import { Poly, add, at, constant, linear, mul, ratAt, roots, scale, sub } from './poly';
import { Affine } from './scene';
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
export function breaksIn(...movers: Moving[]): number[] {
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
