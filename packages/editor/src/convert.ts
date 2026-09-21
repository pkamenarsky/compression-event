// -----------------------------------------------------------------------------
// Files from before keys, as files of keys
//
//   pnpm convert <world.json>...
//
// Writes `<world>.v24.json` beside each. What it reads is a 20, a 21, a 22 or
// a 23 — the formats whose timelines are lists of operations — and what it
// writes is a 24, whose timelines are keys. See `FORMAT` in `save.ts` for what
// each of those said, and `convert-19-20.ts` for what takes a 19 to a 21.
//
// Its own file, and not a branch inside `save.ts`, because a format is a thing
// a file *is* rather than a thing the editor carries a reading of. `save.ts`
// reads one shape and writes the same one; everything a file ever meant that
// it no longer means is here, where it is read once and left behind.
//
// Nothing in the editor imports this, and it imports the editor: the
// conversion needs `keysOf` to say what a list of operations is as keys, and
// the walk to check that it kept its word.
// -----------------------------------------------------------------------------

import { Point } from '@ce/game/world';
import {
  Amount,
  Entry,
  Frame,
  KeyframeId,
  Move,
  Op,
  Rig,
  Stand,
  keysOf,
  stateAt,
} from './rig';
import { Saved, SavedKey, savedKeyRig } from './save';
import { Effects, Id, Options, REMEMBERED, VertexId, World } from './types';

/** A timeline as a 23 and older wrote it: its lists, and a map per corner. */
export interface OldRig {
  keys: [KeyframeId, OldEntry[]][]
  nudges: [VertexId, [KeyframeId, OldEntry][]][]
  depths: [VertexId, [KeyframeId, OldEntry][]][]
  /** Absent in a 21, which had none. */
  rounds?: [VertexId, [KeyframeId, OldEntry][]][]
  deforms?: [VertexId, [KeyframeId, OldEntry][]][]
}

export interface OldEntry {
  op: OldOp
  times: number | null
  /** Absent is none. */
  skip?: KeyframeId[]
  /** Absent is none. */
  gesture?: number
}

/** A stand as it was written, with what a 22 first called its bevels. */
interface OldStand {
  kind: 'stand'
  frame: Frame
  erosion: number
  corners: [VertexId, Point][]
  depths: [VertexId, number][]
  /** Absent in a 21, where they are nought. */
  bevel?: number
  amplitude?: number
  bevels?: [VertexId, number][]
  amplitudes?: [VertexId, number][]
  /** What a 22 first called the bevels, when they were radii. */
  radius?: number
  radii?: [VertexId, number][]
}

type OldOp = Exclude<Op, { kind: 'stand' }> | OldStand;

/** A file as a 23 and older wrote it: everything a 24 has, with timelines of
 * operations and the fields that came later missing. */
export interface Old extends Omit<Saved, 'world'> {
  world: Omit<Saved['world'], 'rigs' | 'flags' | 'effects' | 'cornerEffects'> & {
    rigs: [Id, OldRig][]
    flags?: [Id, Flags][]
    effects?: [Id, Effects][]
    cornerEffects?: [VertexId, Partial<Effects>][]
  }
}

type Flags = Saved['world']['flags'][number][1];

/** The oldest and the newest this takes. Older than a 20 is
 * `convert-19-20.ts`; a 24 is already one. */
export const OLDEST = 20, NEWEST = 23;

/** A file of operations as a file of keys, or why it cannot be one. */
export function converted(file: Old): Saved | { refused: string } {
  if (file.format < OLDEST || file.format > NEWEST) {
    return { refused: `format ${file.format}, and this takes ${OLDEST} to ${NEWEST}` };
  }

  const rigs = file.world.rigs.map(([id, rig]) => [id, keysOf(restoredRig(rig))] as const);

  const out: Saved = {
    ...file,
    format: 24,
    world: {
      ...file.world,
      rigs: rigs.map(([id, rig]) => [id, savedKeyRig(rig)]),
      flags: file.world.flags ?? [],
      effects: (file.world.effects ?? []).map(([id, fx]) => [id, optioned(fx)]),
      cornerEffects: (file.world.cornerEffects ?? []).map(([c, fx]) => [c, optioned(fx)]),
    },
    // Baked against a world whose motion this may have changed in the way
    // between keyframes, and cheap to make again. See `Saved.baked`.
    baked: undefined,
  };

  const stood = held(file, new Map(rigs.map(([id, rig]) => [id, rig])));
  const strayed = stood === null ? null : stood;

  return strayed ?? out;
}

/** Whether every thing stands where it stood, at every keyframe: the
 * conversion holding itself to its word. Nothing where it does. */
function held(file: Old, rigs: Map<Id, ReturnType<typeof keysOf>>): { refused: string } | null {
  const world = {
    keyframes: file.world.keyframes,
    polygons: new Map(file.world.polygons),
    groups: new Map(file.world.groups),
    artefacts: new Map(file.world.artefacts),
    paths: new Map(file.world.paths),
    rigs,
  } as unknown as World;

  for (const [id] of rigs) {
    for (const k of file.world.keyframes) {
      const state = stateAt(world, id, k.id);

      if (!Number.isFinite(state.frame.t.x) || !Number.isFinite(state.frame.t.y)) {
        return { refused: `thing ${id} is nowhere at keyframe ${k.id}` };
      }
    }
  }

  return null;
}

function restoredRig(rig: OldRig): Rig {
  const corners = <O extends Op>(m: [VertexId, [KeyframeId, OldEntry][]][] = []): Map<VertexId, Map<KeyframeId, Entry<O>>> =>
    new Map(m.map(([c, map]) => [c, new Map(map.map(([k, e]) => [k, restoredEntry(e) as Entry<O>]))]));

  return {
    keys: new Map(rig.keys.map(([k, list]) => [k, list.map(restoredEntry)])),
    nudges: corners<Move>(rig.nudges),
    depths: corners<Amount<'erode'>>(rig.depths),
    rounds: corners<Amount<'round'>>(rig.rounds),
    deforms: corners<Amount<'deform'>>(rig.deforms),
  };
}

function restoredEntry(e: OldEntry): Entry {
  // A 20 has no skews: absent is nought.
  const op: Op = e.op.kind === 'stand'
    ? restoredStand(e.op)
    : e.op.kind === 'scale' ? { ...e.op, lean: e.op.lean ?? 0 } : e.op;

  const out: Entry = e.skip === undefined || e.skip.length === 0
    ? { op, times: e.times }
    : { op, times: e.times, skip: new Set(e.skip) };

  return e.gesture === undefined ? out : { ...out, gesture: e.gesture };
}

function restoredStand(op: OldStand): Stand {
  return {
    kind: 'stand',
    frame: { ...op.frame, skew: op.frame.skew ?? 0 },
    erosion: op.erosion,
    corners: new Map(op.corners),
    depths: new Map(op.depths),
    bevel: op.bevel ?? op.radius ?? 0,
    amplitude: op.amplitude ?? 0,
    bevels: new Map(op.bevels ?? op.radii ?? []),
    amplitudes: new Map(op.amplitudes ?? []),
  };
}

/** An effect's options, with what a 22 wrote at each point in its life read as
 * what they are now. */
function optioned<E extends Partial<Effects>>(fx: E): E {
  return {
    ...fx,
    ...(fx.round === undefined ? {} : { round: rounding(fx.round) }),
    ...(fx.deform === undefined ? {} : { deform: { ...REMEMBERED.deform, ...fx.deform } }),
  };
}

/**
 * A round as saved, from whenever in 22: its `verticals` and `ends` came and
 * went and are dropped, it was first a number of `segments`, which reads as a
 * chamfer where that was one and as the precision a round starts with
 * otherwise, and one without a `tension` reads at the one it starts with.
 */
function rounding(round: Effects['round'] & object): Options['round'] {
  const was = round as Partial<Options['round']> & { segments?: number };

  return {
    precision: was.precision ?? REMEMBERED.round.precision,
    tension: was.tension ?? REMEMBERED.round.tension,
    chamfer: was.chamfer ?? was.segments === 1,
    ...(was.off === undefined ? {} : { off: was.off }),
  };
}

export type { SavedKey };
