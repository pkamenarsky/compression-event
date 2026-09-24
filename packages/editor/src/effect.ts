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
import type { EdgeRun, Effecting, Shape, Sweptfrom } from './geometry';
import { OpSubtract, OpUnion, along, patternRun, polygonsOf, sweptBand } from './geometry';
import type { Drawn, Ident, Ids } from './ids';
import { combineIdentified, keyOf, madeOf, on, shows, tooth } from './ids';
import { holding } from './hold';

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

    // One polygon at a time, which is how a resolve does it and so how this has
    // to. See `polygonsOf`: a band is not contained in the ring that swept it,
    // so a shape offset whole has one polygon's slivers cutting into another's
    // material and does not draw what its resolution draws.
    const groups = polygonsOf(it.shape);

    if (groups.length < 2) return erodeOne(it, depth);

    const parts = groups.map(group => erodeOne(
      {
        shape: group.map(r => it.shape[r]),
        ids: group.map(r => it.ids[r]),
        ...(it.edges === undefined ? {} : { edges: group.map(r => it.edges![r]) }),
      },
      depth,
    ));

    // Edges only where every part has them. What `combineIdentified` hands back
    // is walked and carries none, and a part the depths asked nothing of comes
    // back as it went in and carries whatever it arrived with — so the two are
    // mixed, and half an `edges` is worse than none: a reader takes its absence
    // to mean an edge leaves the point it is indexed by, which is true of both.
    return {
      shape: parts.flatMap(p => p.shape),
      ids: parts.flatMap(p => p.ids),
      ...(parts.every(p => p.edges !== undefined) ? { edges: parts.flatMap(p => p.edges!) } : {}),
    };
  };
}

/** The erosion of one polygon: an outline and its holes, and nothing else in
 * the shape to reach into it. */
function erodeOne(it: Drawn, depth: Amount): Drawn {
  const band = sweptBand(it.shape, (r, i) => amountOf(depth, it.ids[r][i]));

  const side = (shape: Shape, from: Sweptfrom[][], along: Sweptfrom[][]): Drawn => ({
    shape,
    ids: from.map(ring => ring.map(w => nameOf(it.ids, w))),
    edges: along.map(ring => ring.map(w => nameOf(it.ids, w))),
  });

  // Which of the band's edges can never be boundary, and so need not cut
  // anything. A wall where it stood is the shape's own edge again. A spoke, from
  // a corner to where it went, is boundary unless the quads either side of it
  // both have it — one each way round, so there is band on both of its sides.
  // At a corner turning out they do; at one turning in the two quads can fold
  // onto the same side, and then the spoke is the edge of the band after all.
  //
  // The band is quads by the hundred, and past a round's radius every spoke
  // crosses every other, so leaving them out of the cut is most of what an
  // erosion costs. They still bound the fill.
  const source = new Set(it.shape.flat());

  const inertIn = (pieces: Shape, from: Sweptfrom[][]) => {
    const edges = new Set<string>();
    const key = (p: Point, q: Point) => `${p.x},${p.y},${q.x},${q.y}`;

    for (const ring of pieces) ring.forEach((p, i) => edges.add(key(p, ring[(i + 1) % ring.length])));

    return (r: number, i: number): boolean => {
      const ring = pieces[r], j = (i + 1) % ring.length;
      const p = ring[i], q = ring[j];
      const f = from[r][i], g = from[r][j];

      if (source.has(p) && source.has(q)) return true;

      return source.has(p) !== source.has(q)
        && f.t === undefined && g.t === undefined
        && f.ring === g.ring && f.index === g.index
        && edges.has(key(q, p));
    };
  };

  let out: Drawn = it;

  if (band.inward.length > 0) {
    out = combineIdentified(
      out,
      side(band.inward, band.inwardFrom, band.inwardAlong),
      OpSubtract,
      inertIn(band.inward, band.inwardFrom),
    );
  }

  if (band.outward.length > 0) {
    out = combineIdentified(
      out,
      side(band.outward, band.outwardFrom, band.outwardAlong),
      OpUnion,
      inertIn(band.outward, band.outwardFrom),
    );
  }

  return out;
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
 * How far the chord of one facet of a square corner's arc of `bevel` in `n`
 * falls from the arc: the accuracy a round is asked to stand at, so that it
 * lays about as many facets as the count it is told.
 *
 * The round is an opening and lays as many facets as the accuracy asks for
 * rather than a count; asking for the accuracy the count stood at is how the
 * two are held to the same look.
 */
export function sagitta(bevel: number, n: number): number {
  return Math.max(bevel * (1 - Math.cos(Math.PI / (4 * Math.max(1, n)))), 1e-9);
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
 *
 * An opening at nought is the identity, and it has to be the identity *whole*:
 * not the same points under new names. The resample renames what it lays as a
 * curve's own samples, and a curve's samples are not features — so a ring that
 * had been asked for no round at all would come back with no corners on it,
 * and the deform after it would read two walls as one run and lay its teeth
 * across the corner between them. Hence the guard, rather than leaning on
 * erode and dilate each doing nothing.
 */
export function rounding(by: Amount, eps: number): Effect {
  return it => {
    if (!asks(by)) return it;

    // One polygon at a time, as the erosion is, and for a reason of its own:
    // how far a polygon may be rounded is a question about that polygon. An
    // opening only ever takes material away, so what each gives back lies
    // inside it and the parts are laid side by side without an arrangement.
    const groups = polygonsOf(it.shape);

    if (groups.length < 2) return resampled(opened(it, by, eps), eps);

    const parts = groups.map(group => opened({ shape: group.map(r => it.shape[r]), ids: group.map(r => it.ids[r]) }, by, eps));

    return resampled({ shape: parts.flatMap(p => p.shape), ids: parts.flatMap(p => p.ids) }, eps);
  };
}

/**
 * A round part way across a span whose accuracy changes: laid at `near` and
 * at `far`, and `at` of the way from the one layout to the other.
 *
 * The bake needs a ring as long at both ends of a span as in the middle of
 * it, and the editor's outline at each end. A round laid at the finer of the
 * two accuracies has the points; laid at the coarser one it has the outline.
 * So the finer layout's points are each put where the same fraction of the
 * way along the same run of the coarser one falls, and moved from there to
 * where the finer layout has them. At the coarse end every point the fine
 * layout has over lies on a facet of the coarse one — the outline the editor
 * draws there, with points on it that do not turn — and from there they come
 * out as the arc gains its facets.
 *
 * A run is found in the other layout by the names at its two ends, which a
 * round gives the same whatever its accuracy: they are where the arc leaves
 * one wall and meets the next. Where the two layouts do not agree about their
 * runs there is nothing to blend and the finer one is taken whole.
 *
 * Linear in the span where `at` is the bevel-weighted fraction the bake hands
 * over: each layout is its bevel times something of the corner, so the blend
 * is the lerp of the two ends.
 */
export function roundingAcross(by: Amount, near: number, far: number, at: number): Effect {
  if (near === far) return rounding(by, near);

  return it => {
    const a = rounding(by, near)(it), b = rounding(by, far)(it);
    const fineIsFar = far < near;
    const fine = fineIsFar ? b : a, coarse = fineIsFar ? a : b;
    const w = fineIsFar ? at : 1 - at;

    if (fine.shape.length !== coarse.shape.length) return fine;

    const shape: Shape = [];
    const ids: Ids = [];

    fine.shape.forEach((ring, r) => {
      const names = fine.ids[r];
      const other = coarse.shape[r], theirs = coarse.ids[r];
      const held = anchorsOf(ring, names);
      const where = new Map(theirs.map((id, i) => [id, i]));

      if (ring.length < 3 || held.length === 0 || held.some(i => !where.has(names[i]))) {
        shape.push(ring);
        ids.push(names);

        return;
      }

      const out: Point[] = [];
      const said: Ident[] = [];

      for (let k = 0; k < held.length; k++) {
        const from = held[k], to = held[(k + 1) % held.length];
        const run = between(ring, from, to);
        const along = between(other, where.get(names[from])!, where.get(names[to])!);

        // The least count both layouts' steps divide, so that every point of
        // either is a point of the blend: miss one and that end cuts across
        // it, and is not the editor's there.
        const nf = run.length - 1, nc = along.length - 1;
        const n = nf * nc / gcd(nf, nc);
        const base = family(names[from]);
        const at = (poly: readonly Point[], m: number, j: number): Point => {
          const c = j * m / n, i = Math.floor(c), u = c - i;

          return i >= m ? poly[m] : { x: poly[i].x + (poly[i + 1].x - poly[i].x) * u, y: poly[i].y + (poly[i + 1].y - poly[i].y) * u };
        };

        out.push(ring[from]);
        said.push(names[from]);

        for (let j = 1; j < n; j++) {
          const q = at(run, nf, j), p = at(along, nc, j);

          out.push({ x: p.x + (q.x - p.x) * w, y: p.y + (q.y - p.y) * w });
          said.push(n === nf ? names[(from + j) % ring.length] : on(base, j / n));
        }
      }

      shape.push(out);
      ids.push(said);
    });

    return { shape, ids };
  };
}

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];

  return a;
}

/**
 * The opening of one polygon, never rounded out of existence.
 *
 * Taken literally an opening at a radius wider than the polygon is nothing at
 * all: no disc that size fits inside, so a square rounded past the point where
 * its arcs meet goes. That is right as morphology and wrong as a round — the
 * arcs meeting is where a round should *stop*, a square at half its width
 * being a circle. So where the erosion would leave nothing, the round is taken
 * down to the most of it that leaves something, found by halving, and a
 * square asked for more than it can take comes back the circle or the stadium
 * it tends to. Continuous in the amount, which the bake needs of it: at the
 * amount where the arcs meet, both answers are the same shape.
 */
function opened(it: Drawn, by: Amount, eps: number): Drawn {
  const inner = eroding(by)(it);

  if (inner.shape.length > 0) return dilating(by, eps)(inner);

  let lo = 0, hi = 1, kept: Drawn | null = null;

  for (let k = 0; k < SHRINKS; k++) {
    const mid = (lo + hi) / 2;
    const tried = eroding(scaled(by, mid))(it);

    if (tried.shape.length > 0) {
      lo = mid;
      kept = tried;
    }
    else {
      hi = mid;
    }
  }

  return kept === null ? it : dilating(scaled(by, lo), eps)(kept);
}

/** How many halvings the most a polygon can be rounded is found to: a part in
 * four thousand of what was asked. */
const SHRINKS = 12;

/** An amount taken down by a share, whether one number or one per identity. */
function scaled(by: Amount, share: number): Amount {
  return typeof by === 'number' ? by * share : new Map([...by].map(([id, a]) => [id, a * share]));
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
    const held = anchorsOf(ring, names);

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
 * Which points of a ring lie flat, where the ring is held: see `hold.ts`.
 *
 * A held point that does not turn is one a still does not have at all — the
 * arrangement would have dropped it — so it may neither start a run nor hold
 * one in place, or a held fold lays its teeth and its samples from a point the
 * still's does not and the two draw different outlines. Nothing is flat where
 * nothing is held, so a still reads exactly as it did.
 */
function flatAt(ring: readonly Point[]): (i: number) => boolean {
  if (!holding()) return () => false;

  let scale = 1;

  for (const p of ring) scale = Math.max(scale, Math.abs(p.x), Math.abs(p.y));

  const snap = scale * 1e-9;
  const n = ring.length;

  return i => {
    const a = ring[(i - 1 + n) % n], b = ring[i], c = ring[(i + 1) % n];
    const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - b.x, vy = c.y - b.y;
    const reach = Math.max(Math.hypot(ux, uy), Math.hypot(vx, vy));

    return reach > 0 && Math.abs(ux * vy - uy * vx) / reach <= snap;
  };
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
function anchorsOf(ring: readonly Point[], names: readonly Ident[]): number[] {
  const flat = flatAt(ring);

  return startedAt(names, (id, i) => !loose(id) && !flat(i));
}

/**
 * Where a deform's runs begin, which is not where the resample's do.
 *
 * A run is what a pattern is laid along: it starts, the teeth are spaced out
 * from it and it ends. So where a run starts is where the rhythm is allowed to
 * restart, and the only thing that earns that is a turn the boundary actually
 * makes — a drawn corner, a corner where two members crossed, the tip of a
 * tooth a deform already laid. An arc is not one of those. An arc is the wall
 * carrying on round, and `on(v, 0)` and `on(v, 1)` are only where somebody
 * chose to stop calling it one wall and start calling it the next.
 *
 * The resample holds those two ends, and has to: they are the features that
 * keep a round of a round of a round from smearing. But holding them and
 * restarting on them are different questions, and answering them with one
 * predicate is what made a round come back with a tooth stuck on each of its
 * arcs — every arc its own run, every run centring one tooth in itself,
 * whatever the arc's length. A rounded square went round in four long
 * rhythms and four spikes instead of one rhythm all the way round.
 *
 * So: an `on` is never a run's start. A rounded ring has no corners left at
 * all and takes its teeth as one run the whole way round — which is what `an
 * arc is more of the ring` was always meant to say.
 *
 * **Where that one run starts is read off the geometry**, and it is the one
 * place here that is. It was the least of the ring's names, and a name is not
 * something two paths to the same ring agree on: a resolved polygon's corners
 * are numbered in the order the arrangement walked it, a scope's in the order
 * its members were drawn, and the least of one set is a different point from
 * the least of the other. Same zigzag, started at another phase, which is
 * the whole of what law 1 was red for where the round met the deform. Nothing
 * about a ring's names says where a circle begins, so it begins at the point
 * furthest along `LEAD`, whichever point that is. Not preferring the arc ends
 * the resample holds, tempting as they are: which points are those is itself
 * read off names, and a resolved ring calls some of them samples. The
 * direction is nothing any room is drawn square to, so two points are never
 * tied on it short of a shape built to tie them.
 */
function runsOf(ring: readonly Point[], names: readonly Ident[]): number[] {
  const flat = flatAt(ring);
  const turns = names.flatMap((id, i) => (madeOf(id).kind !== 'on' && !flat(i) ? [i] : []));

  if (turns.length > 0) return turns;

  const lead = (i: number) => ring[i].x * LEAD.x + ring[i].y * LEAD.y;

  return [names.reduce((best, _id, i) => (lead(i) > lead(best) ? i : best), 0)];
}

/** Which way a ring with nothing on it to start from starts: towards the top
 * left, off any angle a room is drawn at. */
const LEAD = { x: -Math.cos(0.3183), y: -Math.sin(0.3183) };

/** The indices `holds` picks out, or — where it picks out none — the one least
 * name, so that a ring with no feature on it still starts somewhere that is
 * not an index. */
function startedAt(names: readonly Ident[], holds: (id: Ident, i: number) => boolean): number[] {
  const held = names.flatMap((id, i) => (holds(id, i) ? [i] : []));

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
 * the anchor, each pushed along the ring's own normal where it falls, and
 * like a wall it keeps nothing between them: its facets go under the teeth,
 * so a deformed bevel is spaced as a deformed straight is. That is `ArcTeeth`
 * and `drawnBevels` and `CRAMMED`, and it is now nothing at all: an arc is
 * more of the ring.
 *
 * Teeth cross each other and cross walls, so it finishes through the
 * arrangement — which names what the crossings make, as it does anywhere else.
 */
export function deforming(by: Amount, e: Effecting | ((id: Ident) => Effecting | null)): Effect {
  const options = typeof e === 'function' ? e : () => e;

  return it => {
    // Held, a deform at nought still lays its teeth, flat: the bake needs
    // them there at the end a pattern comes up from, so the ring has the same
    // points at every instant of the span. See `hold.ts`.
    const flat = holding();

    if (!asks(by) && !flat) return it;

    const shape: Shape = [];
    const ids: Ids = [];
    const lines = linesOf(it);

    it.shape.forEach((ring, r) => {
      const names = it.ids[r];
      const held = ring.length < 3 ? [] : runsOf(ring, names);

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
        const line = lines.get(`${r}:${from}`);
        const whose = line?.edge ?? names[from];
        const lengths = walked(run);
        const total = lengths[lengths.length - 1];
        const how = options(whose);
        const high = amountOf(by, whose);
        const lay = how === null || !(how.spacing > 0) || (high === 0 && !flat)
          ? { along: [], across: [], teeth: [], room: [] }
          : patternRun(how, keyOf(line?.root ?? whose), high, total, 0, 0, rampAt(how.spacing, line?.before), line?.middle ?? total / 2, undefined, rampAt(how.spacing, line?.after));

        // The whole wall's pattern, where this is a piece of a wall that was
        // cut: what a piece ends on at the cut. See `wallAt`.
        const whole = line === undefined || (line.before === undefined && line.after === undefined) || how === null || !(how.spacing > 0) || (high === 0 && !flat)
          ? null
          : patternRun(how, keyOf(line.root), high, line.span, 0, 0, how.spacing, line.middle + line.at);
        const leg = (at: number, s: number, t: number) => {
          const ride = rideOf(run, lengths, at), off = wallAt(whole!, line!.span, s);

          out.push({ x: ride.at.x + ride.nx * off, y: ride.at.y + ride.ny * off });
          said.push(on(names[from], t));
        };

        out.push(ring[from]);
        said.push(names[from]);

        if (whole !== null && line!.before !== undefined) leg(0, line!.at, 0);

        // A run that takes teeth is its teeth and nothing else: each stands on
        // the run where its arc length puts it, a facet of an arc included,
        // and the points between are the ones the pattern lays. So the ring
        // goes one spacing to a point as it does along a straight, and an
        // arc's facets finer than the spacing go under it. Kept, a facet
        // joint a fraction of a unit from a tooth's foot made that tooth a
        // hairpin — the tooth pushed off one facet's normal and the joint
        // left standing beside it. A run too short for a tooth keeps its own
        // points, being drawn as it was.
        if (lay.along.length === 0) {
          for (let next = 1; next + 1 < run.length; next++) {
            out.push(run[next]);
            said.push(names[stepped(ring, from, next)]);
          }
        }

        for (let j = 0; j < lay.along.length; j++) {
          const ride = rideOf(run, lengths, lay.along[j] * total);

          out.push({ x: ride.at.x + ride.nx * lay.across[j], y: ride.at.y + ride.ny * lay.across[j] });
          said.push(tooth(line?.root ?? whose, lay.teeth[j]));
        }

        if (whole !== null && line!.after !== undefined) leg(total, line!.at + total, 1);
      }

      shape.push(out);
      ids.push(said);
    });

    return combineIdentified({ shape, ids }, { shape: [], ids: [] }, inA => inA);
  };
}

/**
 * The runs that are pieces of one edge, and where the middle of all of them
 * together falls along each: keyed `ring:start`.
 *
 * A run starts at every crossing, so where something rises through a wall the
 * wall's run is cut in two, and each half laid from its own middle moved every
 * tooth on the wall at the instant of the cut. But a crossing is `born` of the
 * two edges that made it, and the run leaving it carries on along one of them
 * — the one whose other points lie on its line. Followed back through as many
 * crossings as there are, pieces that come to the same edge and lie in one
 * line running one way are one wall: named by one of them, and laid from the
 * middle of them all, which is the middle the uncut wall had. So the pattern
 * is the one it was on both halves, and only a tooth that no longer has room
 * changes.
 *
 * Only straight runs, and only in a line: anything else is left as it was,
 * each crossing starting a run of its own.
 *
 * A polygon a scope resolves to reads the same, because resolving writes down
 * what each crossing was a crossing of (`Vertex.crossing`) and `identify`
 * names it `born` of the same again.
 */
function linesOf(it: Drawn): Map<string, Line> {
  const out = new Map<string, Line>();

  let scale = 1;

  for (const ring of it.shape) for (const p of ring) scale = Math.max(scale, Math.abs(p.x), Math.abs(p.y));

  for (const [key, line] of linesIn(it, scale * 1e-7)) out.set(key, line);

  return out;
}

/**
 * How many walls have been laid across more than one ring, ever: for the laws,
 * which have to know. A scope whose union is two islands sharing a wall lays
 * the wall once across both, and resolving it makes each island a polygon of
 * its own, which cannot — so there, and only there, the resolution draws a
 * different pattern from the scope. See PLAN-effect, step 9.
 */
let across = 0;

export function laidAcross(): number {
  return across;
}

/** One piece of a wall: the name its pattern is laid by, where the wall's
 * middle falls along the piece, and how wide the cut is at either end of it
 * where it ends in one rather than at the wall's own end. */
interface Line {
  edge: Ident
  /** The wall itself, which its teeth are named and keyed by: the same edge
   * before a cut and after it, where the piece `edge` names need not be — and
   * a tooth whose name changed across a span faded out and popped back. */
  root: Ident
  middle: number
  before?: number
  after?: number
  /** How long the whole wall is, from the first of its pieces to the end of
   * the last: what its pattern is laid along as though it were not cut. */
  span: number
  /** Where along the whole wall this piece starts. */
  at: number
}

/**
 * How far from the end of a run its teeth come up over: a spacing, or nothing
 * where the run ends at a cut in its wall.
 *
 * A cut is not an end of the wall. The piece ends on the whole wall's pattern
 * (see `wallAt`), so the teeth either side of a cut stand as they stood before
 * it opened, and one the cut reaches is passed over by the piece's end rather
 * than shrunk.
 */
function rampAt(spacing: number, cut: number | undefined): number {
  return cut === undefined ? spacing : 1e-9;
}

/**
 * How far off its line the whole of a cut wall is drawn at `s` along it: its
 * pattern laid as though nothing cut it, and read between the teeth either
 * side, as the drawn wall runs straight from one tooth to the next.
 *
 * Where a wall is cut, the crossing is where the wall's *line* was cut, and
 * the drawn wall stands off that line by as much as the pattern has there. So
 * a piece ends in two points: the crossing, where whatever cut the wall ends,
 * and this one, where the wall was drawn, with a short edge between them.
 * Ending on the crossing alone, the wall under a corner that pinched it
 * closed jumped onto the corner in one frame — sixteen units in a scratch
 * world, the corner having met the line and not the teeth.
 */
function wallAt(lay: EdgeRun, span: number, s: number): number {
  let x0 = 0, y0 = 0;

  for (let k = 0; k <= lay.along.length; k++) {
    const x1 = k < lay.along.length ? lay.along[k] * span : span;
    const y1 = k < lay.along.length ? lay.across[k] : 0;

    if (s <= x1) return x1 === x0 ? y1 : y0 + (y1 - y0) * (s - x0) / (x1 - x0);

    x0 = x1;
    y0 = y1;
  }

  return 0;
}

/** `linesOf`, keyed by the ring and index each piece starts at. */
function linesIn(it: Drawn, snap: number): Map<string, Line> {
  const out = new Map<string, Line>();

  interface Piece {
    key: string
    ring: number
    name: Ident
    from: number
    at: Point
    dx: number
    dy: number
    total: number
  }

  // Every point of the ring that lies on an edge: the one it leaves, and each
  // crossing it made. Whatever kind of name that is — a resolved polygon's
  // corner is a scope's tooth or sample, and the two have to read alike.
  const on = new Map<Ident, Point[]>();
  const put = (e: Ident, p: Point) => {
    const had = on.get(e);

    if (had === undefined) on.set(e, [p]);
    else had.push(p);
  };

  it.ids.forEach((names, r) => names.forEach((id, i) => {
    const what = madeOf(id);

    if (what.kind === 'born') {
      put(what.a, it.shape[r][i]);
      put(what.b, it.shape[r][i]);
    }
    else {
      put(id, it.shape[r][i]);
    }
  }));

  // The straight runs, each by the name of the point it leaves.
  const pieces: Piece[] = [];
  const leaving = new Map<Ident, Piece>();
  it.shape.forEach((ring, r) => {
    const names = it.ids[r];
    const held = ring.length < 3 ? [] : runsOf(ring, names);

    for (let k = 0; k < held.length; k++) {
      const from = held[k], to = held[(k + 1) % held.length];
      const run = between(ring, from, to);
      const lengths = walked(run);
      const total = lengths[lengths.length - 1];
      const a = run[0], b = run[run.length - 1];
      const l = Math.hypot(b.x - a.x, b.y - a.y);

      // Only a straight run is a piece of a line.
      if (!(l > 0) || total - l > snap) continue;

      const piece = { key: `${r}:${from}`, ring: r, name: names[from], from, at: a, dx: (b.x - a.x) / l, dy: (b.y - a.y) / l, total };

      pieces.push(piece);
      leaving.set(names[from], piece);
    }
  });

  const onLine = (at: Point, dx: number, dy: number) => (p: Point) => Math.abs((p.x - at.x) * dy - (p.y - at.y) * dx) <= snap;

  // The line an edge lies on, where the ring says: along its piece, if it
  // leaves a point here, or along the piece of an edge that carries on from
  // it, or else through two of the points on it.
  const known = new Map<Ident, (p: Point) => boolean>();

  for (const [e, piece] of leaving) known.set(e, onLine(piece.at, piece.dx, piece.dy));

  const lineOf = (e: Ident): ((p: Point) => boolean) | null => {
    const had = known.get(e);

    if (had !== undefined) return had;

    const pts = on.get(e) ?? [];
    const far = pts.find(p => Math.hypot(p.x - pts[0].x, p.y - pts[0].y) > snap);

    if (far === undefined) return null;

    const l = Math.hypot(far.x - pts[0].x, far.y - pts[0].y);

    return onLine(pts[0], (far.x - pts[0].x) / l, (far.y - pts[0].y) / l);
  };

  // Which edge an edge carries on. The edge leaving a crossing is named by
  // the crossing, and it runs on along one of the two edges that made it: the
  // one whose points lie on its line. Which name a crossing gets depends on
  // the order an arrangement met things in — a wall cut by one room and then
  // another has its second crossing on the first crossing's edge, and cut by
  // both at once on the wall's — so an edge is followed back to the one it
  // carries on, and the one at the end of that is the wall. What is learnt of
  // a line on the way is handed back, so an edge cut away with a single point
  // left on it is still found on the line of the piece that carries it on.
  const up = (e: Ident): Ident | null => {
    const what = madeOf(e);

    if (what.kind !== 'born') return null;

    const line = lineOf(e);

    if (line === null) return null;

    // The crossing's own point is on both and says nothing. An edge with
    // nothing else on it here lies on every line there is, so where the other
    // has a point on this one, that is the one.
    const self = leaving.get(e)?.at;
    const others = (c: Ident) => (on.get(c) ?? []).filter(p => p !== self);
    const fits = [what.a, what.b].filter(c => others(c).every(line));
    const seen = fits.filter(c => others(c).length > 0);
    let carries = fits.length > 1 ? seen : fits;

    // A name laid in two places — a tooth of a wall whose name heads two runs
    // is laid once on each — has points off this line that are not this edge
    // here. Where neither fits whole, the one with a point on the line does.
    if (carries.length === 0) carries = [what.a, what.b].filter(c => others(c).some(line));

    if (carries.length !== 1) return null;
    if (!known.has(carries[0])) known.set(carries[0], line);

    return carries[0];
  };
  const rootOf = (e: Ident): Ident => {
    const seen = new Set<Ident>();
    let at = e;

    while (true) {
      seen.add(at);

      const next = up(at);

      if (next === null || seen.has(next)) return at;

      at = next;
    }
  };

  // Twice, and the second time with every line the first learnt.
  for (const p of pieces) rootOf(p.name);

  const groups = new Map<Ident, Piece[]>();

  for (const p of pieces) {
    const root = rootOf(p.name);
    const got = groups.get(root);

    if (got === undefined) groups.set(root, [p]);
    else got.push(p);
  }

  for (const [root, got] of groups) {
    // A lone piece is a line of its own, unless it carries on an edge by
    // another name: then its teeth are that edge's, as they are wherever the
    // edge is whole or cut in several.
    if (got.length < 2 && got[0].name === root) continue;

    // Named by a point that is there in any case: the edge's own start where
    // it is, and otherwise the piece furthest back along the line. The edge
    // itself may have been cut away, and a resolved polygon has no amount or
    // options for a corner it does not have.
    //
    // The line is the one most of the pieces lie on. A name can head pieces
    // in two places — a tooth of a wall whose name heads two runs is laid on
    // each — and the one that happened to come first need not be the wall
    // the others are cut from.
    const lined = (a: Piece) => {
      const on = onLine(a.at, a.dx, a.dy);

      return got.filter(p => p.dx * a.dx + p.dy * a.dy > 1 - 1e-9 && on(p.at));
    };
    const named = got.filter(p => p.name === root);
    const most = (named.length > 0 ? named : got).reduce((best, p) => (lined(p).length > lined(best).length ? p : best));
    const { dx, dy } = most;
    const along = (p: Piece) => p.at.x * dx + p.at.y * dy;
    const mine = lined(most);
    const head = named.length > 0 ? most : mine.reduce((best, p) => (along(p) < along(best) ? p : best));

    if (mine.length < 2 && head.name === root) continue;

    const from = (p: Piece) => (p.at.x - head.at.x) * dx + (p.at.y - head.at.y) * dy;
    let lo = Infinity, hi = -Infinity;

    for (const p of mine) {
      lo = Math.min(lo, from(p));
      hi = Math.max(hi, from(p) + p.total);
    }

    const middle = (lo + hi) / 2;

    if (mine.some(p => p.ring !== mine[0].ring)) across++;

    // In order along the wall, each with the width of the cut either side of
    // it: nothing at the wall's own ends.
    mine.sort((a, b) => from(a) - from(b));
    mine.forEach((p, k) => out.set(p.key, {
      edge: head.name,
      root,
      middle: middle - from(p),
      span: hi - lo,
      at: from(p) - lo,
      ...(k === 0 ? {} : { before: Math.max(0, from(p) - from(mine[k - 1]) - mine[k - 1].total) }),
      ...(k + 1 === mine.length ? {} : { after: Math.max(0, from(mine[k + 1]) - from(p) - p.total) }),
    }));
  }

  return out;
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

/**
 * The point `at` along the run, and the way off it: out is to the right of the
 * way round, as a ring with material on its left has it.
 *
 * The way off is eased along each facet from the bisector at one joint to the
 * bisector at the next, and not the facet's own normal. On a straight it is
 * the same thing. On an arc it is the difference between a tooth standing out
 * of the curve and a tooth leaning with whichever facet it happened to land
 * on — and at a joint *which* facet that is was decided by the last bit of a
 * length. Two paths to one ring measure its runs in a different order, so a
 * tooth centred on the apex of a rounded tip swung ten degrees one way on the
 * scope and ten the other on its resolution, a unit apart at the tooth's tip.
 * Eased, the direction is continuous in `at` and an ulp moves it by an ulp.
 */
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
  const from = jointOf(run, i), to = jointOf(run, i + 1);
  const nx = from.x * (1 - u) + to.x * u, ny = from.y * (1 - u) + to.y * u;
  const l = Math.hypot(nx, ny);

  return {
    at: { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u },
    nx: l === 0 ? 0 : nx / l,
    ny: l === 0 ? 0 : ny / l,
  };
}

/** The way off the run at its point `i`: the bisector of the facets either
 * side, or the one facet there is at either end. */
function jointOf(run: readonly Point[], i: number): Point {
  const before = i > 0 ? outward(run[i - 1], run[i]) : null;
  const after = i + 1 < run.length ? outward(run[i], run[i + 1]) : null;

  if (before === null) return after ?? { x: 0, y: 0 };
  if (after === null) return before;

  return { x: before.x + after.x, y: before.y + after.y };
}
