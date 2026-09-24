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
import type { Effecting, Shape, Sweptfrom } from './geometry';
import { OpSubtract, OpUnion, along, patternRun, sweptBand } from './geometry';
import type { Drawn, Ident, Ids } from './ids';
import { combineIdentified, keyOf, madeOf, on, shows, tooth } from './ids';

/** A shape to a shape, carrying identity. */
export type Effect = (it: Drawn) => Drawn

/**
 * How much of an effect a point is given: one amount for the whole shape, or
 * an amount per identity.
 *
 * Per identity is what a polygon has always been able to carry — a round on
 * one corner, a deform on one edge — and it is the only part of the old
 * pipeline that an effect could not say, because an effect took one number.
 * Saying it by *identity* rather than by index is what makes it an effect: the
 * amount is attached to the point the construction made and not to where that
 * point sits in a ring today, so it survives an erosion closing a notch, a
 * union cutting the wall it is on, and the scope above laying its own.
 */
export type Amount = number | ReadonlyMap<Ident, number>

/**
 * The amount a point gets, for an identity nobody wrote one against.
 *
 * Every identity but a `corner` was made by an effect, so it has somewhere to
 * ask. A point along a run is its run's; a tooth is its run's; and a point born
 * where two pieces crossed takes the larger of the two, which is the same rule
 * `round(max(a, b))` states for two rounds meeting at one corner. A drawn
 * corner nobody named gets nothing, which is what "this corner is not rounded"
 * means.
 */
function amountOf(by: Amount, id: Ident): number {
  if (typeof by === 'number') return by;

  const had = by.get(id);

  if (had !== undefined) return had;

  const what = madeOf(id);

  if (what.kind === 'corner') return 0;
  if (what.kind === 'on') return amountOf(by, what.edge);
  if (what.kind === 'tooth') return amountOf(by, what.run);

  return Math.max(amountOf(by, what.a), amountOf(by, what.b));
}

/** Whether an amount asks for anything at all. */
function asks(by: Amount): boolean {
  return typeof by === 'number' ? by !== 0 : [...by.values()].some(a => a !== 0);
}

/** The most any point is given, which is what a facet count is read off. */
function most(by: Amount): number {
  return typeof by === 'number' ? by : Math.max(0, ...by.values());
}

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
export function eroding(depth: Amount): Effect {
  return it => {
    if (!asks(depth)) return it;

    const band = sweptBand(it.shape, (r, i) => amountOf(depth, it.ids[r][i]));

    const side = (shape: Shape, from: Sweptfrom[][], along: Sweptfrom[][]): Drawn => ({
      shape,
      ids: from.map(ring => ring.map(w => nameOf(it.ids, w))),
      edges: along.map(ring => ring.map(w => nameOf(it.ids, w))),
    });

    let out: Drawn = it;

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
// The dilation, and the opening
// -----------------------------------------------------------------------------

/**
 * The shape grown by `by` in every direction: the Minkowski sum with a disc of
 * that radius, and the outward half of a round.
 *
 * Not the mitred offset grown backwards. A mitre run outwards puts a spike
 * where a corner was and takes it straight back off again when it is run in,
 * so a mitre out of a mitre in is the shape it started as and nothing has been
 * rounded. The disc is what puts an arc there, and the arc is the whole point.
 *
 * It is built as the union of three things and every one of them is exactly
 * the ground the boundary covers:
 *
 * - the shape;
 * - a quad per wall, the wall and the wall pushed `by` along its outward
 *   normal;
 * - a fan per corner the boundary turns out at, from where the wall coming in
 *   ends up to where the wall going out starts.
 *
 * **Identity falls out of that and is not looked for.** A point of the grown
 * boundary lies either on a translate of a wall, and is that wall's, or on an
 * arc about a corner, and is that corner's — `on(corner, t)` with `t` sweeping
 * the turn, `0` where the arc leaves the wall coming in and `1` where it meets
 * the wall going out. Nothing is matched within a tolerance, and the fan's
 * ends are the quads' outer corners by construction rather than by landing in
 * the same place.
 *
 * A corner the boundary turns *in* at gets no fan: the two walls' quads
 * already cover the ground between them and there is no arc there to draw.
 * Material is on the left of every ring, hole and outer alike, so a hole
 * shrinks as the material round it grows with nothing said about it here.
 */
export function dilating(by: Amount, eps: number): Effect {
  return it => {
    if (!asks(by)) return it;

    const quads: Drawn = { shape: [], ids: [], edges: [] };
    const fans: Drawn = { shape: [], ids: [], edges: [] };

    it.shape.forEach((ring, r) => {
      const names = it.ids[r];
      const n = ring.length;
      const out = ring.map((p, i) => outward(p, ring[(i + 1) % n]));
      const grows = names.map(id => amountOf(by, id));

      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;

        if (out[i] === null) continue;

        const away = out[i]!;

        // The wall's two ends go out by their own corners' amounts, so the
        // slab under it is a trapezium wherever they differ and the arc at
        // either end meets it where its own radius puts it. Nothing is
        // reconciled afterwards: both are built from the one number.
        const here = { x: ring[i].x + away.x * grows[i], y: ring[i].y + away.y * grows[i] };
        const next = { x: ring[j].x + away.x * grows[j], y: ring[j].y + away.y * grows[j] };

        quads.shape.push([ring[i], here, next, ring[j]]);
        quads.ids!.push([names[i], on(names[i], 1), on(names[j], 0), names[j]]);
        quads.edges!.push([names[i], names[i], names[j], names[i]]);

        // The turn at the far end of this wall, between it and the next wall
        // there is one.
        const after = turnOf(out, j);

        if (after === null || grows[j] <= 0) continue;

        const swept = Math.atan2(away.x * after.y - away.y * after.x, away.x * after.x + away.y * after.y);

        if (swept <= 0) continue;

        const m = facets(swept, grows[j], eps);
        const arc: Point[] = [ring[j]];
        const said: Ident[] = [names[j]];

        for (let k = 0; k <= m; k++) {
          const a = (swept * k) / m;
          const c = Math.cos(a), s = Math.sin(a);

          arc.push({
            x: ring[j].x + (away.x * c - away.y * s) * grows[j],
            y: ring[j].y + (away.x * s + away.y * c) * grows[j],
          });
          said.push(on(names[j], k / m));
        }

        fans.shape.push(arc);
        fans.ids!.push(said);
        fans.edges!.push(said);
      }
    });

    let grown = it;

    if (quads.shape.length > 0) grown = combineIdentified(grown, quads, OpUnion);
    if (fans.shape.length > 0) grown = combineIdentified(grown, fans, OpUnion);

    return grown;
  };
}

/** A wall's outward normal, or nothing where there is no wall. Material is on
 * the left of the ring, so out is to the right of where it is going. */
function outward(p: Point, q: Point): Point | null {
  const dx = q.x - p.x, dy = q.y - p.y;
  const len = Math.hypot(dx, dy);

  return len === 0 ? null : { x: dy / len, y: -dx / len };
}

/** The normal of the wall leaving `i`, looking past any that are not walls. */
function turnOf(out: readonly (Point | null)[], i: number): Point | null {
  for (let k = 0; k < out.length; k++) {
    const at = out[(i + k) % out.length];

    if (at !== null) return at;
  }

  return null;
}

/** How many facets an arc of `swept` radians at radius `by` wants, for its
 * chords to stay within `eps` of it. */
function facets(swept: number, by: number, eps: number): number {
  const most = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - eps / by)));

  return Math.max(1, Math.ceil(swept / Math.max(most, 1e-6)));
}

/**
 * The round: in by `by` and out by `by`, the morphological opening.
 *
 * Every convex corner comes back at radius `by`, whatever made it — a drawn
 * corner, a join between two members, a corner an erosion made, a corner where
 * two arcs crossed. There is no asking what kind of corner it is, which is the
 * case the design being replaced cannot say at all.
 *
 * It composes as `round(max(a, b))` rather than as `round(a + b)`: an arc
 * already at curvature `1 / a` is untouched by an opening at `b` no bigger
 * than it. That is the honest reading of Law 3 and the reason `effects.test`'s
 * summing test is rewritten rather than kept. `linearity.test.ts` measured what
 * it costs the bake — a kink where two amounts cross, first order, at an
 * instant the keyframes already know.
 *
 * It finishes with the resample, which is what keeps the arcs from piling up:
 * a round of a round costs what one round costs.
 */
export function rounding(by: Amount, eps: number): Effect {
  return it => resampled(dilating(by, eps)(eroding(by)(it)), eps);
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
      const base = family(names[from]);

      for (let s = 1; s < n; s++) {
        out.push(stationOf(run, s / n));
        said.push(on(base, s / n));
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
 * A `corner` and a `born` are two of them. The third is an `on` at either end
 * of its run — `on(v, 0)` and `on(v, 1)`, where the arc about a corner leaves
 * the wall coming in and meets the wall going out. Those are not samples: a
 * construction put each of them at the one place it could go, and after a
 * round they are the only features a rounded square has left, every drawn
 * corner having become an arc. An `on` anywhere strictly between is the other
 * thing — one of however many points somebody chose to describe a curve with —
 * and it is the only kind that moves.
 *
 * A ring that is all curve even so — a round's answer to a circle — still has
 * to start its runs somewhere, and where it starts cannot be an index, which
 * says only how the walk went. So it starts at the least of its names, which
 * is the same point whatever the walk did.
 */
function anchorsOf(names: readonly Ident[]): number[] {
  const held = names.flatMap((id, i) => (loose(id) ? [] : [i]));

  if (held.length > 0) return held;

  let least = 0;

  for (let i = 1; i < names.length; i++) {
    if (shows(names[i]) < shows(names[least])) least = i;
  }

  return [least];
}

/**
 * What a run's samples are named along.
 *
 * A run leaving `on(e, 0)` is the arc about `e` — that is what an arc's start
 * is — so its samples are that arc's, `on(e, t)`, and a resample of it lays the
 * same family of names again at another `t`. Named off the anchor instead they
 * would be `on(on(e, 0), t)`, and a round of a round of a round would carry a
 * name as long as the fold is deep.
 *
 * Anything else names off itself: a run leaving a corner is that corner's wall,
 * and a run leaving an arc's far end is whatever comes after the arc.
 */
function family(anchor: Ident): Ident {
  const what = madeOf(anchor);

  return what.kind === 'on' && what.t === 0 ? what.edge : anchor;
}

/**
 * Whether a name is one of a curve's own samples, which is the only kind the
 * resample is free to move.
 *
 * Recursive, and it has to be. An arc's two ends are features of the boundary
 * — but only where the corner the arc was laid about was one. A round lays a
 * fan at *every* turn it finds, and a turn between two facets of an arc it
 * rounded last time is not a corner, it is the curve carrying on; its fan's
 * ends are no more a feature than the facet joint they came of. So an end is
 * as much of a feature as the thing it is an end of, and the ring a round of a
 * round hands back comes out the size a round hands back.
 */
function loose(id: Ident): boolean {
  const what = madeOf(id);

  return what.kind === 'on' && (loose(what.edge) || (what.t > 0 && what.t < 1));
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

// -----------------------------------------------------------------------------
// The deform
// -----------------------------------------------------------------------------

/**
 * The teeth, laid along the ring by arc length.
 *
 * What is gone is the per-edge parallel arrays and everything that went with
 * them. A deform in the fold has only a ring in front of it, and it lays the
 * pattern along the runs that ring is made of — a run being what lies between
 * two of the points a construction turned the boundary at, which is exactly
 * what the resample calls an anchor.
 *
 * **Where a pattern is anchored** (PLAN-bevel 2.1) carries over word for word,
 * with the run's own anchor standing in for the lowest-ranked member edge: the
 * run takes one name, its teeth are laid from that name's middle across the
 * whole of it, and two members side by side along one wall are one run and get
 * one pattern across the join. The name is the anchor's identity, which came
 * of the construction, so nothing about it can flip as members slide past one
 * another — which is the thing rank was there to prevent.
 *
 * **The tooth keeps its place** (2.4) is the identity again: a tooth is
 * `tooth(run, j)`, counted out from the middle, and it is tooth `j` however the
 * run's ends move. There is no `reach` and no `clear` here and nothing to
 * carry a source length through an erosion — the deform is a step of the fold
 * and lays its teeth on the ring in front of it, and whatever runs after it
 * carries the teeth as points like any others rather than laying them again.
 *
 * An arc takes its teeth as a wall does, one every spacing by length out from
 * the anchor, each pushed along the ring's own normal where it falls. That is
 * `ArcTeeth` and `drawnBevels` and `CRAMMED`, and it is now nothing at all:
 * an arc is more of the ring.
 *
 * Teeth cross each other and cross walls, so it finishes through the
 * arrangement — which names what the crossings make, as it does anywhere else.
 */
export function deforming(by: Amount, e: Effecting | ((id: Ident) => Effecting | null)): Effect {
  const options = typeof e === 'function' ? e : () => e;

  return it => {
    if (!asks(by)) return it;

    const shape: Shape = [];
    const ids: Ids = [];

    it.shape.forEach((ring, r) => {
      const names = it.ids[r];
      const held = ring.length < 3 ? [] : anchorsOf(names);

      if (held.length === 0) {
        shape.push(ring);
        ids.push(names);

        return;
      }

      const out: Point[] = [];
      const said: Ident[] = [];

      for (let k = 0; k < held.length; k++) {
        const from = held[k], to = held[(k + 1) % held.length];
        const run = between(ring, from, to);
        const whose = names[from];
        const lengths = walked(run);
        const total = lengths[lengths.length - 1];
        const how = options(whose);
        const high = amountOf(by, whose);
        const lay = how === null || !(how.spacing > 0) || high === 0
          ? { along: [], across: [], teeth: [], room: [] }
          : patternRun(how, keyOf(whose), high, total);

        out.push(ring[from]);
        said.push(whose);

        // The run's own points and its teeth, laid end to end in the order
        // their arc lengths put them: an arc keeps its facets and takes teeth
        // between them.
        let next = 1;

        for (let j = 0; j < lay.along.length; j++) {
          const at = lay.along[j] * total;

          while (next + 1 < run.length && lengths[next] <= at) {
            out.push(run[next]);
            said.push(names[stepped(ring, from, next)]);
            next++;
          }

          const ride = rideOf(run, lengths, at);

          out.push({ x: ride.at.x + ride.nx * lay.across[j], y: ride.at.y + ride.ny * lay.across[j] });
          said.push(tooth(whose, lay.teeth[j]));
        }

        for (; next + 1 < run.length; next++) {
          out.push(run[next]);
          said.push(names[stepped(ring, from, next)]);
        }
      }

      shape.push(out);
      ids.push(said);
    });

    return combineIdentified({ shape, ids }, { shape: [], ids: [] }, inA => inA);
  };
}

/** Where `step` points on from `from` sits in the ring. */
function stepped(ring: readonly Point[], from: number, step: number): number {
  return (from + step) % ring.length;
}

/** How far along the run each of its points is. */
function walked(run: readonly Point[]): number[] {
  const out = [0];

  for (let i = 0; i + 1 < run.length; i++) {
    out.push(out[i] + Math.hypot(run[i + 1].x - run[i].x, run[i + 1].y - run[i].y));
  }

  return out;
}

/** The point `at` along the run, and the way off it: out is to the right of
 * the way round, as a ring with material on its left has it. */
function rideOf(run: readonly Point[], lengths: readonly number[], at: number): {
  at: Point
  nx: number
  ny: number
} {
  let i = 0;

  while (i + 2 < run.length && lengths[i + 1] < at) i++;

  const a = run[i], b = run[i + 1];
  const d = lengths[i + 1] - lengths[i];
  const u = d === 0 ? 0 : Math.min(1, Math.max(0, (at - lengths[i]) / d));
  const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy);

  return {
    at: { x: a.x + dx * u, y: a.y + dy * u },
    nx: l === 0 ? 0 : dy / l,
    ny: l === 0 ? 0 : -dx / l,
  };
}
