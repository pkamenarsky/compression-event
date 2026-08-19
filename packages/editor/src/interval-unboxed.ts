// -----------------------------------------------------------------------------
// Interval arithmetic without the objects
//
// NOT IN USE. `interval.ts` is what the event search runs on, and it should
// stay that way until a measurement says otherwise. This file exists so that
// the measurement, and the rewrite it would justify, are not work that has to
// be done twice.
//
// Why it exists
// -------------
// Every operation in `interval.ts` returns a fresh `{ lo, hi }`. One evaluation
// of `vertexOnEdge` runs `place` three times at around twenty operations each,
// so it allocates something like sixty short-lived objects, and that — not the
// arithmetic — is where its time goes. Measured on the real `vertexOnEdge`:
//
//     boxed, as it stands                          1069 ns/eval
//     boxed, edge frame shared by its two ends       875 ns/eval
//     unboxed, frame shared                          162 ns/eval
//
// The frame sharing is landed in `events.ts` because it is a plain redundancy
// and reads better for being fixed. The unboxing is not, because it costs the
// readable API for a saving that does not currently matter: with the closed
// form taking every pair that has no relative rotation, a ten-version bake of a
// ten-thousand-polygon world sits at a few seconds either way. Reach for this
// when a real world says that is wrong.
//
// How it works
// ------------
// A JavaScript function cannot return two numbers without allocating, so the
// results come back in module-level registers instead. Every operation here
// writes `rlo` and `rhi`, and the caller copies them out before the next call:
//
//     mul(alo, ahi, blo, bhi);
//     const clo = rlo, chi = rhi;
//
// That convention is the entire cost of the approach. It is not a drop-in
// replacement for `interval.ts` and it cannot be made into one — the exports
// have a different shape on purpose.
//
// How to switch over
// ------------------
// The work is in `events.ts`, not here, and it is confined to three functions:
//
//   1. `riding` builds its five intervals into a `Float64Array(10)` rather than
//      an object — a preallocated one per polygon, since the search reuses it
//      at every `t` it visits.
//   2. `place` writes its result into four module-level registers of its own
//      rather than returning `{ x, y }`, in the same style as below.
//   3. `vertexOnEdge` copies each of the three placed points out into locals
//      before placing the next, and finishes with two `mul` calls and a `sub`.
//
// `events` itself needs one change: `holdsZero` and the `flat` test read `rlo`
// and `rhi` instead of a returned interval, so the `f` it is handed becomes
// `(lo, hi) => void` rather than `(t: Iv) => Iv`.
//
// Keep `interval.ts` either way. It is what `interval.test.ts` and the
// completeness properties are written against, and the cheapest guard on a
// rewrite like this is a test that runs both over the same inputs and requires
// the answers to agree.
//
// What not to bother with
// -----------------------
// Two things measured as noise once the call sites were monomorphic, and are
// left out for being complications that buy nothing: replacing the four-argument
// `Math.min`/`Math.max` in `mul` with explicit comparisons, and giving
// `interval x plain number` its own two-multiply path. The one real trap in
// benchmarking this is passing a variant as a parameter — that makes the call
// site polymorphic, blocks inlining, and reports the faster version as slower.
// -----------------------------------------------------------------------------

/** Where every operation below leaves its answer. */
export let rlo = 0;
export let rhi = 0;

export function add(alo: number, ahi: number, blo: number, bhi: number): void {
  rlo = alo + blo;
  rhi = ahi + bhi;
}

export function sub(alo: number, ahi: number, blo: number, bhi: number): void {
  rlo = alo - bhi;
  rhi = ahi - blo;
}

export function mul(alo: number, ahi: number, blo: number, bhi: number): void {
  const p = alo * blo, q = alo * bhi, r = ahi * blo, s = ahi * bhi;

  rlo = Math.min(p, q, r, s);
  rhi = Math.max(p, q, r, s);
}

/**
 * `u + (v - u)·t`, which is what interpolating a component comes to. Written
 * out rather than composed from `mul` and `add` because the slope is a plain
 * number: its sign decides which end goes where, and that is two multiplies
 * instead of four and a sort.
 */
export function lerp(u: number, v: number, tlo: number, thi: number): void {
  const d = v - u;

  if (d >= 0) {
    rlo = u + d * tlo;
    rhi = u + d * thi;
  }
  else {
    rlo = u + d * thi;
    rhi = u + d * tlo;
  }
}

const TAU = Math.PI * 2;

/** The endpoints bound cosine except where a peak or a trough falls inside, so
 * those are the only extra cases to look for. Mirrors `cos` in `interval.ts`. */
export function cos(alo: number, ahi: number): void {
  if (ahi - alo >= TAU) {
    rlo = -1;
    rhi = 1;

    return;
  }

  const k = Math.floor(alo / TAU);
  const lo = alo - k * TAU, hi = ahi - k * TAU;
  const cl = Math.cos(lo), ch = Math.cos(hi);

  let min = cl < ch ? cl : ch;
  let max = cl > ch ? cl : ch;

  // `lo` is in [0, TAU), so `hi` is below 2·TAU and only these can be inside.
  if (hi >= TAU) max = 1;
  if (lo <= Math.PI && Math.PI <= hi) min = -1;
  if (3 * Math.PI <= hi) min = -1;

  rlo = min;
  rhi = max;
}

export function sin(alo: number, ahi: number): void {
  cos(alo - Math.PI / 2, ahi - Math.PI / 2);
}

/** Whether zero is anywhere in the range — whether a root is still possible. */
export function holdsZero(lo: number, hi: number): boolean {
  return lo <= 0 && hi >= 0;
}
