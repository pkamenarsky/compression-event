// -----------------------------------------------------------------------------
// Writing timelines in tests
//
// What the gestures write, said shortly: an operation is aimed at a point in
// world units and painted where the thing's middle is at the moment it is
// written, exactly as the canvas does it — see `painted` in `scene.ts`. Nothing
// in the editor imports this.
// -----------------------------------------------------------------------------

import { Point } from '@ce/game/world';
import { keyRigOf, middleOf, moveOf, painted, rigOf, scaleOf, turnOf, withKeyRig, withRig, writtenInto } from './scene';
import { Amount, Move, Op, REST, addedBy, deltaOf, idle, keysAt, nextKey, nudgedBy, repeating, withKeys } from './rig';
import { TENSION, precisionFor } from './geometry';
import { Id, KeyframeId, Options, VertexId, World } from './types';

/** An operation, or one worked out from the world as it stands when it is
 * written — which is what a gesture's is. */
export type Writing = Op | ((world: World, v: KeyframeId, id: Id) => Op);

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
    const written = typeof op === 'function' ? op(out, v, id) : op;
    const by = deltaOf(written);

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
    const written = writtenInto(out, v, id, key, typeof op === 'function' ? op(out, v, id) : op);

    out = written.world;
    key = written.key ?? key;
  }

  return out;
}

/** `op` added to the end of what `v` does to `id` as a repeat: `times` in
 * all, or to the end. */
export function repeated(world: World, v: KeyframeId, id: Id, op: Writing, times: number | null = null): World {
  const rig = rigOf(world, id);
  const entry = repeating(typeof op === 'function' ? op(world, v, id) : op, times);

  return withRig(world, id, withKeys(rig, v, [...(rig.keys.get(v) ?? []), entry]));
}

/** A move by a world-space step. */
export function moved(x: number, y: number): Writing {
  return (world, v, id) => moveOf(painted(world, v, id), { x, y });
}

/** A move in the frame the thing is held in, as it is written. */
export function move(x: number, y: number): Move {
  return { kind: 'move', by: { x, y } };
}

export function erode(by: number): Amount {
  return { kind: 'erode', by };
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
