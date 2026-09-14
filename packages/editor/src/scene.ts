// -----------------------------------------------------------------------------
// What the world looks like at a keyframe
//
// A thing is its rest geometry and a timeline: a list of operations per
// keyframe, played from its birth — see `rig.ts`. Nothing is inherited and
// nothing is replayed by hand: an operation written at v0 is seen at v4 because
// v4 is v0's operations and then some, played again.
//
// Resolution is a read of the timelines:
//
//   local(k)  = rest + nudges up to k
//   source(k) = (every holder's frame at k) o frame(k), over local(k)
//   shape(k)  = erode(source(k), depth(k))
//
// so `source` is what the handles are on and `shape` is a read-only view taken
// at each keyframe. The next keyframe erodes source(k + 1), never shape(k), and
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
// swung about the difference. An operation turns about a point it painted onto
// the thing when it was written, and carries that point from then on.
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
  KeyframeId,
  Timed,
  Unrolled,
  VertexId,
  World,
  enclosing,
  clickable,
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
import { Affine, IDENTITY, compose, place, unplace } from './affine';
import {
  EMPTY_RIG,
  Entry,
  Erode,
  Frame,
  Move,
  Op,
  REST,
  merged,
  Rig,
  Scale,
  Source,
  Stand,
  Turn,
  affineOf,
  appending,
  deepened,
  framed,
  heldFrame,
  indexIn,
  linear,
  nudged,
  once,
  placed,
  playedAt,
  played,
  sheared,
  skipping,
  sourcesAt,
  spun,
  stepped,
  stateAt,
  trivial,
  unsheared,
  withKeys,
  worldFrame,
} from './rig';

export type { Affine };
export { IDENTITY, compose, place, unplace };

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
  /** The depth `shape` was taken at: what its erosions add up to. */
  erosion: number
  /**
   * The extra depth on single corners, by id, as this keyframe leaves it, and
   * empty in every world nobody has offset a corner of.
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
  birth: KeyframeId,
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
 * Whether a thing is one of the world's at a keyframe: born into one of the
 * keyframes in `from`, and not taken out by one.
 *
 * The whole of what existence means here, and the one place that says so. A
 * group is there wherever anything it holds is: it has no life of its own, the
 * structure being one fact about every keyframe. See `Group`.
 */
export function standingIn(world: World, id: Id, from: ReadonlySet<KeyframeId>): boolean {
  const group = world.groups.get(id);

  if (group !== undefined) return group.members.some(m => standingIn(world, m, from));

  const own = lived(world, id);

  return own !== undefined && standing(own, from);
}

/**
 * The stretch of the keyframes `id` stands over, for anything that has one:
 * a polygon, an artefact, a path. A group has none.
 */
function lived(world: World, id: Id): { birth: KeyframeId, death: KeyframeId | null } | undefined {
  return world.polygons.get(id) ?? world.artefacts.get(id) ?? world.paths.get(id);
}

/**
 * Where an artefact stands at a version, or nothing if it is not there yet.
 *
 * Its own point taken through every transform down the chain, which is the same
 * walk `resolveAt` does for a polygon's ring and is already written: an
 * artefact is in the version's layers like anything else, so `groupFrame`
 * answers for it without knowing what it is.
 */
export function placeAt(world: World, id: ArtefactId, v: KeyframeId): Point | null {
  const it = world.artefacts.get(id);

  if (it === undefined || !standingIn(world, id, new Set(chain(world, v)))) return null;

  return place(groupFrame(world, v, id), [it.at])[0];
}

/** Which way it is pointing at a version, or nothing if it is not there. */
export function facingAt(world: World, id: ArtefactId, v: KeyframeId): number | null {
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
export function shownAt(world: World, v: KeyframeId): Placed[] {
  return [startPlaced(world), ...artefactsAt(world, v)];
}

/** Everything standing at a version, in id order. */
export function artefactsAt(world: World, v: KeyframeId): Placed[] {
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
  v: KeyframeId,
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
export function pathAt(world: World, id: PathId, v: KeyframeId): Point[] | null {
  return laidAt(world, id, v)?.points ?? null;
}

/** The same, with the frame it was placed by — which is what anything writing
 * a point back wants, and the reason `Laid` carries one. */
export function laidAt(world: World, id: PathId, v: KeyframeId): Laid | null {
  const it = world.paths.get(id);

  if (it === undefined || !standingIn(world, id, new Set(chain(world, v)))) return null;

  const frame = groupFrame(world, v, id);

  return { id, points: place(frame, it.points), frame };
}

/** Every path standing at a version, in id order. */
export function pathsAt(world: World, v: KeyframeId): Laid[] {
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

/**
 * The keyframes from the first down to `v`, in the order they play.
 *
 * What existence is asked against: a thing stands at `v` if it was born into
 * one of these and not taken out by one. Membership rather than `<=`, because
 * the order is the array and an id is not a position in it.
 */
export function chain(world: World, v: KeyframeId): KeyframeId[] {
  const i = indexIn(world.keyframes, v);

  return world.keyframes.slice(0, i + 1).map(k => k.id);
}

/** Where a keyframe is in the order. What anything counting across keyframes
 * counts in. */
export function order(world: World, v: KeyframeId): number {
  return indexIn(world.keyframes, v);
}

/** The keyframe at a place in the order, or nothing past either end. */
export function keyAt(world: World, i: number): KeyframeId | null {
  return world.keyframes[i]?.id ?? null;
}

// -----------------------------------------------------------------------------
// Frames
//
// A nudge is written in the polygon's rest frame and its frame carries it,
// which is the only reading under which a polygon is one shape: nudge a corner
// at v3, turn the polygon at v0, and the corner stays where it was put relative
// to its neighbours rather than swinging out of the ring.
//
// A thing's own frame is always a translation, an angle, a skew and a scale
// along its own axes — every operation keeps it so. What places it in the
// world is that, composed with the frame of every group holding it: a group
// squashed across a member turned against it shears it there, and the skew is
// how the member's own frame says so once the group is gone. Nothing
// interpolates the composition, so nothing has to mind.
// -----------------------------------------------------------------------------

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
export function landing(world: World, v: KeyframeId, inside: GroupId | null): Landing {
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
 * The frame a thing's own frame at `v` is read in: every group holding it, at
 * that keyframe, in world units.
 *
 * What a polygon's own operations do happens *inside* whatever its groups are
 * doing, and their numbers are not in world units — a move of (10, 0) on a
 * polygon inside a group turned a quarter turn moves it ten units *down* the
 * screen.
 *
 * Anything writing an operation from a gesture therefore has to take the
 * cursor back through this first, or it is answering a question asked in world
 * units with a number that will be read in another frame entirely. The centre
 * of a turn is the case that shows it worst: left alone, a polygon inside a
 * turned group spins about a point that is nowhere near it.
 */
export function under(world: World, v: KeyframeId, id: Id): Affine {
  return heldFrame(world, id, v);
}

/**
 * The frame a thing newly put inside `into` at `v` is placed by: the group's
 * own frame there, and everything holding the group.
 *
 * `under` answers this for something already in the world, off its own
 * enclosing groups. A paste has nothing to ask about yet — the thing does not
 * exist and is about to be built to fit — so the same walk is done one step
 * early.
 */
export function inward(world: World, v: KeyframeId, into: GroupId): Affine {
  return worldFrame(world, into, v);
}

/** A world-space step as the frame `m` reads it. A direction and a distance,
 * so the frame's own translation is not part of the answer. */
export function unstep(m: Affine, dx: number, dy: number): Point {
  const o = unplace(m, { x: 0, y: 0 });
  const p = unplace(m, { x: dx, y: dy });

  return { x: p.x - o.x, y: p.y - o.y };
}

/**
 * The frame a thing is placed by at a keyframe: its own, and every group
 * holding it.
 *
 * What `resolveAt` puts in `Resolved.frame`, for the things that have no ring
 * to hang one on. A group has none, an artefact has a point, a path has a run
 * of them. What it is also for is the bake: keeping a group's points in this
 * rather than in world units is what makes a turning group interpolate along
 * its arc instead of across the chord.
 *
 * Anything the world does not hold — the sides `sideOf` mints, and anything
 * asking about an id the world has lost — is at rest, and so is anything
 * before it is born.
 */
export function groupFrame(world: World, v: KeyframeId, id: Id): Affine {
  return worldFrame(world, id, v);
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
 * keyframes, because an unchained polygon answers it differently: what its
 * stand froze is standing whatever was said about where it was born. See
 * `Stand` in `rig.ts`.
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

/**
 * Every polygon as keyframe `v` leaves it.
 *
 * In the order they were born into the keyframes, and then in the order they
 * were made. That is the order they are drawn in, so what a click picks on top
 * is what is drawn on top.
 */
export function resolveAt(world: World, v: KeyframeId): Resolved[] {
  const from = new Set(chain(world, v));
  const born = (p: Polygon): number => order(world, p.birth);
  const out: Resolved[] = [];

  const here = [...world.polygons]
    .filter(([id]) => standingIn(world, id, from))
    .sort(([, p], [, q]) => born(p) - born(q));

  for (const [id, polygon] of here) {
    const state = stateAt(world, id, v);
    const corners = surviving(polygon.points, c => state.corners.has(c.id));

    // A polygon whose outline has gone is not geometry any more. It cannot
    // happen through the editor, which will not take a ring below three, but
    // resolving is not the place to be sure of that.
    if (corners.length < 3) continue;

    const local = corners.map(c => state.corners.get(c.id)!);
    const frame = worldFrame(world, id, v);

    out.push(resolved({
      id,
      polygon,
      corners,
      local,
      frame,
      source: place(frame, local),
      erosion: state.erosion,
      over: state.depths,
      depths: varying(corners, state.erosion, state.depths),
    }));
  }

  return out;
}

// -----------------------------------------------------------------------------
// Editing
//
// You edit the keyframe you are standing in, and what is written there plays
// from there on. There is no way to author an operation that lands earlier than
// the keyframe on screen, so if something is wrong at v0, go to v0 and fix it,
// and watch the consequences downstream with ghosts.
//
// A gesture adds one operation to the end of the keyframe's list for each thing
// it moves, and works it out again from the list it started with every time
// the hand moves — so it cannot drift, and letting go leaves one entry however
// long it went on. See `appending` in `rig.ts` for when it folds into the
// entry before it instead.
// -----------------------------------------------------------------------------

/** Everything written about a thing, or nothing. */
export function rigOf(world: World, id: Id): Rig {
  return world.rigs.get(id) ?? EMPTY_RIG;
}

/** A thing's timeline replaced. One with nothing in it is taken out. */
export function withRig(world: World, id: Id, rig: Rig): World {
  const rigs = new Map(world.rigs);

  if (rig.keys.size === 0 && rig.nudges.size === 0 && rig.depths.size === 0) rigs.delete(id);
  else rigs.set(id, rig);

  return { ...world, rigs };
}

/** What keyframe `v` does to a thing, in order. */
export function listAt(world: World, v: KeyframeId, id: Id): readonly Entry[] {
  return rigOf(world, id).keys.get(v) ?? [];
}

/** `k`'s list for `id`, written outright. A bare operation happens once. */
export function keyed(world: World, k: KeyframeId, id: Id, list: readonly (Op | Entry)[]): World {
  const entries = list.map(e => ('op' in e ? e : once(e)));

  return withRig(world, id, withKeys(rigOf(world, id), k, entries));
}

/** One operation more at the end of what `v` does to `id`, folded into the one
 * before where the two are exactly one. */
export function appended(world: World, v: KeyframeId, id: Id, op: Op | Entry): World {
  const list = listAt(world, v, id);
  const now = appending(list, 'op' in op ? op : once(op));

  return now === list ? world : withRig(world, id, withKeys(rigOf(world, id), v, now));
}

/**
 * Where a thing's middle is, as an operation written now paints it.
 *
 * `ref` is the middle of what it is on screen as, taken back through its frame
 * into its rest frame: from here on it is just a point of the thing. `at` is
 * where that point is in the frame the thing is held in, which is what an
 * operation's anchor and slide are measured from. `held` is that frame, for
 * taking the cursor into it.
 */
export interface Painted {
  ref: Point
  at: Point
  frame: Frame
  held: Affine
}

export function painted(world: World, v: KeyframeId, id: Id, items?: readonly Resolved[]): Painted {
  const frame = stateAt(world, id, v).frame;
  const ref = unplace(worldFrame(world, id, v), middleOf(world, v, id, items));

  return { ref, at: placed(frame, ref), frame, held: under(world, v, id) };
}

/**
 * The middle of what a thing is on screen as, at a keyframe.
 *
 * A group is what it is drawn as, shut: the union its members make, with
 * whatever is held inside it. A lone polygon is its own outline, and an
 * artefact is its point.
 *
 * `all` is the keyframe resolved, where the caller has it already: a gesture
 * over a selection asks this once for everything picked.
 */
export function middleOf(
  world: World,
  v: KeyframeId,
  id: Id,
  all: readonly Resolved[] = resolveAt(world, v),
): Point {
  if (world.artefacts.has(id)) return placeAt(world, id, v) ?? { x: 0, y: 0 };
  if (world.paths.has(id)) return middle(pathAt(world, id, v) ?? []);

  const reached = new Set(polygonsIn(world, [id]));
  const items = all.filter(it => reached.has(it.id));
  const open = opened(world, parentOf(world).get(id) ?? null);

  const places = artefactsIn(world, [id]).flatMap(a => {
    const at = placeAt(world, a, v);

    return at === null ? [] : [at];
  });

  const walks = pathsIn(world, [id]).flatMap(p => pathAt(world, p, v) ?? []);
  const drawn = items.length === 0 ? [] : outlining(world, v, items, open);

  return middle([...drawn, ...places, ...walks]);
}

/** A move by a world-space step, as the thing's holder reads it. */
export function moveOf(p: Painted, by: Point): Move {
  return { kind: 'move', by: unstep(p.held, by.x, by.y) };
}

/** A turn about a world-space centre. */
export function turnOf(p: Painted, centre: Point, angle: number): Turn {
  const c = unplace(p.held, centre);

  return { kind: 'turn', angle, ref: p.ref, about: { x: c.x - p.at.x, y: c.y - p.at.y } };
}

/**
 * A stretch along the thing's own axes about a world-space centre: exactly
 * where scaling about it would have slid the thing, written down as a slide.
 */
export function scaleOf(p: Painted, centre: Point, by: { x: number, y: number }): Scale {
  const c = unplace(p.held, centre);
  const along = p.frame.angle, lean = p.frame.skew;
  const w = unsheared({ x: c.x - p.at.x, y: c.y - p.at.y }, along, lean);

  return {
    kind: 'scale',
    by,
    ref: p.ref,
    shift: sheared({ x: (1 - by.x) * w.x, y: (1 - by.y) * w.y }, along, lean),
    along,
    lean,
  };
}

// -----------------------------------------------------------------------------
// Editing one entry
//
// The gesture its kind is written by, read against the thing as that entry
// leaves it and about the entry's own anchor, so that what the hand does is
// the same kind of operation about the same centre — and folds into the entry
// exactly, the way a hand repeating itself does. See `merged` in `rig.ts`.
// -----------------------------------------------------------------------------

/** Where a thing is at keyframe `k` just before `entry` plays there, and just
 * after. Nothing where it is not one of `k`'s. */
export function around(world: World, k: KeyframeId, id: Id, entry: Entry): { before: Frame, after: Frame } | null {
  const i = order(world, k);
  let frame = i > 0 ? stateAt(world, id, world.keyframes[i - 1].id).frame : REST;
  const sources = sourcesAt(world, id, k);
  const ops = playedAt(world, id, k);

  for (let j = 0; j < ops.length; j++) {
    if (sources[j].entry === entry && sources[j].step === 0) return { before: frame, after: played(frame, ops[j]) };

    frame = played(frame, ops[j]);
  }

  return null;
}

/**
 * What an edit of `entry` is read against: the thing painted as the entry
 * leaves it, at the entry's own painted point, and the centre it acts about in
 * world units — a turn's anchor, the one point a scale leaves where it was, or
 * where the thing is for a move or an erosion, which have none.
 */
export function editedAt(world: World, k: KeyframeId, id: Id, entry: Entry): { paint: Painted, pivot: Point } | null {
  const frames = around(world, k, id, entry);

  if (frames === null) return null;

  const op = entry.op;
  const held = under(world, k, id);
  const ref = op.kind === 'turn' || op.kind === 'scale' ? op.ref : painted(world, k, id).ref;
  const was = placed(frames.before, ref);
  const paint = { ref, at: placed(frames.after, ref), frame: frames.after, held };

  let centre = paint.at;

  if (op.kind === 'turn') {
    centre = { x: was.x + op.about.x, y: was.y + op.about.y };
  }
  else if (op.kind === 'scale') {
    // The slide is `(I − M)(c − p)` along its axes: undone axis by axis, and
    // the painted point on an axis it does not stretch.
    const w = unsheared(op.shift, op.along, op.lean);
    const along = (d: number, by: number) => (Math.abs(1 - by) < 1e-9 ? 0 : d / (1 - by));
    const c = sheared({ x: along(w.x, op.by.x), y: along(w.y, op.by.y) }, op.along, op.lean);

    centre = { x: was.x + c.x, y: was.y + c.y };
  }

  return { paint, pivot: place(held, [centre])[0] };
}

/**
 * The entry at `index` of `k`'s list with `op` folded into it: what it did,
 * and then `op`, as one entry repeating as it did. Taken out where the two
 * come to nothing, and left alone where they are not one — which an edit read
 * by `editedAt` never is.
 */
export function refolded(world: World, k: KeyframeId, id: Id, index: number, op: Op): World {
  const list = listAt(world, k, id);
  const e = list[index];

  if (e === undefined) return world;

  // Along the axes the entry was written along, which only its repeats read.
  const also = e.op.kind === 'scale' && op.kind === 'scale' ? { ...op, along: e.op.along, lean: e.op.lean } : op;
  const both = merged(e, { ...e, op: also });

  if (both === null) return world;

  const now = both === 'gone' ? list.filter((_x, i) => i !== index) : list.map((x, i) => (i === index ? both : x));

  return withRig(world, id, withKeys(rigOf(world, id), k, now));
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

// -----------------------------------------------------------------------------
// Unchaining
//
// Everything above this line is about a thing's past reaching its future: an
// operation at v0 is seen at v8, and that is what the document is for. This is
// the one thing that says no to it, for one thing at a time.
//
// An unchained polygon keeps its id, its corners, its groups and everything
// ever written about it. What changes is that the keyframe it was unchained at
// starts again from a stand — the state that keyframe's own list was about to
// be played over, said outright — so it looks identical the second after, and
// stays where it is when v0 is dragged the day after.
//
// Why a copy and not an inverse
// -----------------------------
// The obvious reading of "cut it loose here" is to write the inverse of
// everything upstream into this keyframe, so the two cancel. They do — once.
// Edit upstream and the inverse no longer inverts it, and the change comes
// through as the difference between them, which is worse than it coming
// through whole. And there is no inverse for what is not a frame: a corner
// nudged upstream, deleted, added, a depth. All of those have to stop too.
//
// So what is written down is the state, and `Stand` is the shape of it: the
// frame, where each corner stood, which corners there were, and the depths.
//
// What still comes through is what repeats. A spin written at v0 to go on for
// ever is a thing the room is doing, and a stand that stopped it would change
// what is on screen from the keyframe after — so its steps go on, and only
// what it had already done is held.
//
// Rechaining
// ----------
// Take the stand out. The thing goes back to hearing its past and jumps to
// wherever that says it now is — which may be nowhere near where it was
// sitting, if upstream has moved on since. That is the answer, and a coherent
// one: nothing is inverted and nothing is guessed at.
//
// What is *not* unchained
// -----------------------
// Existence. A polygon deleted at v1 is gone at v6 whether or not it was
// unchained at v4, and one drawn at v1 is not around before it. Birth and death
// are one fact about a thing — see `standing`.
//
// Nor what holds it. A member unchained stands still in its group's frame, and
// goes on going where the group goes; to hold it still in the world, unchain
// the group, which takes its members with it — a group is a frame and a union
// of what its members resolve to, and unchaining the frame alone would leave
// every nudge inside it still coming through.
// -----------------------------------------------------------------------------

/**
 * Whether `v` unchains `id`: whether its list there has a stand in it, and it
 * was there at the keyframe before to stop hearing from.
 *
 * Not where it begins, where a stand is where a pasted thing starts rather
 * than anything it stopped hearing — see `restore`.
 */
export function unchainedAt(world: World, v: KeyframeId, id: Id): boolean {
  const base = keyAt(world, order(world, v) - 1);

  return base !== null
    && standingIn(world, id, new Set(chain(world, base)))
    && listAt(world, v, id).some(e => e.op.kind === 'stand');
}

/**
 * Whether unchaining `ids` at `v` would say anything.
 *
 * The gesture is offered for a selection where any of it is — one already
 * unchained here beside one that is not is not a reason to refuse.
 */
export function unchainable(world: World, v: KeyframeId, ids: readonly Id[]): boolean {
  return reaches(world, v, ids).some(id => !unchainedAt(world, v, id));
}

/** Whether rechaining `ids` at `v` would say anything. */
export function rechainable(world: World, v: KeyframeId, ids: readonly Id[]): boolean {
  return reaches(world, v, ids).some(id => unchainedAt(world, v, id));
}

/**
 * Everything under `ids` that a stand at `v` could be about: standing here,
 * standing at the keyframe before, and not born here.
 *
 * Born here is left out because there is nothing to unchain — a thing born at
 * `v` hears nothing from before it.
 */
function reaches(world: World, v: KeyframeId, ids: readonly Id[]): Id[] {
  const base = keyAt(world, order(world, v) - 1);

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
 * The state `v`'s own list is played over: the keyframe before, and the steps
 * whatever repeats took at `v`. What a stand at the head of the list has to say
 * for nothing to move.
 *
 * The corners are read at `v` itself, less what `v` nudges them by — a corner's
 * nudges have no place in the list, and the ones written at a stand's own
 * keyframe are played over it. See `rig.ts`.
 */
export function handed(world: World, v: KeyframeId, id: Id): Stand {
  const base = keyAt(world, order(world, v) - 1);
  const before = base === null ? stateAt(world, id, v) : stateAt(world, id, base);
  const all = playedAt(world, id, v);
  const steps = base === null ? [] : all.slice(0, all.length - listAt(world, v, id).length);

  let frame = base === null ? REST : before.frame;
  let erosion = base === null ? 0 : before.erosion;

  for (const op of steps) {
    if (op.kind === 'erode') erosion += op.by;
    else frame = played(frame, op);
  }

  const here = stateAt(world, id, v);
  const rig = rigOf(world, id);

  const corners = new Map([...here.corners].map(([c, p]) => {
    const own = rig.nudges.get(c)?.get(v)?.op.by;

    return [c, own === undefined ? p : { x: p.x - own.x, y: p.y - own.y }];
  }));

  const depths = new Map<VertexId, number>();

  for (const [c, d] of here.depths) {
    const left = d - (rig.depths.get(c)?.get(v)?.op.by ?? 0);

    if (left !== 0) depths.set(c, left);
  }

  return { kind: 'stand', frame, erosion, corners, depths };
}

/**
 * `ids` cut loose from everything before `v`, and everything under them.
 *
 * What each one's list at `v` was about to be played over goes at the head of
 * that list as a stand, so nothing moves: the same numbers are now stated
 * rather than heard. From here on an edit upstream is invisible to them, and
 * an edit here or later reads exactly as it did.
 *
 * The world unchanged where there is nothing to say — at the first keyframe,
 * which has nothing before it to stop hearing, and for a selection every part
 * of which is already unchained here.
 */
export function unchained(world: World, v: KeyframeId, ids: readonly Id[]): World {
  const going = reaches(world, v, ids).filter(id => !unchainedAt(world, v, id));
  let out = world;

  for (const id of going) out = keyed(out, v, id, [once(handed(world, v, id)), ...listAt(out, v, id)]);

  return out;
}

/**
 * `ids` chained back up at `v`: the stands written there taken out again, and
 * everything under them.
 *
 * Only the ones at `v`. A thing unchained twice, at v2 and at v6, is chained
 * back up one point at a time, standing where the point is — which is the only
 * reading that lets the two be undone separately.
 *
 * What comes back is what its past says now, which is not necessarily what it
 * said when the stand was written. That is the whole of what was being held
 * off, arriving.
 */
export function rechained(world: World, v: KeyframeId, ids: readonly Id[]): World {
  const going = reaches(world, v, ids).filter(id => unchainedAt(world, v, id));
  let out = world;

  for (const id of going) out = keyed(out, v, id, listAt(out, v, id).filter(e => e.op.kind !== 'stand'));

  return out;
}

// -----------------------------------------------------------------------------
// Grouping
//
// Structure is global and the timelines are per thing, so making a group is a
// change to the world and moving one is an entry on the group's timeline. What
// that costs is all at the other end: taking a group apart has to leave its
// members where they are *at every keyframe*, and there is no single frame to
// bake in, because the group's own differs from one keyframe to the next.
// -----------------------------------------------------------------------------

/**
 * A new group over `ids`, born into the keyframe on screen.
 *
 * Only what is not already held: grouping something with a thing it is already
 * inside means grouping what holds it, and grouping a group with its own member
 * is not a structure — it is the same member twice. Drilled into a group and
 * picking everything in it is the same refusal wearing a different hat.
 *
 * Nothing is compensated. A new group's frame is the identity at every
 * keyframe, so its members are exactly where they were, which is the whole
 * reason making one is cheap and taking one apart is not.
 */
export function grouped(
  world: World,
  v: KeyframeId,
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

  groups.set(id, { members: tops, sealed: false });

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
 * keyframe.
 *
 * The group's frame differs per keyframe, so there is no one frame to bake into
 * the members: baking the keyframe on screen would hold them still where the
 * author is standing and shift them everywhere else. So the group is folded
 * into each member, keyframe by keyframe — see `folded`.
 *
 * A group squashed across a member turned against it shears the member in the
 * world, and the member's frame says so in its skew. Nothing only where the
 * fold would not land a member where it was, which no frame that does not
 * mirror gives it cause to; it is refused whole rather than in part, since half
 * an ungroup would leave the members displaced at the keyframes it could not
 * do.
 */
export function ungrouped(world: World, id: GroupId): World | null {
  return ungrouping(world, id)?.world ?? null;
}

/**
 * The same, and the repeats that had to be taken apart into single entries to
 * do it. See `carried`.
 *
 * Tried keeping every repeat the fold can keep first, and checked; should that
 * ever not land everything where it was, the whole thing again with every
 * repeat taken apart, which is exact by construction.
 */
export function ungrouping(world: World, id: GroupId): { world: World, unrolled: Unrolled[] } | null {
  return apart1(world, id, true) ?? apart1(world, id, false);
}

function apart1(world: World, id: GroupId, keep: boolean): { world: World, unrolled: Unrolled[] } | null {
  const group = world.groups.get(id);

  if (group === undefined) return null;

  const rigs = new Map(world.rigs);
  const unrolled: Unrolled[] = [];

  // The group's own timeline goes with it, folded into its members. Its depth
  // never transfers: a group's erosion offsets the union of its members, and
  // once they are members no longer there is no union for it to be about.
  rigs.delete(id);

  if (world.rigs.has(id)) {
    for (const member of group.members) {
      const fold = folded(world, id, member, keep);

      if (fold === null) return null;

      const rig = fold.rig;

      unrolled.push(...fold.unrolled);

      if (rig.keys.size === 0 && rig.nudges.size === 0 && rig.depths.size === 0) rigs.delete(member);
      else rigs.set(member, rig);
    }
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

  const out = { ...world, groups, rigs };

  // Held to what it promises. Every step of the fold is exact, and this is
  // where that is checked rather than argued: a member that would land
  // anywhere else at any keyframe refuses the lot.
  for (const m of group.members.flatMap(m => within(world, m))) {
    if (!placedAlike(world, out, m)) return null;
  }

  return { world: out, unrolled: distinct(unrolled) };
}

/** Whether `m` is placed alike in both, at every keyframe it stands at. */
function placedAlike(was: World, now: World, m: Id): boolean {
  const from = order(was, lived(was, m)?.birth ?? was.keyframes[0].id);

  return was.keyframes.slice(Math.max(0, from)).every(k => alike(worldFrame(was, m, k.id), worldFrame(now, m, k.id)));
}

/** Each repeat once, however many things it was taken apart onto. */
function distinct(unrolled: readonly Unrolled[]): Unrolled[] {
  const seen = new Set<string>();

  return unrolled.filter(u => {
    const key = `${u.id}@${u.at}#${u.nth}`;

    if (seen.has(key)) return false;

    seen.add(key);

    return true;
  });
}

/** Two frames that place everything within the arithmetic of each other. */
function alike(p: Affine, q: Affine): boolean {
  const size = Math.max(1, Math.abs(p.tx), Math.abs(p.ty), Math.abs(p.a), Math.abs(p.d));
  const off = Math.max(
    Math.abs(p.a - q.a), Math.abs(p.b - q.b), Math.abs(p.c - q.c), Math.abs(p.d - q.d),
    Math.abs(p.tx - q.tx) / size, Math.abs(p.ty - q.ty) / size,
  );

  return off <= 1e-7;
}

/** Whether a frame is a turn and an even scale, which is when turning in it
 * is turning in the frame outside it. */
function similar(f: Frame): boolean {
  return Math.abs(f.skew) <= 1e-12
    && Math.abs(f.scale.x - f.scale.y) <= 1e-12 * Math.max(f.scale.x, f.scale.y);
}

const ORIGIN: Point = { x: 0, y: 0 };

/** A frame's linear part, as a matrix. */
function linearOf(f: Frame): Affine {
  return { ...affineOf(f), tx: 0, ty: 0 };
}

/** A frame's axes, unscaled: `R · K`. */
function axesOf(f: Frame): Affine {
  return linearOf({ ...REST, angle: f.angle, skew: f.skew });
}

/** A linear map undone. Never singular here: every map it is asked about is a
 * frame's, or made of them. */
function inverse(m: Affine): Affine {
  const det = m.a * m.d - m.b * m.c;

  return { a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det, tx: 0, ty: 0 };
}

/** `m` conjugated by `by`: the same map, read in the frame `by` leads out of. */
function within1(by: Affine, m: Affine): Affine {
  return compose(inverse(by), compose(m, by));
}

/** A small matrix is small next to the numbers on its diagonal. */
function tiny(x: number, m: Affine): boolean {
  return Math.abs(x) <= 1e-12 * Math.max(Math.abs(m.a), Math.abs(m.d));
}

/**
 * What carries a thing's frame `f` through `m` — a linear map about the point
 * `p`, in the frame the thing is held in — and then along `slide`, said as the
 * thing's own operations: a turn, a skew and a stretch, all about the point of
 * the thing at `p`, which each of them therefore leaves where it is, and a
 * move.
 *
 * Exact at the end, which is all the fold asks: part way, it goes by its own
 * path rather than the one the map would have taken. The turn is the one
 * nearest `hint`, so a group's full turn is a full turn of its member.
 */
function across(f: Frame, m: Affine, p: Point, slide: Point, hint: number): Op[] | null {
  const to = framed(compose(m, linearOf(f)));

  if (to === null) return null;

  const ref = unplace(affineOf(f), p);
  const d = to.angle - f.angle;
  const angle = d - 2 * Math.PI * Math.round((d - hint) / (2 * Math.PI));

  const ops: Op[] = [
    { kind: 'turn', angle, ref, about: ORIGIN },
    { kind: 'skew', by: to.skew - f.skew, ref, shift: ORIGIN, along: f.angle + angle },
    {
      kind: 'scale',
      by: { x: to.scale.x / f.scale.x, y: to.scale.y / f.scale.y },
      ref,
      shift: ORIGIN,
      along: f.angle + angle,
      lean: to.skew,
    },
    { kind: 'move', by: slide },
  ];

  return ops.filter(op => !trivial(op));
}

/**
 * An operation written in a group's frame, said instead in the frame outside
 * it, for a member whose own frame is `inner` there — or nothing where that
 * cannot be said without knowing `inner`, and it is not known.
 *
 * `outer` is the group's frame. A move and a slide go through its linear part.
 * A stretch along the member's own axes is one along its axes outside too,
 * whatever the group is doing, because the stretch applies before the skew:
 * only the axes a repeat reads change. So is a skew, by however much the
 * member's and the combined frame's proportions differ. A turn is a turn
 * outside only where the group is a turn and an even scale; anywhere else it
 * is a general map about its anchor, said through `across`. `ref` needs
 * nothing: the member's rest frame is the rest frame of what it comes to.
 */
export function outward(op: Op, outer: Frame, inner: Frame | null): Op[] | null {
  const both = inner === null ? null : framed(compose(affineOf(outer), affineOf(inner)));

  switch (op.kind) {
    case 'move':
      return [{ kind: 'move', by: linear(outer, op.by) }];

    case 'turn': {
      if (similar(outer) || Math.abs(op.angle) <= 1e-12) return [{ ...op, about: linear(outer, op.about) }];
      if (inner === null || both === null) return null;

      const at = placed(inner, op.ref);
      const anchor = placed(outer, { x: at.x + op.about.x, y: at.y + op.about.y });
      const g = linearOf(outer);
      const turned = linearOf({ ...REST, angle: op.angle });

      return across(both, compose(g, compose(turned, inverse(g))), anchor, ORIGIN, op.angle);
    }

    case 'scale': {
      const axes = framed(compose(linearOf(outer), axesOf({ ...REST, angle: op.along, skew: op.lean })))!;

      return [{ ...op, shift: linear(outer, op.shift), along: axes.angle, lean: axes.skew }];
    }

    case 'skew': {
      if (inner === null || both === null) return null;

      const axis = linear(outer, spun({ x: 1, y: 0 }, op.along));

      return [{
        ...op,
        by: op.by * (inner.scale.y / inner.scale.x) * (both.scale.x / both.scale.y),
        shift: linear(outer, op.shift),
        along: Math.atan2(axis.y, axis.x),
      }];
    }

    case 'erode':
      return [op];

    case 'stand': {
      const frame = framed(compose(affineOf(outer), affineOf(op.frame)));

      return frame === null ? null : [{ ...op, frame }];
    }
  }
}

/**
 * A group's timeline folded into one of its members: the member's own
 * operations said in the frame outside the group, then the group's, at every
 * keyframe the member stands at.
 *
 * At a keyframe the member is placed by `G ∘ M`, where each is its frame at the
 * keyframe before with that keyframe's operations played over it:
 *
 *   G_k ∘ M_k = gₙ … g₁ ∘ G_{k-1} ∘ mₙ … m₁ ∘ M_{k-1}
 *             = gₙ … g₁ ∘ (G_{k-1} mₙ G_{k-1}⁻¹) … (G_{k-1} m₁ G_{k-1}⁻¹) ∘ (G ∘ M)_{k-1}
 *
 * so the member's own come first, each carried out of the group by the group's
 * frame at the keyframe before — `outward` — and the group's follow, each
 * aimed at the point it was aimed at, which it paints onto the member by
 * taking it back through the combined frame. See `carried` for what becomes of
 * repeats. The corners are untouched — they are in the member's rest frame,
 * which the group never reached.
 */
function folded(
  world: World,
  g: GroupId,
  m: Id,
  keep: boolean,
): { rig: Rig, unrolled: Unrolled[] } | null {
  const rig = rigOf(world, m);
  // From its birth, or from the first keyframe for a group, whose timeline
  // plays from there.
  const born = lived(world, m);
  const first = born !== undefined ? order(world, born.birth) : world.groups.has(m) ? 0 : -1;

  if (first < 0) return { rig, unrolled: [] };

  const across = (i: number): Frame => {
    const before = keyAt(world, i - 1);

    return before === null ? REST : stateAt(world, g, before).frame;
  };

  const out = carried(world, m, first, across, g, keep);

  return out === null ? null : { rig: { ...rig, keys: out.keys }, unrolled: out.unrolled };
}

/** What takes a thing from rest to `f`: a stretch, a skew and a turn about
 * the rest frame's origin, then a move. */
function arrival(f: Frame): Op[] {
  const ops: Op[] = [
    { kind: 'scale', by: f.scale, ref: ORIGIN, shift: ORIGIN, along: 0, lean: 0 },
    { kind: 'skew', by: f.skew, ref: ORIGIN, shift: ORIGIN, along: 0 },
    { kind: 'turn', angle: f.angle, ref: ORIGIN, about: ORIGIN },
    { kind: 'move', by: f.t },
  ];

  return ops.filter(op => !trivial(op));
}

/** One operation a keyframe played, where it came from, and what it came to
 * on the other side. */
interface Crossed {
  source: Source
  /** Whose it was: the thing's own, or the group's aimed at it. */
  group: boolean
  ops: Op[]
}

/**
 * `m`'s timeline said on the other side of a frame, from keyframe index
 * `first` on: what `folded` and `entering` share.
 *
 * `across(i)` is the frame `m`'s own operations at keyframe `i` are carried out
 * through — the group's at the keyframe before when a group is taken away, the
 * landing group's undone when one is put over it — and `g` is the group whose
 * own operations follow, aimed at `m`, where there is one.
 *
 * Every operation is carried as it is played. What that leaves is exact, one
 * entry per operation per keyframe. A repeat is then written back as one entry
 * where that says the same — with `keep`, and where:
 *
 * - every step of it carries to one operation, and that operation is the
 *   carried entry's own step: the frame it is carried through holds its shape
 *   over the span, and the kind needs nothing but that frame to be carried
 *   (a turn across a squash is a turn, a skew and a stretch, and never one);
 * - every repeat running beside it that began before it is kept too. A kept
 *   repeat's steps are played at the head of each keyframe, before its own
 *   list, and one that overtook a step taken apart would change the order.
 *
 * The rest are taken apart, and said so.
 */
function carried(
  world: World,
  m: Id,
  first: number,
  across: (i: number) => Frame | null,
  g: GroupId | null,
  keep: boolean,
): { keys: Map<KeyframeId, Entry[]>, unrolled: Unrolled[] } | null {
  const rows: Crossed[][] = [];

  for (let i = first; i < world.keyframes.length; i++) {
    const k = world.keyframes[i].id;
    const before = keyAt(world, i - 1);

    let outer = across(i);
    let inner = i === first || before === null ? REST : stateAt(world, m, before).frame;

    if (outer === null) return null;

    const row: Crossed[] = [];
    const mine = playedAt(world, m, k), from = sourcesAt(world, m, k);

    // Born after the first keyframe, it begins at rest in whatever holds it
    // — which, on the other side of the frame, is the frame itself. Unless it
    // begins with a stand, which says where it is outright.
    if (i === first && before !== null && mine[0]?.kind !== 'stand') {
      for (const op of arrival(outer)) {
        row.push({ source: { entry: once(op), at: k, step: 0 }, group: false, ops: [op] });
      }
    }

    for (let j = 0; j < mine.length; j++) {
      const out = outward(mine[j], outer, inner);

      if (out === null) return null;

      row.push({ source: from[j], group: false, ops: out });
      inner = played(inner, mine[j]);
    }

    if (g !== null) {
      let both = framed(compose(affineOf(outer), affineOf(inner)));

      if (both === null) return null;

      const theirs = playedAt(world, g, k), whence = sourcesAt(world, g, k);

      for (let j = 0; j < theirs.length; j++) {
        const out = inward1(world, k, m, theirs[j], outer, both);

        if (out === null) return null;

        outer = played(outer, theirs[j]);

        for (const o of out) both = played(both, o);

        row.push({ source: whence[j], group: true, ops: out });
      }
    }

    rows.push(row);
  }

  // Every repeat that played, with its steps in the order they were taken.
  const steps = new Map<Entry, Crossed[]>();

  for (const row of rows) {
    for (const c of row) {
      if (c.source.entry.times === 1 || c.source.entry.op.kind === 'stand') continue;

      const all = steps.get(c.source.entry) ?? [];

      all.push(c);
      steps.set(c.source.entry, all);
    }
  }

  const kept = new Set<Entry>();
  const unrolled: Unrolled[] = [];

  /** Written where, and which of that keyframe's entries. */
  const whose = (c: Crossed): Unrolled => {
    const id = c.group ? g! : m;
    const list = rigOf(world, id).keys.get(c.source.at) ?? [];

    return { id, at: c.source.at, nth: list.indexOf(c.source.entry), why: 'order' };
  };

  // Each repeat is compared from the first step it takes here, which is its
  // own entry unless it was already running where `m` begins. A repeat's
  // steps from its n-th on are the n-th step repeated — a step of a step is a
  // step — so one already running is kept by writing that.
  for (const [entry, all] of steps) {
    const head = all[0];
    const h = head.source.step;
    let why: Unrolled['why'] | null = null;

    if (all.some(c => c.ops.length !== 1)) why = 'squash';
    else if (all.some(c => !sameOp(c.ops[0], stepped(head.ops[0], c.source.step - h)))) {
      why = head.group ? 'moving' : 'reshaped';
    }

    if (why === null && keep) kept.add(entry);
    else unrolled.push({ ...whose(head), why: why ?? 'order' });
  }

  // Where each kept repeat is in the order the walk will play kept steps in:
  // the keyframe it is written at, and its place in what that keyframe
  // played.
  const rank = new Map<Entry, number>();

  rows.forEach((row, i) => row.forEach((c, j) => {
    if (!rank.has(c.source.entry)) rank.set(c.source.entry, i * 1e6 + j);
  }));

  const heads = new Set([...steps.values()].map(all => all[0]));

  let settled = false;

  while (!settled) {
    settled = true;

    for (const row of rows) {
      let prefix = true;
      let last = -Infinity;

      for (const c of row) {
        const step = kept.has(c.source.entry) && !heads.has(c);

        if (!step) {
          prefix = false;
          continue;
        }

        const r = rank.get(c.source.entry)!;

        if (!prefix || r < last) {
          kept.delete(c.source.entry);
          unrolled.push({ ...whose(steps.get(c.source.entry)![0]), why: 'order' });
          settled = false;
          break;
        }

        last = r;
      }

      if (!settled) break;
    }
  }

  const keys = new Map<KeyframeId, Entry[]>();

  rows.forEach((row, i) => {
    const list: Entry[] = [];

    for (const c of row) {
      const e = c.source.entry;

      if (!kept.has(e)) list.push(...c.ops.map(o => once(o)));
      else if (heads.has(c)) {
        const k = world.keyframes[first + i].id;

        list.push(skipping(world.keyframes, { ...e, op: c.ops[0], times: e.times === null ? null : e.times - c.source.step }, k));
      }
    }

    if (list.length > 0) keys.set(world.keyframes[first + i].id, list);
  });

  return { keys, unrolled };
}

/** Two operations the same to within the arithmetic that produced them. */
function sameOp(a: Op, b: Op): boolean {
  const x = a as unknown as Record<string, unknown>, y = b as unknown as Record<string, unknown>;

  if (a.kind !== b.kind) return false;

  return Object.keys(x).every(key => close(x[key], y[key]));
}

function close(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  }

  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const x = a as Record<string, unknown>, y = b as Record<string, unknown>;

    return Object.keys(x).every(key => close(x[key], y[key]));
  }

  return a === b;
}

/**
 * One of a group's operations, aimed at what its member and it come to
 * together: `both`, the combined frame where the operation begins, with the
 * group's own frame there `outer`.
 *
 * A move is a move. A turn goes about the same point, which it paints onto the
 * member through the combined frame. A stretch along the group's axes, or a
 * skew along its first, is the member's own where the member's axes read it as
 * one — a stretch where they are the group's or a quarter turn from them, or
 * where it stretches both ways alike — and anywhere else a general map about
 * that point, said through `across`. The group's depth goes nowhere.
 *
 * A stand says where the group is outright, and so where the member is: the
 * member's own frame inside the new group frame, as one stand, with the corners
 * and depths it has there.
 */
function inward1(
  world: World,
  k: KeyframeId,
  m: Id,
  op: Op,
  outer: Frame,
  both: Frame,
): Op[] | null {
  switch (op.kind) {
    case 'move':
      return [op];

    case 'erode':
      return [];

    case 'turn': {
      const p = placed(outer, op.ref);

      return [{ ...op, ref: unplace(affineOf(both), p) }];
    }

    case 'scale': {
      const p = placed(outer, op.ref);
      const axes = axesOf(outer);
      const x = compose(axes, compose(linearOf({ ...REST, scale: op.by }), inverse(axes)));
      const read = within1(axesOf(both), x);

      if (!tiny(read.b, read) || !tiny(read.c, read)) return across(both, x, p, op.shift, 0);

      return [{
        ...op,
        by: { x: read.a, y: read.d },
        ref: unplace(affineOf(both), p),
        along: both.angle,
        lean: both.skew,
      }];
    }

    case 'skew': {
      const p = placed(outer, op.ref);
      const turn = axesOf({ ...REST, angle: outer.angle });
      const x = compose(turn, compose(axesOf({ ...REST, skew: op.by }), inverse(turn)));
      const read = within1(axesOf(both), x);

      if (!tiny(read.b, read) || !tiny(read.a - 1, read) || !tiny(read.d - 1, read)) {
        return across(both, x, p, op.shift, 0);
      }

      return [{ ...op, by: read.c, ref: unplace(affineOf(both), p), along: both.angle }];
    }

    case 'stand': {
      const inner = stateAt(world, m, k);
      const frame = framed(compose(affineOf(op.frame), affineOf(inner.frame)));

      if (frame === null) return null;

      const held = handed(world, k, m);

      return [{ kind: 'stand', frame, erosion: inner.erosion, corners: held.corners, depths: held.depths }];
    }
  }
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
 * A source vertex put under the cursor, exactly: `it` as it stood when the
 * gesture began, and a nudge at `v` making up the difference.
 *
 * The nudge is in the polygon's rest frame, so its frame carries it and the
 * corner keeps its place in the ring however the polygon is turned or squashed
 * upstream. Taking the cursor back to that frame is one inverse of the frame,
 * which is exact: erosion is not in the way, having never touched the source.
 *
 * Added to what `v` already nudged the corner by, against the corner as the
 * gesture found it — so a drag that returns to where it started leaves the
 * keyframe as it found it.
 */
export function placeVertex(world: World, v: KeyframeId, it: Resolved, index: number, at: Point): World {
  const target = unplace(it.frame, at);
  const local = it.local[index];
  const by = { x: target.x - local.x, y: target.y - local.y };

  return withRig(world, it.id, nudged(rigOf(world, it.id), it.corners[index].id, v, by));
}

/**
 * The named corners of a polygon taken `by` deeper than it, or shallower where
 * `by` is negative, at `v`.
 *
 * Added to what `v` already said about them. A corner that comes back to
 * nothing is taken out of the map rather than written as nought: only an
 * empty map says *nothing here is offset*, which is what puts the polygon back
 * on the road `erode` has always taken. See `varying`.
 */
export function deepen(
  world: World,
  v: KeyframeId,
  id: PolygonId,
  corners: ReadonlySet<VertexId>,
  by: number,
): World {
  const polygon = world.polygons.get(id);

  if (polygon === undefined || by === 0) return world;

  let rig = rigOf(world, id);

  for (const corner of polygon.points) {
    if (corners.has(corner.id)) rig = deepened(rig, corner.id, v, by);
  }

  return withRig(world, id, rig);
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
   * The identity for a group. Its members' frames already carry its own —
   * that is what `worldFrame` does — so the union comes out in world units
   * with the motion in it, and a group that applied its own frame again would
   * apply it twice.
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
 * Every group's depth as keyframe `v` leaves it: what its erosions add up to.
 *
 * A group that is not there at `v` has no depth, whatever was written about it
 * before it was taken out. Nothing reaches its members either — they went with
 * it — so this is about the ghost rather than about the geometry, and a ghost
 * with a depth is one more thing for a reader to have to rule out.
 */
export function depths(world: World, v: KeyframeId): Map<Id, number> {
  const from = new Set(chain(world, v));
  const out = new Map<Id, number>();

  for (const id of world.groups.keys()) {
    if (!standingIn(world, id, from)) continue;

    const d = stateAt(world, id, v).erosion;

    if (d !== 0) out.set(id, d);
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
  v: KeyframeId,
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
 * The slot of `set` a scope publishes into: the outermost one anything in it
 * fills, or nothing where it holds nothing in that set.
 *
 * So a scope is whatever its outermost member is. A room with pillars in it is
 * a level; pillars with holes in them and no room around them are a solid, and
 * go on to cut whatever room they are put in, exactly as a pillar would. There
 * is no flag for it, and nothing to retype: what a group is follows from what
 * it holds, the way a polygon's does from its kind.
 *
 * Read off membership, which is global, and not off what stands at any one
 * keyframe. A polygon's kind never changes from one keyframe to the next and a
 * group's does not either — a scope whose only room is taken out at v2 is a
 * level with nothing in it from there on, not a solid from v2, which would have
 * it shrink away with its room across the span and come back whole at the end.
 * An author wanting the solid to outlive the room nests it: a sealed solid in
 * a sealed level has been a solid all along.
 *
 * Descending through sealed groups as much as loose ones, because a sealed one
 * publishes into its own outermost slot and the least of the least is the
 * least.
 */
export function outermostSlot(world: World, id: Id, set: SetName): number | null {
  const group = world.groups.get(id);

  if (group === undefined) {
    const p = world.polygons.get(id);

    return p === undefined ? null : slotOf(p, set);
  }

  let out: number | null = null;

  for (const m of group.members) {
    const k = outermostSlot(world, m, set);

    if (k !== null && (out === null || k < out)) out = k;
  }

  return out;
}

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
  const outer = new Map<string, number | null>();

  /** The slot a scope publishes into. See `outermostSlot`. */
  const top = (id: Id, set: SetName): number | null => {
    const key = `${id}:${set}`;

    if (!outer.has(key)) outer.set(key, outermostSlot(world, id, set));

    return outer.get(key)!;
  };

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

    // A sealed scope puts in one shape, in the slot of its outermost kind:
    // whatever cut inside it was spent inside it, so what arrives is a level,
    // or a solid with its voids already taken out, and nothing that cuts it
    // back. A loose group, or one standing open, has no scope of its own and
    // hands its members up into this one.
    if (group.sealed && standing(id) !== null) {
      return k === top(id, set) ? [resolves(id, set)] : [];
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
    //
    // Counted from the slot the scope publishes into, since that is the shape
    // the depth erodes: a scope that is a solid shrinks as a solid does, and
    // its voids grow against it.
    const kinds = SLOT_KINDS[set];
    const depth = inverted(kinds[k]) !== inverted(kinds[top(id, set) ?? 0]) ? -d : d;

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
   * the floor out of existence. Nor does one that is a solid: a solid is
   * something standing in a room, not the room a floor is laid in.
   *
   * The fold starts at the scope's outermost slot rather than the first, so a
   * solid with voids in it is `solid - void` and not `nothing - (solid - void)`.
   */
  const resolves = (id: Id, set: SetName): Shape => {
    const key = `${id}:${set}`;
    const known = held?.get(key);

    if (known !== undefined) return known;

    const from = top(id, set);
    const slots: Shape[] = [];

    for (let k = from ?? SLOTS[set]; k < SLOTS[set]; k++) slots.push(slotted(id, set, k));

    const settles = slots.length === 0 ? [] : settled(slots);
    const out = set === 'floor' && top(id, 'level') === 0
      ? underfoot(settles, resolves(id, 'level'))
      : settles;

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
    // what it is made of — the outermost kind it holds, so a level or a solid
    // here and a floor there, and nothing that cuts either. Two ids, because
    // they are two boundaries. See `outermostSlot`.
    for (const set of SETS) {
      const shape = resolves(id, set);

      if (shape.length === 0) continue;

      const kind = SLOT_KINDS[set][top(id, set)!];

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
  v: KeyframeId,
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
   * `empty` is a scope that came to nothing — a room swallowed by its own
   * pillar, a level whose rooms have all been taken out, or one eroded past its
   * own middle.
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
  v: KeyframeId,
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
  v: KeyframeId,
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
  v: KeyframeId,
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
  v: KeyframeId,
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
  // Hidden or locked from its row in the timeline. See `Flags`.
  if (!clickable(world, id)) return false;

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
export function csg(world: World, v: KeyframeId): Point[][] {
  return runs(live(EMPTY_LIVE, contributing(world, v, resolveAt(world, v))));
}

/** The same for the floor, which is a set of its own and answered by the same
 * machinery. See `Live`. */
export function csgFloor(world: World, v: KeyframeId): Point[][] {
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
  v: KeyframeId,
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
  v: KeyframeId,
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

  return { world: placeVertex(grown, v, now, where, at), vertex };
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
 * Polygons, artefacts and paths taken out as of `v`, and standing as they were
 * before it.
 *
 * The same shape as `removeVertices`, one level up, and for the same reasons.
 * What a version's layers already said about a thing stays written: a layer
 * that turned a room still turned it, at the versions that still have the room,
 * and dropping those on the way out would quietly edit the past. `resolveAt`
 * stops walking a thing at its death, so what is left behind is inert rather
 * than wrong.
 *
 * Deleting a group takes out everything under it — picking a group is picking
 * the rooms in it — and leaves the group itself alone. It has no life to end:
 * the structure is one fact about every keyframe, and a group with nothing
 * standing in it is simply not drawn there. See `Group`.
 *
 * Born into `v` and taken out at `v` is the one case that goes entirely: it
 * never stood anywhere, so there is no keyframe for the record to be about.
 * That one *does* restructure, since what is left is a group holding something
 * that is not in the world at all.
 */
export function removeAt(world: World, v: KeyframeId, going: Iterable<Id>): World {
  const inherited = new Set(chain(world, v));

  // Everything under what was picked, which is what a delete has always
  // reached. A group is reached through its members and not as itself: it has
  // no life to end, and holds them still at the keyframes they stand at.
  const gone = new Set<Id>();

  for (const id of going) {
    for (const m of within(world, id)) gone.add(m);
  }

  const polygons = new Map(world.polygons);
  const artefacts = new Map(world.artefacts);
  const paths = new Map(world.paths);
  const outright = new Set<Id>();

  let changed = false;

  /** One thing's map entry, either killed at `v` or dropped outright. */
  const take = <T extends { birth: KeyframeId, death: KeyframeId | null }>(
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

    const artefact = artefacts.get(id);
    if (artefact !== undefined) take(artefacts, id, artefact);

    const path = paths.get(id);
    if (path !== undefined) take(paths, id, path);
  }

  if (!changed) return world;

  const out = { ...world, polygons, artefacts, paths };

  return outright.size === 0 ? out : without(out, outright);
}

export function removeVertices(
  world: World,
  v: KeyframeId,
  going: Iterable<VertexId>,
): World {
  const gone = new Set(going);

  if (gone.size === 0) return world;

  const polygons = new Map(world.polygons);
  let changed = false;

  // Which corners are here is a resolve rather than a filter, because an
  // unchained polygon's are not the ones its births would name — see `Stand`.
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

/**
 * How far past the copy keyframe the thing being copied is taken out, or
 * nothing where it is not.
 *
 * The same offset a corner's `death` becomes, and for the same reason: what is
 * copied is a life rather than a shape, so a room the original loses two
 * keyframes on is a room the copy loses two keyframes after it lands.
 */
function outliving(world: World, it: { death: KeyframeId | null }, v: KeyframeId): number | undefined {
  return it.death === null ? undefined : order(world, it.death) - order(world, v);
}

/**
 * An offset read back at the keyframe a paste lands in.
 *
 * One that falls off the end of the keyframes is nothing: there is no keyframe
 * left to take the thing out, so the copy simply lives to the last one.
 */
function landingAt(world: World, v: KeyframeId, offset: number | undefined): KeyframeId | null {
  return offset === undefined ? null : keyAt(world, order(world, v) + offset);
}

/** A thing's frame read outside everything holding it: exact, since nothing
 * mirrors, and `REST` only if something had gone singular. */
function unheld(m: Affine): Frame {
  return framed(m) ?? REST;
}

/**
 * The picked things lifted out, from the keyframe they were taken at onward.
 *
 * Two halves. Where the keyframe before left it becomes where it starts, over
 * its rest geometry with every nudge up to the copy put in. The keyframe it
 * was copied at, and every one after it, comes across as the list written
 * there, keyed by how far past the copy it was — so the copy starts life
 * looking exactly like what was on screen, a repeat begun there begins where
 * the paste lands, and what the original goes on to do the copy goes on to do
 * too: the erosion sequence is the thing worth copying, and it is not in any
 * one keyframe.
 *
 * Nothing before the copy comes at all, but for the repeats still running: what
 * they go on doing is part of what the original does. Each comes across as its
 * step at the copy keyframe, repeated for the steps it has left, at the head of
 * that keyframe's list — a step of a step is a step, so that is the same repeat
 * carrying on, in the same order. Behind a stand at the copy keyframe, the
 * stand is where it starts, and the repeats come across at the keyframe after.
 *
 * The outermost things are copied in world units, their holders not coming
 * with them — taken out of them as ungrouping would take them, every holder
 * folded in, so that what the copy goes on to do is what was seen, the
 * holders' motion and all. See `freed`. What is inside them keeps the frame of
 * what holds it, since that comes too.
 *
 * What had to come across one step to an entry is said, in `unrolled`.
 */
export function copied(world: World, v: KeyframeId, ids: readonly Id[]): Clipping[] {
  const at = order(world, v);
  const n = world.keyframes.length;
  const offset = (k: KeyframeId): number => order(world, k) - at;

  /** Whether a repeat still has steps to take after the copy keyframe. */
  const reaches = (u: Unrolled): boolean => {
    const times = rigOf(world, u.id).keys.get(u.at)?.[u.nth]?.times;

    return times === null || (times !== undefined && offset(u.at) + times - 1 > 0);
  };

  /** What happens to `id` after the copy keyframe: in world units for the
   * outermost, and in the frame of what holds it for the rest. */
  const timed = (id: Id, outermost: boolean): Timed & { keysOf: Rig } => {
    const freeing = outermost ? freed(world, id) : { world, unrolled: [] };
    const src = freeing.world;
    const rig = rigOf(src, id);
    const state = stateAt(world, id, v);
    const mine = rig.keys.get(v) ?? [];

    // A repeat's step, as an entry of its own that carries on from there.
    const carrying = (op: Op, { entry, step }: Source, k: KeyframeId): Entry =>
      skipping(world.keyframes, { ...entry, op, times: entry.times === null ? null : entry.times - step }, k);

    // Up to its last stand, the copy keyframe's own list is where the copy
    // starts: a stand holds nothing that can be written again elsewhere.
    const cut = mine.map(e => e.op.kind).lastIndexOf('stand') + 1;
    const stand = cut > 0 ? mine[cut - 1].op as Stand : null;
    const was = at > 0 ? stateAt(src, id, world.keyframes[at - 1].id) : null;

    // With no stand, it starts where the keyframe before left it, and the
    // copy keyframe comes across as what it does: the steps of the repeats
    // running into it, as entries that carry on, and then its own list. So a
    // repeat begun there begins where the paste lands, in the same order.
    const sources = sourcesAt(src, id, v);
    const running = stand !== null
      ? []
      : playedAt(src, id, v).flatMap((op, j) => (sources[j].at === v ? [] : [carrying(op, sources[j], v)]));

    // Behind a stand, what is running goes on past it, and comes across as its
    // next step at the head of the keyframe after: the same rig with nothing
    // after the stand in it, walked on.
    const before = withRig(src, id, {
      ...rig,
      keys: new Map([...[...rig.keys].filter(([k]) => offset(k) < 0), ...(cut > 0 ? [[v, mine.slice(0, cut)] as const] : [])]),
    });

    const keys: [number, Entry[]][] = [];

    if (running.length + mine.length - cut > 0) keys.push([0, [...running, ...mine.slice(cut)]]);

    for (let i = at + 1; i < n; i++) {
      const k = world.keyframes[i].id;
      const own = rig.keys.get(k) ?? [];

      // Only the keyframe right after: from there, the walk steps them on.
      const steps: Entry[] = stand === null || i > at + 1
        ? []
        : playedAt(before, id, k).map((op, j) => carrying(op, sourcesAt(before, id, k)[j], k));

      if (steps.length + own.length > 0) keys.push([i - at, [...steps, ...own]]);
    }

    const frame = stand?.frame ?? was?.frame ?? REST;

    return {
      start: frame,
      erosion: stand?.erosion ?? was?.erosion ?? 0,
      stood: { frame: outermost ? unheld(worldFrame(world, id, v)) : state.frame, erosion: state.erosion },
      keys,
      // What the fold took apart matters only where it goes on past the copy.
      unrolled: freeing.unrolled.filter(reaches),
      keysOf: rig,
    };
  };

  /** A corner's entries after the copy keyframe, by offset. */
  const later = <E>(map: ReadonlyMap<KeyframeId, E> | undefined): [number, E][] =>
    [...(map ?? [])].flatMap(([k, e]): [number, E][] => (offset(k) > 0 ? [[offset(k), e]] : []));

  const clip = (id: Id, outermost: boolean): Clipping[] => {
    const here = new Set(chain(world, v));

    if (!standingIn(world, id, here)) return [];

    const thing = world.artefacts.get(id);

    if (thing !== undefined) {
      const { keysOf: _rig, ...time } = timed(id, outermost);

      return [{ kind: 'artefact', type: thing.type, at: thing.at, death: outliving(world, thing, v), ...time }];
    }

    const walk = world.paths.get(id);

    if (walk !== undefined) {
      const { keysOf: _rig, ...time } = timed(id, outermost);

      return [{ kind: 'path', points: walk.points, death: outliving(world, walk, v), ...time }];
    }

    const group = world.groups.get(id);

    if (group !== undefined) {
      const members = group.members.flatMap(m => clip(m, false));
      const { keysOf: _rig, ...time } = timed(id, outermost);

      return members.length === 0 ? [] : [{ kind: 'group', sealed: group.sealed, members, ...time }];
    }

    const polygon = world.polygons.get(id);

    if (polygon === undefined) return [];

    const state = stateAt(world, id, v);
    const { keysOf: rig, ...time } = timed(id, outermost);

    const points = polygon.points
      .filter(c => state.corners.has(c.id) || offset(c.birth) > 0)
      .map(c => ({
        id: c.id,
        at: state.corners.get(c.id) ?? c.at,
        ring: c.ring,
        birth: state.corners.has(c.id) ? 0 : offset(c.birth),
        death: c.death === null ? null : offset(c.death),
      }));

    const kept = new Set(points.map(c => c.id));

    return [{
      kind: 'polygon',
      ...kindOf(polygon),
      points,
      depths: [...state.depths],
      nudges: [...rig.nudges].filter(([c]) => kept.has(c)).map(([c, m]) => [c, later(m)]),
      deep: [...rig.depths].filter(([c]) => kept.has(c)).map(([c, m]) => [c, later(m)]),
      death: outliving(world, polygon, v),
      ...time,
    }];
  };

  return [...new Set(ids)].flatMap(id => clip(id, true));
}

/**
 * `id` taken out of everything holding it, one holder at a time, as ungrouping
 * each would take it — its holders folded into its own timeline, and it left
 * where the holder was. What a copy reads the outermost things off, so that
 * the copy goes on doing what was seen. See `carried` for the repeats.
 */
function freed(world: World, id: Id): { world: World, unrolled: Unrolled[] } {
  let w = world;
  const unrolled: Unrolled[] = [];

  while (true) {
    const g = parentOf(w).get(id);

    if (g === undefined) break;

    const next = lift1(w, g, id, true) ?? lift1(w, g, id, false);

    // Never, for a frame that does not mirror: the copy is then read in the
    // holder's frame, which is wrong, rather than not at all.
    if (next === null) break;

    w = next.world;
    unrolled.push(...next.unrolled);
  }

  return { world: w, unrolled: distinct(unrolled) };
}

/** `id` out of `g` and into `g`'s own holder, beside it, `g` folded in. */
function lift1(world: World, g: GroupId, id: Id, keep: boolean): { world: World, unrolled: Unrolled[] } | null {
  const fold = folded(world, g, id, keep);

  if (fold === null) return null;

  const groups = new Map(world.groups);
  const group = groups.get(g)!;
  const up = parentOf(world).get(g);

  groups.set(g, { ...group, members: group.members.filter(m => m !== id) });

  if (up !== undefined) {
    const holder = groups.get(up)!;

    groups.set(up, { ...holder, members: holder.members.flatMap(m => (m === g ? [g, id] : [m])) });
  }

  const out = withRig({ ...world, groups }, id, fold.rig);

  return within(world, id).every(m => placedAlike(world, out, m)) ? { world: out, unrolled: fold.unrolled } : null;
}

/** A whole affine map undone. */
function undone(m: Affine): Affine {
  const l = inverse(m);

  return { ...l, tx: -(l.a * m.tx + l.c * m.ty), ty: -(l.b * m.tx + l.d * m.ty) };
}

/**
 * A thing pasted at the top level, taken into the group `into`: its timeline
 * said in that group's frame, so that it lands where it was put and from there
 * does what was copied, with whatever the group does over it.
 *
 * The fold the other way round. At the keyframe it lands in, its operations go
 * through the group's frame there, which is what puts it where it was put;
 * after that, through the group's frame at the keyframe before, exactly as a
 * member's own are carried out of a group taken apart. So each keyframe, it
 * does what was copied and then what the group does.
 *
 * Checked, as ungrouping is, and with every repeat taken apart where keeping
 * them would not land it so.
 */
function entering(world: World, v: KeyframeId, id: Id, into: GroupId): { world: World, unrolled: Unrolled[] } {
  const at = order(world, v);

  const through = (i: number): Frame | null =>
    framed(undone(worldFrame(world, into, keyAt(world, i === at ? i : i - 1)!)));

  const attempt = (keep: boolean): { world: World, unrolled: Unrolled[] } | null => {
    const out = carried(world, id, at, through, null, keep);

    return out === null
      ? null
      : { world: withRig(world, id, { ...rigOf(world, id), keys: out.keys }), unrolled: out.unrolled };
  };

  const kept = attempt(true);

  if (kept !== null && landsAsCopied(world, kept.world, at, id, into)) return kept;

  return attempt(false) ?? { world, unrolled: [] };
}

/**
 * Whether `id`, taken into `into`, does what it did at the top level: lands
 * where it was put, and at each keyframe after goes by the same operations from
 * where the keyframe before left it, the group's frame there held over it.
 */
function landsAsCopied(was: World, now: World, at: number, id: Id, into: GroupId): boolean {
  for (let i = at; i < was.keyframes.length; i++) {
    const k = was.keyframes[i].id;
    const h = worldFrame(was, into, keyAt(was, i === at ? i : i - 1)!);

    let expect = stateAt(was, id, k).frame;

    if (i > at) {
      const from = framed(compose(h, affineOf(stateAt(now, id, keyAt(was, i - 1)!).frame)));

      if (from === null) return false;

      expect = from;

      for (const op of playedAt(was, id, k)) expect = played(expect, op);
    }

    if (!alike(compose(h, affineOf(stateAt(now, id, k).frame)), affineOf(expect))) return false;
  }

  return true;
}

/** Every repeat a clipping, and anything in it, brought across as single
 * entries. */
function unrolledIn(clip: Clipping): Unrolled[] {
  return [...clip.unrolled, ...(clip.kind === 'group' ? clip.members.flatMap(unrolledIn) : [])];
}

/**
 * The clipping's timeline written for `id`, starting at `v`: a stand where it
 * is born, which is where it begins, and the lists after it at their offsets.
 *
 * `into` is the paste's offset for the outermost thing, and nothing for what
 * is inside it, which lands in what held it before.
 */
function written(
  world: World,
  v: KeyframeId,
  id: Id,
  clip: Timed,
  corners: ReadonlyMap<VertexId, Point>,
  depths: ReadonlyMap<VertexId, number>,
  into: Affine | null,
): World {
  const start = into === null ? clip.start : unheld(compose(into, affineOf(clip.start)));

  const keys = new Map<KeyframeId, readonly Entry[]>([
    [v, [once<Stand>({ kind: 'stand', frame: start, erosion: clip.erosion, corners, depths })]],
  ]);

  for (const [offset, list] of clip.keys) {
    const k = landingAt(world, v, offset);

    // Past the end of the keyframes, and there is nowhere for it to go. See the
    // note on `pasted`.
    if (k === null) break;

    // A skip names the keyframe it was meant for, and stays on it where the
    // paste still reaches it. What the copy keyframe did plays over the stand.
    keys.set(k, [...(keys.get(k) ?? []), ...list.map(e => skipping(world.keyframes, e, k))]);
  }

  return withRig(world, id, { ...rigOf(world, id), keys });
}

/** A corner's entries after the copy, landed at `v` and renamed. */
function landed<E extends Entry>(
  world: World,
  v: KeyframeId,
  entries: readonly [VertexId, [number, E][]][],
  renamed: ReadonlyMap<VertexId, VertexId>,
): Map<VertexId, Map<KeyframeId, E>> {
  const out = new Map<VertexId, Map<KeyframeId, E>>();

  for (const [c, list] of entries) {
    const id = renamed.get(c);

    if (id === undefined) continue;

    const mine = new Map<KeyframeId, E>();

    for (const [offset, e] of list) {
      const k = landingAt(world, v, offset);

      if (k !== null) mine.set(k, skipping(world.keyframes, e, k));
    }

    if (mine.size > 0) out.set(id, mine);
  }

  return out;
}

/**
 * One clipping put back at `v`, and everything under it.
 *
 * `into` takes the outermost thing's frames from world units into the frame it
 * lands in: the paste's offset, and the open group's frame undone, so that
 * pasting into a turned group does not turn the paste. What is inside a pasted
 * group lands in that group, as it was in the one it came out of, and is
 * handed nothing.
 */
function restore(
  world: World,
  v: KeyframeId,
  clip: Clipping,
  into: Affine | null,
): { world: World, id: Id } {
  const none = new Map();

  if (clip.kind === 'artefact') {
    const id = world.nextId;
    const artefacts = new Map(world.artefacts);

    artefacts.set(id, { type: clip.type, birth: v, death: landingAt(world, v, clip.death), at: clip.at });

    const out = { ...world, artefacts, nextId: id + 1 };

    return { world: written(out, v, id, clip, none, none, into), id };
  }

  if (clip.kind === 'path') {
    const id = world.nextId;
    const paths = new Map(world.paths);

    paths.set(id, { birth: v, death: landingAt(world, v, clip.death), points: clip.points });

    const out = { ...world, paths, nextId: id + 1 };

    return { world: written(out, v, id, clip, none, none, into), id };
  }

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

    groups.set(id, { members, sealed: clip.sealed });
    out = { ...out, groups, nextId: id + 1 };

    return { world: written(out, v, id, clip, none, none, into), id };
  }

  const id = world.nextId;
  const renamed = new Map<VertexId, VertexId>();
  const points = clip.points
    .filter(corner => landingAt(world, v, corner.birth) !== null)
    .map((corner, i) => {
      renamed.set(corner.id, id + 1 + i);

      return {
        id: id + 1 + i,
        at: corner.at,
        ring: corner.ring,
        birth: landingAt(world, v, corner.birth)!,
        death: corner.death === null ? null : landingAt(world, v, corner.death),
      };
    });

  const polygons = new Map(world.polygons);

  polygons.set(id, { ...kindOf(clip), birth: v, death: landingAt(world, v, clip.death), points });

  let out: World = { ...world, polygons, nextId: id + 1 + points.length };

  const corners = new Map(points.filter(c => c.birth === v).map(c => [c.id, c.at]));
  const depths = new Map(clip.depths.flatMap(([c, d]) => {
    const now = renamed.get(c);

    return now === undefined ? [] : [[now, d]];
  }));

  out = written(out, v, id, clip, corners, depths, into);
  out = withRig(out, id, {
    ...rigOf(out, id),
    nudges: landed(out, v, clip.nudges, renamed),
    depths: landed(out, v, clip.deep, renamed),
  });

  return { world: out, id };
}

/**
 * Clippings put back at `v`, offset by `by` so that a paste is something you
 * can see happen.
 *
 * A copy taken at v1 and pasted at v3 has its v1 land in v3, its v2 in v4, and
 * so on: the lists are relative to where they were taken, so what is pasted
 * does from here what the original did from there.
 *
 * What runs off the end of the keyframes is dropped. There is a fixed number of
 * them everywhere else — the strip draws its rows once, the bake counts its
 * spans from the same number — so growing it here would be growing it for all
 * of them.
 *
 * The ids that come back are the top of what was pasted — a group rather than
 * the polygons under it — because that is what the selection should hold: a
 * paste leaves you holding what you copied.
 */
export function pasted(
  world: World,
  v: KeyframeId,
  clips: readonly Clipping[],
  by: Point,
  where: Landing,
): Pasted {
  const ids: Id[] = [];
  const artefacts: ArtefactId[] = [];
  const paths: PathId[] = [];
  const unrolled: Unrolled[] = [];
  let out = world;

  // World units, moved by the offset, and then taken into whatever is
  // standing open. See `entering`.
  const shift: Affine = { ...IDENTITY, tx: by.x, ty: by.y };

  for (const clip of clips) {
    const put = restore(out, v, clip, shift);

    out = put.world;
    unrolled.push(...unrolledIn(clip));

    if (where.into !== null) {
      const inside = entering(out, v, put.id, where.into);

      out = inside.world;
      unrolled.push(...inside.unrolled);
    }

    // Kept apart only because the selection holds them in separate lists.
    // All three go into the group standing open, all three being members of
    // one.
    if (clip.kind === 'artefact') artefacts.push(put.id);
    else if (clip.kind === 'path') paths.push(put.id);
    else ids.push(put.id);
  }

  return {
    world: joined(out, where.into, [...ids, ...artefacts, ...paths]),
    unrolled,
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
  /** The repeats that came across as single entries, copying or landing. */
  unrolled: Unrolled[]
  artefacts: ArtefactId[]
  paths: PathId[]
}

/**
 * The same, and only the keyframe it lands in: one keyframe's worth of shape,
 * born there, saying nothing about any other.
 *
 * The clipping's `stood` *is* the keyframe it was copied at, so this is the
 * paste started there with the tail dropped. For taking a shape somewhere else without taking
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
  v: KeyframeId,
  clips: readonly Clipping[],
  by: Point,
  where: Landing,
): Pasted {
  // Where the copy stood with everything it did there in: a stamp starts
  // there and has no list to play over it.
  const now = (clip: Clipping): Clipping => clip.kind === 'artefact' || clip.kind === 'path'
    ? { ...clip, ...still(clip), death: undefined, keys: [], unrolled: [] }
    : clip.kind === 'group'
    ? { ...clip, ...still(clip), members: clip.members.map(now), death: undefined, keys: [], unrolled: [] }
    : {
        ...clip,
        ...still(clip),
        unrolled: [],
        points: clip.points
          .filter(c => c.birth === 0)
          .map(c => ({ ...c, death: null })),
        death: undefined,
        keys: [],
        nudges: [],
        deep: [],
      };

  return pasted(world, v, clips.map(now), by, where);
}

function still(clip: Timed): { start: Frame, erosion: number } {
  return { start: clip.stood.frame, erosion: clip.stood.erosion };
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
