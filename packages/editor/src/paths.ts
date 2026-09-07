// -----------------------------------------------------------------------------
// Measuring paths
//
// A path is a route somebody might walk, drawn over the level and reported in
// seconds. It is a design aid and nothing else: not shipped and not collided
// with. It *is* in the versions and in the groups, because a tape is worth
// what it says only while it is still lying across the room it was laid over —
// see `Path` in `types.ts`, and `Laid` in `scene.ts` for the read.
//
// The measurement is deliberately the simple one — the run of the polyline at
// the speed the player walks at, with no acceleration and no cost for turning
// a corner. What it answers is "is this room twelve seconds across or three",
// which is the question a layout is judged by, and a model that took the ramps
// up and down into account would answer it to a precision the walk itself does
// not have: a player holding a key down is at full speed for all but the first
// tenth of a second of it.
// -----------------------------------------------------------------------------

import { WALK_SPEED } from '@ce/game';
import { SCALE } from '@ce/game/world';
import { Laid, Landing, joined, unplace, without } from './scene';
import { PathId, Point, VersionId, World } from './types';

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
// The route is one list that every version reads, so writing a point is a map
// with one entry replaced and no layer to put it in. What the versions carry
// for a path is where it *is* — a transform, written by the same gestures that
// write one for a polygon — and that goes through `scene.ts` like everything
// else's does. These are the other half: the walk itself.
//
// Every one of them takes points in the path's own frame. A gesture has world
// units in hand and takes them back through `under` first, which is the same
// inverse a corner's displacement goes through and for the same reason: the
// point is being written where it will be read from, so that a path inside a
// turned group keeps the shape it was drawn with.
// -----------------------------------------------------------------------------

/**
 * A new path, born into the version it was laid down in, and the id it was
 * given.
 *
 * Read in the landing's frame, like a dropped artefact: a walk laid inside a
 * group standing open is a member of that group, running exactly where it was
 * drawn rather than wherever the group's own transform would have sent it.
 */
export function addPath(
  world: World,
  points: readonly Point[],
  v: VersionId,
  where: Landing,
): { world: World, id: PathId } {
  const id = world.nextId;
  const paths = new Map(world.paths);

  paths.set(id, {
    birth: v,
    death: null,
    points: points.map(p => unplace(where.frame, p)),
  });

  return {
    world: joined({ ...world, paths, nextId: id + 1 }, where.into, [id]),
    id,
  };
}

/**
 * One path's points replaced, or the path dropped if what is left is not a
 * walk any more.
 *
 * Fewer than two points is the one case: a single point says nothing about how
 * long anything takes, and leaving one behind would leave a handle on the
 * canvas that no longer means anything.
 *
 * Outright rather than at a version, which is the one place a path is not like
 * everything else — and it has to be, because the route is the one list every
 * version reads. There is no version at which one point is a walk, so there is
 * nothing for a death written at the version on screen to be about. `removeAt`
 * is the other way to lose a path and is the versioned one; this is the walk
 * running out. Whatever group was holding it loses it the same way a deleted
 * polygon's does.
 */
export function setPath(world: World, id: PathId, points: readonly Point[]): World {
  const it = world.paths.get(id);

  if (it === undefined) return world;

  const paths = new Map(world.paths);

  if (points.length >= 2) {
    paths.set(id, { ...it, points: [...points] });

    return { ...world, paths };
  }

  paths.delete(id);

  return without({ ...world, paths }, new Set([id]));
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
  laid: readonly Laid[],
  at: Point,
  reach: number,
): OnPath | null {
  let best: OnPath | null = null;
  let near = reach;

  for (const path of laid) {
    path.points.forEach((p, index) => {
      const d = Math.hypot(p.x - at.x, p.y - at.y);

      if (d <= near) {
        near = d;
        best = { id: path.id, index };
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
  laid: readonly Laid[],
  at: Point,
  reach: number,
): { id: PathId, index: number, at: Point } | null {
  let best: { id: PathId, index: number, at: Point } | null = null;
  let near = reach;

  for (const path of laid) {
    for (let i = 0; i + 1 < path.points.length; i++) {
      const on = nearest(path.points[i], path.points[i + 1], at);
      const d = Math.hypot(on.x - at.x, on.y - at.y);

      if (d <= near) {
        near = d;
        best = { id: path.id, index: i, at: on };
      }
    }
  }

  return best;
}

/**
 * The path under the cursor, whole: which one a click that picks rather than
 * one that edits is about.
 *
 * The nearest leg, so that a click anywhere along the tape picks it — the
 * points are a smaller target and are what the two tools that edit a path aim
 * at, and picking one is a question about the walk rather than about a corner
 * of it.
 */
export function hitPath(laid: readonly Laid[], at: Point, reach: number): PathId | null {
  return hitPathEdge(laid, at, reach)?.id ?? null;
}

/** Every path with a point inside the box, which is the same rule a marquee
 * takes a polygon by. */
export function pathsWithinBox(laid: readonly Laid[], a: Point, b: Point): PathId[] {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);

  return laid
    .filter(it => it.points.some(p => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1))
    .map(it => it.id);
}

/** The point of the segment nearest `p`, clamped to its ends. */
function nearest(a: Point, b: Point, p: Point): Point {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = dx * dx + dy * dy;

  if (len === 0) return a;

  const t = Math.min(Math.max(((p.x - a.x) * dx + (p.y - a.y) * dy) / len, 0), 1);

  return { x: a.x + dx * t, y: a.y + dy * t };
}
