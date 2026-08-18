// -----------------------------------------------------------------------------
// Interval arithmetic
//
// Every operation returns a range guaranteed to *contain* the true range of its
// result over the inputs. Containment is the only property that matters here:
// it is what lets a search discard a stretch of `t` outright, having proved
// that the function cannot reach zero anywhere inside it.
//
// The ranges are wider than the truth, sometimes much wider, because `t`
// appears more than once in an expression and the arithmetic cannot know that
// the two occurrences move together. That costs extra subdivision and nothing
// else: over-wide is safe, too narrow would not be.
//
// A degenerate interval is an ordinary number, so the same expression evaluates
// exactly when handed `at(x)`.
// -----------------------------------------------------------------------------

export interface Iv {
  lo: number
  hi: number
}

export function iv(lo: number, hi: number): Iv {
  return { lo, hi };
}

/** The number itself, as a range with no width. */
export function at(x: number): Iv {
  return { lo: x, hi: x };
}

export function add(a: Iv, b: Iv): Iv {
  return { lo: a.lo + b.lo, hi: a.hi + b.hi };
}

export function sub(a: Iv, b: Iv): Iv {
  return { lo: a.lo - b.hi, hi: a.hi - b.lo };
}

export function mul(a: Iv, b: Iv): Iv {
  const p = a.lo * b.lo, q = a.lo * b.hi, r = a.hi * b.lo, s = a.hi * b.hi;

  return {
    lo: Math.min(p, q, r, s),
    hi: Math.max(p, q, r, s),
  };
}

export function width(a: Iv): number {
  return a.hi - a.lo;
}

/** Whether zero is anywhere in the range — whether a root is still possible. */
export function holdsZero(a: Iv): boolean {
  return a.lo <= 0 && a.hi >= 0;
}

const TAU = Math.PI * 2;

/**
 * The endpoints bound cosine except where a peak or a trough falls inside, so
 * those are the only extra cases to look for.
 */
export function cos(a: Iv): Iv {
  if (a.hi - a.lo >= TAU) return { lo: -1, hi: 1 };

  const k = Math.floor(a.lo / TAU);
  const lo = a.lo - k * TAU, hi = a.hi - k * TAU;

  let min = Math.min(Math.cos(lo), Math.cos(hi));
  let max = Math.max(Math.cos(lo), Math.cos(hi));

  // `lo` is in [0, TAU), so `hi` is below 2·TAU and only these can be inside.
  if (hi >= TAU) max = 1;
  if (lo <= Math.PI && Math.PI <= hi) min = -1;
  if (3 * Math.PI <= hi) min = -1;

  return { lo: min, hi: max };
}

export function sin(a: Iv): Iv {
  return cos(sub(a, at(Math.PI / 2)));
}
