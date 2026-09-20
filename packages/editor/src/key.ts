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

import { Point } from '@ce/game/world';
import { Affine, compose } from './affine';
import {
  AMOUNTS,
  AMOUNT_KINDS,
  AmountKind,
  CORNER_MAPS,
  CornerMap,
  Frame,
  Keyframe,
  KeyframeId,
  NO_CORNERS,
  NO_DEPTHS,
  Op,
  Placing,
  REST,
  Repeat,
  Rig,
  Stand,
  State,
  affineOf,
  applications,
  counted,
  indexIn,
  linear,
  orNever,
  placed,
  sheared,
  slid,
  spun,
  unsheared,
} from './rig';
import { Vertex, VertexId } from './types';

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
   * Where the delta turns about, as an offset from the painted point, for the
   * one delta that cannot say: a turn by a whole number of turns, whose linear
   * part is the identity and whose `move` is therefore nought. Absent
   * everywhere else, where the pair says it already.
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
  if (whole(d.angle)) return d.about ?? null;

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

  const l = linearOf(d);
  let move = d.move;

  for (let i = 0; i < n; i++) move = through(l, move);

  return { ...d, move, ...(d.about === undefined ? {} : { about: stepAbout(d, n) }) };
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
      // about`, since the anchor is `about` away from it. By a whole number of
      // turns it goes nowhere and the anchor is lost, so the anchor comes too.
      if (whole(op.angle)) return { ...NOTHING, angle: op.angle, about: op.about };

      const d = spun(op.about, op.angle);

      return { ...NOTHING, angle: op.angle, move: { x: op.about.x - d.x, y: op.about.y - d.y } };
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

/** A repeat under way: the key, where it was written, and how many steps it
 * has taken. */
interface Running {
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
): (State | undefined)[] {
  const n = keyframes.length;
  const out: (State | undefined)[] = new Array(n).fill(undefined);
  const born = indexIn(keyframes, birth);

  if (born < 0) return out;

  const placing: Placing[] = corners.map(c => ({
    corner: c,
    birth: indexIn(keyframes, c.birth),
    death: c.death === null ? Infinity : orNever(indexIn(keyframes, c.death)),
  }));

  let frame = REST;
  const totals: Record<AmountKind, number> = { erode: 0, round: 0, deform: 0 };
  let running: Running[] = [];
  let stood: { at: number, op: Stand } | null = null;

  for (let i = born; i < n; i++) {
    const at = keyframes[i].id;

    const apply = (key: Key, step: number): void => {
      if (key.stand !== undefined) {
        frame = key.stand.frame;
        for (const kind of AMOUNT_KINDS) totals[kind] = key.stand[AMOUNTS[kind].total];

        return;
      }

      if (key.by === undefined) return;

      const d = steppedBy(key.by, step);

      frame = playedBy(frame, key.ref, d);
      for (const kind of AMOUNT_KINDS) totals[kind] += d[kind];
    };

    // The steps of repeats begun earlier, oldest first. A skipped keyframe is
    // not a step: the repeat waits over it and carries its count on.
    const going: Running[] = [];

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

    out[i] = {
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
