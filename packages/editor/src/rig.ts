// -----------------------------------------------------------------------------
// Timelines of operations
//
// What happens to a thing is a list of operations per keyframe, and where it
// is at a keyframe is those lists played from its birth onward. Nothing else:
// no layer to inherit, nothing composed into anything, nothing solved for
// after an edit.
//
// A thing's state is its frame — `F(x) = t + R(angle) · K(skew) · S · x` over
// its rest geometry, in the frame of whatever holds it — together with how deep it is
// eroded and where its corners stand. An operation is written against the
// frame at the start of *that operation*, and says what it means:
//
//   move   F ↦ T(by) ∘ F
//   turn   a = F(ref) + about;  turn by `angle` about a
//   scale  p = F(ref);  stretch by `by` about p along the thing's own axes;
//          then T(shift)
//   skew   p = F(ref);  shear by `by` about p along the thing's first axis;
//          then T(shift)
//   erode  erosion += by
//   round  bevel += by
//   deform amplitude += by
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
//   skew   shiftₙ = Xⁿ · shift        X = the shear `by` along `along`
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
import { CORNER_KINDS, CORNER_MAPS } from './cornermaps';
import type { CornerMap } from './cornermaps';
import { GroupId, Id, PolygonId, Structure, Vertex, VertexId, enclosing } from './types';

export type KeyframeId = number;

export interface Keyframe {
  id: KeyframeId
  name: string
  /** Whether it draws as a ghost while another keyframe is on screen. */
  visible: boolean
}

/**
 * Where a thing is: a translation, an angle, a skew, and a scale along its own
 * axes.
 *
 * `F(x) = t + R(angle) · K(skew) · diag(scale) · x`, with `K(k) = [[1, k],
 * [0, 1]]` — every affine map that does not mirror. Angles add, skews add and
 * scale factors multiply. The skew is there because a group squashed across a
 * member turned against it shears the member, and without it that shear would
 * exist nowhere but in the nesting. The stretch applies before the skew, so a
 * scale along the thing's own axes stays one whatever it is held in.
 */
export interface Frame {
  t: Point
  angle: number
  skew: number
  scale: { x: number, y: number }
}

/** Where a thing is before anything has happened to it: its rest geometry. */
export const REST: Frame = { t: { x: 0, y: 0 }, angle: 0, skew: 0, scale: { x: 1, y: 1 } };

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
  /** The skew they had then. Read only by repeats. */
  lean: number
}

/**
 * A shear along the thing's first axis. No gesture writes one: it is what
 * ungrouping says where the group had sheared the thing.
 */
export interface Skew {
  kind: 'skew'
  /** Added to the frame's skew. */
  by: number
  /** The painted point, in the thing's rest frame. */
  ref: Point
  shift: Point
  /** The angle the thing's first axis had when it was written. Read only by
   * repeats. */
  along: number
}

/**
 * How much of something a thing has, rather than where it is: how deep it is
 * eroded, how far its corners are rounded — its bevel, how deep along each
 * edge from the corner the arc each becomes starts — and how far its edges
 * are pushed off their lines, the amplitude of the pattern each carries.
 *
 * One operation for the three because they *are* one operation: a number that
 * adds to a running total and commutes with the frame and with each other.
 * Nothing about a bevel, a depth or an amplitude tells them apart here; what
 * does is the geometry each drives, and that lives in `geometry.ts`. How
 * precisely a round is faceted, and what pattern a deform carries, are not
 * operations but facts about the thing, over every keyframe: see `Effects`
 * in `types.ts`.
 *
 * They were three interfaces of identical shape, and the cost of that was
 * paid everywhere but here. Every switch over `Op` carried three labels for
 * one behaviour, `merged` had three cases adding two numbers, the walk had
 * three branches incrementing three fields, and `amounted` — which is one
 * function over all three — had to cast its way back out of the union it
 * had been handed. Adding a fourth amount meant finding all of them. One
 * type with a `kind` says what the three had in common, and the places that
 * genuinely differ by kind now say so by looking a name up in `AMOUNTS`
 * rather than by branching.
 */
export interface Amount<K extends AmountKind = AmountKind> {
  kind: K
  by: number
}

/** Which amount: the one place that lists them. */
export const AMOUNT_KINDS = ['erode', 'round', 'deform'] as const;

export type AmountKind = typeof AMOUNT_KINDS[number];

/** Whether an operation is an amount. */
export function amount(op: Op): op is Amount {
  return (AMOUNT_KINDS as readonly string[]).includes(op.kind);
}

/**
 * What each amount is called where a state keeps it: its running total, and
 * the extra on single corners — for a deform, on single edges, by the corner
 * each starts at. With the rig map the entries for those live in.
 *
 * The one place the three are named, so the walk, `stateAt` and a stand read
 * them by kind rather than by hand. See `Amount`.
 */
export const AMOUNTS = {
  erode: { total: 'erosion', each: 'depths', map: 'depths' },
  round: { total: 'bevel', each: 'bevels', map: 'rounds' },
  deform: { total: 'amplitude', each: 'amplitudes', map: 'deforms' },
} as const satisfies { [K in AmountKind]: {
  total: keyof State & keyof Stand,
  each: keyof State & keyof Stand,
  /** The map whose `CORNER_KINDS` entry is this kind, so the two tables
   * cannot disagree about which map holds what. */
  map: { [M in CornerMap]: typeof CORNER_KINDS[M] extends K ? M : never }[CornerMap],
} };

/**
 * A thing's state, outright: what unchaining writes.
 *
 * Everything the walk carries, frozen — the frame, the depth, bevel and
 * amplitude, which corners stand and where, and the amounts on single corners
 * and edges. Played, it replaces
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
  bevel: number
  amplitude: number
  bevels: ReadonlyMap<VertexId, number>
  amplitudes: ReadonlyMap<VertexId, number>
}

export type Op = Move | Turn | Scale | Skew | Amount | Stand;

/** How long something written at a keyframe goes on contributing: what the
 * counting below needs of an entry, and all of it. A key in `key.ts` is one of
 * these too. */
export interface Repeat {
  /** How many keyframes it contributes to, one after another from its own: 1
   * is once, `null` is to the end. */
  times: number | null
  /** Keyframes after its own where it waits. See `Entry`. */
  skip?: ReadonlySet<KeyframeId>
}

export interface Entry<O extends Op = Op> extends Repeat {
  op: O
  /** How many keyframes it contributes to, one after another from its own: 1
   * is once, `null` is to the end. */
  times: number | null
  /**
   * Keyframes after its own where a repeat takes no step: it waits over them
   * and carries its count on, so a skipped keyframe is not counted. What an
   * inserted keyframe writes onto every repeat running across it, so that it
   * is a keyframe where nothing happens. Absent is none.
   */
  skip?: ReadonlySet<KeyframeId>
  /**
   * The gesture that last wrote what it does, by an id of its own: entries
   * with one, at one keyframe, are picked together in the keyframe view. A
   * hint rather than a structure — nothing holds a gesture's entries to each
   * other, and one lost costs a pick one entry at a time. Absent is none. See
   * `gestured` in `types.ts`.
   */
  gesture?: number
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
  depths: ReadonlyMap<VertexId, ReadonlyMap<KeyframeId, Entry<Amount<'erode'>>>>
  /** Extra bevel on single corners, over the thing's own. */
  rounds: ReadonlyMap<VertexId, ReadonlyMap<KeyframeId, Entry<Amount<'round'>>>>
  /** Extra amplitude on single edges, over the thing's own, each by the
   * corner it starts at. */
  deforms: ReadonlyMap<VertexId, ReadonlyMap<KeyframeId, Entry<Amount<'deform'>>>>
}

export type { CornerKind, CornerMap } from './cornermaps';
export { CORNER_KINDS, CORNER_MAPS, cornerMapOf, eachCornerMap } from './cornermaps';

export const EMPTY_RIG: Rig = { keys: new Map(), nudges: new Map(), depths: new Map(), rounds: new Map(), deforms: new Map() };

/** Whether nothing at all is written in a rig. */
export function blank(rig: Rig): boolean {
  return rig.keys.size === 0 && CORNER_MAPS.every(m => rig[m].size === 0);
}

/** An entry that contributes once, at its own keyframe. */
export function once<O extends Op>(op: O): Entry<O> {
  return { op, times: 1 };
}

/** An entry that goes on contributing: `times` in all, or to the end. */
export function repeating<O extends Op>(op: O, times: number | null, skip?: ReadonlySet<KeyframeId>): Entry<O> {
  return skip === undefined || skip.size === 0 ? { op, times } : { op, times, skip };
}

/**
 * An entry written at `k`, with only the skips that still mean something
 * there: keyframes that exist and come after it. What an entry keeps when it
 * is moved, copied or carried to a keyframe of its own.
 */
export function skipping<E extends Entry>(keyframes: readonly Keyframe[], e: E, k: KeyframeId): E {
  if (e.skip === undefined) return e;

  const at = indexIn(keyframes, k);
  const skip = new Set([...e.skip].filter(s => indexIn(keyframes, s) > at));

  if (skip.size === e.skip.size) return e;

  const { skip: _gone, ...rest } = e;

  return (skip.size === 0 ? rest : { ...rest, skip }) as E;
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
  /** No birth: a group is one fact about the world at every keyframe, and its
   * timeline plays from the first. */
  groups: ReadonlyMap<GroupId, { members: readonly Id[] }>
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
  /** How far its corners are rounded, and its edges deformed: what its
   * rounds and deforms add up to. */
  bevel: number
  amplitude: number
  /** The extra bevel on single corners, and amplitude on single edges by
   * the corner each starts at. Absent is nought. */
  bevels: ReadonlyMap<VertexId, number>
  amplitudes: ReadonlyMap<VertexId, number>
}

export const NO_CORNERS: ReadonlyMap<VertexId, Point> = new Map();
export const NO_DEPTHS: ReadonlyMap<VertexId, number> = new Map();

/** What a thing is before it is born, and what anything the world does not
 * know is: at rest, with nothing on it. */
export const UNBORN: State = {
  frame: REST,
  erosion: 0,
  corners: NO_CORNERS,
  depths: NO_DEPTHS,
  bevel: 0,
  amplitude: 0,
  bevels: NO_DEPTHS,
  amplitudes: NO_DEPTHS,
};

// -----------------------------------------------------------------------------
// Frames
// -----------------------------------------------------------------------------

/** A rest-frame point, placed. */
export function placed(f: Frame, p: Point): Point {
  const v = linear(f, p);

  return { x: f.t.x + v.x, y: f.t.y + v.y };
}

/** A vector through a frame's linear part: `R · K · S · v`. */
export function linear(f: Frame, v: Point): Point {
  return sheared({ x: v.x * f.scale.x, y: v.y * f.scale.y }, f.angle, f.skew);
}

/** A vector through `R(angle) · K(skew)`: the thing's own axes, unscaled. */
export function sheared(v: Point, angle: number, skew: number): Point {
  return spun({ x: v.x + skew * v.y, y: v.y }, angle);
}

/** A vector back through `R(angle) · K(skew)`. */
export function unsheared(v: Point, angle: number, skew: number): Point {
  const w = spun(v, -angle);

  return { x: w.x - skew * w.y, y: w.y };
}

/** The frame as a matrix, for composing with whatever holds it. */
export function affineOf(f: Frame): Affine {
  const c = Math.cos(f.angle), s = Math.sin(f.angle);
  const k = f.skew * f.scale.y;

  return {
    a: c * f.scale.x,
    b: s * f.scale.x,
    c: c * k - s * f.scale.y,
    d: s * k + c * f.scale.y,
    tx: f.t.x,
    ty: f.t.y,
  };
}

/**
 * A matrix as a frame, exactly, or nothing where it is not one: mirrored or
 * singular.
 *
 * The first column gives the angle and the first scale; the second, turned
 * back by that angle, is `(skew · y, y)`.
 */
export function framed(m: Affine): Frame | null {
  const x = Math.hypot(m.a, m.b);
  const angle = Math.atan2(m.b, m.a);
  const c = Math.cos(angle), s = Math.sin(angle);
  const y = m.d * c - m.c * s;

  if (x === 0 || y <= 0) return null;

  return { t: { x: m.tx, y: m.ty }, angle, skew: (m.c * c + m.d * s) / y, scale: { x, y } };
}

/** A vector turned. */
export function spun(v: Point, angle: number): Point {
  if (angle === 0) return v;

  const c = Math.cos(angle), s = Math.sin(angle);

  return { x: c * v.x - s * v.y, y: s * v.x + c * v.y };
}

/** `(1 − dᵘ) / (1 − d)`: how much of a scale's slide has happened when `u` of
 * the scale has. See `played`. */
export function slid(d: number, u: number): number {
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
 * skew goes `u · by` about its painted point, and `u` of its slide with it. A
 * stand goes straight to its numbers, component by component: the two ends of
 * it are not two readings of one motion, and there is no motion to follow.
 */
export function played(f: Frame, op: Op, u = 1): Frame {
  // An amount is not where a thing is, so it leaves the frame alone.
  if (amount(op)) return f;

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
      const own = unsheared({ x: f.t.x - p.x, y: f.t.y - p.y }, f.angle, f.skew);
      const back = sheared({ x: own.x * dx, y: own.y * dy }, f.angle, f.skew);

      let slide = op.shift;

      if (u !== 1) {
        const s = unsheared(op.shift, f.angle, f.skew);

        slide = sheared({ x: s.x * slid(op.by.x, u), y: s.y * slid(op.by.y, u) }, f.angle, f.skew);
      }

      return {
        ...f,
        t: { x: p.x + back.x + slide.x, y: p.y + back.y + slide.y },
        scale: { x: f.scale.x * dx, y: f.scale.y * dy },
      };
    }

    case 'skew': {
      // A shear is linear in how far it goes, so its slide is too.
      const p = placed(f, op.ref);
      const by = op.by * u;
      const w = spun({ x: f.t.x - p.x, y: f.t.y - p.y }, -f.angle);
      const back = spun({ x: w.x + by * w.y, y: w.y }, f.angle);

      return {
        ...f,
        t: { x: p.x + back.x + op.shift.x * u, y: p.y + back.y + op.shift.y * u },
        skew: f.skew + by,
      };
    }

    case 'stand':
      if (u === 1) return op.frame;

      return {
        t: { x: mix(f.t.x, op.frame.t.x, u), y: mix(f.t.y, op.frame.t.y, u) },
        angle: mix(f.angle, op.frame.angle, u),
        skew: mix(f.skew, op.frame.skew, u),
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
    const s = unsheared(op.shift, op.along, op.lean);

    return {
      ...op,
      shift: sheared({ x: s.x * Math.pow(op.by.x, n), y: s.y * Math.pow(op.by.y, n) }, op.along, op.lean),
    };
  }

  if (op.kind === 'skew') {
    // `Xⁿ` is the shear by `n · by`: shears along one axis add.
    return { ...op, shift: sheared(unsheared(op.shift, op.along, -n * op.by), op.along, 0) };
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

/** When a thing begins and, for a polygon, the corners it has ever had. A
 * group begins at the first keyframe, having no birth of its own. */
function lived(tl: Timeline, id: Id): (Lived & { points?: readonly Vertex[] }) | undefined {
  const group = tl.groups.get(id);

  if (group !== undefined) {
    const first = tl.keyframes[0];

    return first === undefined ? undefined : { birth: first.id };
  }

  return tl.polygons.get(id) ?? tl.artefacts.get(id) ?? tl.paths.get(id);
}

interface Walked {
  rig: Rig
  thing: object
  /** The ids the walk was taken over, in order. Not the array: a keyframe
   * that changes its name or its eye changes nothing here. */
  order: KeyframeId[]
  states: (State | undefined)[]
  played: Op[][]
  /** Where each of `played` came from, one for one. */
  sources: Source[][]
}

/**
 * Where an operation a keyframe plays came from: the entry, written at `at`,
 * and which of its steps this is — nought for the entry itself.
 */
export interface Source {
  entry: Entry
  at: KeyframeId
  step: number
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

  // Keyed by the rig, or by the thing where nothing is written about it. A
  // group's life is made up here rather than kept, so it is the group itself
  // that stands for it: what the walk read of it is its first keyframe, which
  // the order already answers for.
  const rig = tl.rigs.get(id) ?? EMPTY_RIG;
  const record: object = tl.groups.get(id) ?? thing;
  const key = rig === EMPTY_RIG ? record : rig;
  const held = walks.get(key);

  if (held !== undefined && held.rig === rig && held.thing === record && same(held.order, tl.keyframes)) {
    return held;
  }

  const out = { ...walk(tl, rig, thing, thing.birth), thing: record };

  walks.set(key, out);

  return out;
}

function same(order: readonly KeyframeId[], keyframes: readonly Keyframe[]): boolean {
  return order.length === keyframes.length && order.every((k, i) => keyframes[i].id === k);
}

/** A repeat under way: its entry, and how many steps it has taken. */
interface Running {
  entry: Entry
  at: KeyframeId
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
    sources: Array.from({ length: n }, () => []),
  };

  if (born < 0) return out;

  const corners = (thing.points ?? []).map(c => ({
    corner: c,
    birth: indexIn(keyframes, c.birth),
    death: c.death === null ? Infinity : orNever(indexIn(keyframes, c.death)),
  }));

  let frame = REST;
  const totals: Record<AmountKind, number> = { erode: 0, round: 0, deform: 0 };
  let running: Running[] = [];

  // The last stand played, and where. Corners and their depths are read from
  // it rather than from the rest geometry, and nothing written before it
  // reaches past it but the steps of what repeats.
  let stood: { at: number, op: Stand } | null = null;

  for (let i = born; i < n; i++) {
    const key = keyframes[i].id;
    const ops = out.played[i];
    const from = out.sources[i];

    const apply = (op: Op, source: Source): void => {
      ops.push(op);
      from.push(source);

      if (amount(op)) {
        totals[op.kind] += op.by;
      }
      else if (op.kind === 'stand') {
        frame = op.frame;
        for (const kind of AMOUNT_KINDS) totals[kind] = op[AMOUNTS[kind].total];
      }
      else {
        frame = played(frame, op);
      }
    };

    // The steps of repeats begun earlier, oldest first. A skipped keyframe
    // is not a step: the repeat waits over it and carries its count on.
    const going: Running[] = [];

    for (const r of running) {
      if (r.entry.skip?.has(key)) {
        going.push(r);
        continue;
      }

      if (r.entry.times !== null && r.steps + 1 >= r.entry.times) continue;

      r.steps += 1;
      apply(stepped(r.entry.op, r.steps), { entry: r.entry, at: r.at, step: r.steps });
      going.push(r);
    }

    running = going;

    for (const e of rig.keys.get(key) ?? []) {
      apply(e.op, { entry: e, at: key, step: 0 });

      if (e.op.kind === 'stand') {
        stood = { at: i, op: e.op };
      }
      else if (e.times === null || e.times > 1) {
        running.push({ entry: e, at: key, steps: 0 });
      }
    }

    const none = corners.length === 0;

    const each = (kind: AmountKind): ReadonlyMap<VertexId, number> => {
      const { map, each: name } = AMOUNTS[kind];

      return none ? NO_DEPTHS : amountsAt(keyframes, rig[map], stood?.op[name], corners, stood, i);
    };

    out.states[i] = {
      frame,
      erosion: totals.erode,
      corners: none ? NO_CORNERS : standingAt(keyframes, rig, corners, stood, i),
      depths: each('erode'),
      bevel: totals.round,
      amplitude: totals.deform,
      bevels: each('round'),
      amplitudes: each('deform'),
    };
  }

  return out;
}

/** A keyframe index where the keyframe may be missing, which is never. */
export function orNever(i: number): number {
  return i < 0 ? Infinity : i;
}

export interface Placing {
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
export function counted(c: Placing, stood: { at: number, op: Stand } | null, i: number): number | null {
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

/**
 * One of the amounts kept by corner — depths, bevels, amplitudes — for every
 * corner standing at `i`: what the stand froze, and what its entries have added
 * since.
 */
function amountsAt(
  keyframes: readonly Keyframe[],
  written: ReadonlyMap<VertexId, ReadonlyMap<KeyframeId, Entry<Amount>>>,
  frozen: ReadonlyMap<VertexId, number> | undefined,
  corners: readonly Placing[],
  stood: { at: number, op: Stand } | null,
  i: number,
): ReadonlyMap<VertexId, number> {
  if (written.size === 0 && (frozen === undefined || frozen.size === 0)) return NO_DEPTHS;

  const out = new Map<VertexId, number>();

  for (const c of corners) {
    const from = counted(c, stood, i);

    if (from === null) continue;

    let d = frozen?.get(c.corner.id) ?? 0;

    for (const [k, e] of written.get(c.corner.id) ?? []) {
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
export function applications(
  keyframes: readonly Keyframe[],
  e: Repeat,
  k: KeyframeId,
  from: number,
  i: number,
): number {
  const j = indexIn(keyframes, k);

  if (j < 0 || j > i) return 0;

  return j >= from ? counted1(keyframes, e, j, i) : counted1(keyframes, e, j, i) - counted1(keyframes, e, j, from);
}

/** How many times an entry written at index `j` has contributed by `i`. */
export function counted1(keyframes: readonly Keyframe[], e: Repeat, j: number, i: number): number {
  let steps = i - j;

  if (e.skip !== undefined) {
    for (let m = j + 1; m <= i; m++) {
      if (e.skip.has(keyframes[m].id)) steps--;
    }
  }

  return 1 + (e.times === null ? steps : Math.min(steps, e.times - 1));
}

/**
 * A thing's state at a keyframe: at rest before it is born, and wherever the
 * world has no such thing.
 *
 * Walked over keys, made from the entries the world still holds — see *Keys*.
 * The entry walk above goes on answering `playedAt` and `sourcesAt` until
 * their callers move over, and the two are held to each other by the tests.
 */
export function stateAt(tl: Timeline, id: Id, k: KeyframeId): State {
  const i = indexIn(tl.keyframes, k);

  return (i < 0 ? undefined : stood(tl, id)?.states[i]) ?? UNBORN;
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

/** Where each of `playedAt`'s operations came from, one for one. */
export function sourcesAt(tl: Timeline, id: Id, k: KeyframeId): readonly Source[] {
  const i = indexIn(tl.keyframes, k);

  return (i < 0 ? undefined : walked(tl, id)?.sources[i]) ?? [];
}

/**
 * What a keyframe does to a thing, in the order it does it: the steps of
 * repeats begun earlier, each adjusted, and then its own keys.
 *
 * Played one after another from the state the keyframe before left, these are
 * that state carried to this one. What the bake puts in flight over a span.
 */
export function playingAt(tl: Timeline, id: Id, k: KeyframeId): readonly Playing[] {
  const i = indexIn(tl.keyframes, k);

  return (i < 0 ? undefined : stood(tl, id)?.playing[i]) ?? [];
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
  if (amount(op)) return op.by === 0;

  switch (op.kind) {
    case 'move':
      return op.by.x === 0 && op.by.y === 0;
    case 'turn':
      return Math.abs(op.angle) < 1e-12;
    case 'scale':
      return op.by.x === 1 && op.by.y === 1 && op.shift.x === 0 && op.shift.y === 0;
    case 'skew':
      return op.by === 0 && op.shift.x === 0 && op.shift.y === 0;
    case 'stand':
      return false;
  }
}

/** Two points the same to within the arithmetic that produced them. */
export function near(p: Point, q: Point): boolean {
  const scale = Math.max(1, Math.abs(p.x), Math.abs(p.y), Math.abs(q.x), Math.abs(q.y));

  return Math.abs(p.x - q.x) <= 1e-9 * scale && Math.abs(p.y - q.y) <= 1e-9 * scale;
}

/**
 * `b` folded into `a`, where that is exact: the entry that does both, or
 * `'gone'` where together they do nothing, or nothing where they cannot be one.
 *
 * Only ever what a hand repeating itself writes. Two moves add, and so do two
 * erosions, two rounds and two deforms. Two scales about the same painted point multiply, and their slides
 * add, and two skews about one add in both — the second's is taken from where the first left the painted point, and
 * that is where the combined one's is taken from too. Two turns about the same
 * centre add; the second's offset from the painted point is the first's turned
 * with it, since that is where the painted point went, and the one they make
 * keeps the first's.
 */
function sameSkip(a: ReadonlySet<KeyframeId> | undefined, b: ReadonlySet<KeyframeId> | undefined): boolean {
  const x = a ?? NONE, y = b ?? NONE;

  return x.size === y.size && [...x].every(k => y.has(k));
}

const NONE: ReadonlySet<KeyframeId> = new Set();

export function merged(a: Entry, b: Entry): Entry | 'gone' | null {
  if (a.times !== b.times || !sameSkip(a.skip, b.skip)) return null;

  const x = a.op, y = b.op;
  let op: Op | null = null;

  if (x.kind === 'move' && y.kind === 'move') {
    op = { kind: 'move', by: { x: x.by.x + y.by.x, y: x.by.y + y.by.y } };
  }
  else if (amount(x) && amount(y) && x.kind === y.kind) {
    op = { kind: x.kind, by: x.by + y.by };
  }
  else if (x.kind === 'turn' && y.kind === 'turn') {
    if (!near(x.ref, y.ref) || !near(spun(x.about, x.angle), y.about)) return null;

    op = { ...x, angle: x.angle + y.angle };
  }
  else if (x.kind === 'scale' && y.kind === 'scale') {
    if (!near(x.ref, y.ref) || x.along !== y.along || x.lean !== y.lean) return null;

    op = {
      ...x,
      by: { x: x.by.x * y.by.x, y: x.by.y * y.by.y },
      shift: { x: x.shift.x + y.shift.x, y: x.shift.y + y.shift.y },
    };
  }

  else if (x.kind === 'skew' && y.kind === 'skew') {
    if (!near(x.ref, y.ref) || x.along !== y.along) return null;

    op = { ...x, by: x.by + y.by, shift: { x: x.shift.x + y.shift.x, y: x.shift.y + y.shift.y } };
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

/** One corner's depth at a keyframe deepened. See `amounted`. */
export function deepened(rig: Rig, vertex: VertexId, k: KeyframeId, by: number): Rig {
  return amounted(rig, 'erode', vertex, k, by);
}

/** One corner rounded further at a keyframe. See `amounted`. */
export function cornerRounded(rig: Rig, vertex: VertexId, k: KeyframeId, by: number): Rig {
  return amounted(rig, 'round', vertex, k, by);
}

/** One edge, by the corner it starts at, deformed further. See `amounted`. */
export function edgeDeformed(rig: Rig, vertex: VertexId, k: KeyframeId, by: number): Rig {
  return amounted(rig, 'deform', vertex, k, by);
}

/**
 * One corner amounted further at a keyframe — for a deform, the edge starting
 * at it: a depth goes deeper, a bevel wider, an amplitude further off the
 * line. One that comes back to nothing is taken out, and its repeat is kept.
 */
export function amounted<K extends AmountKind>(rig: Rig, kind: K, vertex: VertexId, k: KeyframeId, by: number): Rig {
  // The one cast is this lookup, which `AMOUNTS` is what makes true; tying
  // `op` to `K` is what stops the wrong kind being written into a map, since
  // the computed key below puts the result past the compiler's reach.
  const map = AMOUNTS[kind].map;
  const maps = rig[map] as ReadonlyMap<VertexId, ReadonlyMap<KeyframeId, Entry<Amount<K>>>>;
  const was = maps.get(vertex)?.get(k);
  const sum = (was?.op.by ?? 0) + by;
  const op: Amount<K> = { kind, by: sum };
  const entry = sum === 0 ? null : { ...(was ?? once(op)), op };

  return { ...rig, [map]: cornered(maps, vertex, k, entry) };
}

export function cornered<E>(
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

// -----------------------------------------------------------------------------
// Keys
//
// What a thing does at a keyframe, as one thing. A key holds a delta over
// everything the thing has — where it is, how deep it is eroded, how far its
// corners stand — rather than one operation of one kind, and the author says
// where one key ends and the next begins. See `PLAN-keys.md`.
//
// The delta is the frame's parameters and one point:
//
//   angle, skew   added to the frame's
//   scale         multiplied into it, along the thing's own axes
//   move          where the painted point goes, in the axes of whatever holds
//                 the thing
//
// and that is the whole of it. A turn about a far-off centre is an angle and a
// move of the painted point; the centre is implied by the pair, and nothing
// stores an anchor or a slide. `played` in `rig.ts` needs four cases to say
// this; here it is one, and every one of those four comes back out of it
// exactly — see `key.test.ts`.
//
// `ref` is the painted point, as it is for an operation: a point of the thing
// in its rest frame, put where the thing's middle was when the key was made,
// and from then on just a point of the thing.
//
// Repeats
// -------
// A step takes the same delta again, adjusted so that it acts about the centre
// the first one did:
//
//   moveₙ = Lⁿ · move
//
// `L` is the delta's linear part, frozen in the axes it was written along —
// which is what `along` and `lean` are for, and why they are stored rather
// than read off the frame as it stands. This is today's `aboutₙ = R(angle)ⁿ ·
// about` for a turn and `shiftₙ = Mⁿ · shift` for a stretch and a shear, in
// one rule.
//
// Part way
// --------
// The bake draws the keyframes between the keyframes, and asks for a delta `u`
// of the way through — see `flown` in `bake.ts`. The parameters are easy: `u`
// of the angle and the skew, and the scale to the power `u`. Where the painted
// point is part way is the question, because the same two ends are reached by
// a great many paths, and the one to take is the one the hand that wrote it
// took.
//
// The painted point goes round the delta's **fixed point** — the point the
// delta leaves where it is:
//
//   moveᵤ = (I − Lᵤ) · w,  where (I − L) w = move
//
// For a turn that is the arc about the anchor; for a stretch it comes out as
// `(1 − dᵘ)/(1 − d)` along each axis, which is what keeps the gesture's own
// centre still the whole way through. Both are exactly what `played` does with
// a turn and a stretch today.
//
// Where the delta has no fixed point the painted point goes in a line, which
// is what a move and a shear do today. There are three of these and they are
// told apart rather than solved for, because a matrix inverse cannot see the
// difference between a stretch that is 1 on one axis — eased on the other, and
// a line along the first — and a delta that has no fixed point at all:
//
// - **nothing turns.** The easing is per axis in the axes the delta was
//   written along: `slid(scale.x, u)` and `slid(scale.y, u)`. A stretch, a
//   shear, a move and any mixture of them land here, and each is today's.
// - **something turns, and there is a fixed point.** The solve above.
// - **something turns by a whole number of turns.** `L` is then the identity
//   and `move` is nought, so the delta cannot say where the centre was:
//   `about` carries it, and is written by nothing else.
//
// One difference from `played`, in the way and not at the ends: a stretch
// eases along the axes it was written along, where `played` eases along the
// axes the thing has as it plays. They are the same axes wherever the delta is
// played over the frame it was written against, which is every keyframe the
// walk reaches; they differ for a step of a repeat that has turned the thing
// since, where this is the more faithful of the two — `stepped` already reads
// the written axes.
// -----------------------------------------------------------------------------

/** Everything a delta changes, in one. */
export interface Delta {
  /** Where `ref` goes, in the axes of whatever holds the thing. */
  move: Point
  /** Added to the frame's angle and skew. */
  angle: number
  skew: number
  /** Multiplied into the frame's, along the thing's own axes. */
  scale: { x: number, y: number }
  /** The axes the shear and the stretch were written along: the thing's own
   * angle and lean when the key was made. Read only by repeats, and by a key
   * played part way. */
  along: number
  lean: number
  /** Added to the running totals. */
  erode: number
  round: number
  deform: number
  /**
   * Where the delta turns about, as an offset from the painted point: the
   * point it leaves where it is.
   *
   * Derivable from the rest wherever the delta has one such point — it is `w`
   * with `(I − L) w = move` — and kept all the same, for the two reasons that
   * outweigh the redundancy. A turn by a whole number of turns *cannot* say
   * it: its linear part is the identity and its `move` is nought. And the
   * shipped table holds a turn as an angle and an anchor, so a delta that came
   * from one gives back the numbers it came from rather than the numbers a
   * solve makes of them.
   *
   * Absent where there is no one such point: a move, a shear, a stretch that
   * is 1 on an axis.
   */
  about?: Point
}

/** A delta that does nothing. */
export const NOTHING: Delta = {
  move: { x: 0, y: 0 },
  angle: 0,
  skew: 0,
  scale: { x: 1, y: 1 },
  along: 0,
  lean: 0,
  erode: 0,
  round: 0,
  deform: 0,
};

export interface Key {
  /** Its own, for picking it and for a merge, and for nothing else. */
  id: number
  /** The painted point, in the thing's rest frame. */
  ref: Point
  /** What it does to the thing as a whole. Absent is nothing, which is what a
   * key about single corners alone holds. */
  by?: Delta
  /** Moves of single corners, in the rest frame. */
  corners?: ReadonlyMap<VertexId, Point>
  /** The extra amounts on single corners, and on single edges by the corner
   * each starts at. */
  depths?: ReadonlyMap<VertexId, number>
  rounds?: ReadonlyMap<VertexId, number>
  deforms?: ReadonlyMap<VertexId, number>
  /** How many keyframes it contributes to, from its own: 1 is once, `null` is
   * to the end. */
  times: number | null
  /** Keyframes after its own where the repeat waits, carrying its count on. */
  skip?: ReadonlySet<KeyframeId>
  /** The state outright, instead of a delta: what unchaining writes. */
  stand?: Stand
  /** The gesture that wrote it, where one wrote keys on several things. */
  group?: number
}

/**
 * A delta played over the frame it starts from, all of it or `u` of the way
 * through.
 *
 * The parameters add and multiply, and the frame is placed so that the painted
 * point lands where `move` says. Everything a turn's anchor and a stretch's
 * slide do falls out of that: see the equivalences in `key.test.ts`.
 */
export function playedBy(f: Frame, ref: Point, d: Delta, u = 1): Frame {
  const p = placed(f, ref);
  const go = u === 1 ? d.move : movedBy(d, u);

  const frame = {
    ...f,
    angle: f.angle + d.angle * u,
    skew: f.skew + d.skew * u,
    scale: {
      x: f.scale.x * (u === 1 ? d.scale.x : Math.pow(d.scale.x, u)),
      y: f.scale.y * (u === 1 ? d.scale.y : Math.pow(d.scale.y, u)),
    },
  };

  const v = linear(frame, ref);

  return { ...frame, t: { x: p.x + go.x - v.x, y: p.y + go.y - v.y } };
}

/** The delta itself, `u` of the way through: its parameters that far, and the
 * axes it was written along, which do not move. */
function upTo(d: Delta, u: number): Delta {
  return {
    ...d,
    angle: d.angle * u,
    skew: d.skew * u,
    scale: { x: Math.pow(d.scale.x, u), y: Math.pow(d.scale.y, u) },
  };
}

/** Whether a turn is by a whole number of turns, so that its linear part is
 * the identity and says nothing about where it turned. */
function whole(angle: number): boolean {
  return angle !== 0 && Math.abs(Math.sin(angle / 2)) < 1e-12;
}

/**
 * Where the painted point is `u` of the way through: round the delta's fixed
 * point, or in a line where it has none. See *Part way*.
 */
export function movedBy(d: Delta, u: number): Point {
  if (d.angle === 0) {
    // Nothing turns: each axis eases with its own stretch, in the axes the
    // delta was written along. `slid(1, u)` is `u`, so a shear and a move go
    // in a line and an axis that is not stretched does too.
    const w = unsheared(d.move, d.along, d.lean);
    const along = { x: w.x * slid(d.scale.x, u), y: w.y * slid(d.scale.y, u) };

    return sheared(along, d.along, d.lean);
  }

  const fixed = fixedOf(d);

  if (fixed === null) return { x: d.move.x * u, y: d.move.y * u };

  // `(I − Lᵤ) · w`: where the point has swung to, about the point that stays.
  const lu = linearOf(upTo(d, u));
  const go = through(lu, fixed);

  return { x: fixed.x - go.x, y: fixed.y - go.y };
}

/**
 * Where the delta turns about, as an offset from the painted point, or nothing
 * where it has no one such point: `w` with `(I − L) w = move`.
 */
function fixedOf(d: Delta): Point | null {
  if (d.about !== undefined) return d.about;

  const l = linearOf(d);
  const a = 1 - l.a, b = -l.b, c = -l.c, e = 1 - l.d;
  const det = a * e - b * c;
  const size = Math.max(1, Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(e));

  if (Math.abs(det) < 1e-12 * size * size) return null;

  return {
    x: (e * d.move.x - c * d.move.y) / det,
    y: (a * d.move.y - b * d.move.x) / det,
  };
}

/** `R(angle) · K(skew) · S(scale)` as a matrix, with nothing translated. */
function mapped(angle: number, skew: number, scale: { x: number, y: number }): Affine {
  return affineOf({ t: { x: 0, y: 0 }, angle, skew, scale });
}

const UNIT = { x: 1, y: 1 };

/**
 * The delta's linear part, in the axes it was written along: what it does to
 * the thing's shape, with where it is left out of it.
 *
 * `B · M · B⁻¹`, for `B = R(along) · K(lean)` and `M` the parameters' own
 * change. It does not depend on the scale the thing had, since a stretch along
 * its axes commutes with one, which is why two keys written at different sizes
 * repeat the same way.
 */
export function linearOf(d: Delta): Affine {
  const back = compose(mapped(0, -d.lean, UNIT), mapped(-d.along, 0, UNIT));

  return compose(mapped(d.along + d.angle, d.lean + d.skew, d.scale), back);
}

/** A vector through a linear map. */
function through(m: Affine, v: Point): Point {
  return { x: m.a * v.x + m.c * v.y, y: m.b * v.x + m.d * v.y };
}

/**
 * The `n`-th step of a repeat: the same delta, acting about the centre the
 * first one did. Nought is the delta itself.
 */
export function steppedBy(d: Delta, n: number): Delta {
  if (n === 0) return d;

  const about = d.about === undefined ? undefined : { ...stepAbout(d, n) };

  return { ...d, move: moveOn(d, n), ...(about === undefined ? {} : { about }) };
}

/**
 * Where the painted point goes on the `n`-th step: `Lⁿ · move`.
 *
 * Worked out in closed form for a delta that turns, stretches or shears alone,
 * rather than by multiplying the map out `n` times — which is the same number
 * up to the arithmetic, and is the number the operation it came from would
 * have made. A delta that does two of them at once has no closed form and
 * takes the multiplication.
 */
function moveOn(d: Delta, n: number): Point {
  const turns = d.angle !== 0;
  const stretches = d.scale.x !== 1 || d.scale.y !== 1;
  const shears = d.skew !== 0;

  if (turns && !stretches && !shears) {
    // Round the anchor `n` steps on, which is where the point has swung to.
    const about = stepAbout(d, n);
    const to = spun(about, d.angle);

    return { x: about.x - to.x, y: about.y - to.y };
  }

  if (stretches && !turns && !shears) {
    const w = unsheared(d.move, d.along, d.lean);

    return sheared({ x: w.x * Math.pow(d.scale.x, n), y: w.y * Math.pow(d.scale.y, n) }, d.along, d.lean);
  }

  if (shears && !turns && !stretches) {
    // `Xⁿ` is the shear by `n · by`: shears along one axis add.
    return sheared(unsheared(d.move, d.along, -n * d.skew), d.along, 0);
  }

  const l = linearOf(d);
  let move = d.move;

  for (let i = 0; i < n; i++) move = through(l, move);

  return move;
}

/** A whole turn's centre, `n` steps on: it rides the painted point, and the
 * painted point is where the steps before left it. */
function stepAbout(d: Delta, n: number): Point {
  return spun(d.about!, d.angle * n);
}

/**
 * One of today's operations as a delta, or nothing for a stand, which is not
 * one. The painted point is the operation's where it has one, and anywhere at
 * all where it has not: a move and an amount take the same delta about any
 * point of the thing.
 */
export function deltaOf(op: Op): Delta | null {
  switch (op.kind) {
    case 'move':
      return { ...NOTHING, move: op.by };

    case 'turn': {
      // Where the painted point goes, turning about the anchor: `(I − R) ·
      // about`, since the anchor is `about` away from it. The anchor comes
      // too: by a whole number of turns the point goes nowhere and nothing
      // else could say where it turned.
      const d = spun(op.about, op.angle);

      return {
        ...NOTHING,
        angle: op.angle,
        move: whole(op.angle) ? { x: 0, y: 0 } : { x: op.about.x - d.x, y: op.about.y - d.y },
        about: op.about,
      };
    }

    case 'scale':
      return { ...NOTHING, scale: op.by, move: op.shift, along: op.along, lean: op.lean };

    case 'skew':
      return { ...NOTHING, skew: op.by, move: op.shift, along: op.along };

    case 'erode':
    case 'round':
    case 'deform':
      return { ...NOTHING, [op.kind]: op.by };

    case 'stand':
      return null;
  }
}

// -----------------------------------------------------------------------------
// The walk
//
// The same walk `rig.ts` takes, over keys: from the thing's birth, each
// keyframe playing the steps of repeats begun earlier, oldest first, and then
// its own keys in order, each from the state the one before it left.
//
// What a key holds about single corners is not played here. A corner's move is
// in the rest frame and its amounts are numbers, so they commute with
// everything and with each other, and the walk counts them where it needs them
// rather than keeping them — as the entry walk does, and for the same reason.
// -----------------------------------------------------------------------------

/** Everything written about one thing, as keys. */
export interface KeyRig {
  keys: ReadonlyMap<KeyframeId, readonly Key[]>
}

export const EMPTY_KEYS: KeyRig = { keys: new Map() };

/** A key's repeat under way: the key, and how many steps it has taken. */
interface Stepping {
  key: Key
  steps: number
}

/**
 * A thing's state at every keyframe, from its birth on, and nothing before it.
 *
 * `corners` is every corner the thing has ever had, in the rest frame, with
 * its life; a thing without a ring has none.
 */
export function walkedBy(
  keyframes: readonly Keyframe[],
  rig: KeyRig,
  corners: readonly Vertex[],
  birth: KeyframeId,
): Walking {
  const n = keyframes.length;
  const out: Walking = {
    states: new Array(n).fill(undefined),
    playing: Array.from({ length: n }, () => []),
  };
  const born = indexIn(keyframes, birth);

  if (born < 0) return out;

  const placing: Placing[] = corners.map(c => ({
    corner: c,
    birth: indexIn(keyframes, c.birth),
    death: c.death === null ? Infinity : orNever(indexIn(keyframes, c.death)),
  }));

  let frame = REST;
  const totals: Record<AmountKind, number> = { erode: 0, round: 0, deform: 0 };
  let running: Stepping[] = [];
  let stood: { at: number, op: Stand } | null = null;

  for (let i = born; i < n; i++) {
    const at = keyframes[i].id;
    const playing = out.playing[i];

    const apply = (key: Key, step: number): void => {
      if (key.stand !== undefined) {
        playing.push({ ref: key.ref, stand: key.stand, key, at, step });
        frame = key.stand.frame;
        for (const kind of AMOUNT_KINDS) totals[kind] = key.stand[AMOUNTS[kind].total];

        return;
      }

      if (key.by === undefined) return;

      const d = steppedBy(key.by, step);

      playing.push({ ref: key.ref, by: d, key, at, step });
      frame = playedBy(frame, key.ref, d);
      for (const kind of AMOUNT_KINDS) totals[kind] += d[kind];
    };

    // The steps of repeats begun earlier, oldest first. A skipped keyframe is
    // not a step: the repeat waits over it and carries its count on.
    const going: Stepping[] = [];

    for (const r of running) {
      if (r.key.skip?.has(at)) {
        going.push(r);
        continue;
      }

      if (r.key.times !== null && r.steps + 1 >= r.key.times) continue;

      r.steps += 1;
      apply(r.key, r.steps);
      going.push(r);
    }

    running = going;

    for (const key of rig.keys.get(at) ?? []) {
      apply(key, 0);

      if (key.stand !== undefined) {
        stood = { at: i, op: key.stand };
      }
      else if (key.times === null || key.times > 1) {
        running.push({ key, steps: 0 });
      }
    }

    const none = placing.length === 0;

    out.states[i] = {
      frame,
      erosion: totals.erode,
      corners: none ? NO_CORNERS : standingBy(keyframes, rig, placing, stood, i),
      depths: none ? NO_DEPTHS : amountsBy(keyframes, rig, 'depths', stood?.op.depths, placing, stood, i),
      bevel: totals.round,
      amplitude: totals.deform,
      bevels: none ? NO_DEPTHS : amountsBy(keyframes, rig, 'rounds', stood?.op.bevels, placing, stood, i),
      amplitudes: none ? NO_DEPTHS : amountsBy(keyframes, rig, 'deforms', stood?.op.amplitudes, placing, stood, i),
    };
  }

  return out;
}

/**
 * One thing a keyframe does, in the order it does it: a key's delta, adjusted
 * for which step of its repeat this is, about the painted point it acts about.
 *
 * `key`, `at` and `step` are where it came from — the key, the keyframe it is
 * written at, and nought for the key itself. What the view picks by and what
 * the fold compares.
 */
export interface Playing {
  ref: Point
  /** What it does, or nothing where it stands outright. */
  by?: Delta
  stand?: Stand
  key: Key
  at: KeyframeId
  step: number
}

/** A walk's answer: where the thing stands at each keyframe, and what each
 * keyframe did to get there. */
export interface Walking {
  states: (State | undefined)[]
  playing: Playing[][]
}

/** A delta played over the frame it starts from, all of it or `u` of the way
 * through, as the operations it is made of. Exactly what its operation did
 * where the key came from one, which is every key until a gesture folds two
 * into one — see `opsOf`. */
export function playingOn(f: Frame, p: Playing, u = 1): Frame {
  let out = f;

  for (const op of opsOf(p)) out = played(out, op, u);

  return out;
}

/** Whether a contribution moves the frame at all, as against only deepening,
 * rounding or deforming. */
export function flying(p: Playing): boolean {
  if (p.stand !== undefined) return true;

  const d = p.by;

  return d !== undefined
    && (d.move.x !== 0 || d.move.y !== 0 || d.angle !== 0 || d.skew !== 0 || d.scale.x !== 1 || d.scale.y !== 1);
}

/**
 * A contribution as the operations it is made of, in the order they play:
 * shear, stretch, turn, move.
 *
 * What the shipped table holds and what plays part way, until the table holds
 * deltas themselves. A delta that came from one operation gives back that
 * operation, numbers and all — a turn keeps the anchor it was written with
 * rather than one solved from its move, which is why `about` is stored.
 *
 * A delta that holds more than one of them is exact at the ends and takes its
 * own path between: each part about the painted point, and the move last. That
 * is not what a key means — a key is one motion, about the point it leaves
 * still — and it is what a table of single operations can say. See
 * `PLAN-keys.md`.
 */
export function opsOf(p: Playing): Op[] {
  if (p.stand !== undefined) return [p.stand];

  const d = p.by;

  if (d === undefined) return [];

  const turns = d.angle !== 0;
  const stretches = d.scale.x !== 1 || d.scale.y !== 1;
  const shears = d.skew !== 0;
  const alone = Number(turns) + Number(stretches) + Number(shears) <= 1;
  const moved = d.move.x !== 0 || d.move.y !== 0;

  // One of them, with the move it carries: the operation this came from.
  if (alone) {
    if (turns) return [{ kind: 'turn', angle: d.angle, ref: p.ref, about: d.about ?? fixed(d) }];
    if (stretches) return [{ kind: 'scale', by: d.scale, ref: p.ref, shift: d.move, along: d.along, lean: d.lean }];
    if (shears) return [{ kind: 'skew', by: d.skew, ref: p.ref, shift: d.move, along: d.along }];

    return moved ? [{ kind: 'move', by: d.move }] : [];
  }

  const out: Op[] = [];
  const none = { x: 0, y: 0 };

  if (shears) out.push({ kind: 'skew', by: d.skew, ref: p.ref, shift: none, along: d.along });
  if (stretches) out.push({ kind: 'scale', by: d.scale, ref: p.ref, shift: none, along: d.along, lean: d.lean });
  if (turns) out.push({ kind: 'turn', angle: d.angle, ref: p.ref, about: none });
  if (moved) out.push({ kind: 'move', by: d.move });

  return out;
}

/** The anchor of a turn whose delta has lost it, which nothing written by
 * `deltaOf` has. */
function fixed(d: Delta): Point {
  const c = Math.cos(d.angle), s = Math.sin(d.angle);
  const det = (1 - c) * (1 - c) + s * s;

  return det === 0
    ? { x: 0, y: 0 }
    : { x: ((1 - c) * d.move.x + s * d.move.y) / det, y: ((1 - c) * d.move.y - s * d.move.x) / det };
}

/** Where every corner standing at `i` stands, in the rest frame: what a stand
 * froze or where it was drawn, and every nudge since, however many times each
 * has played. */
function standingBy(
  keyframes: readonly Keyframe[],
  rig: KeyRig,
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

    for (const [at, list] of rig.keys) {
      for (const key of list) {
        const by = key.corners?.get(c.corner.id);

        if (by === undefined) continue;

        const times = applications(keyframes, key, at, from, i);

        x += by.x * times;
        y += by.y * times;
      }
    }

    out.set(c.corner.id, { x, y });
  }

  return out;
}

/** One of the amounts kept by corner, for every corner standing at `i`. */
function amountsBy(
  keyframes: readonly Keyframe[],
  rig: KeyRig,
  held: 'depths' | 'rounds' | 'deforms',
  frozen: ReadonlyMap<VertexId, number> | undefined,
  corners: readonly Placing[],
  stood: { at: number, op: Stand } | null,
  i: number,
): ReadonlyMap<VertexId, number> {
  const out = new Map<VertexId, number>();

  for (const c of corners) {
    const from = counted(c, stood, i);

    if (from === null) continue;

    let d = frozen?.get(c.corner.id) ?? 0;

    for (const [at, list] of rig.keys) {
      for (const key of list) {
        const by = key[held]?.get(c.corner.id);

        if (by !== undefined) d += by * applications(keyframes, key, at, from, i);
      }
    }

    if (d !== 0) out.set(c.corner.id, d);
  }

  return out.size === 0 ? NO_DEPTHS : out;
}

// -----------------------------------------------------------------------------
// From entries
//
// What reads a file written before keys, and what the tests play both ways to
// hold this to what `rig.ts` does.
// -----------------------------------------------------------------------------

/**
 * A rig of entries as keys.
 *
 * An entry is a key that holds one channel, so the list converts one for one
 * and keeps its order. What a corner has written about it becomes keys of its
 * own, one per repeat at a keyframe — a nudge and a depth written by the same
 * gesture, repeating the same way, are one key. They hold no `by`, so where
 * they sit among the others does not matter: a corner's move is in the rest
 * frame and commutes with everything the list does.
 */
export function keysOf(rig: Rig): KeyRig {
  const keys = new Map<KeyframeId, Writing[]>();
  let id = 0;

  const list = (at: KeyframeId): Writing[] => {
    let out = keys.get(at);

    if (out === undefined) {
      out = [];
      keys.set(at, out);
    }

    return out;
  };

  for (const [at, entries] of rig.keys) {
    for (const e of entries) {
      const by = deltaOf(e.op);
      const ref = 'ref' in e.op ? e.op.ref : ORIGIN;

      list(at).push({
        id: id++,
        ref,
        ...(by === null ? { stand: e.op as Stand } : { by }),
        times: e.times,
        ...(e.skip === undefined ? {} : { skip: e.skip }),
      });
    }
  }

  // A corner's own writing, gathered by keyframe and by how it repeats.
  const mine = (at: KeyframeId, e: Repeat): Writing => {
    const held = list(at).find(k => k.by === undefined && k.stand === undefined && sameRepeat(k, e));

    if (held !== undefined) return held as Writing;

    const key: Writing = { id: id++, ref: ORIGIN, times: e.times, ...(e.skip === undefined ? {} : { skip: e.skip }) };

    list(at).push(key);

    return key;
  };

  for (const [vertex, written] of rig.nudges) {
    for (const [at, e] of written) {
      const key = mine(at, e);

      key.corners = new Map(key.corners ?? []).set(vertex, e.op.by);
    }
  }

  for (const map of CORNER_MAPS) {
    if (map === 'nudges') continue;

    const held = HELD[map];

    for (const [vertex, written] of rig[map]) {
      for (const [at, e] of written) {
        const key = mine(at, e);

        key[held] = new Map(key[held] ?? []).set(vertex, e.op.by);
      }
    }
  }

  return { keys };
}

const ORIGIN: Point = { x: 0, y: 0 };

/** A key while it is being written into: the maps a corner's writing goes in,
 * which are read-only on a `Key` and are filled here before it is one. */
interface Writing extends Key {
  corners?: Map<VertexId, Point>
  depths?: Map<VertexId, number>
  rounds?: Map<VertexId, number>
  deforms?: Map<VertexId, number>
}

/** Which of a key's corner maps each of a rig's is. */
const HELD = {
  nudges: 'corners',
  depths: 'depths',
  rounds: 'rounds',
  deforms: 'deforms',
} as const satisfies { [M in CornerMap]: keyof Key };

function sameRepeat(a: Repeat, b: Repeat): boolean {
  if (a.times !== b.times) return false;

  const x = a.skip, y = b.skip;

  if (x === undefined || y === undefined) return x === y || (x ?? y)!.size === 0;

  return x.size === y.size && [...x].every(k => y.has(k));
}

// -----------------------------------------------------------------------------
// The states, over keys
//
// What `stateAt` answers from. The rig is converted once and the walk taken
// once, both cached against the rig they were made from — which is persistent,
// so an edit to one thing leaves every other thing's alone.
// -----------------------------------------------------------------------------

const converted = new WeakMap<Rig, KeyRig>();

/** A rig as keys, made once. */
export function keysFor(rig: Rig): KeyRig {
  let held = converted.get(rig);

  if (held === undefined) {
    held = keysOf(rig);
    converted.set(rig, held);
  }

  return held;
}

interface Stood extends Walking {
  rig: Rig
  thing: object
  order: KeyframeId[]
}

const standings = new WeakMap<object, Stood>();

/** The walk over a thing's keys, kept the way the walk over its entries is:
 * by the rig, or by the thing where nothing is written about it. */
function stood(tl: Timeline, id: Id): Stood | null {
  const thing = lived(tl, id);

  if (thing === undefined) return null;

  const rig = tl.rigs.get(id) ?? EMPTY_RIG;
  const record: object = tl.groups.get(id) ?? thing;
  const held = standings.get(rig === EMPTY_RIG ? record : rig);

  if (held !== undefined && held.rig === rig && held.thing === record && same(held.order, tl.keyframes)) {
    return held;
  }

  const out: Stood = {
    rig,
    thing: record,
    order: tl.keyframes.map(f => f.id),
    ...walkedBy(tl.keyframes, keysFor(rig), thing.points ?? [], thing.birth),
  };

  standings.set(rig === EMPTY_RIG ? record : rig, out);

  return out;
}
