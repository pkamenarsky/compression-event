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
  OpSubtract,
  Ring,
  Shape,
  combine,
  contains,
  erode,
  isCCW,
  keeping,
  simplify,
  subtract,
  unionAll,
} from './geometry';
import {
  Clipping,
  EMPTY_TRANSFORM,
  Edit,
  Group,
  GroupId,
  Id,
  Vertex,
  Polygon,
  PolygonId,
  PolygonType,
  Transform,
  Version,
  VersionId,
  VertexId,
  World,
  enclosing,
  outermost,
  parentOf,
  standing,
  within,
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
  /**
   * The corners this version actually has, in ring order.
   *
   * Index for index with `local` and `source`. `polygon.points` is not: it
   * holds every corner the polygon has ever had, and which of them are standing
   * is a question about the version. Anything wanting the id of the corner it
   * is looking at reads this.
   */
  corners: Vertex[]
  /** The ring in the polygon's own frame: as drawn, plus every displacement
   * written at this version or before it. */
  local: Ring
  /** Every transform down the chain, composed. Takes `local` to `source`. */
  frame: Affine
  /** The ring this version's layer produced, in world units. The handles live
   * here. */
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
    points: wound.map((at, i) => ({ id: id + 1 + i, at: { ...at }, birth, death: null })),
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
/** A `Resolved` whose projection has not been taken yet. */
export function resolved(at: Omit<Resolved, 'shape'>): Resolved {
  let shape: Shape | null = null;

  return {
    ...at,
    get shape(): Shape {
      return shape ??= keeping(project(at.source, at.erosion), at.keep ?? []);
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

/** A world-space step as the frame `m` reads it. A direction and a distance,
 * so the frame's own translation is not part of the answer. */
export function unstep(m: Affine, dx: number, dy: number): Point {
  const o = unplace(m, { x: 0, y: 0 });
  const p = unplace(m, { x: dx, y: dy });

  return { x: p.x - o.x, y: p.y - o.y };
}

/**
 * A group's own frame at a version: its layer at every stage of the chain, and
 * every group holding it, in the order resolve applies them.
 *
 * The same walk `resolveAt` does for a polygon, without the geometry — a group
 * has none. What it is for is the bake: keeping a group's points in this rather
 * than in world units is what makes a turning group interpolate along its arc
 * instead of across the chord.
 */
export function groupFrame(world: World, v: VersionId, id: GroupId): Affine {
  let m = IDENTITY;

  for (const k of chain(world, v)) {
    const version = world.versions[k];

    m = compose(affine(version.edits.get(id)?.transform ?? EMPTY_TRANSFORM), m);
    m = compose(held(world, version, id), m);
  }

  return m;
}

export function resolveAt(world: World, v: VersionId): Resolved[] {
  const inherited = new Set(chain(world, v));

  // Where each corner stands in its polygon's own frame. A map rather than a
  // ring, because the ring is not a fixed length any more: corners arrive and
  // leave as the chain is walked, and only the ids hold still.
  const local = new Map<PolygonId, Map<VertexId, Point>>();
  const frame = new Map<PolygonId, Affine>();
  const depth = new Map<PolygonId, number>();

  for (const k of chain(world, v)) {
    const version = world.versions[k];
    const outer = new Map<Id, Affine>();

    for (const [id, polygon] of world.polygons) {
      if (polygon.birth === k) {
        local.set(id, new Map());
        frame.set(id, IDENTITY);
        depth.set(id, 0);
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
      }

      // After its own, and whether or not it has one of its own: what moves a
      // polygon at this version is not only what the version says about it.
      const up = parentOf(world).get(id);

      if (up === undefined) continue;

      const m = outer.get(up) ?? held(world, version, id);

      outer.set(up, m);
      frame.set(id, compose(m, frame.get(id)!));
    }
  }

  const out: Resolved[] = [];

  for (const [id, at] of local) {
    const polygon = world.polygons.get(id)!;
    const corners = polygon.points.filter(c => standing(c, inherited));

    // A polygon whose corners have all gone is not geometry any more. It cannot
    // happen through the editor, which will not take a ring below three, but
    // resolving is not the place to be sure of that.
    if (corners.length < 3) continue;

    const ring = corners.map(c => at.get(c.id) ?? { ...c.at });
    const erosion = depth.get(id) ?? 0;
    const m = frame.get(id)!;

    out.push(resolved({
      id,
      polygon,
      corners,
      local: ring,
      frame: m,
      source: place(m, ring),
      erosion,
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
 * The depth is seeded from what the polygon already resolved to, so that the
 * first thing written into a layer — a nudge, a move — does not also throw away
 * the erosion its base had.
 */
export function editAt(world: World, v: VersionId, id: Id, erosion: number): Edit {
  return world.versions[v].edits.get(id)
    ?? { transform: { ...EMPTY_TRANSFORM, erosion }, vertices: new Map() };
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
  const mine = new Map<Id, number>(resolveAt(world, v).map(it => [it.id, it.erosion]));
  const theirs = depths(world, v);

  return new Map(
    ids
      .filter(id => world.polygons.has(id) || world.groups.has(id))
      .map(id => [id, editAt(world, v, id, mine.get(id) ?? theirs.get(id) ?? 0)]),
  );
}

export function withEdit(world: World, v: VersionId, id: Id, edit: Edit): World {
  const versions = [...world.versions];
  const edits = new Map(versions[v].edits);

  edits.set(id, edit);
  versions[v] = { ...versions[v], edits };

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
 * is not a structure — it is the same member twice.
 *
 * Nothing is compensated. A new group's transform is identity at every version,
 * so its members are exactly where they were, which is the whole reason making
 * one is cheap and taking one apart is not.
 */
export function grouped(world: World, v: VersionId, ids: readonly Id[]): {
  world: World
  id: GroupId
} | null {
  const tops = [...new Set(ids.map(id => outermost(world, id)))];

  if (tops.length < 2) return null;

  const id = world.nextId;
  const groups = new Map(world.groups);

  groups.set(id, { birth: v, members: tops });

  return { world: { ...world, groups, nextId: id + 1 }, id };
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
      const was = edits.get(member) ?? { transform: EMPTY_TRANSFORM, vertices: new Map() };
      const now = composed(mine.transform, was.transform);

      if (now === null) return null;

      edits.set(member, { ...was, transform: now });
    }

    edits.delete(id);
    versions[k] = { ...versions[k], edits };
  }

  const groups = new Map(world.groups);
  const up = parentOf(world).get(id);

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

  return { ...world, groups, versions };
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
  kind: PolygonType
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
 */
export function depths(world: World, v: VersionId): Map<Id, number> {
  const out = new Map<Id, number>();

  for (const k of chain(world, v)) {
    for (const [id, edit] of world.versions[k].edits) {
      if (world.groups.has(id)) out.set(id, edit.transform.erosion);
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

  // At a version, a group with no depth on it is doing nothing at all, so it
  // hands its members over. The bake reads it differently, and has to — see
  // `Standing`.
  return contributed(world, items, id => {
    const d = depth.get(id) ?? 0;

    return d === 0 ? null : { depth: d };
  });
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
/**
 * The id a group's solid side goes by.
 *
 * A group holding a room and a pillar contributes to both sides of the set, and
 * one id names one contributor: the level union and the solid union have
 * different boundaries, take different tracks, and are told apart everywhere
 * downstream by nothing but this number. So the solid side gets one of its own.
 *
 * Negative, because ids come from a counter that only counts up, so nothing
 * authored can ever collide with one — and reversible, so what it belongs to
 * can always be read back.
 */
export function solidSide(id: GroupId): Id {
  return -(id + 1);
}

/** Whose solid side that is, or nothing where the id is an ordinary one. */
export function sidedWith(id: Id): GroupId | null {
  return id < 0 ? -id - 1 : null;
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
  const offer = (id: Id, kind: PolygonType): Shape => {
    const it = mine.get(id);

    if (it !== undefined) return it.polygon.type === kind ? it.shape : [];

    const group = world.groups.get(id);

    if (group === undefined) return [];

    const key = `${id}:${kind}`;
    const known = held?.get(key);

    if (known !== undefined) return known;

    const all = unionAll(group.members.map(m => offer(m, kind)));
    const d = standing(id)?.depth ?? 0;

    // The walls go the other way, and this is not a choice — it is what
    // eroding the group as one shape *means*. What the group puts into the
    // level is `level - solid`, and pulling that boundary in by `d` pulls it
    // in around the holes too, which is the holes getting bigger:
    //
    //   erode(A - B, d) = erode(A, d) - erode(B, -d)
    //
    // exactly, since eroding a complement is dilating. The two sides have to
    // be kept apart for the CSG — a group's walls cut the rooms around it, not
    // only its own — so the identity is what lets them be eroded apart and
    // still come out as though they had been eroded together. A pillar shrunk
    // along with its room leaves a gap that never narrows.
    const depth = kind === 'solid' ? -d : d;
    const out = depth === 0 || all.length === 0 ? all : erode(all, depth);

    held?.set(key, out);

    return out;
  };

  const emit = (id: Id): void => {
    const it = mine.get(id);

    if (it !== undefined) {
      out.push({
        id,
        kind: it.polygon.type,
        shape: it.shape,
        frame: it.frame,
        simple: it.erosion !== 0,
        keep: it.keep,
      });

      return;
    }

    const how = standing(id);

    if (world.groups.get(id) === undefined || how === null) return;

    for (const kind of ['level', 'solid'] as const) {
      const shape = offer(id, kind);

      if (shape.length !== 0) {
        out.push({
          id: kind === 'solid' ? solidSide(id) : id,
          kind,
          shape,
          frame: how.frame ?? IDENTITY,
          simple: true,
        });
      }
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
    const up = enclosing(world, it.id).filter(g => standing(g) !== null);

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
  kind: PolygonType
  shape: Shape
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
  const sides = new Map<GroupId, { level: Shape, solid: Shape }>();

  for (const c of showing(world, v, items, path)) {
    const id = sidedWith(c.id) ?? c.id;

    if (!world.groups.has(id)) continue;

    const side = sides.get(id) ?? { level: [], solid: [] };

    sides.set(id, { ...side, [c.kind]: c.shape });
  }

  const out: Occupied[] = [];

  for (const [id, { level, solid }] of sides) {
    out.push(level.length === 0
      ? { id, kind: 'solid', shape: solid }
      : { id, kind: 'level', shape: solid.length === 0 ? level : subtract(level, solid) });
  }

  return out;
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

  return enclosing(world, id).some(g => !open.has(g));
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
  return items.map(it => ({
    id: it.id,
    kind: it.polygon.type,
    shape: it.shape,
    frame: it.frame,
    keep: it.keep,

    // A projection at any depth came out of an arrangement and is already
    // simple. At depth zero it is the source ring as drawn, which is allowed
    // to cross itself.
    simple: it.erosion !== 0,
  }));
}

/**
 * The set the game would get — every `level` unioned, every `solid` taken out —
 * as the open runs its outline is made of.
 *
 * Runs rather than rings because that is what can be kept up to date: a run
 * belongs to one polygon, so an edit only disturbs the polygons it overlaps.
 * See `worldset.ts`. Nothing that reads this wants a closed loop — the overlay
 * is stroked, and collision is edge-normal based.
 */
export function csg(world: World, v: VersionId): Point[][] {
  return runs(live(EMPTY_LIVE, contributing(world, v, resolveAt(world, v))));
}

/**
 * The set, held on to between draws so that redrawing costs only what actually
 * moved. Rebuilding it from nothing is O(n) in polygons and measured at nearly
 * two seconds for ten thousand of them; bringing it up to date after a dragged
 * vertex is about a millisecond.
 */
export interface Live {
  set: WorldSet
  /** What each contributor resolved to when the set was last brought up to
   * date. A group with a depth on it is one of them; its members are not. */
  seen: Map<Id, Contributed>
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
export function live(previous: Live, items: readonly Contributed[]): Live {
  const edits: SetEdit[] = [];
  const seen = new Map<Id, Contributed>();

  for (const it of items) {
    seen.set(it.id, it);

    const was = previous.seen.get(it.id);
    const retyped = was !== undefined && was.kind !== it.kind;

    if (was !== undefined && !retyped && unmoved(was.shape, it.shape)) continue;

    // A retype has to go in as an insert: an update keeps the kind it had.
    edits.push(
      was === undefined || retyped
        ? { op: 'insert', id: it.id, type: it.kind, shape: it.shape, simple: it.simple }
        : { op: 'update', id: it.id, shape: it.shape, simple: it.simple },
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
  return hitPolygons(items, at)[0] ?? null;
}

/** Every polygon under a point, topmost first, which is what clicking through
 * a stack of them needs. */
export function hitPolygons(items: Resolved[], at: Point): PolygonId[] {
  const out: PolygonId[] = [];

  for (let i = items.length - 1; i >= 0; i--) {
    if (contains(items[i].shape, at)) out.push(items[i].id);
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
  items: Resolved[],
  at: Point,
  radius: number,
): Grabbed | null {
  let best: Grabbed | null = null;
  let bestDistance = radius;

  for (const it of items) {
    it.source.forEach((p, index) => {
      const d = Math.hypot(p.x - at.x, p.y - at.y);

      if (d <= bestDistance) {
        bestDistance = d;
        best = { id: it.id, index, vertex: it.corners[index].id };
      }
    });
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
      const on = along(ring[i], ring[(i + 1) % ring.length], at);
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
export function verticesWithinBox(items: Resolved[], a: Point, b: Point): VertexId[] {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  const out: VertexId[] = [];

  for (const it of items) {
    it.source.forEach((p, i) => {
      if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) {
        out.push(it.corners[i].id);
      }
    });
  }

  return out;
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
  const next = (index + 1) % it.corners.length;
  const t = fraction(it.source[index], it.source[next], at);

  const from = it.corners[index].at, to = it.corners[next].at;
  const vertex = world.nextId;

  const corner: Vertex = {
    id: vertex,
    at: {
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
    },
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

  const edit = placeVertex(now, editAt(grown, v, it.id, now.erosion), where, at);

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
export function removeVertices(
  world: World,
  v: VersionId,
  going: Iterable<VertexId>,
): World {
  const gone = new Set(going);

  if (gone.size === 0) return world;

  const inherited = new Set(chain(world, v));
  const polygons = new Map(world.polygons);
  let changed = false;

  for (const [id, polygon] of world.polygons) {
    const here = polygon.points.filter(c => standing(c, inherited));
    const taking = here.filter(c => gone.has(c.id));

    if (taking.length === 0 || here.length - taking.length < 3) continue;

    const points = polygon.points.flatMap(c => {
      if (!gone.has(c.id) || !standing(c, inherited)) return [c];

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
 */
export function copied(world: World, v: VersionId, ids: readonly Id[]): Clipping[] {
  const items = new Map(resolveAt(world, v).map(it => [it.id, it]));
  const deep = depths(world, v);
  const inherited = new Set(chain(world, v));

  /** What a version's layer says, as the copy will say it. */
  const layers = (id: Id, m: Affine | null, erosion: number): [number, Edit][] => {
    const out: [number, Edit][] = [[0, {
      transform: { ...EMPTY_TRANSFORM, erosion },
      vertices: new Map(),
    }]];

    for (let k = v + 1; k < world.versions.length; k++) {
      const edit = world.versions[k].edits.get(id);

      if (edit === undefined) continue;

      out.push([k - v, {
        transform: { ...edit.transform, translation: { ...edit.transform.translation } },
        vertices: m === null
          ? new Map()
          : new Map([...edit.vertices].map(([id, d]) => [id, pointing(m, d)])),
      }]);
    }

    return out;
  };

  const clip = (id: Id): Clipping[] => {
    const group = world.groups.get(id);

    if (group !== undefined) {
      const members = group.members.flatMap(clip);

      return members.length === 0 ? [] : [{
        kind: 'group',
        members,
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
        birth: source.has(corner.id) ? 0 : corner.birth - v,
        death: corner.death === null ? null : corner.death - v,
      }));

    return [{
      kind: 'polygon',
      type: it.polygon.type,
      points,
      edits: layers(id, it.frame, it.erosion),
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
  by: Point | null,
): World {
  let out = world;

  for (const [offset, edit] of edits) {
    // Past the end of the chain, and there is nowhere for it to go. See the
    // note on `pasted`.
    if (v + offset >= world.versions.length) break;

    const at = edit.transform.translation;
    const moved = offset === 0 && by !== null;

    out = withEdit(out, v + offset, id, {
      transform: moved
        ? { ...edit.transform, translation: { x: at.x + by.x, y: at.y + by.y } }
        : edit.transform,
      vertices: new Map([...edit.vertices].map(([v, d]) => [renamed.get(v) ?? v, d])),
    });
  }

  return out;
}

/** One clipping put back at `v`, and everything under it. The offset lands on
 * the outermost thing only: what is inside a group is placed by the group. */
function restore(
  world: World,
  v: VersionId,
  clip: Clipping,
  by: Point | null,
): { world: World, id: Id } {
  if (clip.kind === 'group') {
    const members: Id[] = [];
    let out = world;

    for (const member of clip.members) {
      const put = restore(out, v, member, null);

      out = put.world;
      members.push(put.id);
    }

    const id = out.nextId;
    const groups = new Map(out.groups);

    groups.set(id, { birth: v, members });
    out = { ...out, groups, nextId: id + 1 };

    return { world: written(out, v, id, clip.edits, new Map(), by), id };
  }

  const id = world.nextId;
  const renamed = new Map<VertexId, VertexId>();
  const points = clip.points
    .filter(corner => v + corner.birth < world.versions.length)
    .map((corner, i) => {
      renamed.set(corner.id, id + 1 + i);

      return {
        id: id + 1 + i,
        at: { ...corner.at },
        birth: v + corner.birth,
        death: corner.death === null || v + corner.death >= world.versions.length
          ? null
          : v + corner.death,
      };
    });

  const polygons = new Map(world.polygons);

  polygons.set(id, { type: clip.type, birth: v, points });

  const out = {
    ...world,
    polygons,
    nextId: id + 1 + points.length,
  };

  return { world: written(out, v, id, clip.edits, renamed, by), id };
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
): { world: World, ids: Id[] } {
  const ids: Id[] = [];
  let out = world;

  for (const clip of clips) {
    const put = restore(out, v, clip, by);

    out = put.world;
    ids.push(put.id);
  }

  return { world: out, ids };
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
 * leaving. What either was for is not happening here.
 */
export function stamped(
  world: World,
  v: VersionId,
  clips: readonly Clipping[],
  by: Point,
): { world: World, ids: Id[] } {
  const now = (clip: Clipping): Clipping => clip.kind === 'group'
    ? { ...clip, members: clip.members.map(now), edits: clip.edits.slice(0, 1) }
    : {
        ...clip,
        points: clip.points
          .filter(c => c.birth === 0)
          .map(c => ({ ...c, death: null })),
        edits: clip.edits.slice(0, 1),
      };

  return pasted(world, v, clips.map(now), by);
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
