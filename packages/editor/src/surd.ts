// -----------------------------------------------------------------------------
// Polynomials with square roots in them
//
// `incident.ts` can solve for a corner reaching an edge because an eroded corner
// travels in a straight line in its own frame: the mitre's direction is fixed by
// the ring's shape, so a depth eased linearly puts the corner at exactly the lerp
// of its two ends. Nudge the ring while it erodes and that stops being true. The
// corner angle turns, the mitre turns with it, and the path bends.
//
// It bends algebraically, though, and the algebra is small. A mitre corner is
// where the two offset lines meet:
//
//   n_{i-1} . x = n_{i-1} . v + d        n_i . x = n_i . v + d
//
// with `n_j` the unit normal of edge `j`. Multiply each row through by the length
// it was divided by and the unit vectors go away:
//
//   m_{i-1} . x = m_{i-1} . v + d L_{i-1}    m_i . x = m_i . v + d L_i
//
// where `m_j` is the edge turned a quarter turn — a polynomial — and `L_j` is
// `sqrt(e_j . e_j)`, the square root of a quadratic. Cramer's rule then gives the
// corner as `(A + B L_{i-1} + C L_i) / D` with `A`, `B`, `C`, `D` polynomials.
// **Linear in each root, and no product of the two.** That is the whole reason
// this is tractable: the irrational part of an eroded corner is two square roots
// entering as plainly as they can.
//
// Why not square them out
// -----------------------
// An incidence is a cross product of differences of three such corners, and it
// touches up to five distinct roots — two per corner, with neighbours sharing.
// Clearing them by squaring multiplies the degree by 2^5 and invents roots that
// then have to be filtered back out. A degree-24 determinant is already near what
// doubles will carry in the Bernstein basis; seven hundred is not.
//
// So they are kept. An element is a sum of terms, each a polynomial times a
// product of distinct roots, and multiplying two of them merges the two products
// and turns each shared root into its own radicand. Exact, closed, and about
// thirty lines.
//
// Bounding one
// ------------
// Isolation needs a bound rather than a formula, and a sum of terms has an
// obvious one: bound each coefficient by its Bernstein hull, bound each root by
// the square root of its radicand's hull, multiply and add. That is interval
// arithmetic over the terms, so it overestimates — the same `t` appears in every
// term and the bound does not know it — but it is a *bound*, so an interval it
// puts strictly one side of zero holds no root. Which is the property the whole
// exercise is for.
//
// Overestimation costs subdivisions, not correctness, and it shrinks with the
// interval. An element with one term and no roots in it is an ordinary
// polynomial, its bound is exactly the Bernstein hull, and this is then the
// isolation in `poly.ts` with more ceremony.
// -----------------------------------------------------------------------------

import { Poly, add as addP, bernstein, mul as mulP, scale as scaleP, sub as subP } from './poly';

/** One term: a polynomial, times the square roots of the radicands named. The
 * names are indices into a `Basis`, ascending and distinct. */
export interface Term {
  c: Poly
  r: readonly number[]
}

/** A sum of terms. */
export type Surd = Term[];

/**
 * The radicands in play, shared by everything built against it.
 *
 * Held apart from the elements so that two corners of one ring can say they mean
 * the *same* square root — which they do, since they share an edge, and which is
 * what keeps the term count down to something a bound can be taken over.
 */
export interface Basis {
  q: Poly[]
}

export function basis(): Basis {
  return { q: [] };
}

/** The index of `q` in the basis, adding it if it is not already there. Compared
 * by coefficients: the same edge reached twice is the same root. */
export function radicand(b: Basis, q: Poly): number {
  for (let i = 0; i < b.q.length; i++) {
    if (b.q[i].length === q.length && b.q[i].every((c, k) => c === q[k])) return i;
  }

  b.q.push(q);

  return b.q.length - 1;
}

/** A polynomial, as an element with nothing irrational in it. */
export function flat(p: Poly): Surd {
  return p.length === 0 ? [] : [{ c: p, r: [] }];
}

/** `p` times the square root of the radicand `i`. */
export function rooted(p: Poly, i: number): Surd {
  return p.length === 0 ? [] : [{ c: p, r: [i] }];
}

function key(r: readonly number[]): string {
  return r.join(',');
}

/** Terms over the same product of roots, gathered. */
function tidy(terms: Surd): Surd {
  const by = new Map<string, Term>();

  for (const t of terms) {
    if (t.c.length === 0) continue;

    const k = key(t.r);
    const had = by.get(k);

    by.set(k, had === undefined ? t : { c: addP(had.c, t.c), r: t.r });
  }

  return [...by.values()].filter(t => t.c.length > 0);
}

export function add(a: Surd, b: Surd): Surd {
  return tidy([...a, ...b]);
}

export function sub(a: Surd, b: Surd): Surd {
  return tidy([...a, ...b.map(t => ({ c: scaleP(t.c, -1), r: t.r }))]);
}

/**
 * The product, with every root that appears twice turned back into its radicand.
 *
 * `L_j L_j = Q_j`, so a root shared by the two terms leaves the product and its
 * radicand joins the coefficient. What is left is the symmetric difference, which
 * is why the term count stays bounded by the number of distinct roots rather than
 * growing with the multiplications.
 */
export function mul(base: Basis, a: Surd, b: Surd): Surd {
  const out: Surd = [];

  for (const p of a) {
    for (const q of b) {
      let c = mulP(p.c, q.c);
      const r: number[] = [];

      for (const i of p.r) {
        if (q.r.includes(i)) c = mulP(c, base.q[i]);
        else r.push(i);
      }

      for (const i of q.r) if (!p.r.includes(i)) r.push(i);

      out.push({ c, r: r.sort((x, y) => x - y) });
    }
  }

  return tidy(out);
}

// -----------------------------------------------------------------------------
// Isolating
// -----------------------------------------------------------------------------

/** An element over one interval, everything in the Bernstein basis so that a
 * hull is a scan and a subdivision is de Casteljau. */
interface Node {
  t: { b: number[], r: readonly number[] }[]
  q: number[][]
}

function nodeOf(base: Basis, s: Surd): Node {
  return { t: s.map(x => ({ b: bernstein(x.c), r: x.r })), q: base.q.map(bernstein) };
}

/** De Casteljau at the midpoint, over every array the node holds. */
function halve(b: number[]): [number[], number[]] {
  const work = [...b];
  const left: number[] = [work[0]];
  const right: number[] = [work[work.length - 1]];

  for (let k = 1; k < b.length; k++) {
    for (let i = 0; i < b.length - k; i++) work[i] = (work[i] + work[i + 1]) / 2;

    left.push(work[0]);
    right.unshift(work[b.length - 1 - k]);
  }

  return [left, right];
}

function split(n: Node): [Node, Node] {
  const t = n.t.map(x => ({ h: halve(x.b), r: x.r }));
  const q = n.q.map(halve);

  return [
    { t: t.map(x => ({ b: x.h[0], r: x.r })), q: q.map(x => x[0]) },
    { t: t.map(x => ({ b: x.h[1], r: x.r })), q: q.map(x => x[1]) },
  ];
}

/** What the element can reach over the node's interval. */
function range(n: Node): [number, number] {
  // The square root of a radicand's own hull. Clamped at zero: a radicand is a
  // sum of two squares and cannot be negative, so anything below zero here is
  // the hull's own slack.
  const root = n.q.map((b) => {
    const lo = Math.min(...b), hi = Math.max(...b);

    return [Math.sqrt(Math.max(0, lo)), Math.sqrt(Math.max(0, hi))] as const;
  });

  let lo = 0, hi = 0;

  for (const term of n.t) {
    let a = Math.min(...term.b), z = Math.max(...term.b);

    for (const i of term.r) {
      const [rl, rh] = root[i];
      const corners = [a * rl, a * rh, z * rl, z * rh];

      a = Math.min(...corners);
      z = Math.max(...corners);
    }

    lo += a;
    hi += z;
  }

  return [lo, hi];
}

/** How near zero a bound has to sit, against the size of what it bounds, before
 * its sign stops being evidence. `poly.ts` has the same, for the same reason. */
const ZERO = 1e-9;

/** More than this in one interval is an element that is numerically flat on
 * zero rather than one with that many crossings. */
const MOST = 64;

/**
 * Every root in `[0, 1]`, to within `eps`.
 *
 * Complete on the same terms as `roots` in `poly.ts`, and for the same reason: an
 * interval left out is one whose *bound* stayed strictly one side of zero, and a
 * bound is a bound. The difference is only how much is left out — an interval
 * bound over terms overestimates, so more intervals survive to be split than a
 * Bernstein hull alone would leave.
 */
export function roots(base: Basis, s: Surd, eps = 1e-9): number[] {
  if (s.length === 0) return [];

  // Against the size of the element, so `ZERO` means something.
  let size = 0;

  for (const t of s) for (const c of t.c) size = Math.max(size, Math.abs(c));

  if (size === 0) return [];

  const norm = s.map(t => ({ c: scaleP(t.c, 1 / size), r: t.r }));
  const out: number[] = [];

  const walk = (n: Node, lo: number, hi: number): void => {
    if (out.length > MOST) return;

    const [a, z] = range(n);

    if (a > ZERO || z < -ZERO) return;

    if (hi - lo <= eps) {
      out.push((lo + hi) / 2);

      return;
    }

    const [left, right] = split(n);
    const mid = (lo + hi) / 2;

    walk(left, lo, mid);
    walk(right, mid, hi);
  };

  walk(nodeOf(base, norm), 0, 1);

  const merged: number[] = [];

  for (const x of out) {
    if (merged.length === 0 || x - merged[merged.length - 1] > eps * 4) merged.push(x);
  }

  return merged;
}

/** The element at one instant, roots and all. For tying the algebra to the
 * arithmetic it stands for. */
export function at(base: Basis, s: Surd, x: number): number {
  const ev = (p: Poly): number => {
    let out = 0;

    for (let i = p.length - 1; i >= 0; i--) out = out * x + p[i];

    return out;
  };

  let sum = 0;

  for (const t of s) {
    let v = ev(t.c);

    for (const i of t.r) v *= Math.sqrt(Math.max(0, ev(base.q[i])));

    sum += v;
  }

  return sum;
}

export { subP as subPoly, addP as addPoly, mulP as mulPoly };
