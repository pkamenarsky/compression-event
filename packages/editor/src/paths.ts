// -----------------------------------------------------------------------------
// Measuring paths
//
// A path is a route somebody might walk, drawn over the level and reported in
// seconds. It is a design aid and nothing else: not shipped, not collided
// with, not transformed by a version. See `Path` in `types.ts`.
//
// The measurement is deliberately the simple one — the run of the polyline at
// the speed the player walks at, with no acceleration and no cost for turning
// a corner. What it answers is "is this room twelve seconds across or three",
// which is the question a layout is judged by, and a model that took the ramps
// up and down into account would answer it to a precision the walk itself does
// not have: a player holding a key down is at full speed for all but the first
// tenth of a second of it.
// -----------------------------------------------------------------------------

import { SCALE, WALK_SPEED } from '@ce/game';
import { Path, PathId, Point, World } from './types';

/** Editor units the player covers in a second: the game's speed is in world
 * units, and the editor's grid is `SCALE` of one. */
export const PACE = WALK_SPEED / SCALE;

/** How long the walk to each point takes, from the first: one number per
 * point, starting at zero. */
export function timings(points: readonly Point[]): number[] {
  const out: number[] = [];
  let run = 0;

  points.forEach((p, i) => {
    if (i > 0) run += Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y);

    out.push(run / PACE);
  });

  return out;
}

/** A time as it is written on the canvas. Tenths throughout: a walk this is
 * worth drawing is seconds long, and hundredths would be a precision the
 * straight-line estimate does not have. */
export function seconds(t: number): string {
  return `${t.toFixed(1)}s`;
}

// -----------------------------------------------------------------------------
// Edits
//
// A path has no history and no versions, so all of these are a map with one
// entry replaced. They are here rather than in `scene.ts` for exactly that
// reason: nothing about a path goes through the chain.
// -----------------------------------------------------------------------------

/** A new path, and the id it was given. */
export function addPath(world: World, points: readonly Point[]): { world: World, id: PathId } {
  const id = world.nextId;
  const paths = new Map(world.paths);

  paths.set(id, { points: [...points] });

  return { world: { ...world, paths, nextId: id + 1 }, id };
}

/**
 * One path's points replaced, or the path dropped if what is left is not a
 * walk any more.
 *
 * Fewer than two points is the one case: a single point says nothing about how
 * long anything takes, and leaving one behind would leave a handle on the
 * canvas that no longer means anything. Taking the last point of a path away
 * is how a path is deleted, and it is the only way there is.
 */
export function setPath(world: World, id: PathId, points: readonly Point[]): World {
  const paths = new Map(world.paths);

  if (points.length < 2) paths.delete(id);
  else paths.set(id, { points: [...points] });

  return { ...world, paths };
}

export function removePath(world: World, id: PathId): World {
  const paths = new Map(world.paths);

  paths.delete(id);

  return { ...world, paths };
}

// -----------------------------------------------------------------------------
// Hit testing
// -----------------------------------------------------------------------------

/** One point of one path: which path, and where in it. */
export interface OnPath {
  id: PathId
  index: number
}

/** The point under the cursor, nearest first, or nothing. */
export function hitPathPoint(
  paths: ReadonlyMap<PathId, Path>,
  at: Point,
  reach: number,
): OnPath | null {
  let best: OnPath | null = null;
  let near = reach;

  for (const [id, path] of paths) {
    path.points.forEach((p, index) => {
      const d = Math.hypot(p.x - at.x, p.y - at.y);

      if (d <= near) {
        near = d;
        best = { id, index };
      }
    });
  }

  return best;
}

/**
 * The leg under the cursor, and where on it: what a click that adds a point
 * needs to know.
 *
 * `index` is the leg's first point, so the new point goes in after it.
 */
export function hitPathEdge(
  paths: ReadonlyMap<PathId, Path>,
  at: Point,
  reach: number,
): { id: PathId, index: number, at: Point } | null {
  let best: { id: PathId, index: number, at: Point } | null = null;
  let near = reach;

  for (const [id, path] of paths) {
    for (let i = 0; i + 1 < path.points.length; i++) {
      const on = nearest(path.points[i], path.points[i + 1], at);
      const d = Math.hypot(on.x - at.x, on.y - at.y);

      if (d <= near) {
        near = d;
        best = { id, index: i, at: on };
      }
    }
  }

  return best;
}

/** The point of the segment nearest `p`, clamped to its ends. */
function nearest(a: Point, b: Point, p: Point): Point {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = dx * dx + dy * dy;

  if (len === 0) return a;

  const t = Math.min(Math.max(((p.x - a.x) * dx + (p.y - a.y) * dy) / len, 0), 1);

  return { x: a.x + dx * t, y: a.y + dy * t };
}
