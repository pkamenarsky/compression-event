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
import {
  Ring,
  Shape,
  contains,
  encloses,
  erode,
  erodeAt,
  erodeRingsAt,
  isCCW,
  keeping,
  nextOf,
  onBoundary,
  simplify,
  sliced,
  intersect,
  subtract,
  unionAll,
} from './geometry';
import {
  ArtefactId,
  ArtefactType,
  Clipping,
  EMPTY_TRANSFORM,
  Edit,
  Footing,
  GroupId,
  IconType,
  FLOOR,
  Id,
  KINDS,
  SETS,
  SLOT_KINDS,
  SLOTS,
  SOLID,
  Path,
  PathId,
  Vertex,
  Polygon,
  PolygonId,
  PolygonKind,
  SetName,
  Transform,
  Version,
  VersionId,
  VertexId,
  World,
  enclosing,
  inside,
  kindOf,
  kindKey,
  opened,
  parentOf,
  ringsOf,
  inverted,
  sameKind,
  slotOf,
  standing,
  within,
} from './types';
import {
  Edit as SetEdit,
  WorldSet,
  edited,
  emptyWorldSet,
  outline,
  pieces,
} from './worldset';
import { remembered } from './memo';

/** One polygon as a version left it: what edits are made against, and what is
 * drawn. */
export interface Resolved {
  id: PolygonId
  polygon: Polygon
  /**
   * The corners this version actually has, in ring order.
   *
   * Index for index with `local` and `source`. `polygon.points` is not: it
   * holds every corner the polygon has ever had, and which of them are standing
   * is a question about the version. Anything wanting the id of the corner it
   * is looking at reads this.
   */
  corners: Vertex[]
  /**
   * Where each ring of `corners` starts, from `ringsOf`.
   *
   * The corners, the local points, the source points and the depths are all one
   * flat list in ring order — a hole's corners follow the outline's — and this
   * is the only thing that says where one ring stops and the next begins. Which
   * is the whole of what a hole changes for anything walking them: the corner
   * after the last of a ring is the first of that same ring. See `nextOf`.
   *
   * Worked out by `resolved` off the corners it was handed, so nothing building
   * one has to keep it in step.
   */
  readonly rings: readonly number[]
  /** The points in the polygon's own frame, ring after ring: as drawn, plus
   * every displacement written at this version or before it. */
  local: Ring
  /** Every transform down the chain, composed. Takes `local` to `source`. */
  frame: Affine
  /** The points this version's layer produced, in world units, ring after ring.
   * The handles live here. */
  source: Ring
  /**
   * The projection: the source decomposed and offset. Read-only, always.
   *
   * Worked out when it is first asked for, and then kept. It is an arrangement
   * per polygon, which is nothing next to what the editor does with it and is
   * most of the cost of resolving a world the bake is about to look at five
   * polygons of. Spreading a `Resolved` reads it, so anything wanting to build
   * one from another names the fields.
   */
  readonly shape: Shape
  /** The depth `shape` was taken at, inherited where this version states none. */
  erosion: number
  /**
   * The extra depth on single corners, by id — `Edit.depths` as this version
   * leaves it, and empty in every world nobody has offset a corner of.
   *
   * Kept by id rather than as an array beside `corners` because that is how it
   * is authored and how it is written down; `depths` below is the same thing
   * arranged for the offset, which wants a number per vertex of the ring and
   * nothing to look up.
   *
   * The editor's business alone, and absent where nobody is going to ask: an
   * instant inside a span is not a version and has no layer to have said this,
   * and building the map anyway would be one allocation per polygon per instant
   * of the bake for a field nothing there reads.
   */
  over?: ReadonlyMap<VertexId, number>
  /**
   * The total depth at each of `corners`, or nothing where they all agree.
   *
   * `null` is not an optimisation. A uniform offset is the one `erode` takes,
   * an arrangement it has always taken and whose answer is byte-for-byte what
   * it was; the varying one goes another way round. So the two are told apart
   * once, here, rather than by every reader comparing numbers.
   */
  depths: readonly number[] | null
  /**
   * Points the projection must have as vertices even though it does not turn
   * at them, in world units.
   *
   * The bake's business alone. A corner it invented so that both ends of a
   * span carry the same ring sits exactly on the edge between its neighbours at
   * the end that does not have it, and `cornersOnly` would drop it there — so
   * the ring would change length part way through the span, which is the one
   * event the invention exists to prevent. Nothing else sets this, and an empty
   * one costs nothing.
   */
  keep?: readonly Point[]
}

/**
 * The middle of what is picked: the centre of the box round it.
 *
 * The box rather than the average of the points, which is what this was and
 * what made a resolve feel like it had moved something. An average is a
 * question about where the corners are, and a shape can be handed the same
 * ground with its corners arranged quite differently — two rooms unioned come
 * back as one ring, and a corner sitting on a straight edge because that is
 * where a neighbour ended counts as much as a corner the shape actually turns
 * at. Resolving redistributes corners by construction, so the average slid
 * across a shape that had not changed at all.
 *
 * The box does not care how many corners sit where, only how far the thing
 * reaches — and how far it reaches is exactly what does not change when the
 * same ground is written down another way.
 *
 * A single point is its own middle, which is what the start wants: turning it
 * leaves the place alone and changes only the facing.
 */
export function middle(points: readonly Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 };

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;

  for (const p of points) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }

  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
}

/** The average of a ring's corners. Somewhere inside a convex ring and
 * somewhere near a concave one, which is all `budding` needs of it — it is not
 * where a gesture turns about, and `middle` says why. */
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
  kind: PolygonKind,
  points: Point[],
  birth: VersionId,
  where: Landing,
): { world: World, id: PolygonId } {
  const wound = isCCW(points) ? points : [...points].reverse();
  const local = wound.map(p => unplace(where.frame, p));

  const id = world.nextId;
  const polygon: Polygon = {
    ...kind,
    birth,
    death: null,
    points: local.map((at, i) => ({ id: id + 1 + i, at, ring: 0, birth, death: null })),
  };

  const polygons = new Map(world.polygons);
  polygons.set(id, polygon);

  return {
    world: joined({ ...world, polygons, nextId: id + 1 + local.length }, where.into, [id]),
    id,
  };
}

// -----------------------------------------------------------------------------
// Artefacts
//
// A polygon is a shape with a history of what has been done to it; an artefact
// is a place, and the history is the places. So none of the machinery above
// applies to one — no frame, no projection, no set — and all of it here is a
// read of `Artefact.at` against a chain.
// -----------------------------------------------------------------------------

/** One artefact as a version left it, or the start, which every version
 * leaves where it is. */
export interface Placed {
  id: ArtefactId
  type: IconType
  at: Point
  /** Which way its frame has been turned, as a yaw in radians. See `facing`. */
  facing: number
}

/**
 * Which way a frame is pointing, out of its linear part alone.
 *
 * An artefact is a place and carries no direction of its own, so the direction
 * is the one its chain has turned it: north in its own frame, taken through
 * the same transforms its point is. A yaw rather than a vector, and measured
 * the way the game measures the player's — zero looks up the negative y axis,
 * and it grows clockwise on screen.
 *
 * Only the start has anything to do with it. A key has no front.
 */
export function facing(m: Affine): number {
  const x = -m.c, y = -m.d;

  return Math.atan2(x, -y);
}

/**
 * Every version that takes something out: its own removal, and the removal of
 * any group holding it.
 *
 * A group goes with what is in it — that is the rule a delete has always
 * followed — so what removes the holder removes the held. `removeAt` writes
 * both, and this is not for the things it wrote. It is for the one case the
 * writing cannot reach: a room drawn *into* a group at v1 when the group was
 * already taken out at v3. Nobody could have written a death on it, since it
 * did not exist when the group went, and it must still go where the group
 * went.
 *
 * Only deaths, never births. A group made at v2 out of rooms drawn at v0 does
 * not un-draw them: grouping is a handle appearing, and removing one is the
 * contents going.
 */
export function removals(world: World, id: Id): VersionId[] {
  const own = lived(world, id);
  const out: VersionId[] = own === undefined || own.death === null ? [] : [own.death];

  for (const g of enclosing(world, id)) {
    const death = world.groups.get(g)?.death;

    if (death !== undefined && death !== null) out.push(death);
  }

  return out;
}

/**
 * Whether a thing is one of the world's at a version: born into the chain, and
 * neither it nor anything holding it taken out by one.
 *
 * The whole of what existence means here, and the one place that says so.
 * `resolveAt` asks the same question the long way round, because it is walking
 * the chain anyway and can drop a polygon as it passes.
 */
export function standingIn(world: World, id: Id, from: ReadonlySet<VersionId>): boolean {
  const own = lived(world, id);

  if (own === undefined || !standing(own, from)) return false;

  return removals(world, id).every(d => !from.has(d));
}

/**
 * The stretch of the chain `id` stands over, whichever kind of thing it is.
 *
 * Four maps and one question. Every kind in the world is born into a version
 * and taken out at one — that is what existence means here — and the two
 * readers above want the answer rather than the map it came out of.
 */
function lived(world: World, id: Id): { birth: VersionId, death: VersionId | null } | undefined {
  return world.polygons.get(id)
    ?? world.groups.get(id)
    ?? world.artefacts.get(id)
    ?? world.paths.get(id);
}

/**
 * Where an artefact stands at a version, or nothing if it is not there yet.
 *
 * Its own point taken through every transform down the chain, which is the same
 * walk `resolveAt` does for a polygon's ring and is already written: an
 * artefact is in the version's layers like anything else, so `groupFrame`
 * answers for it without knowing what it is.
 */
export function placeAt(world: World, id: ArtefactId, v: VersionId): Point | null {
  const it = world.artefacts.get(id);

  if (it === undefined || !standingIn(world, id, new Set(chain(world, v)))) return null;

  return place(groupFrame(world, v, id), [it.at])[0];
}

/** Which way it is pointing at a version, or nothing if it is not there. */
export function facingAt(world: World, id: ArtefactId, v: VersionId): number | null {
  const it = world.artefacts.get(id);

  if (it === undefined || !standingIn(world, id, new Set(chain(world, v)))) return null;

  return facing(groupFrame(world, v, id));
}

/**
 * The start's id in a list of `Placed`.
 *
 * It has no id — it is a field of the world rather than something in a map —
 * but it is drawn and picked alongside the artefacts, and a `Placed` is named
 * by one. Negative, so it can never be mistaken for a real id: those come off
 * a counter that starts at zero and only goes up.
 */
export const START_ID: ArtefactId = -1;

/** The start as one of the things standing in the level. Every version gets
 * the same one. */
export function startPlaced(world: World): Placed {
  return { id: START_ID, type: 'start', at: world.start.at, facing: world.start.facing };
}

/** The start moved to a point of its own, which is where it is at every
 * version. */
export function movedStart(world: World, at: Point): World {
  return { ...world, start: { ...world.start, at } };
}

/** The start turned to face a yaw. */
export function turnedStart(world: World, facing: number): World {
  return { ...world, start: { ...world.start, facing } };
}

/** Everything standing at a version, the start first: it is drawn under the
 * artefacts, and picked after them where the two overlap. */
export function shownAt(world: World, v: VersionId): Placed[] {
  return [startPlaced(world), ...artefactsAt(world, v)];
}

/** Everything standing at a version, in id order. */
export function artefactsAt(world: World, v: VersionId): Placed[] {
  const out: Placed[] = [];

  for (const [id, it] of world.artefacts) {
    const at = placeAt(world, id, v);

    if (at !== null) out.push({ id, type: it.type, at, facing: facingAt(world, id, v)! });
  }

  return out.sort((a, b) => a.id - b.id);
}

/**
 * Born into the version it was put in, where the cursor put it.
 *
 * Read in the landing's frame, like a drawn polygon: dropping one inside a
 * group standing open makes a member of that group, exactly where it was
 * dropped rather than wherever the group's own transform would have sent it.
 */
export function addArtefact(
  world: World,
  type: ArtefactType,
  at: Point,
  v: VersionId,
  where: Landing,
): { world: World, id: ArtefactId } {
  const id = world.nextId;
  const artefacts = new Map(world.artefacts);

  artefacts.set(id, { type, birth: v, death: null, at: unplace(where.frame, at) });

  return {
    world: joined({ ...world, artefacts, nextId: id + 1 }, where.into, [id]),
    id,
  };
}

export function retypeArtefacts(
  world: World,
  ids: readonly ArtefactId[],
  type: ArtefactType,
): World {
  const artefacts = new Map(world.artefacts);

  for (const id of ids) {
    const it = world.artefacts.get(id);

    if (it !== undefined) artefacts.set(id, { ...it, type });
  }

  return { ...world, artefacts };
}

/** The topmost one within `reach` of a point, or nothing. Later ids first, so
 * the one drawn on top is the one picked. */
export function hitArtefact(shown: readonly Placed[], p: Point, reach: number): ArtefactId | null {
  for (let i = shown.length - 1; i >= 0; i--) {
    if (Math.hypot(shown[i].at.x - p.x, shown[i].at.y - p.y) <= reach) return shown[i].id;
  }

  return null;
}

export function artefactsWithinBox(shown: readonly Placed[], a: Point, b: Point): ArtefactId[] {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);

  return shown
    .filter(it => it.at.x >= x0 && it.at.x <= x1 && it.at.y >= y0 && it.at.y <= y1)
    .map(it => it.id);
}

// -----------------------------------------------------------------------------
// Paths
//
// An artefact is one place read against a chain; a path is a run of them, read
// against the same chain in one call. So this is the artefact section with the
// arity changed, and deliberately nothing more: a path has no ring, no
// projection and no depth, so none of the machinery above it applies either.
//
// What that buys is the whole of why paths are in here at all. A tape is drawn
// to measure a room, and it is worth what it says only for as long as it is
// still lying across that room — put it in the group and the version that moves
// the room moves the tape with it, because the frame both are read in is the
// one thing they now share.
// -----------------------------------------------------------------------------

/**
 * One measuring path as a version left it.
 *
 * A `Resolved` with the parts a path has, and named the same: `points` is the
 * walk in world units, where the handles live, and `frame` is what took it
 * there. There is no `local` beside them because there is nothing to displace
 * — the route is one list every version reads — so the path's own points are
 * its `local`, and `frame` is the whole of what a version does to it.
 */
export interface Laid {
  id: PathId
  points: Point[]
  /**
   * Every transform down the chain, composed: exactly `Resolved.frame`.
   *
   * Kept here rather than asked for, because a gesture writing a point back
   * needs the same frame that placed it and reaching for another one is the
   * mistake worth designing out. See `inFrame`.
   */
  frame: Affine
}

/**
 * Where a path runs at a version, or nothing if it is not there.
 *
 * `placeAt` with more than one point, down to the call it makes: the route is
 * in the path's own frame, and the frame is what the chain has to say about it.
 */
export function pathAt(world: World, id: PathId, v: VersionId): Point[] | null {
  return laidAt(world, id, v)?.points ?? null;
}

/** The same, with the frame it was placed by — which is what anything writing
 * a point back wants, and the reason `Laid` carries one. */
export function laidAt(world: World, id: PathId, v: VersionId): Laid | null {
  const it = world.paths.get(id);

  if (it === undefined || !standingIn(world, id, new Set(chain(world, v)))) return null;

  const frame = groupFrame(world, v, id);

  return { id, points: place(frame, it.points), frame };
}

/** Every path standing at a version, in id order. */
export function pathsAt(world: World, v: VersionId): Laid[] {
  const out: Laid[] = [];

  for (const id of world.paths.keys()) {
    const it = laidAt(world, id, v);

    if (it !== null) out.push(it);
  }

  return out.sort((a, b) => a.id - b.id);
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

/**
 * Where a new thing goes, and the frame it will be read in.
 *
 * Everything that makes geometry takes one of these, and there is one place
 * that builds it. Drilled into a group, *everything* the author does happens in
 * there — drawing a polygon, pasting, grouping — and the way that kept being
 * got wrong was one path at a time: paste knew about the open group, drawing
 * did not; drawing was fixed, and grouping still was not. A parameter that
 * cannot be left out is the fix that does not need remembering.
 *
 * The frame is why this is a pair rather than a group id. A member's ring is
 * read inside its group's transform, so points that came from the screen —
 * where a click landed, where a clipping was seen — have to come back through
 * it or the thing arrives turned. `landing` is the only place that decides.
 */
export interface Landing {
  into: GroupId | null
  frame: Affine
}

/** The top level, where everything goes when no group is open. Named so that
 * saying so is a decision rather than a default nobody had to make. */
export const TOP: Landing = { into: null, frame: IDENTITY };

/** Where the author is working: the group standing open, if one is. */
export function landing(world: World, v: VersionId, inside: GroupId | null): Landing {
  return inside === null || !world.groups.has(inside)
    ? TOP
    : { into: inside, frame: inward(world, v, inside) };
}

/** `ids` taken into `into`, at the end, where the last thing done goes. */
export function joined(world: World, into: GroupId | null, ids: readonly Id[]): World {
  const group = into === null ? undefined : world.groups.get(into);

  if (group === undefined || into === null) return world;

  const groups = new Map(world.groups);

  groups.set(into, { ...group, members: [...group.members, ...ids] });

  return { ...world, groups };
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

/**
 * This layer's displacements, added to what the corners already stood at.
 *
 * Keyed by corner throughout, rather than by where it sits in the ring: which
 * corners a version has is not what the version before it had, so an index is
 * not a name that survives the step.
 */
function displace(at: Map<VertexId, Point>, vertices: Map<VertexId, Point>): void {
  for (const [id, d] of vertices) {
    const p = at.get(id);

    if (p !== undefined) at.set(id, { x: p.x + d.x, y: p.y + d.y });
  }
}

/**
 * The projection: what a source ring at a depth actually looks like.
 *
 * `simplify` first, because a source ring is allowed to cross itself — the
 * machinery for turning a self-crossing loop into loops that do not is already
 * in this path for the offset, and having it here while forbidding it on the
 * input would be an invariant enforced for its own sake.
 *
 * At every depth, including none. A ring is cut where it starts, and which
 * vertex that is has to be a fact about the ring rather than about the path it
 * came down — the bake names a point by where it sits in the ring it came out
 * of, and compares those names across two instants. `simplify` settles the
 * winding, and where a ring starts follows from its winding: hand a clockwise
 * ring through and it comes back the other way round, which moves every index
 * by one. Skipping it at depth zero is what used to happen, so a shape that
 * had not started eroding was cut one corner away from the same shape a moment
 * later, and the two were interpolated corner-to-neighbour: a square turning
 * into a diamond inscribed in itself.
 */
export const project = remembered((
  source: Ring,
  rings: readonly number[],
  erosion: number,
  depths: readonly number[] | null,
): Shape => {
  // One ring is the case the winding still has to be settled for: a source ring
  // is whatever it was drawn as, and `erodeAt` is what decides which way is in.
  // A source with holes in it has already said, by how its rings are wound, and
  // settling each of them on its own would fill the holes.
  if (depths !== null) {
    return rings.length <= 1 ? erodeAt(source, depths) : erodeRingsAt(sliced(source, rings), depths);
  }

  const simple = simplify(sliced(source, rings));

  return erosion === 0 ? simple : erode(simple, erosion);
});

/** The per-corner depths under a frame that scales: an offset is a length and
 * goes through one the way lengths do. */
function scaled(depths: readonly number[] | null, s: number): readonly number[] | null {
  return depths === null ? null : depths.map(d => d / s);
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
/**
 * What a frame does to lengths, or nothing when it does different things to
 * different directions.
 *
 * A similarity is what erosion survives: the two columns have to be
 * perpendicular and the same length, so that a circle comes out a circle and an
 * inward normal stays inward. A reflection is turned down with them — it hands
 * back a ring wound the other way, and every reader downstream takes the
 * winding for the answer.
 *
 * The comparisons are relative and deliberately tight. Being wrong here does
 * not look wrong, it disagrees with the shape the world frame would have given,
 * so anything not plainly a similarity goes the long way round.
 */
function similarity(m: Affine): number | null {
  const s = Math.hypot(m.a, m.b);
  const t = Math.hypot(m.c, m.d);

  if (s === 0 || m.a * m.d - m.b * m.c <= 0) return null;
  if (Math.abs(t - s) > s * 1e-12) return null;
  if (Math.abs(m.a * m.c + m.b * m.d) > s * s * 1e-12) return null;

  return s;
}

/**
 * The projection, taken wherever it is cheapest to take it and always handed
 * back in world units.
 *
 * Which is usually the polygon's own frame: its *local* ring is the one thing
 * about it a move does not change. A mitred offset commutes with a rigid
 * motion — every edge moves inward along its own normal, and a rotation takes
 * normals to normals — so a polygon being carried about at a fixed depth has
 * one projection, seen from different places. Taken there, `project` has
 * answered it already, and it is the difference between an arrangement per
 * instant and one per gesture — and one between every version it stands at
 * unchanged.
 *
 * Under a uniform scale the depth scales with it, which is the `erosion / s`
 * below. Under anything else — a squash, a shear — an offset is genuinely not
 * the same shape seen twice, and the world frame is where it has to be taken.
 * See `similarity`.
 *
 * What this does *not* answer is a depth that is itself moving. A span whose
 * version deepens an erosion has a different shape at every instant of it, and
 * no framing makes two of them one. That is the bake's own cost and it is
 * inherent; this is for the polygon that moves at the depth it already had.
 */
function projection(at: Omit<Resolved, 'shape'>): Shape {
  const s = similarity(at.frame);

  if (s === null) return project(at.source, at.rings, at.erosion, at.depths);

  return project(at.local, at.rings, at.erosion / s, scaled(at.depths, s))
    .map(ring => place(at.frame, ring));
}

/**
 * A `Resolved` whose projection has not been taken yet.
 *
 * The ring split comes off the corners rather than being handed in. It is a
 * fact about them — which ring each says it is in — so asking every caller to
 * work it out again would be asking them all to agree, and the bake and the
 * editor build these in different places for different reasons.
 */
export function resolved(at: Omit<Resolved, 'shape' | 'rings'>): Resolved {
  const rings = ringsOf(at.corners);
  let shape: Shape | null = null;

  return {
    ...at,
    rings,
    get shape(): Shape {
      return shape ??= keeping(projection({ ...at, rings }), at.keep ?? []);
    },
  };
}

/**
 * The transform every group holding `id` puts on it at one version, composed
 * outermost last.
 *
 * A group is a frame its members sit in, so this is the same composition the
 * version chain does — apply mine, then the enclosing one's — one level of
 * structure at a time instead of one version at a time. That is deliberate:
 * one rule to learn rather than two that rhyme.
 *
 * Every version, whenever the group was made. Membership is one fact about the
 * world, not something a layer does, so a group made while standing at v3 holds
 * its members at v0 too and can be moved there. What is versioned is the
 * transform, and a version that says nothing about a group leaves it alone —
 * which is why making one changes nothing anywhere until it is used.
 *
 * The group's own erosion is not read here. It offsets the union of what the
 * members produced, which is a read taken after this one and after the CSG has
 * put the union together. See *Groups* in `docs/versioning.md`.
 */
function held(world: World, version: Version, id: Id): Affine {
  return enclosing(world, id).reduce(
    (m, g) => compose(affine(version.edits.get(g)?.transform ?? EMPTY_TRANSFORM), m),
    IDENTITY,
  );
}

/**
 * The frame a thing's own transform at version `v` is read in.
 *
 * Resolve applies a layer in two stages: the thing's own transform first, and
 * then the transforms of the groups holding it, at that same version. So what
 * a polygon's own transform does happens *inside* whatever its groups are
 * doing, and its numbers are not in world units — a translation of (10, 0) on
 * a polygon inside a group turned a quarter turn moves it ten units *down* the
 * screen.
 *
 * Anything writing a transform from a gesture therefore has to take the cursor
 * back through this first, or it is answering a question asked in world units
 * with a number that will be read in another frame entirely. The pivot of a
 * rotation is the case that shows it worst: left alone, a polygon inside a
 * turned group spins about a point that is nowhere near it.
 *
 * Only this version's groups, and that is not an oversight. A group's turn at
 * an earlier version is already inside the space this one's own transform acts
 * on, because that is the order `resolveAt` composed them in.
 */
export function under(world: World, v: VersionId, id: Id): Affine {
  return held(world, world.versions[v], id);
}

/**
 * The frame a thing newly put inside `into` at `v` is placed by.
 *
 * `under` answers this for something already in the world, off its own
 * enclosing groups. A paste has nothing to ask about yet — the thing does not
 * exist and is about to be built to fit — so the same walk is done one step
 * early: the group's own transform, and then everything holding the group.
 *
 * Born at `v`, so this version's layer is the whole of it. Nothing earlier ever
 * applied to something that was not there.
 */
export function inward(world: World, v: VersionId, into: GroupId): Affine {
  const version = world.versions[v];
  const own = affine(version.edits.get(into)?.transform ?? EMPTY_TRANSFORM);

  return compose(held(world, version, into), own);
}

/** A world-space step as the frame `m` reads it. A direction and a distance,
 * so the frame's own translation is not part of the answer. */
export function unstep(m: Affine, dx: number, dy: number): Point {
  const o = unplace(m, { x: 0, y: 0 });
  const p = unplace(m, { x: dx, y: dy });

  return { x: p.x - o.x, y: p.y - o.y };
}

/**
 * The frame a thing is placed by at a version: its own layer at every stage of
 * the chain, and every group holding it, in the order resolve applies them.
 *
 * The same walk `resolveAt` does for a polygon, without the geometry — this is
 * what it puts in `Resolved.frame`, for the things that have no ring to hang
 * one on. A group has none, an artefact has a point, a path has a run of them.
 * What it is also for is the bake: keeping a group's points in this rather than
 * in world units is what makes a turning group interpolate along its arc
 * instead of across the chord.
 *
 * The walk starts where the thing does. Nothing that happened before it was
 * there applies to it — a room drawn into a group at v2 is placed against the
 * group *as it stands at v2*, and the move the group was given at v0 is
 * already in the ground it was drawn on rather than something still to be
 * applied. `resolveAt` says exactly this for a polygon by seeding the frame at
 * `polygon.birth`, and this said it for nothing at all: an artefact dropped
 * into a group an earlier version had moved came out offset by that move, once
 * for every version between.
 *
 * Membership in the chain rather than `k < birth`, for the reason `standing`
 * is: versions happen to be numbered in order today and forks would end that.
 */
export function groupFrame(world: World, v: VersionId, id: Id): Affine {
  let m = IDENTITY;

  // Nothing in the maps is nothing to be born — the sides `sideOf` mints, and
  // anything asking about an id the world has lost. The whole chain for those,
  // which is what this always did.
  const born = lived(world, id)?.birth;
  let here = born === undefined;

  for (const k of chain(world, v)) {
    if (!here) {
      if (k !== born) continue;

      here = true;
    }

    const version = world.versions[k];
    const footing = version.footings.get(id);

    // Everything the chain had built up to here, thrown away for what the
    // footing says instead. Before this version's own layer, which then applies
    // on top of it exactly as it would have. See `Footing`.
    if (footing !== undefined) m = footing.frame;

    m = compose(affine(version.edits.get(id)?.transform ?? EMPTY_TRANSFORM), m);
    m = compose(held(world, version, id), m);
  }

  return m;
}

/** Shared, because there is one of these per polygon per resolve and almost
 * all of them are this. */
const EMPTY_DEPTHS: ReadonlyMap<VertexId, number> = new Map();

/**
 * The depth at each standing corner, or nothing where the layer says nothing
 * about any of them.
 *
 * A corner named with an offset of nought is the same as a corner not named, so
 * a map that has been written into and emptied again does not put the polygon
 * down the slower road for the rest of the session.
 */
function varying(
  corners: readonly Vertex[],
  erosion: number,
  over: ReadonlyMap<VertexId, number>,
): readonly number[] | null {
  if (over.size === 0) return null;

  let any = false;

  const out = corners.map(c => {
    const d = over.get(c.id) ?? 0;

    if (d !== 0) any = true;

    return erosion + d;
  });

  return any ? out : null;
}

/**
 * The corners standing at a version, ring by ring, with the rings that are no
 * longer rings left out.
 *
 * Three is the fewest a ring can have, and a hole below it is not a hole — it
 * is a couple of stray points that would fold the arrangement rather than open
 * anything. So a hole goes on its own, quietly, and what is left is still a
 * polygon.
 *
 * The outline is the other way round: it going takes the polygon with it, since
 * there is then nothing for the holes to be holes in. That is said by the
 * caller, which has the polygon to drop; here it comes out as a list too short
 * to be one.
 *
 * Which corners are standing comes in as a question rather than as a set of
 * versions, because an unchained polygon answers it differently: what its
 * footing froze is standing whatever the chain says about where it was born.
 * See `Footing`.
 */
function surviving(points: readonly Vertex[], alive: (c: Vertex) => boolean): Vertex[] {
  const out: Vertex[] = [];

  let run: Vertex[] = [];
  let first = true;
  let gone = false;

  const close = (): void => {
    // The outline decides for everybody: below three it is not there, and
    // neither is anything that was a hole in it.
    if (first) gone = run.length < 3;

    if (!gone && run.length >= 3) out.push(...run);

    first = false;
    run = [];
  };

  // Off the whole list rather than off what is standing: a ring every one of
  // whose corners has died is still a boundary in the order, and reading the
  // ring numbers only where somebody survived would let the next ring take the
  // dead one's place as the outline.
  let ring = points[0]?.ring;

  for (const c of points) {
    if (c.ring !== ring) {
      close();

      if (gone) return [];

      ring = c.ring;
    }

    if (alive(c)) run.push(c);
  }

  close();

  return gone ? [] : out;
}

export function resolveAt(world: World, v: VersionId): Resolved[] {
  const order = chain(world, v);
  const inherited = new Set(order);

  // Where each corner stands in its polygon's own frame. A map rather than a
  // ring, because the ring is not a fixed length any more: corners arrive and
  // leave as the chain is walked, and only the ids hold still.
  const local = new Map<PolygonId, Map<VertexId, Point>>();
  const frame = new Map<PolygonId, Affine>();
  const depth = new Map<PolygonId, number>();
  // What a layer says about single corners, wholesale rather than merged, for
  // the same reason `depth` is: a layer states the offsets it means to be
  // under, and `editAt` hands it the ones its base was under to start from.
  const over = new Map<PolygonId, ReadonlyMap<VertexId, number>>();

  // Worked out once rather than per version: the walk up to a polygon's holders
  // is the same at every step of the chain, and there are as many steps as
  // there are versions.
  const taken = new Map<PolygonId, VersionId[]>();

  for (const id of world.polygons.keys()) taken.set(id, removals(world, id));

  // What an unchained polygon hears instead of the whole chain: the stretch of
  // it from its last footing on. Absent for everything nobody has unchained,
  // which is nearly everything — see `Footing`.
  const since = new Map<PolygonId, ReadonlySet<VersionId>>();
  const frozen = new Map<PolygonId, ReadonlySet<VertexId>>();

  order.forEach((k, step) => {
    const version = world.versions[k];
    const outer = new Map<Id, Affine>();

    for (const [id, polygon] of world.polygons) {
      if (polygon.birth === k) {
        local.set(id, new Map());
        frame.set(id, IDENTITY);
        depth.set(id, 0);
        over.set(id, EMPTY_DEPTHS);
      }

      // Taken out by this version — its own removal, or that of a group holding
      // it, which is the same thing: see `removals`.
      //
      // After the birth rather than before: the walk is what says a polygon is
      // here at all, so dropping it here drops it from the rest of the walk
      // too, and whatever later layers still name it are inert rather than
      // wrong. They are left written for the reason `removeVertices` leaves a
      // displacement — a layer that moved something still moved it, at the
      // versions that still have it.
      if (taken.get(id)!.includes(k)) {
        local.delete(id);
        frame.delete(id);
        depth.delete(id);
        over.delete(id);
      }

      // Standing on its own numbers from here rather than on what the base
      // handed over. Where a birth would be, and for the same reason: this is
      // the version the thing begins at, as far as it is concerned. Only for
      // something that is here — a footing does not raise the dead, and it does
      // not bring a polygon forward past the version it is born into.
      const footing = version.footings.get(id);

      if (footing !== undefined && local.has(id)) {
        local.set(id, new Map(footing.local));
        frame.set(id, footing.frame);
        depth.set(id, footing.erosion);
        over.set(id, footing.depths);
        since.set(id, new Set(order.slice(step)));
        frozen.set(id, new Set(footing.local.keys()));
      }

      const at = local.get(id);

      if (at === undefined) continue;

      // Corners this version introduces take their resting place before its
      // own layer is applied, so that a layer can move a corner it just added.
      for (const corner of polygon.points) {
        if (corner.birth === k) at.set(corner.id, { ...corner.at });
      }

      const edit = version.edits.get(id);

      if (edit !== undefined) {
        displace(at, edit.vertices);
        frame.set(id, compose(affine(edit.transform), frame.get(id)!));
        depth.set(id, edit.transform.erosion);
        over.set(id, edit.depths);
      }

      // After its own, and whether or not it has one of its own: what moves a
      // polygon at this version is not only what the version says about it.
      const up = parentOf(world).get(id);

      if (up === undefined) continue;

      const m = outer.get(up) ?? held(world, version, id);

      outer.set(up, m);
      frame.set(id, compose(m, frame.get(id)!));
    }
  });

  const out: Resolved[] = [];

  for (const [id, at] of local) {
    const polygon = world.polygons.get(id)!;
    const from = since.get(id) ?? inherited;
    const kept = frozen.get(id);

    // Born into the stretch being listened to, or frozen into the footing at
    // the head of it — and either way gone if something in that stretch took it
    // out. Where there is no footing, `kept` is nothing and this is exactly
    // `standing`.
    const corners = surviving(
      polygon.points,
      c => (from.has(c.birth) || kept?.has(c.id) === true)
        && (c.death === null || !from.has(c.death)),
    );

    // A polygon whose outline has gone is not geometry any more. It cannot
    // happen through the editor, which will not take a ring below three, but
    // resolving is not the place to be sure of that.
    if (corners.length < 3) continue;

    const ring = corners.map(c => at.get(c.id) ?? { ...c.at });
    const erosion = depth.get(id) ?? 0;
    const mine = over.get(id) ?? EMPTY_DEPTHS;
    const m = frame.get(id)!;

    out.push(resolved({
      id,
      polygon,
      corners,
      local: ring,
      frame: m,
      source: place(m, ring),
      erosion,
      over: mine,
      depths: varying(corners, erosion, mine),
    }));
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
 * The depths are seeded from what it already resolved to, so that the first
 * thing written into a layer — a nudge, a move — does not also throw away the
 * erosion its base had. Both of them: the polygon's own, and the corners
 * offset apart from it.
 *
 * Hand it the `Resolved` wherever there is one, which is every polygon. A bare
 * number is for the things that have no ring and so no corners to have offset —
 * a group, an artefact — and for a caller stating a depth outright; it seeds no
 * corner depths, because there are none to seed it from.
 */
export function editAt(world: World, v: VersionId, id: Id, base: number | Resolved): Edit {
  const erosion = typeof base === 'number' ? base : base.erosion;
  const over = typeof base === 'number' ? EMPTY_DEPTHS : base.over ?? EMPTY_DEPTHS;

  return world.versions[v].edits.get(id)
    ?? {
      transform: { ...EMPTY_TRANSFORM, erosion },
      vertices: new Map(),
      depths: new Map(over),
    };
}

/**
 * What each of `ids` holds at version `v`, as the edit a gesture starts from.
 *
 * Every gesture recomputes from here rather than composing onto its own last
 * frame, so it cannot drift and letting go leaves exactly what is on screen.
 *
 * Keyed by what was picked rather than by what is drawn: picking a group
 * writes one transform to the group, not one to each of its members, and that
 * is the whole of what a group is for.
 *
 * Two readers, because there are two kinds of thing here and neither knows
 * about the other. `resolveAt` answers for polygons, having geometry to answer
 * with; a group's depth is only ever a number on a layer, and `depths` is what
 * walks the chain for it. Asking the polygon reader about a group gets nothing
 * back, and then the first thing written into a later version — a turn, a
 * nudge — throws away the erosion its base had.
 */
export function starting(world: World, v: VersionId, ids: readonly Id[]): Map<Id, Edit> {
  const mine = new Map<Id, Resolved>(resolveAt(world, v).map(it => [it.id, it]));
  const theirs = depths(world, v);

  return new Map(
    ids
      .filter(id =>
        world.polygons.has(id)
        || world.groups.has(id)
        || world.artefacts.has(id)
        || world.paths.has(id),
      )
      // An artefact has no depth of its own and inherits nobody's: erosion is
      // the one part of a transform that means nothing to a point, and reading
      // its group's depth onto it would write a number nothing would ever
      // take back off. A path is a run of points and answers the same way.
      .map(id => [
        id,
        editAt(
          world,
          v,
          id,
          world.artefacts.has(id) || world.paths.has(id)
            ? 0
            : mine.get(id) ?? theirs.get(id) ?? 0,
        ),
      ]),
  );
}

/**
 * Seal a group, or let it loose again.
 *
 * The gesture behind the two kinds of group. Not a layer and not versioned:
 * which of the two a group is, it is over the whole chain, because a group
 * that were one thing at v0 and another at v4 would change what the boundary
 * is *made of* half way along — the same reason a group's standing is settled
 * for a whole span rather than asked at each instant.
 *
 * Eroding a loose group does not do this. A depth is an offset of a union and
 * a loose group has none, so the gesture is refused rather than granted by
 * quietly turning the group into something else — see `erodible`.
 */
export function sealing(world: World, id: GroupId, sealed: boolean): World {
  const group = world.groups.get(id);

  if (group === undefined || group.sealed === sealed) return world;

  const groups = new Map(world.groups);

  groups.set(id, { ...group, sealed });

  return { ...world, groups };
}

export function withEdit(world: World, v: VersionId, id: Id, edit: Edit): World {
  const was = world.versions[v].edits.get(id)?.transform ?? EMPTY_TRANSFORM;
  const versions = [...world.versions];
  const edits = new Map(versions[v].edits);

  edits.set(id, edit);
  versions[v] = { ...versions[v], edits };

  return carried({ ...world, versions }, v, id, was, edit.transform);
}

/**
 * Whether two transforms differ in where a thing is and in nothing else.
 *
 * The compensation below is derived for a translation and is right for
 * nothing else, so it asks rather than assuming. Which costs nothing in
 * practice: a gesture writes one kind of transform at a time — `t` moves, `r`
 * turns, `s` scales — so a drag that moves something changes this and only
 * this.
 */
function onlyMoved(was: Transform, now: Transform): boolean {
  return was.rotation === now.rotation
    && was.scale.x === now.scale.x
    && was.scale.y === now.scale.y
    && was.erosion === now.erosion
    && (was.translation.x !== now.translation.x || was.translation.y !== now.translation.y);
}

/**
 * Moving something at one version, carried through the versions after it.
 *
 * A version's layer applies on top of everything before it, so a rotation at
 * v1 acts on v0's translation as much as on the geometry: drag a room right at
 * v0 with a quarter turn on it at v1 and it goes *up* at v1. That is what
 * composing layers means and it is not a mistake in the composition, but it is
 * not what anybody drags for. What the hand said was "this is a hundred units
 * further right", and every version it reaches should hear the same sentence.
 *
 * The frame at a later version is `L . D . Mv`, where `D` is the displacement
 * the drag made and `L` is everything the later versions add over the top. The
 * wanted frame is `D . L . Mv`, and the two agree exactly when `L` is replaced
 * by `D L D-inverse` — so each later layer is conjugated by the displacement.
 * For a layer `T . R . S` and a translation `D` that is
 *
 *   T' = T + d - RS(d)
 *
 * which touches the translation and nothing else, so it stays inside
 * `Transform` and no shear can appear. A layer with no turn and no scale in it
 * has `RS(d) = d` and is left exactly as it was, which is most of them.
 *
 * What gets conjugated is every later layer of the thing moved *and of
 * everything inside it*, because those are the layers composing over the top of
 * this one. Nothing outside it is touched: moving a polygon inside a group that
 * turns at a later version leaves the group's turn alone, and the polygon rides
 * it. A thing attached to something that turns turning with it is not the
 * surprise — a thing re-aiming its own earlier drag is.
 *
 * It stops at a footing, which is the one thing that says *ignore what the base
 * handed over*. The displacement does not reach past one, so there is nothing
 * there to compensate for.
 *
 * This is the one place that writes into a version other than the one being
 * edited, and it is worth saying why that is allowed here. Inheritance is the
 * whole design and rewriting downstream is what `Footing` exists to avoid — but
 * what is written here is what those layers already meant. A turn at v1 means
 * *this room, turned*; it went on meaning that, and the numbers are what
 * changed under it.
 */
function carried(world: World, v: VersionId, id: Id, was: Transform, now: Transform): World {
  if (!onlyMoved(was, now)) return world;

  const step = {
    x: now.translation.x - was.translation.x,
    y: now.translation.y - was.translation.y,
  };

  // Into world units. A layer's own translation is read in the frame its groups
  // make at that version — see `under` — and the displacement has to be in the
  // space the later layers compose in, which is the world.
  const h = held(world, world.versions[v], id);
  const d = {
    x: h.a * step.x + h.c * step.y,
    y: h.b * step.x + h.d * step.y,
  };

  const mine = new Set(within(world, id));
  const versions = [...world.versions];
  const done = new Set<Id>();

  let touched = false;

  for (let k = v + 1; k < versions.length; k++) {
    // Only the versions this one is actually upstream of. Membership rather
    // than `k > v`, for the reason `standing` gives: versions happen to be
    // numbered in order today and forks would end that.
    if (!chain(world, k).includes(v)) continue;

    let edits: Map<Id, Edit> | null = null;

    for (const t of mine) {
      // Past a footing the base is not what this stands on, so the move never
      // reached here and there is nothing to take back out.
      if (done.has(t)) continue;
      if (versions[k].footings.has(t)) {
        done.add(t);
        continue;
      }

      const layer = versions[k].edits.get(t);

      if (layer === undefined) continue;

      const m = affine({ ...layer.transform, translation: { x: 0, y: 0 } });
      const turned = { x: m.a * d.x + m.c * d.y, y: m.b * d.x + m.d * d.y };

      // No turn and no scale, so the layer carries the move unchanged and has
      // nothing to say about it.
      if (turned.x === d.x && turned.y === d.y) continue;

      edits ??= new Map(versions[k].edits);
      edits.set(t, {
        ...layer,
        transform: {
          ...layer.transform,
          translation: {
            x: layer.transform.translation.x + d.x - turned.x,
            y: layer.transform.translation.y + d.y - turned.y,
          },
        },
      });
    }

    if (edits !== null) {
      versions[k] = { ...versions[k], edits };
      touched = true;
    }
  }

  return touched ? { ...world, versions } : world;
}

// -----------------------------------------------------------------------------
// Unchaining
//
// Everything above this line is about inheritance: a version is a layer over
// its base, an edit at v0 is seen at v8, and that is what the document is for.
// This is the one thing that says no to it, for one thing at a time.
//
// An unchained polygon keeps its id, its corners, its groups and every layer
// ever written about it. What it stops keeping is its base's answer: at the
// version it was unchained in, the state the chain would have handed over is
// replaced by a copy of what that state *was* at the moment of unchaining, and
// the walk carries on from there. So it looks identical the second after, and
// stays where it is when v0 is dragged the day after.
//
// Why a copy and not an inverse
// -----------------------------
// The obvious reading of "cut it loose here" is to write the inverse of
// everything upstream into this version's layer, so the two cancel. They do —
// once. Edit the upstream transform and the inverse no longer inverts it, and
// the change comes through as the difference between them, which is worse than
// it coming through whole. And a transform has no inverse for the parts of the
// chain that are not transforms: a corner an upstream layer nudges, a corner it
// deletes, a corner it adds, a depth it states. All of those flow down too, and
// all of them have to stop.
//
// So what is written down is the state, and `Footing` is the shape of it: the
// composed frame, where each corner stood, which corners there were, and the
// depths. Exactly the accumulators `resolveAt` carries, which is not a
// coincidence — the whole trick is that a footing is what a base hands over,
// said outright instead of computed.
//
// Rechaining
// ----------
// Delete the footing. The thing becomes derived again and jumps to wherever the
// chain says it now is — which may be nowhere near where it was sitting, if the
// upstream it stopped listening to has moved on since. That is the answer, and
// it is a coherent one: unchaining suppresses the inheritance rather than
// destroying it, so rechaining restores something that was true all along
// rather than reconstructing something that was lost. Nothing is inverted and
// nothing is guessed at.
//
// Which is why unchaining is not an identity-breaking operation here, and does
// not have to be. Breaking identity — copy the geometry into a new polygon born
// at this version, kill the old one — would give the same picture and would
// give up the id, the corner ids, the group membership, the layers downstream
// and any hope of undoing it as anything but an undo.
//
// What is *not* unchained
// -----------------------
// Existence. A polygon deleted at v1 is gone at v6 whether or not it was
// unchained at v4, and one drawn at v1 is not around before it. Birth and death
// are one fact about a thing rather than something a layer hands down — see
// `standing` — and a thing that outlived its own deletion in one stretch of the
// chain would be two things wearing one id. Deleting upstream is how something
// stops existing, and it still is.
//
// Groups go down to their members, always. A group is a frame and a union of
// what its members resolve to, so unchaining the frame alone would leave every
// upstream nudge inside it still coming through, which is not what anybody
// meant by unchaining the group.
// -----------------------------------------------------------------------------

/** Whether `v`'s layer unchains `id`: whether there is a footing here. */
export function unchainedAt(world: World, v: VersionId, id: Id): boolean {
  return world.versions[v].footings.has(id);
}

/**
 * Whether unchaining `ids` at `v` would say anything.
 *
 * The gesture is offered for a selection where any of it is — one already
 * unchained here beside one that is not is not a reason to refuse.
 */
export function unchainable(world: World, v: VersionId, ids: readonly Id[]): boolean {
  return reaches(world, v, ids).some(id => !unchainedAt(world, v, id));
}

/** Whether rechaining `ids` at `v` would say anything. */
export function rechainable(world: World, v: VersionId, ids: readonly Id[]): boolean {
  return reaches(world, v, ids).some(id => unchainedAt(world, v, id));
}

/**
 * Everything under `ids` that a footing at `v` could be about: standing here,
 * standing at the base, and not the version it was born into.
 *
 * Born here is left out because there is nothing to unchain — a thing born at
 * `v` already stands on this version and hears nothing from before it. Writing
 * a footing for one would be a copy of an empty state, which is what it has.
 */
function reaches(world: World, v: VersionId, ids: readonly Id[]): Id[] {
  const base = world.versions[v].base;

  if (base === null) return [];

  const here = new Set(chain(world, v));
  const there = new Set(chain(world, base));
  const out: Id[] = [];

  for (const id of ids) {
    for (const m of within(world, id)) {
      if (!out.includes(m) && standingIn(world, m, here) && standingIn(world, m, there)) {
        out.push(m);
      }
    }
  }

  return out;
}

/**
 * `ids` cut loose from everything before `v`, and everything under them.
 *
 * What each one resolved to at the base is copied into `v`'s layer as a
 * footing, so nothing moves: the same numbers are now stated rather than
 * inherited. From here on an edit upstream is invisible to them, and an edit
 * here or later reads exactly as it did.
 *
 * The world unchanged where there is nothing to say — at the root version,
 * which has no base to stop listening to, and for a selection every part of
 * which is already unchained here.
 */
export function unchained(world: World, v: VersionId, ids: readonly Id[]): World {
  const base = world.versions[v].base;
  const going = reaches(world, v, ids).filter(id => !unchainedAt(world, v, id));

  if (base === null || going.length === 0) return world;

  // What the base resolved to, read once for the whole gesture. Three readers,
  // because there are three kinds of thing here and the geometry is only one of
  // them: a group's depth is a number on a layer rather than something a ring
  // was eroded by, and an artefact is a point with no depth at all.
  const mine = new Map(resolveAt(world, base).map(it => [it.id, it]));
  const theirs = depths(world, base);

  const footings = new Map(world.versions[v].footings);

  for (const id of going) {
    const it = mine.get(id);

    footings.set(id, it === undefined
      ? {
          frame: groupFrame(world, base, id),
          local: new Map(),
          erosion: world.groups.has(id) ? theirs.get(id) ?? 0 : 0,
          depths: new Map(),
        }
      : {
          frame: it.frame,
          local: new Map(it.corners.map((c, i) => [c.id, it.local[i]])),
          erosion: it.erosion,
          depths: new Map(it.over ?? []),
        });
  }

  return withFootings(world, v, footings);
}

/**
 * `ids` chained back up at `v`: the footings written there taken out again, and
 * everything under them.
 *
 * Only the ones at `v`. A thing unchained twice, at v2 and at v6, is chained
 * back up one point at a time, standing where the point is — which is the only
 * reading that lets the two be undone separately, and the only one where doing
 * this at a version that never unchained anything does nothing at all.
 *
 * What comes back is what the chain says now, which is not necessarily what it
 * said when the footing was written. That is the whole of what was being
 * suppressed, arriving.
 */
export function rechained(world: World, v: VersionId, ids: readonly Id[]): World {
  const going = reaches(world, v, ids).filter(id => unchainedAt(world, v, id));

  if (going.length === 0) return world;

  const footings = new Map(world.versions[v].footings);

  for (const id of going) footings.delete(id);

  return withFootings(world, v, footings);
}

function withFootings(world: World, v: VersionId, footings: Map<Id, Footing>): World {
  const versions = [...world.versions];

  versions[v] = { ...versions[v], footings };

  return { ...world, versions };
}

// -----------------------------------------------------------------------------
// Grouping
//
// Structure is global and the transform is versioned, so making a group is a
// change to the world and moving one is a change to a layer. What that costs is
// all at the other end: taking a group apart has to leave its members where
// they are *at every version*, and there is no single transform to bake in,
// because the group's own differs from one version to the next.
// -----------------------------------------------------------------------------

/**
 * `outer` after `inner` as one layer, or nothing where that is not a layer.
 *
 * A `Transform` is components rather than a matrix — a turn, a scale per axis,
 * a move — and that family is not closed under composition: turn, squash and
 * turn again is a shear, and no combination of the three says shear. Nothing in
 * the chain ever needed it to be closed, because nothing composes; taking a
 * group apart is the one operation that does.
 *
 * So this answers where it can and refuses where it cannot, and the refusal is
 * the honest one: what the author is asking for is not something the document
 * can hold.
 */
export function composed(outer: Transform, inner: Transform): Transform | null {
  const m = compose(affine(outer), affine(inner));

  // `affine` builds `R(rotation) · diag(scale)`, so the first column is the
  // turn at the length of one axis and the second is what is left.
  const rotation = Math.atan2(m.b, m.a);
  const cos = Math.cos(rotation), sin = Math.sin(rotation);

  const x = Math.hypot(m.a, m.b);
  const y = m.d * cos - m.c * sin;

  // Whatever of the second column lies along the first. Zero for anything this
  // family can say, and a shear otherwise.
  const skew = m.c * cos + m.d * sin;

  if (Math.abs(skew) > 1e-9 * Math.max(1, Math.abs(x), Math.abs(y))) return null;

  return {
    translation: { x: m.tx, y: m.ty },
    rotation,
    scale: { x, y },

    // Depths never transfer. A polygon owns one, membership does not touch it,
    // and a group's is the group's — which is the only rule under which
    // leaving and rejoining is the identity.
    erosion: inner.erosion,
  };
}

/**
 * A new group over `ids`, born into the version on screen.
 *
 * Only what is not already held: grouping something with a thing it is already
 * inside means grouping what holds it, and grouping a group with its own member
 * is not a structure — it is the same member twice. Drilled into a group and
 * picking everything in it is the same refusal wearing a different hat.
 *
 * Nothing is compensated. A new group's transform is identity at every version,
 * so its members are exactly where they were, which is the whole reason making
 * one is cheap and taking one apart is not.
 */
export function grouped(
  world: World,
  v: VersionId,
  ids: readonly Id[],
  where: Landing,
): { world: World, id: GroupId } | null {
  // What each of them is picked *as*, which inside an open group is the member
  // itself rather than the group standing over the whole thing. Grouping two
  // members while drilled in makes a group in there, holding those two.
  const into = where.into;
  const path = opened(world, into);
  const tops = [...new Set(ids.map(id => reaching(world, id, path)))];

  if (tops.length < 2) return null;

  const held = new Set<Id>(tops);
  const parent = into === null ? undefined : world.groups.get(into);

  // Nor is a group holding exactly what the open group already holds: it is a
  // level of nesting that says nothing, and one the author then has to get
  // through twice to reach anything. Out at the top level the same refusal
  // falls out of the count — everything picked inside a group reaches that
  // group, and one thing is not a group — and drilled into it, it has to be
  // said outright.
  if (parent !== undefined && parent.members.every(m => held.has(m))) return null;

  const id = world.nextId;
  const groups = new Map(world.groups);

  groups.set(id, { birth: v, death: null, members: tops, sealed: false });

  // Taken out of wherever they were, so nothing is claimed twice: the members
  // belong to the new group now, and the new group belongs where they were.
  if (into !== null && parent !== undefined) {
    groups.set(into, { ...parent, members: parent.members.filter(m => !held.has(m)) });
  }

  return {
    world: joined({ ...world, groups, nextId: id + 1 }, into, [id]),
    id,
  };
}

/**
 * A group taken apart, with its members left exactly where they stood at every
 * version.
 *
 * The group's transform differs per version, so there is no one transform to
 * bake into the members: baking the version on screen would hold them still
 * where the author is standing and shift them everywhere else. So every version
 * that says anything about the group writes it into every member instead, as
 * one change.
 *
 * Nothing where a version cannot hold the composition — see `composed`. It is
 * refused whole rather than in part: half an ungroup would leave the members
 * displaced at the versions it could not do, which is worse than not having
 * done it.
 *
 * A group that is taken out at a version passes that on too, the same way it
 * passes on its transform: the members died with it, and letting them outlive
 * the thing whose removal took them would be an ungroup that brought rooms
 * back. The earlier of the two, since a member may already have gone first.
 */
export function ungrouped(world: World, id: GroupId): World | null {
  const group = world.groups.get(id);

  if (group === undefined) return null;

  const versions = [...world.versions];

  for (let k = 0; k < versions.length; k++) {
    const mine = versions[k].edits.get(id);

    if (mine === undefined) continue;

    const edits = new Map(versions[k].edits);

    for (const member of group.members) {
      const was = edits.get(member)
        ?? { transform: EMPTY_TRANSFORM, vertices: new Map(), depths: new Map() };
      const now = composed(mine.transform, was.transform);

      if (now === null) return null;

      edits.set(member, { ...was, transform: now });
    }

    edits.delete(id);
    versions[k] = { ...versions[k], edits };
  }

  const groups = new Map(world.groups);
  const polygons = new Map(world.polygons);
  const artefacts = new Map(world.artefacts);
  const paths = new Map(world.paths);
  const up = parentOf(world).get(id);

  if (group.death !== null) {
    for (const member of group.members) {
      const maps = [groups, polygons, artefacts, paths] as Map<Id, { death: VersionId | null }>[];

      for (const map of maps) {
        const it = map.get(member);

        if (it === undefined) continue;

        map.set(member, {
          ...it,
          death: it.death === null ? group.death : Math.min(it.death, group.death),
        });
      }
    }
  }

  groups.delete(id);

  // The members take the group's place rather than being appended, so what a
  // click walks through stays in the order it was drawn in.
  if (up !== undefined) {
    const holder = groups.get(up)!;

    groups.set(up, {
      ...holder,
      members: holder.members.flatMap(m => (m === id ? group.members : [m])),
    });
  }

  return { ...world, groups, polygons, artefacts, paths, versions };
}

/**
 * The structure with `gone` taken out of it.
 *
 * A group that ends up holding one thing or nothing is not holding anything
 * together, so it goes too — and its own holder loses it in turn, which is why
 * this settles rather than passing once.
 */
export function without(world: World, gone: ReadonlySet<Id>): World {
  const groups = new Map(world.groups);

  while (true) {
    const empty = new Set<GroupId>();

    for (const [id, group] of groups) {
      const members = group.members.filter(m => !gone.has(m) && !empty.has(m));

      if (members.length !== group.members.length) groups.set(id, { ...group, members });
      if (members.length < 2) empty.add(id);
    }

    if (empty.size === 0) break;

    for (const id of empty) groups.delete(id);

    gone = empty;
  }

  return { ...world, groups };
}

/** `ids` and everything under them, with the groups left out: what a gesture
 * over a selection actually reaches. */
export function polygonsIn(world: World, ids: readonly Id[]): PolygonId[] {
  const out = new Set<PolygonId>();

  for (const id of ids) {
    for (const m of within(world, id)) {
      if (world.polygons.has(m)) out.add(m);
    }
  }

  return [...out];
}

/**
 * The polygons a retype is allowed to reach.
 *
 * `polygonsIn` with one stop in it: a sealed group is a set of its own, and
 * what it resolves to is `level - (solid - void)` over the members it has.
 * Retyping through one would rewrite that rule from outside the scope that
 * states it — the handle says *this shape*, not *these parts of it* — so the
 * descent stops at a sealed group and its members keep their kinds. A loose
 * group is only a handle round polygons that are in the set on their own
 * account, so it passes the retype straight through.
 *
 * A polygon named in its own right is always reached, sealed group around it
 * or not: command-click picked that one polygon, and what is picked is what
 * the next gesture acts on.
 */
export function retypable(world: World, ids: readonly Id[]): PolygonId[] {
  const out = new Set<PolygonId>();

  const descend = (id: Id): void => {
    const group = world.groups.get(id);

    if (group === undefined) {
      if (world.polygons.has(id)) out.add(id);

      return;
    }

    if (!group.sealed) group.members.forEach(descend);
  };

  for (const id of ids) descend(id);

  return [...out];
}

/** Every kind among `ids`, deduplicated. One entry says the selection agrees
 * about what it is; more than one is what the type buttons draw as mixed. */
export function kindsOf(world: World, ids: readonly PolygonId[]): PolygonKind[] {
  const out = new Map<string, PolygonKind>();

  for (const id of ids) {
    const p = world.polygons.get(id);

    if (p !== undefined) out.set(kindKey(p), kindOf(p));
  }

  return [...out.values()];
}

/** `ids` made `kind`, and nothing else touched. */
export function retypedPolygons(
  world: World,
  ids: readonly PolygonId[],
  kind: PolygonKind,
): World {
  const polygons = new Map(world.polygons);

  for (const id of ids) {
    const p = world.polygons.get(id);

    if (p !== undefined) polygons.set(id, { ...p, ...kind });
  }

  return { ...world, polygons };
}

/** The same, for artefacts: what a gesture over a selection actually moves,
 * including the ones inside a group it names. */
export function artefactsIn(world: World, ids: readonly Id[]): ArtefactId[] {
  const out = new Set<ArtefactId>();

  for (const id of ids) {
    for (const m of within(world, id)) {
      if (world.artefacts.has(m)) out.add(m);
    }
  }

  return [...out];
}

/** The same again, for paths: the tapes a gesture over a selection carries
 * along, including the ones inside a group it names. */
export function pathsIn(world: World, ids: readonly Id[]): PathId[] {
  const out = new Set<PathId>();

  for (const id of ids) {
    for (const m of within(world, id)) {
      if (world.paths.has(m)) out.add(m);
    }
  }

  return [...out];
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
  const id = it.corners[index].id;
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

/**
 * The named corners taken `by` deeper than the polygon they are in, or shallower
 * where `by` is negative.
 *
 * Against the layer rather than against nothing, so a drag composes with what
 * the version already held — and `starting` seeded that from what the base
 * resolved to, so the first drag in a fresh version starts where the shape on
 * screen is rather than at nought.
 *
 * A corner that comes back to the depth of its polygon is taken out of the map
 * instead of being written as nought. What is left is the same offset either
 * way, but only an empty map says *nothing here is offset*, which is what puts
 * the polygon back on the road `erode` has always taken. See `varying`.
 */
export function deepen(
  edit: Edit,
  polygon: Polygon,
  corners: ReadonlySet<VertexId>,
  by: number,
): Edit {
  const depths = new Map(edit.depths);

  for (const corner of polygon.points) {
    if (!corners.has(corner.id)) continue;

    const d = (edit.depths.get(corner.id) ?? 0) + by;

    if (d === 0) depths.delete(corner.id);
    else depths.set(corner.id, d);
  }

  return { ...edit, depths };
}

/** Which polygons the picked corners belong to. A depth is written into the
 * layer of the thing that has a ring, and a corner is not one. */
export function owning(world: World, corners: ReadonlySet<VertexId>): PolygonId[] {
  const out: PolygonId[] = [];

  for (const [id, polygon] of world.polygons) {
    if (polygon.points.some(c => corners.has(c.id))) out.push(id);
  }

  return out;
}

// -----------------------------------------------------------------------------
// Reading the result
// -----------------------------------------------------------------------------

/**
 * What the CSG is actually handed: a polygon, or the projection an eroding
 * group takes over what its members produced.
 *
 * Separate from `Resolved` because a group has none of what a `Resolved`
 * is — no source ring, no corners, nothing to put a handle on. What it has is
 * a shape, which is all this end of the pipe ever wanted.
 */
export interface Contributed {
  id: Id
  /** Which set it goes into, and which way. A group contributes one of these
   * per side it has anything on. */
  kind: PolygonKind
  shape: Shape
  /**
   * The frame the shape is placed by, which is what the bake keeps its points
   * in so that a turn is a turn rather than a chord.
   *
   * The identity for a group. Its members' frames already carry its transform —
   * that is what `held` does — so the union comes out in world units with the
   * motion in it, and a group that applied its own layer again would apply it
   * twice.
   */
  frame: Affine
  /** Whether the shape is already an arrangement and `simplify` may be
   * skipped. A projection is one by construction. */
  simple: boolean
  /** The bake's invented corners, carried through the arrangement. A group's
   * union has none: nothing invents a corner on it. See `Resolved.keep`. */
  keep?: readonly Point[]
}

/**
 * Every polygon's depth, and every group's, as version `v` leaves it.
 *
 * Inherited down the chain exactly as a polygon's is: a version that says
 * nothing about a group leaves its depth where its base had it.
 *
 * A group that is not there at `v` has no depth, whatever a layer written
 * before it was taken out still says. Nothing reaches its members either — they
 * went with it — so this is about the ghost rather than about the geometry, and
 * a ghost with a depth is one more thing for a reader to have to rule out.
 */
export function depths(world: World, v: VersionId): Map<Id, number> {
  const inherited = new Set(chain(world, v));
  const out = new Map<Id, number>();

  for (const k of inherited) {
    // Footings first, then this version's own layer over them: the same order
    // the chain applies them in everywhere else.
    for (const [id, footing] of world.versions[k].footings) {
      if (world.groups.has(id) && standingIn(world, id, inherited)) {
        out.set(id, footing.erosion);
      }
    }

    for (const [id, edit] of world.versions[k].edits) {
      if (world.groups.has(id) && standingIn(world, id, inherited)) {
        out.set(id, edit.transform.erosion);
      }
    }
  }

  return out;
}

/**
 * The resolved polygons as the CSG should see them: a group with a depth on it
 * standing in for its members, and everything else passed straight through.
 *
 * A group erodes **as if it were one polygon** — union the members, offset that
 * boundary inward — rather than each member being offset on its own. Two
 * rectangles making a corridor, each eroded by `d`, both pull back lengthwise
 * at the join and the corridor breaks in two; eroding the union pulls back only
 * the outer boundary and the corridor stays put. The author cannot see the seam
 * that failed, because it is interior geometry behind a wall that still looks
 * right, which is what makes it unacceptable rather than approximate.
 *
 * A group at depth zero contributes nothing of its own and hands its members
 * over one by one. That is not a special case for speed — the union of a set is
 * what the CSG does with them anyway — but it is what keeps an edit inside an
 * unerroded group as cheap as an edit outside one.
 *
 * The two kinds are unioned apart. A group holding a room and a pillar is one
 * group, but the room's boundary and the pillar's are not one boundary, and
 * there is no shape that is the union of a thing and a hole in it.
 */
export function contributing(
  world: World,
  v: VersionId,
  items: readonly Resolved[],
): Contributed[] {
  const depth = depths(world, v);

  // Every sealed group stands, whether or not it is eroding: a scope is a scope
  // at depth zero as much as at any other, and what its solids and voids cut
  // they cut inside it either way.
  //
  // A loose one is not here at all, `contributed` having walked past it to its
  // members. It used to be the depth that decided this — a group with none was
  // taken to be doing nothing — which asked erosion to stand for a question it
  // is not about. Sealing is that question, asked outright.
  return contributed(world, items, id => ({ depth: depth.get(id) ?? 0 }));
}

/**
 * What a group does where it is being read.
 *
 * `null` is transparent: it contributes nothing of its own and hands its
 * members over one by one. Anything else means it stands for them, and then
 * `depth` is how far its union is offset — which may be zero, and that is not
 * the same as being transparent. A depth arriving over a span is zero at one
 * end of it, and a group that stopped standing for its members at that end
 * would change what the boundary is *made of* half way through a stretch,
 * which no interpolation describes.
 */
/** The kinds a group can contribute as, in the order `sideOf` numbers them.
 * The first keeps the group's own id; the rest are given one. */
const SIDES: readonly PolygonKind[] = KINDS;

/**
 * The id one side of a group goes by.
 *
 * A group holding a room and a pillar contributes as both a level and a solid,
 * and one id names one contributor: the two unions have different boundaries,
 * take different tracks, and are told apart everywhere downstream by nothing
 * but this number. Its floor and its voids are more of them again, and for the
 * same reason.
 *
 * So every side but the first gets an id of its own, and the first keeps the
 * group's. Negative, because ids come from a counter that only counts up, so
 * nothing authored can ever collide with one — and reversible, so what it
 * belongs to can always be read back.
 */
export function sideOf(id: Id, kind: PolygonKind): Id {
  const at = SIDES.findIndex(k => sameKind(k, kind));

  return at <= 0 ? id : -(id * SIDES.length + at);
}

/** Whose side that is, or nothing where the id is an ordinary one. */
export function sidedWith(id: Id): Id | null {
  return id < 0 ? Math.floor(-id / SIDES.length) : null;
}

/**
 * One kind as the parts it plays, one per set it takes part in, each narrowed
 * to that set.
 *
 * All but one kind is in a single set and comes back as itself. The exception
 * is a void cutting the solids and the floors at once, which is two members of
 * two sets that happen to have been drawn once — and everything downstream is
 * built on a contributor belonging to one set, because for every other kind
 * that is simply true. So the split happens here, where the contribution is
 * made, rather than being carried the whole way down.
 *
 * The first part keeps the thing's own id; a second is minted by `sideOf` the
 * way a group's sides are. Which means only the floor half of a void that cuts
 * both is ever renamed, and a polygon's own id still names the polygon
 * everywhere it did before.
 */
export function parts(kind: PolygonKind): PolygonKind[] {
  return kind.type === 'void' && kind.from === (SOLID | FLOOR)
    ? [{ type: 'void', from: SOLID }, { type: 'void', from: FLOOR }]
    : [kind];
}

/**
 * One set from its slots, the rule worked from the inside out.
 *
 * `level - (solid - void)`, `floor - void`: each slot has the one below it
 * taken out of it, and the answer is the outermost. The pointwise version of
 * the same rule is `inside` in the game's `world.ts`, and the two have to
 * agree — this is what the shapes say and that is what a point query says.
 */
export function settled(slots: readonly Shape[]): Shape {
  let out = slots[slots.length - 1];

  for (let k = slots.length - 2; k >= 0; k--) {
    out = out.length === 0 || slots[k].length === 0 ? slots[k] : subtract(slots[k], out);
  }

  return out;
}

/**
 * A scope's floor, cut to the level that scope makes.
 *
 * The whole of what sealing does to a floor, in one place because two things
 * do it: the reader that hands the floor to the CSG and to the drawing, and
 * the gesture that bakes a scope into polygons. Two cuts that could disagree
 * would be a floor drawn in one place and shipped in another.
 *
 * A scope with no level keeps its floor whole. There is nothing there for the
 * clip to mean, and clipping to an outline that is not there would resolve the
 * floor out of existence — which is a group of nothing but floors vanishing.
 *
 * And a floor already inside its walls keeps its floor whole too, because there
 * the clip *is* the identity and the intersect would hand back the shape it was
 * given. That is the ordinary case — a room with ground laid in it — and it is
 * the case the bake pays for over and over: this runs at every instant the cut
 * evaluates, and every one of them would otherwise be an arrangement built to
 * discover that nothing crosses. `encloses` asks that question directly and
 * says no where it cannot tell, so what is left to the boolean is the floors
 * that really do run past the walls, and the ones drawn flush against them.
 */
export function underfoot(floor: Shape, level: Shape): Shape {
  if (floor.length === 0 || level.length === 0) return floor;

  return encloses(level, floor) ? floor : intersect(floor, level);
}

export interface Standing {
  depth: number
  /**
   * The frame to keep the union's points in.
   *
   * The identity, or nothing, says world units — which is what anything
   * drawing them wants and what anything interpolating them does not. See
   * `groupFrame`.
   */
  frame?: Affine
}

/**
 * The same, with what each group is doing asked for rather than read off a
 * version.
 *
 * The bake wants the depths part way between two versions, where a depth being
 * scrubbed on is a number in flight like any other — and it wants which groups
 * stand for their members settled for the whole span rather than per instant.
 *
 * Only what `items` reaches: the walk starts at what it was given and goes up,
 * so handing it a neighbourhood rather than the world gives that
 * neighbourhood's contributors, which is what a track is cut against.
 */
/**
 * The union of `shapes`, offset by `depth`: what one slot of a scope comes to.
 *
 * Remembered, because a group with erosion on it is two arrangements per slot
 * and the drawing asks afresh every frame — once for the version being edited
 * and once more for every ghost on screen, about groups the hand is nowhere
 * near. See `remembered`.
 */
const offsetUnion = remembered((shapes: readonly Shape[], depth: number): Shape => {
  const all = unionAll(shapes);

  return depth === 0 || all.length === 0 ? all : erode(all, depth);
});

export function contributed(
  world: World,
  items: readonly Resolved[],
  standing: (id: GroupId) => Standing | null,
  /**
   * Where the group projections are kept, if the caller wants them kept.
   *
   * A group's offset union is a full arrangement, and the bake asks for the
   * same one over and over: every track whose neighbourhood the group falls
   * into needs it, at whatever instant that track is looking at. The caller
   * owns the map because only the caller knows what makes two asks the same
   * ask — for the bake, the same instant.
   */
  held?: Map<string, Shape>,
): Contributed[] {
  const mine = new Map(items.map(it => [it.id as Id, it]));
  const out: Contributed[] = [];

  /** What one member offers of a kind, projected if it is an eroding group. */
  /**
   * What one member puts into slot `k` of `set`, in the scope that is asking.
   *
   * A polygon puts its shape into the one slot its kind names. A group that
   * stands puts in what it *resolved to*, at the slot its own kind names —
   * whatever cut inside it was spent inside it, so what arrives here is a
   * shape with a part to play and nothing else, exactly like a polygon's. A
   * group that is open has no scope of its own for the moment and hands its
   * members up into this one.
   */
  const from = (id: Id, set: SetName, k: number): Shape[] => {
    const it = mine.get(id);

    if (it !== undefined) {
      return slotOf(kindOf(it.polygon), set) === k ? [it.shape] : [];
    }

    const group = world.groups.get(id);

    if (group === undefined) return [];

    // A sealed scope puts in one shape, in the first slot: whatever cut inside
    // it was spent inside it, so what arrives is a level or a floor and nothing
    // that cuts. A loose group, or one standing open, has no scope of its own
    // and hands its members up into this one.
    if (group.sealed && standing(id) !== null) {
      return k === 0 ? [resolves(id, set)] : [];
    }

    return group.members.flatMap(m => from(m, set, k));
  };

  /** One slot of one scope, offset by that scope's own depth the way the
   * slot's place in the rule means. */
  const slotted = (id: Id, set: SetName, k: number): Shape => {
    const group = world.groups.get(id);

    if (group === undefined) return [];

    const d = standing(id)?.depth ?? 0;

    // What is taken away goes the other way, and this is not a choice — it is
    // what eroding the scope as one shape *means*: eroding a complement is
    // dilating, so the sign alternates with how deeply a slot is nested. See
    // `inverted` in the game's `world.ts` for the identity.
    //
    // The slots are eroded apart and folded after, which is what lets them come
    // out as though they had been eroded together. A pillar shrunk along with
    // its room leaves a gap that never narrows.
    const depth = inverted(SLOT_KINDS[set][k]) ? -d : d;

    return offsetUnion(group.members.flatMap(m => from(m, set, k)), depth);
  };

  /**
   * What one scope puts into `set`: its slots folded by the rule, and, for the
   * floor, clipped to what the same scope puts into the level.
   *
   * The clip is what makes a group a scope rather than a bag. A floor running
   * out past the walls it belongs to is floor laid where the group is not, and
   * it was only ever invisible because a wall stood in front of it. This is the
   * same `(floor - void) and (level - (solid - void))` that resolving a group
   * has always produced — see the header of `resolve.ts` — now taken without
   * the group having to be destroyed to get it.
   *
   * A scope with no level keeps its floor whole. There is nothing there for the
   * clip to mean, and clipping to an outline that is not there would resolve
   * the floor out of existence.
   */
  const resolves = (id: Id, set: SetName): Shape => {
    const key = `${id}:${set}`;
    const known = held?.get(key);

    if (known !== undefined) return known;

    const slots: Shape[] = [];

    for (let k = 0; k < SLOTS[set]; k++) slots.push(slotted(id, set, k));

    const out = set === 'floor'
      ? underfoot(settled(slots), resolves(id, 'level'))
      : settled(slots);

    held?.set(key, out);

    return out;
  };

  const emit = (id: Id): void => {
    const it = mine.get(id);

    if (it !== undefined) {
      parts(kindOf(it.polygon)).forEach((kind, k) => {
        out.push({
          id: k === 0 ? id : sideOf(id, kind),
          kind,
          shape: it.shape,
          frame: it.frame,
          // Already an arrangement, whatever its depth. See `plainly`.
          simple: true,
          keep: it.keep,
        });
      });

      return;
    }

    const how = standing(id);
    const group = world.groups.get(id);

    // A loose group contributes nothing of its own. It is a handle, and its
    // members are already here in their own right — `tops` walked past it to
    // find them, exactly as it walks past an open one.
    if (group === undefined || how === null || !group.sealed) return;

    // One contribution per set at most, and both under the group's own kind: a
    // scope publishes what it *is*, not what it is made of. Whatever cut inside
    // it has been spent inside it, so there is nothing here for a sibling's
    // room to be cut by — which is the whole of what scoping means.
    //
    // A group whose kind is in only one of the sets puts nothing into the
    // other. A block assembled out of parts has floors inside it and they are
    // inside a block, which is not somewhere a floor is drawn.
    // One contribution per set, both plain: a scope publishes what it *is*, not
    // what it is made of, so a level here and a floor there and nothing that
    // cuts either. Two ids, because they are two boundaries.
    for (const set of SETS) {
      const shape = resolves(id, set);

      if (shape.length === 0) continue;

      const kind = SLOT_KINDS[set][0];

      out.push({
        id: sideOf(id, kind),
        kind,
        shape,
        frame: how.frame ?? IDENTITY,
        simple: true,
      });
    }
  };

  // Upwards from what is actually here, rather than down from the top.
  //
  // Down would reach a standing group by way of a transparent one holding it,
  // with none of that group's members in hand — and answer for it anyway, out
  // of nothing. Every polygon here names the one thing that stands for it, and
  // a group nothing here belongs to is never asked about at all.
  const tops = new Set<Id>();

  for (const it of items) {
    const up = enclosing(world, it.id)
      .filter(g => standing(g) !== null && world.groups.get(g)?.sealed === true);

    tops.add(up[up.length - 1] ?? it.id);
  }

  for (const id of tops) emit(id);

  return out;
}

/**
 * What is on screen, as things that can be picked: a closed group as one shape,
 * an open one as whatever is inside it.
 *
 * This is `contributing` asked a different question. The CSG wants to know
 * which groups are *eroding*, because that is the only thing that changes what
 * the set is made of. Drawing wants to know which groups are *closed*, because
 * a group is one thing to the hand whether or not it erodes — and a group at
 * depth zero still draws as its own outline.
 *
 * The two answers are the same walk over the same structure, so the same
 * function gives both. Only the question differs: `standing` here is "is this
 * group shut?".
 *
 * A group's shape comes out per kind, and a group holding a room and a pillar
 * has two of them. There is no shape that is the union of a thing and a hole
 * in it, and drawing one outline over both would draw a boundary that is not
 * anywhere. See `solidSide`.
 */
export function showing(
  world: World,
  v: VersionId,
  items: readonly Resolved[],
  /** The groups standing open, from `opened`. Everything else is shut. */
  path: readonly GroupId[],
): Contributed[] {
  const depth = depths(world, v);
  const open = new Set<Id>(path);

  return contributed(world, items, id =>
    open.has(id) ? null : { depth: depth.get(id) ?? 0 },
  );
}

/** One shut group as it is drawn: its whole contribution, as one boundary. */
export interface Occupied {
  id: GroupId
  /**
   * Why the group has no boundary of its own, where it has none. `shape` is
   * then the union of everything it holds — where the group *is* — rather than
   * an edge of any set.
   *
   * `loose` is a handle. Its members are in the set one by one and their own
   * outlines are on screen in their own right, so this is drawn round them and
   * nothing about them changes: what it says is *these are held together*.
   *
   * `empty` is a scope that came to nothing — a group of pillars, which has no
   * room in it for them to be holes in, or one eroded past its own middle.
   * Nothing else of it is on screen at all, so this is the whole of what says
   * it is there, and it is drawn the way an eroded-away polygon is.
   *
   * Either way what can be picked is what is drawn, which is the rule
   * everywhere else too — see `standingFor`.
   */
  gone?: 'loose' | 'empty'
  /**
   * Which of the two sets `shape` is the group's contribution to, and which
   * way it goes.
   *
   * `level`/`add` in the ordinary case, which is any group with a room in it.
   * `level`/`subtract` for a group made of nothing but pillars, which has no
   * level side to take them out of and is drawn as the pillars — a group must
   * be visible, and one made of holes is still a thing. `floor`/`add` for a
   * group with neither, which is drawn as its floor for the same reason.
   */
  kind: PolygonKind
  /**
   * The added side with the subtracted side taken out of it: what the group
   * puts into the level, and the whole of what a click on it can land on.
   *
   * A shut group draws no pillar of its own — a pillar's outline is exactly
   * the internal geometry that shutting it was meant to put away — so there is
   * nothing on screen to click in the hole one leaves, and the click falls
   * through, as a click on anything not drawn does.
   *
   * Empty for a group of nothing but floors, which occupies no level at all.
   * Then `floor` is the whole of it and `kind` says so.
   *
   * Always an arrangement, whichever branch built it: a union, or a union with
   * the subtracted side taken out of it. That is what lets `erodedShape` offset
   * it ring by ring — material is on the left of every ring a walk produces,
   * hole and outer alike, so one depth moves them all the right way.
   */
  shape: Shape
  /**
   * The group's floor set — its floors added and its floor holes taken back
   * out — whole.
   *
   * It has to end up drawn inside `shape` — a floor running out past the walls
   * it belongs to would put floor where the group is not — but it is handed
   * over unclipped, because the one thing that wants it is painting it and a
   * canvas clips for free. Intersecting with `shape` here would be a boolean
   * per redraw to work out a boundary nothing asks a question about: nothing
   * is picked by a floor, and where it is cut short the group's own outline is
   * already drawn along the cut.
   *
   * The subtraction *within* the floor set is a different matter and is done
   * here, because there is no outline anywhere else saying where those edges
   * are. A hole cut in a floor is a boundary of the floor.
   */
  floor: Shape
}

/**
 * What one shut group is on screen as, which is its level side where it has
 * one and its floor where it has nothing else.
 *
 * The same fallback the drawing makes and the picking makes, in one place so
 * that they cannot drift: what can be clicked is what is drawn.
 */
export function occupiedShape(o: Occupied): Shape {
  return o.shape.length === 0 ? o.floor : o.shape;
}

/**
 * What each shut group occupies, as the one outline that says so.
 *
 * A group resolves internally. Its level union with its solid union taken out
 * is what it puts into the level, and it is one boundary with nothing inside
 * it — which is the whole of what shutting a group is supposed to do to the
 * eye. Drawing the two sides separately puts the pillar's own outline back on
 * screen, and a pillar inside a room is exactly the internal geometry that
 * grouping was meant to stop showing.
 *
 * It is the same principle as eroding: a group erodes as one shape, so a group
 * resolves as one shape. What happens *between* its members is its own
 * business; what happens between it and the rest of the level is not, and is
 * left to the CSG outline over the top, exactly as it is for a lone polygon —
 * whose outline is also drawn whole, whatever cuts it.
 *
 * A group with nothing but walls in it has no level side to take them out of,
 * and is drawn as the walls. A group must be visible: it is the thing being
 * picked and dragged, and one made of pillars is still a thing.
 *
 * This is a question only drawing asks. The CSG needs the two sides apart —
 * a group's walls cut the rooms around it too, not only its own — which is
 * what `contributed` is careful to give it. See `showing`.
 */
export function occupying(
  world: World,
  v: VersionId,
  items: readonly Resolved[],
  path: readonly GroupId[],
): Occupied[] {
  return withExtents(world, items, path, occupied(world, showing(world, v, items, path)));
}

/**
 * The shut groups `items` reaches, outermost first for each of them.
 *
 * `contributed` walks the same way but stops at scopes; this stops at whatever
 * the hand would grab, which is any shut group, loose or sealed.
 */
function shutGroups(
  world: World,
  items: readonly Resolved[],
  path: readonly GroupId[],
): Set<GroupId> {
  const open = new Set<Id>(path);
  const out = new Set<GroupId>();

  for (const it of items) {
    const up = enclosing(world, it.id).filter(g => !open.has(g));
    const top = up[up.length - 1];

    if (top !== undefined) out.add(top);
  }

  return out;
}

/** The shut groups that occupy nothing, given their extent to stand in. */
function withExtents(
  world: World,
  items: readonly Resolved[],
  path: readonly GroupId[],
  shown: Occupied[],
): Occupied[] {
  const held = new Map<Id, Shape>(shown.map(o => [o.id, occupiedShape(o)]));
  const missing = [...shutGroups(world, items, path)].filter(id => !held.has(id));

  if (missing.length === 0) return shown;

  const mine = new Map(items.map(it => [it.id as Id, it.shape]));

  /**
   * Everything the group holds, unioned: where it *is*, for a group that has
   * no boundary of its own.
   *
   * What each member is on screen as, rather than what it is made of. A scope
   * inside the group has already answered that — it is in `held`, as the one
   * outline it draws — and going past it to the polygons underneath would put
   * its internal geometry back into the union: a loose group round a sealed
   * one would bulge out over the hole the scope cut in itself, which is the
   * very shape sealing took off the screen.
   */
  const extent = (id: Id): Shape => held.get(id)
    ?? mine.get(id)
    ?? offsetUnion((world.groups.get(id)?.members ?? []).map(extent), 0);

  for (const id of missing) {
    const shape = extent(id);

    if (shape.length === 0) continue;

    shown.push({
      id,
      kind: { type: 'level' },
      shape,
      floor: [],
      gone: world.groups.get(id)?.sealed === true ? 'empty' : 'loose',
    });
  }

  return shown;
}

/**
 * The same, with every shut group's own depth left off: the boundary the
 * group's erosion moved, rather than where it moved it to.
 *
 * A group has no source ring — it has no corners at all, which is the whole
 * reason `Occupied` is not a `Resolved` — so the only thing there is to say
 * where its erosion started from is the union taken again at depth zero. Its
 * members are resolved once either way and the union is the cheap half, so
 * this is a second pass over shapes already in hand rather than a second
 * resolve.
 *
 * Only drawing asks, and only about a group that is picked: it is the far end
 * of a leader line. See `moved`.
 */
export function occupyingSource(
  world: World,
  v: VersionId,
  items: readonly Resolved[],
  path: readonly GroupId[],
): Occupied[] {
  const open = new Set<Id>(path);

  return occupied(world, contributed(world, items, id =>
    open.has(id) ? null : { depth: 0 },
  ));
}

/** The four sides of each group put together into the one outline it draws as. */
function occupied(world: World, shown: readonly Contributed[]): Occupied[] {
  const sides = new Map<GroupId, Map<string, Shape>>();

  for (const c of shown) {
    const id = sidedWith(c.id) ?? c.id;

    if (!world.groups.has(id)) continue;

    const side = sides.get(id) ?? new Map<string, Shape>();

    side.set(kindKey(c.kind), c.shape);
    sides.set(id, side);
  }

  const out: Occupied[] = [];

  for (const [id, side] of sides) {
    const at = (k: PolygonKind): Shape => side.get(kindKey(k)) ?? [];

    // Nothing is folded or clipped here any more. A scope arrives resolved —
    // one shape per set, its solids and voids already spent inside it and its
    // floor already cut to it — because that is what it hands the CSG too, and
    // the two must not be two answers. See `resolves` in `contributed`.
    const floor = at({ type: 'floor' });

    for (const kind of [
      { type: 'level' } as const,
      { type: 'solid' } as const,
      { type: 'void', from: SOLID } as const,
    ]) {
      const shape = at(kind);

      if (shape.length !== 0) {
        out.push({ id, kind, shape, floor });
        break;
      }
    }

    // Nothing in the level at all. Then the floor is the whole of it, and it is
    // drawn as a floor rather than as nothing — the same reason a group of
    // pillars is drawn as pillars. `shape` empty is what says so on top of
    // `kind`, and it is what stops the drawing clipping the floor to an outline
    // that is not there.
    if (!out.some(o => o.id === id)) out.push({ id, kind: { type: 'floor' }, shape: [], floor });
  }

  return out;
}

/**
 * The outline of what is picked, as points: where a gesture takes the selection
 * to be.
 *
 * What is drawn, rather than what it was drawn from. A shut group's outline is
 * its level side with its solid side taken out of it — `occupying` says why —
 * and a pillar is not part of where a room is. It is a hole in one. So a group
 * whose pillar reaches out into the dark is still a group centred on its room,
 * and turning it does not swing about a point out in the middle of nothing.
 *
 * Which is the same answer the eye gives, because it is the same answer the
 * drawing gives: the two ask `occupying` and get one shape back.
 *
 * Anything drawn by itself speaks for itself. A lone pillar is a thing that has
 * been picked and is on screen, so it is where it is.
 *
 * The source rings where there is no outline at all — eroded past its own
 * middle, on every side. The same fallback the drawing makes, and for the same
 * reason: a selection with nothing on screen still has to be somewhere.
 */
export function outlining(
  world: World,
  v: VersionId,
  items: readonly Resolved[],
  path: readonly GroupId[],
): Point[] {
  const out: Point[] = [];

  for (const g of occupying(world, v, items, path)) {
    for (const ring of occupiedShape(g)) out.push(...ring);
  }

  for (const it of items) {
    if (swallowed(world, it.id, path)) continue;

    for (const ring of it.shape.length === 0 ? [it.source] : it.shape) out.push(...ring);
  }

  return out.length > 0 ? out : items.flatMap(it => it.source);
}

/**
 * Whether a polygon is drawn by itself, or swallowed by a group drawing for it.
 *
 * Any enclosing group that is not on the open path shuts it in. It does not
 * matter which one — the outermost shut group is what draws — because a
 * polygon inside a shut group has no outline of its own on screen either way.
 */
export function swallowed(world: World, id: Id, path: readonly GroupId[]): boolean {
  const open = new Set<Id>(path);

  // Only a sealed one. Shutting a scope takes several outlines away and leaves
  // one, which is the whole of what it does to the eye — but a loose group
  // takes nothing away, because its members are in the set in their own right
  // and their outlines are the set's. Hiding them would leave a green ring
  // round an empty patch of level that is demonstrably still there.
  return enclosing(world, id).some(g => !open.has(g) && world.groups.get(g)?.sealed === true);
}

/**
 * The polygons the point tool may have handles on: everything drawn by itself,
 * plus the members of whatever groups are picked.
 *
 * A shut group hides its members' outlines, and their corners went with them —
 * a handle on a shape that is not on screen is a handle on nothing. Picking
 * the group puts them back, corners only: the group is still one outline, and
 * what a click on it does is still pick the group, but the shapes underneath
 * are named now and their corners are worth reaching. That is the same bargain
 * command-click already makes for one polygon at a time, offered to the whole
 * of what the selection names.
 *
 * Which of those corners are worth a square is a second question, and it is
 * `handles` that answers it: a member offers only the corners standing on the
 * group's own boundary.
 */
export function editable(
  world: World,
  items: readonly Resolved[],
  path: readonly GroupId[],
  inside: GroupId | null,
  /** What the selection reaches, from `polygonsIn`. */
  picked: ReadonlySet<PolygonId>,
): Resolved[] {
  return items.filter(it =>
    reachable(world, it.id, inside)
    && (picked.has(it.id) || !swallowed(world, it.id, path)),
  );
}

/** One corner the point tool can put a square on and a click can land on:
 * which corner it is, and where it is standing. */
export interface Handle extends Grabbed {
  at: Point
}

/**
 * Every handle on screen, which is what the point tool draws and what a click
 * under it hits.
 *
 * A corner rather than a polygon, because a picked group's members do not
 * offer all of theirs. A group is one outline and the corners under it are of
 * two kinds: the ones on that outline, which are the shape of the thing being
 * looked at, and the seams where two members meet, which are the internal
 * geometry shutting the group put away. Handing back every corner of every
 * member puts the seams back as squares — the outline of the members without
 * the lines, which is the most confusing form the hidden geometry could take.
 * So a swallowed member offers the corners that are on the group's boundary
 * and no others.
 *
 * The group's *source* boundary, and its floor's: the union with the group's
 * own depth left off, which is where the members' corners actually are, and
 * the floor union beside it, which is drawn inside the group and is nobody's
 * outline but is on screen all the same. See `occupyingSource`.
 *
 * Drawing and hitting share this and have to: a square drawn where no click
 * lands is worse than no square, and a click that moves a corner with no
 * square on it is worse still.
 */
export function handles(
  world: World,
  v: VersionId,
  items: readonly Resolved[],
  path: readonly GroupId[],
  inside: GroupId | null,
  /** What the selection reaches, from `polygonsIn`. */
  picked: ReadonlySet<PolygonId>,
): Handle[] {
  const mine = editable(world, items, path, inside, picked);
  const shut = mine.filter(it => swallowed(world, it.id, path));

  // Only where a picked group is standing for something, which is the only
  // case that needs a boundary to test against.
  const on = new Map<Id, (p: Point) => boolean>();

  if (shut.length !== 0) {
    for (const g of occupyingSource(world, v, items, path)) {
      const edge = onBoundary(g.shape);
      const floor = g.floor.length === 0 ? null : onBoundary(g.floor);

      on.set(g.id, p => edge(p) || (floor !== null && floor(p)));
    }
  }

  const out: Handle[] = [];

  for (const it of mine) {
    const edge = on.get(reaching(world, it.id, path));

    it.source.forEach((at, index) => {
      if (edge !== undefined && !edge(at)) return;

      out.push({ id: it.id, index, vertex: it.corners[index].id, at });
    });
  }

  return out;
}

/**
 * Whether a click can reach `id` at all.
 *
 * Everything outside the group standing open is out of reach: it is drawn, so
 * that what is being edited can be judged against the level around it, but it
 * cannot be picked or dragged. That is what makes going inside a group a scope
 * rather than a hint — a slip of the cursor onto the room next door does not
 * silently take the selection out with it.
 */
export function reachable(world: World, id: Id, inside: GroupId | null): boolean {
  // A group that is no longer there holds nothing in, which is the same answer
  // `opened` gives: undo can restore a world the open path was never in, and
  // the way out of that is being outside rather than being nowhere.
  if (inside === null || !world.groups.has(inside)) return true;

  return enclosing(world, id).includes(inside);
}

/**
 * What a click on `id` picks: the outermost group around it that is still shut,
 * or `id` itself where none is.
 *
 * The top-level answer with nothing open, and one step deeper for every level
 * opened — which is the whole of what going inside a group does to picking.
 */
export function reaching(world: World, id: Id, path: readonly GroupId[]): Id {
  const open = new Set<Id>(path);
  const shut = enclosing(world, id).filter(g => !open.has(g));

  return shut[shut.length - 1] ?? id;
}

/** Resolved polygons as contributors, one for one. What the CSG sees wherever
 * no group is eroding, and what the bake works in. */
export function plainly(items: readonly Resolved[]): Contributed[] {
  return items.flatMap(it => parts(kindOf(it.polygon)).map((kind, k) => ({
    id: k === 0 ? it.id : sideOf(it.id, kind),
    kind,
    shape: it.shape,
    frame: it.frame,
    keep: it.keep,

    // A projection came out of an arrangement and is already simple, at every
    // depth. Depth zero is not the exception it used to be: `project` decomposes
    // there too, so that a ring which has not started eroding is cut the same
    // way as the same ring a moment later — see `project`. Saying otherwise
    // costs an arrangement per polygon per evaluation, for an answer that is
    // already in hand.
    simple: true,
  })));
}

/**
 * The set the game would get — every level polygon added, every one subtracted
 * taken out — as the open runs its outline is made of.
 *
 * Runs rather than rings because that is what can be kept up to date: a run
 * belongs to one polygon, so an edit only disturbs the polygons it overlaps.
 * See `worldset.ts`. Nothing that reads this wants a closed loop — the overlay
 * is stroked, and collision is edge-normal based.
 */
export function csg(world: World, v: VersionId): Point[][] {
  return runs(live(EMPTY_LIVE, contributing(world, v, resolveAt(world, v))));
}

/** The same for the floor, which is a set of its own and answered by the same
 * machinery. See `Live`. */
export function csgFloor(world: World, v: VersionId): Point[][] {
  return floorRuns(live(EMPTY_LIVE, contributing(world, v, resolveAt(world, v))));
}

/**
 * The two sets, held on to between draws so that redrawing costs only what
 * actually moved. Rebuilding one from nothing is O(n) in polygons and measured
 * at nearly two seconds for ten thousand of them; bringing it up to date after
 * a dragged vertex is about a millisecond.
 *
 * Two, because there are two: the level, which is what collision and the walls
 * are made of, and the floor, which is drawn flat and takes part in nothing.
 * They are kept apart rather than tagged and mixed because they are separate
 * questions — a pillar does not cut a floor and a hole in a floor does not cut
 * a room — and because keeping them apart is what makes each of them a set
 * `worldset` already knows how to answer.
 */
export interface Live {
  level: WorldSet
  floor: WorldSet
  /** What each contributor resolved to when the sets were last brought up to
   * date. A group with a depth on it is one of them; its members are not. */
  seen: Map<Id, Contributed>
}

/** An empty set of each, each knowing the shape of the set it is. */
export const emptySet = (set: SetName): WorldSet =>
  emptyWorldSet(SLOTS[set], on => inside(set, on));

export const EMPTY_LIVE: Live = {
  level: emptySet('level'),
  floor: emptySet('floor'),
  seen: new Map(),
};

export function runs(l: Live): Point[][] {
  return outline(l.level);
}

export function floorRuns(l: Live): Point[][] {
  return outline(l.floor);
}

/**
 * The same runs, each carrying whether the boundary turns at each of its
 * points.
 *
 * What the walls need and what `runs` throws away. The answer comes off the
 * CSG rather than off the runs, because it is a question about a polygon and
 * its neighbours — see `cornering` in `geometry.ts` — and the bake is handed
 * the very same answer, so the walls standing still and the walls in flight
 * agree about every vertical.
 */
export function sourced(l: Live): { points: Point[], corner: boolean[] }[] {
  return pieces(l.level).map(p => ({ points: p.points, corner: p.corner }));
}

/**
 * The sets brought up to date against `items`, doing only the work the
 * differences call for.
 *
 * `resolveAt` builds fresh arrays every time, so what changed cannot be read
 * off object identity and is compared point by point instead. That costs one
 * pass over the geometry, which is the same order as resolving it — and far
 * less than rebuilding the set for a world where nothing moved.
 *
 * A polygon that changes which set it is in is a removal from one and an
 * insertion into the other, which falls out of doing this per set: it is
 * missing from the one and unknown to the other, and neither has to be told
 * that a retype is what happened.
 */
export function live(previous: Live, items: readonly Contributed[]): Live {
  const seen = new Map<Id, Contributed>();
  const edits = new Map<SetName, SetEdit[]>([['level', []], ['floor', []]]);

  for (const it of items) {
    seen.set(it.id, it);

    const was = previous.seen.get(it.id);
    const moved = was === undefined || !unmoved(was.shape, it.shape);
    const retyped = was !== undefined && !sameKind(was.kind, it.kind);

    // Each set on its own, because one kind can be in both: a void cutting the
    // solids and the floors alike is a member of each, under the same id and
    // in slots that have nothing to do with one another. The two sets are two
    // id spaces, so there is nothing to tell apart.
    for (const set of SETS) {
      const slot = slotOf(it.kind, set);
      const before = was === undefined ? null : slotOf(was.kind, set);

      // Gone from this set — a retype that dropped it, or one that never had
      // it. Either way it is removed and nothing is inserted.
      if (slot === null) {
        if (before !== null) edits.get(set)!.push({ op: 'remove', id: it.id });
        continue;
      }

      if (!moved && slot === before) continue;

      // A slot it did not have has to go in as an insert: an update keeps the
      // slot it had.
      edits.get(set)!.push(
        before === null || slot !== before
          ? { op: 'insert', id: it.id, slot, shape: it.shape, simple: it.simple }
          : { op: 'update', id: it.id, shape: it.shape, simple: it.simple },
      );
    }
  }

  for (const [id, was] of previous.seen) {
    if (seen.has(id)) continue;

    for (const set of SETS) {
      if (slotOf(was.kind, set) !== null) edits.get(set)!.push({ op: 'remove', id });
    }
  }

  const level = edits.get('level')!, floor = edits.get('floor')!;

  if (level.length === 0 && floor.length === 0) return previous;

  return {
    level: level.length === 0 ? previous.level : edited(level)(previous.level),
    floor: floor.length === 0 ? previous.floor : edited(floor)(previous.floor),
    seen,
  };
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
  return hitPolygons(items, at)[0] ?? null;
}

/** Every polygon under a point, topmost first, which is what clicking through
 * a stack of them needs. */
export function hitPolygons(items: Resolved[], at: Point): PolygonId[] {
  const out: PolygonId[] = [];

  for (let i = items.length - 1; i >= 0; i--) {
    if (contains(standingFor(items[i]), at)) out.push(items[i].id);
  }

  return out;
}

/**
 * The shape a click is tested against: the projection, or the source ring
 * where the projection is empty.
 *
 * A polygon eroded away has nothing on screen and nothing to click, and being
 * unpickable is how it stays that way for good — there is no gesture that
 * takes the depth back off a shape that cannot be selected. So the source ring
 * stands in for it, and the drawing puts that ring on screen for exactly the
 * same shapes: what can be picked is what is drawn, which is the rule
 * everywhere else too.
 */
function standingFor(it: Resolved): Shape {
  return it.shape.length === 0 ? sliced(it.source, it.rings) : it.shape;
}

/**
 * What a click lands on, topmost first: the things it could pick, tested
 * against the shapes they are drawn as.
 *
 * A shut group is one outline — its members' union, eroded by its own depth —
 * and that outline is what has to answer, not the members underneath it. They
 * are not eroded; the group is. Test them and a group eroded well inward is
 * still picked from anywhere inside the rings it was made of, which is a long
 * way outside anything on screen.
 *
 * Walked in draw order and reversed, so a group answers from where its topmost
 * member is in the stack and the reaching stays in step with what is painted
 * over what. A group is asked once however many members lead to it: the answer
 * cannot differ, it being one shape.
 *
 * Everything out of reach is skipped, which with a group open is everything
 * outside it. It is drawn, so that it can be seen where the work is going, but
 * it is not there to be clicked on.
 */
export function hitting(
  world: World,
  v: VersionId,
  items: readonly Resolved[],
  path: readonly GroupId[],
  at: Point,
): Id[] {
  const shut = new Map(occupying(world, v, items, path).map(o => [o.id, occupiedShape(o)]));
  const asked = new Set<Id>();
  const out: Id[] = [];

  const open = path[path.length - 1] ?? null;

  // The source union, for the groups that eroded away to nothing. Taken once
  // and only where one has, since it is a second union over every member of
  // every shut group. A group standing at a depth that leaves nothing is
  // otherwise unpickable for good, the same trap `standingFor` keeps a polygon
  // out of, and its source ring is on screen for the same reason.
  let source: Map<GroupId, Shape> | null = null;

  const drawn = (id: Id, it: Resolved): Shape => {
    const shape = shut.get(id);

    if (shape !== undefined && shape.length !== 0) return shape;

    // A polygon standing for itself answers with its own ring; a group has to
    // answer with the union, and cannot be left to answer with the member this
    // pass happens to be looking at — every member maps to the one id, and the
    // first of them to be asked is the only one that gets to.
    if (id === it.id) return standingFor(it);

    source ??= new Map(
      occupyingSource(world, v, items, path).map(o => [o.id, occupiedShape(o)]),
    );

    return source.get(id as GroupId) ?? shape ?? [];
  };

  for (let i = items.length - 1; i >= 0; i--) {
    if (!reachable(world, items[i].id, open)) continue;

    const id = reaching(world, items[i].id, path);

    if (asked.has(id)) continue;

    asked.add(id);

    if (contains(drawn(id, items[i]), at)) out.push(id);
  }

  return out;
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
  on: readonly Handle[],
  at: Point,
  radius: number,
): Grabbed | null {
  let best: Grabbed | null = null;
  let bestDistance = radius;

  for (const h of on) {
    const d = Math.hypot(h.at.x - at.x, h.at.y - at.y);

    if (d <= bestDistance) {
      bestDistance = d;
      best = { id: h.id, index: h.index, vertex: h.vertex };
    }
  }

  return best;
}

/** One corner of one polygon: where it is in the ring, and which corner it is.
 * The index moves when a corner is inserted before it; the id never does. */
export interface Grabbed {
  id: PolygonId
  index: number
  vertex: VertexId
}

/**
 * The nearest point of a source edge within `radius`, and which edge it is on.
 *
 * `index` is the corner the edge leaves, so what gets inserted for this hit
 * goes directly after it. Callers are expected to have asked `hitVertex` first
 * and taken its answer: every corner lies on two edges, and a click on one
 * means the corner rather than either edge.
 */
export function hitEdge(
  items: Resolved[],
  at: Point,
  radius: number,
): { id: PolygonId, index: number, at: Point } | null {
  let best: { id: PolygonId, index: number, at: Point } | null = null;
  let bestDistance = radius;

  for (const it of items) {
    const ring = it.source;

    for (let i = 0; i < ring.length; i++) {
      const on = along(ring[i], ring[nextOf(it.rings, ring.length, i)], at);
      const d = Math.hypot(on.x - at.x, on.y - at.y);

      if (d <= bestDistance) {
        bestDistance = d;
        best = { id: it.id, index: i, at: on };
      }
    }
  }

  return best;
}

/** How far along `a`–`b` the foot of `p` falls, clamped to the segment. */
function fraction(a: Point, b: Point, p: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = dx * dx + dy * dy;

  if (len === 0) return 0;

  return Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
}

/** The point of `a`–`b` closest to `p`. */
function along(a: Point, b: Point, p: Point): Point {
  const t = fraction(a, b, p);

  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Every corner inside the box, by id, which is what a marquee over the points
 * is asking for. */
export function verticesWithinBox(on: readonly Handle[], a: Point, b: Point): VertexId[] {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);

  return on
    .filter(h => h.at.x >= x0 && h.at.x <= x1 && h.at.y >= y0 && h.at.y <= y1)
    .map(h => h.vertex);
}

// -----------------------------------------------------------------------------
// Corners, added and taken away
//
// A corner is added and removed the way a polygon is: it is born into the
// version doing the adding and dies at the version doing the removing, and the
// versions before that one are not touched. Nothing a layer does reaches back
// past itself — that is the rule the whole design rests on, and a corner is not
// an exception to it.
//
// The list itself never shrinks. `polygon.points` holds every corner the
// polygon has ever had, in ring order, and which of them a version has is
// `standing`. Keeping the dead in place is what lets a corner be inserted
// between two others without the versions that lack it losing the order.
//
// A corner has to stand somewhere at versions that were never looking at it,
// and it is put the same fraction along the edge as the click was, measured in
// the polygon's own frame. Where an upstream layer has since pulled the edge's
// ends apart that is no longer under the cursor, and the adding version's own
// layer takes the displacement that makes up the difference.
//
// What the span between two versions does about the change is `bake.ts`: the
// corner is there at both ends of it, sitting on the edge it grows out of.
// -----------------------------------------------------------------------------

/**
 * A corner put into the edge that was clicked, at the point of it that was.
 *
 * Two steps, because they answer different questions: the ring gains a corner
 * at a sensible resting place everywhere, and then this version alone says
 * exactly where it goes. The second writes nothing when the first already
 * landed it, which is every polygon no upstream layer has nudged.
 */
export function addVertex(
  world: World,
  v: VersionId,
  it: Resolved,
  index: number,
  at: Point,
): { world: World, vertex: VertexId } {
  // Round its own ring rather than round the list: the corner after the last
  // of a hole is the first of that hole, not the first of the outline.
  const next = nextOf(it.rings, it.corners.length, index);
  const t = fraction(it.source[index], it.source[next], at);

  const from = it.corners[index].at, to = it.corners[next].at;
  const vertex = world.nextId;

  const corner: Vertex = {
    id: vertex,
    at: {
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
    },
    // Whichever ring the edge it was added to belongs to, which is the whole of
    // what keeps the corners grouped: a corner only ever arrives beside one.
    ring: it.corners[index].ring,
    birth: v,
    death: null,
  };

  // Directly after the corner the edge leaves, in the full list rather than in
  // this version's view of it: a corner that died earlier still holds its place
  // in the order, and stepping over it would put this one on the wrong edge.
  const points = [...it.polygon.points];
  points.splice(points.indexOf(it.corners[index]) + 1, 0, corner);

  const polygons = new Map(world.polygons);
  polygons.set(it.id, { ...it.polygon, points });

  const grown: World = { ...world, polygons, nextId: vertex + 1 };
  const now = resolveAt(grown, v).find(r => r.id === it.id);

  if (now === undefined) return { world: grown, vertex };

  const where = now.corners.findIndex(c => c.id === vertex);
  const stands = now.source[where];

  if (Math.hypot(stands.x - at.x, stands.y - at.y) <= 1e-9) {
    return { world: grown, vertex };
  }

  const edit = placeVertex(now, editAt(grown, v, it.id, now), where, at);

  return { world: withEdit(grown, v, it.id, edit), vertex };
}

/**
 * Corners taken out as of `v`, and standing as they were before it.
 *
 * Their displacements stay written where they were written. A layer that moved
 * a corner still moved it, at the versions that still have it, and dropping
 * that on the way out would quietly edit the past.
 *
 * Three is the fewest a ring can have and still be one, so a polygon down to
 * three keeps all of them: what is being asked for below that is to delete the
 * polygon, and that is a different thing to ask for.
 */
/**
 * Polygons, groups and artefacts taken out as of `v`, and standing as they were
 * before it.
 *
 * The same shape as `removeVertices`, one level up, and for the same reasons.
 * What a version's layers already said about a thing stays written: a layer
 * that turned a room still turned it, at the versions that still have the room,
 * and dropping those on the way out would quietly edit the past. `resolveAt`
 * stops walking a thing at its death, so what is left behind is inert rather
 * than wrong.
 *
 * A group goes with everything under it. That is the rule a delete already
 * followed when it was global — picking a group is picking the rooms in it, and
 * removing the thing that holds them together while they stayed would be a
 * delete that removed less than it drew — and it is the rule here, one version
 * at a time. What it does *not* do is take the group apart: the membership is a
 * fact about the world at every version that still has the group, and `without`
 * is for things that are leaving the world rather than leaving a version.
 *
 * Born into `v` and taken out at `v` is the one case that goes entirely: it
 * never stood anywhere, so there is no version for the record to be about. That
 * one *does* restructure, since what is left is a group holding something that
 * is not in the world at all.
 */
export function removeAt(world: World, v: VersionId, going: Iterable<Id>): World {
  const inherited = new Set(chain(world, v));

  // Everything under what was picked, which is what a delete has always
  // reached. A group is in here as itself as well as through its members.
  const gone = new Set<Id>();

  for (const id of going) {
    for (const m of within(world, id)) gone.add(m);
  }

  const polygons = new Map(world.polygons);
  const groups = new Map(world.groups);
  const artefacts = new Map(world.artefacts);
  const paths = new Map(world.paths);
  const outright = new Set<Id>();

  let changed = false;

  /** One thing's map entry, either killed at `v` or dropped outright. */
  const take = <T extends { birth: VersionId, death: VersionId | null }>(
    map: Map<Id, T>,
    id: Id,
    it: T,
  ): void => {
    // Not standing here is not something a delete has anything to say about.
    // It reaches these through a group rather than through a click — a member
    // that died two versions ago, or one not born until later — and either way
    // its own record is already right.
    if (!standing(it, inherited)) return;

    changed = true;

    if (it.birth === v) {
      map.delete(id);
      outright.add(id);
      return;
    }

    map.set(id, { ...it, death: v });
  };

  for (const id of gone) {
    const polygon = polygons.get(id);
    if (polygon !== undefined) take(polygons, id, polygon);

    const group = groups.get(id);
    if (group !== undefined) take(groups, id, group);

    const artefact = artefacts.get(id);
    if (artefact !== undefined) take(artefacts, id, artefact);

    const path = paths.get(id);
    if (path !== undefined) take(paths, id, path);
  }

  if (!changed) return world;

  const out = { ...world, polygons, groups, artefacts, paths };

  return outright.size === 0 ? out : without(out, outright);
}

export function removeVertices(
  world: World,
  v: VersionId,
  going: Iterable<VertexId>,
): World {
  const gone = new Set(going);

  if (gone.size === 0) return world;

  const polygons = new Map(world.polygons);
  let changed = false;

  // Which corners are here is a resolve rather than a filter, because an
  // unchained polygon's are not the ones the chain would name — see `Footing`.
  const standingHere = new Map(resolveAt(world, v).map(it => [it.id, it.corners]));

  for (const [id, polygon] of world.polygons) {
    const here = standingHere.get(id) ?? [];
    const taking = here.filter(c => gone.has(c.id));

    if (taking.length === 0) continue;

    // Three per ring rather than three in all. What is being asked for below
    // that is to delete the ring, and deleting a hole is deleting a hole — a
    // gesture this has no way to tell from a slip of the marquee, so it refuses
    // the whole removal exactly as it always has.
    const left = new Map<number, number>();

    for (const c of here) {
      if (!gone.has(c.id)) left.set(c.ring, (left.get(c.ring) ?? 0) + 1);
    }

    const rings = new Set(here.map(c => c.ring));

    if ([...rings].some(r => (left.get(r) ?? 0) < 3)) continue;

    const alive = new Set(here.map(c => c.id));

    const points = polygon.points.flatMap(c => {
      if (!gone.has(c.id) || !alive.has(c.id)) return [c];

      // Added and taken out at the same version: it never stood anywhere, so
      // there is nothing for the order to remember and it goes entirely.
      return c.birth === v ? [] : [{ ...c, death: v }];
    });

    polygons.set(id, { ...polygon, points });
    changed = true;
  }

  return changed ? { ...world, polygons } : world;
}

// -----------------------------------------------------------------------------
// Copying
// -----------------------------------------------------------------------------

/** A direction as the frame `m` places it: the linear part only, so a
 * displacement turns and stretches with the frame but does not travel. */
function pointing(m: Affine, d: Point): Point {
  return { x: m.a * d.x + m.c * d.y, y: m.b * d.x + m.d * d.y };
}

/**
 * How far past the copy version the thing being copied is taken out, or nothing
 * where it is not.
 *
 * The same offset a corner's `death` becomes, and for the same reason: what is
 * copied is a life rather than a shape, so a room the original loses two
 * versions on is a room the copy loses two versions after it lands. One that
 * died before the copy version is never reached — nothing that is not standing
 * at `v` is offered to `clip` at all.
 */
function outliving(it: { death: VersionId | null }, v: VersionId): number | undefined {
  return it.death === null ? undefined : it.death - v;
}

/**
 * `outliving` read back at the version a paste lands in.
 *
 * A death that falls off the end of the chain is nothing: there is no version
 * left to take the thing out, so the copy simply lives to the last one. The
 * same rule a corner's death is restored under.
 */
function dying(world: World, v: VersionId, death: number | undefined): VersionId | null {
  return death === undefined || v + death >= world.versions.length ? null : v + death;
}

/**
 * The picked things lifted out, from the version they were taken at onward.
 *
 * Two halves. The version it was copied at becomes the geometry: rings in world
 * units as they stood there, so the copy starts life looking exactly like what
 * was on screen. Every version *after* it comes across as a layer, keyed by how
 * far past the copy it was, so what the original goes on to do the copy goes on
 * to do too — the erosion sequence is the thing worth copying, and it is not in
 * any one version.
 *
 * Nothing before the copy comes at all. A copy taken at v1 that reappeared at
 * v0 is answering a question nobody asked: the author is standing at v1 and
 * pointing at what is there.
 *
 * Displacements and corners still to arrive are written in the polygon's drawn
 * frame, which the copy no longer has — its drawn frame is the copy version's
 * world. So they come through that frame: `place` for a corner, which is
 * somewhere, and `pointing` for a displacement, which is only a direction.
 *
 * No footings come across, and there is nothing for them to say: a copy is born
 * at the version it lands in, out of the geometry that stood at the version it
 * was taken at, so it already hears nothing from before that. A footing further
 * down the original's chain is the one thing lost, and it is lost the way every
 * other layer before the copy version is — see *Unchaining*.
 */
export function copied(world: World, v: VersionId, ids: readonly Id[]): Clipping[] {
  const items = new Map(resolveAt(world, v).map(it => [it.id, it]));
  const deep = depths(world, v);

  /** What a version's layer says, as the copy will say it. */
  const layers = (
    id: Id,
    m: Affine | null,
    erosion: number,
    over: ReadonlyMap<VertexId, number> = new Map(),
  ): [number, Edit][] => {
    const out: [number, Edit][] = [[0, {
      transform: { ...EMPTY_TRANSFORM, erosion },
      vertices: new Map(),
      depths: new Map(over),
    }]];

    for (let k = v + 1; k < world.versions.length; k++) {
      const edit = world.versions[k].edits.get(id);

      if (edit === undefined) continue;

      out.push([k - v, {
        transform: { ...edit.transform, translation: { ...edit.transform.translation } },
        vertices: m === null
          ? new Map()
          : new Map([...edit.vertices].map(([id, d]) => [id, pointing(m, d)])),
        depths: new Map(edit.depths),
      }]);
    }

    return out;
  };

  const clip = (id: Id): Clipping[] => {
    const thing = world.artefacts.get(id);

    if (thing !== undefined) {
      const here = placeAt(world, id, v);

      // Its layers come across the way a group's do — a transform and nothing
      // else. There is no ring under it to displace and no depth to inherit.
      return here === null
        ? []
        : [{
          kind: 'artefact',
          type: thing.type,
          at: here,
          death: outliving(thing, v),
          edits: layers(id, null, 0),
        }];
    }

    const walk = world.paths.get(id);

    if (walk !== undefined) {
      const here = pathAt(world, id, v);

      // An artefact's clipping with more points in it, and the same layers: a
      // transform per version and nothing else, there being no ring to
      // displace and no depth to inherit.
      return here === null
        ? []
        : [{
          kind: 'path',
          points: here,
          death: outliving(walk, v),
          edits: layers(id, null, 0),
        }];
    }

    const group = world.groups.get(id);

    if (group !== undefined) {
      const members = group.members.flatMap(clip);

      return members.length === 0 ? [] : [{
        kind: 'group',
        sealed: group.sealed,
        members,
        death: outliving(group, v),
        edits: layers(id, null, deep.get(id) ?? 0),
      }];
    }

    const it = items.get(id);

    if (it === undefined) return [];

    const source = new Map(it.corners.map((corner, i) => [corner.id, it.source[i]]));

    const points = it.polygon.points
      .filter(corner => source.has(corner.id) || corner.birth > v)
      .map(corner => ({
        id: corner.id,
        at: source.get(corner.id) ?? place(it.frame, [corner.at])[0],
        ring: corner.ring,
        birth: source.has(corner.id) ? 0 : corner.birth - v,
        death: corner.death === null ? null : corner.death - v,
      }));

    return [{
      kind: 'polygon',
      ...kindOf(it.polygon),
      points,
      death: outliving(it.polygon, v),
      edits: layers(id, it.frame, it.erosion, it.over),
    }];
  };

  return [...new Set(ids)].flatMap(clip);
}

/**
 * The clipping's layers written for `id`, starting at `v`, with its vertices
 * renamed and the paste's offset put in.
 *
 * The offset goes on the translation of the layer the thing is born into rather
 * than into the ring: that translation is applied after the layer's own turn
 * and scale, so at the top level it is a world-space nudge, and every later
 * layer applies to what it produced. Move it once at the start and it has moved
 * at every version, keeping whatever it does in between.
 */
function written(
  world: World,
  v: VersionId,
  id: Id,
  edits: readonly [number, Edit][],
  renamed: ReadonlyMap<VertexId, VertexId>,
  m: Affine,
  by: Point | null,
): World {
  let out = world;

  for (const [offset, edit] of edits) {
    // Past the end of the chain, and there is nowhere for it to go. See the
    // note on `pasted`.
    if (v + offset >= world.versions.length) break;

    const at = edit.transform.translation;

    // A world-space nudge, and this layer's translation is read in `m`.
    const step = offset === 0 && by !== null ? unstep(m, by.x, by.y) : null;

    out = withEdit(out, v + offset, id, {
      transform: step === null
        ? edit.transform
        : { ...edit.transform, translation: { x: at.x + step.x, y: at.y + step.y } },
      vertices: new Map([...edit.vertices].map(
        ([v, d]) => [renamed.get(v) ?? v, unstep(m, d.x, d.y)],
      )),
      depths: new Map([...edit.depths].map(([v, d]) => [renamed.get(v) ?? v, d])),
    });
  }

  return out;
}

/**
 * One clipping put back at `v`, and everything under it.
 *
 * `m` is the frame whatever is pasted will be placed by: identity at the top
 * level, and the open group's own frame when pasting into one. A clipping's
 * geometry is in world units, so it comes back through that frame on the way
 * in — otherwise pasting into a turned group would turn the paste, which is not
 * what the author is looking at while they do it.
 *
 * The same frame all the way down, rather than one per level: what is inside
 * the pasted group is placed by the pasted group, whose own frame at `v` is
 * nothing but the offset.
 *
 * The offset lands on the outermost thing only, for the same reason.
 */
function restore(
  world: World,
  v: VersionId,
  clip: Clipping,
  m: Affine,
  by: Point | null,
): { world: World, id: Id } {
  if (clip.kind === 'artefact') {
    const id = world.nextId;
    const artefacts = new Map(world.artefacts);

    artefacts.set(id, {
      type: clip.type,
      birth: v,
      death: dying(world, v, clip.death),
      at: unplace(m, clip.at),
    });

    const out = { ...world, artefacts, nextId: id + 1 };

    return { world: written(out, v, id, clip.edits, new Map(), m, by), id };
  }

  if (clip.kind === 'path') {
    const id = world.nextId;
    const paths = new Map(world.paths);

    paths.set(id, {
      birth: v,
      death: dying(world, v, clip.death),
      points: clip.points.map(p => unplace(m, p)),
    });

    const out = { ...world, paths, nextId: id + 1 };

    return { world: written(out, v, id, clip.edits, new Map(), m, by), id };
  }

  if (clip.kind === 'group') {
    const members: Id[] = [];
    let out = world;

    for (const member of clip.members) {
      const put = restore(out, v, member, m, null);

      out = put.world;
      members.push(put.id);
    }

    const id = out.nextId;
    const groups = new Map(out.groups);

    groups.set(id, { birth: v, death: dying(out, v, clip.death), members, sealed: clip.sealed });
    out = { ...out, groups, nextId: id + 1 };

    return { world: written(out, v, id, clip.edits, new Map(), m, by), id };
  }

  const id = world.nextId;
  const renamed = new Map<VertexId, VertexId>();
  const points = clip.points
    .filter(corner => v + corner.birth < world.versions.length)
    .map((corner, i) => {
      renamed.set(corner.id, id + 1 + i);

      return {
        id: id + 1 + i,
        at: unplace(m, corner.at),
        ring: corner.ring,
        birth: v + corner.birth,
        death: corner.death === null || v + corner.death >= world.versions.length
          ? null
          : v + corner.death,
      };
    });

  const polygons = new Map(world.polygons);

  polygons.set(id, {
    ...kindOf(clip),
    birth: v,
    death: dying(world, v, clip.death),
    points,
  });

  const out = {
    ...world,
    polygons,
    nextId: id + 1 + points.length,
  };

  return { world: written(out, v, id, clip.edits, renamed, m, by), id };
}

/**
 * Clippings put back at `v`, offset by `by` so that a paste is something you
 * can see happen.
 *
 * A copy taken at v1 and pasted at v3 has its v1 land in v3, its v2 in v4, and
 * so on: the layers are relative to where they were taken, so what is pasted
 * does from here what the original did from there.
 *
 * What runs off the end of the chain is dropped. The chain is a fixed length
 * everywhere else — the strip draws its rows once, the bake counts its spans
 * from the same number — so growing it here would be growing it for all of
 * them, and that is a change about forks, not about pasting.
 *
 * The ids that come back are the top of what was pasted — a group rather than
 * the polygons under it — because that is what the selection should hold: a
 * paste leaves you holding what you copied.
 */
export function pasted(
  world: World,
  v: VersionId,
  clips: readonly Clipping[],
  by: Point,
  where: Landing,
): Pasted {
  const ids: Id[] = [];
  const artefacts: ArtefactId[] = [];
  const paths: PathId[] = [];
  let out = world;

  for (const clip of clips) {
    const put = restore(out, v, clip, where.frame, by);

    out = put.world;

    // Kept apart only because the selection holds them in separate lists.
    // All three go into the group standing open, all three being members of
    // one.
    if (clip.kind === 'artefact') artefacts.push(put.id);
    else if (clip.kind === 'path') paths.push(put.id);
    else ids.push(put.id);
  }

  return {
    world: joined(out, where.into, [...ids, ...artefacts, ...paths]),
    ids,
    artefacts,
    paths,
  };
}

/** What a paste leaves picked, in the three lists the selection keeps. */
export interface Pasted {
  world: World
  /** The polygons and groups, which is what `Selection.polygons` holds. */
  ids: Id[]
  artefacts: ArtefactId[]
  paths: PathId[]
}

/**
 * The same, and only the version it lands in: one version's worth of shape,
 * born there, saying nothing about any other.
 *
 * The clipping's first layer *is* the version it was copied at, so this is the
 * paste with the tail dropped. For taking a shape somewhere else without taking
 * its history with it — the pillar from v0's room, in v3's, standing still
 * while the original goes on eroding.
 *
 * Corners still to arrive go with the tail, and corners due to leave stop
 * leaving. What either was for is not happening here — and the same goes for
 * the thing itself: a stamp of a room that is due to be taken out is a room,
 * not a countdown.
 */
export function stamped(
  world: World,
  v: VersionId,
  clips: readonly Clipping[],
  by: Point,
  where: Landing,
): Pasted {
  const now = (clip: Clipping): Clipping => clip.kind === 'artefact' || clip.kind === 'path'
    ? { ...clip, death: undefined, edits: clip.edits.slice(0, 1) }
    : clip.kind === 'group'
    ? {
        ...clip,
        members: clip.members.map(now),
        death: undefined,
        edits: clip.edits.slice(0, 1),
      }
    : {
        ...clip,
        points: clip.points
          .filter(c => c.birth === 0)
          .map(c => ({ ...c, death: null })),
        death: undefined,
        edits: clip.edits.slice(0, 1),
      };

  return pasted(world, v, clips.map(now), by, where);
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
