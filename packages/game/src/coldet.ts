// -----------------------------------------------------------------------------
// Walking into things
//
// The jam build's collision, carried over with three changes.
//
// **The normals arrive precomputed.** `PolygonPoint` carries the edge normal
// and the scaled bisector, worked out once where the world is written rather
// than on every level load. Nothing here recomputes them.
//
// **A polygon is a ring, and a version has more of them than it was authored
// with.** Erosion is a projection: a room whose walls close until they meet is
// two rooms, and a room with something taken out of it has a hole wound the
// other way. Which side of a ring is material follows from its winding and its
// type, and is the one thing this has to get right — see `sideOf`.
//
// **The rings are the union's, not the author's.** This is the one that
// mattered. Hulls built from the source rings give the player walls the union
// does not have: two rooms overlapping is the ordinary way to author a level
// here, and the seam between them stopped the player dead in the middle of open
// floor. So what arrives here is the CSG at each version — every `level`
// unioned, every `solid` taken back out — and a seam is not in it, because the
// union dissolved it. That is `versionOf` in the editor's exporter, and it is
// why everything below deals only in `level` rings.
//
// Which leaves the walls a version behind the walls being drawn, since the
// drawn ones morph continuously and these snap. The transition is short and the
// lag is a wall that has visually moved slightly ahead of where it stops you —
// which is what the jam build had between its snaps too. Rebuilding the hulls
// off the morphing boundary every frame would close that gap and cost a
// per-frame CSG readback to do it; it is not worth the trade.
//
// Everything else is Quake 2's: expand each wall by the player's radius so the
// player is a point, trace the point against the convex hulls that produces,
// stop at the first, and slide along it unless two of them arrive at once.
// -----------------------------------------------------------------------------

import { Point, Polygon, PolygonPoint, signedArea } from './world';

/** World units. The player is a point and the walls are this much closer. */
export const PLAYER_RADIUS = 0.3;

/** One convex hull: the expansion of a single wall. */
interface Hull {
  /** Counter-clockwise, so the plane normals come out pointing outward. */
  verts: Point[]
  planes: { nx: number, ny: number, d: number }[]
  /** The original wall's outward normal, which is what a slide is taken
   * against and what tells two hulls of one wall apart from a corner. */
  wallNx: number
  wallNy: number
}

/**
 * Which way a ring's walls are expanded.
 *
 * `withNormals` points a ring's normals away from the region it encloses in the
 * counter-clockwise sense, whichever way round it happens to be wound. Every
 * ring that gets here encloses somewhere to stand, so the walls move against
 * the normal — and a hole, wound against the room it is in, has that flipped
 * for it by the winding without anything having to know it is a hole.
 */
function sideOf(polygon: Polygon): number {
  return signedArea(polygon.points) > 0 ? -1 : 1;
}

function planesOf(verts: Point[]): { nx: number, ny: number, d: number }[] {
  const planes = [];

  for (let i = 0; i < verts.length; i++) {
    const a = verts[i], b = verts[(i + 1) % verts.length];
    const ex = b.x - a.x, ey = b.y - a.y;
    const len = Math.hypot(ex, ey);

    if (len < 1e-12) continue;

    // Counter-clockwise winding puts the outward normal at (ey, -ex).
    const nx = ey / len, ny = -ex / len;

    planes.push({ nx, ny, d: nx * a.x + ny * a.y });
  }

  return planes;
}

/** Where two segments meet along the first, or nothing. */
function meeting(
  p1: Point, p2: Point,
  p3: Point, p4: Point,
): number | null {
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x, d2y = p4.y - p3.y;

  const det = d1x * d2y - d1y * d2x;
  if (Math.abs(det) < 1e-12) return null;

  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / det;
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / det;

  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

function hullOf(
  a: PolygonPoint,
  b: PolygonPoint,
  scale: number,
  side: number,
  radius: number,
): Hull | null {
  const wa = { x: a.x * scale, y: a.y * scale };
  const wb = { x: b.x * scale, y: b.y * scale };

  if (Math.hypot(wb.x - wa.x, wb.y - wa.y) < 1e-12) return null;

  // Along the bisector rather than the edge normal, so that both walls meeting
  // at a corner end up exactly `radius` away from it rather than pinching. The
  // scaling is what makes that exact: `withNormals` divides the unit bisector
  // by the cosine of the half angle, so the bisector's component along either
  // of the two edge normals is exactly one, and the moved edge is a translate
  // of the original by `radius` however sharp the corner is.
  const ea = { x: wa.x + a.bnx * radius * side, y: wa.y + a.bny * radius * side };
  const eb = { x: wb.x + b.bnx * radius * side, y: wb.y + b.bny * radius * side };

  // Except where there was no bisector to divide. A hairpin's two edges are
  // antiparallel and their normals cancel, so `withNormals` falls back to the
  // edge's own normal — which is right for one of the two walls meeting there
  // and points straight through the other. That quad crosses itself, and every
  // way of salvaging a triangle out of it puts all three corners on one line:
  // the crossing sits on the original edge by construction. A zero-area hull
  // catches nothing, so the wall silently stopped stopping anyone.
  //
  // The rectangle the bisector would have given anywhere else is what it gets
  // instead: both ends moved along the wall's own normal. It is short of the
  // radius at the far corner, which is the corner a hairpin does not have.
  const folded = meeting(wa, wb, ea, eb) !== null;
  const out = (p: Point) => ({ x: p.x + a.enx * radius * side, y: p.y + a.eny * radius * side });

  const verts: Point[] = folded ? [wa, wb, out(wb), out(wa)] : [wa, wb, eb, ea];

  if (signedArea(verts) < 0) verts.reverse();

  const planes = planesOf(verts);
  if (planes.length < 3) return null;

  return { verts, planes, wallNx: a.enx, wallNy: a.eny };
}

/** What a trace against one hull found: where it went in, where it would come
 * out, and the plane it went in through. */
interface Crossed {
  enter: number
  exit: number
  nx: number
  ny: number
}

const MISSED: Crossed = { enter: 1, exit: -1, nx: 0, ny: 0 };

function traced(from: Point, to: Point, hull: Hull): Crossed {
  let enter = -1, exit = 1, nx = 0, ny = 0;

  for (const plane of hull.planes) {
    const ds = plane.nx * from.x + plane.ny * from.y - plane.d;
    const de = plane.nx * to.x + plane.ny * to.y - plane.d;

    // Outside this plane the whole way is outside the hull, whatever the
    // others say.
    if (ds > 0 && de > 0) return MISSED;
    if (ds <= 0 && de <= 0) continue;

    const frac = ds / (ds - de);

    if (ds > 0) {
      if (frac > enter) {
        enter = frac;
        nx = plane.nx;
        ny = plane.ny;
      }
    }
    else if (frac < exit) {
      exit = frac;
    }
  }

  return { enter, exit, nx, ny };
}

function hit(c: Crossed): boolean {
  return c.enter < c.exit && c.enter >= 0 && c.enter <= 1;
}

/** How far behind the wall the trace stops, so that the next frame does not
 * start inside it. */
const GAP = 1e-4;

/** Two hulls whose walls point the same way are one wall, not a corner. */
const SAME_WALL = 0.99;

/** Hits this much of the move apart are the same instant. */
const TOGETHER = 0.01;

/**
 * One version's walls, expanded and ready to be walked into.
 *
 * The rings are the union's, so there is one kind of them: `level`. A solid was
 * taken back out where the union was worked out, and what it left behind is a
 * hole wound against the room it is in — so nothing here has to be told that a
 * solid is a solid, or that a hole is a hole. `sideOf` is the whole of that.
 *
 * Every ring handed over is one of them. Floors are drawn rather than walked
 * into and travel in a list of their own, so there is nothing here to skip.
 */
export class Hulls {
  private hulls: Hull[] = [];

  constructor(
    private polygons: Polygon[],
    private scale: number,
    radius = PLAYER_RADIUS,
  ) {
    for (const polygon of polygons) {
      if (polygon.points.length < 3) continue;

      const side = sideOf(polygon);
      const n = polygon.points.length;

      for (let i = 0; i < n; i++) {
        const made = hullOf(polygon.points[i], polygon.points[(i + 1) % n], this.scale, side, radius);

        if (made !== null) this.hulls.push(made);
      }
    }
  }

  /** Inside a wall, which is not somewhere the player is allowed to be. */
  insideAny(at: Point): boolean {
    return this.hulls.some(hull =>
      hull.planes.every(p => p.nx * at.x + p.ny * at.y - p.d <= 0));
  }

  /**
   * Somewhere to stand: not inside a wall, and inside some room.
   *
   * Two questions rather than three, because being inside something solid is
   * not a separate one: a solid is a hole in the union, wound against the room
   * it is in, so the nonzero rule takes it back out without anything here
   * having to know which ring is which.
   */
  standable(at: Point): boolean {
    if (this.insideAny(at)) return false;

    return this.winding(at) !== 0;
  }

  /** How many times the rooms wind round the point. */
  private winding(at: Point): number {
    const x = at.x / this.scale, y = at.y / this.scale;
    let turns = 0;

    for (const polygon of this.polygons) {
      const points = polygon.points;

      for (let i = 0; i < points.length; i++) {
        const a = points[i], b = points[(i + 1) % points.length];

        if (a.y <= y) {
          if (b.y > y && (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y) > 0) turns++;
        }
        else if (b.y <= y && (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y) < 0) {
          turns--;
        }
      }
    }

    return turns;
  }

  /**
   * A move, stopped and slid.
   *
   * Everything is traced, not just the first thing in the way: two walls
   * arriving at the same instant is a corner and stops the player dead, where
   * sliding along either one of them would walk through the other.
   */
  trace(start: Point, move: Point): Point {
    const length = Math.hypot(move.x, move.y);
    if (length < 1e-8) return { ...start };

    const end = { x: start.x + move.x, y: start.y + move.y };
    const hits = [];

    for (const hull of this.hulls) {
      const crossed = traced(start, end, hull);

      if (hit(crossed)) {
        hits.push({ frac: crossed.enter, ...crossed, wall: hull });
      }
    }

    if (hits.length === 0) return end;

    hits.sort((a, b) => a.frac - b.frac);

    const first = hits[0];
    const safe = Math.max(0, first.frac - GAP / length);
    const stopped = { x: start.x + move.x * safe, y: start.y + move.y * safe };

    // Two hulls off one wall are not two walls: a long wall is one hull per
    // edge, and crossing where they meet would otherwise read as a corner.
    const walls: typeof hits = [];

    for (const h of hits) {
      if (h.frac - first.frac >= TOGETHER) break;

      const known = walls.some(w =>
        h.wall.wallNx * w.wall.wallNx + h.wall.wallNy * w.wall.wallNy > SAME_WALL);

      if (!known) walls.push(h);
    }

    if (walls.length >= 2) return stopped;

    const rest = { x: move.x * (1 - first.frac), y: move.y * (1 - first.frac) };
    const into = rest.x * first.nx + rest.y * first.ny;
    const slide = { x: rest.x - into * first.nx, y: rest.y - into * first.ny };

    const along = Math.hypot(slide.x, slide.y);
    if (along < 1e-8) return stopped;

    // The slide is traced too: sliding along one wall is how the player
    // reaches the next one.
    const to = { x: stopped.x + slide.x, y: stopped.y + slide.y };
    let frac = 1;

    for (const hull of this.hulls) {
      const crossed = traced(stopped, to, hull);

      if (hit(crossed) && crossed.enter < frac) frac = crossed.enter;
    }

    const safely = Math.max(0, frac - GAP / along);

    return { x: stopped.x + slide.x * safely, y: stopped.y + slide.y * safely };
  }
}
