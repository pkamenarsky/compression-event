// -----------------------------------------------------------------------------
// What the two halves agree on
//
// The editor authors versions as layers over one another and cuts the morph
// between them into stretches; none of that survives into here. What the game
// is handed is flat, id-free and answers exactly two questions:
//
// - **Where are the walls right now?** `baked`, which the vertex shader reads
//   and which nothing on the CPU has to resolve. See `baked.ts`.
// - **What is the player standing in?** `versions`, the set at each version as
//   closed rings, which collision and the out-of-bounds check run on.
//
// Both are the union, and neither is the other. The authored rings carry seams
// the set does not have — two rooms overlapping is the ordinary way to author a
// level here, and the seam between them was a wall you could see through and
// could not walk through — so collision is on the union too, and every ring
// here ships as `level` whatever it was made of: a `solid` has been subtracted
// by now and is a hole, and a hole is one by the way it is wound.
//
// What differs is the shape they arrive in, and that is the whole reason the
// second is a separate evaluation rather than a read of the first. A run
// belongs to one polygon and can be kept up to date on its own, which is what
// the editor wants of the drawing; a wall needs both its neighbours to mitre
// against, and a ring is where they are.
//
// So collision snaps at version boundaries while the walls morph between them,
// and during a transition the wall you see is a little ahead of the wall that
// stops you. That was chosen. The seams were not.
// -----------------------------------------------------------------------------

import { BakedLevel, EMPTY_BAKED } from './baked';

/**
 * What an author can draw, which is not what the game is handed.
 *
 * A `level` is somewhere to stand, a `solid` is something taken back out of it,
 * and a `floor` is neither — it is drawn and nothing else. The first two are
 * resolved into one set before they get here and arrive as untagged rings; the
 * third arrives in a list of its own. So this describes the editor's side of
 * the agreement, and nothing shipped carries it.
 */
export type PolygonType = 'level' | 'solid' | 'floor';

export type ArtefactType = 'start' | 'exit' | 'key' | 'delay' | 'decompress' | 'anchor' | 'compass';

export interface Point {
  x: number
  y: number
}

export interface PolygonPoint {
  x: number
  y: number
  bnx: number  // bisector normal x (scaled so parallel offset works)
  bny: number  // bisector normal y (scaled so parallel offset works)
  enx: number  // edge normal x (unit) between current point and (next one | first one (if current point is last))
  eny: number  // edge normal y (unit) between current point and (next one | first one (if current point is last))
}

/**
 * One ring of the set, wound and normalled: something to walk into.
 *
 * A ring rather than a polygon, deliberately: an eroded polygon resolves to
 * several — a room pinched into two by its own walls closing is two rings, and
 * a room with something taken out of it has a hole. They come out as separate
 * entries here, wound the way the projection wound them, and everything reading
 * this takes the winding off the signed area rather than assuming it.
 *
 * Untagged, and that is the point. Every ring in the list is the same kind of
 * thing — a `level` was unioned and a `solid` was subtracted long before this,
 * and what a `solid` left behind is a hole, which is one by the way it is
 * wound. There is nothing left for a tag to distinguish.
 */
export interface Polygon {
  points: PolygonPoint[]
}

/**
 * One floor: a shape drawn flat on the ground, and nothing else.
 *
 * Its own list rather than a tag on the one above, because it is not the same
 * kind of thing and every reader of that list would have to know to skip it. It
 * takes no part in the set, nothing walks into it, and nothing needs to know
 * which side of it is material — so it carries no normals either. A ring of
 * points, filled, is the whole of it.
 */
export interface Floor {
  points: Point[]
}

/**
 * One artefact, and where it stands at every version.
 *
 * A place per version rather than one place, because an artefact is carried by
 * whatever holds it: a key in a room that turns turns with it. Only the places
 * are shipped and not the layers between them, so what the game draws during a
 * transition is a straight line between two of them — where the editor, which
 * has the layers, draws the arc. A dozen artefacts sliding for a second is not
 * worth carrying the frame table twice over.
 *
 * Null where it does not exist yet: a version before the one that introduced
 * it cannot name it.
 */
export interface Artefact {
  type: ArtefactType
  places: (Point | null)[]
}

export interface Version {
  /** The set as closed rings: what stops the player. */
  polygons: Polygon[]
  /** What is drawn flat underfoot, taking no part in any of that. */
  floors: Floor[]
}

export interface Path {
  points: Point[]
}

export interface World {
  paths: Path[]
  /** The set at each version as closed rings, for collision and for knowing
   * whether the player is anywhere at all. Not the polygons it was made of —
   * see the header. */
  versions: Version[]
  artefacts: Artefact[]
  /** The morph between each adjacent pair of versions, as buffers. */
  baked: BakedLevel
}

export function emptyWorld(): World {
  return { paths: [], versions: [], artefacts: [], baked: EMPTY_BAKED };
}

// -----------------------------------------------------------------------------
// Normals
//
// Both of the collision hull's inputs, worked out once when the world is
// written rather than on every level load, which is what the jam build did.
//
// The edge normal is the unit outward normal of the edge starting at the point.
// The bisector is the outward direction a corner has to move for both of its
// edges to shift outward by the same distance — which is not the unit bisector,
// but that divided by the cosine of the half angle. Offsetting along it is what
// makes the Minkowski expansion by the player's radius come out right at
// corners instead of pinching them.
// -----------------------------------------------------------------------------

/** Positive is counter-clockwise. */
export function signedArea(points: readonly Point[]): number {
  let area = 0;

  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;

    area += points[i].x * points[j].y - points[j].x * points[i].y;
  }

  return area / 2;
}

/**
 * A ring with its normals, outward whichever way it happens to be wound.
 *
 * The winding is read off the ring rather than declared, because a hole is
 * wound the other way from its outer ring and both arrive here as rings. What
 * "outward" means follows from it: away from the material either way.
 */
export function withNormals(points: readonly Point[]): PolygonPoint[] {
  const n = points.length;
  if (n < 3) return [];

  const sign = signedArea(points) > 0 ? 1 : -1;

  const edges = points.map((a, i) => {
    const b = points[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);

    return len < 1e-12
      ? { nx: 0, ny: 0 }
      : { nx: sign * dy / len, ny: sign * -dx / len };
  });

  return points.map((p, i) => {
    const prev = edges[(i - 1 + n) % n], here = edges[i];

    let bx = prev.nx + here.nx, by = prev.ny + here.ny;
    const len = Math.hypot(bx, by);

    // A hairpin — the two edges antiparallel — has no bisector worth the name,
    // and neither has a corner whose halves cancel. The edge's own normal is
    // the least wrong thing to offset along.
    if (len < 1e-8) {
      return { x: p.x, y: p.y, bnx: here.nx, bny: here.ny, enx: here.nx, eny: here.ny };
    }

    bx /= len;
    by /= len;

    const cosHalf = bx * here.nx + by * here.ny;

    if (Math.abs(cosHalf) < 1e-8) {
      return { x: p.x, y: p.y, bnx: here.nx, bny: here.ny, enx: here.nx, eny: here.ny };
    }

    return {
      x: p.x,
      y: p.y,
      bnx: bx / cosHalf,
      bny: by / cosHalf,
      enx: here.nx,
      eny: here.ny,
    };
  });
}
