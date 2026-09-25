// -----------------------------------------------------------------------------
// Files from before keys, as files of keys, deforms in the world as deforms
// in proportion, and effects on single corners and edges dropped
//
//   pnpm convert <world.json>...
//
// Writes `<world>.v27.json` beside each. What it reads is a 20, a 21, a 22 or
// a 23 — the formats whose timelines are lists of operations — which it makes
// a 24, whose timelines are keys (`converted`); a 24, whose amounts are
// lengths in the world, which it makes a 27, whose amounts are lengths at the
// thing's own scale (`relative`); a 25, whose kinds are a type and a mask,
// which it makes a 26, whose kinds are a part per set (`unmasked`); and a 26,
// whose effects could be written about single corners and edges, which it
// makes a 27, where they cannot (`uncornered`); and a 27, whose effects are a
// record and whose amounts are three numbers, which it makes a 28, whose
// effects are a list of layers and whose amounts are by layer (`layered`).
// See `FORMAT` in `save.ts` for
// what each of those said, and `convert-19-20.ts` for what takes a 19 to a
// 21.
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
  Amounts,
  Delta,
  Entry,
  Frame,
  KeyRig,
  KeyframeId,
  Move,
  Op,
  Rig,
  Stand,
  keysOf,
  stateAt,
  timesAmounts,
} from './rig';
import { FORMAT, Saved, SavedKey, SavedStand, restored, saved } from './save';
import { chain, scaleAt, standingIn } from './scene';
import { Key } from './rig';
import { DeformOptions, Id, Layer, LayerId, Options, Polygon, PolygonId, REMEMBERED, RoundOptions, VertexId, World } from './types';

/** A thing's effects as a 27 and older wrote them: one of each, in the fixed
 * order, and an erosion that applied unless switched off. */
export interface Effects {
  round?: RoundOptions & { off?: boolean }
  deform?: DeformOptions & { off?: boolean }
  erode?: { off: boolean }
}

/** A delta as a 27 wrote it: three amounts by name. */
type Delta27 = Omit<Delta, 'amounts'> & { erode: number, round: number, deform: number };

/** A stand as a 27 wrote it. */
interface SavedStand27 {
  kind: 'stand'
  frame: Frame
  erosion: number
  corners: [VertexId, Point][]
  bevel: number
  amplitude: number
}

/** A key as a 27 wrote it. */
export interface SavedKey27 extends Omit<SavedKey, 'by' | 'stand'> {
  by?: Partial<Delta27>
  stand?: SavedStand27
}

/** A file as a 24 to a 27 wrote it: its effects a record, its amounts three
 * numbers. */
export interface Saved27 extends Omit<Saved, 'world'> {
  world: Omit<Saved['world'], 'rigs' | 'effects'> & {
    rigs: [Id, { keys: [KeyframeId, SavedKey27[]][] }][]
    effects: [Id, Effects][]
  }
}

/**
 * The three amounts of a 27, carried through the editor's walk by the layers
 * they would be — a converter's own, never a world's: every id a world makes
 * is from nought up.
 */
const ERODE = -1, ROUND = -2, DEFORM = -3;

/** An amount operation as a 23 and older wrote it. */
type OldAmount = { kind: 'erode' | 'round' | 'deform', by: number };

const AS_LAYER = { erode: ERODE, round: ROUND, deform: DEFORM } as const;

/** A timeline of keys as a 27 writes it, from one walked with the stand-in
 * layers. */
function savedKeyRig27(rig: KeyRig): { keys: [KeyframeId, SavedKey27[]][] } {
  const three = (a: Amounts) => ({ erode: a.get(ERODE) ?? 0, round: a.get(ROUND) ?? 0, deform: a.get(DEFORM) ?? 0 });

  return {
    keys: [...rig.keys].map(([k, list]) => [k, list.map((key): SavedKey27 => {
      const { by, stand, corners, skip, ...rest } = key;

      return {
        ...rest,
        ...(by === undefined ? {} : { by: (({ amounts, ...d }) => ({ ...d, ...three(amounts) }))(by) }),
        ...(corners === undefined || corners.size === 0 ? {} : { corners: [...corners] }),
        ...(skip === undefined || skip.size === 0 ? {} : { skip: [...skip] }),
        ...(stand === undefined ? {} : {
          stand: (({ amounts, corners: c, ...st }) => ({
            ...st,
            corners: [...c],
            erosion: amounts.get(ERODE) ?? 0,
            bevel: amounts.get(ROUND) ?? 0,
            amplitude: amounts.get(DEFORM) ?? 0,
          }))(stand),
        }),
      };
    })]),
  };
}

/** A timeline as a 23 and older wrote it: its lists, and a map per corner.
 * The amounts on single corners are read and dropped: see `uncornered`. */
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

type OldOp = Exclude<Op, { kind: 'stand' | 'amount' }> | OldAmount | OldStand;

/** A file as a 23 and older wrote it: everything a 24 has, with timelines of
 * operations and the fields that came later missing. */
export interface Old extends Omit<Saved27, 'world'> {
  world: Omit<Saved27['world'], 'rigs' | 'flags' | 'effects'> & {
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
export function converted(file: Old): Saved27 | { refused: string } {
  if (file.format < OLDEST || file.format > NEWEST) {
    return { refused: `format ${file.format}, and this takes ${OLDEST} to ${NEWEST}` };
  }

  const rigs = file.world.rigs.map(([id, rig]) => [id, keysOf(restoredRig(rig))] as const);

  const out: Saved27 = {
    ...file,
    format: 24,
    world: {
      ...file.world,
      rigs: rigs.map(([id, rig]) => [id, savedKeyRig27(rig)]),
      flags: file.world.flags ?? [],
      effects: (file.world.effects ?? []).map(([id, fx]) => [id, optioned(fx)]),
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
  };
}

function restoredEntry(e: OldEntry): Entry {
  // A 20 has no skews: absent is nought.
  const was = e.op;
  const op: Op = was.kind === 'stand'
    ? restoredStand(was)
    : 'layer' in was || !(was.kind in AS_LAYER)
      ? was.kind === 'scale' ? { ...was, lean: was.lean ?? 0 } : was as Op
      : { kind: 'amount', layer: AS_LAYER[was.kind as OldAmount['kind']], by: (was as OldAmount).by };

  const out: Entry = e.skip === undefined || e.skip.length === 0
    ? { op, times: e.times }
    : { op, times: e.times, skip: new Set(e.skip) };

  return e.gesture === undefined ? out : { ...out, gesture: e.gesture };
}

function restoredStand(op: OldStand): Stand {
  return {
    kind: 'stand',
    frame: { ...op.frame, skew: op.frame.skew ?? 0 },
    corners: new Map(op.corners),
    amounts: new Map([[ERODE, op.erosion], [ROUND, op.bevel ?? op.radius ?? 0], [DEFORM, op.amplitude ?? 0]]),
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
function rounding(round: Effects['round'] & object): Options['round'] & { off?: boolean } {
  const was = round as Partial<Options['round']> & { segments?: number, off?: boolean };

  return {
    precision: was.precision ?? REMEMBERED.round.precision,
    tension: was.tension ?? REMEMBERED.round.tension,
    chamfer: was.chamfer ?? was.segments === 1,
    ...(was.off === undefined ? {} : { off: was.off }),
  };
}

/** A 26's key, with what a key could say about single corners' amounts. */
interface CorneredKey extends SavedKey27 {
  depths?: [VertexId, number][]
  rounds?: [VertexId, number][]
  deforms?: [VertexId, number][]
  stand?: SavedKey27['stand'] & {
    depths?: [VertexId, number][]
    bevels?: [VertexId, number][]
    amplitudes?: [VertexId, number][]
  }
}

/**
 * A 26 as a 27: every effect one amount over its whole ring and one set of
 * options. The amounts written about single corners and edges — a key's
 * `depths`, `rounds` and `deforms`, and a stand's `depths`, `bevels` and
 * `amplitudes` — are dropped, and so are an edge's own deform options,
 * `cornerEffects`. Each polygon keeps its own amounts and options.
 *
 * The one conversion that loses something: wherever those were used, the
 * drawing changes, and the bake with it, which is dropped where anything was.
 * Nothing else about the file is touched.
 */
export function uncornered(file: Saved27): Saved27 | { refused: string } {
  if (file.format !== 26) return { refused: `format ${file.format}, and this takes 26` };

  let lost = false;

  const some = (m: readonly unknown[] | undefined): boolean => m !== undefined && m.length > 0;
  const key = (was: SavedKey27): SavedKey27 => {
    const { depths, rounds, deforms, stand, ...rest } = was as CorneredKey;

    if (some(depths) || some(rounds) || some(deforms)) lost = true;
    if (stand === undefined) return rest;

    const { depths: d, bevels: b, amplitudes: a, ...kept } = stand;

    if ([d, b, a].some(m => (m ?? []).some(([, x]) => x !== 0))) lost = true;

    return { ...rest, stand: kept };
  };

  const { cornerEffects, ...world } = file.world as Saved27['world'] & { cornerEffects?: unknown[] };

  if (some(cornerEffects)) lost = true;

  const rigs = world.rigs.map(([id, rig]): Saved27['world']['rigs'][number] => [
    id,
    { keys: rig.keys.map(([k, list]) => [k, list.map(key)]) },
  ]);

  return {
    ...file,
    format: 27,
    world: { ...world, rigs },
    ...(lost ? { baked: undefined } : {}),
  };
}

export type { SavedKey };

/** A 27's stand, for what reads one. */
export type { SavedStand };

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
export function kinded(file: Saved27): Saved27 {
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
export function unmasked(file: Saved27): Saved27 | { refused: string } {
  if (file.format !== 25) return { refused: `format ${file.format}, and this takes 25` };

  return { ...kinded(file), format: 26 };
}

/**
 * A 27 as a 28: each thing's effects as a list of layers, in the order the
 * fold laid them — erode, round, deform — each with an id from the file's
 * counter; and its amounts by layer.
 *
 * An erosion applied unless switched off, so a thing gets an erode layer
 * wherever it had one switched off or any depth written. A bevel or an
 * amplitude with no round or deform to be about did nothing, and goes.
 * Nothing drawn changes, and the bake stays.
 */
export function layered(file: Saved27): Saved | { refused: string } {
  if (file.format !== 27) return { refused: `format ${file.format}, and this takes 27` };

  let next = file.world.nextId;
  const effects = new Map(file.world.effects);
  const rigs = new Map(file.world.rigs);
  const lists = new Map<Id, Layer[]>();

  for (const id of new Set([...effects.keys(), ...rigs.keys()])) {
    const fx = effects.get(id) ?? {};
    const keys = (rigs.get(id)?.keys ?? []).flatMap(([, list]) => list);
    const eroded = keys.some(k => (k.by?.erode ?? 0) !== 0 || (k.stand?.erosion ?? 0) !== 0);
    const list: Layer[] = [];

    if (fx.erode !== undefined || eroded) list.push({ id: next++, kind: 'erode', ...(fx.erode?.off === true ? { off: true } : {}) });
    if (fx.round !== undefined) list.push({ ...fx.round, id: next++, kind: 'round' });
    if (fx.deform !== undefined) list.push({ ...fx.deform, id: next++, kind: 'deform' });

    if (list.length > 0) lists.set(id, list);
  }

  const idOf = (id: Id, kind: Layer['kind']): LayerId | undefined => lists.get(id)?.find(l => l.kind === kind)?.id;

  const amounts = (id: Id, three: { erode?: number, round?: number, deform?: number }): [LayerId, number][] | undefined => {
    const out: [LayerId, number][] = [];

    for (const kind of ['erode', 'round', 'deform'] as const) {
      const layer = idOf(id, kind), by = three[kind] ?? 0;

      if (layer !== undefined && by !== 0) out.push([layer, by]);
    }

    return out.length === 0 ? undefined : out;
  };

  const key = (id: Id) => (was: SavedKey27): SavedKey => {
    const { by, stand, ...rest } = was;
    const out: SavedKey = { ...rest };

    if (by !== undefined) {
      const { erode, round, deform, ...d } = by;
      const a = amounts(id, { erode, round, deform });

      out.by = a === undefined ? d : { ...d, amounts: a };
    }

    if (stand !== undefined) {
      const { erosion, bevel, amplitude, ...st } = stand;
      const a = amounts(id, { erode: erosion, round: bevel, deform: amplitude });

      out.stand = a === undefined ? st : { ...st, amounts: a };
    }

    return out;
  };

  return {
    ...file,
    format: 28,
    world: {
      ...file.world,
      nextId: next,
      rigs: file.world.rigs.map(([id, rig]) => [id, { keys: rig.keys.map(([k, list]) => [k, list.map(key(id))]) }]),
      effects: [...lists],
    },
  };
}

/**
 * A 24 as a 28: every amount — depths, bevels, a deform's spacing and its
 * amplitudes — which was a length in the world, as a length at the thing's
 * own scale, which the world multiplies by `scaleAt`; and then everything a
 * 25 to a 27 changed, through `layered`.
 *
 * Taken at the first keyframe the thing stands at, which is where it was
 * made. The amounts add up, so dividing every one of them divides what they
 * come to, and the thing is eroded, rounded and deformed there exactly as it
 * was. Where it is scaled afterwards its amounts now scale with it, which is
 * the point of the change. At scale one, which is nearly everything, nothing
 * changes at all.
 */
export function relative(file: Saved27): Saved | { refused: string } {
  if (file.format !== 24) return { refused: `format ${file.format}, and this takes 24` };

  // Made a 28 first, since what reads it is the editor, and the editor reads
  // nothing else: its kinds a 26's, its amounts on single corners dropped as
  // `uncornered` drops them, and its effects layers.
  const cornerless = uncornered({ ...kinded(file), format: 26 });

  if ('refused' in cornerless) return cornerless;

  const now = layered({ ...cornerless, format: 27 });

  if ('refused' in now) return now;

  const state = restored({ ...now, format: FORMAT });
  const world = state.world;
  const effects = new Map(world.effects);
  const rigs = new Map(world.rigs);

  for (const [id, rig] of world.rigs) {
    const from = world.keyframes.find(k => standingIn(world, id, new Set(chain(world, k.id))));
    const k = from === undefined ? 1 : scaleAt(world, id, from.id);

    if (k === 1 || !(k > 0)) continue;

    const fx = world.effects.get(id);

    if (fx !== undefined) effects.set(id, fx.map(l => (l.kind === 'deform' ? { ...l, spacing: l.spacing / k } : l)));

    const key = (key: Key): Key => ({
      ...key,
      ...(key.by === undefined ? {} : { by: { ...key.by, amounts: timesAmounts(key.by.amounts, 1 / k) } }),
      ...(key.stand === undefined ? {} : { stand: { ...key.stand, amounts: timesAmounts(key.stand.amounts, 1 / k) } }),
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
