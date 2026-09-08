// -----------------------------------------------------------------------------
// Polynomials, and where they cross zero
//
// Small and dense, lowest power first, because everything here is a degree the
// span can name in advance: a frame is degree four over degree two, a placed
// point one more than that, and an incidence twelve. Nothing is sparse and
// nothing is big enough to want anything cleverer than an array.
//
// Roots in the Bernstein basis
// ----------------------------
// A polynomial written in the Bernstein basis on an interval has the *convex
// hull property*: the curve lies inside the hull of its coefficients, so
// coefficients that are all one sign are a proof that there is no root in that
// interval. That is the half nothing else gives. A sampled search can say "I
// looked and found nothing", and the bake has had to live with that; this says
// "there is nothing here", which is what makes an analytic cut a cut rather
// than a hope.
//
// The isolation is plain bisection on that test — de Casteljau at the midpoint,
// recurse into the halves that could still hold a root. Bezier clipping would
// take the hull's own crossing instead of the midpoint and converge quadratically
// rather than linearly; it is the same test underneath and worth having if this
// ever runs anywhere hot. It does not yet.
//
// The conversion from powers to Bernstein is exact in exact arithmetic and is
// not in doubles: the binomial ratios reach about 2^12 at the degrees here, so a
// coefficient near zero can come out with the wrong sign. `ZERO` is the width of
// that doubt, and a coefficient inside it counts as "could be either", which
// costs a subdivision that was not needed and never loses a root.
// -----------------------------------------------------------------------------

/** Dense, lowest power first. `[1, 0, 2]` is `1 + 2s²`. */
export type Poly = number[];

export function constant(k: number): Poly {
  return k === 0 ? [] : [k];
}

/** `a + b s`, the shape most of what follows is built out of. */
export function linear(a: number, b: number): Poly {
  return trimmed([a, b]);
}

export function add(p: Poly, q: Poly): Poly {
  const out: Poly = [];

  for (let i = 0; i < Math.max(p.length, q.length); i++) out.push((p[i] ?? 0) + (q[i] ?? 0));

  return trimmed(out);
}

export function sub(p: Poly, q: Poly): Poly {
  const out: Poly = [];

  for (let i = 0; i < Math.max(p.length, q.length); i++) out.push((p[i] ?? 0) - (q[i] ?? 0));

  return trimmed(out);
}

export function mul(p: Poly, q: Poly): Poly {
  if (p.length === 0 || q.length === 0) return [];

  const out = new Array<number>(p.length + q.length - 1).fill(0);

  for (let i = 0; i < p.length; i++) {
    for (let j = 0; j < q.length; j++) out[i + j] += p[i] * q[j];
  }

  return trimmed(out);
}

export function scale(p: Poly, k: number): Poly {
  return k === 0 ? [] : trimmed(p.map(c => c * k));
}

export function at(p: Poly, s: number): number {
  let out = 0;

  for (let i = p.length - 1; i >= 0; i--) out = out * s + p[i];

  return out;
}

/** Trailing zeros carry no information and make every degree here a lie. */
function trimmed(p: Poly): Poly {
  let n = p.length;

  while (n > 0 && p[n - 1] === 0) n--;

  return n === p.length ? p : p.slice(0, n);
}

/**
 * The same polynomial in the Bernstein basis on `[0, 1]`.
 *
 * `b[j] = sum_{i <= j} C(j, i) / C(n, i) * a[i]`, which is the standard change
 * of basis and is what the hull test needs.
 */
export function bernstein(p: Poly): number[] {
  const n = Math.max(0, p.length - 1);
  const c = binomials(n);
  const out: number[] = [];

  for (let j = 0; j <= n; j++) {
    let sum = 0;

    for (let i = 0; i <= j; i++) sum += (c[j][i] / c[n][i]) * (p[i] ?? 0);

    out.push(sum);
  }

  return out;
}

function binomials(n: number): number[][] {
  const rows: number[][] = [[1]];

  for (let i = 1; i <= n; i++) {
    const prev = rows[i - 1];
    const row = [1];

    for (let j = 1; j < i; j++) row.push(prev[j - 1] + prev[j]);

    row.push(1);
    rows.push(row);
  }

  return rows;
}

/** How near zero a Bernstein coefficient has to be, against the size of the
 * polynomial it belongs to, before its sign is not evidence. See the note on
 * the conversion at the top. */
const ZERO = 1e-9;

/** More roots than this in one interval is a polynomial that is numerically
 * flat on zero rather than one with that many crossings. Stop rather than
 * subdivide the whole interval to `eps`. */
const MOST = 64;

/**
 * Every root of `p` in `[0, 1]`, to within `eps`.
 *
 * Complete: an interval left out is one whose Bernstein coefficients were all
 * strictly one sign, and no polynomial does that with a root inside. Everything
 * else is split until it is thinner than `eps` and then reported, so a grazing
 * touch and a crossing come back the same way — which is what the caller wants
 * of a corner that reaches an edge and turns back without passing through it.
 *
 * Roots are returned in order and no two are nearer than `eps`.
 */
export function roots(p: Poly, eps = 1e-9): number[] {
  const size = Math.max(...p.map(Math.abs), 0);

  if (size === 0) return [];

  const norm = scale(p, 1 / size);
  const out: number[] = [];

  const walk = (b: number[], lo: number, hi: number): void => {
    if (out.length > MOST) return;

    // Strictly one sign across the whole hull is a proof there is no root here,
    // and it is the only proof available. Everything else is a maybe and is
    // split — including a hull that is positive but touches zero, which is
    // exactly what a subdivision landing on a root looks like.
    if (b.every(c => c > ZERO) || b.every(c => c < -ZERO)) return;

    if (hi - lo <= eps) {
      out.push((lo + hi) / 2);

      return;
    }

    const [left, right] = split(b);
    const mid = (lo + hi) / 2;

    walk(left, lo, mid);
    walk(right, mid, hi);
  };

  walk(bernstein(norm), 0, 1);

  return merged(out, eps);
}

/** De Casteljau at the midpoint: the same curve over each half. */
function split(b: number[]): [number[], number[]] {
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

/** Two halves either side of a root both report it. */
function merged(xs: number[], eps: number): number[] {
  const out: number[] = [];

  for (const x of xs) {
    if (out.length === 0 || x - out[out.length - 1] > eps * 4) out.push(x);
  }

  return out;
}

// -----------------------------------------------------------------------------
// Rationals
//
// A ratio of two polynomials, with the denominator kept positive across the
// interval by construction rather than by checking: everything that ever lands
// in one here is a product of `1 + u²` terms. So a root of the ratio is a root
// of its numerator, and that is the whole reason the numerator is the only
// thing the isolation is ever handed.
// -----------------------------------------------------------------------------

export interface Ratio {
  n: Poly
  d: Poly
}

export function ratio(n: Poly, d: Poly): Ratio {
  return { n, d };
}

export function ratAt(r: Ratio, s: number): number {
  return at(r.n, s) / at(r.d, s);
}
