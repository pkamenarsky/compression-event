// -----------------------------------------------------------------------------
// What the world looks like right now
//
// A polygon keeps the points it was drawn with and a transform describing what
// has happened to it since, so the thing to draw has to be worked out. That is
// this: erode in the polygon's own frame, add whatever its vertices have been
// nudged by, then turn, scale and move the result.
//
// The CSG over that is what the game would actually see — every `level` polygon
// unioned and every `solid` one taken back out — and it is recomputed from
// scratch on every change, which is affordable at this size and is what makes
// it possible to watch it move while a transform is being dragged.
//
// Nothing in here derives a frame from geometry the user can edit. An earlier
// version turned and scaled about `centroid(p.points)`, which tied the frame to
// the points: moving one vertex moved the centroid, and every other vertex swung
// about the difference. Under rotation and scale that difference is
// `(I - scale·R)·Δcentroid`, which is zero only while the polygon is untouched —
// so the whole thing looked right until the first rotate and then smeared. A
// transform is about the world origin instead, and the gesture that builds one
// puts the pivot it wants into the translation.
// -----------------------------------------------------------------------------

import { Point } from '@ce/game/world';
import { OpSubtract, Ring, Shape, combine, contains, erode, isCCW, simplify } from './geometry';
import { EMPTY_TRANSFORM, Polygon, PolygonId, PolygonType, World } from './types';

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
 * A polygon as drawn: wound counter-clockwise, nothing nudged, nothing done to
 * it yet. Every polygon in the world comes from here.
 *
 * The winding is settled once, at the source, rather than being read back off
 * the points at every CSG. Which way a ring is wound decides what it
 * contributes under the nonzero rule, so two polygons that overlap only merge
 * if they agree; clicking one out clockwise rather than anticlockwise is not a
 * statement about anything, and left alone it would punch a hole through
 * whatever it overlapped and leave the wall between them standing.
 *
 * Fixing it here is also what leaves the *resolved* ring free to mean
 * something. A polygon eroded past the point of turning itself inside out comes
 * back wound the other way, and that inversion is real — it has to reach the
 * CSG and cancel, rather than being read as a hole and quietly flipped back.
 */
export function sourcePolygon(type: PolygonType, points: Point[]): Polygon {
  return {
    type,
    points: isCCW(points) ? [...points] : [...points].reverse(),
    nudges: points.map(() => ({ x: 0, y: 0 })),
    transform: EMPTY_TRANSFORM,
  };
}

/**
 * The ring in the polygon's own frame: eroded, then nudged.
 *
 * Erosion reads the points and nothing else, so a nudge moves its own vertex
 * and no other. Were it to read the nudged ring, dragging a vertex would swing
 * its two neighbours' bisectors and walk them off along with it — the same
 * frozen-bisector rule the rest of the erosion work rests on, arrived at from
 * the other end.
 */
export function localRing(p: Polygon): Ring {
  const { erosion } = p.transform;
  const base = erosion === 0 ? p.points : erode(p.points, erosion);

  return base.map((q, i) => {
    const n = p.nudges[i];

    return { x: q.x + n.x, y: q.y + n.y };
  });
}

/** The points, put where the transform says. */
export function resolve(p: Polygon): Ring {
  const { rotation, scale, translation } = p.transform;
  const c = Math.cos(rotation), s = Math.sin(rotation);

  return localRing(p).map(q => ({
    x: (q.x * c - q.y * s) * scale + translation.x,
    y: (q.x * s + q.y * c) * scale + translation.y,
  }));
}

/** A world point back in a polygon's own frame. The exact inverse of the
 * affine half of `resolve`; erosion and nudges are not undone. */
export function toLocal(p: Polygon, at: Point): Point {
  const { rotation, scale, translation } = p.transform;
  const c = Math.cos(-rotation), s = Math.sin(-rotation);

  const x = (at.x - translation.x) / scale;
  const y = (at.y - translation.y) / scale;

  return { x: x * c - y * s, y: x * s + y * c };
}

/**
 * A vertex put under the cursor, exactly.
 *
 * With nothing eroded the drag moves the point itself, which is what any later
 * erosion should read. Once there is erosion it cannot: `erode` has no inverse
 * to reach for — a vertex's bisector depends on where that vertex is and on
 * where its neighbours are, so asking which point erodes to the cursor is an
 * implicit problem, and there is no iterative solver anywhere in this system.
 *
 * So the drag writes a nudge: a displacement added after the erosion. It lands
 * on the cursor by construction, at any erosion depth, and it leaves every
 * other vertex exactly where it was.
 */
export function placeVertex(p: Polygon, index: number, at: Point): Polygon {
  const target = toLocal(p, at);
  const nudges = [...p.nudges];

  if (p.transform.erosion === 0) {
    const points = [...p.points];

    // Erosion is the identity here, so the nudge has nowhere to hide: fold it
    // into the point and leave the source saying what the shape is.
    points[index] = target;
    nudges[index] = { x: 0, y: 0 };

    return { ...p, points, nudges };
  }

  const base = erode(p.points, p.transform.erosion)[index];

  nudges[index] = { x: target.x - base.x, y: target.y - base.y };

  return { ...p, nudges };
}

export function resolved(world: World): Resolved[] {
  const out: Resolved[] = [];

  for (const [id, polygon] of world.sourcePolygons) {
    out.push({ id, polygon, ring: resolve(polygon) });
  }

  return out;
}

/** Every `level` unioned, every `solid` taken out: the set the game would get. */
export function csg(items: Resolved[]): Shape {
  const level: Ring[] = [], solid: Ring[] = [];

  for (const it of items) {
    if (it.polygon.type === 'level') level.push(it.ring);
    else if (it.polygon.type === 'solid') solid.push(it.ring);
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
