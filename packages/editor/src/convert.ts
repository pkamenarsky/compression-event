// -----------------------------------------------------------------------------
// Files from before keys, as files of keys, and deforms in the world as
// deforms in proportion
//
//   pnpm convert <world.json>...
//
// Writes `<world>.v26.json` beside each. What it reads is a 20, a 21, a 22 or
// a 23 — the formats whose timelines are lists of operations — which it makes
// a 24, whose timelines are keys (`converted`); a 24, whose amounts are
// lengths in the world, which it makes a 26, whose amounts are lengths at the
// thing's own scale (`relative`); and a 25, whose kinds are a type and a mask,
// which it makes a 26, whose kinds are a part per set (`unmasked`). See
// `FORMAT` in `save.ts` for what each of those said, and `convert-19-20.ts`
// for what takes a 19 to a 21.
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

import { Point, PolygonKind } from '@ce/game/world';
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
import { FORMAT, Saved, SavedKey, restored, saved, savedKeyRig } from './save';
import { chain, scaleAt, standingIn } from './scene';
import { Key } from './rig';
import { Effects, Id, Options, Polygon, PolygonId, REMEMBERED, VertexId, World } from './types';

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

/** A polygon's kind as a 25 and older wrote it. */
interface OldKind {
  type: 'level' | 'solid' | 'floor' | 'void'
  /** What a void cut: 1 the solids, 2 the floors, 3 both. */
  from?: number
}

/**
 * Every polygon's kind as the part it plays in each set, the rest of the file
 * as it was — whatever its format, which is left for the caller to move on.
 *
 * Every old kind is a new one: the plain three are one part each, and a void
 * is a void in each set its mask named. A polygon without a `type` is taken
 * to be one already.
 */
export function kinded(file: Saved): Saved {
  const kind = (old: OldKind): PolygonKind => {
    if (old.type === 'void') {
      const from = old.from ?? 1;

      return {
        ...((from & 1) === 0 ? {} : { level: 'void' as const }),
        ...((from & 2) === 0 ? {} : { floor: 'void' as const }),
      };
    }

    return old.type === 'floor' ? { floor: 'floor' } : { level: old.type === 'level' ? 'hollow' : old.type };
  };

  const polygons = file.world.polygons.map(([id, p]): [PolygonId, Polygon] => {
    // One already a 26's, which a file handed on from `converted` is where the
    // format it was made from had nothing to say about kinds.
    if (!('type' in p)) return [id, p];

    const { type: _type, from: _from, ...rest } = p as unknown as Polygon & OldKind;

    return [id, { ...rest, ...kind(p as unknown as OldKind) }];
  });

  return { ...file, world: { ...file.world, polygons } };
}

/** A 25 as a 26: see `kinded`. */
export function unmasked(file: Saved): Saved | { refused: string } {
  if (file.format !== 25) return { refused: `format ${file.format}, and this takes 25` };

  return { ...kinded(file), format: 26 };
}

/**
 * A 24 as a 26: every amount — depths, bevels, a deform's spacing and its
 * amplitudes — which was a length in the world, as a length at the thing's
 * own scale, which the world multiplies by `scaleAt`.
 *
 * Taken at the first keyframe the thing stands at, which is where it was
 * made. The amounts add up, so dividing every one of them divides what they
 * come to, and the thing is eroded, rounded and deformed there exactly as it
 * was. Where it is scaled afterwards its amounts now scale with it, which is
 * the point of the change. At scale one, which is nearly everything, nothing
 * changes at all.
 */
export function relative(file: Saved): Saved | { refused: string } {
  if (file.format !== 24) return { refused: `format ${file.format}, and this takes 24` };

  // Its kinds made a 26's first, since what reads it is the editor, and the
  // editor reads nothing else. What comes out is a 26 whole.
  const state = restored({ ...kinded(file), format: FORMAT });
  const world = state.world;
  const effects = new Map(world.effects);
  const rigs = new Map(world.rigs);

  for (const [id, rig] of world.rigs) {
    const from = world.keyframes.find(k => standingIn(world, id, new Set(chain(world, k.id))));
    const k = from === undefined ? 1 : scaleAt(world, id, from.id);

    if (k === 1 || !(k > 0)) continue;

    const fx = world.effects.get(id);

    if (fx?.deform !== undefined) effects.set(id, { ...fx, deform: { ...fx.deform, spacing: fx.deform.spacing / k } });

    const shrunk = (m: ReadonlyMap<number, number>) => new Map([...m].map(([c, a]) => [c, a / k]));
    const key = (key: Key): Key => ({
      ...key,
      ...(key.by === undefined
        ? {}
        : { by: { ...key.by, erode: key.by.erode / k, round: key.by.round / k, deform: key.by.deform / k } }),
      ...(key.depths === undefined ? {} : { depths: shrunk(key.depths) }),
      ...(key.rounds === undefined ? {} : { rounds: shrunk(key.rounds) }),
      ...(key.deforms === undefined ? {} : { deforms: shrunk(key.deforms) }),
      ...(key.stand === undefined
        ? {}
        : {
          stand: {
            ...key.stand,
            erosion: key.stand.erosion / k,
            depths: shrunk(key.stand.depths),
            bevel: key.stand.bevel / k,
            bevels: shrunk(key.stand.bevels),
            amplitude: key.stand.amplitude / k,
            amplitudes: shrunk(key.stand.amplitudes),
          },
        }),
    });

    rigs.set(id, { ...rig, keys: new Map([...rig.keys].map(([at, keys]) => [at, keys.map(key)])) });
  }

  return {
    ...saved({ ...state, world: { ...world, effects, rigs } }),
    // Baked against the same geometry, but cheap to make again, and a bake is
    // the last place to find out a conversion was wrong.
    baked: undefined,
  };
}
