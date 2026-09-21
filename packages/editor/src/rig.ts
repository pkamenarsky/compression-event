// -----------------------------------------------------------------------------
// Timelines
//
// What happens to a thing is keys, keyframe by keyframe, and where it is at a
// keyframe is those played from its birth onward. Nothing else: no layer to
// inherit, nothing composed into anything, nothing solved for after an edit.
// *Keys*, below, is what one is; this half is the operations a key is made of,
// which is what the group fold carries through a frame and what a test says a
// timeline in.
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
// keyframes, oldest first, and then that keyframe's own keys in list order.
// Each is applied in turn, to the state the one before left.
//
// Repeats
// -------
// A key may go on contributing after its own keyframe — `times` of them in
// all, or to the end — each time adjusted so that it acts about the same
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
import type { CornerKind } from './cornermaps';
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
   * The gesture that wrote it, as a key's `group` is. Absent is none.
   */
  gesture?: number
}

/**
 * Everything written about one thing, as operations.
 *
 * What a test says a timeline in, and what a file older than a 24 held — see
 * `entriesOf` and `keysOf` below, and `convert.ts`. The editor's own is
 * `KeyRig`.
 *
 * The corners have maps of their own rather than a place in the list: a nudge
 * or a depth is about one corner, and there is only ever one per corner per
 * keyframe, so there is no order among them to keep. A key has no such limit,
 * which is the one thing this cannot say back.
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
export function skipping<E extends Repeat>(keyframes: readonly Keyframe[], e: E, k: KeyframeId): E {
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
  rigs: ReadonlyMap<Id, KeyRig>
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
// The keyframes
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

/** A thing's state at a keyframe: at rest before it is born, and wherever the
 * world has no such thing. See *The states, over keys*. */
export function stateAt(tl: Timeline, id: Id, k: KeyframeId): State {
  const i = indexIn(tl.keyframes, k);

  return (i < 0 ? undefined : stood(tl, id)?.states[i]) ?? UNBORN;
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
  const fixed = aboutOf(d);

  if (fixed === null) {
    // Nothing it turns about: each axis eases with its own stretch, in the
    // axes the delta was written along. `slid(1, u)` is `u`, so a shear and a
    // move go in a line and an axis that is not stretched does too.
    const w = unsheared(d.move, d.along, d.lean);
    const along = { x: w.x * slid(d.scale.x, u), y: w.y * slid(d.scale.y, u) };

    return sheared(along, d.along, d.lean);
  }

  // `w − Lᵤ · w`: where the point has swung to, about the point that stays.
  const w = unsheared(fixed, d.along, d.lean);
  const back = sheared(
    { x: w.x * Math.pow(d.scale.x, u), y: w.y * Math.pow(d.scale.y, u) },
    d.along + d.angle * u,
    d.lean + d.skew * u,
  );

  return { x: fixed.x - back.x, y: fixed.y - back.y };
}

/**
 * Where the delta turns about, as an offset from the painted point, or nothing
 * where it does not turn or has no one such point: `w` with `(I − L) w = move`.
 *
 * Nothing where it does not turn, though a stretch has such a point too: the
 * easing per axis says the same thing there and says it about each axis on its
 * own, which is what a stretch along one axis needs. So this is the question
 * *the other way of saying it cannot answer*, and it is what the shipped table
 * tells its two kinds apart by. See `OP_STRIDE` in `baked.ts`.
 */
export function aboutOf(d: Delta): Point | null {
  if (d.angle === 0) return null;
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

/** A key's repeat under way: the key, the keyframe it is written at, and how
 * many steps it has taken. */
interface Stepping {
  key: Key
  at: KeyframeId
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

    const apply = (key: Key, wrote: KeyframeId, step: number): void => {
      if (key.stand !== undefined) {
        playing.push({ ref: key.ref, stand: key.stand, key, at: wrote, step });
        frame = key.stand.frame;
        for (const kind of AMOUNT_KINDS) totals[kind] = key.stand[AMOUNTS[kind].total];

        return;
      }

      if (key.by === undefined) return;

      const d = steppedBy(key.by, step);

      playing.push({ ref: key.ref, by: d, key, at: wrote, step });
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
      apply(r.key, r.at, r.steps);
      going.push(r);
    }

    running = going;

    for (const key of rig.keys.get(at) ?? []) {
      apply(key, at, 0);

      if (key.stand !== undefined) {
        stood = { at: i, op: key.stand };
      }
      else if (key.times === null || key.times > 1) {
        running.push({ key, at, steps: 0 });
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
 * `key`, `at` and `step` are where it came from — the key, the keyframe the
 * key is written at, which is not this one for a step of a repeat begun
 * earlier, and nought for the key itself. What the view picks by and what the
 * fold compares.
 */
export interface Playing extends Motion {
  key: Key
  at: KeyframeId
  step: number
}

/**
 * What one contribution *does*, and nothing about where it came from: the
 * delta about its painted point, or a state outright.
 *
 * What the bake puts in flight and the table is written from. A flight that
 * carried the key as well would be carrying the editor's bookkeeping into the
 * game's — and into the hash a span is dropped by, which would then move
 * whenever a key was written beside it.
 */
export interface Motion {
  ref: Point
  /** What it does, or nothing where it stands outright. */
  by?: Delta
  stand?: Stand
}

/** A walk's answer: where the thing stands at each keyframe, and what each
 * keyframe did to get there. */
export interface Walking {
  states: (State | undefined)[]
  playing: Playing[][]
}

/**
 * What one contribution does to the frame it starts from, all of it or `u` of
 * the way through.
 *
 * One motion, which is what a key is: `playedBy` for a delta, and a stand
 * straight to its numbers. The same arithmetic the shipped table is played by
 * — see `OP_STRIDE` in `baked.ts`, which is this on the other side.
 */
export function playingOn(f: Frame, p: Motion, u = 1): Frame {
  if (p.stand !== undefined) return played(f, p.stand, u);

  return p.by === undefined ? f : playedBy(f, p.ref, p.by, u);
}

/** Whether a contribution moves the frame at all, as against only deepening,
 * rounding or deforming. */
export function flying(p: Motion): boolean {
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
export function opsOf(p: Motion): Op[] {
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

/**
 * Everything a contribution does, as operations: what moves the frame, and
 * then its amounts, which commute with it and with each other.
 *
 * What carries a timeline through a frame — see `carried` in `scene/core.ts`.
 * The shipped table wants only the first of those, which is `opsOf`.
 */
export function everyOp(p: Motion): Op[] {
  const out = opsOf(p);

  if (p.by !== undefined) {
    for (const kind of AMOUNT_KINDS) {
      if (p.by[kind] !== 0) out.push({ kind, by: p.by[kind] });
    }
  }

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
export function keysOf(rig: Rig, was?: KeyRig): KeyRig {
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
        ...(e.gesture === undefined ? {} : { group: e.gesture }),
      });
    }
  }

  // A corner's own writing, gathered by keyframe and by how it repeats.
  const mine = (at: KeyframeId, e: Entry): Writing => {
    const held = list(at).find(k =>
      k.by === undefined && k.stand === undefined && k.group === e.gesture && sameRepeat(k, e));

    if (held !== undefined) return held as Writing;

    const key: Writing = {
      id: id++,
      ref: ORIGIN,
      times: e.times,
      ...(e.skip === undefined ? {} : { skip: e.skip }),
      ...(e.gesture === undefined ? {} : { group: e.gesture }),
    };

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

  const out: KeyRig = { keys: kept(keys, was) };

  made.set(out, entriesBy(out, rig));

  return out;
}

/**
 * The keys of every keyframe whose entries are the very ones a key made,
 * unchanged: those keys themselves, and not copies of them.
 *
 * TEMPORARY, with `entriesOf`. What the editor writes through the way back is
 * one keyframe of one thing, and everything else has to come out of it the
 * same objects it went in as — the bake drops a span when what it was baked
 * from changed, and `gestured` stamps a key it has not seen before. Rebuilding
 * every key would say everything changed, every time.
 */
function kept(now: Map<KeyframeId, Writing[]>, was: KeyRig | undefined): Map<KeyframeId, readonly Key[]> {
  const out = new Map<KeyframeId, readonly Key[]>(now);

  if (was === undefined) return out;

  const before = made.get(was);

  if (before === undefined) return out;

  for (const [at, list] of out) {
    const held = before.get(at);

    if (held !== undefined && sameKeys(held.keys, list)) out.set(at, held.keys);
  }

  return out;
}

/** Which entries each keyframe's keys were taken apart into, for `kept`. */
const made = new WeakMap<KeyRig, Map<KeyframeId, { keys: readonly Key[], entries: Rig }>>();

function entriesBy(rig: KeyRig, entries: Rig): Map<KeyframeId, { keys: readonly Key[], entries: Rig }> {
  return new Map([...rig.keys].map(([at, keys]) => [at, { keys, entries }]));
}

/** Whether two lists of keys say the same thing, field by field. */
function sameKeys(a: readonly Key[], b: readonly Key[]): boolean {
  return a.length === b.length && a.every((x, i) => sameKey(x, b[i]));
}

function sameKey(a: Key, b: Key): boolean {
  if (a === b) return true;
  if (a.id !== b.id || a.times !== b.times || a.group !== b.group) return false;
  if (!sameRepeat(a, b) || a.stand !== b.stand) return false;
  if (a.ref.x !== b.ref.x || a.ref.y !== b.ref.y) return false;
  if ((a.by === undefined) !== (b.by === undefined)) return false;
  if (a.by !== undefined && b.by !== undefined && !sameDelta(a.by, b.by)) return false;

  return CORNER_HELD.every(m => sameHeld(a[m], b[m]));
}

function sameDelta(a: Delta, b: Delta): boolean {
  return a.move.x === b.move.x && a.move.y === b.move.y && a.angle === b.angle && a.skew === b.skew
    && a.scale.x === b.scale.x && a.scale.y === b.scale.y && a.along === b.along && a.lean === b.lean
    && a.erode === b.erode && a.round === b.round && a.deform === b.deform
    && (a.about?.x ?? null) === (b.about?.x ?? null) && (a.about?.y ?? null) === (b.about?.y ?? null);
}

function sameHeld(a: ReadonlyMap<VertexId, unknown> | undefined, b: ReadonlyMap<VertexId, unknown> | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.size !== b.size) return false;

  for (const [k, v] of a) {
    const mine = b.get(k);

    if (v === mine) continue;

    const p = v as Point, q = mine as Point | undefined;

    if (q === undefined || typeof v === 'number' || p.x !== q.x || p.y !== q.y) return false;
  }

  return true;
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

interface Stood extends Walking {
  rig: KeyRig
  thing: object
  order: KeyframeId[]
}

const standings = new WeakMap<object, Stood>();

/** Whether a walk was taken over these keyframes, in this order. Not the
 * array: a keyframe that changes its name or its eye changes nothing. */
function same(order: readonly KeyframeId[], keyframes: readonly Keyframe[]): boolean {
  return order.length === keyframes.length && order.every((k, i) => keyframes[i].id === k);
}

/** The walk over a thing's keys, kept the way the walk over its entries is:
 * by the rig, or by the thing where nothing is written about it. */
function stood(tl: Timeline, id: Id): Stood | null {
  const thing = lived(tl, id);

  if (thing === undefined) return null;

  const rig = tl.rigs.get(id) ?? EMPTY_KEYS;
  const record: object = tl.groups.get(id) ?? thing;
  const held = standings.get(rig === EMPTY_KEYS ? record : rig);

  if (held !== undefined && held.rig === rig && held.thing === record && same(held.order, tl.keyframes)) {
    return held;
  }

  const out: Stood = {
    rig,
    thing: record,
    order: tl.keyframes.map(f => f.id),
    ...walkedBy(tl.keyframes, rig, thing.points ?? [], thing.birth),
  };

  standings.set(rig === EMPTY_KEYS ? record : rig, out);

  return out;
}

// -----------------------------------------------------------------------------
// Writing keys
//
// What the editor edits. A keyframe's list is the keys written at it, in the
// order they play, and a gesture writes into the last one it opened rather
// than adding another — see `PLAN-keys.md`.
// -----------------------------------------------------------------------------

/** Whether nothing at all is written in a rig of keys. */
export function blankKeys(rig: KeyRig): boolean {
  return rig.keys.size === 0;
}

/** What a keyframe does to a thing, in order. */
export function keysAt(rig: KeyRig, k: KeyframeId): readonly Key[] {
  return rig.keys.get(k) ?? [];
}

/** A keyframe's list replaced. An empty one is taken out of the map. */
export function withKeysAt(rig: KeyRig, k: KeyframeId, list: readonly Key[]): KeyRig {
  const keys = new Map(rig.keys);

  if (list.length === 0) keys.delete(k);
  else keys.set(k, list);

  return { ...rig, keys };
}

/** The next id free in a rig: one more than the highest written. */
export function nextKey(rig: KeyRig): number {
  let out = 0;

  for (const list of rig.keys.values()) {
    for (const key of list) out = Math.max(out, key.id + 1);
  }

  return out;
}

/**
 * `by` added to the end of a keyframe's list, folded into the last key where
 * the two are exactly one, and left off where it does nothing.
 *
 * A gesture recomputes from the list it started with every time the hand
 * moves, so what it leaves is one key however long it went on.
 *
 * Folded only where the two are the same channel about the same painted point,
 * for now: a key that holds a turn and a move at once is a key no entry can be
 * made of, and the group fold and the copy still read entries. Lifting that is
 * what break and split are for — see `PLAN-keys.md`, phase 3d.
 */
export function appendedBy(rig: KeyRig, k: KeyframeId, ref: Point, by: Delta): KeyRig {
  if (idle(by)) return rig;

  const list = keysAt(rig, k);
  const last = list[list.length - 1];
  const both = last === undefined ? null : foldedBy(last, ref, by);

  if (both === null) return withKeysAt(rig, k, [...list, keyOnce(nextKey(rig), ref, by)]);

  const head = list.slice(0, -1);

  return withKeysAt(rig, k, both === 'gone' ? head : [...head, both]);
}

/**
 * `by` folded into `key`, where that leaves one channel: the key that does
 * both, `'gone'` where together they do nothing, or nothing where they cannot
 * be one.
 */
export function foldedBy(key: Key, ref: Point, by: Delta): Key | 'gone' | null {
  const was = key.by;

  if (was === undefined || key.times !== 1 || key.skip !== undefined) return null;
  if (!near(key.ref, ref) || !oneChannel(was, by)) return null;

  const now: Delta = {
    ...was,
    move: { x: was.move.x + by.move.x, y: was.move.y + by.move.y },
    angle: was.angle + by.angle,
    skew: was.skew + by.skew,
    scale: { x: was.scale.x * by.scale.x, y: was.scale.y * by.scale.y },
    erode: was.erode + by.erode,
    round: was.round + by.round,
    deform: was.deform + by.deform,
  };

  // A turn keeps the anchor it was written about, which is where the painted
  // point went round; the move the pair make is worked out from it again.
  if (now.angle !== 0 && was.about !== undefined) {
    const to = spun(was.about, now.angle);

    now.about = was.about;
    now.move = whole(now.angle) ? { x: 0, y: 0 } : { x: was.about.x - to.x, y: was.about.y - to.y };
  }

  return idle(now) ? 'gone' : { ...key, by: now };
}

/** Whether two deltas are the same one channel, about the same axes: what can
 * be folded while a key has to be an entry. */
function oneChannel(a: Delta, b: Delta): boolean {
  const mine = channelOf(a), theirs = channelOf(b);

  if (mine === null || mine !== theirs) return false;
  if (a.along !== b.along || a.lean !== b.lean) return false;

  // Two turns fold only about the same centre, as two entries do: the second's
  // anchor is where the first left the painted point.
  if (mine === 'turn') {
    const to = a.about === undefined ? null : spun(a.about, a.angle);

    return to !== null && b.about !== undefined && near(to, b.about);
  }

  return true;
}

/**
 * The one thing a delta does, or nothing where it does more than one.
 *
 * A turn, a stretch and a shear each take the painted point somewhere as well,
 * which is the one operation they are: what more than one means is a turn and
 * an erosion, or a turn and a stretch.
 */
export function channelOf(d: Delta): string | null {
  const held = [
    d.angle !== 0 ? 'turn' : '',
    d.scale.x !== 1 || d.scale.y !== 1 ? 'scale' : '',
    d.skew !== 0 ? 'skew' : '',
    d.erode !== 0 ? 'erode' : '',
    d.round !== 0 ? 'round' : '',
    d.deform !== 0 ? 'deform' : '',
  ].filter(k => k !== '');
  const moved = d.move.x !== 0 || d.move.y !== 0;

  if (held.length > 1) return null;
  if (held.length === 0) return moved ? 'move' : null;

  // An amount does not take the painted point anywhere; a turn, a stretch and
  // a shear do, and that is theirs.
  return moved && (held[0] === 'erode' || held[0] === 'round' || held[0] === 'deform') ? null : held[0];
}

/** Which of a key's corner maps a kind of corner writing is in. */
export function heldOf(kind: CornerKind): 'corners' | 'depths' | 'rounds' | 'deforms' {
  return kind === 'move' ? 'corners' : ({ erode: 'depths', round: 'rounds', deform: 'deforms' } as const)[kind];
}

/**
 * The one thing a key does, by name: what the view draws it as and what a
 * gesture folds into. Nothing where it does more than one — which is what a
 * key is allowed to do and nothing writes yet.
 */
export function kindOf(key: Key): string | null {
  if (key.stand !== undefined) return 'stand';
  if (key.by === undefined) return 'corners';

  return channelOf(key.by);
}

/** A key that happens once, at its own keyframe. */
export function keyOnce(id: number, ref: Point, by: Delta): Key {
  return { id, ref, by, times: 1 };
}

/** Whether a delta does nothing at all: no shape, no place, no amount. */
export function idle(d: Delta): boolean {
  return d.move.x === 0 && d.move.y === 0 && d.angle === 0 && d.skew === 0
    && d.scale.x === 1 && d.scale.y === 1
    && d.erode === 0 && d.round === 0 && d.deform === 0;
}

/**
 * One corner's move at a keyframe added to, the way a hand adds to it: a nudge
 * moves it further, a depth goes deeper, an amplitude further off the line.
 * One that comes back to nothing is taken out.
 *
 * It goes in the keyframe's last key about corners alone, or a new one where
 * there is none. Which key a corner's writing sits in never changes what plays
 * — a corner's move is in the rest frame and its amounts are numbers, so they
 * commute with everything — and keeping them together is what makes one
 * gesture over four corners one key.
 */
export function cornerWrite<T>(
  rig: KeyRig,
  k: KeyframeId,
  id: number,
  held: 'corners' | 'depths' | 'rounds' | 'deforms',
  vertex: VertexId,
  add: (was: T | undefined) => T | null,
): KeyRig {
  const list = keysAt(rig, k);
  const at = lastCornerKey(list);
  const key: Key = at < 0 ? { id, ref: REST.t, times: 1 } : list[at];
  const mine = key[held] as ReadonlyMap<VertexId, T> | undefined;
  const now = add(mine?.get(vertex));
  const into = new Map(mine ?? []);

  if (now === null) into.delete(vertex);
  else into.set(vertex, now);

  const written = { ...key, [held]: into.size === 0 ? undefined : into } as Key;
  const empty = CORNER_HELD.every(m => written[m] === undefined);

  if (at < 0) return empty ? rig : withKeysAt(rig, k, [...list, written]);

  return withKeysAt(rig, k, empty ? list.filter((_x, i) => i !== at) : list.map((x, i) => (i === at ? written : x)));
}

/** The four maps a key keeps about single corners. */
const CORNER_HELD = ['corners', 'depths', 'rounds', 'deforms'] as const;

/** Where a keyframe's last key about corners alone is, or -1. */
function lastCornerKey(list: readonly Key[]): number {
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].by === undefined && list[i].stand === undefined) return i;
  }

  return -1;
}

/** One corner's nudge at a keyframe, added to. */
export function nudgedBy(rig: KeyRig, id: number, vertex: VertexId, k: KeyframeId, by: Point): KeyRig {
  return cornerWrite<Point>(rig, k, id, 'corners', vertex, was => {
    const sum = { x: (was?.x ?? 0) + by.x, y: (was?.y ?? 0) + by.y };

    return sum.x === 0 && sum.y === 0 ? null : sum;
  });
}

/** One corner's own depth, bevel or amplitude at a keyframe, added to. */
export function amountedBy(
  rig: KeyRig,
  id: number,
  kind: AmountKind,
  vertex: VertexId,
  k: KeyframeId,
  by: number,
): KeyRig {
  const held = ({ erode: 'depths', round: 'rounds', deform: 'deforms' } as const)[kind];

  return cornerWrite<number>(rig, k, id, held, vertex, was => {
    const sum = (was ?? 0) + by;

    return sum === 0 ? null : sum;
  });
}

/**
 * A rig of keys as entries: one entry per operation a key is made of.
 *
 * What the tests read a timeline by, and nothing else — the editor reads keys
 * everywhere. A key that holds one channel is an entry; one that holds two is
 * the two entries it is made of, which play the same at every keyframe and
 * differ in the way between them. What a corner has written about it in two
 * keys of one keyframe is the one thing this cannot say, an entry map having
 * room for one per keyframe.
 */
const asEntries = new WeakMap<KeyRig, Rig>();

/** `entriesOf`, made once per rig. */
export function entriesFor(rig: KeyRig): Rig {
  let held = asEntries.get(rig);

  if (held === undefined) {
    held = entriesOf(rig);
    asEntries.set(rig, held);
  }

  return held;
}

export function entriesOf(rig: KeyRig): Rig {
  let out = EMPTY_RIG;

  for (const [at, list] of rig.keys) {
    const entries: Entry[] = [];

    for (const key of list) {
      const repeat = {
        times: key.times,
        ...(key.skip === undefined ? {} : { skip: key.skip }),
        ...(key.group === undefined ? {} : { gesture: key.group }),
      };

      for (const op of everyOp({ ref: key.ref, by: key.by, stand: key.stand })) {
        entries.push({ ...repeat, op });
      }

      if (key.corners !== undefined) {
        for (const [vertex, by] of key.corners) {
          out = { ...out, nudges: cornered(out.nudges, vertex, at, { ...repeat, op: { kind: 'move', by } }) };
        }
      }

      for (const map of ['depths', 'rounds', 'deforms'] as const) {
        const mine = key[map];

        if (mine === undefined) continue;

        for (const [vertex, by] of mine) {
          // One map at a time, so that each keeps the kind it holds: the cast
          // is the lookup `AMOUNTS` makes true, as `amounted` says.
          const op = { kind: CORNER_KINDS[map], by } as Amount<AmountKind>;
          const held = cornered(out[map] as ReadonlyMap<VertexId, ReadonlyMap<KeyframeId, Entry<Amount>>>, vertex, at, { ...repeat, op });

          out = { ...out, [map]: held };
        }
      }
    }

    if (entries.length > 0) out = withKeys(out, at, entries);
  }

  return out;
}
