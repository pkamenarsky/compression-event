// -----------------------------------------------------------------------------
// What the world looks like at a version
//
// A world is a sequence of versions, and a version is a layer rather than a
// copy: it stores what changed against its base and resolves against it here,
// on demand. That is the whole reason this file exists — an edit made in v0 is
// seen by v4 without being replayed by hand into v1, v2 and v3.
//
// Resolution is sequential:
//
//   local(k)  = local(k - 1) + vertexEdits_k
//   source(k) = (transform_k o ... o transform_1)(local(k))
//   shape(k)  = erode(source(k), depth_k)
//
// so `source` is what flows down the chain and `shape` is a read-only view
// taken at each version. Version k + 1 erodes source(k), never shape(k), and
// that one decision is what makes erosion free to delete vertices and split a
// room in two: what it deletes belongs to a projection, and a projection has no
// identity to lose. Nothing is written back, ever.
//
// The CSG over the shapes is what the game would see — every `level` polygon
// unioned and every `solid` one taken back out — recomputed from scratch on
// every change, which is affordable at this size and is what makes it possible
// to watch it move while a gesture is running.
//
// Nothing in here derives a frame from geometry the user can edit. An earlier
// version turned and scaled about `centroid(points)`, which tied the frame to
// the points: moving one vertex moved the centroid, and every other vertex
// swung about the difference. A transform is about the world origin instead,
// and the gesture that builds one puts the pivot it wants into the translation.
// -----------------------------------------------------------------------------

import { Point } from '@ce/game/world';
import { OpSubtract, Ring, Shape, combine, contains, erode, isCCW, simplify } from './geometry';
import {
  EMPTY_TRANSFORM,
  Edit,
  Polygon,
  PolygonId,
  PolygonType,
  Transform,
  VersionId,
  VertexId,
  World,
} from './types';
import {
  Edit as SetEdit,
  WorldSet,
  edited,
  emptyWorldSet,
  outline,
} from './worldset';

/** One polygon as a version left it: what edits are made against, and what is
 * drawn. */
export interface Resolved {
  id: PolygonId
  polygon: Polygon
  /** The ring in the polygon's own frame: as drawn, plus every displacement
   * written at this version or before it. */
  local: Ring
  /** Every transform down the chain, composed. Takes `local` to `source`. */
  frame: Affine
  /** The ring this version's layer produced, in world units. The handles live
   * here. */
  source: Ring
  /** The projection: the source decomposed and offset. Read-only, always. */
  shape: Shape
  /** The depth `shape` was taken at, inherited where this version states none. */
  erosion: number
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

// -----------------------------------------------------------------------------
// Building
// -----------------------------------------------------------------------------

/**
 * A polygon as drawn, born into the version it was drawn in, with a fresh id
 * for itself and for every one of its corners.
 *
 * The winding is settled once, here, rather than being read back off the points
 * at every CSG. Which way a ring is wound decides what it contributes under the
 * nonzero rule, so two polygons that overlap only merge if they agree; clicking
 * one out clockwise rather than anticlockwise is not a statement about
 * anything, and left alone it would punch a hole through whatever it overlapped
 * and leave the wall between them standing.
 *
 * Fixing it here is also what leaves the resolved ring free to mean something.
 * A polygon eroded past the point of turning itself inside out comes back wound
 * the other way, and that inversion is real — it has to reach the CSG and
 * cancel, rather than being read as a hole and quietly flipped back.
 */
export function addPolygon(
  world: World,
  type: PolygonType,
  points: Point[],
  birth: VersionId,
): { world: World, id: PolygonId } {
  const wound = isCCW(points) ? points : [...points].reverse();

  const id = world.nextId;
  const polygon: Polygon = {
    type,
    birth,
    points: wound.map((at, i) => ({ id: id + 1 + i, at: { ...at } })),
  };

  const polygons = new Map(world.polygons);
  polygons.set(id, polygon);

  return {
    world: { ...world, polygons, nextId: id + 1 + wound.length },
    id,
  };
}

// -----------------------------------------------------------------------------
// Resolution
// -----------------------------------------------------------------------------

/** The versions from the root down to `v`, in the order they apply. */
export function chain(world: World, v: VersionId): VersionId[] {
  const out: VersionId[] = [];

  for (let at: VersionId | null = v; at !== null; at = world.versions[at].base) {
    out.unshift(at);
  }

  return out;
}

// -----------------------------------------------------------------------------
// The composed frame
//
// A vertex edit is written in the polygon's own frame and every transform in
// the chain carries it, which is the only reading under which a polygon is one
// shape: nudge a corner at v3, turn the polygon at v0, and the corner stays
// where it was put relative to its neighbours rather than swinging out of the
// ring. Written the other way — a displacement against the world geometry the
// base handed over — the nudge keeps its screen direction while the polygon
// turns underneath it, and the shape is different at every upstream angle.
//
// So resolution accumulates one composed affine per polygon rather than pushing
// each version's displacement through the transforms that come after it. That
// is strictly less work, not more: the awkward `sum over j of (M_k ... M_j) e_j`
// is gone, and what is left is one matrix product down the chain and one pass
// over the points at the end.
//
// The composed map is a general affine — rotate, squash, rotate again is a
// shear, so this family is not closed under composition. That costs nothing
// here, because nothing interpolates an accumulated transform: every version
// boundary is a keyframe, and the one in flight is stored per version in
// components. Components are kept separate for interpolation, and this is not
// interpolation.
// -----------------------------------------------------------------------------

/** `(x, y)` goes to `(ax + cy + tx, bx + dy + ty)`. */
export interface Affine {
  a: number
  b: number
  c: number
  d: number
  tx: number
  ty: number
}

export const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

/** One version's layer as a matrix: scale per axis, then turn, then move. */
export function affine(t: Transform): Affine {
  const c = Math.cos(t.rotation), s = Math.sin(t.rotation);

  return {
    a: c * t.scale.x,
    b: s * t.scale.x,
    c: -s * t.scale.y,
    d: c * t.scale.y,
    tx: t.translation.x,
    ty: t.translation.y,
  };
}

/** `outer` after `inner`. */
export function compose(outer: Affine, inner: Affine): Affine {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    tx: outer.a * inner.tx + outer.c * inner.ty + outer.tx,
    ty: outer.b * inner.tx + outer.d * inner.ty + outer.ty,
  };
}

export function place(m: Affine, ring: Ring): Ring {
  return ring.map(p => ({
    x: m.a * p.x + m.c * p.y + m.tx,
    y: m.b * p.x + m.d * p.y + m.ty,
  }));
}

/**
 * A world point back in the frame `m` came from. The inverse of `place`, named
 * apart from `displaced` above, which is about vertex edits rather than frames.
 *
 * Always possible: every stage of the chain refuses a zero axis, so no stage is
 * singular and neither is their product.
 */
export function unplace(m: Affine, p: Point): Point {
  const det = m.a * m.d - m.b * m.c;
  const x = p.x - m.tx, y = p.y - m.ty;

  return {
    x: (m.d * x - m.c * y) / det,
    y: (m.a * y - m.b * x) / det,
  };
}

/** The vertex displacements this layer holds, added to the ones already
 * standing. Keyed by id, so an edit survives a vertex being inserted upstream. */
function displaced(polygon: Polygon, ring: Ring, vertices: Map<VertexId, Point>): Ring {
  if (vertices.size === 0) return ring;

  return ring.map((p, i) => {
    const d = vertices.get(polygon.points[i].id);

    return d === undefined ? p : { x: p.x + d.x, y: p.y + d.y };
  });
}

/**
 * The projection: what a source ring at a depth actually looks like.
 *
 * `simplify` first, because a source ring is allowed to cross itself — the
 * machinery for turning a self-crossing loop into loops that do not is already
 * in this path for the offset, and having it here while forbidding it on the
 * input would be an invariant enforced for its own sake.
 */
export function project(source: Ring, erosion: number): Shape {
  return erosion === 0 ? [source] : erode(simplify([source]), erosion);
}

/**
 * Every polygon as version `v` leaves it, one stage at a time from the root.
 *
 * Depth is inherited rather than restated: a version that says nothing about a
 * polygon leaves it exactly as its base had it, erosion included, which is what
 * makes a fresh version render identically to the one before it. To shrink
 * progressively the author raises the depth version by version — 2, 5, 9, 14 —
 * which is more direct to author than compounding and exactly reproducible.
 */
export function resolveAt(world: World, v: VersionId): Resolved[] {
  const local = new Map<PolygonId, Ring>();
  const frame = new Map<PolygonId, Affine>();
  const depth = new Map<PolygonId, number>();

  for (const k of chain(world, v)) {
    const version = world.versions[k];

    for (const [id, polygon] of world.polygons) {
      if (polygon.birth === k) {
        local.set(id, polygon.points.map(p => ({ ...p.at })));
        frame.set(id, IDENTITY);
        depth.set(id, 0);
      }

      const ring = local.get(id);
      const edit = version.edits.get(id);

      if (ring === undefined || edit === undefined) continue;

      local.set(id, displaced(polygon, ring, edit.vertices));
      frame.set(id, compose(affine(edit.transform), frame.get(id)!));
      depth.set(id, edit.transform.erosion);
    }
  }

  const out: Resolved[] = [];

  for (const [id, ring] of local) {
    const polygon = world.polygons.get(id)!;
    const erosion = depth.get(id) ?? 0;
    const m = frame.get(id)!;
    const source = place(m, ring);

    out.push({
      id,
      polygon,
      local: ring,
      frame: m,
      source,
      shape: project(source, erosion),
      erosion,
    });
  }

  return out;
}

// -----------------------------------------------------------------------------
// Editing
//
// You edit the version you are standing in, and edits flow forward. That is the
// entire propagation model: there is no way to author an edit that lands in an
// earlier version than the one on screen, so if something is wrong in v0, go to
// v0 and fix it, and watch the consequences downstream with ghosts.
// -----------------------------------------------------------------------------

/**
 * This version's own edit for a polygon, or a fresh one that changes nothing.
 *
 * The depth is seeded from what the polygon already resolved to, so that the
 * first thing written into a layer — a nudge, a move — does not also throw away
 * the erosion its base had.
 */
export function editAt(world: World, v: VersionId, id: PolygonId, erosion: number): Edit {
  return world.versions[v].edits.get(id)
    ?? { transform: { ...EMPTY_TRANSFORM, erosion }, vertices: new Map() };
}

export function withEdit(world: World, v: VersionId, id: PolygonId, edit: Edit): World {
  const versions = [...world.versions];
  const edits = new Map(versions[v].edits);

  edits.set(id, edit);
  versions[v] = { ...versions[v], edits };

  return { ...world, versions };
}

/**
 * A source vertex put under the cursor, exactly.
 *
 * The displacement is written in the polygon's own frame, so every transform in
 * the chain carries it and the corner keeps its place in the ring however the
 * polygon is turned or squashed upstream. Taking the cursor back to that frame
 * is one inverse of the composed matrix, which is exact: erosion is not in the
 * way, having never touched the source.
 *
 * It is not cumulative. The displacement replaces what this layer held rather
 * than adding to it, so a drag that returns to where it started leaves the
 * layer as it found it.
 */
export function placeVertex(it: Resolved, edit: Edit, index: number, at: Point): Edit {
  const id = it.polygon.points[index].id;
  const was = edit.vertices.get(id) ?? { x: 0, y: 0 };

  const target = unplace(it.frame, at);
  const local = it.local[index];

  const vertices = new Map(edit.vertices);
  vertices.set(id, {
    x: was.x + target.x - local.x,
    y: was.y + target.y - local.y,
  });

  return { ...edit, vertices };
}

// -----------------------------------------------------------------------------
// Reading the result
// -----------------------------------------------------------------------------

/**
 * The set the game would get — every `level` unioned, every `solid` taken out —
 * as the open runs its outline is made of.
 *
 * Runs rather than rings because that is what can be kept up to date: a run
 * belongs to one polygon, so an edit only disturbs the polygons it overlaps.
 * See `worldset.ts`. Nothing that reads this wants a closed loop — the overlay
 * is stroked, and collision is edge-normal based.
 */
export function csg(items: Resolved[]): Point[][] {
  return runs(live(EMPTY_LIVE, items));
}

/**
 * The set, held on to between draws so that redrawing costs only what actually
 * moved. Rebuilding it from nothing is O(n) in polygons and measured at nearly
 * two seconds for ten thousand of them; bringing it up to date after a dragged
 * vertex is about a millisecond.
 */
export interface Live {
  set: WorldSet
  /** What each polygon resolved to when the set was last brought up to date. */
  seen: Map<PolygonId, Resolved>
}

export const EMPTY_LIVE: Live = { set: emptyWorldSet, seen: new Map() };

export function runs(l: Live): Point[][] {
  return outline(l.set);
}

/**
 * The set brought up to date against `items`, doing only the work the
 * differences call for.
 *
 * `resolveAt` builds fresh arrays every time, so what changed cannot be read
 * off object identity and is compared point by point instead. That costs one
 * pass over the geometry, which is the same order as resolving it — and far
 * less than rebuilding the set for a world where nothing moved.
 */
export function live(previous: Live, items: Resolved[]): Live {
  const edits: SetEdit[] = [];
  const seen = new Map<PolygonId, Resolved>();

  for (const it of items) {
    seen.set(it.id, it);

    const was = previous.seen.get(it.id);
    const retyped = was !== undefined && was.polygon.type !== it.polygon.type;

    if (was !== undefined && !retyped && unmoved(was.shape, it.shape)) continue;

    // A retype has to go in as an insert: an update keeps the kind it had.
    edits.push(
      was === undefined || retyped
        ? { op: 'insert', id: it.id, type: it.polygon.type, shape: it.shape }
        : { op: 'update', id: it.id, shape: it.shape },
    );
  }

  for (const id of previous.seen.keys()) {
    if (!seen.has(id)) edits.push({ op: 'remove', id });
  }

  return edits.length === 0 ? previous : { set: edited(edits)(previous.set), seen };
}

function unmoved(a: Shape, b: Shape): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;

  for (let r = 0; r < a.length; r++) {
    const p = a[r], q = b[r];

    if (p.length !== q.length) return false;

    for (let i = 0; i < p.length; i++) {
      if (p[i].x !== q[i].x || p[i].y !== q[i].y) return false;
    }
  }

  return true;
}

/** The topmost polygon under a point, hit against what is on screen. */
export function hitPolygon(items: Resolved[], at: Point): PolygonId | null {
  for (let i = items.length - 1; i >= 0; i--) {
    if (contains(items[i].shape, at)) return items[i].id;
  }

  return null;
}

/**
 * The nearest source vertex within `radius` world units, topmost first.
 *
 * The source ring, never the projection. The eroded outline carries no handles
 * at all and there is no gesture that pretends it does — it is derived
 * geometry, in the same sense the CSG result is, and nobody expects to drag
 * that either.
 */
export function hitVertex(
  items: Resolved[],
  at: Point,
  radius: number,
): { id: PolygonId, index: number } | null {
  let best: { id: PolygonId, index: number } | null = null;
  let bestDistance = radius;

  for (const it of items) {
    it.source.forEach((p, index) => {
      const d = Math.hypot(p.x - at.x, p.y - at.y);

      if (d <= bestDistance) {
        bestDistance = d;
        best = { id: it.id, index };
      }
    });
  }

  return best;
}

/** Everything with a source vertex inside the box, which is enough for a
 * marquee. */
export function withinBox(items: Resolved[], a: Point, b: Point): PolygonId[] {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);

  return items
    .filter(it => it.source.some(p => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1))
    .map(it => it.id);
}
