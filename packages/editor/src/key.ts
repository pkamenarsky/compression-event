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
// Not here yet: playing a key part way, which the bake needs. At `u = 1` there
// is nothing to decide; part way there is, and the rule is
// `moveᵤ = (I − Lᵤ) · w` where `(I − L) w = move` — the painted point going
// round the delta's fixed point, which comes out as an arc for a turn and as
// `(1 − dᵘ)/(1 − d)` for a stretch, both of them exactly what `played` does
// today. Where `L` has no unique fixed point the point goes in a line, which
// is what a move and a shear do today; where it has none but the gesture had a
// centre — a turn by a whole number of turns — the centre is unrecoverable
// from the delta and `about` carries it.
// -----------------------------------------------------------------------------

import { Point } from '@ce/game/world';
import { Affine, compose } from './affine';
import { Frame, KeyframeId, Op, Stand, affineOf, linear, placed, spun } from './rig';
import { VertexId } from './types';

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
 * A delta played over the frame it starts from.
 *
 * The parameters add and multiply, and the frame is placed so that the painted
 * point lands where `move` says. Everything a turn's anchor and a stretch's
 * slide do falls out of that: see the equivalences in `key.test.ts`.
 */
export function playedBy(f: Frame, ref: Point, d: Delta): Frame {
  const p = placed(f, ref);

  const frame = {
    ...f,
    angle: f.angle + d.angle,
    skew: f.skew + d.skew,
    scale: { x: f.scale.x * d.scale.x, y: f.scale.y * d.scale.y },
  };

  const v = linear(frame, ref);

  return { ...frame, t: { x: p.x + d.move.x - v.x, y: p.y + d.move.y - v.y } };
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
      // about`, since the anchor is `about` away from it.
      const d = spun(op.about, op.angle);
      const move = { x: op.about.x - d.x, y: op.about.y - d.y };
      const whole = move.x === 0 && move.y === 0 && op.angle !== 0;

      return { ...NOTHING, angle: op.angle, move, ...(whole ? { about: op.about } : {}) };
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
