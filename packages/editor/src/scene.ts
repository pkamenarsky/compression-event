// -----------------------------------------------------------------------------
// What the world looks like right now
//
// A polygon keeps the points it was drawn with and a transform describing what
// has happened to it since, so the thing to draw has to be worked out. That is
// this: erode in the polygon's own frame, then turn, scale and move it.
//
// The CSG over the result is what the game would actually see — every `level`
// polygon unioned and every `solid` one taken back out — and it is recomputed
// from scratch on every change, which is affordable at this size and is what
// makes it possible to watch it move while a transform is being dragged.
// -----------------------------------------------------------------------------

import { Point } from '@ce/game/world';
import { OpSubtract, Ring, Shape, combine, contains, erode, isCCW, simplify } from './geometry';
import { Polygon, PolygonId, World } from './types';

export interface Resolved {
  id: PolygonId
  polygon: Polygon
  ring: Ring
}

export function centroid(ring: Ring): Point {
  if (ring.length === 0) return { x: 0, y: 0 };

  let x = 0, y = 0;

  for (const p of ring) {
    x += p.x;
    y += p.y;
  }

  return { x: x / ring.length, y: y / ring.length };
}

/**
 * The points, put where the transform says. Erosion happens first and in the
 * polygon's own frame, so turning a polygon does not turn which way its
 * vertices erode; the pivot is the centroid of the points as drawn, so it stays
 * put as the ring shrinks.
 */
export function resolve(p: Polygon): Ring {
  const { rotation, scale, translation, erosion } = p.transform;
  const base = erosion === 0 ? p.points : erode(p.points, erosion);
  const o = centroid(p.points);
  const c = Math.cos(rotation), s = Math.sin(rotation);

  return base.map(q => {
    const x = (q.x - o.x) * scale, y = (q.y - o.y) * scale;

    return {
      x: o.x + x * c - y * s + translation.x,
      y: o.y + x * s + y * c + translation.y,
    };
  });
}

/**
 * A world point back in a polygon's own frame, so that dragging a vertex about
 * on screen can be written down as a change to the points it was drawn with.
 * Erosion is not undone — it moves each vertex its own way, and there is no one
 * answer — so a vertex dragged on an eroded polygon lands where the un-eroded
 * ring would have put it.
 */
export function toLocal(p: Polygon, at: Point): Point {
  const { rotation, scale, translation } = p.transform;
  const o = centroid(p.points);
  const c = Math.cos(-rotation), s = Math.sin(-rotation);

  const x = at.x - translation.x - o.x;
  const y = at.y - translation.y - o.y;

  return {
    x: o.x + (x * c - y * s) / scale,
    y: o.y + (x * s + y * c) / scale,
  };
}

export function resolved(world: World): Resolved[] {
  const out: Resolved[] = [];

  for (const [id, polygon] of world.sourcePolygons) {
    out.push({ id, polygon, ring: resolve(polygon) });
  }

  return out;
}

/**
 * Which way a ring is wound decides what it contributes under the nonzero rule,
 * so two polygons that overlap only merge if they agree. Clicking a polygon out
 * clockwise rather than anticlockwise is not a statement about anything, and
 * left alone it would punch a hole through whatever it overlapped and leave the
 * wall between them standing.
 *
 * The winding is taken from the points *as drawn* rather than from the ring on
 * screen, so that a polygon eroded past the point of turning itself inside out
 * keeps its inversion and cancels, instead of being flipped back and quietly
 * reappearing as solid ground.
 */
function facing(it: Resolved): Ring {
  return isCCW(it.polygon.points) ? it.ring : [...it.ring].reverse();
}

/** Every `level` unioned, every `solid` taken out: the set the game would get. */
export function csg(items: Resolved[]): Shape {
  const level: Ring[] = [], solid: Ring[] = [];

  for (const it of items) {
    if (it.polygon.type === 'level') level.push(facing(it));
    else if (it.polygon.type === 'solid') solid.push(facing(it));
  }

  if (level.length === 0) return [];
  if (solid.length === 0) return simplify(level);

  return combine(level, solid, OpSubtract);
}

/** The topmost polygon under a point, or nothing. */
export function hitPolygon(items: Resolved[], at: Point): PolygonId | null {
  for (let i = items.length - 1; i >= 0; i--) {
    if (contains([items[i].ring], at)) return items[i].id;
  }

  return null;
}

/** The nearest vertex within `radius` world units, topmost first. */
export function hitVertex(
  items: Resolved[],
  at: Point,
  radius: number,
): { id: PolygonId, index: number } | null {
  let best: { id: PolygonId, index: number } | null = null;
  let bestDistance = radius;

  for (const it of items) {
    it.ring.forEach((p, index) => {
      const d = Math.hypot(p.x - at.x, p.y - at.y);

      if (d <= bestDistance) {
        bestDistance = d;
        best = { id: it.id, index };
      }
    });
  }

  return best;
}

/** Everything with a vertex inside the box, which is enough for a marquee. */
export function withinBox(items: Resolved[], a: Point, b: Point): PolygonId[] {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);

  return items
    .filter(it => it.ring.some(p => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1))
    .map(it => it.id);
}
