// -----------------------------------------------------------------------------
// An effect is a ring to a ring
//
// The design of `PLAN-effect`, one step in. An effect is a function from a
// shape to a shape carrying identity, a scope is the fold of its members'
// through its own, and a point that comes out the far end knows what it came
// of because of how it was made rather than because something matched it to
// something.
//
// `Drawn` ties a shape to its names and is what an effect takes and gives
// back, which is the plan's `(shape, ids) => { shape, ids }` with its two
// halves held together so that a fold of them is a `reduce` and nothing else.
//
// Its type is shape to *shape*: an erosion closes a notch, splits a ring, kills
// a ring outright, so points are born and they die. A born point is born of an
// identified pair and exists exactly while that pair crosses, which is the
// whole of what the bake needs from it.
// -----------------------------------------------------------------------------

import type { Shape, Sweptfrom } from './geometry';
import { OpSubtract, OpUnion, simplify, sweptBand } from './geometry';
import type { Drawn, Ident, Ids } from './ids';
import { combineIdentified, on } from './ids';

/** A shape to a shape, carrying identity. */
export type Effect = (it: Drawn) => Drawn

/**
 * The erosion, as an effect.
 *
 * The same offset `erode` takes and not a second one: the band the boundary
 * sweeps on its way in, taken away from the shape. What is added is the names.
 * The band is built out of corners of the source and the places those corners
 * moved to, so every point of it *is* one of them — a moved corner is the
 * corner it moved from, there being no other thing it could be — and the
 * arrangement between shape and band then names its own output for us:
 *
 * - a corner the erosion did not consume keeps the name it came in with;
 * - a corner it pushed inwards is that same corner, at its new place;
 * - a corner the erosion *made*, where two walls' bands crossed or where a
 *   band cut a wall, is `born` of the two walls that made it — and it exists
 *   exactly as long as they cross.
 *
 * Nothing is matched within a tolerance anywhere in that, which is the rule
 * the whole design turns on.
 *
 * A negative depth grows the shape instead, and the band goes on the other side
 * and is added; both halves run where a depth per corner changed sign, which is
 * why they are both here rather than one branch of an `if`.
 */
export function eroding(depth: number): Effect {
  return it => {
    if (depth === 0) return it;

    const shape = simplify(it.shape);
    const band = sweptBand(shape, depth);

    const side = (shape: Shape, from: Sweptfrom[][], along: Sweptfrom[][]): Drawn => ({
      shape,
      ids: from.map(ring => ring.map(w => nameOf(it.ids, w))),
      edges: along.map(ring => ring.map(w => nameOf(it.ids, w))),
    });

    let out: Drawn = { shape, ids: it.ids };

    if (band.inward.length > 0) {
      out = combineIdentified(out, side(band.inward, band.inwardFrom, band.inwardAlong), OpSubtract);
    }

    if (band.outward.length > 0) {
      out = combineIdentified(out, side(band.outward, band.outwardFrom, band.outwardAlong), OpUnion);
    }

    return out;
  };
}

/** The name of the corner a band point came of, or of the place along its wall
 * where a changing depth crossed zero. */
function nameOf(ids: Ids, w: Sweptfrom): Ident {
  const id = ids[w.ring]?.[w.index];

  if (id === undefined) throw new Error(`no identity for ${w.ring}.${w.index}`);

  return w.t === undefined ? id : on(id, w.t);
}
