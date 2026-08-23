// -----------------------------------------------------------------------------
// What the two halves agree on
//
// The editor authors versions as layers over one another and cuts the morph
// between them into stretches; none of that survives into here. What the game
// is handed is flat, id-free and answers exactly two questions:
//
// - **Where are the walls right now?** `baked`, which the vertex shader reads
//   and which nothing on the CPU has to resolve. See `baked.ts`.
// - **What is the player standing in?** `versions`, the source polygons as each
//   version resolves them, which collision and the out-of-bounds check run on.
//
// The second is not the first evaluated at a version boundary, and is not meant
// to be. The outline is the CSG of the whole set; a room is a polygon. Walking
// into a wall is a question about the room you are in, and the answer does not
// need the union.
// -----------------------------------------------------------------------------

import { BakedLevel, EMPTY_BAKED } from './baked';

export type PolygonType = 'level' | 'solid' | 'floor';

export type ArtefactType = 'key' | 'exit' | 'delay' | 'decompress' | 'anchor' | 'compass' | 'start';

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
 * One ring, wound and normalled.
 *
 * A ring rather than a polygon, deliberately: an eroded polygon resolves to
 * several — a room pinched into two by its own walls closing is two rings, and
 * a room with something taken out of it has a hole. They come out as separate
 * entries here, wound the way the projection wound them, and everything reading
 * this takes the winding off the signed area rather than assuming it.
 */
export interface Polygon {
  type: PolygonType
  points: PolygonPoint[]
}

export interface Artefact {
  x: number
  y: number
  type: ArtefactType
}

export interface Version {
  polygons: Polygon[]
}

export interface Path {
  points: Point[]
}

export interface World {
  paths: Path[]
  /** The source polygons at each version, for collision and for knowing
   * whether the player is anywhere at all. */
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
