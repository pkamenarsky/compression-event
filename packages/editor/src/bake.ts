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
//   frame(t)  = lerp(I, T_{k+1}, t) o A_k        (translation, rotation, scale)
//   local(t)  = lerp(local_k, local_{k+1}, t)    (vertex nudges)
//   depth(t)  = lerp(d_k, d_{k+1}, t)
//   shape(t)  = erode(frame(t)(local(t)), depth(t))
//
// which is exactly `resolveAt(k)` at t = 0 and `resolveAt(k + 1)` at t = 1. A
// polygon that turns therefore turns through the morph rather than collapsing
// through its own centre, which is the whole reason a version keeps its
// transform in components instead of as a matrix.
//
// `A_k` is a general affine and is constant across the span, so nothing here
// interpolates an accumulated chain — the property the composed frame in
// `scene.ts` was allowed to give up.
//
// When a keyframe is needed
// -------------------------
// The shader can work out *where* a vertex goes. It cannot work out *whether it
// exists*, or what order a ring visits its vertices in. Those are the only
// things that need cutting, and there are two ways to know about them:
//
// - **Known outright, from the layer chain.** Both ends of the span, always: a
//   version boundary is a keyframe because the interpolation's derivative
//   changes there, and because a polygon born in `k + 1` appears exactly there
//   and nowhere inside. Those cost nothing to find.
//
// - **Found, because the geometry decided.** A corner passing through an edge,
//   two rooms joining, a room pinching in two, an eroded ring losing a corner.
//   Every one of them shows up as a change in the CSG's combinatorics.
//
// The second kind is found in `events.ts`, over the corners of the offset ring
// rather than over the source: the offset is what the CSG combines, and a
// corner of it travels along its mitre at one unit per unit of depth. Every
// edge is asked about every corner that is not one of its own ends, within a
// polygon as well as across a pair, which is one rule covering all of them —
// see *Cutting the span* below.
//
// The search is over intervals, not samples, so a pair of events sharing a
// sample interval and a corner that grazes an edge without going through are
// both found rather than missed. Where nothing turns and nothing squashes it
// does not search at all: `p(t)` is a straight line, `f` is a quadratic, and
// the roots come in closed form. Pure erosion is entirely inside that case.
//
// Why the set is incremental
// --------------------------
// A span is evaluated at both ends of every stretch and most polygons are not
// moving in it — a version edits a few things and leaves the rest alone. So
// each evaluation goes through `live`, which diffs the resolved shapes against
// the last evaluation and hands `worldset` only what actually moved. The full
// CSG is paid once per span, at the first evaluation; everything after it costs
// the polygons that moved and their overlappers. A polygon untouched by the
// version in flight is never re-CSG'd at all, however many stretches the span
// turns out to have.
// -----------------------------------------------------------------------------

import { Point } from '@ce/game/world';
import * as aabb from './aabb';
import { AABB } from './aabb';
import {
  Frame as Layer,
  Moving as Corner,
  Search,
  collinear,
  edgesMeet,
  events,
  swept,
} from './events';
import { Ring, Shape, bisectors } from './geometry';
import {
  Affine,
  EMPTY_LIVE,
  Live,
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
 * A stretch of `t` across which nothing discrete happens, and the geometry at
 * both ends of it. This is the unit the game would be handed: everything
 * between `a` and `b` is a lerp.
 */
export interface Stretch {
  t0: number
  t1: number
  a: Frame
  b: Frame
  /** Every polygon's eroded shape at both ends, in the frame its runs are kept
   * in. The four endpoints a crossing is solved from live in here. */
  table: Map<PolygonId, { a: Shape, b: Shape }>
  /**
   * Where each run point comes from, run by run and point by point, or null
   * where the two ends could not be made to agree about it. A `cross` is
   * re-solved at every instant rather than interpolated; everything else is a
   * vertex of its own polygon and interpolates exactly.
   */
  origins: (Origin | null)[][]
  /**
   * The two ends disagree about the arrangement, so there is an event inside
   * that the search did not find. Nothing can be interpolated across it and the
   * replay snaps instead — which is the tear this whole search exists to
   * prevent, made visible rather than papered over.
   */
  torn: boolean
}

/** Everything between two adjacent versions. */
export interface Span {
  from: VersionId
  stretches: Stretch[]
  /** Per polygon, what its runs ride. Constant across the span: only the
   * easing of `layer` varies, and that is a function of `t` alone. */
  riders: Map<PolygonId, Rider>
  /** How many times the CSG was evaluated to find them. */
  samples: number
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
  /** The version in flight does nothing to it, so it is the same shape at every
   * `t` and the set never has to hear about it again. */
  still: boolean
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
        still: false,
      };
    }

    return {
      at: it,
      base: was.frame,
      layer,
      local: [was.local, it.local] as [Ring, Ring],
      depth: [was.erosion, it.erosion] as [number, number],
      newborn: false,
      // The version in flight says nothing about it, so by construction its
      // local ring, its frame and its depth are all its base's. There is
      // nothing to compare: the absence of a layer is the whole test.
      still: edit === undefined,
    };
  });
}

function mix(u: number, v: number, t: number): number {
  return u + (v - u) * t;
}

/** The layer eased on, in components. Identity at 0, itself at 1. */
function easing(layer: Transform, t: number): Transform {
  return {
    translation: {
      x: layer.translation.x * t,
      y: layer.translation.y * t,
    },
    rotation: layer.rotation * t,
    scale: {
      x: mix(1, layer.scale.x, t),
      y: mix(1, layer.scale.y, t),
    },
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

/** The world at one instant inside the span, in the form `live` wants. */
function world1(items: Moving[], t: number): Resolved[] {
  const out: Resolved[] = [];

  for (const m of items) {
    if (m.newborn && t < 1) continue;

    if (m.still || m.newborn) {
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
  const items = world1(moving(world, from), t);

  return pieces(live(EMPTY_LIVE, items).set)
    .map(p => ({ id: p.source, points: p.points }))
    .sort((p, q) => p.id - q.id);
}

// -----------------------------------------------------------------------------
// Evaluating
// -----------------------------------------------------------------------------

/**
 * The CSG at one `t`, through the incremental set.
 *
 * `held` is carried from the last evaluation whatever `t` was, and that is the
 * point: the diff is per polygon, not per instant, so a polygon the version
 * does not touch stays out of the CSG for the whole span however far the search
 * jumps around.
 */
interface Taken {
  held: Live
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

function evaluate(held: Live, items: Moving[], t: number): Taken {
  const at = world1(items, t);
  const next = live(held, at);

  const frames = new Map(at.map(it => [it.id, it.frame]));
  const table = new Map<PolygonId, Shape>();
  const world = new Map<PolygonId, Shape>();

  for (const it of at) {
    world.set(it.id, it.shape);
    table.set(it.id, it.shape.map(ring => ring.map(q => unplace(it.frame, q))));
  }

  // Sorted, so that two evaluations line up run by run. `worldset` hands its
  // runs back in whatever order the entries happen to sit in, which an edit
  // reorders; within one polygon the order is the boundary's own and is stable
  // for as long as the combinatorics are — which is exactly a stretch.
  const out = pieces(next.set)
    .map(p => ({ id: p.source, points: p.points }))
    .sort((p, q) => p.id - q.id);

  const frame = out.map(r => ({
    id: r.id,
    points: r.points.map(q => unplace(frames.get(r.id)!, q)),
  }));

  return { held: next, frame, table, world, out };
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
// ends is the search having missed something.
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
// A crossing appears or dies exactly when a vertex reaches the line through an
// edge, so the quantity to watch is a signed area and an event is where it
// vanishes. `events.ts` does that part; everything here is about handing it the
// right vertices.
//
// The vertices are the *offset* ring's, not the source's: those are what the
// CSG combines, and a corner of the offset ring travels along its mitre at a
// rate of one per unit of depth. So a corner is `local + depth * bisector`,
// which is the form `Moving` is written in, and `bisectors` in `geometry.ts`
// supplies the direction.
//
// Which questions get asked
// -------------------------
// Every edge against every vertex that is not one of its own two ends, within
// a polygon as well as across a pair of them. That one rule covers all four
// kinds of event at once:
//
// - a corner passing through another polygon's edge — the crossing appears
// - an edge of the offset ring collapsing — its two ends meet, so the end lands
//   on the line through its neighbour's edge
// - the offset folding through itself — a corner reaches an edge of its own
//   polygon
//
// Asking within a polygon is why the adjacent vertex is included rather than
// skipped as degenerate: a collapse *is* the adjacent vertex arriving.
//
// And then every triple of edges from three different polygons, for the events
// that are not about vertices at all. Where three boundaries pass through one
// point, two crossings arrive at the same place and the runs either side of
// them join or come apart — a room connecting to a room, or a wall pinching in
// two, seen at the moment it happens. Nothing is at an endpoint there, so no
// signed area over three vertices vanishes and `collinear` is blind to it. That
// is `edgesMeet`, and leaving it out is worth about four per cent: measured on
// six overlapping boxes eroding at different rates it left the whole span in
// one torn stretch, missing both of the two events it had.
//
// Triples are cubic in edges, so the pruning matters more here than anywhere
// else. Each edge carries its own swept box rather than its polygon's, and a
// triple is only asked about when all three boxes meet each other. In a level,
// where most things are nowhere near most other things, almost nothing gets
// past that.
//
// What is not searched for, because it is known: both ends of the span. The
// interpolation's derivative breaks at a version boundary and a polygon born
// into the later version appears there, and neither is something the geometry
// has to be asked about.
//
// Why this replaces a scan
// ------------------------
// The first version of this bisected on the arrangement's *signature* — how
// many runs each polygon owned and how long each was. It is blind to exactly
// the case the doc singles out. A pillar turning inside a wall always cuts two
// crossings; as it turns, each corner sweeping through hands a crossing from
// one edge to the next. The counts never change, so the scan sees nothing and
// the whole turn comes out as one stretch, interpolated straight through every
// handoff. Measured against the truth it ran ten per cent wrong across the
// middle of the span. `f` has no such blind spot: it is about *which* edge, not
// how many.
// -----------------------------------------------------------------------------

/** How wide a bracket to leave around a root. The two sides of a keyframe
 * disagree, so nothing is evaluated at the event itself — only just outside it,
 * and this is how far. */
const BRACKET = 1e-6;

/** Roots closer together than this are one event seen twice: symmetric geometry
 * puts several at the same instant, and one keyframe absorbs them all. */
const TOGETHER = 4 * BRACKET;

interface Cut {
  /** The last `t` on the near side, and the first on the far side. */
  lo: number
  hi: number
}

/** One polygon's offset corners, in the form the search wants. */
function corners(m: Moving): Corner[] {
  const layer: [Layer, Layer] = [
    { translation: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    {
      translation: m.layer.translation,
      rotation: m.layer.rotation,
      scale: m.layer.scale,
    },
  ];

  // The chain below the version in flight is constant across the span, so it
  // is folded in here rather than carried: `local` is what the layer applies
  // to, which is the source ring already put in place by everything before it.
  const a = place(m.base, m.local[0]);
  const b = place(m.base, m.local[1]);

  const bis = bisectors(a);

  return a.map((p, i) => ({
    local: [p, b[i] ?? p] as [Point, Point],
    bisector: bis[i],
    erosion: m.depth,
    frames: layer,
  }));
}

/**
 * Every moment the arrangement can change, bracketed and in order.
 *
 * The broad phase is the boxes the same interval arithmetic produces for the
 * whole span: a box that holds everywhere a polygon's corners go is sound by
 * construction, so a pair whose boxes miss each other has been *proved* to have
 * no event between them, on the same footing as an interval the search throws
 * away. A polygon is still asked about itself, whatever its box overlaps.
 */
function* cuts(items: Moving[], search: Search): Generator<number, Cut[], void> {
  const live = items.filter(m => !m.newborn);
  const sets = live.map(corners);

  const boxes = sets.map((cs, i) => ({ id: i, box: swept(cs) }));
  const edges = sets.map(edgesOf);
  const tree = aabb.build(boxes);

  const roots: number[] = [];

  for (let i = 0; i < sets.length; i++) {
    // Itself, and every polygon it might reach — each unordered pair once, but
    // asked both ways round, because an edge of one against a corner of the
    // other is a different question from the reverse.
    const near = aabb.search(tree, boxes[i].box).filter(j => j >= i);

    for (const j of near) {
      ask(sets[i], sets[j], roots, search);

      if (j !== i) ask(sets[j], sets[i], roots, search);
    }

    // Three at a time, this one lowest, so each triple is asked about once.
    for (const j of near) {
      if (j <= i) continue;

      for (const k of near) {
        if (k <= j || !aabb.overlaps(boxes[j].box, boxes[k].box)) continue;

        meeting(edges[i], edges[j], edges[k], roots, search);
      }
    }

    yield (i + 1) / Math.max(1, sets.length);
  }

  return bracketed(roots);
}

/** One edge, and the box holding everywhere it goes over the span. */
interface Edge {
  ends: readonly [Corner, Corner]
  box: AABB
}

function edgesOf(cs: Corner[]): Edge[] {
  if (cs.length < 2) return [];

  return cs.map((c, i) => {
    const ends = [c, cs[(i + 1) % cs.length]] as const;

    return { ends, box: swept(ends) };
  });
}

/**
 * Every moment three boundaries pass through one point.
 *
 * `flat` scales as the cube of the world units in play, because the determinant
 * is one: without it, two polygons sharing a stretch of edge make the
 * determinant vanish for the whole span, and the search subdivides for ever
 * looking for the instant it does.
 */
function meeting(
  one: Edge[],
  two: Edge[],
  three: Edge[],
  out: number[],
  search: Search,
): void {
  for (const a of one) {
    for (const b of two) {
      if (!aabb.overlaps(a.box, b.box)) continue;

      for (const c of three) {
        if (!aabb.overlaps(a.box, c.box) || !aabb.overlaps(b.box, c.box)) continue;

        const scale = span(a.box, b.box, c.box);

        out.push(...events(edgesMeet(a.ends, b.ends, c.ends), {
          ...search,
          flat: search.flat ?? scale * scale * scale * 1e-12,
        }).at);
      }
    }
  }
}

function span(...boxes: AABB[]): number {
  let out = 1;

  for (const b of boxes) {
    out = Math.max(out, b.maxX - b.minX, b.maxY - b.minY);
  }

  return out;
}

/** Every edge of `edges` against every corner of `points` that is not one of
 * its own ends. */
function ask(edges: Corner[], points: Corner[], out: number[], search: Search): void {
  const n = edges.length;
  if (n < 2) return;

  const same = edges === points;

  for (let i = 0; i < n; i++) {
    const a = edges[i], b = edges[(i + 1) % n];

    for (let k = 0; k < points.length; k++) {
      if (same && (k === i || k === (i + 1) % n)) continue;

      out.push(...collinear(a, b, points[k], search).at);
    }
  }
}

/**
 * The roots, sorted, coincident ones absorbed into one, each opened out into the
 * gap a keyframe leaves.
 *
 * A root at either end of the span is kept rather than discarded as an artefact
 * of the boundary. Polygons drawn edge to edge separate the instant one of them
 * erodes, so `t = 0` really is a moment the arrangement changes, and the stretch
 * of no width it leaves behind carries the touching geometry — which is what the
 * earlier version renders, and so has to be what the span begins with.
 */
function bracketed(roots: number[]): Cut[] {
  const sorted = [...roots].sort((p, q) => p - q);
  const out: Cut[] = [];

  for (const t of sorted) {
    const last = out[out.length - 1];

    if (last !== undefined && t - last.hi <= TOGETHER) {
      last.hi = Math.min(1, t + BRACKET);
      continue;
    }

    out.push({ lo: Math.max(0, t - BRACKET), hi: Math.min(1, t + BRACKET) });
  }

  return out;
}

// -----------------------------------------------------------------------------
// Baking
// -----------------------------------------------------------------------------

/**
 * One span, as a generator so that the editor can run it a slice at a time and
 * keep drawing. It yields how far along it is, between 0 and 1.
 */
export function* bakeSpan(
  world: World,
  from: VersionId,
  search: Search = {},
): Generator<number, Span, void> {
  const items = moving(world, from);
  const held = { at: EMPTY_LIVE };

  let samples = 0;

  const found = yield* cuts(items, search);

  // A polygon born into the later version appears at the boundary and nowhere
  // inside, so the boundary is a keyframe on its own account — known from the
  // layer chain, never searched for. The span runs to just short of it with the
  // newborn absent, and the instant itself is a stretch of no width carrying
  // the version as it really is.
  if (items.some(m => m.newborn)) found.push({ lo: 1 - BRACKET, hi: 1 });

  // A stretch runs from the far side of one event to the near side of the next,
  // so the events themselves are the gaps between them. Nothing is evaluated
  // *at* an event, because at an event the two sides genuinely disagree.
  const bounds: [number, number][] = [];

  let t0 = 0;

  for (const c of found) {
    bounds.push([t0, c.lo]);
    t0 = c.hi;
  }

  bounds.push([t0, 1]);

  const stretches: Stretch[] = [];

  for (const [i, [u, v]] of bounds.entries()) {
    const a = evaluate(held.at, items, u);
    held.at = a.held;

    const b = evaluate(held.at, items, v);
    held.at = b.held;

    samples += 2;

    const torn = signature(a.frame) !== signature(b.frame);

    stretches.push({
      t0: u,
      t1: v,
      a: a.frame,
      b: b.frame,
      table: table(a.table, b.table),
      // Read off both ends and only kept where they say the same thing. A
      // crossing solved from the wrong pair of edges would be worse than one
      // interpolated, so disagreement gives up rather than guesses.
      origins: torn ? a.frame.map(r => r.points.map(() => null)) : agreed(a, b),
      torn,
    });

    yield (i + 1) / bounds.length;
  }

  const riders = new Map<PolygonId, Rider>(
    items.map(m => [m.at.id, { base: m.base, layer: m.newborn ? EMPTY_TRANSFORM : m.layer }]),
  );

  return { from, stretches, riders, samples, stamp: stamp(world, from) };
}

/** Every span in the chain, one after the other. */
export function* bakeAll(world: World): Generator<number, Map<VersionId, Span>, void> {
  const out = new Map<VersionId, Span>();
  const count = world.versions.length - 1;

  for (let k = 0; k < count; k++) {
    // Two thirds of a span goes on the search and a third on the stretches,
    // which is roughly how the samples fall.
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

export function sample(span: Span, t: number): Frame {
  const s = stretchAt(span, t);
  if (s === null) return [];

  // Snapped rather than interpolated. The ends do not agree about what exists,
  // so there is no correspondence to interpolate along — but the frame is
  // still a function of `t`, so the snapped geometry rides it like any other.
  const u = s.torn
    ? (t < (s.t0 + s.t1) / 2 ? 0 : 1)
    : s.t1 === s.t0 ? 0 : (t - s.t0) / (s.t1 - s.t0);

  const from = s.torn && u === 1 ? s.b : s.a;

  // One per polygon rather than one per point: every vertex of a polygon rides
  // the same layer, and rebuilding it is four trig calls.
  const frames = new Map<PolygonId, Affine>();

  const frameOf = (id: PolygonId): Affine => {
    const known = frames.get(id);
    if (known !== undefined) return known;

    const rider = span.riders.get(id)!;
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

  return from.map((run, i) => {
    const to = s.torn ? from[i] : s.b[i];
    const frame = frameOf(run.id);
    const origins = s.origins[i] ?? [];

    return {
      id: run.id,
      points: run.points.map((p, j) => {
        const solved = crossing(origins[j], ends);

        if (solved !== null) return solved;

        // A vertex of its own polygon, or a point the reading could not place.
        // Either way it interpolates in the polygon's frame, which for a vertex
        // is exact and for the rest is the best there is.
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

/** The stretch holding `t`, or the nearest one when `t` has landed in an event's
 * own bracket. */
function stretchAt(span: Span, t: number): Stretch | null {
  let best: Stretch | null = null;
  let away = Infinity;

  for (const s of span.stretches) {
    if (t >= s.t0 && t <= s.t1) return s;

    const d = t < s.t0 ? s.t0 - t : t - s.t1;

    if (d < away) {
      away = d;
      best = s;
    }
  }

  return best;
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
