// -----------------------------------------------------------------------------
// Timelines of operations
//
// What happens to a thing is a list of operations per keyframe, and where it
// is at a keyframe is those lists played from its birth onward. Nothing else:
// no layer to inherit, nothing composed into anything, nothing solved for
// after an edit.
//
// A thing's state is its frame — `F(x) = t + R(angle) · S · x` over its rest
// geometry, in the frame of whatever holds it — together with how deep it is
// eroded and where its corners stand. An operation is written against the
// frame at the start of *that operation*, and says what it means:
//
//   move   F ↦ T(by) ∘ F
//   turn   a = F(ref) + about;  turn by `angle` about a
//   scale  p = F(ref);  stretch by `by` about p along the thing's own axes;
//          then T(shift)
//   erode  erosion += by
//   stand  the state is these numbers, whatever came before
//
// `ref` is a painted point: a point of the thing, in its rest frame, that the
// gesture put where the thing's middle was when it wrote the operation. From
// then on it is just a point of the thing, going wherever the thing takes it.
// Everything else — `about`, `shift`, `by` of a move — is in the axes of the
// frame the thing is held in, and does not turn when the thing turns upstream.
// So an upstream move is carried through a downstream turn unturned, an
// upstream spin in place leaves every downstream turn and scale where it was,
// and reshaping a thing upstream changes nothing about where a downstream
// operation acts, since `ref` is stored.
//
// Order
// -----
// At a keyframe, the contributions are the steps of repeats begun at earlier
// keyframes, oldest first, and then that keyframe's own entries in list order.
// Each is applied in turn, to the state the one before left.
//
// Repeats
// -------
// An entry may go on contributing after its own keyframe — `times` of them
// in all, or to the end — each time adjusted so that it acts about the same
// centre as the first:
//
//   turn   aboutₙ = R(angle)ⁿ · about
//   scale  shiftₙ = Mⁿ · shift        M = the stretch `by` in the axes `along`
//
// Each step has to ride every displacement of `ref` except the ones the repeat
// itself causes, and that comes out to these from the entry's own numbers. So
// a move by hand part way through carries the centre along, and a spin in
// place leaves it alone.
//
// A stand is the one operation that says nothing about what came before: it is
// how a thing stops hearing from upstream. The state is its numbers, corners
// and their depths included, and nothing written before it reaches past it —
// except the repeats still running, which go on taking their steps. Those are
// what the thing is doing rather than where it got to, and a stand that stopped
// them would change what is on screen from the moment it was written.
// -----------------------------------------------------------------------------

import { Point } from '@ce/game/world';
import { Affine, compose } from './affine';
import { GroupId, Id, PolygonId, Structure, Vertex, VertexId, enclosing } from './types';

export type KeyframeId = number;

export interface Keyframe {
  id: KeyframeId
  name: string
  /** Whether it draws as a ghost while another keyframe is on screen. */
  visible: boolean
}

/**
 * Where a thing is: a translation, an angle, and a scale along its own axes.
 *
 * `F(x) = t + R(angle) · diag(scale) · x`. Angles add and scale factors
 * multiply, and every operation keeps the frame in this family — which is why
 * a scale is along the thing's own axes: stretched along any others, a turned
 * thing would be sheared, and a shear is not a frame.
 */
export interface Frame {
  t: Point
  angle: number
  scale: { x: number, y: number }
}

/** Where a thing is before anything has happened to it: its rest geometry. */
export const REST: Frame = { t: { x: 0, y: 0 }, angle: 0, scale: { x: 1, y: 1 } };

export interface Move {
  kind: 'move'
  by: Point
}

export interface Turn {
  kind: 'turn'
  /** Unwrapped: 720° is two turns, and plays as two. */
  angle: number
  /** The painted point, in the thing's rest frame. */
  ref: Point
  /** The anchor, as an offset from where `ref` is when the turn begins. */
  about: Point
}

export interface Scale {
  kind: 'scale'
  /** Along the thing's own axes. Never zero on either. */
  by: { x: number, y: number }
  /** The painted point, in the thing's rest frame. */
  ref: Point
  /** Where scaling about the gesture's centre would have slid it, written
   * down as a slide. */
  shift: Point
  /** The angle the thing's axes had when it was written. Read only by
   * repeats. */
  along: number
}

export interface Erode {
  kind: 'erode'
  by: number
}

/**
 * A thing's state, outright: what unchaining writes.
 *
 * Everything the walk carries, frozen — the frame, the depth, which corners
 * stand and where, and the depths on single corners. Played, it replaces
 * whatever the walk had arrived at, so a thing standing on one stops hearing
 * from anything before it.
 */
export interface Stand {
  kind: 'stand'
  frame: Frame
  erosion: number
  /** Where each corner stood, in the rest frame, and by which ids are in it,
   * which corners there were. */
  corners: ReadonlyMap<VertexId, Point>
  depths: ReadonlyMap<VertexId, number>
}

export type Op = Move | Turn | Scale | Erode | Stand;

export interface Entry<O extends Op = Op> {
  op: O
  /** How many keyframes it contributes to: 1 is once, `null` is to the end. */
  times: number | null
  /** Keyframes where a step is left out. A skipped keyframe is not counted. */
  skip: ReadonlySet<KeyframeId>
}

/**
 * Everything written about one thing.
 *
 * The corners have maps of their own rather than a place in the list: a nudge
 * or a depth is about one corner, and there is only ever one per corner per
 * keyframe, so there is no order among them to keep.
 */
export interface Rig {
  keys: ReadonlyMap<KeyframeId, readonly Entry[]>
  /** Moves of single corners, in the rest frame. */
  nudges: ReadonlyMap<VertexId, ReadonlyMap<KeyframeId, Entry<Move>>>
  /** Extra depth on single corners, over the thing's own. */
  depths: ReadonlyMap<VertexId, ReadonlyMap<KeyframeId, Entry<Erode>>>
}

export const EMPTY_RIG: Rig = { keys: new Map(), nudges: new Map(), depths: new Map() };

const NEVER: ReadonlySet<KeyframeId> = new Set();

/** An entry that contributes once, at its own keyframe. */
export function once<O extends Op>(op: O): Entry<O> {
  return { op, times: 1, skip: NEVER };
}

/** An entry that goes on contributing: `times` in all, or to the end. */
export function repeating<O extends Op>(
  op: O,
  times: number | null,
  skip: ReadonlySet<KeyframeId> = NEVER,
): Entry<O> {
  return { op, times, skip };
}

/**
 * What the walk needs to know about a world: the keyframes, what is written,
 * and when each thing begins. Structural, so that a world is one and so is a
 * test's handful of maps.
 */
interface Lived {
  birth: KeyframeId
}

export interface Timeline extends Structure {
  keyframes: readonly Keyframe[]
  rigs: ReadonlyMap<Id, Rig>
  polygons: ReadonlyMap<PolygonId, Lived & { points: readonly Vertex[] }>
  groups: ReadonlyMap<GroupId, Lived & { members: readonly Id[] }>
  artefacts: ReadonlyMap<Id, Lived>
  paths: ReadonlyMap<Id, Lived>
}

/** A thing as a keyframe leaves it. */
export interface State {
  /** In the frame of whatever holds it. */
  frame: Frame
  erosion: number
  /** The corners standing, by id, at their rest-frame positions with every
   * nudge in. Empty for anything without a ring. */
  corners: ReadonlyMap<VertexId, Point>
  /** The extra depth on single corners. Absent is nought. */
  depths: ReadonlyMap<VertexId, number>
}

const NO_CORNERS: ReadonlyMap<VertexId, Point> = new Map();
const NO_DEPTHS: ReadonlyMap<VertexId, number> = new Map();

/** What a thing is before it is born, and what anything the world does not
 * know is: at rest, with nothing on it. */
const UNBORN: State = { frame: REST, erosion: 0, corners: NO_CORNERS, depths: NO_DEPTHS };

// -----------------------------------------------------------------------------
// Frames
// -----------------------------------------------------------------------------

/** A rest-frame point, placed. */
export function placed(f: Frame, p: Point): Point {
  const c = Math.cos(f.angle), s = Math.sin(f.angle);
  const x = p.x * f.scale.x, y = p.y * f.scale.y;

  return { x: f.t.x + c * x - s * y, y: f.t.y + s * x + c * y };
}

/** The frame as a matrix, for composing with whatever holds it. */
export function affineOf(f: Frame): Affine {
  const c = Math.cos(f.angle), s = Math.sin(f.angle);

  return {
    a: c * f.scale.x,
    b: s * f.scale.x,
    c: -s * f.scale.y,
    d: c * f.scale.y,
    tx: f.t.x,
    ty: f.t.y,
  };
}

/**
 * A matrix as a frame, or nothing where it is not one: sheared, mirrored or
 * singular.
 */
export function framed(m: Affine): Frame | null {
  const x = Math.hypot(m.a, m.b);
  const angle = Math.atan2(m.b, m.a);
  const c = Math.cos(angle), s = Math.sin(angle);
  const y = m.d * c - m.c * s;

  // Whatever of the second column lies along the first. Nothing for a frame.
  const skew = m.c * c + m.d * s;

  if (x === 0 || y <= 0) return null;
  if (Math.abs(skew) > 1e-9 * Math.max(1, x, y)) return null;

  return { t: { x: m.tx, y: m.ty }, angle, scale: { x, y } };
}

/** A vector turned. */
export function spun(v: Point, angle: number): Point {
  if (angle === 0) return v;

  const c = Math.cos(angle), s = Math.sin(angle);

  return { x: c * v.x - s * v.y, y: s * v.x + c * v.y };
}

/** `(1 − dᵘ) / (1 − d)`: how much of a scale's slide has happened when `u` of
 * the scale has. See `played`. */
function slid(d: number, u: number): number {
  const l = Math.log(d);

  return Math.abs(l) < 1e-12 ? u : Math.expm1(u * l) / Math.expm1(l);
}

/**
 * One operation, `u` of the way through, applied to the frame it starts from.
 *
 * All of it at `u = 1`, and exactly so: nothing is eased at the end, because
 * the end is where the next keyframe's state is and the two have to be the
 * same numbers.
 *
 * Part way, each kind goes the way it would have gone under the hand. A move
 * goes in a line; a turn goes round its own anchor, which is placed off the
 * frame it starts from, so a turn after a move in the same keyframe turns about
 * a centre that is itself moving; a scale grows by `byᵘ` about its painted
 * point, and its slide eases with it — by `(1 − dᵘ) / (1 − d)` along each of the
 * thing's axes, which is exactly what keeps the gesture's own centre still. A
 * stand goes straight to its numbers, component by component: the two ends of
 * it are not two readings of one motion, and there is no motion to follow.
 */
export function played(f: Frame, op: Op, u = 1): Frame {
  switch (op.kind) {
    case 'move':
      return { ...f, t: { x: f.t.x + op.by.x * u, y: f.t.y + op.by.y * u } };

    case 'turn': {
      const p = placed(f, op.ref);
      const a = { x: p.x + op.about.x, y: p.y + op.about.y };
      const angle = op.angle * u;
      const d = spun({ x: f.t.x - a.x, y: f.t.y - a.y }, angle);

      return { ...f, t: { x: a.x + d.x, y: a.y + d.y }, angle: f.angle + angle };
    }

    case 'scale': {
      const p = placed(f, op.ref);
      const dx = u === 1 ? op.by.x : Math.pow(op.by.x, u);
      const dy = u === 1 ? op.by.y : Math.pow(op.by.y, u);

      // The stretch along the thing's own axes, about the painted point.
      const own = spun({ x: f.t.x - p.x, y: f.t.y - p.y }, -f.angle);
      const back = spun({ x: own.x * dx, y: own.y * dy }, f.angle);

      let slide = op.shift;

      if (u !== 1) {
        const s = spun(op.shift, -f.angle);

        slide = spun({ x: s.x * slid(op.by.x, u), y: s.y * slid(op.by.y, u) }, f.angle);
      }

      return {
        t: { x: p.x + back.x + slide.x, y: p.y + back.y + slide.y },
        angle: f.angle,
        scale: { x: f.scale.x * dx, y: f.scale.y * dy },
      };
    }

    case 'erode':
      return f;

    case 'stand':
      if (u === 1) return op.frame;

      return {
        t: { x: mix(f.t.x, op.frame.t.x, u), y: mix(f.t.y, op.frame.t.y, u) },
        angle: mix(f.angle, op.frame.angle, u),
        scale: { x: mix(f.scale.x, op.frame.scale.x, u), y: mix(f.scale.y, op.frame.scale.y, u) },
      };
  }
}

function mix(a: number, b: number, u: number): number {
  return a + (b - a) * u;
}

/**
 * The `n`-th step of a repeat: its operation, adjusted to act about the same
 * centre the first one did. Nought is the entry itself.
 */
export function stepped(op: Op, n: number): Op {
  if (n === 0) return op;

  if (op.kind === 'turn') return { ...op, about: spun(op.about, op.angle * n) };

  if (op.kind === 'scale') {
    const s = spun(op.shift, -op.along);

    return {
      ...op,
      shift: spun({ x: s.x * Math.pow(op.by.x, n), y: s.y * Math.pow(op.by.y, n) }, op.along),
    };
  }

  return op;
}

// -----------------------------------------------------------------------------
// The walk
// -----------------------------------------------------------------------------

const indices = new WeakMap<readonly Keyframe[], ReadonlyMap<KeyframeId, number>>();

/** Where a keyframe is in the order, or -1 where it is not in it at all. */
export function indexIn(keyframes: readonly Keyframe[], k: KeyframeId): number {
  let held = indices.get(keyframes);

  if (held === undefined) {
    held = new Map(keyframes.map((f, i) => [f.id, i]));
    indices.set(keyframes, held);
  }

  return held.get(k) ?? -1;
}

/** When a thing begins and, for a polygon, the corners it has ever had. */
function lived(tl: Timeline, id: Id): (Lived & { points?: readonly Vertex[] }) | undefined {
  return tl.polygons.get(id) ?? tl.groups.get(id) ?? tl.artefacts.get(id) ?? tl.paths.get(id);
}

interface Walked {
  rig: Rig
  thing: object
  /** The ids the walk was taken over, in order. Not the array: a keyframe
   * that changes its name or its eye changes nothing here. */
  order: KeyframeId[]
  states: (State | undefined)[]
  played: Op[][]
}

/**
 * Every walk taken, by the rig it was taken over — or by the thing, for the
 * ones nobody has written anything about.
 *
 * A rig is persistent, so an edit to one thing leaves every other thing's walk
 * where it is. What it is checked against on the way out is the rest of what
 * the walk read: the thing itself, whose corners it placed, and the order of
 * the keyframes.
 */
const walks = new WeakMap<object, Walked>();

function walked(tl: Timeline, id: Id): Walked | null {
  const thing = lived(tl, id);

  if (thing === undefined) return null;

  const rig = tl.rigs.get(id) ?? EMPTY_RIG;
  const key = rig === EMPTY_RIG ? thing : rig;
  const held = walks.get(key);

  if (held !== undefined && held.rig === rig && held.thing === thing && same(held.order, tl.keyframes)) {
    return held;
  }

  // A group's from the first keyframe, whenever it was made. Membership is one
  // fact about the world rather than something a keyframe does, so a group made
  // while standing at v3 holds its members at v0 too, and can be moved there.
  const from = tl.groups.has(id) ? tl.keyframes[0]?.id ?? thing.birth : thing.birth;
  const out = walk(tl, rig, thing, from);

  walks.set(key, out);

  return out;
}

function same(order: readonly KeyframeId[], keyframes: readonly Keyframe[]): boolean {
  return order.length === keyframes.length && order.every((k, i) => keyframes[i].id === k);
}

/** A repeat under way: its entry, and how many steps it has taken. */
interface Running {
  entry: Entry
  steps: number
}

function walk(
  tl: Timeline,
  rig: Rig,
  thing: Lived & { points?: readonly Vertex[] },
  from: KeyframeId,
): Walked {
  const keyframes = tl.keyframes;
  const n = keyframes.length;
  const born = indexIn(keyframes, from);

  const out: Walked = {
    rig,
    thing,
    order: keyframes.map(f => f.id),
    states: new Array(n).fill(undefined),
    played: Array.from({ length: n }, () => []),
  };

  if (born < 0) return out;

  const corners = (thing.points ?? []).map(c => ({
    corner: c,
    birth: indexIn(keyframes, c.birth),
    death: c.death === null ? Infinity : orNever(indexIn(keyframes, c.death)),
  }));

  let frame = REST;
  let erosion = 0;
  let running: Running[] = [];

  // The last stand played, and where. Corners and their depths are read from
  // it rather than from the rest geometry, and nothing written before it
  // reaches past it but the steps of what repeats.
  let stood: { at: number, op: Stand } | null = null;

  for (let i = born; i < n; i++) {
    const key = keyframes[i].id;
    const ops = out.played[i];

    const apply = (op: Op): void => {
      ops.push(op);

      if (op.kind === 'erode') {
        erosion += op.by;
      }
      else if (op.kind === 'stand') {
        frame = op.frame;
        erosion = op.erosion;
      }
      else {
        frame = played(frame, op);
      }
    };

    // The steps of repeats begun earlier, oldest first. A skipped keyframe
    // is not a step: the repeat waits over it and carries its count on.
    const going: Running[] = [];

    for (const r of running) {
      if (r.entry.skip.has(key)) {
        going.push(r);
        continue;
      }

      if (r.entry.times !== null && r.steps + 1 >= r.entry.times) continue;

      r.steps += 1;
      apply(stepped(r.entry.op, r.steps));
      going.push(r);
    }

    running = going;

    for (const e of rig.keys.get(key) ?? []) {
      apply(e.op);

      if (e.op.kind === 'stand') {
        stood = { at: i, op: e.op };
      }
      else if (e.times === null || e.times > 1) {
        running.push({ entry: e, steps: 0 });
      }
    }

    out.states[i] = {
      frame,
      erosion,
      corners: corners.length === 0 ? NO_CORNERS : standingAt(keyframes, rig, corners, stood, i),
      depths: corners.length === 0 ? NO_DEPTHS : deepAt(keyframes, rig, corners, stood, i),
    };
  }

  return out;
}

/** A keyframe index where the keyframe may be missing, which is never. */
function orNever(i: number): number {
  return i < 0 ? Infinity : i;
}

interface Placing {
  corner: Vertex
  birth: number
  death: number
}

/**
 * Whether a corner is standing at `i`, and the index its own writing counts
 * from: its birth, or the stand that froze it.
 *
 * Under a stand, the corners are the ones it froze and the ones born since,
 * and only a death since takes one away — upstream has stopped being asked.
 */
function counted(c: Placing, stood: { at: number, op: Stand } | null, i: number): number | null {
  if (stood === null) return c.birth >= 0 && c.birth <= i && c.death > i ? c.birth : null;

  const gone = c.death >= stood.at && c.death <= i;

  if (stood.op.corners.has(c.corner.id)) return gone ? null : stood.at;

  return c.birth >= stood.at && c.birth <= i && !gone ? c.birth : null;
}

function standingAt(
  keyframes: readonly Keyframe[],
  rig: Rig,
  corners: readonly Placing[],
  stood: { at: number, op: Stand } | null,
  i: number,
): Map<VertexId, Point> {
  const out = new Map<VertexId, Point>();

  for (const c of corners) {
    const from = counted(c, stood, i);

    if (from === null) continue;

    const base = stood?.op.corners.get(c.corner.id) ?? c.corner.at;
    let x = base.x, y = base.y;

    for (const [k, e] of rig.nudges.get(c.corner.id) ?? []) {
      const n = applications(keyframes, e, k, from, i);

      x += e.op.by.x * n;
      y += e.op.by.y * n;
    }

    out.set(c.corner.id, { x, y });
  }

  return out;
}

function deepAt(
  keyframes: readonly Keyframe[],
  rig: Rig,
  corners: readonly Placing[],
  stood: { at: number, op: Stand } | null,
  i: number,
): ReadonlyMap<VertexId, number> {
  if (rig.depths.size === 0 && (stood === null || stood.op.depths.size === 0)) return NO_DEPTHS;

  const out = new Map<VertexId, number>();

  for (const c of corners) {
    const from = counted(c, stood, i);

    if (from === null) continue;

    let d = stood?.op.depths.get(c.corner.id) ?? 0;

    for (const [k, e] of rig.depths.get(c.corner.id) ?? []) {
      d += e.op.by * applications(keyframes, e, k, from, i);
    }

    if (d !== 0) out.set(c.corner.id, d);
  }

  return out;
}

/**
 * How many times an entry written at `k` has contributed by `i`, counting only
 * what it did after `from` if it was written before it.
 *
 * The same count the walk keeps for the list — once at its own keyframe, and
 * once more at each unskipped one after it while it has steps left — worked
 * out directly, since a corner's moves commute and there is no order to play
 * them in. `from` is a stand, or the corner's own birth: a stand holds what
 * came before it, the steps it was written over included, and what a repeat
 * does afterwards is all that is left of it.
 */
function applications(
  keyframes: readonly Keyframe[],
  e: Entry,
  k: KeyframeId,
  from: number,
  i: number,
): number {
  const j = indexIn(keyframes, k);

  if (j < 0 || j > i) return 0;

  return j >= from ? counted1(keyframes, e, j, i) : counted1(keyframes, e, j, i) - counted1(keyframes, e, j, from);
}

/** How many times an entry written at index `j` has contributed by `i`. */
function counted1(keyframes: readonly Keyframe[], e: Entry, j: number, i: number): number {
  let steps = 0;

  for (let m = j + 1; m <= i; m++) {
    if (!e.skip.has(keyframes[m].id)) steps++;
  }

  return 1 + (e.times === null ? steps : Math.min(steps, e.times - 1));
}

/** A thing's state at a keyframe: at rest before it is born, and wherever the
 * world has no such thing. */
export function stateAt(tl: Timeline, id: Id, k: KeyframeId): State {
  const i = indexIn(tl.keyframes, k);

  return (i < 0 ? undefined : walked(tl, id)?.states[i]) ?? UNBORN;
}

/**
 * What a keyframe does to a thing, in the order it does it: the steps of
 * repeats begun earlier, each adjusted, and then its own entries.
 *
 * Played one after another from the state the keyframe before left, these are
 * that state carried to this one. What the bake puts in flight over a span.
 */
export function playedAt(tl: Timeline, id: Id, k: KeyframeId): readonly Op[] {
  const i = indexIn(tl.keyframes, k);

  return (i < 0 ? undefined : walked(tl, id)?.played[i]) ?? [];
}

/** A thing's frame at a keyframe in world units: its own, and every group
 * holding it, each at that keyframe. */
export function worldFrame(tl: Timeline, id: Id, k: KeyframeId): Affine {
  return compose(heldFrame(tl, id, k), affineOf(stateAt(tl, id, k).frame));
}

/**
 * The frame a thing's own frame is read in: whatever holds it, in world
 * units, and the identity at the top level.
 *
 * What a gesture takes the cursor back through before it writes anything,
 * because an operation's anchors and slides are in these axes.
 */
export function heldFrame(tl: Timeline, id: Id, k: KeyframeId): Affine {
  const up = enclosing(tl, id);
  let m: Affine = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

  for (let i = up.length - 1; i >= 0; i--) m = compose(m, affineOf(stateAt(tl, up[i], k).frame));

  return m;
}

// -----------------------------------------------------------------------------
// Writing
// -----------------------------------------------------------------------------

/** Whether an operation does nothing, which a gesture that has come back to
 * where it started writes rather than an entry. */
export function trivial(op: Op): boolean {
  switch (op.kind) {
    case 'move':
      return op.by.x === 0 && op.by.y === 0;
    case 'turn':
      return Math.abs(op.angle) < 1e-12;
    case 'scale':
      return op.by.x === 1 && op.by.y === 1 && op.shift.x === 0 && op.shift.y === 0;
    case 'erode':
      return op.by === 0;
    case 'stand':
      return false;
  }
}

/** Two points the same to within the arithmetic that produced them. */
function near(p: Point, q: Point): boolean {
  const scale = Math.max(1, Math.abs(p.x), Math.abs(p.y), Math.abs(q.x), Math.abs(q.y));

  return Math.abs(p.x - q.x) <= 1e-9 * scale && Math.abs(p.y - q.y) <= 1e-9 * scale;
}

function sameSkip(a: ReadonlySet<KeyframeId>, b: ReadonlySet<KeyframeId>): boolean {
  return a.size === b.size && [...a].every(k => b.has(k));
}

/**
 * `b` folded into `a`, where that is exact: the entry that does both, or
 * `'gone'` where together they do nothing, or nothing where they cannot be one.
 *
 * Only ever what a hand repeating itself writes. Two moves add, and so do two
 * erosions. Two scales about the same painted point multiply, and their slides
 * add — the second's is taken from where the first left the painted point, and
 * that is where the combined one's is taken from too. Two turns about the same
 * centre add; the second's offset from the painted point is the first's turned
 * with it, since that is where the painted point went, and the one they make
 * keeps the first's.
 */
function merged(a: Entry, b: Entry): Entry | 'gone' | null {
  if (a.times !== b.times || !sameSkip(a.skip, b.skip)) return null;

  const x = a.op, y = b.op;
  let op: Op | null = null;

  if (x.kind === 'move' && y.kind === 'move') {
    op = { kind: 'move', by: { x: x.by.x + y.by.x, y: x.by.y + y.by.y } };
  }
  else if (x.kind === 'erode' && y.kind === 'erode') {
    op = { kind: 'erode', by: x.by + y.by };
  }
  else if (x.kind === 'turn' && y.kind === 'turn') {
    if (!near(x.ref, y.ref) || !near(spun(x.about, x.angle), y.about)) return null;

    op = { ...x, angle: x.angle + y.angle };
  }
  else if (x.kind === 'scale' && y.kind === 'scale') {
    if (!near(x.ref, y.ref) || x.along !== y.along) return null;

    op = {
      ...x,
      by: { x: x.by.x * y.by.x, y: x.by.y * y.by.y },
      shift: { x: x.shift.x + y.shift.x, y: x.shift.y + y.shift.y },
    };
  }

  if (op === null) return null;

  return trivial(op) || (op.kind === 'scale' && nearlyNothing(op)) ? 'gone' : { ...a, op };
}

/** A scale that has come back to nothing, up to the arithmetic. */
function nearlyNothing(op: Scale): boolean {
  return Math.abs(op.by.x - 1) < 1e-12 && Math.abs(op.by.y - 1) < 1e-12
    && near(op.shift, { x: 0, y: 0 });
}

/**
 * `entry` added to the end of a keyframe's list, folded into the last entry
 * where the two are exactly one, and left off where it does nothing.
 *
 * A gesture recomputes from the list it started with every time the hand
 * moves, so what it leaves is one entry however long it went on.
 */
export function appending(list: readonly Entry[], entry: Entry): readonly Entry[] {
  if (trivial(entry.op)) return list;

  const last = list[list.length - 1];
  const both = last === undefined ? null : merged(last, entry);

  if (both === null) return [...list, entry];

  const head = list.slice(0, -1);

  return both === 'gone' ? head : [...head, both];
}

/** A keyframe's list replaced. An empty one is taken out of the map. */
export function withKeys(rig: Rig, k: KeyframeId, list: readonly Entry[]): Rig {
  const keys = new Map(rig.keys);

  if (list.length === 0) keys.delete(k);
  else keys.set(k, list);

  return { ...rig, keys };
}

/**
 * One corner's entry at a keyframe added to, the way a hand adds to it: a
 * nudge moves it further, a depth goes deeper. One that comes back to nothing
 * is taken out.
 *
 * Its repeat is kept: what is added to is how far each step goes.
 */
export function nudged(rig: Rig, vertex: VertexId, k: KeyframeId, by: Point): Rig {
  const was = rig.nudges.get(vertex)?.get(k);
  const sum = { x: (was?.op.by.x ?? 0) + by.x, y: (was?.op.by.y ?? 0) + by.y };
  const entry = sum.x === 0 && sum.y === 0
    ? null
    : { ...(was ?? once<Move>({ kind: 'move', by: sum })), op: { kind: 'move' as const, by: sum } };

  return { ...rig, nudges: cornered(rig.nudges, vertex, k, entry) };
}

export function deepened(rig: Rig, vertex: VertexId, k: KeyframeId, by: number): Rig {
  const was = rig.depths.get(vertex)?.get(k);
  const sum = (was?.op.by ?? 0) + by;
  const entry = sum === 0
    ? null
    : { ...(was ?? once<Erode>({ kind: 'erode', by: sum })), op: { kind: 'erode' as const, by: sum } };

  return { ...rig, depths: cornered(rig.depths, vertex, k, entry) };
}

function cornered<E>(
  maps: ReadonlyMap<VertexId, ReadonlyMap<KeyframeId, E>>,
  vertex: VertexId,
  k: KeyframeId,
  entry: E | null,
): ReadonlyMap<VertexId, ReadonlyMap<KeyframeId, E>> {
  const out = new Map(maps);
  const mine = new Map(maps.get(vertex) ?? []);

  if (entry === null) mine.delete(k);
  else mine.set(k, entry);

  if (mine.size === 0) out.delete(vertex);
  else out.set(vertex, mine);

  return out;
}
