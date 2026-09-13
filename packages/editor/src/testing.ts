// -----------------------------------------------------------------------------
// Writing timelines in tests
//
// What the gestures write, said shortly: an operation is aimed at a point in
// world units and painted where the thing's middle is at the moment it is
// written, exactly as the canvas does it — see `painted` in `scene.ts`. Nothing
// in the editor imports this.
// -----------------------------------------------------------------------------

import { Point } from '@ce/game/world';
import { appended, middleOf, moveOf, painted, scaleOf, turnOf } from './scene';
import { Erode, Move, Op } from './rig';
import { Id, KeyframeId, World } from './types';

/** An operation, or one worked out from the world as it stands when it is
 * written — which is what a gesture's is. */
export type Writing = Op | ((world: World, v: KeyframeId, id: Id) => Op);

/** `ops` added to the end of what `v` does to `id`, one after another, each
 * written against the world the ones before it left. */
export function wrote(world: World, v: KeyframeId, id: Id, ...ops: Writing[]): World {
  let out = world;

  for (const op of ops) out = appended(out, v, id, typeof op === 'function' ? op(out, v, id) : op);

  return out;
}

/** A move by a world-space step. */
export function moved(x: number, y: number): Writing {
  return (world, v, id) => moveOf(painted(world, v, id), { x, y });
}

/** A move in the frame the thing is held in, as it is written. */
export function move(x: number, y: number): Move {
  return { kind: 'move', by: { x, y } };
}

export function erode(by: number): Erode {
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
