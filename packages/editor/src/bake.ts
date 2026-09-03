// -----------------------------------------------------------------------------
// The bake
//
// The game does not resolve versions. It gets buffers, and between two of them
// it lerps. So the bake's job is to cut the span between two versions into
// *stretches* — runs of `t` across which the arrangement's combinatorics hold —
// and to evaluate the geometry at both ends of each one. Within a stretch the
// shader reproduces the world exactly by interpolating; between two stretches
// there is a discontinuity, which is what a topology event *is*.
//
// What is interpolated
// --------------------
// Not positions: components. The version in flight contributes its own layer,
// eased from identity to itself, and everything before it is already inside the
// base frame and inside `local`:
//
//   frame(t)  = ease(T_{k+1}, t) o A_k           (rotation, scale, translation)
//   local(t)  = lerp(local_k, local_{k+1}, t)    (vertex nudges)
//   depth(t)  = lerp(d_k, d_{k+1}, t)
//   shape(t)  = erode(frame(t)(local(t)), depth(t))
//
// which is exactly `resolveAt(k)` at t = 0 and `resolveAt(k + 1)` at t = 1. A
// polygon that turns therefore turns through the morph rather than collapsing
// through its own centre, which is the whole reason a version keeps its
// transform in components instead of as a matrix.
//
// Rotation and scale ease from identity on their own terms. The translation
// does not: it is whatever holds the layer's own fixed point still, so a turn
// goes round its pivot instead of round the world origin. See `pivot`.
//
// `A_k` is a general affine and is constant across the span, so nothing here
// interpolates an accumulated chain — the property the composed frame in
// `scene.ts` was allowed to give up.
//
// A polygon that is new in `k + 1` has no `local_k` of its own, and is given
// one: its own ring pinched into its own middle. So `local(t)` opens it back
// out over the span and it grows out of a point instead of arriving whole at
// the boundary — through the same three lines above rather than through a case
// of its own. See `budding`, which also says why the birth goes in the ring
// rather than in the frame, where it looks like it belongs.
//
// One that `k + 1` takes out is the same thing read backwards: it has no
// `local_{k+1}`, and gets the pinched ring at that end instead. A removal is a
// birth with the span running the other way, and it is written that way here —
// the only asymmetry is that a dying polygon takes no layer of its own, since a
// version that does not have a polygon cannot be saying anything about it.
//
// It costs something, and what it costs is not about which direction it goes —
// a birth and a removal of the same polygon measure identically, being the same
// span read from the two ends. It is about what the polygon touches. Either one
// is now a motion, so it makes topology events where it passes through its
// neighbours and the span is cut where they are, where before there was nothing
// inside the span to find.
//
// So a pillar standing alone inside a room is free: a hole that stays a hole
// until it is a speck is no event at all, and a hundred-room level losing the
// pillar from every room bakes in exactly the time and exactly the stretches it
// did before. A room joined to its neighbours by corridors is the other end of
// it — pulling away from them is a real event per corridor per instant it takes
// to separate — and a quarter of a hundred-room level arriving or leaving that
// way is some fifty extra stretches each and about eight times the bake.
//
// The one thing either is is absent. A ring with no area is not something the
// arrangement can be asked about, so the end a polygon does not have holds a
// real polygon a thousandth of its final size; standing still at the version
// where it is not there the game draws nothing, and the instant a shift starts
// it draws a speck. That is the one place the still and the morph do not agree,
// and it is a tenth of a unit wide.
//
// A stretch belongs to a polygon
// ------------------------------
// Not to the level. A polygon's share of the outline is a question about that
// polygon and the ones it overlaps — that is what `boundaryRuns` promises and
// what the whole set is built on — so its keyframes are a question about the
// same handful of polygons, and a room losing a corner is no business of a room
// two hundred rooms away.
//
// Cutting the level as one thing made both the work and the file grow with the
// square of it: every event anywhere ended the stretch for everybody, and every
// keyframe then stored every polygon's outline, nearly all of it unchanged. A
// thousand-polygon level measured at twenty-odd minutes and half a gigabyte for
// one span. Cut per polygon, against a neighbourhood of about five, the same
// span is half a minute and four megabytes.
//
// So a `Span` holds one `Track` per polygon, each with its own stretches, and
// `sample` reads them all at the same instant and puts the runs back in id
// order. Two tracks' keyframes almost never line up, which is the point.
//
// What a stretch carries
// ----------------------
// Its runs, and the rings a crossing has to be solved from — which is a
// neighbour's business, since a crossing is where two polygons meet. Only the
// rings some `Origin` actually names: carrying the neighbours whole cost nine
// of the fifteen megabytes a busy thousand-polygon span held, all of it never
// read. Adjacent stretches take their geometry off the same evaluation and so
// share it already; what needed saying was which of it was wanted at all.
//
// Where a stretch ends
// --------------------
// The shader can work out *where* a vertex goes. It cannot work out *whether it
// exists*, or what order a ring visits its vertices in, and it cannot follow a
// path that bends. So a stretch has to end wherever any of those gives out, and
// there are two ways to know:
//
// - **Known outright, from the layer chain.** Both ends of the span, always: a
//   version boundary is a keyframe because the interpolation's derivative
//   changes there. Those cost nothing.
//
// - **Measured, because nothing else is trustworthy.** Everything else — a
//   corner passing through an edge, two rooms joining, an eroded ring losing a
//   corner, and the bends and reshufflings that are not events at all — is
//   found by checking the stretch against `csg(t)` in the middle and splitting
//   until it is close enough. See *Cutting the span*, which is also where the
//   analytic search that used to live here is buried.
//
// Why the CSG runs from nothing every time
// ----------------------------------------
// It used to be kept incrementally, on the reasoning that a version edits a few
// polygons and leaves the rest alone, so most of the set would survive from one
// instant to the next. That is true of a *gesture* and false of a *span*: a
// version that erodes moves every polygon it names, every instant, so the diff
// found nothing to skip and paid its bookkeeping for the privilege. Each
// evaluation now builds a set from nothing. `worldset` is still the engine; the
// bake simply does not carry one across instants.
// -----------------------------------------------------------------------------

import { Point } from '@ce/game/world';
import { AABB, Tree, build, merge, ofRings, overlaps, search } from './aabb';
import { Member, Ring, Shape, boundaryRuns, ground, keeping, simplify } from './geometry';
import {
  Affine,
  Contributed,
  EMPTY_LIVE,
  IDENTITY,
  Placed,
  Resolved,
  affine,
  artefactsAt,
  centroid,
  chain,
  compose,
  contributed,
  depths,
  facing,
  groupFrame,
  placeAt,
  sidedWith,
  sideOf,
  live,
  place,
  resolved,
  standingIn,
  unplace,
  resolveAt,
} from './scene';
import {
  ArtefactId,
  EMPTY_TRANSFORM,
  GroupId,
  Id,
  PolygonId,
  PolygonType,
  Transform,
  VersionId,
  Vertex,
  VertexId,
  World,
  enclosing,
} from './types';
import { pieces } from './worldset';

// -----------------------------------------------------------------------------
// What comes out
// -----------------------------------------------------------------------------

/**
 * One polygon's share of the set's outline, at one instant. Open, as it comes
 * out of `worldset`.
 *
 * The points are in the owning polygon's own frame, not in the world. That is
 * what makes a turn interpolate as a turn: the frame is rebuilt from components
 * at every instant and the points ride it, where lerping world positions
 * between 0 and 90 degrees would pull every corner a third of the way toward
 * the centre. A run always belongs to exactly one polygon — that is what
 * `boundaryRuns` guarantees and why `worldset` deals in runs at all — so there
 * is always one frame to take it back to.
 *
 * The ends of a run are crossings with *other* polygons, and a crossing is
 * strictly speaking a function of both. Carried in the owner's frame it moves
 * as though it were pinned to the owner, which is exact whenever nothing turns
 * relative to anything, and off by the sliding of the crossing along the edge
 * when something does. The doc's answer is to ship the four endpoints and solve
 * the intersection in the shader; this is the prototype's.
 */
export interface Run {
  id: PolygonId
  points: Point[]
  /**
   * Per point: what it is, out of the arrangement that made it — a corner of
   * somebody's outline, or the crossing of two edges, named by whose.
   *
   * This is what pairs two readings. It arrives with the boundary rather than
   * being worked out again from the geometry, which is the whole point: a name
   * is exact where a measurement needs a tolerance, and two readings agree
   * about a point exactly when they agree about its name.
   */
  whence: Origin[]
  /**
   * Per point: whether the boundary actually turns there, out of
   * `boundaryRuns`. It rides along rather than being worked out again at the
   * end, because it is a question about a polygon *and its neighbours* and only
   * the CSG ever sees both. See `cornering` in `geometry.ts`.
   */
  corner: boolean[]
  /**
   * A floor's ring rather than a share of the outline. See `Track.fill`.
   *
   * It rides on the run for the same reason the corner flags do: what to build
   * on a set of points is not something a reader should be working out again
   * from the ids, and the one place that knows is the one that made them.
   */
  fill: boolean
}

/** The set at one instant, ordered so that two evaluations can be compared and
 * interpolated run by run. */
export type Frame = Run[];

/** A shape with only some of its rings, held at their own indices. */
export type Rings = (Ring | undefined)[];

/** One edge of one polygon's eroded shape: the edge that starts at `index`. */
export interface Ref {
  id: PolygonId
  ring: number
  index: number
}

/**
 * Why an output point is where it is — the doc's two kinds, and the whole of
 * what the shader has to be told.
 *
 * A `vertex` is a corner of the polygon's own eroded shape and interpolates
 * exactly, because that is the thing the stretch was cut to make true. A
 * `cross` is where two edges meet, and it is *not* a function of either polygon
 * alone: as one turns relative to the other the meeting point slides along both
 * edges, on a path no lerp of its endpoints follows. So it is not stored as a
 * point at all. The four endpoints are evaluated and the intersection solved,
 * which is about ten multiply-adds and is exact.
 *
 * Within a stretch the two edges are guaranteed to still meet inside their
 * segment bounds, because an endpoint passing through the other edge is an
 * event and would have ended the stretch.
 */
export type Origin =
  | { kind: 'vertex', at: Ref }
  | { kind: 'cross', a: Ref, b: Ref };

/**
 * A group holding a polygon over the span, and the layer it is in flight with.
 *
 * Named, because the shader shares one of these between everything the group
 * holds rather than carrying a copy per polygon: what a vertex rides is a
 * chain, and the chain is the structure.
 */
export interface Holder {
  id: Id
  layer: Transform
}

/**
 * What takes a polygon's runs back out to the world, in the form that can be
 * interpolated: a constant chain, the one layer in flight over it, and every
 * group in flight over that, innermost first.
 *
 * The groups stay a chain rather than being composed into one layer, and they
 * have to: a `Transform` is components, composing two of them is a general
 * matrix, and a matrix lerped entrywise slews a rotation through a shear. Each
 * is eased on its own terms and the results multiply, which is the same thing
 * `resolveAt` does one stage at a time.
 */
export interface Rider {
  base: Affine
  layer: Transform
  holders: Holder[]
}

/** Where a polygon's own frame stands at an instant of the span: its base, its
 * layer in flight over that, and every group's in flight over that. */
export function riding(r: {
  base: Affine
  layer: Transform
  holders: readonly Holder[]
}, t: number): Affine {
  let frame = compose(affine(easing(r.layer, t)), r.base);

  for (const h of r.holders) frame = compose(affine(easing(h.layer, t)), frame);

  return frame;
}

/**
 * A stretch of `t` across which nothing discrete happens to *one polygon*, and
 * that polygon's geometry at both ends of it. This is the unit the game would
 * be handed: everything between `a` and `b` is a lerp.
 *
 * `a` and `b` are the runs the polygon owns, which is usually one and is
 * several where other polygons cut its boundary into pieces.
 */
export interface Stretch {
  t0: number
  t1: number
  a: Frame
  b: Frame
  /**
   * The rings a crossing is solved from: the polygon's own and its
   * neighbours', in the frame each one's runs are kept in, at both ends of the
   * stretch.
   *
   * Only the rings some `Origin` names. Everything else about the neighbours is
   * of no use here — the runs carry their own points — and carrying it anyway
   * measured at nine of the fifteen megabytes a busy thousand-polygon span held.
   * So the arrays are indexed by ring number and have holes in them wherever
   * nothing asked, which is most places. The two readers already treat a
   * missing ring as a point they cannot place, which is the right answer for a
   * ring that no origin named.
   */
  table: Map<PolygonId, { a: Rings, b: Rings }>
  /**
   * Where each run point comes from, run by run and point by point, or null
   * where the two ends could not be made to agree about it. A `cross` is
   * re-solved at every instant rather than interpolated; everything else is a
   * vertex of its own polygon and interpolates exactly.
   */
  origins: (Origin | null)[][]
  /**
   * How solid each run point is at each end — the doc's `lineOpacity`.
   *
   * A corner that is not the polygon's at one end of the span is still in the
   * ring there, sitting on the edge between its neighbours so the shape is
   * unchanged. It is not a corner, and a wall drawn with a line standing at it
   * says it is. Zero there and one where the corner is real, lerped across the
   * stretch, so the line fades over exactly the run the vertex emerges through.
   */
  opacity: [number[][], number[][]]
}

/**
 * One polygon's own cut of the span.
 *
 * Two lists, because a cut produces two kinds of thing and only one of them is
 * an interval. `stretches` is an ordered cover of the whole span: every instant
 * lies in exactly one of them, they abut exactly, and each holds one
 * arrangement from end to end. `jumps` are the discontinuities — the geometry
 * *at* an instant where the arrangement changes, which belongs to no interval
 * because it is true at a point and nowhere either side of it.
 *
 * They used to be one list, and that is what made this hard to see. A jump sat
 * in the cover with no width, `abutting` gave it half the gap to its
 * neighbours to keep the cover closed, and from then on it was an interval
 * holding an arrangement true only at its left end. A walk beginning at a jump
 * drew that arrangement for its whole first frame. Kept apart, a jump can only
 * be reached by asking for its exact instant, which is the only question it can
 * answer.
 */
export interface Track {
  id: PolygonId
  /**
   * A floor: drawn filled and flat underfoot rather than as walls.
   *
   * A floor is in no set — `worldset` takes only `level` and `solid` — so its
   * boundary is its own projection and nothing else, and its runs are closed
   * rings rather than the open arcs a share of the outline comes in. Everything
   * else about a track is the same, which is the point: it rides the same
   * frame, it is cut by the same measure, and it interpolates by the same lerp.
   */
  fill: boolean
  stretches: Stretch[]
  /** By `t`, ascending. Never an interval — see above. */
  jumps: Stretch[]
}

/** Everything between two adjacent versions. */
export interface Span {
  from: VersionId
  /** One per polygon, ordered by id — which is also the order `sample` puts
   * their runs back in. */
  tracks: Track[]
  /** Per polygon, what its runs ride. Constant across the span: only the
   * easing of `layer` varies, and that is a function of `t` alone. */
  riders: Map<Id, Rider>
  /** How many times the CSG was run to settle the span. One of these is a
   * polygon's own neighbourhood, not the level, so the count is large and each
   * one is small. */
  evaluations: number
  /**
   * The furthest the replay was ever measured from `csg(t)`, in world units.
   *
   * The bake states its own error rather than resting on an argument about
   * which topology events exist. Nothing consults it — it is here to be read,
   * and to fail a test if it ever grows.
   */
  worst: number
  /**
   * Thread-milliseconds spent resolving the span and then cutting it, added up
   * over however many threads did it. Nothing reads these; against the wall
   * clock they say how well the work divided, and how much of what did not
   * divide was setup.
   */
  setup: number
  cut: number
  /** What the world looked like when this was baked. */
  stamp: Stamp
}

/**
 * A span's geometry depends on its own two versions and on every version above
 * them, since that is what `resolveAt` walks. So the stamp is the whole chain
 * down to `k + 1`, plus the polygons, the group structure and the artefacts
 * themselves.
 *
 * The artefacts because they have slots in the frame table — `carried` puts
 * them there, and which of them exist decides both how many slots there are and
 * what `bakedSpan` indexes them by. A span baked before a key was dropped has
 * no row for it, and the game falls back to a straight line between the two
 * places rather than the frame it should be riding.
 *
 * It is the `edits` maps rather than the `Version` objects, so that opening and
 * closing a ghost's eye — which replaces the version but changes no
 * geometry — does not throw away a bake.
 */
export interface Stamp {
  edits: unknown[]
  polygons: unknown
  groups: unknown
  artefacts: unknown
}

export interface Bake {
  /** Keyed by the earlier of the two versions. */
  spans: Map<VersionId, Span>
  /** 0 to 1 while a bake is running, and null when none is. */
  progress: number | null
}

export const EMPTY_BAKE: Bake = { spans: new Map(), progress: null };

export function stamp(world: World, from: VersionId): Stamp {
  return {
    edits: world.versions.slice(0, from + 2).map(v => v.edits),
    polygons: world.polygons,
    groups: world.groups,
    artefacts: world.artefacts,
  };
}

/** The span, if what it was baked against is still standing. */
export function spanAt(bake: Bake, world: World, from: VersionId): Span | null {
  const span = bake.spans.get(from);
  if (span === undefined) return null;

  const now = stamp(world, from);

  if (span.stamp.polygons !== now.polygons) return null;
  if (span.stamp.groups !== now.groups) return null;
  if (span.stamp.artefacts !== now.artefacts) return null;
  if (span.stamp.edits.length !== now.edits.length) return null;

  return span.stamp.edits.every((e, i) => e === now.edits[i]) ? span : null;
}

/** Every span the edit reached, dropped. Cheaper to ask than to work out, and
 * `spanAt` is the one that has to be right. */
export function pruned(bake: Bake, world: World): Bake {
  const spans = new Map<VersionId, Span>();

  for (const [from] of bake.spans) {
    const kept = spanAt(bake, world, from);
    if (kept !== null) spans.set(from, kept);
  }

  return spans.size === bake.spans.size ? bake : { ...bake, spans };
}

// -----------------------------------------------------------------------------
// The moving world
// -----------------------------------------------------------------------------

/**
 * One polygon across one span: the frame it already stood in, the layer being
 * eased onto it, and its two endpoints.
 *
 * A polygon born into `k + 1` has no near end of its own, and one taken out at
 * `k + 1` has no far end; either way the end it lacks is the same ring pinched
 * into its own middle. See `budding`. From there it is a polygon like any
 * other — it rides its groups, it cuts stretches where it passes through its
 * neighbours, and nothing downstream has to know it is arriving or leaving.
 */
interface Moving {
  at: Resolved
  base: Affine
  layer: Transform
  /**
   * The corners both ends are written over: every corner either version has,
   * in ring order. `local` and `corners` are index for index at both ends, so
   * the two rings interpolate straight across. See `spanning`.
   */
  corners: Vertex[]
  local: [Ring, Ring]
  /**
   * Which of `corners` is not really the polygon's at each end — the ones
   * `spanning` had to invent so that both ends could be written over the same
   * ring.
   *
   * This is the whole of what `lineOpacity` is worked out from. A corner that
   * is not there is sitting on the edge between its neighbours, and the wall it
   * stands on is straight; drawing a line at it says there is a corner where
   * there is none. Existence is known here and nowhere downstream, so it is
   * carried rather than inferred later from the geometry — which could not tell
   * a corner that is arriving from one that was never there.
   */
  dead: [boolean[], boolean[]]
  depth: [number, number]
  /**
   * The depth at each of `corners` at the two ends, written over the same ring
   * the way `local` is, and read only where `varying` says the polygon has
   * corners offset apart from each other.
   *
   * A corner one end had to invent carries the depth its edge has where it
   * sits — the same interpolation its position gets — so that it stays flat in
   * the projection as well as in the source. Anything else and it would push a
   * dent into a wall it is supposed to be lying along.
   */
  depths: [number[], number[]]
  /** Whether either end offsets a corner apart from the rest. Almost never, and
   * the uniform road is the one whose arithmetic has not moved. */
  varying: boolean
  /** The groups holding it over this span, innermost first. */
  holders: Holder[]
}

/**
 * The two ends of a span written over the same corners, so that a ring which
 * gains or loses one still interpolates.
 *
 * A corner added at the far end of the span is put in at the near end as well,
 * sitting on the edge it is about to grow out of; one taken away at the far end
 * stays for the whole span and lands back on that edge at the end of it. Either
 * way the ring never changes length while the span runs, and at the instant the
 * corner is not supposed to exist it is a point on a straight edge, which is
 * the same shape as not being there at all.
 *
 * Which edge is the whole of it. The corner goes between its nearest
 * neighbours *that the end being filled in actually has* — not its nearest
 * neighbours that both ends have. Those are different questions whenever a
 * corner arrives next to one that is leaving: the leaving one is still there at
 * the near end, and stepping over it to reach the next survivor anchors the
 * arrival on a chord across the polygon's inside rather than on its boundary.
 * What that looks like is a corner diving through the middle of the shape and
 * back out, which is what it did.
 *
 * Where along that edge is a matter of taste rather than correctness — anywhere
 * on it leaves the shape alone. Where the far end has the same two neighbours,
 * the fraction the corner sits at over there is used, so one added near an end
 * of a long edge grows from near that end rather than sliding along it. Where
 * it does not — the arriving-beside-a-leaving case again — there is no shared
 * pair to measure against, and a run of them is spread evenly instead.
 */
function spanning(was: Resolved, now: Resolved): Spanned {
  const here = new Map(was.corners.map((c, i) => [c.id, was.local[i]]));
  const there = new Map(now.corners.map((c, i) => [c.id, now.local[i]]));
  const deep = [depthsOf(was), depthsOf(now)] as const;

  const corners = was.polygon.points.filter(c => here.has(c.id) || there.has(c.id));

  const dead: [boolean[], boolean[]] = [
    corners.map(c => !here.has(c.id)),
    corners.map(c => !there.has(c.id)),
  ];

  // Same count as both ends means the same corners as both ends: each is a
  // subset of the union, so equal sizes make all three the same set.
  const depths: [number[], number[]] = [
    corners.map(c => deep[0].get(c.id) ?? was.erosion),
    corners.map(c => deep[1].get(c.id) ?? now.erosion),
  ];

  if (corners.length === was.corners.length && corners.length === now.corners.length) {
    return straightened(corners, [was.local, now.local], dead, depths);
  }

  const n = corners.length;
  const ends = [here, there] as const;
  const ends2 = [was.erosion, now.erosion] as const;
  const local: [Ring, Ring] = [
    corners.map(c => here.get(c.id) ?? ORIGIN),
    corners.map(c => there.get(c.id) ?? ORIGIN),
  ];

  // The nearest corner in that direction that `has` holds. It terminates
  // because neither end is ever left with fewer than three corners.
  const nearest = (i: number, step: number, has: Map<VertexId, Point>): number => {
    let k = i;

    do {
      k = (k + step + n) % n;
    }
    while (!has.has(corners[k].id));

    return k;
  };

  corners.forEach((c, i) => {
    for (const side of [0, 1] as const) {
      const mine = ends[side], other = ends[1 - side];

      if (mine.has(c.id)) continue;

      const before = nearest(i, -1, mine), after = nearest(i, 1, mine);
      const from = mine.get(corners[before].id)!, to = mine.get(corners[after].id)!;

      const sameBefore = nearest(i, -1, other) === before;
      const sameAfter = nearest(i, 1, other) === after;

      // Everything strictly between two neighbours is missing here by
      // construction, so its place in that run is all the spreading needs.
      const at = sameBefore && sameAfter
        ? fraction(other.get(corners[before].id)!, other.get(corners[after].id)!, other.get(c.id)!)
        : ((i - before + n) % n) / ((after - before + n) % n);

      local[side][i] = between2(from, to, at);

      // The depth it would have had if it were on the edge, because it is: a
      // corner is flat in the projection only where its own offset agrees with
      // what its neighbours' offsets say the edge is doing at that point.
      const da = deep[side].get(corners[before].id) ?? ends2[side];
      const db = deep[side].get(corners[after].id) ?? ends2[side];

      depths[side][i] = da + (db - da) * at;
    }
  });

  return straightened(corners, local, dead, depths);
}

/** What `Resolved.depths` says, by corner id, and nothing where the polygon is
 * under one depth throughout. */
function depthsOf(it: Resolved): Map<VertexId, number> {
  const out = new Map<VertexId, number>();

  if (it.depths !== null) {
    it.corners.forEach((c, i) => out.set(c.id, it.depths![i]));
  }

  return out;
}

/** The two ends of a span written over one ring: what `spanning` produces. */
interface Spanned {
  corners: Vertex[]
  local: [Ring, Ring]
  dead: [boolean[], boolean[]]
  depths: [number[], number[]]
}

/**
 * `dead` widened to the corners the arrangement is going to drop anyway.
 *
 * A corner that is exactly collinear with its neighbours is not in the
 * projection — `cornersOnly` takes it out — and for everything downstream that
 * is the same thing as not being there. A corner flat at one end of the span
 * and turning at the other therefore arrives exactly as one that is born does:
 * the ring changes length part way through, and a vertical stands up out of a
 * flat wall the instant it stops being exactly straight. Which is what it did —
 * three authored points sitting on a wall, one of them dragged off it, and all
 * three lines flashing on for the frame at the near end of the span.
 *
 * So they are marked dead where they are flat, and the machinery `spanning`
 * already has does the rest: `invented` asks for them back so the ring keeps
 * its length, and `fading` fades their lines in over the run they emerge
 * through. Erosion moves edges parallel, so exactly collinear in the source is
 * exactly collinear in the projection, and the source is what is in hand here.
 *
 * Only where it *changes*. A corner flat at both ends is dropped at both ends
 * and at every instant between, and saying it is dead would ask for it back at
 * the two ends alone — a ring one point longer at the ends than in the middle,
 * which is the one thing this is all for. Existence wins where it has already
 * spoken, for the same reason.
 */
function straightened(
  corners: Vertex[],
  local: [Ring, Ring],
  dead: [boolean[], boolean[]],
  depths: [number[], number[]],
): Spanned {
  const snap: [number, number] = [near1(local[0]), near1(local[1])];

  for (let i = 0; i < corners.length; i++) {
    if (dead[0][i] || dead[1][i]) continue;

    const was = flat(local[0], depths[0], i, snap[0]);
    const now = flat(local[1], depths[1], i, snap[1]);

    if (was !== now) dead[was ? 0 : 1][i] = true;
  }

  return { corners, local, dead, depths };
}

/** The arrangement's own tolerance, off one ring. See `near`. */
function near1(ring: Ring): number {
  let extent = 1;

  for (const p of ring) extent = Math.max(extent, Math.abs(p.x), Math.abs(p.y));

  return extent * 1e-9;
}

/**
 * Whether the ring runs straight through a corner: `cornersOnly`'s question,
 * asked of the source rather than of the projection.
 *
 * Asking it of the source is only allowed because the offset does not bend a
 * straight run — which is true while one depth covers the whole ring, and false
 * the moment a corner carries its own. Three points in a line whose depths are
 * not in the same line come out of `erodeAt` as a genuine corner, so the depths
 * have to answer the same question the positions do, and both have to say yes.
 */
function flat(ring: Ring, depths: readonly number[], i: number, snap: number): boolean {
  const n = ring.length;
  const a = ring[(i - 1 + n) % n], b = ring[i], c = ring[(i + 1) % n];
  const ux = b.x - a.x, uy = b.y - a.y;
  const vx = c.x - b.x, vy = c.y - b.y;
  const reach = Math.max(Math.hypot(ux, uy), Math.hypot(vx, vy));

  if (reach === 0) return true;
  if (Math.abs(ux * vy - uy * vx) / reach > snap) return false;

  // Where the depth sits, against where running from `a` to `c` would put it.
  const l = Math.hypot(ux, uy) + Math.hypot(vx, vy);
  const da = depths[(i - 1 + n) % n], db = depths[i], dc = depths[(i + 1) % n];
  const want = l === 0 ? da : da + (dc - da) * (Math.hypot(ux, uy) / l);

  return Math.abs(db - want) <= snap;
}

const ORIGIN: Point = { x: 0, y: 0 };

/** How far along `a`–`b` the foot of `p` falls, clamped to the segment. */
function fraction(a: Point, b: Point, p: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = dx * dx + dy * dy;

  if (len === 0) return 0;

  return Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
}

function between2(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * How small a polygon is at the instant before it is there.
 *
 * Not nought. A ring with no area is not something the arrangement can be asked
 * about — every edge is degenerate, every crossing is a division by nothing,
 * and the offset of it is worse — so the near end is a real polygon, only a
 * very small one. Small enough to read as a point at any scale a level is drawn
 * at, and some six orders above the tolerance `near1` works to, so the CSG is
 * looking at an honest shape rather than at rounding.
 */
const SEED = 1e-3;

/**
 * The end a polygon does not have, whichever end that is: its own ring, pinched
 * into its own middle.
 *
 * In the ring rather than in the frame, and the two are the same shape. A
 * uniform scale about the centroid takes every corner along the line from the
 * centroid to where it ends up, and the scale runs linearly over the span, so
 * scaling the frame and lerping the corners are the same arithmetic — which is
 * exactly what `between` and the shader's `mix(aPointA, aPointB, u)` already
 * do, at both ends of every stretch, for free.
 *
 * The frame road works and was the first one written. What is wrong with it is
 * single precision: a frame squashed by `SEED` has to be opened back out by a
 * layer of `1 / SEED`, and the translation holding the pivot still is then a
 * large number that must cancel a large number in a float32 table. The error
 * that survives is small — some hundredths of a unit — but it is error bought
 * for nothing, since the ring says the same thing exactly.
 */
function budding(local: Ring): Ring {
  const c = centroid(local);

  return local.map(p => ({
    x: c.x + (p.x - c.x) * SEED,
    y: c.y + (p.y - c.y) * SEED,
  }));
}

/**
 * Every group holding something, with what the later version does to it.
 *
 * Membership is global, so which groups these are is not a question about when
 * any of them was made. What *is* a question is whether the group is still
 * there at the far end: a group taken out at `from + 1` may still have a layer
 * written at that version from before it was, and applying it would carry a
 * shrinking room off to somewhere the editor never draws. A group that is not
 * there does nothing, which is the same answer `resolveAt` gives by never
 * reaching it.
 */
function holders(world: World, from: VersionId, id: Id): Holder[] {
  const next = world.versions[from + 1];
  const there = new Set(chain(world, from + 1));

  return enclosing(world, id).map(g => ({
    id: g,
    layer: standingIn(world, g, there)
      ? next.edits.get(g)?.transform ?? EMPTY_TRANSFORM
      : EMPTY_TRANSFORM,
  }));
}

function moving(world: World, from: VersionId): Moving[] {
  const before = new Map(resolveAt(world, from).map(it => [it.id, it]));
  const after = resolveAt(world, from + 1);

  const next = world.versions[from + 1];
  const holding = (id: PolygonId): Holder[] => holders(world, from, id);

  const out = after.map(it => {
    const was = before.get(it.id);
    const edit = next.edits.get(it.id);
    const layer = edit?.transform ?? EMPTY_TRANSFORM;

    if (was === undefined) {
      // Its own transform is applied outright rather than eased: a version that
      // both makes a polygon and moves it is describing where the polygon *is*,
      // and there is no earlier place for that to be a move away from. So the
      // only thing in flight over the frame is what its groups are doing, and
      // the birth itself is in the ring.
      return {
        at: it,
        base: compose(affine(layer), groupFrame(world, from, it.id)),
        layer: EMPTY_TRANSFORM,
        corners: it.corners,
        local: [budding(it.local), it.local] as [Ring, Ring],
        dead: [it.corners.map(() => false), it.corners.map(() => false)] as [boolean[], boolean[]],

        // From nothing, so that the depth stays in proportion to the shape it
        // is taken off. A full depth against a thousandth of a polygon is not a
        // thin room; it is an inside-out one.
        depth: [0, it.erosion] as [number, number],
        depths: [it.corners.map(() => 0), flatDepths(it)] as [number[], number[]],
        varying: it.depths !== null,
        holders: holding(it.id),
      };
    }

    const over = spanning(was, it);

    return {
      at: it,
      base: was.frame,
      layer,
      corners: over.corners,
      local: over.local,
      dead: over.dead,
      depth: [was.erosion, it.erosion] as [number, number],
      depths: over.depths,
      varying: was.depths !== null || it.depths !== null,
      holders: holding(it.id),
    };
  });

  // And the ones going the other way. A polygon the later version takes out is
  // in `before` and nowhere in `after`, so it is picked up here rather than in
  // the walk above, and given the far end it does not have: the same ring
  // pinched into its own middle, which is `budding` read backwards.
  //
  // Its own layer at `from + 1` is *not* applied, whatever it says. A polygon
  // is not editable at a version that does not have it, so anything written
  // there was written before the delete and is inert everywhere else — see
  // `resolveAt`, which stops walking a polygon at its death and never reads it.
  // What is left in flight is what its groups are doing, which is real: a room
  // going out of a turning group turns on its way out.
  const kept = new Set(after.map(it => it.id));

  for (const [id, was] of before) {
    if (kept.has(id)) continue;

    out.push({
      at: was,
      base: was.frame,
      layer: EMPTY_TRANSFORM,
      corners: was.corners,
      local: [was.local, budding(was.local)] as [Ring, Ring],
      dead: [was.corners.map(() => false), was.corners.map(() => false)] as [boolean[], boolean[]],
      depth: [was.erosion, 0] as [number, number],
      depths: [flatDepths(was), was.corners.map(() => 0)] as [number[], number[]],
      varying: was.depths !== null,
      holders: holding(id),
    });
  }

  return out;
}

/** A depth per corner for a polygon standing still: whatever it is under. */
function flatDepths(it: Resolved): number[] {
  return it.depths !== null ? [...it.depths] : it.corners.map(() => it.erosion);
}

function mix(u: number, v: number, t: number): number {
  return u + (v - u) * t;
}

/**
 * The one point a layer leaves where it found it, or nothing when it has none.
 *
 * A transform turns about the world origin and carries a translation, so the
 * pivot a gesture was made about is not stored anywhere — `turned` folds it
 * into the translation and forgets it. It can be had back regardless: a map
 * with a fixed point has exactly one, and it is the pivot, whatever gesture put
 * the layer there. Solving `(I - A) f = T` recovers it.
 *
 * That is also the answer to a version holding several gestures about several
 * different pivots. Their composite is still one map and still has one fixed
 * point, so there is nothing to store, nothing to choose between, and no order
 * to remember. Turn a polygon about its middle and then about its corner, and
 * the morph spins it about the single point that both agree stayed put.
 *
 * A pure translation has no fixed point, and neither has a scale that leaves an
 * axis alone. `null` says so, and the caller falls back to a straight line —
 * which for a translation is exactly right anyway.
 */
export function pivot(layer: Transform): Point | null {
  const m = affine({ ...layer, translation: { x: 0, y: 0 } });

  const det = (1 - m.a) * (1 - m.d) - m.b * m.c;
  const size = Math.max(1, Math.abs(m.a), Math.abs(m.b), Math.abs(m.c), Math.abs(m.d));

  if (Math.abs(det) < 1e-9 * size * size) return null;

  const { x: tx, y: ty } = layer.translation;

  return {
    x: ((1 - m.d) * tx + m.c * ty) / det,
    y: (m.b * tx + (1 - m.a) * ty) / det,
  };
}

/**
 * The layer eased on, in components. Identity at 0, itself at 1.
 *
 * Rotation and scale ease on their own terms, and the translation is then
 * whatever holds the pivot still: `T(t) = f - A(t) f`. Easing it in a straight
 * line instead is what makes a turning polygon swing out on a great arc and
 * come back — the translation a rotation gesture leaves behind is the pivot
 * carried round a circle, and a chord is not a circle. Both ends are unmoved by
 * this, since `A(0)` is the identity and `A(1) f` is `f - T` by construction.
 */
function easing(layer: Transform, t: number): Transform {
  const rotation = layer.rotation * t;
  const scale = { x: mix(1, layer.scale.x, t), y: mix(1, layer.scale.y, t) };
  const held = t === 0 || t === 1 ? null : pivot(layer);

  if (held === null) {
    return {
      translation: { x: layer.translation.x * t, y: layer.translation.y * t },
      rotation,
      scale,
      erosion: 0,
    };
  }

  const a = affine({ translation: { x: 0, y: 0 }, rotation, scale, erosion: 0 });

  return {
    translation: {
      x: held.x - (a.a * held.x + a.c * held.y),
      y: held.y - (a.b * held.x + a.d * held.y),
    },
    rotation,
    scale,
    erosion: 0,
  };
}

function between(a: Ring, b: Ring, t: number): Ring {
  if (a === b || t === 0) return a;
  if (t === 1) return b;

  return a.map((p, i) => {
    const q = b[i] ?? p;

    return { x: mix(p.x, q.x, t), y: mix(p.y, q.y, t) };
  });
}

/**
 * Where the corners `spanning` invented land in the projection, at the one
 * instant each of them is flat.
 *
 * They are only a problem where they are not corners, and that is exactly the
 * end of the span that does not have them — everywhere in between they are part
 * way out of the wall and turn like anything else, so the projection keeps them
 * without being asked. So this is empty at every instant but two, and at those
 * two it is a handful of points.
 *
 * A flat corner's two edges are parallel, so `mitred` comes back with its own
 * position moved along the shared normal by the depth: the mitre a corner would
 * get has nothing to bite on. That is the offset `moved` takes in `erode`, and
 * it has to be, or the point would miss the edge it is meant to land on.
 */
function invented(
  m: Moving,
  source: Ring,
  erosion: number | readonly number[],
  t: number,
): Point[] {
  const dead = t === 0 ? m.dead[0] : t === 1 ? m.dead[1] : null;
  if (dead === null) return [];

  const out: Point[] = [];

  for (let i = 0; i < source.length; i++) {
    if (dead[i] !== true) continue;

    const p = mitred(source, i, typeof erosion === 'number' ? erosion : erosion[i]);

    if (p !== null) out.push(p);
  }

  return out;
}

/** The world at one instant inside the span, resolved. */
function world1(items: Moving[], t: number): Resolved[] {
  const out: Resolved[] = [];

  for (const m of items) {
    const local = between(m.local[0], m.local[1], t);
    const frame = riding(m, t);
    const source = place(frame, local);
    const erosion = mix(m.depth[0], m.depth[1], t);
    const depths = m.varying
      ? m.depths[0].map((d, i) => mix(d, m.depths[1][i], t))
      : null;

    // Named rather than spread: spreading `m.at` would read its projection,
    // which is the one thing worth not doing here.
    out.push(resolved({
      id: m.at.id,
      polygon: m.at.polygon,
      corners: m.corners,
      local,
      frame,
      source,
      erosion,
      depths,
      keep: invented(m, source, depths ?? erosion, t),
    }));
  }

  return out;
}

/**
 * How solid each vertex of a polygon's projection is, at one instant — the
 * doc's `lineOpacity`, worked out where the answer is actually known.
 *
 * The question is only ever asked about the corners `spanning` invented, and
 * about those it is asked at every instant of the span, not only at the two ends
 * where they are flat. So the point has to be *named*, and the name is
 * arithmetic: erosion moves every edge parallel to itself, so the image of a
 * corner is where its two moved edges meet, which is `mitred` and is the same
 * point `erode` builds the boundary out of.
 *
 * It used to be found instead by projecting the ring again without them and
 * keeping whatever was left over. That is only sound where taking a corner out
 * leaves the same curve — which is to say where it is already flat, which is to
 * say at the two ends of the span and nowhere in between. Everywhere else the
 * two projections are honestly different shapes, the leftovers did not line up,
 * and the whole fade was abandoned: the lines stayed solid for the length of the
 * span and vanished in its last frame, which is the thing they exist not to do.
 *
 * Only polygons whose corner set actually changes across the span pay for it,
 * which in most spans is none of them.
 *
 * The value is the lerp of the two ends: a corner leaving goes 1 to 0 across
 * the span and one arriving goes 0 to 1, so the line fades over exactly the
 * stretch the vertex is emerging through.
 */
function fading(m: Moving, it: Resolved, t: number): number[][] | null {
  const changing: number[] = [];

  for (let i = 0; i < m.corners.length; i++) {
    if (m.dead[0][i] || m.dead[1][i]) changing.push(i);
  }

  if (changing.length === 0) return null;

  const full = it.shape;
  const snap = near(new Map([[it.id, full]]));
  const out = full.map(ring => ring.map(() => 1));

  for (const i of changing) {
    const image = mitred(it.source, i, it.depths === null ? it.erosion : it.depths[i]);

    // Swallowed: an offset deep enough to eat the edge the corner sat on leaves
    // it nowhere to be, and a point that is not drawn needs no opacity.
    if (image === null) continue;

    const at = corner(full, image, snap);

    if (at === null) continue;

    out[at.ring][at.index] = mix(m.dead[0][i] ? 0 : 1, m.dead[1][i] ? 0 : 1, t);
  }

  return out;
}

/**
 * Where corner `i` of a ring lands once the ring is offset by `depth` — the
 * meeting point of its two edges after each has moved to its left.
 *
 * This is `erode`'s own construction rather than a guess at it: every surviving
 * edge lies on a translate of its own line, so the corner between two of them is
 * where those translates cross. Two edges that run exactly straight through the
 * corner never cross, and then the answer is the corner moved along the shared
 * normal, which is that construction's limit rather than a case beside it.
 *
 * `null` where the corner is not on the offset boundary at all: a ring that
 * doubles back on itself sends the meeting point off towards infinity, and a
 * deep enough offset eats the edges the corner stood between.
 */
function mitred(ring: Ring, i: number, depth: number): Point | null {
  const n = ring.length;
  const a = ring[(i - 1 + n) % n], b = ring[i], c = ring[(i + 1) % n];

  const ux = b.x - a.x, uy = b.y - a.y, ul = Math.hypot(ux, uy);
  const vx = c.x - b.x, vy = c.y - b.y, vl = Math.hypot(vx, vy);

  if (ul === 0 || vl === 0) return null;

  const p = { x: ux / ul, y: uy / ul };
  const q = { x: vx / vl, y: vy / vl };

  // Both moved lines pass through the corner's own offset, one for each edge.
  const pa = { x: b.x - p.y * depth, y: b.y + p.x * depth };
  const qa = { x: b.x - q.y * depth, y: b.y + q.x * depth };

  const turn = p.x * q.y - p.y * q.x;

  if (Math.abs(turn) < 1e-12) return pa;

  const s = ((qa.x - pa.x) * q.y - (qa.y - pa.y) * q.x) / turn;

  return { x: pa.x + p.x * s, y: pa.y + p.y * s };
}

/**
 * The set at one instant, worked out directly rather than interpolated: what
 * the replay is supposed to reproduce, and what the tests hold it to.
 *
 * This is the CPU's answer — resolve the world at `t`, then run the whole CSG.
 * The bake exists precisely so that the game never has to do it, so nothing in
 * the editor calls this; it is the yardstick.
 */
export function truth(world: World, from: VersionId, t: number): Frame {
  const cast = casting(world, from);

  return evaluate(cast, cast.items, t, null).out;
}

// -----------------------------------------------------------------------------
// Evaluating
// -----------------------------------------------------------------------------

/** The whole answer at one instant: the set, and everything the check and the
 * crossings need to be worked out from it.
 *
 * `frame` and `out` hold whatever was asked for — one polygon's runs when a
 * track is being cut, everybody's when the yardstick is being taken. The two
 * shape tables are the same either way: they hold what was handed in, which for
 * a track is the polygon and its neighbours.
 */
interface Taken {
  t: number
  frame: Frame
  /** Each contributor's eroded shape, in the same frame the runs are kept in:
   * the table the crossings are solved from. */
  table: Map<Id, Shape>
  /** The same, left in world units, which is where a point is classified. */
  world: Map<Id, Shape>
  /** The runs before they were taken back to their frames, for the same
   * reason: an edge of another contributor is only nearby in the world. */
  out: Frame
  /** Per contributor, how solid each vertex of its projection is. Missing for
   * anything whose corners do not change across the span, which is most of
   * them, and read as one throughout — a group's union has no source corners
   * to fade, so it is never in here. */
  fade: Map<Id, number[][]>
}

/**
 * The whole cast of a span: how every polygon moves, and which groups are
 * eroding over it.
 *
 * The polygons are the geometry; the contributors are what the CSG is handed,
 * and an eroding group is one of those in place of everything under it. Kept
 * together because working out the second needs the first and the structure
 * they hang off.
 */
export interface Cast {
  world: World
  items: Moving[]
  /** Group to its depth at each end of the span, for the groups that have one
   * at either end. A depth arriving is a depth in flight like any other. */
  eroding: Map<GroupId, [number, number]>
  /**
   * What each eroding group's own points ride: its frame at the near version,
   * its layer in flight over the span, and whatever holds it.
   *
   * A group carries no geometry, so this is not where its shape comes from —
   * its members' frames already have all of this in them and the union arrives
   * in world units. It is what the union is taken *back* into, so that a group
   * turning is a turn in the buffers rather than a chord across it.
   */
  riders: Map<GroupId, Rider>
  /**
   * Every group projection worked out so far, by the instant it was worked out
   * at.
   *
   * A group's offset union is a full arrangement and it is asked for once per
   * track that the group falls near, which is every track its box touches. The
   * answer depends on nothing but the instant — a neighbourhood holds all of a
   * group's members or none of them, so the union is never a partial one — so
   * the same instant is the same shape and it is worked out once.
   *
   * Bounded, because a span reaches far more instants than it shares: over a
   * hundred-room level, 18438 of 19166 evaluations land on an instant nothing
   * else ever asks about, and holding all of them would be holding the span
   * over again to save a few per cent.
   */
  folds: Map<number, Map<string, Shape>>
}

function casting(world: World, from: VersionId): Cast {
  const a = depths(world, from), b = depths(world, from + 1);
  const eroding = new Map<GroupId, [number, number]>();

  for (const id of world.groups.keys()) {
    const pair: [number, number] = [a.get(id) ?? 0, b.get(id) ?? 0];

    if (pair[0] !== 0 || pair[1] !== 0) eroding.set(id, pair);
  }

  const next = world.versions[from + 1];
  const there = new Set(chain(world, from + 1));
  const riders = new Map<GroupId, Rider>();

  for (const id of eroding.keys()) {
    riders.set(id, {
      base: groupFrame(world, from, id),

      // Nothing, for a group the later version takes out: whatever it says
      // about one it does not have was written before the removal and means
      // no more here than a dead polygon's layer does. See `moving`.
      layer: standingIn(world, id, there)
        ? next.edits.get(id)?.transform ?? EMPTY_TRANSFORM
        : EMPTY_TRANSFORM,
      holders: holders(world, from, id),
    });
  }

  return { world, items: moving(world, from), eroding, riders, folds: new Map() };
}

/** How many instants' worth of group projections to hold at once. */
const FOLDS = 512;

/** The polygons at an instant, folded into what the CSG sees there. */
function folded(cast: Cast, at: Resolved[], t: number): Contributed[] {
  let held = cast.folds.get(t);

  // Full, and then closed rather than emptied. The instants that get asked
  // about more than once are the early ones — both ends of the span, and the
  // first few places the cut bisects at — so the ones already in are worth more
  // than the ones still arriving, and throwing them out to make room would give
  // up exactly the sharing this is for.
  if (held === undefined && cast.folds.size < FOLDS) {
    held = new Map();
    cast.folds.set(t, held);
  }

  const all = contributed(
    cast.world,
    at,

    // Which groups stand for their members is settled for the whole span, not
    // asked at each instant. A depth arriving is zero at the near end, and a
    // group that handed its members back there would change what the boundary
    // is made of half way through a stretch.
    id => {
      const both = cast.eroding.get(id);

      if (both === undefined) return null;

      return {
        depth: mix(both[0], both[1], t),
        frame: riding(cast.riders.get(id)!, t),
      };
    },
    held,
  );

  // An eroding group stands in front of its members and hands over one union
  // per side, floors included — which is right for the canvas, where a shut
  // group is drawn as the one outline that says what it occupies, and wrong
  // here. A floor is in no set, so there is nothing for a union of them to be
  // the boundary *of*; it is baked as itself at its own depth, which is what
  // `floorsAt` draws standing still and therefore what the still and the morph
  // have to agree on. See `subjects`.
  const mine = all.filter(it => it.kind !== 'floor');

  for (const it of at) {
    if (it.polygon.type !== 'floor') continue;

    mine.push({
      id: it.id,
      kind: 'floor',
      shape: it.shape,
      frame: it.frame,
      simple: it.erosion !== 0 || it.depths !== null,
      keep: it.keep,
    });
  }

  return mine;
}


/** One track's worth of the span: what it is cut for, and what it is cut
 * from. */
interface Subject {
  id: Id
  mine: Moving[]
  /** See `Track.fill`. */
  fill: boolean
}

/** Everything the span's tracks are cut for: a polygon that nothing holds, an
 * eroding group in place of all of its members, and every floor as itself. */
function subjects(cast: Cast): Subject[] {
  const out = new Map<Id, Moving[]>();
  const kinds = new Map<Id, Set<PolygonType>>();
  const all: Subject[] = [];

  for (const m of cast.items) {
    // A floor is in no set, so there is no union for a group to stand in front
    // of and nothing for it to be folded into. It is baked as itself at its own
    // depth, which is exactly what `floorsAt` draws standing still — so the
    // still and the morph agree at the ends of the span by construction rather
    // than by two paths happening to arrive at the same answer.
    if (m.at.polygon.type === 'floor') {
      all.push({ id: m.at.id, mine: [m], fill: true });
      continue;
    }

    // The outermost group that erodes, or the polygon itself. Everything
    // between them is transparent and hands its members on.
    const up = enclosing(cast.world, m.at.id).filter(g => cast.eroding.has(g));
    const id = up[up.length - 1] ?? m.at.id;

    (out.get(id) ?? out.set(id, []).get(id)!).push(m);
    (kinds.get(id) ?? kinds.set(id, new Set()).get(id)!).add(m.at.polygon.type);
  }

  for (const [id, mine] of out) {
    if (!cast.eroding.has(id)) {
      all.push({ id, mine, fill: false });
      continue;
    }

    // A group that holds both kinds contributes to both sides of the set, and
    // each side is its own boundary and its own track. They are cut over the
    // same members and ride the same frame; only the classification differs.
    if (kinds.get(id)?.has('level')) all.push({ id, mine, fill: false });
    if (kinds.get(id)?.has('solid')) all.push({ id: sideOf(id, 'solid'), mine, fill: false });
  }

  return all;
}

/** A polygon as the boundary wants to see it: simplified, unless it came out of
 * an erosion and is an arrangement already. The same reasoning `worldset` uses,
 * and it has to be the same or the two would not agree. */
function memberOf(it: Contributed): Member | null {
  const kind = it.kind;

  if (kind !== 'level' && kind !== 'solid') return null;

  // A source ring as drawn is allowed to cross itself, so it goes through an
  // arrangement here — and an arrangement drops the vertices it does not turn
  // at, this one included. Anything already simple is spared it.
  const shape = it.simple ? it.shape : keeping(simplify(it.shape), it.keep ?? []);

  return shape.length === 0 ? null : { id: it.id, kind, shape };
}

/**
 * One polygon's share of the outline, worked out against the handful of
 * polygons that could bury it and nothing else.
 *
 * This is the whole reason a track is cheap. `boundaryRuns` already promises
 * that a polygon's share is a question about that polygon and the ones it
 * overlaps, so evaluating it does not need the level — it needs five polygons.
 * The overlap test is by box and against the same boxes `worldset` uses, so the
 * member list is the one the full set would have handed over, ranks and
 * tolerances included, and the two answers are the same answer.
 */
function share(at: readonly Contributed[], only: Id): Frame {
  const members: Member[] = [];
  let subject: Member | null = null;

  const mine = at.find(it => it.id === only);

  if (mine !== undefined && mine.kind === 'floor') return filling(mine);

  for (const it of at) {
    const m = memberOf(it);

    if (m === null) continue;
    if (m.id === only) subject = m;

    members.push(m);
  }

  if (subject === null) return [];

  const box = ofRings(subject.shape);
  const others = members.filter(m => m.id !== only && overlaps(box, ofRings(m.shape)));

  return boundaryRuns(subject, others, ground([subject, ...others]))
    .map(r => ({ id: only, points: r.points, corner: r.corner, whence: r.whence, fill: false }));
}

/**
 * A floor's share: its own rings, and nothing to do with anybody else's.
 *
 * Closed, because a ring of the union belongs to no one polygon and is handed
 * back as open arcs, while a floor's ring is a floor's ring the whole way
 * round. Repeating the first point is how `boundaryRuns` says so too, and it
 * is what `extrude` and the fill both read.
 *
 * Every point is a corner of its own outline, so nothing here is ever a
 * crossing: a floor overlapping a wall is drawn under it, not cut by it.
 */
function filling(it: Contributed): Frame {
  return it.shape
    .filter(ring => ring.length >= 3)
    .map((ring, r) => ({
      id: it.id,
      fill: true,
      points: [...ring, ring[0]],
      corner: ring.map(() => true).concat(true),
      whence: ring
        .map((_unused, i) => named(it.id, r, i))
        .concat(named(it.id, r, 0)),
    }));
}

function named(id: Id, ring: number, index: number): Origin {
  return { kind: 'vertex', at: { id, ring, index } };
}

/** Everybody's share at once, through the full set. The yardstick's path, and
 * what the editor's own drawing goes through. */
function everything(at: readonly Contributed[]): Frame {
  // Sorted, so that two evaluations line up run by run. `worldset` hands its
  // runs back in whatever order the entries happen to sit in, which an edit
  // reorders; within one polygon the order is the boundary's own and is stable
  // for as long as the combinatorics are — which is exactly a stretch.
  // Floors are not in the set at all, so they are put back beside it rather
  // than read out of it. Sorting by id afterwards lands each one where its own
  // track put it, which is the order `sample` reads them in.
  return [
    ...pieces(live(EMPTY_LIVE, at).set)
      .map(p => ({
        id: p.source,
        points: p.points,
        corner: p.corner,
        whence: p.whence,
        fill: false,
      })),
    ...at.filter(it => it.kind === 'floor').flatMap(filling),
  ].sort((p, q) => p.id - q.id);
}

function evaluate(cast: Cast, items: Moving[], t: number, only: Id | null): Taken {
  const resolved = world1(items, t);
  const at = folded(cast, resolved, t);

  const frames = new Map(at.map(it => [it.id, it.frame]));
  const table = new Map<Id, Shape>();
  const world = new Map<Id, Shape>();
  const fade = new Map<Id, number[][]>();
  const moving = new Map(items.map(m => [m.at.id, m]));
  const was = new Map(resolved.map(it => [it.id, it]));

  for (const it of at) {
    world.set(it.id, it.shape);
    table.set(it.id, it.shape.map(ring => ring.map(q => unplace(it.frame, q))));

    // Only a polygon has source corners, and only they can be invented. A
    // group's union boundary has none to fade.
    const m = moving.get(it.id), mine = was.get(it.id);
    const how = m === undefined || mine === undefined ? null : fading(m, mine, t);

    if (how !== null) fade.set(it.id, how);
  }

  const out = only === null ? everything(at) : share(at, only);

  const frame = out.map(r => ({
    id: r.id,
    points: r.points.map(q => unplace(frames.get(r.id)!, q)),
    corner: r.corner,
    whence: r.whence,
    fill: r.fill,
  }));

  return { frame, table, world, out, fade, t };
}

// -----------------------------------------------------------------------------
// Who can reach whom
//
// A track is cut against a fixed list of polygons, so that list has to hold for
// the whole span rather than for one instant: something can slide into range
// half way through and start burying a boundary that was open until then.
//
// So each polygon is given the box it can reach anywhere in the span. The
// points are sampled along `t` and the boxes unioned, and the union is then
// grown by half the furthest any point travelled between two samples — which is
// the most a path can bow away from the chord its two samples span.
//
// It is taken off the polygon before the erosion, which only ever shrinks it,
// so the box covers the eroded shape at every depth the span passes through.
// That matters because erosion is the expensive part and this must not pay for
// it: reaching for the source ring is a few multiplies per vertex, and the
// whole sweep costs less than one CSG.
// -----------------------------------------------------------------------------

const PROBES = 16;

function reach(m: Moving): AABB {
  let all: AABB | null = null;
  let step = 0;
  let was: Ring | null = null;

  for (let k = 0; k <= PROBES; k++) {
    const t = k / PROBES;
    const now = place(riding(m, t), between(m.local[0], m.local[1], t));
    const box = ofRings([now]);

    all = all === null ? box : merge(all, box);

    if (was !== null) {
      for (let i = 0; i < now.length && i < was.length; i++) {
        step = Math.max(step, Math.hypot(now[i].x - was[i].x, now[i].y - was[i].y));
      }
    }

    was = now;
  }

  return expandBox(all ?? ofRings([m.at.source]), step / 2);
}

function expandBox(a: AABB, m: number): AABB {
  return { minX: a.minX - m, minY: a.minY - m, maxX: a.maxX + m, maxY: a.maxY + m };
}

/**
 * For each subject, the polygons it shares a span with — its own first, so a
 * track always has what it is about.
 *
 * By subject rather than by polygon, because an eroding group's boundary is a
 * question about the whole group: its members are never split across two
 * neighbourhoods, or a track would be cut against half of itself.
 */
function neighbourhoods(all: Subject[]): Moving[][] {
  const boxes = all.map(s => s.mine.map(reach).reduce(merge));

  // Floors are in neither half of it: nothing of theirs can bury a boundary and
  // no boundary can cut them, so they neither look nor are looked at.
  const tree: Tree = build(
    boxes.flatMap((box, id) => all[id].fill ? [] : [{ id, box }]),
  );

  return all.map((s, i) => {
    if (s.fill) return s.mine;

    const near = search(tree, boxes[i]).filter(j => j !== i);

    return [...s.mine, ...near.flatMap(j => all[j].mine)];
  });
}

/**
 * What has to hold for the shader to interpolate: the same arrangement, named.
 *
 * Positions are free to move — that is what interpolation is for — and
 * everything discrete is in here. Every point of the boundary says which corner
 * of whose outline it is, or which two edges cross there, so the whole
 * combinatorial state of the level is the set of those names, and a stretch is
 * exactly a run of instants over which the set does not change.
 *
 * Counting runs and their lengths was the old test, and it is a proxy that a
 * coincidence gets past: two arrangements can have the same shape of arrays
 * while naming different geometry, and then a stretch spans an event it was
 * meant to be cut at and interpolates one piece of boundary into another from
 * the far side of the level. Sorted, because which order the runs came back in
 * is the thing a signature must not be sensitive to — `lined` puts them in
 * order afterwards, and cannot be asked to do it before the two are known to be
 * the same arrangement at all.
 */
function signature(frame: Frame): string {
  return frame
    .map(r => `${r.id}:${[...new Set(r.whence.map(names))].sort().join(',')}`)
    .sort()
    .join(' ');
}

// -----------------------------------------------------------------------------
// Where a point came from
//
// The CSG hands back positions, and a position is not enough: a crossing has to
// be recomputed at every instant from the two edges that make it, or it slides
// wrongly whenever one polygon turns relative to another.
//
// So it hands back names as well. Every point the arrangement produces is one
// of exactly two things — a corner of somebody's outline, or the crossing of
// two edges — and `boundaryRuns` says which, in the members' own terms. See
// `Whither` in `geometry.ts`.
//
// This used to be read back off the geometry here instead, by hunting each
// point for a vertex or an edge near it. It worked, and everything built on it
// inherited a tolerance and an ordering that no reading could pin down: which
// corner a ring starts at, which run of a polygon is which, whether two
// readings are the same arrangement at all. All three are name comparisons now.
//
// The two ends are still checked against each other, and it is a real check
// rather than a formality: the stretch is *supposed* to hold the arrangement
// constant, so a point that comes from different edges at the two ends is a
// stretch that should have been split.
// -----------------------------------------------------------------------------

/** How close counts as on. Relative, so a world measured in thousands is not
 * held to a world measured in units. */
function near(shapes: Map<PolygonId, Shape>): number {
  let extent = 1;

  for (const shape of shapes.values()) {
    for (const ring of shape) {
      for (const p of ring) extent = Math.max(extent, Math.abs(p.x), Math.abs(p.y));
    }
  }

  return extent * 1e-9;
}

/**
 * The rings the origins name, at both ends, and nothing else.
 *
 * A polygon appears only where both ends have it: a stretch is supposed to hold
 * the arrangement still, and one that gained or lost a polygon part way is one
 * that should have been split.
 */
function table(
  a: Map<PolygonId, Shape>,
  b: Map<PolygonId, Shape>,
  origins: (Origin | null)[][],
): Map<PolygonId, { a: Rings, b: Rings }> {
  const out = new Map<PolygonId, { a: Rings, b: Rings }>();

  const need = (r: Ref): void => {
    const from = a.get(r.id), to = b.get(r.id);

    if (from === undefined || to === undefined) return;
    if (from[r.ring] === undefined || to[r.ring] === undefined) return;

    let both = out.get(r.id);

    if (both === undefined) {
      both = { a: [], b: [] };
      out.set(r.id, both);
    }

    both.a[r.ring] = from[r.ring];
    both.b[r.ring] = to[r.ring];
  };

  for (const run of origins) {
    for (const o of run) {
      if (o === null || o.kind !== 'cross') continue;

      need(o.a);
      need(o.b);
    }
  }

  return out;
}

function agreed(one: (Origin | null)[][], two: (Origin | null)[][]): (Origin | null)[][] {
  return one.map((run, r) => run.map((o, i) => {
    const q = two[r]?.[i];

    return o !== null && q !== null && q !== undefined && same(o, q) ? o : null;
  }));
}

function same(o: Origin, q: Origin): boolean {
  if (o.kind !== q.kind) return false;

  return o.kind === 'vertex'
    ? sameRef(o.at, (q as { at: Ref }).at)
    : sameRef(o.a, (q as { a: Ref, b: Ref }).a) && sameRef(o.b, (q as { a: Ref, b: Ref }).b);
}

function sameRef(p: Ref, q: Ref): boolean {
  return p.id === q.id && p.ring === q.ring && p.index === q.index;
}

/** Which corner of the shape this is, if it is one. */
function corner(shape: Shape, p: Point, snap: number): { ring: number, index: number } | null {
  for (let r = 0; r < shape.length; r++) {
    for (let i = 0; i < shape[r].length; i++) {
      const q = shape[r][i];

      if (Math.abs(q.x - p.x) <= snap && Math.abs(q.y - p.y) <= snap) {
        return { ring: r, index: i };
      }
    }
  }

  return null;
}


// -----------------------------------------------------------------------------
// Cutting the span
//
// The rule this has to meet is simple and is about the output, not about the
// method: at no instant may the replay be far from `csg(t)`. So rather than
// prove where the cuts belong and hope the proof covers everything, the bake
// *measures* — it builds a candidate stretch, checks it against the CSG in the
// middle, and splits until the check passes.
//
// Why not the event search
// ------------------------
// The previous version located topology events analytically: a vertex reaching
// an edge, and three edges through one point, both found by interval arithmetic
// over `t` with a completeness guarantee. That machinery is real and it works,
// and it still did not meet the rule, for two reasons that no amount of extra
// event kinds fixes:
//
// - **Between events the geometry is not straight.** A corner travels along its
//   mitre, and the mitre depends on the corner angle. Erode a polygon while a
//   vertex nudge is also in flight and the angle turns, so the corner's true
//   path bends and the chord between the two ends of the stretch cuts across
//   the bend. Nothing discrete happens, so there is no event to find. The doc
//   files this under *Known limits* for a squash and an erosion together, and
//   a nudge and an erosion is the same thing — but nudging while eroding is the
//   ordinary way to author, not a corner case.
//
// - **Not every change in the output is a change in the geometry.** The CSG
//   reports its boundary as runs, and where several runs meet, which one
//   carries on through the junction is decided by a walk rather than by the
//   shape. That can change with no vertex near any edge and no three edges
//   concurrent — measured on six overlapping boxes, at a moment whose nearest
//   coincidence was 0.05 world units away.
//
// Measuring answers both, because it does not care why two things differ.
//
// How it goes
// -----------
// Take the whole span, evaluate the CSG at both ends, and ask whether one
// stretch would do:
//
// - The two ends disagree about the arrangement — different runs, or the same
//   runs coming off different edges — so there is nothing to interpolate along.
//   Split.
// - They agree. Build the stretch, evaluate the CSG at the midpoint, and
//   compare it against what the stretch would have drawn there. Too far? Split.
// - Good enough. Keep it.
//
// Splitting reuses the midpoint that was just evaluated, so a stretch costs one
// evaluation plus a shared one at each end.
//
// The recursion stops on width as well as on error, and that is what finds the
// discontinuities: at a genuine event the two sides never come to agree however
// narrow the interval gets, so the interval keeps halving until it is thinner
// than `GAP` and is then handed back as a gap between two stretches rather than
// as a stretch. That is the same keyframe the event search was there to place —
// arrived at from the other side, and without needing to know what kind of
// event it was.
//
// What it costs, and what that buys
// ---------------------------------
// Three evaluations per stretch kept, one per stretch rejected, and about
// fourteen per discontinuity to pin it down — but each one is a polygon's own
// neighbourhood rather than the level, so a busy thousand-polygon span runs a
// hundred thousand of them in half a minute. It is offline work behind a
// progress bar either way.
//
// What it buys is the guarantee itself: `Span.worst` is how far the replay was
// ever measured to be from the truth, so the bake states its own error instead
// of resting on an argument about which events exist.
// -----------------------------------------------------------------------------

/**
 * How far, in world units, the replay may sit from the CSG before a stretch is
 * split. Well under a pixel at any sane zoom.
 *
 * A width, not a tolerance in `t`, which is what makes it meaningful: it is the
 * thing the eye would see.
 */
export const TOLERANCE = 0.05;

/**
 * How thin an interval has to get before the bisection gives up on it.
 *
 * One meaning, used for both of the things that end a bisection. An interval the
 * two sides will not agree about is a discontinuity, and this is how finely it is
 * pinned; an interval they agree about but whose middle the stretch cannot reach
 * is a curve too sharp to follow, and this is how far it is chased.
 *
 * It used to be two meanings under one name, and the second was doing damage. A
 * narrow interval whose ends were comparable was kept *without being checked at
 * all* — not "we found an event" but "we stopped asking" — and whatever the
 * interpolation did in the middle went unmeasured and unreported. What that hid
 * was a unit of pop in anything much turning, with `Span.worst` calmly saying
 * two hundredths. Now the check runs whether or not there is width left to split,
 * and what it finds goes into `worst` either way.
 *
 * It is a width in `t`, and the pop it leaves is that width times how fast the
 * geometry is moving. That is a few thousandths of a unit for a vertex, which is
 * what this value was once reasoned from — but a *crossing* has no such bound:
 * two edges going parallel send their meeting point off at any speed you like,
 * and near one of those the outline has been measured moving eight units inside
 * a single gap. So this is not a value anybody can argue is enough, and it is
 * not claimed to be. It is the depth the search gives up at, and everything it
 * gives up on now goes into `worst` — which is where to look.
 *
 * What the levels to hand say, measured rather than guessed. A tenth of this is
 * cheap and useless on a quiet level and ruinous on a busy one: 28s against 45s
 * for a `worst` of 1.70 against 0.10, which is thirty-four times the tolerance.
 * A tenth the other way brings that level inside tolerance at 59s. So it sits
 * here, and a level whose `worst` has crept past `TOLERANCE` is a level that
 * wants it smaller — which is now a thing the bake can be asked rather than a
 * thing to be guessed at.
 */
const GAP = 1e-4;

/**
 * The same, for an interval whose two ends agree and whose middle the stretch
 * cannot reach.
 *
 * Its own constant because the two cost wildly different amounts. Pinning an
 * event is a bisection and every event pays for it, so halving `GAP` doubles the
 * cover; chasing a bend happens in the handful of places that bend, so this can
 * be orders of magnitude finer for nothing. On the busiest level to hand,
 * dropping it two decades cost six-tenths of a percent and halved the error the
 * bake had to own — where dropping `GAP` one decade cost a third of the bake for
 * the same answer.
 *
 * They were one constant, and what that bought was every event in the level
 * paying the price of the few places that needed the depth.
 */
const BEND = 1e-6;

const MARGIN = 0.5;

/** Two evaluations that could be the ends of one stretch, or could not. */
function comparable(a: Taken, b: Taken): boolean {
  return signature(a.frame) === signature(b.frame) && explained(a, b);
}

/**
 * Whether every point that turns — or stops turning — between these two
 * readings has something to fade over.
 *
 * Corner-ness is drawn: a wall stands a vertical where the boundary turns. It
 * is deliberately not an event, because a vertex emerging over a span is a
 * move, and `fading` gives it a value at each end for the line to fade
 * between. That is the case this is careful to keep.
 *
 * What it will not accept is a corner that changes with no fade behind it,
 * which `fading` cannot produce: it covers vertices that die between the span's
 * two ends, and a corner can also come and go because a *neighbour* moved —
 * two rooms flush against each other at one version and apart at the next make
 * a junction that exists at a single instant. Nothing interpolates that, so the
 * two ends of a stretch holding it differ by a whole unit of opacity, and the
 * line is fully drawn for the width of the stretch and gone after it. Called an
 * event instead, the cut pins it and keeps the two instants either side, and
 * half-open ownership draws neither.
 */
function explained(a: Taken, b: Taken): boolean {
  const plan = lining(a.frame, b.frame);

  if (plan === null) return false;

  const there = following(b.frame, plan);

  const covered = (o: Origin): boolean => {
    if (o.kind !== 'vertex') return false;

    const where = (it: Taken) => it.fade.get(o.at.id)?.[o.at.ring]?.[o.at.index];

    return where(a) !== undefined || where(b) !== undefined;
  };

  return a.frame.every((run, r) => {
    const other = there[r];

    return other !== undefined && run.corner.every((c, i) =>
      c === other.corner[i] || covered(run.whence[i]));
  });
}

/**
 * The furthest apart the two outlines are, as sets of points rather than as
 * lists of them.
 *
 * `apart` is the sharper measure and the right one everywhere it can be used: it
 * pairs point with point, so it catches a point that has slid along a boundary
 * the shape of which has not changed. It needs the two readings to agree about
 * where their rings start, which is what `lined` is for.
 *
 * In the window `abutting` gives away, they do not agree. The stretch is being
 * drawn past the end it was cut at and the fresh evaluation has cut its runs its
 * own way, so `lined` pairs points that are not each other's opposite number and
 * calls a shape that is right to within a twentieth of a unit a hundred and
 * eighteen units wrong. A measure of `worst` that overstates by two thousand
 * times is no more use than one that understates, so that one region is measured
 * the blunt way: how far is any point of either from the nearest point of the
 * other. It cannot see a permutation, and there is nothing there to see.
 */
function strayed(a: Frame, b: Frame): number {
  const far = (from: Point[], to: Point[]): number => {
    let worst = 0;

    for (const p of from) {
      let near = Infinity;

      for (const q of to) near = Math.min(near, Math.hypot(p.x - q.x, p.y - q.y));

      worst = Math.max(worst, near);
    }

    return worst;
  };

  const one = a.flatMap(r => r.points), two = b.flatMap(r => r.points);

  if (one.length === 0 || two.length === 0) return one.length === two.length ? 0 : Infinity;

  return Math.max(far(one, two), far(two, one));
}

/**
 * The furthest any point of the interpolated stretch sits from the point the
 * CSG puts there. Infinite when the two do not even agree on what points there
 * are, which is a disagreement no distance describes.
 */
function apart(guess: Frame, actual: Frame): number {
  if (guess.length !== actual.length) return Infinity;

  // Where a ring starts is not part of the question. The two are the same
  // boundary at the same instant, read twice; how far apart they are is asked
  // of the corners, not of whichever one the walk happened to begin at.
  const lined_ = lined(guess, actual);

  let worst = 0;

  for (let r = 0; r < guess.length; r++) {
    const p = guess[r], q = lined_[r];

    if (p.id !== q.id || p.points.length !== q.points.length) return Infinity;

    for (let i = 0; i < p.points.length; i++) {
      worst = Math.max(worst, Math.hypot(
        p.points[i].x - q.points[i].x,
        p.points[i].y - q.points[i].y,
      ));
    }
  }

  return worst;
}

/** One name, as a string, so that two of them can be compared and a set of
 * them can be looked up. */
function names(o: Origin): string {
  const ref = (r: Ref) => `${r.id}.${r.ring}.${r.index}`;

  return o.kind === 'vertex' ? `v${ref(o.at)}` : `x${ref(o.a)}|${ref(o.b)}`;
}

/**
 * How far to turn `b` so that it lines up with `a`: two readings of one ring,
 * paired corner for corner.
 *
 * **Where a ring starts is not a fact about the ring.** It closes on itself, so
 * the arrangement hands it back cut wherever the walk began, and two readings
 * of a pillar that has not moved at all can come back cut at different corners
 * — the same points, rotated by one. Paired as they came, every corner is
 * dragged toward its neighbour, and half way across the stretch the pillar is a
 * square inscribed in itself at forty-five degrees.
 *
 * Names cannot settle it, though they look as if they should. A name carries an
 * index, and that index is a position in the ring as the arrangement handed it
 * over — so when the arrangement re-cuts the ring, the names travel with the
 * cut. Both readings then say `index 0` about different corners, agree with
 * each other perfectly, and are both wrong. That is what this used to do.
 *
 * What settles it is that the two ends of a stretch are the same shape a moment
 * apart. These points are kept in the polygon's own frame, so nothing rigid
 * moves them: only erosion does, continuously, and a stretch is cut short of
 * any event. So the true rotation costs a few microns and every other rotation
 * costs an edge, which is the whole width of the pillar. Names are kept for the
 * ties, where two rotations really are equally close.
 */
function phase(a: Turnable, b: Turnable): number | null {
  const n = a.points.length - 1;

  if (n < 1 || b.points.length !== a.points.length) return null;

  let best = 0, cost = Infinity, agree = -1;

  for (let k = 0; k < n; k++) {
    let far = 0, same = 0;

    for (let j = 0; j < n; j++) {
      const p = a.points[j], q = b.points[(j + k) % n];

      far += (p.x - q.x) ** 2 + (p.y - q.y) ** 2;

      if (names(a.whence[j]) === names(b.whence[(j + k) % n])) same++;
    }

    if (far < cost || (far === cost && same > agree)) {
      best = k; cost = far; agree = same;
    }
  }

  return best;
}

interface Turnable {
  points: Point[]
  corner: boolean[]
  whence: Origin[]
}

/** A ring walked from `k` instead of from 0, its repeated last point kept. */
function turned<A extends Turnable>(run: A, k: number): A {
  const n = run.points.length - 1;

  if (k === 0 || n < 2) return run;

  const points: Point[] = [], corner: boolean[] = [], whence: Origin[] = [];

  for (let i = 0; i <= n; i++) {
    points.push(run.points[(k + i) % n]);
    corner.push(run.corner[(k + i) % n]);
    whence.push(run.whence[(k + i) % n]);
  }

  return { ...run, points, corner, whence };
}

/** Whether a run closes on itself. Its names say so: the last point is the
 * first one, written down twice. */
function closes(run: { whence: readonly Origin[] }): boolean {
  const n = run.whence.length;

  return n > 2 && names(run.whence[0]) === names(run.whence[n - 1]);
}

/**
 * How to read one reading in another's order: for each run of `to`, which run
 * of `from` answers to it and how far that run has to be turned.
 *
 * Two things are lined up here, and both used to be left to the order the two
 * readings happened to come back in. Which run answers to which: a polygon's
 * boundary can be several runs, and at an event the arrangement reorders them,
 * so pairing them by position pairs pieces from opposite ends of the level.
 * And where within a run: see `phase`.
 *
 * Null where any run cannot be found. All or nothing: a frame half in one order
 * and half in another is worse than one honestly left alone, and the caller
 * reads a length that does not match as the arrangement having moved on. A run
 * with no counterpart means the arrangement changed — an event, and a stretch
 * that spans one is a stretch that should have been cut.
 *
 * The plan is worked out once and applied to every view a reading has of its
 * own runs. Working it out again per view is what this used to do, and the two
 * answers are not the same answer: the same ring in the polygon's frame and in
 * the world's is the same ring, but the runs are matched by name and turned by
 * distance, and neither is obliged to break a tie the same way twice. The
 * views then disagree about which run is which — and since the points are
 * drawn from one and the corner flags read from another, a wall gets a line
 * standing at a corner it does not have.
 */
function lining(to: Frame, from: Frame): { at: number, k: number }[] | null {
  // What a run *is*: whose boundary, and which points of the arrangement it
  // visits. A set rather than a list, because the order is the thing in
  // question — and a ring's first point is written down twice, which a list
  // would count and a set does not.
  const which = (run: Run) =>
    `${run.id}:${[...new Set(run.whence.map(names))].sort().join(',')}`;

  const spare = new Map<string, number>();

  from.forEach((run, i) => {
    if (!spare.has(which(run))) spare.set(which(run), i);
  });

  const taken = new Set<number>();
  const plan: { at: number, k: number }[] = [];

  for (const want of to) {
    const at = spare.get(which(want));

    if (at === undefined || taken.has(at)) return null;

    taken.add(at);

    const run = from[at];
    const k = closes(run) && closes(want) ? phase(want, run) : 0;

    if (k === null) return null;

    plan.push({ at, k });
  }

  return plan;
}

/** A reading put in the order a plan asks for. The same `from` back when the
 * plan asks for nothing, so a caller can tell that nothing moved. */
function following(from: Frame, plan: { at: number, k: number }[]): Frame {
  if (plan.every(({ at, k }, i) => at === i && k === 0)) return from;

  return plan.map(({ at, k }) => turned(from[at], k));
}

/**
 * One reading read in another's order. See `lining` — this is that plan, worked
 * out and applied in one go, for a caller with only one view to line up.
 */
export function lined(to: Frame, from: Frame): Frame {
  const plan = lining(to, from);

  return plan === null ? from : following(from, plan);
}

function stretchOf(a: Taken, b: Taken): Stretch {
  // The far end read in the near end's order. Nothing else in the span pairs
  // two readings, and this is the only place both are in hand. Both of a
  // Taken's views of its runs go together, or the frames and the world drift
  // apart.
  // Worked out on the frames and applied to both, so the two views of one
  // reading stay the same runs in the same order. `frame` is what gets drawn
  // and `out` is what the corner flags and the fade are read off; line them
  // separately and a point can be a corner in one and not in the other.
  const plan = lining(a.frame, b.frame);
  const frame = plan === null ? b.frame : following(b.frame, plan);
  const to: Taken = frame === b.frame
    ? b
    : { ...b, frame, out: following(b.out, plan!) };

  // Straight off the runs. The arrangement named every point when it made it.
  const one = a.out.map(r => r.whence), two = to.out.map(r => r.whence);
  const reconciled = agreed(one, two);

  return {
    t0: a.t,
    t1: b.t,
    a: a.frame,
    b: to.frame,
    table: table(a.table, to.table, reconciled),
    origins: reconciled,

    // Each end's own reading, rather than the reconciled one: a point the two
    // ends disagree about the provenance of still has an opacity at each of
    // them, and it is the fade that would be lost by insisting they agree.
    opacity: [faded(a, one), faded(to, two)],
  };
}

/**
 * How solid each output point is: the projection vertex it stands on, and
 * whether there is a corner there at all.
 *
 * Both say how much of a corner is there and both are lerped across the
 * stretch, so they are one number rather than two channels — a vertex emerging
 * fades in over the run it emerges through, and a corner straightening out
 * fades the same way. A crossing is a corner by construction and is always
 * drawn.
 */
function faded(taken: Taken, os: (Origin | null)[][]): number[][] {
  return taken.out.map((run, r) => run.points.map((_unused, i) => {
    if (!run.corner[i]) return 0;

    const o = os[r]?.[i];

    if (o === null || o === undefined || o.kind !== 'vertex') return 1;

    return taken.fade.get(o.at.id)?.[o.at.ring]?.[o.at.index] ?? 1;
  }));
}


/** A stretch of no width, carrying one instant exactly. Either side of a gap
 * needs one, so that the geometry at the discontinuity itself is not lost. */
function instant(a: Taken): Stretch {
  return stretchOf(a, a);
}

interface Cut {
  stretches: Stretch[]
  jumps: Stretch[]
  /** The worst the check ever measured, over the whole track. */
  worst: number
  evaluations: number
}

/**
 * One polygon's own cut of the span.
 *
 * The measuring is the same as it ever was; what has changed is what is being
 * measured. A stretch used to end when *anything anywhere* changed, which put a
 * whole-world keyframe in the file for an event two hundred rooms away and made
 * both the work and the file grow with the square of the level. A polygon's
 * boundary is a question about its own neighbourhood, so its keyframes are too.
 */
function* cutTrack(
  cast: Cast,
  sub: Moving[],
  id: Id,
  riders: Map<Id, Rider>,
  tol: number,
): Generator<number, Cut, void> {
  const out: Stretch[] = [];

  let evaluations = 0;
  let worst = 0;

  const at = (t: number): Taken => {
    evaluations++;

    return evaluate(cast, sub, t, id);
  };

  // Left to right, so what comes out is in order and the progress is honest:
  // how much of the span has been settled, which only ever goes forwards.
  const stack: [Taken, Taken][] = [[at(0), at(1)]];

  let done = 0;

  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    const narrow = b.t - a.t <= GAP;

    if (!comparable(a, b)) {
      if (!narrow) {
        const m = at((a.t + b.t) / 2);

        stack.push([m, b], [a, m]);
        continue;
      }

      // Pinned as far as it is worth pinning: a discontinuity, and the two
      // sides of it genuinely have different geometry. Both are kept.
      keep(instant(a));
      keep(instant(b));

      done = b.t;
      yield done;
      continue;
    }

    const s = stretchOf(a, b);

    // How far the stretch would sit from the truth at an instant inside it.
    const check = (c: Taken): number =>
      comparable(a, c) ? apart(drawn(s, riders, c.t), c.out) : Infinity;

    const m = at((a.t + b.t) / 2);

    let off = check(m);

    // One sample does not bound a curve. The middle is where a bend is worst
    // and is therefore the right place to look first, but a run whose points
    // are moving different ways can be well behaved there and off elsewhere,
    // so an acceptance is confirmed at the quarters before it is believed.
    //
    // This used to be carried by accident: a stretch ended when anything
    // anywhere changed, so a busy neighbour's keyframes were sprinkled through
    // a quiet polygon's span and cut its curves up for it. Cutting each polygon
    // on its own takes that away, and it has to be paid for honestly.
    if (off <= tol * MARGIN) {
      for (const f of [0.25, 0.75]) {
        off = Math.max(off, check(at(a.t + (b.t - a.t) * f)));

        if (off > tol * MARGIN) break;
      }
    }

    if (off > tol * MARGIN && b.t - a.t > BEND) {
      stack.push([m, b], [a, m]);
      continue;
    }

    // Narrow and still not agreeing: the ends were comparable but the inside is
    // not, which is a discontinuity that has been pinned as far as it is worth
    // pinning — the same answer the incomparable path above reaches, from the
    // other side of it.
    if (!Number.isFinite(off)) {
      keep(instant(a));
      keep(instant(b));

      done = b.t;
      yield done;
      continue;
    }

    // Measured whether or not it passed. A stretch kept because the interval ran
    // out of width is still the bake's error to own: `worst` is what the bake
    // says about itself, and a number that only counts the checks that went well
    // is not that. This used to be the one place a stretch was kept with no
    // check at all, and what it hid was a whole unit of pop in a level with
    // anything much turning in it.
    worst = Math.max(worst, off);
    keep(s);

    done = b.t;
    yield done;
  }

  const kept = out.filter(wide);
  const cover = abutting(kept);

  // What `abutting` gives away, checked. Closing the gaps around an event hands
  // each neighbour half of one, so a stretch is drawn over a window wider than
  // the one it was measured over — and `abutting` calls that safe on the grounds
  // that half a gap is smaller than the tolerance the gap converged to. That
  // holds for a vertex. It does not hold for a crossing: two edges going
  // parallel send their meeting point off at any speed, and the outline has been
  // measured moving eight units inside one gap. So it is measured rather than
  // argued, and what it finds is `worst` like anything else — this was the one
  // region of the cover nothing looked at, and every instant the replay was ever
  // caught out at was inside one.
  for (let i = 0; i < cover.length; i++) {
    const grown = cover[i], was = kept[i];

    for (const t of [grown.t0, grown.t1]) {
      if (t >= was.t0 && t <= was.t1) continue;

      const c = at(t);

      // The two sides of an event genuinely differ, and the size of that is the
      // event's own, not the replay's — the same exclusion `apart` makes by
      // coming back infinite. Here it has to be made in so many words, because
      // `strayed` will cheerfully measure the distance across a discontinuity
      // and report the pop as though the replay had invented it.
      if (signature(drawn(grown, riders, t)) !== signature(c.out)) continue;

      worst = Math.max(worst, strayed(drawn(grown, riders, t), c.out));
    }
  }

  return { stretches: cover, jumps: out.filter(s => !wide(s)), worst, evaluations };

  function keep(s: Stretch): void {
    const last = out[out.length - 1];

    // Two instants running together, or a stretch that adds nothing.
    if (last !== undefined && last.t0 === last.t1 && last.t0 === s.t0 && s.t0 === s.t1) {
      return;
    }

    out.push(s);
  }
}

/**
 * The gaps between one stretch and the next closed, each side taking half.
 *
 * Converging on an event leaves a hair of a gap: the search stops once the two
 * sides are near enough, and what is between them belongs to neither. Something
 * has to be drawn there, and the choice is where to make it.
 *
 * Making it here is the only place it can be made *once*. Left open, every
 * reader has to decide for itself what an uncovered instant means, and the two
 * readers disagreed: the CPU took the nearer side, and the shader let both
 * sides draw across a fixed window. A fixed window is the part that cannot
 * work — the gaps are as small as the search made them, but the stretches
 * beside an event are smaller still, so the window swallowed whole stretches
 * and drew the topology from either side of the event at once. One frame of a
 * doubled wall, with a vertical standing where the boundary had not reached
 * yet, at the start of every animation however long it ran.
 *
 * Closed, every instant belongs to exactly one stretch, and both readers agree
 * because there is nothing left to decide. The cost is that a stretch is
 * interpolated over a window wider than the one it was measured over, by half
 * a gap — smaller than the tolerance the gap was converged to.
 *
 * An instant carries the geometry *at* a discontinuity and has no width to
 * interpolate over: growing it holds that geometry across the gap, which is
 * what it was put there for.
 */
function abutting(stretches: readonly Stretch[]): Stretch[] {
  const out = stretches.map(s => ({ ...s }));

  for (let i = 1; i < out.length; i++) {
    const gap = out[i].t0 - out[i - 1].t1;

    if (gap <= 0) continue;

    const mid = out[i - 1].t1 + gap / 2;

    out[i - 1].t1 = mid;
    out[i].t0 = mid;
  }

  // The ends of the span belong to the cover too. What sat between them and it
  // was a jump, and a jump owns no interval.
  if (out.length > 0) {
    out[0].t0 = 0;
    out[out.length - 1].t1 = 1;
  }

  return out;
}

/** An interval, rather than the geometry at a single instant. */
function wide(s: Stretch): boolean {
  return s.t1 > s.t0;
}

// -----------------------------------------------------------------------------
// Baking
// -----------------------------------------------------------------------------

/** Some of a span's tracks, and what cutting them measured. */
export interface Slice {
  tracks: Track[]
  worst: number
  evaluations: number
  /** Milliseconds spent resolving the world before any of it could be cut. Not
   * used for anything; it is here because it is the part a thread cannot share
   * with the others, and therefore the part that decides how well this scales. */
  setup: number
  /** Milliseconds spent cutting, which is the part that divides. */
  cut: number
}

/**
 * What every polygon's runs ride, which the span needs and a slice of it does
 * not: it is small, and a thread that has been handed some of the polygons has
 * no business deciding it for the others.
 */
/**
 * What every polygon's runs ride, which the span needs and a handful of it does
 * not.
 *
 * In the order `ready` puts its items in, because that is what a job names its
 * polygons by: both go through `moving`, and a job that meant a different
 * polygon than the thread cutting it would be a silent wrong answer rather than
 * an error.
 */
export function ridersOf(world: World, from: VersionId): Map<Id, Rider> {
  const cast = casting(world, from);
  const out = ridden(cast, subjects(cast));

  for (const [id, rider] of carried(world, from)) out.set(id, rider);

  return out;
}

/**
 * What each artefact rides, which is what a polygon rides.
 *
 * An artefact has no geometry and so no track, and it is in here for one
 * reason: a slot in the frame table. Everything that carries a wall carries
 * whatever is standing in it, so a key on the floor of a room that turns goes
 * round with the room rather than taking the chord — and it does so by riding
 * the same chain, eased the same way, rather than by a second answer to a
 * question the frame table already answers.
 *
 * Born and taken out the same way a polygon is, with the one difference that an
 * artefact has no size: there is nothing to grow out of a point or shrink back
 * into one, so what those get here is not a scale but the rest of it. Either
 * way it hangs in its group's frame from the near end of the span and rides
 * whatever that group does, so a key introduced into a room that also turns
 * goes round with the room instead of waiting at the far end for it, and one
 * taken out of a turning room turns on its way out.
 *
 * The layer it eases is its own, and only where it is standing at both ends.
 * Arriving, the transform is applied outright — it says where the artefact is
 * rather than where it went, and there is no earlier place for it to be a move
 * away from. Leaving, there is nothing to ease at all: whatever the later
 * version says about it was written before the delete and is inert, exactly as
 * `moving` says of a polygon's.
 */
function carried(world: World, from: VersionId): Map<Id, Rider> {
  const next = world.versions[from + 1];
  const out = new Map<Id, Rider>();

  if (next === undefined) return out;

  const near = new Set(chain(world, from));
  const far = new Set(chain(world, from + 1));

  for (const [id, it] of world.artefacts) {
    const here = standingIn(world, id, near), there = standingIn(world, id, far);

    // At neither end is not in the span at all: one the versions have not
    // reached yet, and one they finished with before it began.
    if (!here && !there) continue;

    const own = next.edits.get(id)?.transform ?? EMPTY_TRANSFORM;
    const base = groupFrame(world, from, id);

    out.set(id, {
      base: here ? base : compose(affine(own), base),
      layer: here && there ? own : EMPTY_TRANSFORM,
      holders: holders(world, from, id),
    });
  }

  return out;
}

/**
 * What each subject's runs ride.
 *
 * A polygon rides its own chain. An eroding group rides nothing: its members'
 * frames already carry every transform above them, so the union it hands over
 * is in world units with the motion in it, and a layer applied here would be
 * that motion applied twice.
 */
function ridden(cast: Cast, all: Subject[]): Map<Id, Rider> {
  const own = new Map(cast.items.map(m => [m.at.id, m]));

  return new Map(all.map(s => {
    const m = own.get(s.id);
    const group = sidedWith(s.id) ?? s.id;

    return [
      s.id,
      m === undefined
        ? cast.riders.get(group) ?? { base: IDENTITY, layer: EMPTY_TRANSFORM, holders: [] }
        : {
          base: m.base,
          layer: m.layer,
          holders: m.holders,
        },
    ];
  }));
}

/**
 * A span resolved and ready to be cut, but not cut.
 *
 * Worth naming because it is the part a thread cannot share with the others and
 * cannot avoid: resolving the world twice, and working out who can reach whom.
 * A thread that is handed the polygons a few at a time does this once and keeps
 * it, rather than once per handful.
 */
export interface Ready {
  from: VersionId
  cast: Cast
  /** What the tracks are cut for, and what a job names them by. */
  items: Subject[]
  near: Moving[][]
  riders: Map<Id, Rider>
  /** Milliseconds it took, which is the fixed cost of putting a thread on this
   * span at all. */
  setup: number
}

export function ready(world: World, from: VersionId): Ready {
  const began = now();
  const cast = casting(world, from);
  const items = subjects(cast);

  return {
    from,
    cast,
    items,
    near: neighbourhoods(items),
    riders: ridden(cast, items),
    setup: now() - began,
  };
}

/**
 * Some of a span's polygons, named by their place in `at.items`.
 *
 * Tracks are independent by construction: each is cut against its own
 * neighbourhood, reads nothing but the world it was given, and writes nowhere.
 * That is what makes this a dealing-out problem rather than a synchronising
 * one — and what lets the caller deal them out a handful at a time and keep
 * whichever thread comes back first busy, which matters because polygons differ
 * wildly in what they cost. One that nothing happens to is a single stretch;
 * one in a corner where three rooms are all eroding is a hundred. Dealt out in
 * advance, one thread draws the short straw and everybody waits for it.
 */
export function* cutSome(
  at: Ready,
  which: readonly number[],
  tol: number = TOLERANCE,
): Generator<number, Slice, void> {
  const began = now();
  const tracks: Track[] = [];

  let worst = 0;
  let evaluations = 0;

  for (let k = 0; k < which.length; k++) {
    const i = which[k];
    const { id, fill } = at.items[i];

    const cut = yield* weighted(
      cutTrack(at.cast, at.near[i], id, at.riders, tol),
      k / which.length,
      1 / which.length,
    );

    tracks.push({ id, fill, stretches: cut.stretches, jumps: cut.jumps });

    worst = Math.max(worst, cut.worst);
    evaluations += cut.evaluations;
  }

  return { tracks, worst, evaluations, setup: 0, cut: now() - began };
}

function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

/** Part of a span: every polygon whose place in the list falls to `index` when
 * the list is dealt out `of` ways. The serial path's slicing, and the bench's. */
export function* bakeSlice(
  world: World,
  from: VersionId,
  index: number,
  of: number,
  tol: number = TOLERANCE,
): Generator<number, Slice, void> {
  const at = ready(world, from);
  const which: number[] = [];

  for (let i = index; i < at.items.length; i += of) which.push(i);

  const slice = yield* cutSome(at, which, tol);

  return { ...slice, setup: at.setup };
}

/** Every slice put back together, in the order `sample` reads them. */
export function joined(
  world: World,
  from: VersionId,
  riders: Map<Id, Rider>,
  slices: readonly Slice[],
): Span {
  const tracks = slices.flatMap(s => s.tracks).sort((p, q) => p.id - q.id);

  return {
    from,
    tracks,
    riders,
    worst: Math.max(0, ...slices.map(s => s.worst)),
    evaluations: slices.reduce((n, s) => n + s.evaluations, 0),
    setup: slices.reduce((n, s) => n + s.setup, 0),
    cut: slices.reduce((n, s) => n + s.cut, 0),
    stamp: stamp(world, from),
  };
}

/**
 * One span, as a generator so that the editor can run it a slice at a time and
 * keep drawing. It yields how far along it is, between 0 and 1.
 *
 * The whole thing on one thread: the slice that is all of it.
 */
export function* bakeSpan(
  world: World,
  from: VersionId,
  tol: number = TOLERANCE,
): Generator<number, Span, void> {
  const slice = yield* bakeSlice(world, from, 0, 1, tol);

  return joined(world, from, ridersOf(world, from), [slice]);
}

/** Every span in the chain, one after the other. */
export function* bakeAll(world: World): Generator<number, Map<VersionId, Span>, void> {
  const out = new Map<VersionId, Span>();
  const count = world.versions.length - 1;

  for (let k = 0; k < count; k++) {
    const span = yield* weighted(bakeSpan(world, k), k / count, 1 / count);

    out.set(k, span);
  }

  return out;
}

/** A generator's 0-to-1 progress, moved into its slice of a longer one. */
function* weighted<T>(
  inner: Generator<number, T, void>,
  base: number,
  width: number,
): Generator<number, T, void> {
  while (true) {
    const step = inner.next();

    if (step.done) return step.value;

    yield base + step.value * width;
  }
}

// -----------------------------------------------------------------------------
// Replaying
//
// What the shader would do, on the canvas instead: find the stretch `t` is in
// and lerp its two ends. Nothing here consults the world — that is the point of
// looking at it, since a bake that disagrees with the editor is a bake that
// would disagree with the game.
// -----------------------------------------------------------------------------

/**
 * Every track read at the same instant and put back together, in id order,
 * which is the order the full set hands its runs over in.
 *
 * The tracks are cut independently and their keyframes almost never line up,
 * which is the point: two rooms at opposite ends of a level have no reason to
 * be told about each other's corners.
 */
export function sample(span: Span, t: number): Frame {
  const out: Frame = [];

  for (const track of span.tracks) {
    const s = stretchAt(track, t);

    if (s !== null) out.push(...drawn(s, span.riders, t));
  }

  return out;
}

/**
 * One stretch, evaluated at an instant inside it — the whole of what the shader
 * would do, and the thing the bake checks itself against.
 */
function drawn(s: Stretch, riders: Map<Id, Rider>, t: number): Frame {
  const u = s.t1 === s.t0 ? 0 : (t - s.t0) / (s.t1 - s.t0);

  // One per polygon rather than one per point: every vertex of a polygon rides
  // the same layer, and rebuilding it is four trig calls.
  const frames = new Map<PolygonId, Affine>();

  const frameOf = (id: PolygonId): Affine => {
    const known = frames.get(id);
    if (known !== undefined) return known;

    const made = riding(riders.get(id)!, t);

    frames.set(id, made);

    return made;
  };

  /** A table entry, evaluated: `apply(lerp(T), lerp(local))`. */
  const entry = (r: Ref): Point | null => {
    const both = s.table.get(r.id);
    const a = both?.a[r.ring], b = both?.b[r.ring];

    if (a === undefined || b === undefined) return null;

    const p = a[r.index % a.length], q = b[r.index % b.length];

    if (p === undefined || q === undefined) return null;

    return place(frameOf(r.id), [{ x: mix(p.x, q.x, u), y: mix(p.y, q.y, u) }])[0];
  };

  const ends = (r: Ref): [Point, Point] | null => {
    const ring = s.table.get(r.id)?.a[r.ring];
    if (ring === undefined) return null;

    const a = entry(r);
    const b = entry({ ...r, index: (r.index + 1) % ring.length });

    return a === null || b === null ? null : [a, b];
  };

  return s.a.map((run, i) => {
    const to = s.b[i] ?? run;
    const frame = frameOf(run.id);
    const origins = s.origins[i] ?? [];

    return {
      id: run.id,
      corner: run.corner,
      whence: run.whence,
      fill: run.fill,
      points: run.points.map((p, j) => {
        const solved = crossing(origins[j], ends);

        if (solved !== null) return solved;

        // A vertex of its own polygon, or a point the reading could not place.
        // Either way it interpolates in the polygon's frame, which for a vertex
        // is exact and for the rest is what the measured check is for.
        const q = to.points[j] ?? p;

        return place(frame, [{ x: mix(p.x, q.x, u), y: mix(p.y, q.y, u) }])[0];
      }),
    };
  });
}

/**
 * Where the two edges meet, from their four endpoints — the ten multiply-adds
 * the doc gives the shader.
 *
 * Nothing here checks that they meet inside their segment bounds, because that
 * is what the stretch is for: an endpoint passing through the other edge is an
 * event, and would have ended it. Parallel is possible all the same, at the
 * instant an event is arriving, and gives up rather than dividing by nothing.
 */
function crossing(
  origin: Origin | null | undefined,
  ends: (r: Ref) => [Point, Point] | null,
): Point | null {
  if (origin === null || origin === undefined || origin.kind !== 'cross') return null;

  const one = ends(origin.a), two = ends(origin.b);
  if (one === null || two === null) return null;

  const [p, q] = one, [r, w] = two;
  const ux = q.x - p.x, uy = q.y - p.y;
  const vx = w.x - r.x, vy = w.y - r.y;

  const d = ux * vy - uy * vx;
  if (d === 0) return null;

  const k = ((r.x - p.x) * vy - (r.y - p.y) * vx) / d;

  return { x: p.x + ux * k, y: p.y + uy * k };
}

/**
 * The stretch holding `t`, or the nearest one when `t` has landed in an event's
 * own bracket.
 *
 * The stretches come out of the cut in order and cover the span, so this is a
 * search rather than a scan. It is asked once per polygon per frame, and a
 * level's worth of linear scans through a busy track was showing up in the
 * replay's own frame time.
 */
export function stretchAt(track: Track, t: number): Stretch | null {
  // A jump answers for its own instant and for nothing else. Asked for exactly
  // the instant an arrangement changes, that is the arrangement to draw — it is
  // what the editor draws standing still at that version, and it is what the
  // span has to begin and end on. Asked for any other instant it has nothing to
  // say, which is why it is not in the cover.
  for (const j of track.jumps) {
    if (j.t0 === t) return j;
  }

  const all = track.stretches;

  if (all.length === 0) return null;

  let lo = 0, hi = all.length - 1;

  while (lo < hi) {
    const mid = (lo + hi) >> 1;

    // Half-open: a stretch holds its start and not its end, so the instant two
    // of them share belongs to the later one. The cover is exact — see
    // `abutting` — so every instant has an owner and none has two.
    if (all[mid].t1 <= t) {
      lo = mid + 1;
    }
    else {
      hi = mid;
    }
  }

  // The last one keeps its end, since nothing follows it to take `t` on.
  return all[lo];
}

/** How an artefact's own layer at the later version is read over a leg. */
type Own = 'ease' | 'whole' | 'none';

/**
 * The set part way through a walk from one version to another, which is what
 * the editor draws while the versions change under it.
 *
 * `u` runs from 0 to 1 over the whole walk however many versions it crosses, so
 * a jump from v0 to v4 plays the four spans one after another. Going backwards
 * plays them backwards, which is the same stretches read the other way.
 *
 * Null when the span it lands in is not baked, or was baked against a world
 * that has since moved. There is deliberately nothing to fall back on: the
 * point of watching this is to see what the bake says, and quietly resolving
 * the version instead would show something the game will never get.
 */
/**
 * Every artefact part way through a walk, in the frame the versions put it in.
 *
 * Here rather than beside `artefactsAt` because it is `replayed`'s question,
 * and it has to be answered `replayed`'s way: one leg per version crossed, so
 * the walk is over versions rather than over distance and a key does not
 * arrive in a room ahead of the room.
 *
 * The layer is eased, not the place. A leg differs from its neighbour by
 * exactly one version's worth of transforms — its own and every group holding
 * it — so easing those on is what a turning group does to everything else it
 * holds, and interpolating the two ends instead would carry a turning artefact
 * across the chord while the room it is in went round the arc.
 *
 * One that is not there yet, and one on its way out, both still ride. There is
 * nowhere for either to come from or go to, but the groups holding them are
 * moving over this leg like any others, and a key put into a turning room
 * belongs to the room from the start of the turn. This is `carried`'s rule, and
 * it is here as well because the two have to agree across the crossing between
 * the still and the morph.
 */
export function artefactsDuring(
  world: World,
  from: VersionId,
  to: VersionId,
  u: number,
): Placed[] {
  const n = Math.abs(to - from);

  if (n === 0) return artefactsAt(world, to);

  const x = Math.min(Math.max(u, 0), 1) * n;
  const i = Math.min(Math.floor(x), n - 1);
  const step = to > from ? 1 : -1;
  const rest = x - i;

  const a = from + step * i, b = a + step;

  // The later of the two, whose layer is the one being eased on or off. Going
  // forward it arrives over the leg; going back it leaves over it, which is
  // the same easing read from the other end.
  const late = Math.max(a, b);
  const t = step > 0 ? rest : 1 - rest;

  const out: Placed[] = [];

  for (const [id, it] of world.artefacts) {
    const there = placeAt(world, id, a), then = placeAt(world, id, b);

    if (there === null && then === null) continue;

    // Which ends of the leg it is standing at, which is the whole of what
    // decides how its own layer is read. The leg's own two versions rather
    // than its direction: going backwards is the same span read the other way,
    // and a thing arriving is a thing leaving seen from there.
    const here = placeAt(world, id, Math.min(a, b)) !== null;
    const own: Own = there !== null && then !== null ? 'ease' : here ? 'none' : 'whole';
    const m = easedFrame(world, id, late, t, own);

    out.push({ id, type: it.type, at: place(m, [it.at])[0], facing: facing(m) });
  }

  return out.sort((p, q) => p.id - q.id);
}

/**
 * `groupFrame`, with one version's layers part way on.
 *
 * The groups always ease. What the artefact's *own* layer at `late` does is
 * `own`, and there are three answers rather than two. It eases where the
 * artefact is standing at both ends of the leg, which is the ordinary case. It
 * is applied `whole` for one the leg introduces: there was no earlier place for
 * that transform to be a move away from. And it is skipped entirely for one the
 * leg takes out, because a layer written at a version that does not have the
 * artefact was written before the delete and means nothing — the same reading
 * `resolveAt` gives a dead polygon's.
 */
function easedFrame(
  world: World,
  id: ArtefactId,
  late: VersionId,
  t: number,
  own: Own,
): Affine {
  const up = enclosing(world, id);
  let m = IDENTITY;

  for (const k of chain(world, late)) {
    const edits = world.versions[k].edits;
    const lay = (of: Id, how: Own): Transform => {
      const layer = edits.get(of)?.transform ?? EMPTY_TRANSFORM;

      if (k !== late) return layer;

      return how === 'ease' ? easing(layer, t) : how === 'whole' ? layer : EMPTY_TRANSFORM;
    };

    m = compose(affine(lay(id, own)), m);

    for (const g of up) m = compose(affine(lay(g, 'ease')), m);
  }

  return m;
}

export function replayed(
  bake: Bake,
  world: World,
  from: VersionId,
  to: VersionId,
  u: number,
): Frame | null {
  const n = Math.abs(to - from);
  if (n === 0) return null;

  const x = Math.min(Math.max(u, 0), 1) * n;
  const i = Math.min(Math.floor(x), n - 1);
  const rest = x - i;

  const forward = to > from;
  const span = spanAt(bake, world, forward ? from + i : from - 1 - i);

  return span === null ? null : sample(span, forward ? rest : 1 - rest);
}
