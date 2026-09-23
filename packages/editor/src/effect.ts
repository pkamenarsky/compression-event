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

import type { Point } from '@ce/game/world';
import type { Shape, Sweptfrom } from './geometry';
import { OpSubtract, OpUnion, along, simplify, sweptBand } from './geometry';
import type { Drawn, Ident, Ids } from './ids';
import { combineIdentified, madeOf, on, shows } from './ids';

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

// -----------------------------------------------------------------------------
// The canonical resample
// -----------------------------------------------------------------------------

/**
 * A ring laid out again at accuracy `eps`, so that how many points it has is a
 * question about the geometry and `eps` and not about how many effects have run
 * over it.
 *
 * This is what the bake needs across a span and what a pile of machinery under
 * `arcsWith` exists to patch around today. Two evaluations of the same world a
 * moment apart hand back rings, and if the number of points in one depends on
 * the order and count of the effects that made it, nothing downstream can line
 * the two up.
 *
 * **What may be moved and what may not.** A point named `corner` or `born` is a
 * feature: the boundary genuinely turns there, and it turns there because of
 * something the construction did. Those stay, at the place they are, and the
 * resample only ever works *between* them. A point named `on` is the opposite:
 * something put it along a run to describe a curve, and where exactly it sits
 * is an accident of the effect that laid it. Those are the ones that go.
 *
 * So the rule is read off the identity itself and not off an angle or a
 * distance — which is the design's one rule, in the one place it would be most
 * tempting to classify a point by looking at it.
 *
 * **Between two anchors**, the run is laid again at `n` equal steps of arc
 * length, `n` the least power of two whose chords stay within `eps` of the run
 * they replace. A straight run takes `n` of 1 and comes back with nothing
 * between its ends; an arc takes the `n` its radius and angle and `eps` ask
 * for, whether it arrived as eight points or eighty. Powers of two because `n`
 * then changes rarely and by a step that is visible when it happens, rather
 * than creeping by one every few frames as a run grows.
 *
 * It never emits more points than it was handed, so a ring cannot grow under a
 * fold however deep the nesting goes.
 */
export function resampled(it: Drawn, eps: number): Drawn {
  const shape: Shape = [];
  const ids: Ids = [];

  it.shape.forEach((ring, r) => {
    const names = it.ids[r];
    const held = anchorsOf(names);

    if (ring.length < 3 || held.length === 0) {
      shape.push(ring);
      ids.push(names);

      return;
    }

    const out: Point[] = [];
    const said: Ident[] = [];

    for (let k = 0; k < held.length; k++) {
      const from = held[k], to = held[(k + 1) % held.length];
      const run = between(ring, from, to);

      out.push(ring[from]);
      said.push(names[from]);

      const n = steps(run, eps, run.length - 1);

      for (let s = 1; s < n; s++) {
        out.push(stationOf(run, s / n));
        said.push(on(names[from], s / n));
      }
    }

    shape.push(out);
    ids.push(said);
  });

  return { shape, ids };
}

/**
 * Which points of a ring the resample may not move: the ones a construction
 * turned the boundary at.
 *
 * A ring that is all curve and has no such point — a round's answer to a circle
 * — still has to start its runs somewhere, and where it starts cannot be an
 * index, which says only how the walk went. So it starts at the least of its
 * names, which is the same point whatever the walk did.
 */
function anchorsOf(names: readonly Ident[]): number[] {
  const held = names.flatMap((id, i) => (madeOf(id).kind === 'on' ? [] : [i]));

  if (held.length > 0) return held;

  let least = 0;

  for (let i = 1; i < names.length; i++) {
    if (shows(names[i]) < shows(names[least])) least = i;
  }

  return [least];
}

/** The points from `from` round to `to`, both ends in. A single anchor asks for
 * the whole ring, back round to itself. */
function between(ring: readonly Point[], from: number, to: number): Point[] {
  const out = [ring[from]];

  for (let i = (from + 1) % ring.length; ; i = (i + 1) % ring.length) {
    out.push(ring[i]);

    if (i === to) break;
  }

  return out;
}

/**
 * The least power of two whose equal steps of arc length stay within `eps` of
 * the run, never more than `most`.
 *
 * Measured from the run to the chords and not the other way about: what matters
 * is that no part of the boundary being replaced is further than `eps` from the
 * one replacing it.
 */
function steps(run: readonly Point[], eps: number, most: number): number {
  let n = 1;

  while (n < most) {
    if (strays(run, n) <= eps) return n;

    n *= 2;
  }

  return Math.max(1, most);
}

/** How far the run wanders from the polyline of its own `n` stations. */
function strays(run: readonly Point[], n: number): number {
  const at: Point[] = [run[0]];

  for (let s = 1; s < n; s++) at.push(stationOf(run, s / n));

  at.push(run[run.length - 1]);

  let worst = 0;

  for (const p of run) {
    let near = Infinity;

    for (let i = 0; i + 1 < at.length; i++) {
      const q = along(at[i], at[i + 1], p);

      near = Math.min(near, Math.hypot(p.x - q.x, p.y - q.y));
    }

    worst = Math.max(worst, near);
  }

  return worst;
}

/** The point `t` of the way along the run by arc length. */
function stationOf(run: readonly Point[], t: number): Point {
  let total = 0;

  for (let i = 0; i + 1 < run.length; i++) {
    total += Math.hypot(run[i + 1].x - run[i].x, run[i + 1].y - run[i].y);
  }

  let want = total * t;

  for (let i = 0; i + 1 < run.length; i++) {
    const d = Math.hypot(run[i + 1].x - run[i].x, run[i + 1].y - run[i].y);

    if (want <= d || i + 2 === run.length) {
      const u = d === 0 ? 0 : Math.min(1, want / d);

      return {
        x: run[i].x + (run[i + 1].x - run[i].x) * u,
        y: run[i].y + (run[i + 1].y - run[i].y) * u,
      };
    }

    want -= d;
  }

  return run[run.length - 1];
}
