// -----------------------------------------------------------------------------
// Writing timelines in tests
//
// What the gestures write, said shortly: an operation is aimed at a point in
// world units and painted where the thing's middle is at the moment it is
// written, exactly as the canvas does it — see `painted` in `scene.ts`. Nothing
// in the editor imports this.
// -----------------------------------------------------------------------------

import { Point } from '@ce/game/world';
import { added } from './effects';
import { keyRigOf, layerOf, middleOf, moveOf, painted, rigOf, scaleOf, turnOf, withKeyRig, withRig, writtenInto } from './scene';
import { Amount, AmountKind, Move, amountIn, stateAt, Op, REST, addedBy, deltaOf, idle, keysAt, nextKey, nudgedBy, repeating, withKeys } from './rig';
import { TENSION, precisionFor } from './geometry';
import { DeformOptions, Id, KeyframeId, Layer, Options, REMEMBERED, RoundOptions, VertexId, World } from './types';

/** An operation, or one worked out from the world as it stands when it is
 * written — which is what a gesture's is — perhaps with the world changed to
 * have what it is written against: an amount's layer. */
export type Writing = Op | ((world: World, v: KeyframeId, id: Id) => Op | Wrote | Writing);

export interface Wrote {
  world: World
  op: Op
}

/** A writing worked out against `world`: the world it is written into, and
 * the operation. */
export function worked(world: World, v: KeyframeId, id: Id, op: Writing): Wrote {
  if (typeof op !== 'function') return { world, op };

  const out = op(world, v, id);

  if (typeof out === 'function') return worked(world, v, id, out);

  return 'kind' in out ? { world, op: out } : out;
}

/** Corners of a polygon moved at `v` by one gesture, in one key: what a drag
 * of several picked corners writes. */
export function nudge(world: World, v: KeyframeId, id: Id, corners: Iterable<VertexId>, by: Point): World {
  let rig = keyRigOf(world, id);
  const made = nextKey(rig);

  for (const c of corners) rig = nudgedBy(rig, made, c, v, by);

  return withKeyRig(world, id, rig);
}

/**
 * `ops` added to the end of what `v` does to `id`, one after another, each
 * written against the world the ones before it left, and each a key of its
 * own.
 *
 * A key each, where the canvas would fold them into one: what a test says by
 * writing four things is a keyframe that holds four. The hand that does not
 * let go is `wroteOne`, and the fold has its own tests.
 */
export function wrote(world: World, v: KeyframeId, id: Id, ...ops: Writing[]): World {
  let out = world;

  for (const op of ops) {
    const { world: into, op: written } = worked(out, v, id, op);
    const by = deltaOf(written);

    out = into;

    if (by === null || idle(by)) continue;

    out = withKeyRig(out, id, addedBy(keyRigOf(out, id), v, 'ref' in written ? written.ref : REST.t, by));
  }

  return out;
}

/** The same, as one gesture after another with the hand kept on the key the
 * first wrote, or on the keyframe's last where there is one already: what the
 * canvas writes, which goes into one key. See `EditorState.target`. */
export function wroteOne(world: World, v: KeyframeId, id: Id, ...ops: Writing[]): World {
  let out = world;
  let key = keysAt(keyRigOf(world, id), v).at(-1)?.id ?? null;

  for (const op of ops) {
    const w = worked(out, v, id, op);
    const written = writtenInto(w.world, v, id, key, w.op);

    out = written.world;
    key = written.key ?? key;
  }

  return out;
}

/** `op` added to the end of what `v` does to `id` as a repeat: `times` in
 * all, or to the end. */
export function repeated(world: World, v: KeyframeId, id: Id, op: Writing, times: number | null = null): World {
  const w = worked(world, v, id, op);
  const rig = rigOf(w.world, id);
  const entry = repeating(w.op, times);

  return withRig(w.world, id, withKeys(rig, v, [...(rig.keys.get(v) ?? []), entry]));
}

/** A move by a world-space step. */
export function moved(x: number, y: number): Writing {
  return (world, v, id) => moveOf(painted(world, v, id), { x, y });
}

/** A move in the frame the thing is held in, as it is written. */
export function move(x: number, y: number): Move {
  return { kind: 'move', by: { x, y } };
}

/**
 * An amount of one kind, on the thing's first layer of that kind — given one
 * where it has none, with the options an effect starts with: what a test that
 * erodes a room it never gave an erode layer means.
 */
export function amounted(kind: AmountKind, by: number): Writing {
  return (world, _v, id) => {
    const had = layerOf(world, id, kind);
    const made = had === undefined
      ? added(world, id, (kind === 'erode' ? { kind } : { kind, ...REMEMBERED[kind] }) as Omit<Layer, 'id'>)
      : { world, layer: had.id };

    return { world: made.world, op: { kind: 'amount', layer: made.layer, by } satisfies Amount };
  };
}

export function erode(by: number): Writing {
  return amounted('erode', by);
}

export function round(by: number): Writing {
  return amounted('round', by);
}

export function deform(by: number): Writing {
  return amounted('deform', by);
}

/** A turn about a world-space point: the origin, unless said otherwise. */
export function turned(angle: number, centre: Point = { x: 0, y: 0 }): Writing {
  return (world, v, id) => turnOf(painted(world, v, id), centre, angle);
}

/** A turn about the thing's own middle: a spin in place. */
export function spun(angle: number): Writing {
  return (world, v, id) => turnOf(painted(world, v, id), middleOf(world, v, id), angle);
}

/** A stretch along the thing's own axes about a world-space point: the
 * origin, unless said otherwise. */
export function scaled(x: number, y: number, centre: Point = { x: 0, y: 0 }): Writing {
  return (world, v, id) => scaleOf(painted(world, v, id), centre, { x, y });
}

/** A round's options that make exactly `segments` of a bevel of `bevel`:
 * what a test that counts points asks for. See `segmentsFor`. */
export function inSegments(segments: number, bevel: number): Options['round'] {
  return segments === 1
    ? { precision: 1, tension: TENSION, chamfer: true }
    : { precision: precisionFor(segments, bevel), tension: TENSION, chamfer: false };
}

/** A thing's effects as a record, one of each: how a test says what a thing
 * has, before lists. */
export interface Effects {
  round?: RoundOptions & { off?: boolean }
  deform?: DeformOptions & { off?: boolean }
  erode?: { off: boolean }
}

/**
 * A thing's effects set from a record, as layers in the order the fold used
 * to lay them: erode, round, deform. A kind it has a layer of already keeps
 * that layer's id, and so the amounts written against it.
 */
export function withEffects(world: World, id: Id, fx: Effects): World {
  let next = world.nextId;
  const list: Layer[] = [];

  for (const kind of ['erode', 'round', 'deform'] as const) {
    const had = layerOf(world, id, kind);
    const o = fx[kind];

    if (o === undefined) {
      if (kind === 'erode' && had !== undefined) list.push(had);

      continue;
    }

    list.push({ ...o, kind, id: had?.id ?? next++ } as Layer);
  }

  const effects = new Map(world.effects);

  if (list.length === 0) effects.delete(id);
  else effects.set(id, list);

  return { ...world, nextId: next, effects };
}

/** A thing's amount of one kind at `v`: its first layer of that kind's, and
 * nought where it has none. What a test reads where a state had an erosion, a
 * bevel and an amplitude. */
export function amountAt(world: World, id: Id, v: KeyframeId, kind: AmountKind): number {
  const l = layerOf(world, id, kind);

  return l === undefined ? 0 : amountIn(stateAt(world, id, v).amounts, l.id);
}

/** `writtenInto` for a writing: what the canvas does with the hand on `key`. */
export function writing(world: World, v: KeyframeId, id: Id, key: number | null, op: Writing): ReturnType<typeof writtenInto> {
  const w = worked(world, v, id, op);

  return writtenInto(w.world, v, id, key, w.op);
}
