import * as THREE from 'three';
import { WORLD_SCALE } from './constants';
import { Polygon } from './editor';

const PLAYER_RADIUS = 0.3; // world units — used for Minkowski expansion

/** A convex collision hull for one wall edge, in world XZ space. */
interface ColHull {
  /** Vertices of the convex polygon, wound CCW (outward normals via right-hand rule). */
  verts: { x: number; y: number }[];
  /** Outward-facing plane normals and distances for each edge of the hull. */
  planes: { nx: number; ny: number; d: number }[];
  /** The outward normal of the *original* wall edge (used for sliding). */
  wallNx: number;
  wallNy: number;
}

/**
 * Compute the signed area of a polygon given in editor coords.
 * Positive = CCW, negative = CW.
 */
function signedArea(pts: { x: number; y: number }[]): number {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    area += pts[i].x * pts[j].y;
    area -= pts[j].x * pts[i].y;
  }
  return area / 2;
}

/**
 * Build plane normals + distances for a CCW-wound convex polygon.
 * Each plane's normal points outward.  The plane equation is:
 *   dot(normal, point) - d = 0   (d = dot(normal, vertex_on_edge))
 * Points with dot(normal, P) - d > 0 are outside.
 */
function buildPlanes(
  verts: { x: number; y: number }[]
): { nx: number; ny: number; d: number }[] {
  const planes: { nx: number; ny: number; d: number }[] = [];
  const n = verts.length;
  for (let i = 0; i < n; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % n];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    // For CCW winding, outward normal is (ey, -ex) normalised
    const len = Math.sqrt(ex * ex + ey * ey);
    if (len < 1e-12) continue;
    const nx = ey / len;
    const ny = -ex / len;
    const d = nx * a.x + ny * a.y;
    planes.push({ nx, ny, d });
  }
  return planes;
}

/**
 * Check if two 2D segments (p1→p2) and (p3→p4) intersect.
 * Returns the parametric t along (p1→p2) if they do, or null.
 */
function segSegIntersectT(
  p1x: number, p1y: number, p2x: number, p2y: number,
  p3x: number, p3y: number, p4x: number, p4y: number
): number | null {
  const d1x = p2x - p1x;
  const d1y = p2y - p1y;
  const d2x = p4x - p3x;
  const d2y = p4y - p3y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((p3x - p1x) * d2y - (p3y - p1y) * d2x) / denom;
  const u = ((p3x - p1x) * d1y - (p3y - p1y) * d1x) / denom;
  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return t;
  return null;
}

export class Hulls {
  private colHulls: ColHull[] = [];
  private polygons: Polygon[] = [];

  constructor(polygons: Polygon[]) {
    this.polygons = polygons;
    this.buildCollisionHulls();
  }

  private buildCollisionHulls(): void {
    this.colHulls = [];

    for (const poly of this.polygons) {
      const pts = poly.points;
      const n = pts.length;
      if (poly.type !== 'level' && poly.type !== 'solid') continue;
      if (n < 3) continue;

      const area = signedArea(pts);
      const sign = area > 0 ? 1 : -1;

      // Compute per-edge outward unit normals
      const edgeNormals: { nx: number; ny: number }[] = [];
      for (let i = 0; i < n; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % n];
        const edx = b.x - a.x;
        const edy = b.y - a.y;
        const len = Math.sqrt(edx * edx + edy * edy);
        if (len < 1e-12) {
          edgeNormals.push({ nx: 0, ny: 0 });
        } else {
          edgeNormals.push({
            nx: (sign * edy) / len,
            ny: (sign * -edx) / len,
          });
        }
      }

      // Compute per-vertex bisector normals (outward), scaled so that
      // offsetting along them by PLAYER_RADIUS correctly expands each
      // adjacent edge by PLAYER_RADIUS.
      const vertBisectors: { nx: number; ny: number }[] = [];
      for (let i = 0; i < n; i++) {
        const prev = edgeNormals[(i - 1 + n) % n];
        const curr = edgeNormals[i];

        // Average of the two adjacent edge normals
        let bx = prev.nx + curr.nx;
        let by = prev.ny + curr.ny;
        const blen = Math.sqrt(bx * bx + by * by);

        if (blen < 1e-8) {
          // Degenerate: edges are parallel with opposite normals (180° turn).
          // Just use the current edge normal.
          vertBisectors.push({ nx: curr.nx, ny: curr.ny });
        } else {
          bx /= blen;
          by /= blen;
          // Scale so that the perpendicular distance from the offset point
          // to each adjacent edge equals PLAYER_RADIUS.
          // cos(half_angle) = dot(bisector, edgeNormal)
          const cosHalf = bx * curr.nx + by * curr.ny;
          if (Math.abs(cosHalf) < 1e-8) {
            vertBisectors.push({ nx: curr.nx, ny: curr.ny });
          } else {
            const scale = 1.0 / cosHalf;
            vertBisectors.push({ nx: bx * scale, ny: by * scale });
          }
        }
      }

      // For each edge, build a convex hull (quad or triangle).
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const a = pts[i];
        const b = pts[j];

        const edx = b.x - a.x;
        const edy = b.y - a.y;
        const edgeLen = Math.sqrt(edx * edx + edy * edy);
        if (edgeLen < 1e-12) continue;

        // Original edge endpoints in world space
        const wax = a.x * WORLD_SCALE;
        const way = a.y * WORLD_SCALE;
        const wbx = b.x * WORLD_SCALE;
        const wby = b.y * WORLD_SCALE;

        const direction = poly.type === 'level' ? -1 : 1;

        const aExpX = wax + vertBisectors[i].nx * PLAYER_RADIUS * direction;
        const aExpY = way + vertBisectors[i].ny * PLAYER_RADIUS * direction;
        const bExpX = wbx + vertBisectors[j].nx * PLAYER_RADIUS * direction;
        const bExpY = wby + vertBisectors[j].ny * PLAYER_RADIUS * direction;

        // The wall normal in world space (outward)
        const wnx = edgeNormals[i].nx;
        const wny = edgeNormals[i].ny;

        // Check if the expanded edges cross (sharp convex corner).
        // The hull is: A_orig → B_orig → B_exp → A_exp (CCW if normals point outward).
        // But we need to ensure correct winding. The original edge goes A→B.
        // The outward normal points away from the polygon interior.
        // So the hull should be wound so that its interior is between the
        // original edge and the expanded edge.
        //
        // For CCW polygon winding with outward normals:
        //   Hull (CCW): A_orig, B_orig, B_exp, A_exp
        //
        // Check if A_exp→B_exp crosses A_orig→B_orig (sharp angle causes this).
        const crossed = segSegIntersectT(
          wax, way, wbx, wby,
          aExpX, aExpY, bExpX, bExpY
        );

        let hullVerts: { x: number; y: number }[];

        if (crossed !== null) {
          // The expanded edge crosses the original edge — degenerate to triangle.
          // Find the crossing point.
          const cx = wax + crossed * (wbx - wax);
          const cy = way + crossed * (wby - way);
          // Triangle: A_orig, B_orig, crossing_point
          // But actually we want the hull that covers the expansion region.
          // The crossing means the two expanded points are on the wrong side.
          // Use the midpoint of the crossing as the apex.
          hullVerts = [
            { x: wax, y: way },
            { x: wbx, y: wby },
            { x: cx, y: cy },
          ];
          // Ensure CCW winding
          if (signedArea(hullVerts) < 0) {
            hullVerts.reverse();
          }
        } else {
          // Normal quad hull
          hullVerts = [
            { x: wax, y: way },
            { x: wbx, y: wby },
            { x: bExpX, y: bExpY },
            { x: aExpX, y: aExpY },
          ];
          // Ensure CCW winding
          if (signedArea(hullVerts) < 0) {
            hullVerts.reverse();
          }
        }

        const planes = buildPlanes(hullVerts);
        if (planes.length < 3) continue; // degenerate

        this.colHulls.push({
          verts: hullVerts,
          planes,
          wallNx: wnx,
          wallNy: wny,
        });
      }
    }
  }

  // ───────────────────── point-in-hull test ─────────────────────────

  /**
   * Check whether a point is inside a single convex hull.
   * A point is inside when it is on the negative (interior) side of every plane,
   * i.e. dot(normal, point) - d <= 0 for all planes.
   */
  private isInsideHull(px: number, py: number, hull: ColHull): boolean {
    for (const plane of hull.planes) {
      const dist = plane.nx * px + plane.ny * py - plane.d;
      if (dist > 0) return false;
    }
    return true;
  }

  /**
   * Check whether a point (in world XZ space) is inside any collision hull.
   */
  isInsideAnyHull(px: number, py: number): boolean {
    for (const hull of this.colHulls) {
      if (this.isInsideHull(px, py, hull)) {
        return true;
      }
    }
    return false;
  }

  // ───────────────────── Quake 2 style trace ─────────────────────────

  /**
   * Trace a point from `start` to `end` against a convex hull.
   * Returns { enterFrac, exitFrac, normal } using the Quake 2 algorithm.
   * If enterFrac < exitFrac and enterFrac >= 0, there's a hit.
   */
  private traceAgainstHull(
    sx: number, sy: number,
    ex: number, ey: number,
    hull: ColHull
  ): { enterFrac: number; exitFrac: number; nx: number; ny: number } {
    let enterFrac = -1.0;
    let exitFrac = 1.0;
    let enterNx = 0;
    let enterNy = 0;

    for (const plane of hull.planes) {
      // signed distance of start and end from this plane
      const distS = plane.nx * sx + plane.ny * sy - plane.d;
      const distE = plane.nx * ex + plane.ny * ey - plane.d;

      if (distS > 0 && distE > 0) {
        // Entirely outside this plane — no intersection with hull
        return { enterFrac: 1, exitFrac: -1, nx: 0, ny: 0 };
      }

      if (distS <= 0 && distE <= 0) {
        // Entirely inside this plane — doesn't constrain
        continue;
      }

      // The ray crosses this plane
      const frac = distS / (distS - distE);

      if (distS > 0) {
        // Entering the hull through this plane
        if (frac > enterFrac) {
          enterFrac = frac;
          enterNx = plane.nx;
          enterNy = plane.ny;
        }
      } else {
        // Exiting the hull through this plane
        if (frac < exitFrac) {
          exitFrac = frac;
        }
      }
    }

    return { enterFrac, exitFrac, nx: enterNx, ny: enterNy };
  }

  // ───────────────────────── public collision API ─────────────────────────

  trace(start: THREE.Vector2, direction: THREE.Vector2): THREE.Vector2 {
    const dirLen = direction.length();
    if (dirLen < 1e-8) return start.clone();

    const endX = start.x + direction.x;
    const endY = start.y + direction.y;

    // ── Primary trace: find all walls hit ──
    const hits: { frac: number; nx: number; ny: number; wallNx: number; wallNy: number }[] = [];

    for (const hull of this.colHulls) {
      const result = this.traceAgainstHull(start.x, start.y, endX, endY, hull);

      if (result.enterFrac < result.exitFrac && result.enterFrac >= 0 && result.enterFrac <= 1) {
        hits.push({
          frac: result.enterFrac,
          nx: result.nx,
          ny: result.ny,
          wallNx: hull.wallNx,
          wallNy: hull.wallNy,
        });
      }
    }

    if (hits.length === 0) {
      // No collision — full movement
      return new THREE.Vector2(endX, endY);
    }

    // Sort by fraction to find the earliest hit(s)
    hits.sort((a, b) => a.frac - b.frac);

    const earliest = hits[0];
    const epsilon = 1e-4;
    const safeFrac = Math.max(0, earliest.frac - epsilon / dirLen);

    // Move to the collision point
    const colX = start.x + direction.x * safeFrac;
    const colY = start.y + direction.y * safeFrac;

    // Check if there are multiple walls hit at approximately the same fraction
    // (hitting a corner/edge head-on)
    const FRAC_EPSILON = 0.01;
    const nearHits: typeof hits = [];
    for (const h of hits) {
      if (h.frac - earliest.frac < FRAC_EPSILON) {
        nearHits.push(h);
      }
    }

    // Deduplicate by wall normal direction (two hulls from the same wall
    // shouldn't count as two separate walls)
    const uniqueWalls: typeof hits = [];
    for (const h of nearHits) {
      let isDupe = false;
      for (const u of uniqueWalls) {
        const dot = h.wallNx * u.wallNx + h.wallNy * u.wallNy;
        if (dot > 0.99) {
          isDupe = true;
          break;
        }
      }
      if (!isDupe) uniqueWalls.push(h);
    }

    if (uniqueWalls.length >= 2) {
      // Hit a corner — stop dead
      return new THREE.Vector2(colX, colY);
    }

    // Single wall hit — slide along it
    const hit = uniqueWalls[0];

    // Remaining movement
    const remainFrac = 1.0 - earliest.frac;
    const remainX = direction.x * remainFrac;
    const remainY = direction.y * remainFrac;

    // Project remaining movement onto the wall plane (remove the normal component)
    const dotRemain = remainX * hit.nx + remainY * hit.ny;
    const slideX = remainX - dotRemain * hit.nx;
    const slideY = remainY - dotRemain * hit.ny;

    const slideLen = Math.sqrt(slideX * slideX + slideY * slideY);
    if (slideLen < 1e-8) {
      return new THREE.Vector2(colX, colY);
    }

    // ── Slide trace: trace the slide movement to avoid sliding into another wall ──
    const slideEndX = colX + slideX;
    const slideEndY = colY + slideY;

    let slideFrac = 1.0;

    for (const hull of this.colHulls) {
      const result = this.traceAgainstHull(colX, colY, slideEndX, slideEndY, hull);

      if (result.enterFrac < result.exitFrac && result.enterFrac >= 0 && result.enterFrac <= 1) {
        if (result.enterFrac < slideFrac) {
          slideFrac = result.enterFrac;
        }
      }
    }

    const slideSafeFrac = Math.max(0, slideFrac - epsilon / slideLen);
    const finalX = colX + slideX * slideSafeFrac;
    const finalY = colY + slideY * slideSafeFrac;

    return new THREE.Vector2(finalX, finalY);
  }
}
