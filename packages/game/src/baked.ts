// -----------------------------------------------------------------------------
// The bake, as buffers
//
// What the editor works out and what the game is handed are not the same shape.
// The editor's `Span` is a graph of maps keyed by polygon id, cut into one
// track per polygon; the game wants flat arrays it can hand to a GPU without
// walking anything. This is that flattening, and it lives here rather than in
// the editor because it is the *contract*: the editor writes it, the game reads
// it, and neither of them owns it.
//
// Nothing in here resolves a version. A span holds two adjacent versions'
// worth of geometry already evaluated, cut into stretches across which the
// arrangement holds, and everything between two stretch ends is a lerp. That is
// the whole runtime model — see `docs/versioning.md`, *The bake*.
//
// Two kinds of output point
// -------------------------
// A **corner** of some polygon's own eroded ring interpolates exactly, in that
// polygon's own frame, which is what makes a turning room turn rather than
// collapse through its middle. A **crossing** — where two polygons' edges meet —
// is not a function of either polygon alone and does not interpolate at all:
// the four endpoints are evaluated and the 2x2 is solved. About ten
// multiply-adds, and exact.
//
// Within a stretch the two edges are guaranteed to still meet inside their
// segment bounds, because an endpoint passing through the other edge is an
// event and would have ended the stretch.
//
// Why the strides are what they are
// ---------------------------------
// Both tables go up as RGBA float textures, so both strides are multiples of
// four and the padding is deliberate rather than left over.
// -----------------------------------------------------------------------------

import { Point } from './world';

/**
 * Sixteen floats per polygon: the chain it already stood in as an affine, the
 * version in flight in components, and that layer's fixed point.
 *
 *   0..5   base affine a, b, c, d, tx, ty
 *   6, 7   the layer's translation
 *   8      the layer's rotation, in radians
 *   9, 10  the layer's scale, per axis
 *   11     whether the layer has a fixed point at all
 *   12, 13 that fixed point
 *   14, 15 spare
 *
 * The layer is kept in components rather than as a matrix because it is
 * interpolated, and a matrix lerped entrywise slews a rotation through a shear.
 * The fixed point is what a turn goes round; a layer that has none — a pure
 * translation, or a scale leaving an axis alone — says so in slot 11 and the
 * translation is taken in a straight line instead, which for a translation is
 * exactly right anyway.
 */
export const FRAME_STRIDE = 16;

/**
 * Eight floats per entry of the table crossings are solved from.
 *
 *   0, 1  the point at the near end of the stretch, in its owner's frame
 *   2, 3  the same at the far end
 *   4     the frame slot it rides
 *   5     the entry the edge starting here carries on to
 *   6, 7  spare
 *
 * Only the rings some crossing actually names are in here. Carrying the
 * neighbours whole was most of the size of a busy span and none of it was ever
 * read.
 */
export const ENTRY_STRIDE = 8;

/** An output point that is a corner of its own polygon's ring. */
export const CORNER = 0;
/** One that is where two polygons' edges meet, and has to be solved. */
export const CROSSING = 1;

/**
 * One polygon's share of the outline across one stretch: a run of consecutive
 * output points, open, as the CSG hands it over.
 *
 * Open rather than closed, and that is not a loss. A ring of the union is
 * generally made of several polygons' runs and belongs to none of them, so
 * keeping ring identity would put back exactly the global bookkeeping the
 * whole design avoids. A wall is a consecutive pair of points, and every pair
 * is inside some run.
 */
export interface BakedRun {
  /** Where its points start in the span's output arrays. */
  first: number
  count: number
}

/**
 * A stretch of `t` across which nothing discrete happens to one polygon.
 *
 * `t0` and `t1` are positions within the span, 0 at the earlier version and 1
 * at the later one. Adjacent stretches in a track may leave a hair of a gap
 * between them: that is a topology event, converged on from both sides, and the
 * reader takes whichever side is nearer.
 */
export interface BakedStretch {
  t0: number
  t1: number
  runs: BakedRun[]
}

/**
 * One polygon's own cut of the span, in order and covering all of it.
 *
 * Tracks are cut independently, against the handful of polygons each one
 * overlaps, so two rooms at opposite ends of a level share no keyframes. That
 * is what keeps a span from growing with the square of the level.
 */
export interface BakedTrack {
  stretches: BakedStretch[]
}

/** Everything between two adjacent versions. */
export interface BakedSpan {
  /** The earlier of the two versions. `t` runs 0 to 1 from it to the next. */
  from: number
  /** `FRAME_STRIDE` floats per polygon slot. */
  frames: Float32Array
  /** `ENTRY_STRIDE` floats per entry. */
  entries: Float32Array

  /** Per output point, two floats: where it sits at the near end of its
   * stretch, in its owner's frame. */
  pointsA: Float32Array
  /** The same at the far end. */
  pointsB: Float32Array
  /** Per output point, the frame slot its run's polygon rides. */
  slots: Int32Array
  /** Per output point, `CORNER` or `CROSSING`. */
  kinds: Uint8Array
  /**
   * Per output point, how solid it is at each end of its stretch — the doc's
   * `lineOpacity`.
   *
   * A corner that is not its polygon's at one end of the span is still in the
   * ring there, put on the edge between its ring-neighbours so that the shape
   * is unchanged and the two ends still interpolate. It is not a corner, and
   * the vertical line a wall draws at a corner has nothing to stand on. Zero
   * there, one where the corner is real, and lerped between — so the line
   * fades in over exactly the stretch the vertex emerges through.
   */
  opacityA: Float32Array
  opacityB: Float32Array

  /**
   * Per output point, four entries: the two ends of one edge and the two ends
   * of the other. Only read where the kind is `CROSSING`; elsewhere it is -1,
   * which is also what a crossing the bake could not place is written as, so
   * that it falls back to interpolating like a corner.
   */
  crossings: Int32Array

  /** One per polygon, in the order their runs come back out in. */
  tracks: BakedTrack[]
}

/** Every span of one level, in version order and covering all of them. */
export interface BakedLevel {
  spans: BakedSpan[]
}

export const EMPTY_BAKED: BakedLevel = { spans: [] };

/** How many points a span holds, over every run of every stretch of every
 * track. */
export function points(span: BakedSpan): number {
  return span.slots.length;
}

// -----------------------------------------------------------------------------
// Reading it back
//
// What the vertex shader does, on the CPU. Nothing in the game runs this — the
// renderer positions on the GPU and collision runs off the source polygons —
// and that is the point of it: it is written from the same description the
// shader is, so a test can hold it against what the editor says the span means
// and the shader against it in turn.
// -----------------------------------------------------------------------------

/** `(x, y)` goes to `(ax + cy + tx, bx + dy + ty)`, as in the editor. */
export interface Affine {
  a: number
  b: number
  c: number
  d: number
  tx: number
  ty: number
}

function mix(u: number, v: number, t: number): number {
  return u + (v - u) * t;
}

/**
 * A polygon's frame at one instant: the layer it is in the middle of receiving,
 * eased from identity to itself, composed onto the chain it already stood in.
 *
 * Rotation and scale ease on their own terms; the translation is then whatever
 * holds the fixed point still. Easing it in a straight line instead is what
 * makes a turning room swing out on a great arc and come back, since the
 * translation a turn leaves behind is its pivot carried round a circle and a
 * chord is not a circle.
 */
export function frameAt(span: BakedSpan, slot: number, t: number): Affine {
  const f = span.frames, o = slot * FRAME_STRIDE;

  const rotation = f[o + 8] * t;
  const sx = mix(1, f[o + 9], t), sy = mix(1, f[o + 10], t);

  const cos = Math.cos(rotation), sin = Math.sin(rotation);
  const a = cos * sx, b = sin * sx, c = -sin * sy, d = cos * sy;

  // Both ends are unmoved by the choice: at 0 the map is the identity and at 1
  // it is the layer itself, whichever way the translation got there.
  const held = f[o + 11] !== 0 && t !== 0 && t !== 1;
  const px = f[o + 12], py = f[o + 13];

  const tx = held ? px - (a * px + c * py) : f[o + 6] * t;
  const ty = held ? py - (b * px + d * py) : f[o + 7] * t;

  // The eased layer, after the base.
  const ba = f[o], bb = f[o + 1], bc = f[o + 2], bd = f[o + 3];
  const bx = f[o + 4], by = f[o + 5];

  return {
    a: a * ba + c * bb,
    b: b * ba + d * bb,
    c: a * bc + c * bd,
    d: b * bc + d * bd,
    tx: a * bx + c * by + tx,
    ty: b * bx + d * by + ty,
  };
}

function place(m: Affine, x: number, y: number): Point {
  return { x: m.a * x + m.c * y + m.tx, y: m.b * x + m.d * y + m.ty };
}

/** One table entry, evaluated: the lerp of its two ends, taken out to the
 * world by the frame it rides. */
function entryAt(span: BakedSpan, entry: number, t: number, u: number): Point {
  const e = span.entries, o = entry * ENTRY_STRIDE;
  const m = frameAt(span, e[o + 4], t);

  return place(m, mix(e[o], e[o + 2], u), mix(e[o + 1], e[o + 3], u));
}

/**
 * Where the two edges meet, from their four endpoints.
 *
 * Nothing here checks that they meet inside their segment bounds, because that
 * is what the stretch is for. Parallel is possible all the same, at the instant
 * an event is arriving, and gives up rather than dividing by nothing.
 */
function crossingAt(span: BakedSpan, at: number, t: number, u: number): Point | null {
  const c = span.crossings, o = at * 4;

  const p = entryAt(span, c[o], t, u), q = entryAt(span, c[o + 1], t, u);
  const r = entryAt(span, c[o + 2], t, u), w = entryAt(span, c[o + 3], t, u);

  const ux = q.x - p.x, uy = q.y - p.y;
  const vx = w.x - r.x, vy = w.y - r.y;

  const det = ux * vy - uy * vx;
  if (det === 0) return null;

  const k = ((r.x - p.x) * vy - (r.y - p.y) * vx) / det;

  return { x: p.x + ux * k, y: p.y + uy * k };
}

/**
 * The stretch holding `t`, or the nearer of the two around it when `t` has
 * landed in an event's own bracket.
 *
 * A search rather than a scan: this is asked once per polygon per frame, and a
 * level's worth of linear walks through busy tracks showed up in the frame time
 * of the editor's replay.
 */
export function stretchAt(track: BakedTrack, t: number): BakedStretch | null {
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

  const here = all[lo];
  if (t >= here.t0) return here;

  const back = all[lo - 1];
  if (back === undefined) return here;

  return t - back.t1 <= here.t0 - t ? back : here;
}

/**
 * The outline at one instant, in world units, run by run and in track order.
 *
 * The yardstick the shader is written against, and the only thing in here that
 * costs anything: the game itself never calls it.
 */
export function outline(span: BakedSpan, t: number): Point[][] {
  const out: Point[][] = [];

  for (const track of span.tracks) {
    const s = stretchAt(track, t);
    if (s === null) continue;

    const u = s.t1 === s.t0 ? 0 : (t - s.t0) / (s.t1 - s.t0);

    for (const run of s.runs) {
      const points: Point[] = [];

      for (let i = run.first; i < run.first + run.count; i++) {
        const solved = span.kinds[i] === CROSSING ? crossingAt(span, i, t, u) : null;

        if (solved !== null) {
          points.push(solved);
          continue;
        }

        // A corner of its own polygon, or a crossing that could not be
        // placed. Either way it interpolates in the polygon's frame, which
        // for a corner is exact and for the rest is what the bake's measured
        // tolerance covers.
        const m = frameAt(span, span.slots[i], t);

        points.push(place(
          m,
          mix(span.pointsA[i * 2], span.pointsB[i * 2], u),
          mix(span.pointsA[i * 2 + 1], span.pointsB[i * 2 + 1], u),
        ));
      }

      out.push(points);
    }
  }

  return out;
}

/**
 * The outline part way through a walk across the whole level, which is what the
 * countdown drives.
 *
 * `u` runs 0 to 1 over however many spans the walk crosses, so a run from the
 * first version to the last plays them one after another. Backwards is the same
 * stretches read the other way, which is what the reversal artefact wants.
 */
export function outlineAt(level: BakedLevel, u: number): Point[][] {
  const n = level.spans.length;
  if (n === 0) return [];

  const x = Math.min(Math.max(u, 0), 1) * n;
  const i = Math.min(Math.floor(x), n - 1);

  return outline(level.spans[i], x - i);
}
