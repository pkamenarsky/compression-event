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
// Nothing in here resolves a keyframe. A span holds two adjacent keyframes'
// worth of geometry already evaluated, cut into stretches across which the
// arrangement holds, and everything between two stretch ends is a lerp in the
// frame each point rides — and a frame is the operations the far keyframe
// plays, played part way. That is the whole runtime model.
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
// All three tables go up as RGBA float textures, so every stride is a multiple
// of four and the padding is deliberate rather than left over.
// -----------------------------------------------------------------------------

// A type, and imported as one on purpose: `world.ts` reads `EMPTY_BAKED` out
// of this file, so a value import back would be a runtime cycle between the
// two. `import type` is erased, and the cycle with it. See CLAUDE.md.
import type { Point } from './world';

/**
 * Eight floats per slot: where the thing's own frame stands at the near end of
 * the span, in the frame of whatever holds it, and where its operations are.
 *
 *   0, 1   the translation
 *   2      the angle
 *   3, 4   the scale, along the thing's own axes
 *   5      the slot of the group holding this one, or -1
 *   6      the first of its operations in the operation table
 *   7      how many there are
 *   8      the skew
 *   9–11   spare, so that a slot is three whole texels
 *
 * A frame is a translation, an angle, a skew and a scale along its own axes —
 * `t + R · K · S` — and every operation keeps it one, so a slot is six numbers
 * rather than a matrix, and the operations are played on those numbers as they
 * were written. What the
 * far keyframe does to the thing is its operations one after another, each
 * part way, each from the frame the one before it left: see `OP_STRIDE`.
 *
 * A group is a slot like any other: its own frame, its own operations, and its
 * own holder above it. A vertex rides the chain up to the top rather than one
 * composed matrix, because a composed matrix has no operations to play on it:
 * each link's own are played on its own numbers. How deep the chain goes is
 * `BakedSpan.depth`.
 */
export const FRAME_STRIDE = 12;

/**
 * Eight floats per operation: its kind, and its numbers.
 *
 *   OP_MOVE   by x, by y
 *   OP_TURN   angle, painted point x, y, offset of the anchor from it x, y
 *   OP_SCALE  by x, by y, painted point x, y, slide x, y
 *   OP_STAND  translation x, y, angle, scale x, y, skew
 *   OP_SKEW   by, painted point x, y, slide x, y
 *
 * Part way, `u` of the way through — which is `t`, the span being one
 * keyframe's worth — each goes the way it would have gone under the hand:
 *
 *   MOVE   the translation goes `u · by`
 *   TURN   `u · angle` about the anchor, which is the painted point placed
 *          by the frame as it stands when the turn begins, plus the offset
 *   SCALE  `byᵘ` along the thing's own axes about the painted point placed
 *          the same way, and the slide eased to match: by `(1 − dᵘ)/(1 − d)`
 *          along each axis, which keeps the gesture's own centre still
 *   SKEW   `u · by` along the thing's first axis about the painted point,
 *          and `u` of the slide, a shear being linear in how far it goes
 *   STAND  every component straight to its numbers
 *
 * The anchor is placed off the frame as it stands, rather than stored placed,
 * because an operation that comes after another in the same keyframe acts
 * about a point the one before it is still carrying.
 */
export const OP_STRIDE = 8;

export const OP_MOVE = 0;
export const OP_TURN = 1;
export const OP_SCALE = 2;
export const OP_STAND = 3;
export const OP_SKEW = 4;

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
 * `t0` and `t1` are positions within the span, 0 at the earlier keyframe and 1
 * at the later one. Adjacent stretches abut exactly and the track's stretches
 * cover the whole span, so every instant has one owner and no instant has two.
 *
 * A jump is written the same way with `t0 === t1` — see `BakedTrack`.
 */
export interface BakedStretch {
  t0: number
  t1: number
  runs: BakedRun[]
}

/**
 * One polygon's own cut of the span.
 *
 * Tracks are cut independently, against the handful of polygons each one
 * overlaps, so two rooms at opposite ends of a level share no keyframes. That
 * is what keeps a span from growing with the square of the level.
 *
 * `stretches` is an ordered cover: they abut exactly and every instant of the
 * span lies in one of them. `jumps` are the geometry *at* the instants where
 * the arrangement changes, which is true at a point and at neither side of it,
 * so they are not in the cover and only an exact instant reaches them. That is
 * what the span begins and ends on, and it is what the shader is not handed —
 * the morph buffers are built from `stretches` alone, because an arrangement
 * that holds for no length of time cannot be drawn for a frame.
 */
export interface BakedTrack {
  /**
   * A floor: drawn filled and flat underfoot rather than as walls.
   *
   * Which of the two sets the track's boundary belongs to, and nothing more.
   * A floor is a set of its own — floors added, holes cut in them taken back
   * out — cut by the same measure against the same kind of neighbourhood, so
   * its runs are the same open arcs a share of any outline comes in, crossings
   * and all. Everything about a track is the same, which is the point: it
   * rides the same frame, it is cut to the same measure, and it moves by the
   * same lerp.
   *
   * Only what is built on top of the points differs, and that is the reader's
   * business. A wall stands up on a run; a fill needs the loop, and a loop of
   * the floor set generally belongs to several polygons — so whatever fills it
   * stitches the runs back into rings at the instant it draws them. See
   * `looped` in `walls.ts`.
   */
  fill: boolean
  /**
   * A hole cut in the floors rather than floor.
   *
   * The floor set is drawn by counting, and a count is additive where a set is
   * not: two floors over the same ground count two, and a hole through both of
   * them takes one away and leaves it filled. So the holes cannot go into the
   * floors' count, and they are not wound to. They are counted on their own,
   * inside what the floors filled, and taken back out of it — see `stencilled`
   * in `walls.ts`, which is the only reader of this.
   *
   * False on a wall, which has no such question.
   */
  hole: boolean
  stretches: BakedStretch[]
  /** By `t`, ascending. Always `t0 === t1`. */
  jumps: BakedStretch[]
}

/** Everything between two adjacent keyframes. */
export interface BakedSpan {
  /** Where the earlier of the two is in the order. `t` runs 0 to 1 from it to
   * the next. */
  from: number
  /** `FRAME_STRIDE` floats per slot: one per polygon, and one per group
   * holding any of them. */
  frames: Float32Array
  /** `OP_STRIDE` floats per operation, every slot's laid end to end. */
  ops: Float32Array
  /**
   * The most operations any one slot plays.
   *
   * The shader walks a slot's run per vertex, so it is written down here and
   * the loop is built to it, the way it is built to `depth`.
   */
  most: number
  /**
   * How many slots deep the deepest chain of them goes: 1 where nothing is
   * grouped, 2 for a polygon in a group, and so on.
   *
   * The shader walks the chain per vertex, so it is written down here and the
   * loop is built to it rather than to a limit the author has to be told
   * about. Nothing about the format caps it.
   */
  depth: number
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

  /**
   * Per artefact, in the order the world holds them, the frame slot it rides —
   * or -1 where this span does not carry it.
   *
   * An artefact has no geometry and no track, so it is in the buffers as a
   * slot and nothing else: its own point goes through `frameAt` exactly as a
   * corner does. That is the whole of why it comes round a turn on the arc
   * rather than the chord, without anything reading this knowing what a turn
   * is.
   */
  artefacts: Int32Array
}

/** Every span of one level, in keyframe order and covering all of them. */
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
 * The frame a point actually rides: its own slot's, and every group holding
 * it, each played on its own terms and multiplied.
 *
 * The chain stays a chain rather than arriving as one composed matrix, because
 * composing two frames gives a general matrix and there are no operations to
 * play on one of those. Exactly what `worldFrame` walks at a keyframe, and
 * exactly what the shader's `frameAt` does.
 */
export function frameAt(span: BakedSpan, slot: number, t: number): Affine {
  let m = linkAt(span, slot, t);
  let up = span.frames[slot * FRAME_STRIDE + 5];

  while (up >= 0) {
    m = onto(linkAt(span, up, t), m);
    up = span.frames[up * FRAME_STRIDE + 5];
  }

  return m;
}

/** `outer` after `inner`, which is `compose` in the editor. */
function onto(outer: Affine, inner: Affine): Affine {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    tx: outer.a * inner.tx + outer.c * inner.ty + outer.tx,
    ty: outer.b * inner.tx + outer.d * inner.ty + outer.ty,
  };
}

/** A frame in the components the table keeps it in. */
interface Pose {
  x: number
  y: number
  angle: number
  skew: number
  sx: number
  sy: number
}

/** A point of the thing, placed by a frame. */
function posed(f: Pose, px: number, py: number): Point {
  const v = shear(px * f.sx, py * f.sy, f);

  return { x: f.x + v.x, y: f.y + v.y };
}

/** A vector through the frame's axes, `R · K`, and back. */
function shear(x: number, y: number, f: Pose): Point {
  return spin(x + f.skew * y, y, f.angle);
}

function unshear(x: number, y: number, f: Pose): Point {
  const w = spin(x, y, -f.angle);

  return { x: w.x - f.skew * w.y, y: w.y };
}

function spin(x: number, y: number, angle: number): Point {
  const c = Math.cos(angle), s = Math.sin(angle);

  return { x: c * x - s * y, y: s * x + c * y };
}

/** `(1 − dᵘ) / (1 − d)`: how much of a scale's slide has happened when `u` of
 * the scale has. */
function slid(d: number, u: number): number {
  const l = Math.log(d);

  return Math.abs(l) < 1e-12 ? u : Math.expm1(u * l) / Math.expm1(l);
}

/** One operation of the table, `u` of the way through. See `OP_STRIDE`. */
function playedAt(span: BakedSpan, op: number, f: Pose, u: number): Pose {
  const o = span.ops, i = op * OP_STRIDE;
  const kind = o[i];

  if (kind === OP_MOVE) return { ...f, x: f.x + o[i + 1] * u, y: f.y + o[i + 2] * u };

  if (kind === OP_TURN) {
    const p = posed(f, o[i + 2], o[i + 3]);
    const ax = p.x + o[i + 4], ay = p.y + o[i + 5];
    const angle = o[i + 1] * u;
    const d = spin(f.x - ax, f.y - ay, angle);

    return { ...f, x: ax + d.x, y: ay + d.y, angle: f.angle + angle };
  }

  if (kind === OP_SCALE) {
    const p = posed(f, o[i + 3], o[i + 4]);
    const dx = Math.pow(o[i + 1], u), dy = Math.pow(o[i + 2], u);
    const own = unshear(f.x - p.x, f.y - p.y, f);
    const back = shear(own.x * dx, own.y * dy, f);
    const sh = unshear(o[i + 5], o[i + 6], f);
    const slide = shear(sh.x * slid(o[i + 1], u), sh.y * slid(o[i + 2], u), f);

    return {
      ...f,
      x: p.x + back.x + slide.x,
      y: p.y + back.y + slide.y,
      sx: f.sx * dx,
      sy: f.sy * dy,
    };
  }

  if (kind === OP_SKEW) {
    const p = posed(f, o[i + 2], o[i + 3]);
    const by = o[i + 1] * u;
    const w = spin(f.x - p.x, f.y - p.y, -f.angle);
    const back = spin(w.x + by * w.y, w.y, f.angle);

    return {
      ...f,
      x: p.x + back.x + o[i + 4] * u,
      y: p.y + back.y + o[i + 5] * u,
      skew: f.skew + by,
    };
  }

  return {
    x: mix(f.x, o[i + 1], u),
    y: mix(f.y, o[i + 2], u),
    angle: mix(f.angle, o[i + 3], u),
    skew: mix(f.skew, o[i + 6], u),
    sx: mix(f.sx, o[i + 4], u),
    sy: mix(f.sy, o[i + 5], u),
  };
}

/**
 * One link of that chain: the slot's own frame at the near end, with every
 * operation the far keyframe plays over it played `t` of the way.
 */
export function linkAt(span: BakedSpan, slot: number, t: number): Affine {
  const fr = span.frames, o = slot * FRAME_STRIDE;

  let f: Pose = { x: fr[o], y: fr[o + 1], angle: fr[o + 2], skew: fr[o + 8], sx: fr[o + 3], sy: fr[o + 4] };

  if (t !== 0) {
    const first = fr[o + 6], count = fr[o + 7];

    for (let k = 0; k < count; k++) f = playedAt(span, first + k, f, t);
  }

  const c = Math.cos(f.angle), s = Math.sin(f.angle);
  const k = f.skew * f.sy;

  return { a: c * f.sx, b: s * f.sx, c: c * k - s * f.sy, d: s * k + c * f.sy, tx: f.x, ty: f.y };
}

/** A point in a slot's own frame, taken out to the world at one instant. */
export function placeAt(span: BakedSpan, slot: number, at: Point, t: number): Point {
  return place(frameAt(span, slot, t), at.x, at.y);
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
 * The stretch holding `t`, or the jump sitting exactly on it.
 *
 * A search rather than a scan: this is asked once per polygon per frame, and a
 * level's worth of linear walks through busy tracks showed up in the frame time
 * of the editor's replay.
 */
export function stretchAt(track: BakedTrack, t: number): BakedStretch | null {
  // A jump answers for its own instant and nothing else.
  for (const j of track.jumps) {
    if (j.t0 === t) return j;
  }

  const all = track.stretches;

  if (all.length === 0) return null;

  let lo = 0, hi = all.length - 1;

  while (lo < hi) {
    const mid = (lo + hi) >> 1;

    // Half-open, the same rule the shader uses: a stretch holds its start and
    // not its end. The cover is exact, so this needs no fallback — there is no
    // gap for `t` to land in and no side to prefer.
    if (all[mid].t1 <= t) {
      lo = mid + 1;
    }
    else {
      hi = mid;
    }
  }

  return all[lo];
}

/**
 * The outline at one instant, in world units, run by run and in track order.
 *
 * The yardstick the shader is written against, and the only thing in here that
 * costs anything: the game itself never calls it.
 *
 * Every track, floors included — the shader reads them out of the same buffers
 * by the same arithmetic, and what this is for is checking that arithmetic.
 * Run by run either way: a fill track's runs are arcs of the floor set's
 * boundary, and putting them back into loops is the fill's business rather
 * than this one's. See `BakedTrack.fill`.
 */
export function outline(span: BakedSpan, t: number): Point[][] {
  const out: Point[][] = [];

  for (const track of span.tracks) {
    const s = stretchAt(track, t);
    if (s === null) continue;

    const u = s.t1 === s.t0 ? 0 : (t - s.t0) / (s.t1 - s.t0);

    for (const run of s.runs) {
      const points: Point[] = [];

      for (let i = run.first; i < run.first + run.count; i++) points.push(placedAt(span, i, t, u));

      out.push(points);
    }
  }

  return out;
}

/**
 * Where one output point stands at `t`, in world units.
 *
 * The arithmetic the shader is written against, for a caller holding one point
 * rather than a whole run: `outline` is this over everything, and the fill's
 * cut is this over the handful of points a floor has. See `fan`.
 *
 * `u` is how far through its own stretch the point is, which the caller has to
 * know because the stretch belongs to the track rather than to the span.
 */
export function placedAt(span: BakedSpan, i: number, t: number, u: number): Point {
  const solved = span.kinds[i] === CROSSING ? crossingAt(span, i, t, u) : null;

  if (solved !== null) return solved;

  // A corner of its own polygon, or a crossing that could not be placed.
  // Either way it interpolates in the polygon's frame, which for a corner is
  // exact and for the rest is what the bake's measured tolerance covers.
  const m = frameAt(span, span.slots[i], t);

  return place(
    m,
    mix(span.pointsA[i * 2], span.pointsB[i * 2], u),
    mix(span.pointsA[i * 2 + 1], span.pointsB[i * 2 + 1], u),
  );
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
