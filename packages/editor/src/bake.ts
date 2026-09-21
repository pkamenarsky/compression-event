// -----------------------------------------------------------------------------
// The bake
//
// The game does not resolve keyframes. It gets buffers, and between two of
// them it lerps. So the bake's job is to cut the span between two keyframes
// into *stretches* — runs of `t` across which the arrangement's combinatorics
// hold — and to evaluate the geometry at both ends of each one. Within a
// stretch the shader reproduces the world exactly by interpolating; between two
// stretches there is a discontinuity, which is what a topology event *is*.
//
// What is interpolated
// --------------------
// Not positions: operations. Each thing's own frame starts where the near
// keyframe left it, and the far keyframe's operations play over it one after
// another, each `t` of the way and each from the frame the one before it left;
// every group holding it does the same over that:
//
//   frame(t)  = … o play(G, t) o play(F_k, ops_{k+1}, t)   (each link a frame)
//   local(t)  = lerp(local_k, local_{k+1}, t)               (corner nudges)
//   depth(t)  = lerp(d_k, d_{k+1}, t)
//   shape(t)  = erode(frame(t)(local(t)), depth(t))
//
// which is exactly `resolveAt(k)` at t = 0 and `resolveAt(k + 1)` at t = 1. A
// turn goes round its own anchor, so a room spun in place keeps its size and a
// turned selection swings about its centre; a turn of 720° goes round twice;
// and a spin with a drag in the same keyframe spins while it slides. See
// `played` in `rig.ts` for how each kind goes part way, and `Flight` for why
// it is the operations and not one motion fitted to the two ends.
//
// Each link is a frame played on its own terms, and the links multiply at
// every instant. Nothing interpolates a composed matrix, so nothing has to
// mind that one can be sheared.
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
// the only asymmetry is that a dying polygon plays nothing of its own, since a
// keyframe that does not have a polygon cannot be saying anything about it.
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
// - **Known outright, from the keyframes.** Both ends of the span, always: a
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
//
// Which is not the same as baking from nothing
// --------------------------------------------
// Nothing is carried from one *instant* to the next, for the reason above. A
// *bake* is the other case, and it is the one a diff was always right about: an
// edit reaches a few polygons, and every track cut from geometry it did not
// reach would come out exactly as it did last time. So a track carries a hash
// of what it was cut from and a bake keeps the ones whose hash still stands.
// See `signed`.
//
// The two are not in tension, they are about different spans of time. Within a
// span everything is moving and there is nothing to skip; between one bake and
// the next almost nothing has moved and there is almost nothing to do.
// -----------------------------------------------------------------------------

import type { BakedLevel } from '@ce/game';
import { REPLAY_MS } from '@ce/game/replay';
import { Point, TOLERANCE } from '@ce/game/world';
import { AABB, Tree, build, merge, ofRings, overlaps, search } from './aabb';
import {
  Member,
  Ring,
  Shape,
  alongOf,
  boundaryRuns,
  betweenOf,
  erodedRingCorners,
  ground,
  Facets,
  Fade,
  SEEDING,
  facetFades,
  facetsOf,
  keeping,
  mitred,
  nextOf,
  prevOf,
  simplify,
  sliced,
} from './geometry';
import {
  Affine,
  Contributed,
  EMPTY_LIVE,
  Effected,
  IDENTITY,
  Placed,
  Resolved,
  artefactsAt,
  centroid,
  chain,
  compose,
  contributed,
  depths,
  effectedOf,
  facing,
  groupFrame,
  imagesOf,
  keyAt,
  order,
  outermostSlot,
  parts,
  placeAt,
  sidedWith,
  sideOf,
  live,
  place,
  resolved,
  standingIn,
  under,
  unplace,
  resolveAt,
  optionOf,
  segmentsOf,
} from './scene';
import {
  ArtefactId,
  GroupId,
  Id,
  KINDS,
  PolygonId,
  PolygonKind,
  SLOTS,
  SLOT_KINDS,
  SetName,
  KeyframeId,
  Vertex,
  VertexId,
  World,
  enclosing,
  inverted,
  inside,
  kindKey,
  kindOf,
  within,
  ringsOf,
  slotOf,
} from './types';
import { CORNER_MAPS, Frame as Pose, Playing, REST, State, affineOf, flying, playingAt, playingOn, stateAt } from './rig';
import { WorldSet, pieces } from './worldset';

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
   * A share of the floor's outline rather than of the level's: something to
   * fill rather than a wall to stand up. See `Track.fill`.
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
 * A thing's own frame across a span: where it stands at the near end, in the
 * frame of whatever holds it, and what the far keyframe plays over it, in
 * order.
 *
 * What the keyframe does, and not one motion that joins the two ends. A turned
 * selection swings about the centre it was turned about, a turn of 720° goes
 * round twice, and a spin with a drag in the same keyframe spins while it
 * slides — each of which a single motion fitted to the ends gets wrong, and
 * the first of which it gets wrong only when the keyframe holds anything else.
 * See `playingOn` in `rig.ts` for how each one goes part way.
 *
 * The keys the keyframe plays, each stepped for its repeat: what the shipped
 * table holds, one for one. See `OP_STRIDE` in `baked.ts`.
 *
 * Only what moves the frame. An erosion, a round or a deform is an amount,
 * which is lerped.
 */
export interface Flight {
  frame: Pose
  ops: readonly Playing[]
}

/**
 * A group holding a polygon over the span, and what it is in flight with.
 *
 * Named, because the shader shares one of these between everything the group
 * holds rather than carrying a copy per polygon: what a vertex rides is a
 * chain, and the chain is the structure.
 */
export interface Holder extends Flight {
  id: Id
}

/**
 * What takes a polygon's runs back out to the world: its own flight, and every
 * group's over that, innermost first.
 *
 * A chain rather than one composed matrix, because each link is a frame played
 * forward on its own terms, and a composition has no operations of its own to
 * play. The links multiply at each instant, which is the same thing
 * `worldFrame` does at a keyframe.
 */
export interface Rider extends Flight {
  holders: Holder[]
}

/** A flight `t` of the way through: everything the keyframe does that far, one
 * after another, each from the frame the one before it left. Its own frame
 * exactly at nought, and exactly the far keyframe's at one. */
export function flown(f: Flight, t: number): Pose {
  if (t === 0) return f.frame;

  let out = f.frame;

  for (const p of f.ops) out = playingOn(out, p, t);

  return out;
}

/** Where a polygon's own frame stands at an instant of the span, in world
 * units: its flight, and every group's over it. Composed innermost first, the
 * way `worldFrame` composes, so that the two ends are the keyframes' own
 * frames to the last bit. */
export function riding(r: Rider, t: number): Affine {
  let frame = affineOf(flown(r, t));

  for (const h of r.holders) frame = compose(affineOf(flown(h, t)), frame);

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
   * Which set the track's boundary belongs to, and nothing more than that.
   * A floor is its own set — floors added, floor holes taken back out — cut by
   * the same `boundaryRuns` against the same kind of neighbourhood, so its runs
   * are open arcs partitioned by source exactly as the level's are. Everything
   * about a track is the same, which is the point: it rides the same frame, it
   * is cut by the same measure, and it interpolates by the same lerp.
   *
   * What differs is downstream. A wall stands up on a run and needs only the
   * run; a fill needs the ring, and a ring of the floor set generally belongs
   * to several polygons — so whatever draws it stitches the fill runs back into
   * rings at the instant it draws them. See `stitch` in the game's `walls.ts`.
   *
   * It used to mean more: a floor was in no set at all, and its runs were its
   * own closed rings. That is why the flag is on the run as well as the track.
   */
  fill: boolean
  /**
   * A hole cut in the floors rather than floor: the other slot of the floor
   * set, and the whole of what the reader needs to tell the two apart.
   *
   * A floor is never cut against its set — see `fillTrack` — so what arrives is
   * every floor's own ring and every hole's own ring, and which is which is not
   * a thing the rings themselves say. It is not the winding: `fillRuns` turns
   * every ring to face the way its slot means, so a hole comes out wound
   * against the floors and would cancel one of them where they overlap, which
   * is a count and not a set. Whatever draws these counts the two apart. See
   * `stencilled` in the game's `walls.ts`.
   *
   * False on everything else, a wall having no such question.
   */
  hole: boolean
  stretches: Stretch[]
  /** By `t`, ascending. Never an interval — see above. */
  jumps: Stretch[]
  /**
   * The furthest this track's replay was measured from `csg(t)`, and the widths
   * the attempt that managed it was cut at. `Span.worst` and `Span.strained`
   * are these, read over the tracks.
   *
   * On the track rather than only added up over the span because a track
   * outlives the bake that cut it: a span that keeps the tracks an edit did not
   * reach has to say what its error is, and a maximum taken over the handful it
   * re-cut would be a smaller number than the truth. See `joined`.
   */
  worst: number
  gap: number
  /**
   * Everything this track was cut from, as a hash: see `signed`.
   *
   * What makes a track reusable. A bake after an edit works out the same hash
   * from the world in front of it, and a track whose hash comes back the same
   * is cut from the same geometry against the same neighbours and would come
   * out identical, so it is kept rather than cut again.
   */
  sig: string
}

/** Everything between two adjacent keyframes. */
export interface Span {
  /** Where the earlier of the two is in the order. */
  from: number
  /** One per polygon, ordered by id — which is also the order `sample` puts
   * their runs back in. */
  tracks: Track[]
  /** Per polygon, what its runs ride. Constant across the span: how far its
   * operations have played is a function of `t` alone. */
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
   *
   * It is now a number the bake acts on rather than only reports: a track
   * outside the tolerance is re-cut finer until it is inside, so anything left
   * above `TOLERANCE` here is named in `strained` as well. See `chased`.
   */
  worst: number
  /**
   * The tracks that would not come inside the tolerance however finely they
   * were cut, by id. Empty on a level that behaves, and absent on a span baked
   * before the bake chased its own error.
   */
  strained?: Strain[]
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
 * A span's geometry depends on everything written at its own two keyframes and
 * at every keyframe before them, since that is what the walk plays. So the
 * stamp is every entry written up to the later of the two, plus the order of
 * the keyframes, the polygons, the group structure and the artefacts
 * themselves.
 *
 * The entries by identity, one by one, rather than the map of timelines: an
 * edit at v5 replaces that map and leaves every entry written before v5 the
 * same object, so the spans before it stand.
 *
 * The artefacts because they have slots in the frame table — `carried` puts
 * them there, and which of them exist decides both how many slots there are and
 * what `bakedSpan` indexes them by. A span baked before a key was dropped has
 * no row for it, and the game falls back to a straight line between the two
 * places rather than the frame it should be riding.
 *
 * Opening and closing a ghost's eye — which replaces the keyframe but changes
 * no geometry — does not throw away a bake: only the order of their ids is
 * read.
 */
export interface Stamp {
  written: unknown[]
  order: string
  polygons: unknown
  groups: unknown
  artefacts: unknown
  /** Which effects things have, and how: one fact over every keyframe, so
   * every span hears of a change to it. */
  effects: unknown
  cornerEffects: unknown
}

export interface Bake {
  /** Keyed by where the earlier of the two keyframes is in the order. */
  spans: Map<number, Span>
  /** 0 to 1 while a bake is running, and null when none is. */
  progress: number | null
  /**
   * The bake a level file came with, as the game gets it.
   *
   * Only the flat buffers are in a file, and a `Span` cannot be put back
   * together out of them, so this cannot stand in for `spans` wherever the
   * editor reads the bake itself — the replay, the 3D panel. What it can stand
   * in for is what is shipped: playing the level, and writing it out again,
   * without having to bake what was baked already. See `loadedFor`.
   *
   * Stamped like a span, against the whole chain, so the first edit that would
   * have invalidated any span of it invalidates it.
   */
  loaded?: Loaded | null
}

export interface Loaded {
  level: BakedLevel
  stamp: Stamp
}

export const EMPTY_BAKE: Bake = { spans: new Map(), progress: null };

export function stamp(world: World, from: number): Stamp {
  const upto = new Set(world.keyframes.slice(0, from + 2).map(k => k.id));
  const written: unknown[] = [];

  for (const [id, rig] of world.rigs) {
    const mine: unknown[] = [];

    for (const [k, list] of rig.keys) {
      if (upto.has(k)) mine.push(k, list);
    }

    if (mine.length > 0) written.push(id, ...mine);
  }

  return {
    written,
    order: ordered(world),
    polygons: world.polygons,
    groups: world.groups,
    artefacts: world.artefacts,
    effects: world.effects,
    cornerEffects: world.cornerEffects,
  };
}

function ordered(world: World): string {
  return world.keyframes.map(k => k.id).join(',');
}

/** The span, if what it was baked against is still standing. */
export function spanAt(bake: Bake, world: World, from: number): Span | null {
  const span = bake.spans.get(from);
  if (span === undefined) return null;

  return stamped(span.stamp, stamp(world, from)) ? span : null;
}

/**
 * The span as it was last baked, whether or not it still stands, for a bake to
 * take the tracks an edit did not reach from.
 *
 * A different question from `spanAt`, which asks whether a span may be *used* —
 * and must go on asking it, since a stale span is stale whatever its tracks
 * are. This asks only whether the two spans are about the same pair of
 * keyframes, because a track carries its own answer to everything else. Where
 * the order has changed, `from` no longer names the same span at all and there
 * is nothing here to take.
 */
export function reusable(bake: Bake, world: World, from: number): Span | null {
  const span = bake.spans.get(from);

  if (span === undefined) return null;

  return span.stamp.order === ordered(world) ? span : null;
}

/** A stamp over every span of the level, which is everything written down to
 * the last keyframe. */
export function stampAll(world: World): Stamp {
  return stamp(world, Math.max(world.keyframes.length - 2, 0));
}

function stamped(a: Stamp, b: Stamp): boolean {
  if (a.polygons !== b.polygons) return false;
  if (a.groups !== b.groups) return false;
  if (a.artefacts !== b.artefacts) return false;
  if (a.effects !== b.effects || a.cornerEffects !== b.cornerEffects) return false;
  if (a.order !== b.order) return false;
  if (a.written.length !== b.written.length) return false;

  return a.written.every((e, i) => e === b.written[i]);
}

/** The bake a file came with, if the world it came with is still the one
 * standing. */
export function loadedFor(bake: Bake, world: World): BakedLevel | null {
  const loaded = bake.loaded;
  if (loaded === undefined || loaded === null) return null;

  return stamped(loaded.stamp, stampAll(world)) ? loaded.level : null;
}

/** Every span the edit reached, dropped. Cheaper to ask than to work out, and
 * `spanAt` is the one that has to be right. */
export function pruned(bake: Bake, world: World): Bake {
  const spans = new Map<number, Span>();

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
 * One polygon across one span: its flight, the groups it rides, and its two
 * endpoints.
 *
 * A polygon born into `k + 1` has no near end of its own, and one taken out at
 * `k + 1` has no far end; either way the end it lacks is the same ring pinched
 * into its own middle. See `budding`. From there it is a polygon like any
 * other — it rides its groups, it cuts stretches where it passes through its
 * neighbours, and nothing downstream has to know it is arriving or leaving.
 */
interface Moving extends Rider {
  at: Resolved
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
  /**
   * Its rounds and deforms at the two ends, over `corners`, or nothing where
   * it has no effects. The options are the same at both ends; the amounts are
   * lerped. See `effectsOver`.
   */
  effected: [Effected, Effected] | null
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

  const corners = merged(was.corners, now.corners, was.polygon.points);

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
  const straight = [straightOf(was), straightOf(now)] as const;
  const local: [Ring, Ring] = [
    corners.map(c => here.get(c.id) ?? ORIGIN),
    corners.map(c => there.get(c.id) ?? ORIGIN),
  ];

  // The nearest corner in that direction that `has` holds. Round the corner's
  // own ring, not round the list: a hole's neighbours are in the hole. It
  // terminates because no ring at either end is ever left with fewer than three
  // corners.
  const rings = ringsOf(corners);

  const nearest = (i: number, step: number, has: Map<VertexId, Point>): number => {
    let k = i;

    do {
      k = alongOf(rings, n, k, step);
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
      const taste = sameBefore && sameAfter
        ? fraction(other.get(corners[before].id)!, other.get(corners[after].id)!, other.get(c.id)!)
        : betweenOf(rings, n, before, i) / betweenOf(rings, n, before, after);

      // On the edge as it is drawn there: between the two corners' arcs, and
      // not on a stretch one of them has rounded away, where it would clamp
      // that arc short of the one the editor draws.
      const [lo, hi] = straight[side](corners[before].id, corners[after].id, from, to);
      const at = lo + (hi - lo) * taste;

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

/**
 * Every corner either end of a span has, in ring order: what `spanning` writes
 * both ends over.
 *
 * The polygon's own corners are in its list of points, dead ones in place, and
 * that is their order. A tooth a deform made is not — see `Vertex.root` — so
 * the two ends' own orders are what is merged: what both have keeps the order
 * both give it, and between two such, what one end has alone goes in by where
 * its own corner, or the one its edge starts at, is in the polygon's list,
 * the near end's first. Without teeth that is the polygon's list, filtered.
 */
function merged(a: readonly Vertex[], b: readonly Vertex[], points: readonly Vertex[]): Vertex[] {
  const place = new Map(points.map((c, i) => [c.id, i]));
  const rank = (c: Vertex): number => place.get(c.root ?? c.id) ?? Infinity;
  const inB = new Set(b.map(c => c.id)), inA = new Set(a.map(c => c.id));
  const out: Vertex[] = [];

  let i = 0, j = 0;

  while (i < a.length || j < b.length) {
    const x = a[i], y = b[j];

    // Both at a corner the other has too: the same corner, since the two
    // orders agree on what they share.
    if (x !== undefined && y !== undefined && inB.has(x.id) && inA.has(y.id)) {
      out.push(x);
      i++;
      j++;
      continue;
    }

    const takeA = x !== undefined && !inB.has(x.id)
      && (y === undefined || inA.has(y.id) || rank(x) <= rank(y));

    if (takeA) {
      out.push(x);
      i++;
    }
    else {
      out.push(y!);
      j++;
    }
  }

  return out;
}

/**
 * Where along an edge of the polygon as drawn the straight part is, as
 * fractions of the source edge from one corner to the next: between the end
 * of the first corner's arc and the start of the second's. The whole of it
 * for a polygon that is not rounded.
 *
 * An eroded edge is parallel to its source edge, so a point on it is read off
 * the source line by where its foot falls.
 */
function straightOf(it: Resolved): (a: VertexId, b: VertexId, from: Point, to: Point) => [number, number] {
  const im = it.effected ? imagesOf(it) : null;

  if (im === null) return () => [0, 1];

  const index = new Map(it.corners.map((c, i) => [c.id, i]));

  return (a, b, from, to) => {
    const first = im.corners[index.get(a)!], second = im.corners[index.get(b)!];

    if (first === null || second === null) return [0, 1];

    const lo = fraction(from, to, unplace(it.frame, first[first.length - 1]));
    const hi = fraction(from, to, unplace(it.frame, second[0]));

    return lo < hi ? [lo, hi] : [0, 1];
  };
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
  const rings = ringsOf(corners);

  for (let i = 0; i < corners.length; i++) {
    if (dead[0][i] || dead[1][i]) continue;

    const was = flat(local[0], rings, depths[0], i, snap[0]);
    const now = flat(local[1], rings, depths[1], i, snap[1]);

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
function flat(
  ring: Ring,
  rings: readonly number[],
  depths: readonly number[],
  i: number,
  snap: number,
): boolean {
  const n = ring.length;
  const before = prevOf(rings, n, i), after = nextOf(rings, n, i);
  const a = ring[before], b = ring[i], c = ring[after];
  const ux = b.x - a.x, uy = b.y - a.y;
  const vx = c.x - b.x, vy = c.y - b.y;
  const reach = Math.max(Math.hypot(ux, uy), Math.hypot(vx, vy));

  if (reach === 0) return true;
  if (Math.abs(ux * vy - uy * vx) / reach > snap) return false;

  // Where the depth sits, against where running from `a` to `c` would put it.
  const l = Math.hypot(ux, uy) + Math.hypot(vx, vy);
  const da = depths[before], db = depths[i], dc = depths[after];
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
 * What a thing does across a span: from where it stands at the near keyframe,
 * what the far one plays over it.
 *
 * At one end only, it stands still at that end. A polygon born at the far
 * keyframe is where that keyframe puts it, outright — a keyframe that both
 * makes a thing and moves it is describing where the thing *is*, and there is
 * no earlier place for that to be a move away from — and one taken out there
 * stands where the near keyframe left it: whatever the far one still says
 * about it was written before it went, and plays nowhere. See `budding` for
 * what is in flight instead.
 */
function flightOf(world: World, from: number, id: Id, here: boolean, there: boolean): Flight {
  const near = keyAt(world, from)!, far = keyAt(world, from + 1)!;

  if (here && there) {
    return { frame: stateAt(world, id, near).frame, ops: playingAt(world, id, far).filter(flying) };
  }

  return { frame: stateAt(world, id, here ? near : far).frame, ops: [] };
}

/**
 * Every group holding something, and what each is in flight with.
 *
 * A group is global and its timeline runs from the first keyframe, so it
 * always has a near end. What can still be asked is whether anything of it is
 * there at the far end: one whose rooms all go at `from + 1` plays nothing, so
 * that what it held stands still while it goes, as a dead polygon does.
 */
function holders(world: World, from: number, id: Id): Holder[] {
  const there = new Set(chain(world, keyAt(world, from + 1)!));

  return enclosing(world, id).map(g => ({
    id: g,
    ...flightOf(world, from, g, true, standingIn(world, g, there)),
  }));
}

function moving(world: World, from: number): Moving[] {
  const near = keyAt(world, from)!, far = keyAt(world, from + 1)!;
  const before = new Map(resolveAt(world, near).map(it => [it.id, it]));
  const after = resolveAt(world, far);

  const out = after.map(it => {
    const was = before.get(it.id);

    if (was === undefined) {
      // Where it is at the far end, and the birth all in the ring: what is in
      // flight over its frame is whatever holds it.
      return {
        at: it,
        ...flightOf(world, from, it.id, false, true),
        corners: it.corners,
        local: [budding(it.local), it.local] as [Ring, Ring],
        dead: [it.corners.map(() => false), it.corners.map(() => false)] as [boolean[], boolean[]],

        // From nothing, so that the depth stays in proportion to the shape it
        // is taken off. A full depth against a thousandth of a polygon is not a
        // thin room; it is an inside-out one.
        depth: [0, it.erosion] as [number, number],
        depths: [it.corners.map(() => 0), flatDepths(it)] as [number[], number[]],
        varying: it.depths !== null,
        holders: holders(world, from, it.id),
        ...effectsOver(world, it.id, it.corners, [null, stateAt(world, it.id, far)]),
      };
    }

    const over = spanning(was, it);

    return {
      at: it,
      ...flightOf(world, from, it.id, true, true),
      corners: over.corners,
      local: over.local,
      dead: over.dead,
      depth: [was.erosion, it.erosion] as [number, number],
      depths: over.depths,
      varying: was.depths !== null || it.depths !== null,
      holders: holders(world, from, it.id),
      ...effectsOver(world, it.id, over.corners, [stateAt(world, it.id, near), stateAt(world, it.id, far)]),
    };
  });

  // And the ones going the other way. A polygon the later keyframe takes out is
  // in `before` and nowhere in `after`, so it is picked up here rather than in
  // the walk above, and given the far end it does not have: the same ring
  // pinched into its own middle, which is `budding` read backwards. Its own
  // frame stands still while it goes, and what holds it goes on moving: a room
  // going out of a turning group turns on its way out.
  const kept = new Set(after.map(it => it.id));

  for (const [id, was] of before) {
    if (kept.has(id)) continue;

    out.push({
      at: was,
      ...flightOf(world, from, id, true, false),
      corners: was.corners,
      local: [was.local, budding(was.local)] as [Ring, Ring],
      dead: [was.corners.map(() => false), was.corners.map(() => false)] as [boolean[], boolean[]],
      depth: [was.erosion, 0] as [number, number],
      depths: [flatDepths(was), was.corners.map(() => 0)] as [number[], number[]],
      varying: was.depths !== null,
      holders: holders(world, from, id),
      ...effectsOver(world, id, was.corners, [stateAt(world, id, near), null]),
    });
  }

  return out;
}

/** A thing's amounts where it is not there: none. */
const NOTHING: Pick<State, 'bevel' | 'bevels'> = {
  bevel: 0,
  bevels: new Map(),
};

/**
 * A polygon's round at both ends of a span, written over the same corners.
 * Nothing where it has none. Its deform is not here: that is in its corners
 * already, teeth and all, and the bake carries them as it carries any.
 *
 * A degenerate end is seeded, never collapsed. A bevel of nought at one end
 * and more at the other is `SEEDING` of the other there, so the arc turns,
 * however little, and the arrangement keeps its points unasked: the ring is
 * the same length at both ends. So is the polygon's own bevel, which what
 * the erosion made takes and no slot answers for.
 *
 * Nor does a corner's count of points change across a span, though its
 * segments do: each end's are what its bevel asks for, the still's at that
 * keyframe, and the span lays every corner in as many points as the finer
 * end has. At the coarser end the points it has over are on its facets, so
 * its outline is the still's; across the span the arc goes over from the one
 * to the other. See `Facets`.
 */
function effectsOver(
  world: World,
  id: Id,
  corners: readonly Vertex[],
  ends: [State | null, State | null],
): Pick<Moving, 'effected'> {
  const none = { effected: null };
  const two = ends.map(e => effectedOf(world, id, corners, e ?? NOTHING)) as [Effected | null, Effected | null];

  if (two[0] === null && two[1] === null) return none;

  // Where it has no effects at one end, it has them at nought there: the
  // options are a fact about the thing, and the same at both.
  const bare = (e: Effected | null, other: Effected): Effected => e ?? {
    facets: other.facets.map(f => (f.n > 0 ? facetsOf(1, f.tension) : f)),
    bevels: other.bevels.map(() => 0),
    own: other.own.n > 0 ? facetsOf(1, other.own.tension) : other.own,
    bevel: 0,
    flat: other.flat,
  };
  const a = bare(two[0], two[1]!), b = bare(two[1], two[0]!);

  // One count for the span, laid as each end's own at that end.
  const spanned = (f: Facets, g: Facets, at: number): Facets => ({ n: Math.max(f.n, g.n), from: f.n, to: g.n, at, tension: f.tension });
  const ended = (e: Effected, at: number): Effected => ({
    ...e,
    facets: a.facets.map((f, i) => spanned(f, b.facets[i], at)),
    own: spanned(a.own, b.own, at),
  });

  const seed = (x: number, y: number): number => (x <= 0 && y > 0 ? y * SEEDING : x);
  const seeded = (e: Effected, o: Effected): Effected => ({
    ...e,
    bevels: e.bevels.map((r, i) => (e.facets[i].n > 0 ? seed(r, o.bevels[i]) : r)),
    bevel: seed(e.bevel, o.bevel),
  });

  return {
    effected: [ended(seeded(a, b), 0), ended(seeded(b, a), 1)],
  };
}

/** A polygon's effects `t` of the way across a span. */
function effectedAt(e: [Effected, Effected], t: number): Effected {
  if (t === 0) return e[0];
  if (t === 1) return e[1];

  return {
    facets: e[0].facets.map((f, i) => ({ ...f, at: weighed(e[0].bevels[i], e[1].bevels[i], t) })),
    bevels: e[0].bevels.map((r, i) => mix(r, e[1].bevels[i], t)),
    own: { ...e[0].own, at: weighed(e[0].bevel, e[1].bevel, t) },
    bevel: mix(e[0].bevel, e[1].bevel, t),
    flat: e[0].flat,
  };
}

/**
 * How far an arc has gone over from its near layout to its far one, `t` of
 * the way across a span whose bevel goes from `a` to `b`: by the bevel, not
 * by the time. Each layout's points are the bevel times something of the
 * corner alone, so blended by `t · b / bevel(t)` a point is the lerp of its
 * two ends exactly, as it is where the layout does not change — and the
 * bake's lerp is exact again. By the time, it would be a product of two
 * lerps, and every stretch a curve to be cut up.
 */
function weighed(a: number, b: number, t: number): number {
  const bevel = mix(a, b, t);

  return bevel > 0 ? t * b / bevel : t;
}

/** A depth per corner for a polygon standing still: whatever it is under. */
function flatDepths(it: Resolved): number[] {
  return it.depths !== null ? [...it.depths] : it.corners.map(() => it.erosion);
}

function mix(u: number, v: number, t: number): number {
  return u + (v - u) * t;
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
 *
 * And the points of an arc laid on its facets at this end — see
 * `effectsOver` — which are as flat here as an invented corner, and for the
 * same while.
 */
function invented(
  m: Moving,
  at: Omit<Resolved, 'shape' | 'rings'>,
  t: number,
): Point[] {
  const end = t === 0 ? 0 : t === 1 ? 1 : null;
  if (end === null) return [];

  const rings = ringsOf(m.corners);

  if (m.effected !== null) {
    return [
      ...slots(m, { ...at, rings }).flatMap(s => (s.dead[end] ? s.points : [])),
      ...facetsFading({ ...at, rings }).filter(f => f.v === 0).map(f => f.p),
    ];
  }

  const dead = m.dead[end];
  const out: Point[] = [];
  const erosion = at.depths ?? at.erosion;

  for (let i = 0; i < at.source.length; i++) {
    if (dead[i] !== true) continue;

    const p = mitred(at.source, rings, i, typeof erosion === 'number' ? erosion : erosion[i]);

    if (p !== null) out.push(p);
  }

  return out;
}

/**
 * A polygon with effects, slot by slot: each corner's arc and each edge's
 * deform points where the projection has them at `t`, and whether the slot is
 * flat at either end.
 *
 * A flat corner's arc is a short run along its wall, never one point — see
 * `shaped` — so at an end where a slot is flat its points lie on an edge of
 * the projection, `keeping` takes every one of them, and the ring is as long
 * at the end as it is in between.
 */
function slots(m: Moving, at: Omit<Resolved, 'shape'>): { points: Point[], dead: [boolean, boolean] }[] {
  const im = imagesOf(at);

  if (im === null) return [];

  const out: { points: Point[], dead: [boolean, boolean] }[] = [];

  m.corners.forEach((_c, i) => {
    const run = im.corners[i];
    const dead: [boolean, boolean] = [m.dead[0][i], m.dead[1][i]];

    if (run !== null && (dead[0] || dead[1])) out.push({ points: run, dead });
  });

  return out;
}

/** A polygon `t` of the way across the span, without the corners it keeps. */
function at1(m: Moving, t: number): Omit<Resolved, 'shape' | 'rings'> {
  const local = between(m.local[0], m.local[1], t);
  const frame = riding(m, t);

  // Named rather than spread: spreading `m.at` would read its projection,
  // which is the one thing worth not doing here.
  return {
    id: m.at.id,
    polygon: m.at.polygon,
    corners: m.corners,
    local,
    frame,
    source: place(frame, local),
    erosion: mix(m.depth[0], m.depth[1], t),
    depths: m.varying ? m.depths[0].map((d, i) => mix(d, m.depths[1][i], t)) : null,
    effected: m.effected === null ? null : effectedAt(m.effected, t),
  };
}

/** The world at one instant inside the span, resolved. */
function world1(items: Moving[], t: number): Resolved[] {
  return items.map(m => {
    const at = at1(m, t);

    return resolved({ ...at, keep: invented(m, at, t) });
  });
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
  return paintedOn(it.shape, fadingPoints(m, it, t));
}

/**
 * The points of a polygon's projection that are not wholly solid at `t`,
 * each with how solid it is: `fading`'s answer before it is put onto a
 * shape, so that a scope holding the polygon can put it onto its own. See
 * `groupFading`.
 */
function fadingPoints(m: Moving, it: Resolved, t: number): Fade[] {
  return m.effected === null ? fadingCorners(m, it, t) : [...fadingSlots(m, it, t), ...facetsFading(it)];
}

/** Where its arcs' points are on their facets at one end of the span or the
 * other, and fading. See `facetFades`. */
function facetsFading(it: Omit<Resolved, 'shape'>): Fade[] {
  const e = it.effected ?? null;

  if (e === null) return [];

  const faded = (f: Facets) => f.n > 0 && (f.from !== f.to || f.from < f.n);

  if (!e.facets.some(faded) && !faded(e.own)) return [];

  const im = imagesOf(it);

  if (im === null) return [];

  return [
    ...im.corners.flatMap((run, i) => (run === null ? [] : facetFades(run, e.facets[i]))),
    ...im.rest.flatMap(run => facetFades(run, e.own)),
  ];
}

/** `fadingPoints` for a polygon with no round: its corners dead at an end. */
function fadingCorners(m: Moving, it: Resolved, t: number): Fade[] {
  const out: { p: Point, v: number }[] = [];

  for (let i = 0; i < m.corners.length; i++) {
    if (!m.dead[0][i] && !m.dead[1][i]) continue;

    const image = mitred(it.source, it.rings, i, it.depths === null ? it.erosion : it.depths[i]);

    // Swallowed: an offset deep enough to eat the edge the corner sat on leaves
    // it nowhere to be, and a point that is not drawn needs no opacity.
    if (image !== null) out.push({ p: image, v: mix(m.dead[0][i] ? 0 : 1, m.dead[1][i] ? 0 : 1, t) });
  }

  return out;
}

/** Points with how solid each is, put onto a shape: every point of it one of
 * them lands on, and the rest wholly solid. Nothing where none lands. */
function paintedOn(shape: Shape, points: readonly { p: Point, v: number }[]): number[][] | null {
  if (points.length === 0) return null;

  const snap = near(new Map([[0, shape]]));
  const out = shape.map(ring => ring.map(() => 1));
  let any = false;

  for (const { p, v } of points) {
    const at = corner(shape, p, snap);

    if (at === null) continue;

    out[at.ring][at.index] = Math.min(out[at.ring][at.index], v);
    any = true;
  }

  return any ? out : null;
}

/** `fadingPoints` for a polygon with a round, slot by slot: every point of a
 * slot flat at one end fades over the span. */
function fadingSlots(m: Moving, it: Resolved, t: number): Fade[] {
  return slots(m, it).flatMap(slot => {
    const v = mix(slot.dead[0] ? 0 : 1, slot.dead[1] ? 0 : 1, t);

    return slot.points.map(p => ({ p, v }));
  });
}

/**
 * How solid each point of a scope's side is at `t`: its polygons' fading,
 * carried onto it. A polygon's point is moved in by the depth of every scope
 * from the polygon's up to this one, the way the erosion moves a corner —
 * offsets of one shape add, so the depths can be taken together — and put
 * onto the side's shape where it lands. Without this, a corner arriving on a
 * room inside a sealed group stood its vertical all at once.
 */
function groupFading(
  cast: Cast,
  side: Contributed,
  moving: ReadonlyMap<Id, Moving>,
  was: ReadonlyMap<Id, Resolved>,
  t: number,
): number[][] | null {
  const group = sidedWith(side.id) ?? side.id;
  const world = cast.world;

  if (!world.groups.has(group)) return null;

  const set = setOf(side.kind);

  const points: Fade[] = [...(side.faded ?? [])];

  for (const id of within(world, group)) {
    const m = moving.get(id), it = was.get(id);

    if (m === undefined || it === undefined) continue;

    const mine = fadingPoints(m, it, t);

    if (mine.length === 0) continue;

    // Every sealed scope from the polygon's up to this one, each at the depth
    // it stands at, turned the way the slot the one inside it fills is.
    let depth = 0;
    let slot = slotOf(kindOf(it.polygon), set);

    for (const g of enclosing(world, id)) {
      const both = cast.scopes.get(g);

      if (both !== undefined && slot !== null) {
        const top = outermostSlot(world, g, set) ?? 0;
        const kinds = SLOT_KINDS[set];

        depth += mix(both[0], both[1], t) * (inverted(kinds[slot]) !== inverted(kinds[top]) ? -1 : 1);
        slot = top;
      }

      if (g === group) break;
    }

    const snap = near(new Map([[id, it.shape]]));

    for (const { p, v } of mine) {
      const at = corner(it.shape, p, snap);

      if (at === null) continue;

      const moved = depth === 0 ? it.shape[at.ring][at.index] : mitred(it.shape[at.ring], [0], at.index, depth);

      if (moved !== null) points.push({ p: moved, v });
    }
  }

  return paintedOn(side.shape, points);
}

/**
 * The set at one instant, worked out directly rather than interpolated: what
 * the replay is supposed to reproduce, and what the tests hold it to.
 *
 * This is the CPU's answer — resolve the world at `t`, then run the whole CSG.
 * The bake exists precisely so that the game never has to do it, so nothing in
 * the editor calls this; it is the yardstick.
 */
export function truth(world: World, from: number, t: number): Frame {
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
  scopes: Map<GroupId, [number, number]>
  /** Each scope's effects: its options, and its bevel and amplitude at each
   * end, seeded where one end has nought. Absent is none. */
  shapes: Map<GroupId, { facets: Facets, bevel: [number, number] }>
  /**
   * What each eroding group's own points ride: its own flight over the span,
   * and whatever holds it.
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

function casting(world: World, from: number): Cast {
  const near = keyAt(world, from)!, far = keyAt(world, from + 1)!;
  const a = depths(world, near), b = depths(world, far);
  const scopes = new Map<GroupId, [number, number]>();

  // Every sealed group, whatever its depth, and no loose one. It used to be the
  // ones with a depth on them, because erosion was the only thing a group did
  // that the CSG could see; sealing is that question asked outright, and a
  // scope is a scope at depth zero as much as at any other.
  //
  // A loose group is not here at all, and must not be: its members go into the
  // set one by one, and standing for them would bake a different world from
  // the one the editor draws.
  for (const [id, group] of world.groups) {
    if (group.sealed) scopes.set(id, [a.get(id) ?? 0, b.get(id) ?? 0]);
  }

  // A union has no slots to put back, so an end at nought is seeded: the arc
  // turns, however little, and the ring keeps its length.
  const shapes: Cast['shapes'] = new Map();
  const seed = (x: number, y: number): number => (x === 0 && y !== 0 ? y * SEEDING : x);

  for (const id of scopes.keys()) {
    const round = optionOf(world.effects.get(id), 'round');

    if (round === undefined) continue;

    const was = stateAt(world, id, near), now = stateAt(world, id, far);

    // Laid as a polygon's corners are across a span: see `effectsOver`.
    const from = segmentsOf(round, was.bevel), to = segmentsOf(round, now.bevel);

    shapes.set(id, {
      facets: { n: Math.max(from, to), from, to, at: 0, tension: round.tension },
      bevel: [seed(was.bevel, now.bevel), seed(now.bevel, was.bevel)],
    });
  }

  const there = new Set(chain(world, far));
  const riders = new Map<GroupId, Rider>();

  for (const id of scopes.keys()) {
    riders.set(id, {
      // Nothing played, for a group with nothing left in it at the later
      // keyframe: it stands still while it goes, as a dead polygon does.
      ...flightOf(world, from, id, true, standingIn(world, id, there)),
      holders: holders(world, from, id),
    });
  }

  return { world, items: moving(world, from), scopes, shapes, riders, folds: new Map() };
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
      const both = cast.scopes.get(id);

      if (both === undefined) return null;

      const fx = cast.shapes.get(id);

      return {
        depth: mix(both[0], both[1], t),
        frame: riding(cast.riders.get(id)!, t),
        ...(fx === undefined ? {} : {
          effects: { facets: { ...fx.facets, at: weighed(fx.bevel[0], fx.bevel[1], t) }, bevel: mix(fx.bevel[0], fx.bevel[1], t) },
        }),
      };
    },
    held,
  );

  // Every side of it, floors included. An eroding group hands over one union
  // per side and each of them is a real boundary: a floor is a set of its own
  // now, so a group's floors union into one shape exactly as its rooms do, and
  // there is something for that union to be the boundary *of*. See `subjects`.
  return all;
}


/** One track's worth of the span: what it is cut for, and what it is cut
 * from. */
interface Subject {
  id: Id
  mine: Moving[]
  /** Which set this track's boundary belongs to. A track is only ever cut
   * against the other members of its own set. */
  set: SetName
  /** See `Track.fill`. */
  fill: boolean
  /**
   * Which slot of `set` it fills.
   *
   * Only a floor reads it, and only because a floor is no longer cut against
   * its set: a void is its rings wound the other way, which is the whole of
   * what taking it out of the set means when the set is counted rather than
   * carved. See `fillTrack`.
   */
  slot: number
}

/** Which set a kind is in. Every contributor is in exactly one: a void that
 * cuts both was split into two before it got here. See `parts` in `scene.ts`. */
function setOf(kind: PolygonKind): SetName {
  return slotOf(kind, 'level') !== null ? 'level' : 'floor';
}

/** Everything the span's tracks are cut for: a polygon that nothing holds, and
 * an eroding group once per side it has anything on. */
function subjects(cast: Cast): Subject[] {
  const out = new Map<Id, Moving[]>();
  const kinds = new Map<Id, Set<string>>();
  const all: Subject[] = [];

  const subject = (id: Id, mine: Moving[], kind: PolygonKind): Subject => {
    const set = setOf(kind);

    return { id, mine, set, slot: slotOf(kind, set)!, fill: set === 'floor' };
  };

  for (const m of cast.items) {
    // The outermost group that erodes, or the polygon itself. Everything
    // between them is transparent and hands its members on.
    const up = enclosing(cast.world, m.at.id).filter(g => cast.scopes.has(g));
    const id = up[up.length - 1] ?? m.at.id;

    (out.get(id) ?? out.set(id, []).get(id)!).push(m);
    for (const kind of parts(kindOf(m.at.polygon))) {
      (kinds.get(id) ?? kinds.set(id, new Set()).get(id)!).add(kindKey(kind));
    }
  }

  for (const [id, mine] of out) {
    if (!cast.scopes.has(id)) {
      // A polygon in two sets is two tracks, under the ids `parts` named its
      // contributions by. See `parts` in `scene.ts`.
      parts(kindOf(mine[0].at.polygon)).forEach((kind, k) => {
        all.push(subject(k === 0 ? id : sideOf(id, kind), mine, kind));
      });
      continue;
    }

    // A group that holds more than one kind contributes to more than one side,
    // and each side is its own boundary and its own track. They are cut over
    // the same members and ride the same frame; only the classification
    // differs.
    for (const kind of KINDS) {
      if (kinds.get(id)?.has(kindKey(kind)) === true) {
        all.push(subject(sideOf(id, kind), mine, kind));
      }
    }
  }

  return all;
}

/** A polygon as the boundary of one set wants to see it: simplified, unless it
 * came out of an erosion and is an arrangement already. The same reasoning
 * `worldset` uses, and it has to be the same or the two would not agree.
 *
 * Nothing where it is in the other set. A pillar does not cut a floor and a
 * hole in a floor does not cut a room, so the two are never in one another's
 * neighbourhoods at all. */
function memberOf(it: Contributed, set: SetName): Member | null {
  const slot = slotOf(it.kind, set);

  if (slot === null) return null;

  // A source ring as drawn is allowed to cross itself, so it goes through an
  // arrangement here — and an arrangement drops the vertices it does not turn
  // at, this one included. Anything already simple is spared it.
  const shape = it.simple ? it.shape : keeping(simplify(it.shape), it.keep ?? []);

  return shape.length === 0 ? null : { id: it.id, slot, shape };
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
  const mine = at.find(it => it.id === only);

  if (mine === undefined) return [];

  const set = setOf(mine.kind);
  const fill = set === 'floor';
  const members: Member[] = [];

  let subject: Member | null = null;

  for (const it of at) {
    const m = memberOf(it, set);

    if (m === null) continue;
    if (m.id === only) subject = m;

    members.push(m);
  }

  if (subject === null) return [];

  const box = ofRings(subject.shape);
  const others = members.filter(m => m.id !== only && overlaps(box, ofRings(m.shape)));

  const slots = SLOTS[set];
  const rule = (on: readonly boolean[]) => inside(set, on);

  return boundaryRuns(subject, others, slots, rule, ground([subject, ...others], slots))
    .map(r => ({ id: only, points: r.points, corner: r.corner, whence: r.whence, fill }));
}

/** Everybody's share at once, through both full sets. The yardstick's path, and
 * what the editor's own drawing goes through. */
function everything(at: readonly Contributed[]): Frame {
  const both = live(EMPTY_LIVE, at);

  const shares = (set: WorldSet, fill: boolean): Frame =>
    pieces(set).map(p => ({
      id: p.source,
      points: p.points,
      corner: p.corner,
      whence: p.whence,
      fill,
    }));

  // Sorted, so that two evaluations line up run by run. `worldset` hands its
  // runs back in whatever order the entries happen to sit in, which an edit
  // reorders; within one polygon the order is the boundary's own and is stable
  // for as long as the combinatorics are — which is exactly a stretch. Sorting
  // by id afterwards lands each run where its own track put it, which is the
  // order `sample` reads them in, and it is what interleaves the two sets: no
  // polygon is in both, so the id decides it outright.
  return [...shares(both.level, false), ...shares(both.floor, true)]
    .sort((p, q) => p.id - q.id);
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

    // Only a polygon has source corners, and only they can be invented; a
    // scope's side fades where its polygons' do.
    const m = moving.get(it.id), mine = was.get(it.id);
    const how = m === undefined || mine === undefined ? groupFading(cast, it, moving, was, t) : fading(m, mine, t);

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
// It is taken off the polygon before the erosion, because erosion is the
// expensive part and this must not pay for it: reaching for the source ring is
// a few multiplies per vertex, and the whole sweep costs less than one CSG.
//
// Before the erosion is not the same as ignoring it. It used to be, on the
// reasoning that erosion only ever shrinks — and a negative depth grows, and so
// does a group's positive one on the kinds it inverts. A solid dilated flush
// against a room was left out of the room's neighbourhood, the room's track
// never saw the wall it shared, and a line stood in the middle of a flat wall
// for as long as the morph ran while the still, which sees everything, had
// none. So the box takes in where every corner would go under the most any
// offset in play could move it, both ways. See `grown`.
// -----------------------------------------------------------------------------

const PROBES = 16;

/**
 * Where a polygon's corners go under the most that any offset in play could
 * grow it by at `t`, or nothing where nothing can.
 *
 * Its own depth grows it only where the depth is negative — the projection
 * settles which way is in, so a positive one stays inside the source. A sealed
 * group's grows it either way, since the sign alternates with the kind it lands
 * on and a solid inside a group is dilated by the depth that erodes its room.
 * So a group counts by size.
 *
 * Moved both ways, because which way the bisector points out is a question of
 * winding and a box has no use for the answer. The offset moves a corner along
 * its bisector by an amount linear in the depth, so the corners moved by the
 * whole of it bound every smaller offset, and the band an offset sweeps is quads
 * between the source and them. A group's union reaches further out only at its
 * convex corners, and those are its members' own.
 */
function grown(m: Moving, scopes: ReadonlyMap<GroupId, [number, number]>, placed: Ring, t: number): Point[] {
  let groups = 0;

  for (const h of m.holders) {
    const d = scopes.get(h.id);

    if (d !== undefined) groups += Math.abs(mix(d[0], d[1], t));
  }

  const own = m.varying
    ? m.depths[0].map((d, i) => mix(d, m.depths[1][i], t))
    : m.corners.map(() => mix(m.depth[0], m.depth[1], t));

  const out = own.map(d => Math.max(0, -d) + groups);

  if (out.every(d => d === 0)) return [];

  const shape = sliced(placed, ringsOf(m.corners));

  return [...erodedRingCorners(shape, out), ...erodedRingCorners(shape, out.map(d => -d))];
}

function reach(m: Moving, scopes: ReadonlyMap<GroupId, [number, number]>): AABB {
  let all: AABB | null = null;
  let step = 0;
  let was: Ring | null = null;

  for (let k = 0; k <= PROBES; k++) {
    const t = k / PROBES;
    const placed = place(riding(m, t), between(m.local[0], m.local[1], t));
    const now = [...placed, ...grown(m, scopes, placed, t)];
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
function neighbourhoods(all: Subject[], scopes: ReadonlyMap<GroupId, [number, number]>): Moving[][] {
  const boxes = all.map(s => s.mine.map(m => reach(m, scopes)).reduce(merge));

  const tree: Tree = build(boxes.map((box, id) => ({ id, box })));

  // Only within its own set. A pillar cannot bury a floor's boundary and a
  // hole cut in a floor cannot cut a room, so the two sets are never in one
  // another's neighbourhoods however far their boxes overlap — and a box test
  // is the wrong way round to say that, since a floor and the room it is drawn
  // in overlap by construction.
  //
  // A group's two sides find each other here, and must not bring each other's
  // members along: they are the same members, and a neighbourhood holding
  // every one of them twice would put every ring into the arrangement twice.
  return all.map((s, i) => {
    const near = search(tree, boxes[i]).filter(j => j !== i && all[j].set === s.set);
    const seen = new Set<Id>();
    const out: Moving[] = [];

    for (const m of [s.mine, ...near.map(j => all[j].mine)].flat()) {
      if (seen.has(m.at.id)) continue;

      seen.add(m.at.id);
      out.push(m);
    }

    return out;
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
// than the track's `gap` and is then handed back as a gap between two stretches
// rather than as a stretch. That is the same keyframe the event search was there to place —
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
// of resting on an argument about which events exist — and, because it is a
// measure rather than an argument, it is something the bake can be driven by.
// A track outside the tolerance is re-cut finer until it is inside; one that
// will not come inside at any width is named in `Span.strained`. See `chased`.
// -----------------------------------------------------------------------------

/** How far the replay may sit from the CSG before a stretch is split. In
 * `world.ts` because it is a promise to whoever plays the bake back, and one
 * reader there takes it up. See `TOLERANCE`. */
export { TOLERANCE };

/** One frame, at the rate the game is assumed to be drawn at. See `GAP`. */
const FRAME_MS = 1000 / 60;

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
 * A tenth the other way brings that level inside tolerance at 59s.
 *
 * That trade is what makes this a starting depth rather than a setting. Charging
 * a whole level for the depth two crossings need is the wrong shape, so a track
 * that comes back outside the tolerance is cut again a decade finer and only
 * that track pays. This is where it begins; see `chased` for where it ends.
 *
 * Tied to what is actually shown, now. A span plays in `REPLAY_MS` and nobody
 * sees it at more than sixty frames a second, so an event pinned to within a
 * tenth of a frame pops at the frame it would have popped at anyway, and the
 * half gap `abutting` hands each side of it is a window most frames never land
 * in. On the level that asked for this — two bevelled solids crossing, three
 * hundred events a track — it took the bake from 12s to a few seconds, for a
 * `worst` of a unit or two inside those windows where `EXACT_GAP` held it to
 * four hundredths everywhere.
 *
 * Linear in `t`, which the easing is not: where it is slow a frame covers less
 * of the span than this assumes, and where it is fast, more.
 *
 * To go back to holding the tolerance everywhere, make this `EXACT_GAP`.
 */
export const GAP = FRAME_MS / REPLAY_MS / 10;

/** What `GAP` was before it was counted in frames: a width chosen to hold the
 * tolerance, whatever the frame rate. */
export const EXACT_GAP = 1e-4;

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

/**
 * The two widths a bisection stops at, together, because a track is cut at a
 * pair of them and the pair is what a re-cut makes finer.
 *
 * They were module constants, which said the depth of the search was a property
 * of the bake rather than of the track. It is not: a track whose crossings race
 * wants a depth the rest of the level would be ruined by paying for. See
 * `chased`.
 */
export interface Limits {
  gap: number
  bend: number
}

/** What a track is cut at until it gives the bake reason to go finer, starting
 * events at `gap`. */
function limitsFrom(gap: number): Limits {
  return { gap, bend: BEND };
}

/**
 * As far as a re-cut will ever go, whatever the measure says.
 *
 * Three decades below `EXACT_GAP`, and it is a real bound rather than a formality.
 * `PAYING` stops a track whose error has stopped falling, which is the case it
 * was written for; it does not stop one whose error keeps falling towards a
 * tolerance it will never reach. That track chases every decade, and a decade
 * of `bend` is a decade of bisection depth on every stretch that bends — the
 * work grows ten times faster than the error falls. Asked for a tolerance of
 * 1e-14, six turning boxes ran the heap out rather than finishing.
 *
 * Three is what the levels to hand ever wanted: on the worst of them the two
 * strained tracks stopped at one decade and at two. A track that has spent
 * three and is still outside is asking for a tolerance the bake cannot afford,
 * and the honest answer to that is `Span.strained` rather than the heap.
 */
const FINEST = 1e-7;

/**
 * How much of the error a decade of depth has to remove to earn the next one.
 *
 * The stopping rule, and it took a measurement to find. Chasing every track that
 * was outside the tolerance all the way to `FINEST` was the obvious thing and it
 * is a bad bargain: on the worst level to hand it took the bake from 7.5s to 97s
 * and the error from 11.30 to 5.86 — thirteen times the work to stay a hundred
 * times outside the tolerance. Dearer and still wrong.
 *
 * What the two offending tracks showed is that they were not the same case. One
 * went 11.30 to 4.11 and was still coming down, which is a crossing racing
 * through a stretch: continuous, so halving the interval does halve the chord,
 * so depth is the answer and it is only a question of how much. The other went
 * 5.866 to 5.863 across five decades, which is not a bend at any depth — it is a
 * discontinuity that `comparable` accepted, and no width makes the two sides of
 * one agree. Five decades of bisection bought three thousandths.
 *
 * So the question a re-cut asks is not "is there width left" but "did the last
 * decade pay". An error that is the search's own falls when the search deepens.
 * One that is not, does not, and says so immediately and cheaply.
 */
const PAYING = 0.7;

/**
 * How many events a track may pin, against the stretches it keeps, and still be
 * offered another decade.
 *
 * `PAYING` asks whether the last decade reduced the error. That is the right
 * question and it is not the only one, because a decade does not cost every
 * track the same. On the level this was found on, a track deepened from 4,801
 * stretches and 705 events to 5,906 and 734: the error fell from 11.30 to 4.11
 * for a fifth again the work. On another, a track went from 73 stretches and
 * 3,931 events to 335 and *30,437* — the error fell too, from 6.97 to 2.55, so
 * `PAYING` waved the next decade through, and the next one is three hundred
 * thousand events and the heap.
 *
 * The counts say what the difference is. Pinning a fixed set of events finer
 * adds a few evaluations to each and leaves the count where it was; a count that
 * multiplies means the finer look is finding events that were not there before.
 *
 * So a track whose cover is mostly events is not offered a decade. The two
 * populations were two orders of magnitude apart either side of this — 0.15 and
 * 0.13 against 54 — so it is a line drawn through empty space rather than a
 * number tuned against a level.
 *
 * Where the second track's events came from is now known and fixed: a
 * self-crossing was one point of the boundary with two names, and the walk chose
 * between them freely, so the bake read a name changing and pinned it. That
 * level bakes in a second and a half now, with 118 events and nothing strained.
 * See `boundaryRuns`.
 *
 * Which leaves this a guard rather than a working part — nothing to hand reaches
 * it. It is kept because what it guards against is not that bug. Any polygon
 * whose combinatorial state churns faster than the search resolves it makes the
 * same shape of cover, and what that cost was not a bad bake but a bake that
 * never finished. A comparison against a number in empty space is worth having
 * on that road even with nothing on it. See `Span.strained`.
 */
const CHURN = 1;

/** A decade deeper, both of them. */
const finer = (l: Limits): Limits => ({ gap: l.gap / 10, bend: l.bend / 10 });

const MARGIN = 0.5;

/** Two evaluations that could be the ends of one stretch, or could not. */
function comparable(a: Taken, b: Taken): boolean {
  return signature(a.frame) === signature(b.frame) && explained(a, b) && numbered(a, b);
}

/**
 * Whether the two readings number their shapes the same way, for every polygon
 * a crossing names an edge of.
 *
 * A crossing is not a position, it is two edges — `drawn` rebuilds it at every
 * instant from their four endpoints, and it finds those endpoints by index into
 * the polygon's own shape. So the index has to mean the same vertex at both ends
 * of a stretch, and `signature` does not say that: it compares the *boundary's*
 * names, and two readings can name the boundary identically while the shape
 * under it has gained a vertex somewhere the boundary does not reach.
 *
 * When that happened the stretch was built anyway and every crossing in it was
 * rebuilt from one edge at one end and a different edge at the other. The error
 * is whatever the two edges happen to be apart — nothing to do with the width of
 * the interval, so bisecting never touched it. A level came back at 5.86 against
 * a tolerance of 0.05 with the two ends of the offending stretch 6e-8 apart:
 * seven vertices at one, eight at the other, and `entry` reaching for index 6 of
 * each and getting two different edges.
 *
 * Only the polygons a crossing actually names. Every polygon in the table would
 * be simpler and would end stretches for a neighbour's vertex count changing
 * where nothing refers to it.
 */
function numbered(a: Taken, b: Taken): boolean {
  const same = (r: Ref): boolean => {
    const p = a.table.get(r.id)?.[r.ring], q = b.table.get(r.id)?.[r.ring];

    return p !== undefined && q !== undefined && p.length === q.length;
  };

  for (const it of [a, b]) {
    for (const run of it.out) {
      for (const o of run.whence) {
        if (o.kind === 'cross' && !(same(o.a) && same(o.b))) return false;
      }
    }
  }

  return true;
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

  // Every rotation against every other is quadratic in the ring, and a bevel
  // makes rings long. So the names are written out once rather than per pair,
  // a rotation is dropped as soon as it is already further than the best, and
  // the names are only counted for one that can still win.
  const an = a.whence.slice(0, n).map(names), bn = b.whence.slice(0, n).map(names);

  let best = 0, cost = Infinity, agree = -1;

  for (let k = 0; k < n; k++) {
    let far = 0;

    for (let j = 0; j < n && far <= cost; j++) {
      const p = a.points[j], q = b.points[(j + k) % n];

      far += (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
    }

    if (far > cost) continue;

    let same = 0;

    for (let j = 0; j < n; j++) {
      if (an[j] === bn[(j + k) % n]) same++;
    }

    if (far < cost || same > agree) {
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
  const which = (run: Run) => `${run.id}:${visits(run.whence)}`;

  const spare = new Map<string, number>();

  from.forEach((run, i) => {
    const key = which(run);

    if (!spare.has(key)) spare.set(key, i);
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

/**
 * The points of the arrangement a run visits, as one string. Remembered by the
 * run's names, which are never written to once made: the same reading is lined
 * up against every other it is compared with, and writing this out was the
 * greater part of the cost of lining one up.
 */
const visited = new WeakMap<readonly Origin[], string>();

function visits(whence: readonly Origin[]): string {
  let known = visited.get(whence);

  if (known === undefined) {
    known = [...new Set(whence.map(names))].sort().join(',');
    visited.set(whence, known);
  }

  return known;
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

// -----------------------------------------------------------------------------
// Floors are not cut against anything
//
// A floor produces no walls and no lines. It produces filled ground and nothing
// else — `walling` in the game's `morph.ts` skips a fill track outright — and
// filled ground is counted rather than carved: the nonzero rule over every
// floor ring *is* the floor set. See the header of the game's `walls.ts`.
//
// The holes are counted apart from the floors, and have to be. A count is
// additive where a set is not: two floors over the same ground count two, and a
// hole through both of them takes one away and leaves the ground filled, where
// the set says bare. So one count is not enough for both — the floors are
// counted and what they filled is marked, and the holes are then counted inside
// that mark and taken back out. Two counts and a mask, on the GPU, at a cost
// that does not move with how much is in them. That is what `Track.hole` is
// there to say, and it is why a floor set with a hole in it is no longer a
// reason to give up and cut the boundary after all.
//
// So the boundary of the floor set is a thing nobody needs. A floor track is
// the polygon's own rings, exactly as its own erosion left them, and the union
// with its neighbours happens on the GPU by arithmetic that cannot go wrong.
// No arrangement, no runs partitioned by source, no crossings to solve, and no
// topology events — because a ring has none. What is left to end a stretch is
// the ring itself changing shape: a vertex born or dying, or an erosion deep
// enough to collapse a corner.
//
// What that is worth
// ------------------
// Everything, on a level anyone actually draws. A vertex dragged far enough
// that the ring crosses itself is ordinary authoring, and the boundary of a
// self-crossing ring is a genuinely eventful thing — the arrangement splits it
// into loops, the loops appear and vanish, and each of those is a
// discontinuity the cut has to pin. Measured on `world-2026-09-08T10-43-44Z`,
// two floors with a vertex each dragged across the shape cost fifty thousand
// evaluations, two thousand stretches and nine seconds, and reported itself two
// hundred times outside its own tolerance. The same world cuts in a tenth of a
// second now, inside its tolerance. The room in it cost fifteen evaluations
// either way.
//
// None of that was the set being hard. It was the boundary of the set being
// asked for, by something that only ever wanted the area inside it.
//
// The ring is still resolved, and still measured
// ----------------------------------------------
// Resolved, because it is the polygon's own arrangement that is handed over
// and not its ring as drawn. A count is additive where a set is not: a ring
// that crosses itself has lobes wound against each other, and a lobe at -1
// cancels a neighbouring floor's +1 over the ground they share, where the set
// says filled. Resolved, a polygon is simple rings around the region it fills,
// wound together by `fillRuns`, and it contributes the one or the nothing it
// ought to however it was drawn.
//
// The ring as drawn is tempting and is worth naming as a dead end: it needs no
// evaluations at all and it makes a self-crossing floor one stretch instead of
// forty. It is sound exactly when the ring is simple — and a simple ring *is*
// its own arrangement, so the case it would have paid for is the case it gets
// wrong. What it saves on a ring that never crosses itself is three
// evaluations.
//
// Measured, not because of topology but because of erosion, which walks a
// corner along its mitre on a path no lerp of the two ends follows. So a
// stretch is checked the same way the walls' are — the interpolation against
// the truth at the middle, split if it is too far — and the check is point
// against point, because a ring cut this way has the same corners at both ends
// and knows which is which.
// -----------------------------------------------------------------------------

/** The rings of one subject's own eroded shape at `t`, in the frame its points
 * are kept in. No boundary is taken: this is the shape itself. */
function ringsAt(cast: Cast, mine: Moving[], id: Id, t: number): Ring[] {
  const table = evaluate(cast, mine, t, id).table.get(id);

  return table === undefined ? [] : table.filter((r): r is Ring => r !== undefined);
}

/** Whether two readings of a ring set are the same ring set moved: same rings,
 * same corners, in the same order. Anything else is a vertex arriving or an
 * erosion taking one away, and neither interpolates. */
function alike(a: readonly Ring[], b: readonly Ring[]): boolean {
  return a.length === b.length && a.every((ring, i) => ring.length === b[i].length);
}

/**
 * One floor's own rings as a track: closed runs, wound the way its op means.
 *
 * `whence` names every point a vertex of the ring it is in, which is what it
 * is, and what makes the two ends of a stretch pair up point for point. There
 * are no crossings in here to name — that is the whole difference.
 *
 * Wound, and that word is doing all the work. A count is *additive* where a set
 * is not: two floors over the same ground count two, and it is only because
 * two is not zero that this draws the union at all. Let one of them be wound
 * the other way — a ring drawn clockwise, which nothing stops an author doing —
 * and the two cancel to nothing over the ground they share, where the set says
 * filled. So the sign is not taken as drawn: every polygon is turned to face
 * the way its slot means, floors one way and voids the other, and then the
 * only thing a sum can do is grow.
 *
 * Which is also why this is handed the polygon's *resolved* rings rather than
 * its ring as drawn. A ring that crosses itself has lobes wound against each
 * other — a figure eight has one of each — and those cancel against a
 * neighbour exactly as a clockwise floor would. Resolved, a polygon is simple
 * rings around the region it fills, wound together, and it contributes the one
 * or the nothing it ought to.
 */
function fillRuns(id: Id, rings: readonly Ring[], slot: number): Frame {
  let area = 0;

  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length];

      area += p.x * q.y - q.x * p.y;
    }
  }

  // A shape with no area at all has no sense of which way it faces, and turning
  // it round would be a coin toss. It counts nothing either way.
  const facing = slot === 0 ? 1 : -1;
  const turn = area !== 0 && Math.sign(area) !== facing;

  return rings.map((ring, r) => {
    const points = turn ? [...ring].reverse() : [...ring];

    // Closed, first point repeated at the end. A fan wants every edge of the
    // ring and the last one is the one back to the start.
    return {
      id,
      points: [...points, points[0]],
      corner: points.map(() => true).concat(true),
      whence: points
        .map((_unused, i): Origin => ({ kind: 'vertex', at: { id, ring: r, index: i } }))
        .concat({ kind: 'vertex', at: { id, ring: r, index: 0 } }),
      fill: true,
    };
  });
}

/**
 * One stretch of a fill track: the rings at each end, and nothing else to say
 * about them.
 *
 * No table and no origins, because there is nothing in a fill to solve — every
 * point is a vertex of its own ring and interpolates exactly. No opacity that
 * means anything either: a fill draws no lines, so nothing here can be wrong
 * about a corner.
 */
function held0(id: Id, a: readonly Ring[], b: readonly Ring[], slot: number): Stretch {
  const runs = fillRuns(id, a, slot);

  return {
    t0: 0,
    t1: 1,
    a: runs,
    b: fillRuns(id, b, slot),
    table: new Map(),
    origins: runs.map(run => run.points.map(() => null)),
    opacity: [
      a.map(ring => ring.map(() => 1).concat(1)),
      b.map(ring => ring.map(() => 1).concat(1)),
    ],
  };
}

/** How far a ring set lerped across a stretch sits from the ring set actually
 * there, point against point — which is a comparison the walls cannot make and
 * this can, because both ends are the same corners. */
function drift(a: readonly Ring[], b: readonly Ring[], now: readonly Ring[], u: number): number {
  let worst = 0;

  for (let r = 0; r < now.length; r++) {
    for (let i = 0; i < now[r].length; i++) {
      const p = a[r][i], q = b[r][i], at = now[r][i];

      worst = Math.max(worst, Math.hypot(p.x + (q.x - p.x) * u - at.x, p.y + (q.y - p.y) * u - at.y));
    }
  }

  return worst;
}

/**
 * One floor's cut of the span: its own rings, and wherever they stop being the
 * same rings moved, a split.
 *
 * The same shape as `cutTrack` and a great deal less of it. There is no
 * arrangement to compare, so two readings are comparable when they have the
 * same corners; and there is no boundary to measure against, so the check is
 * the lerp against the ring itself.
 */
function* fillTrack(
  cast: Cast,
  mine: Moving[],
  id: Id,
  slot: number,
  tol: number,
  limits: Limits,
): Generator<number, Cut, void> {
  const out: Stretch[] = [];
  const jumps: Stretch[] = [];

  let evaluations = 0;
  let worst = 0;

  const at = (t: number): { t: number, rings: Ring[] } => {
    evaluations++;

    return { t, rings: ringsAt(cast, mine, id, t) };
  };

  const held = (a: { t: number, rings: Ring[] }, b: { t: number, rings: Ring[] }): Stretch =>
    ({ ...held0(id, a.rings, b.rings, slot), t0: a.t, t1: b.t });

  const stack: [{ t: number, rings: Ring[] }, { t: number, rings: Ring[] }][] = [[at(0), at(1)]];

  let done = 0;

  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    const narrow = b.t - a.t <= limits.gap;

    if (!alike(a.rings, b.rings)) {
      if (!narrow) {
        const m = at((a.t + b.t) / 2);

        stack.push([m, b], [a, m]);
        continue;
      }

      // A corner arriving or leaving. Both sides kept, as a discontinuity.
      jumps.push(held(a, a), held(b, b));

      done = b.t;
      yield done;
      continue;
    }

    const m = at((a.t + b.t) / 2);
    const off = alike(a.rings, m.rings) ? drift(a.rings, b.rings, m.rings, 0.5) : Infinity;

    if (off > tol * MARGIN && b.t - a.t > limits.bend) {
      stack.push([m, b], [a, m]);
      continue;
    }

    worst = Math.max(worst, Number.isFinite(off) ? off : 0);
    out.push(held(a, b));

    done = b.t;
    yield done;
  }

  out.sort((x, y) => x.t0 - y.t0);
  jumps.sort((x, y) => x.t0 - y.t0);

  // The same closing `cutTrack` does, and safe here for the reason it argues
  // there and then checks: half a gap is smaller than the tolerance the gap
  // converged to. It checks anyway because a crossing can move at any speed
  // inside a gap, and there are no crossings in a floor — every point of one is
  // a vertex of its own ring, and a vertex moves at the speed it moves at.
  return { stretches: abutting(out.filter(wide)), jumps, worst, evaluations };
}

/**
 * One interval of a track's bisection, as it settled: a stretch across it, or
 * the two instants either side of an event pinned inside it.
 *
 * The pieces tile the span in order, each exactly the interval the bisection
 * stopped on, which is what lets one of them be cut again on its own. The
 * bisection is local — what happens inside an interval depends on its two ends
 * and nothing else — so cutting one piece a decade finer gives exactly what
 * cutting the whole track a decade finer would have given there.
 */
interface Piece {
  a: Taken
  b: Taken
  kept: Stretch[]
  /** What the check measured across it. Nothing for an event. */
  off: number
  /**
   * Whether it stopped because the interval ran out of width rather than
   * because it was right. Only these can come out any differently cut finer: a
   * stretch that passed its check passes it at any depth, so a finer cut would
   * walk down to it and stop there again.
   */
  limited: boolean
}

/** What cutting one track needs, whatever part of it is being cut. */
interface Cutting {
  at: (t: number) => Taken
  riders: Map<Id, Rider>
  tol: number
}

/**
 * One polygon's own cut of `[from, to]`, as pieces.
 *
 * The measuring is the same as it ever was; what has changed is what is being
 * measured. A stretch used to end when *anything anywhere* changed, which put a
 * whole-world keyframe in the file for an event two hundred rooms away and made
 * both the work and the file grow with the square of the level. A polygon's
 * boundary is a question about its own neighbourhood, so its keyframes are too.
 */
function* bisected(
  c: Cutting,
  from: Taken,
  to: Taken,
  limits: Limits,
): Generator<number, Piece[], void> {
  const { at, riders, tol } = c;
  const pieces: Piece[] = [];

  // Left to right, so what comes out is in order and the progress is honest:
  // how much of the span has been settled, which only ever goes forwards.
  const stack: [Taken, Taken][] = [[from, to]];

  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    const narrow = b.t - a.t <= limits.gap;

    if (!comparable(a, b)) {
      if (!narrow) {
        const m = at((a.t + b.t) / 2);

        stack.push([m, b], [a, m]);
        continue;
      }

      // Pinned as far as it is worth pinning: a discontinuity, and the two
      // sides of it genuinely have different geometry. Both are kept.
      pieces.push({ a, b, kept: [instant(a), instant(b)], off: 0, limited: true });

      yield b.t;
      continue;
    }

    const s = stretchOf(a, b);

    // How far the stretch would sit from the truth at an instant inside it.
    const check = (x: Taken): number =>
      comparable(a, x) ? apart(drawn(s, riders, x.t), x.out) : Infinity;

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

    if (off > tol * MARGIN && b.t - a.t > limits.bend) {
      stack.push([m, b], [a, m]);
      continue;
    }

    // Narrow and still not agreeing: the ends were comparable but the inside is
    // not, which is a discontinuity that has been pinned as far as it is worth
    // pinning — the same answer the incomparable path above reaches, from the
    // other side of it.
    if (!Number.isFinite(off)) {
      pieces.push({ a, b, kept: [instant(a), instant(b)], off: 0, limited: true });

      yield b.t;
      continue;
    }

    // Measured whether or not it passed. A stretch kept because the interval ran
    // out of width is still the bake's error to own: `worst` is what the bake
    // says about itself, and a number that only counts the checks that went well
    // is not that. This used to be the one place a stretch was kept with no
    // check at all, and what it hid was a whole unit of pop in a level with
    // anything much turning in it.
    pieces.push({ a, b, kept: [s], off, limited: off > tol * MARGIN });

    yield b.t;
  }

  return pieces;
}

/**
 * A track's pieces made into its cut, and which of them are why it is not
 * inside the tolerance — the ones a finer cut should go back to.
 */
function settled(c: Cutting, pieces: readonly Piece[]): Cut & { failing: boolean[] } {
  const { riders, tol } = c;
  const out: Stretch[] = [];

  // Which piece each of `out` came from.
  const whose: number[] = [];
  const failing = pieces.map(p => p.limited && p.off > tol);

  let worst = 0;

  pieces.forEach((p, k) => {
    worst = Math.max(worst, p.off);

    for (const s of p.kept) {
      const last = out[out.length - 1];

      // Two instants running together, or a stretch that adds nothing.
      if (last !== undefined && last.t0 === last.t1 && last.t0 === s.t0 && s.t0 === s.t1) continue;

      out.push(s);
      whose.push(k);
    }
  });

  const wideAt = out.flatMap((s, j) => (wide(s) ? [j] : []));
  const kept = wideAt.map(j => out[j]);
  const cover = abutting(kept);

  // The pieces between two of `kept`, which pinned the event whose gap it is.
  // `-1` and `pieces.length` stand for the two ends of the span.
  const between = (from: number, to: number): void => {
    for (let k = from + 1; k < to; k++) {
      if (pieces[k].limited) failing[k] = true;
    }
  };

  const pieceOf = (i: number): number =>
    i < 0 ? -1 : i >= kept.length ? pieces.length : whose[wideAt[i]];

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
  //
  // Where it is outside, the gap is what is wrong, and the gap is the event
  // pieces either side of this stretch: those are what a finer cut narrows.
  for (let i = 0; i < cover.length; i++) {
    const grown = cover[i], was = kept[i];

    for (const [t, side] of [[grown.t0, -1], [grown.t1, 1]] as const) {
      if (t >= was.t0 && t <= was.t1) continue;

      const now = c.at(t);

      // The two sides of an event genuinely differ, and the size of that is the
      // event's own, not the replay's — the same exclusion `apart` makes by
      // coming back infinite. Here it has to be made in so many words, because
      // `strayed` will cheerfully measure the distance across a discontinuity
      // and report the pop as though the replay had invented it.
      if (signature(drawn(grown, riders, t)) !== signature(now.out)) continue;

      const off = strayed(drawn(grown, riders, t), now.out);

      worst = Math.max(worst, off);

      if (off > tol) {
        const here = pieceOf(i), there = pieceOf(i + side);

        between(Math.min(here, there), Math.max(here, there));
      }
    }
  }

  return { stretches: cover, jumps: out.filter(s => !wide(s)), worst, evaluations: 0, failing };
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
/**
 * A track the search could not bring inside the tolerance, and how far it got.
 *
 * `Span.worst` says how wrong the bake is; this says *where*, and how hard the
 * bake tried. `gap` is the reading to go by, and it says which of three things
 * happened:
 *
 * - The starting gap — never re-cut at all, because the track pins more events than
 *   it keeps stretches. Its ring crosses itself; the arrangement is churning
 *   rather than moving, and depth would find more churn rather than less error.
 *   The polygon is what wants fixing, not the bake. See `CHURN`.
 * - One decade below — deepened once and it bought nothing, so the error is a
 *   discontinuity `comparable` accepted rather than a bend. Also a level to look
 *   at, for a different reason. See `PAYING`.
 * - Several decades below — it was coming closer the whole way and ran out of
 *   patience rather than out of argument. That one is a tolerance question, and
 *   the answer might be to ask for less.
 */
export interface Strain {
  id: PolygonId
  /** What the best of the attempts measured. */
  worst: number
  /** The widths that best attempt was cut at, by its `gap`. */
  gap: number
}

export interface Slice {
  /** Each with its own error on it, which is where a span's comes from. */
  tracks: Track[]
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
export function ridersOf(world: World, from: number): Map<Id, Rider> {
  const cast = casting(world, from);

  return ridersFrom({ riders: ridden(cast, subjects(cast)), from }, world);
}

/**
 * The same, off something that has already resolved the span.
 *
 * `ready` works the polygons' riders out on its way to the neighbourhoods, so a
 * span that has one has already paid for all of this but the artefacts. Asking
 * `ridersOf` afterwards resolved the world a second time for an answer sitting
 * in front of it — which cost nothing worth naming while a bake cut every
 * track, and is a fifth of what an incremental one does.
 */
function ridersFrom(at: { riders: Map<Id, Rider>, from: number }, world: World): Map<Id, Rider> {
  const out = new Map(at.riders);

  for (const [id, rider] of carried(world, at.from)) out.set(id, rider);

  return out;
}

/**
 * What each artefact rides, which is what a polygon rides.
 *
 * An artefact has no geometry and so no track, and it is in here for one
 * reason: a slot in the frame table. Everything that carries a wall carries
 * whatever is standing in it, so a key on the floor of a room that turns goes
 * round with the room rather than taking the chord — and it does so by riding
 * the same chain, played the same way, rather than by a second answer to a
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
 * What it plays of its own is only where it is standing at both ends.
 * Arriving, it is where the far keyframe puts it, outright — there is no
 * earlier place for that to be a move away from. Leaving, it plays nothing:
 * whatever the far keyframe says about it was written before the delete and
 * is inert, exactly as `moving` says of a polygon's. See `flightOf`.
 */
function carried(world: World, from: number): Map<Id, Rider> {
  const out = new Map<Id, Rider>();
  const late = keyAt(world, from + 1);

  if (late === null) return out;

  const early = keyAt(world, from)!;
  const near = new Set(chain(world, early));
  const far = new Set(chain(world, late));

  for (const id of world.artefacts.keys()) {
    const here = standingIn(world, id, near), there = standingIn(world, id, far);

    // At neither end is not in the span at all: one the keyframes have not
    // reached yet, and one they finished with before it began.
    if (!here && !there) continue;

    out.set(id, { ...flightOf(world, from, id, here, there), holders: holders(world, from, id) });
  }

  return out;
}

/**
 * What each subject's runs ride.
 *
 * A polygon rides its own chain. A scope rides its own: its members' frames
 * already carry it, so the union it hands over is in world units with the
 * motion in it, and the scope's chain is what the union's points are taken
 * back into — so that a turning group is a turn in the buffers rather than a
 * chord across it.
 */
function ridden(cast: Cast, all: Subject[]): Map<Id, Rider> {
  const own = new Map(cast.items.map(m => [m.at.id, m]));

  return new Map(all.map(s => {
    const m = own.get(s.id);
    const group = sidedWith(s.id) ?? s.id;

    return [
      s.id,
      m === undefined
        ? cast.riders.get(group) ?? { frame: REST, ops: [], holders: [] }
        : { frame: m.frame, ops: m.ops, holders: m.holders },
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
  from: number
  cast: Cast
  /** What the tracks are cut for, and what a job names them by. */
  items: Subject[]
  near: Moving[][]
  riders: Map<Id, Rider>
  /** Milliseconds it took, which is the fixed cost of putting a thread on this
   * span at all. */
  setup: number
}

export function ready(world: World, from: number): Ready {
  const began = now();
  const cast = casting(world, from);
  const items = subjects(cast);

  return {
    from,
    cast,
    items,
    near: neighbourhoods(items, cast.scopes),
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
/**
 * One track, cut as finely as it takes to keep the bake's own promise.
 *
 * `Span.worst` used to be a number the bake reported and then did nothing
 * about. A level came back at eleven and a half against a tolerance of five
 * hundredths and the only thing to do was to reach for `GAP` by hand, which
 * charges the whole level for the depth two crossings needed.
 *
 * So the depth is per track and it is driven by the measure. Cut at the starting `gap`;
 * if what comes back is outside the tolerance, cut the same track again a
 * decade finer, and again, until it is inside or the widths reach `FINEST`.
 *
 * How far is "finer" allowed to go is the whole question, and the first answer —
 * as far as the numbers can represent — was wrong. The argument for it was that
 * `worst` only ever holds a continuous error, because a genuine event is
 * incomparable and gets pinned and excluded rather than measured. That argument
 * is false, and the measurement says so: one of the two bad tracks on the worst
 * level to hand went 5.866 to 5.863 across five decades. A discontinuity
 * `comparable` accepts is a discontinuity all the same, and no width makes its
 * two sides agree.
 *
 * So the loop stops on whether the last decade paid rather than on whether there
 * is width left. See `PAYING`. A track whose error is the search's own sees it
 * fall when the search deepens; a track whose error is not sees nothing, once,
 * and is named in `Span.strained` for a person to look at.
 *
 * The cost is paid where it is owed. A track inside the tolerance is cut once
 * and never looked at again, which is nearly every track on every level — the
 * healthy levels to hand bake to the evaluation exactly as before. A track that
 * is outside pays for its own depth and no one else's, and pays one speculative
 * decade to find out that depth is not the answer. Every attempt's evaluations
 * are counted, the discarded ones included: a re-cut is work the bake did.
 */
function* chased(
  at: Ready,
  i: number,
  fill: boolean,
  tol: number,
  gap: number,
): Generator<number, Cut & { limits: Limits }, void> {
  if (!fill) return yield* recut(at, i, tol, gap);

  const { id } = at.items[i];

  let limits = limitsFrom(gap);
  let best: (Cut & { limits: Limits }) | null = null;
  let was = Infinity;
  let spent = 0;
  let seen = 0;

  while (true) {
    // Its own members, and nothing else: a floor is not cut against its
    // neighbours, so resolving them would be work nobody reads.
    const inner = fillTrack(at.cast, at.items[i].mine, id, at.items[i].slot, tol, limits);

    let cut: Cut | null = null;

    // A re-cut starts its own progress at zero. What the caller is shown is how
    // far this track has ever got, so an attempt being made again reads as a
    // pause rather than as ground given back.
    while (cut === null) {
      const step = inner.next();

      if (step.done) {
        cut = step.value;
      }
      else {
        seen = Math.max(seen, step.value);
        yield seen;
      }
    }

    spent += cut.evaluations;

    // The best of the attempts, not the last. A finer cut splits in different
    // places and is not bound to beat a coarser one everywhere; what the span
    // promises is the smallest error the bake managed, so that is what it keeps.
    if (best === null || cut.worst < best.worst) best = { ...cut, limits };

    // Inside the tolerance, out of width, a decade that did not pay for itself,
    // or a track that pins more events than it keeps stretches — which is a
    // decade nobody can afford however well it would pay. See `PAYING`, `CHURN`.
    if (
      best.worst <= tol
      || limits.gap <= FINEST
      || cut.worst > PAYING * was
      || cut.jumps.length > CHURN * cut.stretches.length
    ) {
      return { ...best, evaluations: spent };
    }

    was = cut.worst;
    limits = finer(limits);
  }
}

/**
 * `chased`, for a track cut against its neighbours: the same decades and the
 * same rules for stopping, but each decade goes back only to the pieces that
 * are outside the tolerance.
 *
 * It used to cut the whole track again. A track's error is nearly always in one
 * place — a crossing racing through the gap around one event — and cutting it
 * again a decade finer pinned every other event in the track a decade finer
 * too, for nothing: a level whose two busy tracks held three hundred events
 * each spent half its bake re-pinning the ones that had been fine. The pieces
 * that come back are the ones the whole track cut finer would have had there,
 * because the bisection inside an interval is its own; the rest are left as the
 * coarser decade had them.
 */
function* recut(at: Ready, i: number, tol: number, gap: number): Generator<number, Cut & { limits: Limits }, void> {
  const { id } = at.items[i];
  const sub = at.near[i];

  // Every instant this track has looked at, so that a piece cut again finds its
  // two ends and its middle already worked out. Kept for this track only: its
  // neighbours ask with a different subject.
  const taken = new Map<number, Taken>();

  let evaluations = 0;
  let seen = 0;

  const c: Cutting = {
    at: t => {
      let known = taken.get(t);

      if (known === undefined) {
        evaluations++;
        known = evaluate(at.cast, sub, t, id);
        taken.set(t, known);
      }

      return known;
    },
    riders: at.riders,
    tol,
  };

  // A piece cut again reports how far it has got, which is behind where the
  // track has been. What the caller is shown is how far this track has ever
  // got, so going back reads as a pause rather than as ground given back.
  function* shown<T>(g: Generator<number, T, void>): Generator<number, T, void> {
    while (true) {
      const step = g.next();

      if (step.done) return step.value;

      seen = Math.max(seen, step.value);
      yield seen;
    }
  }

  let limits = limitsFrom(gap);
  let pieces = yield* shown(bisected(c, c.at(0), c.at(1), limits));
  let cut = settled(c, pieces);
  let best = { ...cut, limits };
  let was = Infinity;

  while (true) {
    // As `chased`: inside the tolerance, out of width, a decade that did not
    // pay for itself, or a track that pins more events than it keeps
    // stretches. See `PAYING`, `CHURN`.
    if (
      best.worst <= tol
      || limits.gap <= FINEST
      || cut.worst > PAYING * was
      || cut.jumps.length > CHURN * cut.stretches.length
    ) {
      return { stretches: best.stretches, jumps: best.jumps, worst: best.worst, evaluations, limits: best.limits };
    }

    was = cut.worst;
    limits = finer(limits);

    const next: Piece[] = [];

    for (let k = 0; k < pieces.length; k++) {
      if (cut.failing[k]) {
        next.push(...yield* shown(bisected(c, pieces[k].a, pieces[k].b, limits)));
      }
      else {
        next.push(pieces[k]);
      }
    }

    pieces = next;
    cut = settled(c, pieces);

    // The best of the decades, not the last. See `chased`.
    if (cut.worst < best.worst) best = { ...cut, limits };
  }
}

// -----------------------------------------------------------------------------
// What a track was cut from
//
// A track is cut against its own neighbourhood and reads nothing else — that is
// what makes the bake a dealing-out problem, and it is also what makes a bake
// after an edit mostly a re-run of work already done. An edit reaches a handful
// of polygons; every other track on the level would be cut from exactly the
// geometry it was cut from last time and would come out exactly as it did.
//
// So each track carries a hash of everything it was cut from, and a bake keeps
// the tracks whose hash has not moved. What has to be in that hash is what the
// cut reads, and the cut reads three things:
//
// - its own polygon over the span — which is `at1` and `invented`, and so is
//   the named fields below rather than the `Moving` whole. Never `at.shape`:
//   spreading a `Resolved` works its projection out, which is the one thing a
//   signature must not pay for.
// - its neighbours' the same way, and *which* neighbours they are. Membership
//   is worked out afresh every bake from the reach boxes, so a polygon that
//   moves into range shows up here as a member that was not there before. By
//   id rather than in the order the sweep handed them over: the arrangement
//   does not depend on that order and a signature must not either.
// - the scopes they ride. A sealed group's depth is a fact about the whole
//   group rather than about any member, so a change to it reaches a polygon
//   that nothing was written about. This is the one dependency that is not
//   local, and leaving it out would keep a track that should have been cut
//   again.
//
// The risk this carries is not a slow bake, it is a wrong one: a track wrongly
// kept is geometry that silently disagrees with the world. `bake.test.ts` holds
// it to the only standard that matters — an incremental bake and a full one of
// the same world come out identical, over every shape of edit there is.
// -----------------------------------------------------------------------------

/**
 * Every primitive in a value, in an order that depends on the value alone:
 * arrays in their own order, objects and maps by sorted key.
 *
 * Brackets as well, so that two different shapes cannot flatten to the same
 * list — `[[1], [2]]` and `[[1, 2], []]` hold the same numbers in the same
 * order and are not the same value.
 */
function into(out: unknown[], v: unknown): void {
  if (v === null || typeof v !== 'object') {
    out.push(v);
    return;
  }

  if (Array.isArray(v)) {
    out.push('[');
    for (const e of v) into(out, e);
    out.push(']');
    return;
  }

  if (v instanceof Map) {
    out.push('{');

    for (const k of [...v.keys()].sort()) {
      into(out, k);
      into(out, v.get(k));
    }

    out.push('}');
    return;
  }

  out.push('{');

  for (const k of Object.keys(v).sort()) {
    out.push(k);
    into(out, (v as Record<string, unknown>)[k]);
  }

  out.push('}');
}

/** One polygon over the span, as the cut sees it: the fields `at1` builds an
 * instant out of, what it rides, and the scopes that ride over that. */
function movement(out: unknown[], m: Moving, cast: Cast): void {
  into(out, m.at.id);
  into(out, m.at.polygon);
  into(out, m.corners);
  into(out, m.local);
  into(out, m.dead);
  into(out, m.depth);
  into(out, m.varying ? m.depths : null);
  into(out, m.effected);
  into(out, m.frame);
  into(out, m.ops);

  for (const h of m.holders) {
    into(out, h.id);
    into(out, h.frame);
    into(out, h.ops);

    // The group itself as well as its flight: whether it is sealed decides
    // whether it stands for its members at all, and who its members are decides
    // what its boundary is. Neither is written on the polygon.
    into(out, cast.world.groups.get(h.id) ?? null);
    into(out, cast.scopes.get(h.id) ?? null);
    into(out, cast.shapes.get(h.id) ?? null);

    const rider = cast.riders.get(h.id);

    if (rider !== undefined) {
      into(out, rider.frame);
      into(out, rider.ops);
      into(out, rider.holders.map(o => o.id));
    }
  }
}

/**
 * What the track at `i` would be cut from, hashed.
 *
 * Sixty-four bits, as two passes over the same text: a track wrongly kept is a
 * silently wrong bake, so the collision this must not have is worth the second
 * multiply. Over a thousand tracks the odds of one are about one in
 * thirty-seven million million.
 */
export function signed(at: Ready, i: number, tol: number, gap: number): string {
  const s = at.items[i];
  const out: unknown[] = [s.id, s.set, s.fill, s.slot, tol, gap];
  const near = at.near[i];

  // Its own first, in the order the cut is handed them, and the rest by id:
  // `neighbourhoods` takes the others off a sweep whose order an unrelated
  // polygon can change, and a track is not cut differently for it.
  const mine = new Set(s.mine.map(m => m.at.id));

  for (const m of near.filter(m => mine.has(m.at.id))) movement(out, m, at.cast);

  for (const m of near.filter(m => !mine.has(m.at.id)).sort((p, q) => p.at.id - q.at.id)) {
    movement(out, m, at.cast);
  }

  return hashed(out);
}

/** FNV-1a twice over, from two offsets, as sixteen hex digits. */
function hashed(parts: readonly unknown[]): string {
  const text = parts.join('\u0001');

  let a = 0x811c9dc5, b = 0x01000193;

  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);

    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x85ebca6b);
  }

  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/** Every track of a span, hashed, in the order `ready` put its items in. */
export function signatures(at: Ready, tol: number = TOLERANCE, gap: number = GAP): string[] {
  return at.items.map((_unused, i) => signed(at, i, tol, gap));
}

export function* cutSome(
  at: Ready,
  which: readonly number[],
  tol: number = TOLERANCE,
  gap: number = GAP,
): Generator<number, Slice, void> {
  const began = now();
  const tracks: Track[] = [];

  let evaluations = 0;

  for (let k = 0; k < which.length; k++) {
    const i = which[k];
    const { id, fill, slot } = at.items[i];

    // A floor is not cut against anything — see `fillTrack`, and the header
    // above it. Everything else is its share of a boundary and is measured
    // against the CSG.
    const cut = yield* weighted(
      chased(at, i, fill, tol, gap),
      k / which.length,
      1 / which.length,
    );

    tracks.push({
      id,
      fill,
      hole: fill && slot !== 0,
      stretches: cut.stretches,
      jumps: cut.jumps,
      worst: cut.worst,
      gap: cut.limits.gap,
      sig: signed(at, i, tol, gap),
    });

    evaluations += cut.evaluations;
  }

  return { tracks, evaluations, setup: 0, cut: now() - began };
}

function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

/** Part of a span: every polygon whose place in the list falls to `index` when
 * the list is dealt out `of` ways. The serial path's slicing, and the bench's. */
export function* bakeSlice(
  world: World,
  from: number,
  index: number,
  of: number,
  tol: number = TOLERANCE,
  gap: number = GAP,
): Generator<number, Slice, void> {
  const at = ready(world, from);
  const which: number[] = [];

  for (let i = index; i < at.items.length; i += of) which.push(i);

  const slice = yield* cutSome(at, which, tol, gap);

  return { ...slice, setup: at.setup };
}

/** Every slice put back together, in the order `sample` reads them. */
export function joined(
  world: World,
  from: number,
  riders: Map<Id, Rider>,
  slices: readonly Slice[],
  tol: number = TOLERANCE,
  kept: readonly Track[] = [],
): Span {
  const tracks = [...slices.flatMap(s => s.tracks), ...kept].sort((p, q) => p.id - q.id);

  return {
    from,
    tracks,
    riders,
    // Read off the tracks rather than added up as the slices came in, so that
    // it says the same thing however the span was put together.
    worst: Math.max(0, ...tracks.map(t => t.worst)),
    strained: tracks
      .filter(t => t.worst > tol)
      .map(t => ({ id: t.id, worst: t.worst, gap: t.gap })),
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
 *
 * `was` is the span as it was baked before whatever the author has just done,
 * and every track of it whose signature still stands is kept rather than cut
 * again. Nothing about the result says which: a kept track is the track the
 * cut would have produced, which is what `signed` is for and what the tests
 * hold it to. Left out, the span is cut from nothing, which is what a first
 * bake is.
 */
export function* bakeSpan(
  world: World,
  from: number,
  tol: number = TOLERANCE,
  gap: number = GAP,
  was: Span | null = null,
): Generator<number, Span, void> {
  const at = ready(world, from);
  const held = new Map((was?.tracks ?? []).map(t => [t.sig, t]));
  const which: number[] = [];
  const kept: Track[] = [];

  at.items.forEach((_unused, i) => {
    // By signature alone, which names the polygon it is about: two tracks
    // cannot share one without being the same track of the same span.
    const track = held.get(signed(at, i, tol, gap));

    if (track === undefined) which.push(i);
    else kept.push(track);
  });

  const slice = yield* cutSome(at, which, tol, gap);

  return joined(world, from, ridersFrom(at, world), [{ ...slice, setup: at.setup }], tol, kept);
}

/** Every span in the chain, one after the other. */
export function* bakeAll(
  world: World,
  tol: number = TOLERANCE,
  gap: number = GAP,
  was: Bake = EMPTY_BAKE,
): Generator<number, Map<number, Span>, void> {
  const out = new Map<number, Span>();
  const count = world.keyframes.length - 1;

  for (let k = 0; k < count; k++) {
    const span = yield* weighted(
      bakeSpan(world, k, tol, gap, reusable(was, world, k)),
      k / count,
      1 / count,
    );

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
  // the same chain, and playing it is a handful of trig calls a link.
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

    // In range of both, rather than wrapped into it. A ring that is not the
    // length the origin was named against is not this ring any more, and a
    // silently wrapped index reads a different edge with no sign that it did —
    // which is what `numbered` is there to keep from ever reaching here.
    const p = a[r.index], q = b[r.index];

    if (p === undefined || q === undefined || a.length !== b.length) return null;

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

/**
 * Every artefact part way through a walk, in the frame the keyframes put it in.
 *
 * Here rather than beside `artefactsAt` because it is `replayed`'s question,
 * and it has to be answered `replayed`'s way: one leg per keyframe crossed, so
 * the walk is over keyframes rather than over distance and a key does not
 * arrive in a room ahead of the room — and each leg rides exactly what the
 * span's frame table says it rides. See `carried`.
 */
export function artefactsDuring(
  world: World,
  from: KeyframeId,
  to: KeyframeId,
  u: number,
): Placed[] {
  const a0 = order(world, from), b0 = order(world, to);
  const n = Math.abs(b0 - a0);

  if (n === 0) return artefactsAt(world, to);

  const x = Math.min(Math.max(u, 0), 1) * n;
  const i = Math.min(Math.floor(x), n - 1);
  const step = b0 > a0 ? 1 : -1;
  const rest = x - i;

  const a = a0 + step * i, b = a + step;

  // The earlier of the two is the span; going backwards reads it the other
  // way, which is the same easing from the other end.
  const riders = carried(world, Math.min(a, b));
  const t = step > 0 ? rest : 1 - rest;

  const out: Placed[] = [];

  for (const [id, it] of world.artefacts) {
    const r = riders.get(id);

    if (r === undefined) continue;

    const m = riding(r, t);

    out.push({ id, type: it.type, at: place(m, [it.at])[0], facing: facing(m) });
  }

  return out.sort((p, q) => p.id - q.id);
}

export function replayed(
  bake: Bake,
  world: World,
  from: KeyframeId,
  to: KeyframeId,
  u: number,
): Frame | null {
  const a = order(world, from), b = order(world, to);
  const n = Math.abs(b - a);
  if (n === 0) return null;

  const x = Math.min(Math.max(u, 0), 1) * n;
  const i = Math.min(Math.floor(x), n - 1);
  const rest = x - i;

  const forward = b > a;
  const span = spanAt(bake, world, forward ? a + i : a - 1 - i);

  return span === null ? null : sample(span, forward ? rest : 1 - rest);
}
