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
// Where a stretch ends
// --------------------
// The shader can work out *where* a vertex goes. It cannot work out *whether it
// exists*, or what order a ring visits its vertices in, and it cannot follow a
// path that bends. So a stretch has to end wherever any of those gives out, and
// there are two ways to know:
//
// - **Known outright, from the layer chain.** Both ends of the span, always: a
//   version boundary is a keyframe because the interpolation's derivative
//   changes there, and because a polygon born in `k + 1` appears exactly there
//   and nowhere inside. Those cost nothing.
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
import { Member, Ring, Shape, boundaryRuns, ground, simplify } from './geometry';
import {
  Affine,
  EMPTY_LIVE,
  Resolved,
  affine,
  compose,
  live,
  place,
  project,
  unplace,
  resolveAt,
} from './scene';
import {
  EMPTY_TRANSFORM,
  PolygonId,
  Transform,
  VersionId,
  World,
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
}

/** The set at one instant, ordered so that two evaluations can be compared and
 * interpolated run by run. */
export type Frame = Run[];

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

/** What takes a polygon's runs back out to the world, in the form that can be
 * interpolated: a constant chain, and the one layer in flight over it. */
export interface Rider {
  base: Affine
  layer: Transform
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
  /** The polygon's own eroded shape at both ends, and its neighbours', in the
   * frame each one's runs are kept in. The four endpoints a crossing is solved
   * from live in here — and a crossing is with a neighbour, which is why they
   * are here at all. */
  table: Map<PolygonId, { a: Shape, b: Shape }>
  /**
   * Where each run point comes from, run by run and point by point, or null
   * where the two ends could not be made to agree about it. A `cross` is
   * re-solved at every instant rather than interpolated; everything else is a
   * vertex of its own polygon and interpolates exactly.
   */
  origins: (Origin | null)[][]
}

/** One polygon's own cut of the span, in order and covering all of it. */
export interface Track {
  id: PolygonId
  stretches: Stretch[]
}

/** Everything between two adjacent versions. */
export interface Span {
  from: VersionId
  /** One per polygon, ordered by id — which is also the order `sample` puts
   * their runs back in. */
  tracks: Track[]
  /** Per polygon, what its runs ride. Constant across the span: only the
   * easing of `layer` varies, and that is a function of `t` alone. */
  riders: Map<PolygonId, Rider>
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
  /** What the world looked like when this was baked. */
  stamp: Stamp
}

/**
 * A span's geometry depends on its own two versions and on every version above
 * them, since that is what `resolveAt` walks. So the stamp is the whole chain
 * down to `k + 1`, plus the polygons themselves.
 *
 * It is the `edits` maps rather than the `Version` objects, so that opening and
 * closing a ghost's eye — which replaces the version but changes no
 * geometry — does not throw away a bake.
 */
export interface Stamp {
  edits: unknown[]
  polygons: unknown
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
  };
}

/** The span, if what it was baked against is still standing. */
export function spanAt(bake: Bake, world: World, from: VersionId): Span | null {
  const span = bake.spans.get(from);
  if (span === undefined) return null;

  const now = stamp(world, from);

  if (span.stamp.polygons !== now.polygons) return null;
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
 * A polygon born into `k + 1` has no `t` inside the span at which it exists —
 * it appears at the boundary, which is a keyframe already — so it is `newborn`
 * and shows up only at `t === 1`.
 */
interface Moving {
  at: Resolved
  base: Affine
  layer: Transform
  local: [Ring, Ring]
  depth: [number, number]
  newborn: boolean
}

function moving(world: World, from: VersionId): Moving[] {
  const before = new Map(resolveAt(world, from).map(it => [it.id, it]));
  const after = resolveAt(world, from + 1);

  return after.map(it => {
    const was = before.get(it.id);
    const edit = world.versions[from + 1].edits.get(it.id);
    const layer = edit?.transform ?? EMPTY_TRANSFORM;

    if (was === undefined) {
      return {
        at: it,
        base: it.frame,
        layer: EMPTY_TRANSFORM,
        local: [it.local, it.local] as [Ring, Ring],
        depth: [it.erosion, it.erosion] as [number, number],
        newborn: true,
      };
    }

    return {
      at: it,
      base: was.frame,
      layer,
      local: [was.local, it.local] as [Ring, Ring],
      depth: [was.erosion, it.erosion] as [number, number],
      newborn: false,
    };
  });
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
function pivot(layer: Transform): Point | null {
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

/** The world at one instant inside the span, resolved. */
function world1(items: Moving[], t: number): Resolved[] {
  const out: Resolved[] = [];

  for (const m of items) {
    if (m.newborn && t < 1) continue;

    if (m.newborn) {
      out.push(m.at);
      continue;
    }

    const local = between(m.local[0], m.local[1], t);
    const frame = compose(affine(easing(m.layer, t)), m.base);
    const source = place(frame, local);
    const erosion = mix(m.depth[0], m.depth[1], t);

    out.push({
      ...m.at,
      local,
      frame,
      source,
      shape: project(source, erosion),
      erosion,
    });
  }

  return out;
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
  return evaluate(moving(world, from), t, null).out;
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
  /** Each polygon's eroded shape, in the same frame the runs are kept in: the
   * table the crossings are solved from. */
  table: Map<PolygonId, Shape>
  /** The same, left in world units, which is where a point is classified. */
  world: Map<PolygonId, Shape>
  /** The runs before they were taken back to their frames, for the same
   * reason: an edge of another polygon is only nearby in the world. */
  out: Frame
}

/** A polygon as the boundary wants to see it: simplified, unless it came out of
 * an erosion and is an arrangement already. The same reasoning `worldset` uses,
 * and it has to be the same or the two would not agree. */
function memberOf(it: Resolved): Member | null {
  const kind = it.polygon.type;

  if (kind !== 'level' && kind !== 'solid') return null;

  const shape = it.erosion === 0 ? simplify(it.shape) : it.shape;

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
function share(at: Resolved[], only: PolygonId): Frame {
  const members: Member[] = [];
  let subject: Member | null = null;

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
    .map(points => ({ id: only, points }));
}

/** Everybody's share at once, through the full set. The yardstick's path, and
 * what the editor's own drawing goes through. */
function everything(at: Resolved[]): Frame {
  // Sorted, so that two evaluations line up run by run. `worldset` hands its
  // runs back in whatever order the entries happen to sit in, which an edit
  // reorders; within one polygon the order is the boundary's own and is stable
  // for as long as the combinatorics are — which is exactly a stretch.
  return pieces(live(EMPTY_LIVE, at).set)
    .map(p => ({ id: p.source, points: p.points }))
    .sort((p, q) => p.id - q.id);
}

function evaluate(items: Moving[], t: number, only: PolygonId | null): Taken {
  const at = world1(items, t);

  const frames = new Map(at.map(it => [it.id, it.frame]));
  const table = new Map<PolygonId, Shape>();
  const world = new Map<PolygonId, Shape>();

  for (const it of at) {
    world.set(it.id, it.shape);
    table.set(it.id, it.shape.map(ring => ring.map(q => unplace(it.frame, q))));
  }

  const out = only === null ? everything(at) : share(at, only);

  const frame = out.map(r => ({
    id: r.id,
    points: r.points.map(q => unplace(frames.get(r.id)!, q)),
  }));

  return { frame, table, world, out, t };
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
  if (m.newborn) return ofRings([m.at.source]);

  let all: AABB | null = null;
  let step = 0;
  let was: Ring | null = null;

  for (let k = 0; k <= PROBES; k++) {
    const t = k / PROBES;
    const now = place(compose(affine(easing(m.layer, t)), m.base), between(m.local[0], m.local[1], t));
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

/** For each polygon, the ones it shares a span with — itself first, so a track
 * always has its own subject. */
function neighbourhoods(items: Moving[]): Moving[][] {
  const boxes = items.map(reach);
  const tree: Tree = build(boxes.map((box, id) => ({ id, box })));

  return items.map((m, i) => {
    const near = search(tree, boxes[i]).filter(j => j !== i);

    return [m, ...near.map(j => items[j])];
  });
}

/**
 * What has to hold for the shader to interpolate: the same polygons owning the
 * same number of runs, each of the same length. Positions are free to move —
 * that is what interpolation is for — and everything discrete is in here.
 */
function signature(frame: Frame): string {
  return frame.map(r => `${r.id}.${r.points.length}`).join(' ');
}

// -----------------------------------------------------------------------------
// Where a point came from
//
// The CSG hands back positions, and a position is not enough: a crossing has to
// be recomputed at every instant from the two edges that make it, or it slides
// wrongly whenever one polygon turns relative to another. What is missing is
// provenance, and rather than thread tags out through `geometry.ts` and
// `worldset.ts` — which would have to survive the ring being re-indexed by
// every erosion — it is read back off the geometry here, where it is wanted and
// where the cost of looking does not matter.
//
// The reading is unambiguous. A run point is either one of its own polygon's
// eroded corners, or it lies on one of that polygon's edges and on an edge of
// exactly one other polygon. Ties are impossible in anything but degenerate
// geometry, and a degenerate instant is an event, so the stretch does not
// contain one.
//
// It is done at both ends and kept only where the two agree, which is a real
// check rather than a formality: the stretch is *supposed* to hold the
// arrangement constant, so a point that comes from different edges at the two
// ends is a stretch that should have been split.
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

function table(
  a: Map<PolygonId, Shape>,
  b: Map<PolygonId, Shape>,
): Map<PolygonId, { a: Shape, b: Shape }> {
  const out = new Map<PolygonId, { a: Shape, b: Shape }>();

  for (const [id, shape] of a) {
    const other = b.get(id);
    if (other !== undefined) out.set(id, { a: shape, b: other });
  }

  return out;
}

function agreed(a: Taken, b: Taken): (Origin | null)[][] {
  const one = origins(a);
  const two = origins(b);

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

/** Every run point read back against the shapes it came out of. */
function origins(taken: Taken): (Origin | null)[][] {
  const snap = near(taken.world);

  return taken.out.map(run => run.points.map(p => {
    const world = taken.world.get(run.id);
    if (world === undefined) return null;

    const mine = corner(world, p, snap);
    if (mine !== null) return { kind: 'vertex', at: { id: run.id, ...mine } };

    const on = lying(world, p, snap);
    if (on === null) return null;

    let found: Ref | null = null;

    for (const [id, shape] of taken.world) {
      if (id === run.id) continue;

      const hit = lying(shape, p, snap);

      // Two answers is no answer: a point on two other polygons at once is a
      // degeneracy, and a degeneracy is an event this stretch is not supposed
      // to contain.
      if (hit !== null) {
        if (found !== null) return null;

        found = { id, ...hit };
      }
    }

    return found === null
      ? null
      : { kind: 'cross', a: { id: run.id, ...on }, b: found };
  }));
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

/** Which edge of the shape this sits on, if it sits on one. */
function lying(shape: Shape, p: Point, snap: number): { ring: number, index: number } | null {
  for (let r = 0; r < shape.length; r++) {
    const ring = shape[r];

    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const dx = b.x - a.x, dy = b.y - a.y;
      const l = Math.hypot(dx, dy);

      if (l === 0) continue;

      const side = ((p.x - a.x) * dy - (p.y - a.y) * dx) / l;
      if (Math.abs(side) > snap) continue;

      const along = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l;
      if (along < -snap || along > l + snap) continue;

      return { ring: r, index: i };
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
 * Narrower than this and an interval the two sides will not agree on is a
 * discontinuity rather than a stretch to keep splitting.
 *
 * It is a width in `t`, and the pop it leaves is that width times how fast the
 * geometry is moving — for a span crossing a couple of hundred world units,
 * a few thousandths of a unit.
 */
const GAP = 1e-4;

const MARGIN = 0.5;

/** Two evaluations that could be the ends of one stretch, or could not. */
function comparable(a: Taken, b: Taken): boolean {
  return signature(a.frame) === signature(b.frame);
}

/**
 * The furthest any point of the interpolated stretch sits from the point the
 * CSG puts there. Infinite when the two do not even agree on what points there
 * are, which is a disagreement no distance describes.
 */
function apart(guess: Frame, actual: Frame): number {
  if (guess.length !== actual.length) return Infinity;

  let worst = 0;

  for (let r = 0; r < guess.length; r++) {
    const p = guess[r], q = actual[r];

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

function stretchOf(a: Taken, b: Taken): Stretch {
  return {
    t0: a.t,
    t1: b.t,
    a: a.frame,
    b: b.frame,
    table: table(a.table, b.table),
    origins: agreed(a, b),
  };
}

/** A stretch of no width, carrying one instant exactly. Either side of a gap
 * needs one, so that the geometry at the discontinuity itself is not lost. */
function instant(a: Taken): Stretch {
  return stretchOf(a, a);
}

interface Cut {
  stretches: Stretch[]
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
  sub: Moving[],
  id: PolygonId,
  riders: Map<PolygonId, Rider>,
  tol: number,
): Generator<number, Cut, void> {
  const out: Stretch[] = [];

  let evaluations = 0;
  let worst = 0;

  const at = (t: number): Taken => {
    evaluations++;

    return evaluate(sub, t, id);
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

    if (narrow) {
      keep(s);
      continue;
    }

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

    if (off > tol * MARGIN) {
      stack.push([m, b], [a, m]);
      continue;
    }

    worst = Math.max(worst, off);
    keep(s);

    done = b.t;
    yield done;
  }

  return { stretches: out, worst, evaluations };

  function keep(s: Stretch): void {
    const last = out[out.length - 1];

    // Two instants running together, or a stretch that adds nothing.
    if (last !== undefined && last.t0 === last.t1 && last.t0 === s.t0 && s.t0 === s.t1) {
      return;
    }

    out.push(s);
  }
}

// -----------------------------------------------------------------------------
// Baking
// -----------------------------------------------------------------------------

/**
 * One span, as a generator so that the editor can run it a slice at a time and
 * keep drawing. It yields how far along it is, between 0 and 1.
 *
 * Every polygon is cut on its own, against the polygons it can reach. Each one
 * gets an equal slice of the progress; how long one takes depends on how much
 * is happening around it, so the bar is honest about where the work is rather
 * than about how long it will take.
 */
export function* bakeSpan(
  world: World,
  from: VersionId,
  tol: number = TOLERANCE,
): Generator<number, Span, void> {
  const items = moving(world, from);

  const riders = new Map<PolygonId, Rider>(
    items.map(m => [m.at.id, { base: m.base, layer: m.newborn ? EMPTY_TRANSFORM : m.layer }]),
  );

  const near = neighbourhoods(items);
  const tracks: Track[] = [];

  let worst = 0;
  let evaluations = 0;

  for (let i = 0; i < items.length; i++) {
    const id = items[i].at.id;
    const cut = yield* weighted(
      cutTrack(near[i], id, riders, tol),
      i / items.length,
      1 / items.length,
    );

    tracks.push({ id, stretches: cut.stretches });

    worst = Math.max(worst, cut.worst);
    evaluations += cut.evaluations;
  }

  tracks.sort((p, q) => p.id - q.id);

  return { from, tracks, riders, worst, evaluations, stamp: stamp(world, from) };
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
function drawn(s: Stretch, riders: Map<PolygonId, Rider>, t: number): Frame {
  const u = s.t1 === s.t0 ? 0 : (t - s.t0) / (s.t1 - s.t0);

  // One per polygon rather than one per point: every vertex of a polygon rides
  // the same layer, and rebuilding it is four trig calls.
  const frames = new Map<PolygonId, Affine>();

  const frameOf = (id: PolygonId): Affine => {
    const known = frames.get(id);
    if (known !== undefined) return known;

    const rider = riders.get(id)!;
    const made = compose(affine(easing(rider.layer, t)), rider.base);

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
function stretchAt(track: Track, t: number): Stretch | null {
  const all = track.stretches;
  if (all.length === 0) return null;

  let lo = 0, hi = all.length - 1;

  while (lo < hi) {
    const mid = (lo + hi) >> 1;

    if (all[mid].t1 < t) {
      lo = mid + 1;
    }
    else {
      hi = mid;
    }
  }

  // `lo` is the first stretch ending at or after `t`. Either it holds `t`, or
  // `t` is in the gap before it and the stretch behind is just as close.
  const here = all[lo];
  if (t >= here.t0) return here;

  const back = all[lo - 1];
  if (back === undefined) return here;

  return t - back.t1 <= here.t0 - t ? back : here;
}

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
