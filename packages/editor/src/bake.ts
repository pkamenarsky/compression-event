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
// This prototype finds the second kind by scanning `t` and bisecting wherever
// the arrangement's *signature* — how many runs each polygon owns and how many
// points each run has — differs between two samples. That is the method the
// doc calls the inferior one, and it is: it can miss two events inside one
// sample interval, and it cannot see a corner that grazes an edge without going
// through, because neither changes the signature at the sample points.
//
// `events.ts` is the answer to that and is built, but it is not wired in here,
// because its model of a moving vertex is not this one: it carries a uniform
// scale and expresses erosion as `local + depth * bisector`, and a version here
// has a per-axis scale and gets its offset out of the CSG as a subtracted band
// rather than out of per-corner bisectors. Feeding it would mean recovering the
// bisectors — which do exist, the mitre point being linear in depth exactly as
// it assumes — and widening `Frame` to two axes. Both are real work and neither
// changes anything the replay shows, so the scan stands in for now and the
// seam is one function wide: `cuts`.
//
// Why the set is incremental
// --------------------------
// A span is evaluated at a hundred-odd values of `t` and most polygons are not
// moving in it — a version edits a few things and leaves the rest alone. So
// each evaluation goes through `live`, which diffs the resolved shapes against
// the last evaluation and hands `worldset` only what actually moved. The full
// CSG is paid once per span, at the first sample; everything after it costs the
// polygons that moved and their overlappers. A polygon untouched by the version
// in flight is never re-CSG'd at all, however many samples the search takes.
// -----------------------------------------------------------------------------

import { Point } from '@ce/game/world';
import { Ring } from './geometry';
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
function evaluate(held: Live, items: Moving[], t: number): { held: Live, frame: Frame } {
  const at = world1(items, t);
  const next = live(held, at);

  const frames = new Map(at.map(it => [it.id, it.frame]));

  // Sorted, so that two evaluations line up run by run. `worldset` hands its
  // runs back in whatever order the entries happen to sit in, which an edit
  // reorders; within one polygon the order is the boundary's own and is stable
  // for as long as the combinatorics are — which is exactly a stretch.
  const frame = pieces(next.set)
    .map(p => ({
      id: p.source,
      points: p.points.map(q => unplace(frames.get(p.source)!, q)),
    }))
    .sort((p, q) => p.id - q.id);

  return { held: next, frame };
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
// Cutting the span
// -----------------------------------------------------------------------------

/** Samples across the span, before anything is bisected. Two events inside one
 * of these intervals are two events this search will miss. */
const SCAN = 48;

/** Bisection steps per event. The bracket left over is the pop at the keyframe,
 * so this is a width in `t` and needs no tuning per world. */
const REFINE = 20;

interface Cut {
  /** The last `t` proved to be on the near side, and the first on the far
   * side. The event is between them and the stretches stop short of it. */
  lo: number
  hi: number
}

/**
 * Every moment the arrangement changes, bracketed.
 *
 * The two ends of the span are not in here. They are keyframes for reasons that
 * have nothing to do with the geometry — the interpolation breaks there, and a
 * newborn polygon appears there — and they are added by the caller, which is
 * why nothing in this function has to know about them.
 */
function* cuts(
  held: { at: Live },
  items: Moving[],
  onSample: () => void,
): Generator<number, Cut[], void> {
  const seen = new Map<number, string>();

  const sign = (t: number): string => {
    const known = seen.get(t);
    if (known !== undefined) return known;

    const r = evaluate(held.at, items, t);
    held.at = r.held;

    const s = signature(r.frame);
    seen.set(t, s);
    onSample();

    return s;
  };

  const out: Cut[] = [];

  let lo = 0;
  let previous = sign(0);

  for (let i = 1; i <= SCAN; i++) {
    const hi = i / SCAN;
    const now = sign(hi);

    if (now !== previous) {
      out.push(yield* bisect(sign, lo, hi, previous));
      yield i / SCAN;
    }

    lo = hi;
    previous = now;
  }

  return out;
}

/** The event, pinned down. `a` is the signature at `lo`, which is what tells
 * the two halves apart. */
function* bisect(
  sign: (t: number) => string,
  lo: number,
  hi: number,
  a: string,
): Generator<number, Cut, void> {
  for (let i = 0; i < REFINE; i++) {
    const mid = (lo + hi) / 2;

    if (sign(mid) === a) lo = mid;
    else hi = mid;
  }

  return { lo, hi };
}

// -----------------------------------------------------------------------------
// Baking
// -----------------------------------------------------------------------------

/**
 * One span, as a generator so that the editor can run it a slice at a time and
 * keep drawing. It yields how far along it is, between 0 and 1.
 */
export function* bakeSpan(world: World, from: VersionId): Generator<number, Span, void> {
  const items = moving(world, from);
  const held = { at: EMPTY_LIVE };

  let samples = 0;
  const onSample = () => samples++;

  const found = yield* cuts(held, items, onSample);

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

    stretches.push({
      t0: u,
      t1: v,
      a: a.frame,
      b: b.frame,
      torn: signature(a.frame) !== signature(b.frame),
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

  return from.map((run, i) => {
    const to = s.torn ? from[i] : s.b[i];
    const rider = span.riders.get(run.id)!;

    // `apply(lerp(T), lerp(local))`, which is the whole of what the shader
    // does. The components are eased at the instant being drawn, not at the
    // stretch's ends, so a turn is a turn all the way across.
    const frame = compose(affine(easing(rider.layer, t)), rider.base);

    return {
      id: run.id,
      points: place(frame, run.points.map((p, j) => {
        const q = to.points[j];

        return { x: mix(p.x, q.x, u), y: mix(p.y, q.y, u) };
      })),
    };
  });
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
