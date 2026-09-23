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
  fraction,
  Effecting,
  CRAMMED,
  FALLOFF,
  Facets,
  SEEDING,
  ArcTeeth,
  Imaged,
  PLAIN,
  SQUARE,
  facetsOf,
  segmentsFor,
  Ring,
  Shape,
  erode,
  erodeAt,
  erodeRingsAt,
  isCCW,
  keeping,
  diameter,
  mitred,
  nextOf,
  Naming,
  foldShaped,
  outlineOf,
  prevOf,
  signedArea2,
  subdivided,
  simplify,
  sliced,
} from '../geometry';
import {
  ArtefactId,
  ArtefactType,
  Clipping,
  Effects,
  Eye,
  FloorPart,
  GroupId,
  Options,
  IconType,
  Id,
  KINDS,
  LevelPart,
  PathId,
  SetName,
  Vertex,
  Polygon,
  PolygonId,
  PolygonKind,
  KeyframeId,
  Timed,
  Unrolled,
  VertexId,
  World,
  enclosing,
  inside,
  kindOf,
  unkinded,
  kindKey,
  opened,
  parentOf,
  ringsOf,
  inverted,
  sameKind,
  standing,
  within,
} from '../types';
import { outline } from '../worldset';
import { Key as Memo, remembered } from '../memo';
import { Affine, IDENTITY, compose, place, unplace } from '../affine';
import {
  EMPTY_RIG,
  Amount,
  Entry,
  Frame,
  Move,
  Op,
  REST,
  Rig,
  Scale,
  Stand,
  State,
  Turn,
  affineOf,
  blank,
  deepened,
  framed,
  heldFrame,
  indexIn,
  linear,
  nudged,
  once,
  placed,
  played,
  sheared,
  skipping,
  spun,
  stepped,
  stateAt,
  trivial,
  unsheared,
  withKeys,
  worldFrame,
  EMPTY_KEYS,
  KeyRig,
  blankKeys,
  entriesFor,
  keysOf,
  keysAt,
  withKeysAt,
  Key as RigKey,
  amountedBy,
  deltaOf,
  nextKey,
  nudgedBy,
  Playing,
  everyOp,
  playingAt,
  playingOn,
  anywhere,
  idle,
  lessBy,
  near,
  NOTHING,
  addedBy,
} from '../rig';

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
  /**
   * Its rounds and deforms, as the projection takes them: nothing where it has
   * none, or none of them comes to anything. See `effectedOf`.
   */
  effected?: Effected | null
}

/**
 * What rounds a polygon's corners and deforms its arcs, corner by corner and
 * index for index with `Resolved.corners`: each corner's facets, and the
 * bevel it is drawn at — the polygon's with the corner's own on top, and the
 * depth on that where the round is held. See `drawnBevels`.
 *
 * Lengths, so a frame that scales divides them the way it divides a depth.
 * The round is drawn before the erosion, and the teeth along the arcs with
 * it; the teeth along the straights are in the corners already. See
 * `deforms` and `outlineOf`.
 */
export interface Effected {
  facets: readonly Facets[]
  bevels: readonly number[]
  /** Which corners are teeth, which a round leaves square. */
  flat: readonly boolean[]
  /** The deform along the arcs: its options, and at each corner the
   * amplitude of the edge before it and of the edge after. Nothing where the
   * thing has no deform of its own, or no arc could take one. */
  deform: ArcDeform | null
  /** Which corners are rounded apart from the rest: see `outlineOf`. Only
   * the bake's, for a corner it invented. A corner apart names no wall, so
   * the wall it stands on keeps the pattern it had without it.
   *
   * With `apartTo`, the naming at the far end of the span, and `apartAt` how
   * far across it is: a wall splitting or joining then carries both patterns,
   * each at its own height, so that either end is the editor's still and the
   * middle shows the one going and the one coming. See PLAN-bevel's step 4. */
  apart?: readonly boolean[]
  apartTo?: readonly boolean[]
  apartAt?: number
}

export interface ArcDeform {
  e: Effecting
  before: readonly number[]
  after: readonly number[]
  /** Each corner's arc's name to the noise and the offset: its id. */
  keys: readonly number[]
  /** Each corner's own id, which is what names the edge leaving it: see
   * `namesOf`. The teeth along that edge are keyed and anchored by it. */
  ids: readonly number[]
  /** Each corner's bevel as it is seen, which its arc's teeth are laid by:
   * see `ArcTeeth.seen`. */
  seen: readonly number[]
}

/** How many segments a round of `bevel` is in. See `segmentsFor`. */
/** `bevel` is in the world and `scale` is what took it there (`scaleAt`):
 * the precision is a length at the thing's own scale, as the bevel was, so a
 * thing scaled keeps the facets it had. */
export function segmentsOf(round: Options['round'], bevel: number, scale = 1): number {
  return round.chamfer ? 1 : segmentsFor(bevel, round.precision * scale, round.tension);
}

/**
 * The options of one effect on a thing, with a corner's own over its
 * thing's, and nothing where the one that applies is switched off — or its
 * thing's is, which switches off its corners' with it.
 *
 * One function for both effects with options: they differ in nothing but
 * which key they read. See `Effects` in `types.ts`.
 */
export function optionOf<N extends keyof Options>(
  fx: Effects | undefined,
  name: N,
  own?: Partial<Effects>,
): Options[N] | undefined {
  const mine = fx?.[name] as Options[N] | undefined;

  if (mine?.off === true) return undefined;

  const option = (own?.[name] as Options[N] | undefined) ?? mine;

  return option?.off === true ? undefined : option;
}

/** Whether a thing's erosion applies: it does unless switched off. */
export function eroding(world: World, id: Id): boolean {
  return world.effects.get(id)?.erode?.off !== true;
}

/** A thing's options, with a corner's own over them where it has them. */
export function effecting(fx: Effects | undefined, own?: Partial<Effects>): Effecting {
  const deform = optionOf(fx, 'deform', own);

  return {
    spacing: deform?.spacing ?? 0,
    pattern: deform?.pattern ?? PLAIN.pattern,
    seed: deform?.seed ?? 0,
    sides: deform?.sides ?? PLAIN.sides,
    jitter: deform?.jitter ?? 0,
    falloff: deform?.falloff ?? FALLOFF,
    offset: true,
  };
}

/**
 * A polygon's round at its standing corners, from its options in the world
 * and its amounts as a keyframe leaves them — or as the bake has them part
 * way along — and the deform its arcs take. Nothing where it is not rounded,
 * or not by anything there: then the projection is its erosion alone,
 * exactly as it always was.
 *
 * `local` is where the corners are, and `depth` how deep each is eroded,
 * for a round that is held: see `drawnBevels`.
 */
export function effectedOf(
  world: World,
  id: Id,
  corners: readonly Vertex[],
  local: readonly Point[],
  amounts: Pick<State, 'bevel' | 'bevels' | 'amplitude' | 'amplitudes'>,
  depth: (i: number) => number,
  /** What took the amounts into the world: see `segmentsOf`. */
  scale = 1,
): Effected | null {
  const fx = world.effects.get(id);
  const deform = arcDeform(world, id, corners, amounts, scale, drawnBevels(world, id, corners, local, amounts, () => 0));

  // A deform with no round still has somewhere to be: the teeth are laid on
  // the eroded outline and the round is only one more thing that happens to
  // it first. See PLAN-bevel 3.1.
  if (fx?.round === undefined && !corners.some(c => world.cornerEffects.get(c.id)?.round !== undefined) && deform === null) return null;

  const bevels = drawnBevels(world, id, corners, local, amounts, depth);
  const seen = drawnBevels(world, id, corners, local, amounts, () => 0);
  const faceted = (round: Options['round'] | undefined, bevel: number): Facets =>
    (round === undefined ? SQUARE : facetsOf(segmentsOf(round, bevel, scale), round.tension));
  const flat = corners.map(c => c.root !== undefined);

  // Faceted as the arc is seen, not as it is drawn: a held round the erosion
  // draws bigger is the same curve once eroded, and would otherwise gain a
  // facet — and a line fading in — for a change nobody sees.
  return shaping({
    facets: corners.map((c, i) => (flat[i] ? SQUARE : faceted(optionOf(fx, 'round', world.cornerEffects.get(c.id)), bevels[i] > 0 ? seen[i] : 0))),
    bevels,
    flat,
    deform,
  });
}

/**
 * Each corner's bevel as it is drawn, before the erosion: the polygon's with
 * the corner's own on top, and nothing for a tooth or a corner not rounded.
 *
 * Where the round is held — which it is unless it says otherwise — the depth
 * the corner is eroded by goes on top of that where the corner turns out of
 * the material and comes off where it turns in, so that what the erosion
 * leaves is a round of the bevel asked for, at any depth. A bevel of nought
 * is nought, held or not: a corner eroded from square is square.
 */
export function drawnBevels(
  world: Pick<World, 'effects' | 'cornerEffects'>,
  id: Id,
  corners: readonly Vertex[],
  local: readonly Point[],
  amounts: Pick<State, 'bevel' | 'bevels'>,
  depth: (i: number) => number,
): number[] {
  const fx = world.effects.get(id);
  const rings = ringsOf(corners), n = corners.length;
  const drawn = (k: number) => corners[k].root === undefined;

  // Out of the material is to the right of the outline's way round: see
  // `deformedAt`. A corner turning left is one turning out of it.
  const first = local.slice(0, rings[1] ?? n);
  const wound = signedArea2(first) >= 0 ? 1 : -1;
  const convex = (i: number): number => {
    let a = prevOf(rings, n, i), c = nextOf(rings, n, i);

    while (!drawn(a) && a !== i) a = prevOf(rings, n, a);
    while (!drawn(c) && c !== i) c = nextOf(rings, n, c);

    const p = local[a], q = local[i], r = local[c];
    const turn = (q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x);

    return Math.sign(turn) * wound;
  };

  return corners.map((c, i) => {
    const round = optionOf(fx, 'round', world.cornerEffects.get(c.id));

    if (round === undefined || !drawn(i)) return 0;

    const seen = amounts.bevel + (amounts.bevels.get(c.id) ?? 0);

    if (!(seen > 0) || round.held === false) return Math.max(0, seen);

    // Down to a sliver of itself, never to nothing: an erosion deep enough to
    // take a corner that turns into the material back past its own bevel
    // would leave it square, and a square corner eroded mitres to a point
    // where a rounded one — however little — fans out at the depth. The two
    // are not near each other, so the corner keeps a hair of its round and
    // the fan is there throughout. `SEEDING` is what a corner barely turning
    // keeps of its bevel, for the same reason. See `arcs`.
    return Math.max(seen * SEEDING, seen + depth(i) * convex(i));
  });
}

/**
 * The deform a polygon's arcs take: its own, at its amounts, the amplitude
 * each side of a corner the one its edge has — nought on an edge the
 * timeline never deforms, as `deforms` has it for the straights. A group's
 * deform is its members' straights' alone.
 */
function arcDeform(
  world: World,
  id: Id,
  corners: readonly Vertex[],
  amounts: Pick<State, 'amplitude' | 'amplitudes'>,
  scale: number,
  seen: readonly number[],
): ArcDeform | null {
  const fx = world.effects.get(id);

  if (fx?.deform === undefined || fx.deform.off === true || !(fx.deform.spacing > 0)) return null;

  const ever = everDeformed(keyRigOf(world, id));
  const e = effecting(fx);
  const rings = ringsOf(corners), n = corners.length;
  const edge = (c: Vertex) => c.root ?? c.id;
  const amplitude = (from: VertexId) => (ever.all || ever.edges.has(from) ? amounts.amplitude + (amounts.amplitudes.get(from) ?? 0) : 0);

  return {
    e: { ...e, spacing: e.spacing * scale },
    before: corners.map((_c, i) => amplitude(edge(corners[prevOf(rings, n, i)]))),
    after: corners.map(c => amplitude(edge(c))),
    keys: corners.map(c => arcKey(c.id)),
    ids: corners.map(c => c.id),
    seen,
  };
}

/**
 * Which of `corners` are teeth, which a round leaves square. See
 * `outlineOf`.
 */
export function unrounded(corners: readonly Vertex[]): boolean[] {
  return corners.map(c => c.root !== undefined);
}

/** Kept only where it does something: a round that rounds, or a deform whose
 * teeth stand anywhere. */
export function shaping(e: Effected): Effected | null {
  const any = e.facets.some((f, i) => f.n > 0 && e.bevels[i] > 0);
  const toothed = e.deform !== null && e.deform.after.some(a => a !== 0);

  return any || toothed ? e : null;
}

/** A round as numbers, lengths divided by `s`, for `project`. */
function effectKey(e: Effected, s = 1): Memo[] {
  const d = e.deform;
  const deform: Memo[] = d === null
    ? []
    : [d.e.spacing / s, PATTERNS.indexOf(d.e.pattern), d.e.seed, SIDES.indexOf(d.e.sides), d.e.jitter, d.e.falloff, d.before.map(a => a / s), d.after.map(a => a / s), [...d.keys], d.seen.map(b => b / s), [...d.ids]];

  return [e.facets.map(facetKey), e.bevels.map(r => r / s), e.flat.map(Number), deform, (e.apart ?? []).map(Number), (e.apartTo ?? []).map(Number), e.apartAt ?? 0];
}

export const PATTERNS: readonly Effecting['pattern'][] = ['zigzag', 'sine', 'noise'];
export const SIDES: readonly Effecting['sides'][] = ['in', 'out', 'both'];

export function facetKey(f: Facets): number[] {
  return [f.n, f.from, f.to, f.at, f.tension];
}

function facetsFrom(k: Memo): Facets {
  const [n, from, to, at, tension] = k as number[];

  return { n, from, to, at, tension };
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
 * The keyframe a thing came in at: where a polygon, an artefact or a path was
 * born, and where a group was made — the first keyframe for one that never
 * said.
 */
export function bornAt(world: World, id: Id): KeyframeId | undefined {
  const group = world.groups.get(id);

  if (group !== undefined) return group.birth ?? world.keyframes[0]?.id;

  return lived(world, id)?.birth;
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

/**
 * The eye's id in the same list: the ghost of whoever is standing in the 3D
 * view, drawn and picked among the artefacts and belonging to no version.
 * Negative, for the reason the start's is.
 */
export const GHOST_ID: ArtefactId = -2;

/** The start as one of the things standing in the level. Every version gets
 * the same one. */
export function startPlaced(world: World): Placed {
  return { id: START_ID, type: 'start', at: world.start.at, facing: world.start.facing };
}

/** The eye as one of the things standing in the level: a start, drawn where
 * whoever is in the 3D view is standing and pointing the way they are facing. */
export function eyePlaced(eye: Eye): Placed {
  return { id: GHOST_ID, type: 'start', at: eye.at, facing: eye.facing };
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
  effects: readonly Memo[] | null,
): Shape => {
  if (effects === null) return offsetOf(source, rings, erosion, depths);

  // Rounded, deformed along its arcs, and then eroded: see `outlineOf`.
  return simplify(imagedBy(source, rings, erosion, depths, effects).shape);
});

/** Where each of a polygon's features lands: the construction `project`
 * builds its effects by, before the arrangement. */
const imagedBy = remembered((
  source: Ring,
  rings: readonly number[],
  erosion: number,
  depths: readonly number[] | null,
  effects: readonly Memo[],
): Imaged => {
  const [facets, bevels, flat, deform, apart, apartTo, apartAt] = effects as [Memo[], number[], number[], Memo[], number[], number[], number];
  const each = facets.map(facetsFrom);
  const [spacing, pattern, seed, sides, jitter, falloff, before, after, keys, seen, ids] = deform as [number, number, number, number, number, number, number[], number[], number[], number[], number[]];
  const e: Effecting | null = deform.length === 0
    ? null
    : { spacing, pattern: PATTERNS[pattern], seed, sides: SIDES[sides], jitter, falloff, offset: true };
  const teeth = (i: number): ArcTeeth | null => (e === null || (before[i] === 0 && after[i] === 0)
    ? null
    : { e, before: before[i], after: after[i], key: keys[i], seen: bevels[i] > 0 ? Math.min(CRAMMED, seen[i] / bevels[i]) : 1 });

  // Rounded and nothing else: the teeth are laid on what the erosion leaves,
  // not on this. See PLAN-bevel 3.1.
  const o = outlineOf(source, rings, () => false, i => each[i], i => bevels[i], () => null, i => apart[i] === 1);
  const deep = depths === null ? null : o.owner.map(i => depths[i]);
  const at = (k: number) => deep?.[k] ?? erosion;
  const image = (k: number) => mitred(o.ring, o.rings, k, at(k));
  const corners = o.arcs.map(run => {
    const images = run.map(image);

    return images.some(p => p === null) ? null : images as Point[];
  });
  const eroded = offsetOf(o.ring, o.rings, erosion, deep);
  const drawn = o.arcs.map(run => run.map(k => o.ring[k]));
  const rest = { corners, teeth: [] as Point[], drawn, rest: [], restSquare: [] };

  if (e === null) return { shape: eroded, ...rest };

  // What each run of the eroded outline is: a source edge's line, named by
  // the corner it leaves, and a rounded corner's arc, named by that corner.
  // The same thing `namesOf` reports, built from the inside so that nothing
  // has to resolve to ask. See PLAN-bevel 2.9.
  const n = source.length;
  const lines: { id: number, a: Point, b: Point }[] = [];
  const curves: { id: number, points: Point[] }[] = [];
  const same = (p: Point, q: Point) => p.x === q.x && p.y === q.y;

  // A corner the bake invented names nothing: it sits wherever its neighbours
  // put it, and a wall that took its name would lose its pattern the instant
  // the corner arrived. The line runs through it to the next real corner, as
  // the arcs beside it are laid as though it were not there. See
  // `effectsOver`.
  const linesBy = (aside: readonly boolean[]): { id: number, a: Point, b: Point }[] => {
    const names = (i: number) => !aside[i];
    const out: { id: number, a: Point, b: Point }[] = [];

    for (let i = 0; i < n; i++) {
      if (!names(i)) continue;

      let j = nextOf(rings, n, i);

      while (!names(j) && j !== i) j = nextOf(rings, n, j);

      const mine = corners[i], theirs = corners[j];

      if (mine === null || theirs === null) continue;

      const a = mine[mine.length - 1], b = theirs[0];

      if (same(a, b)) continue;

      out.push({ id: ids[i], a, b });
    }

    return out;
  };

  const near = ids.map((_x, i) => apart[i] === 1);
  const far = apartTo.length === 0 ? near : ids.map((_x, i) => apartTo[i] === 1);

  corners.forEach((run, i) => {
    if (run === null || run.length < 2 || near[i] || run.every(p => same(p, run[0]))) return;

    curves.push({ id: ids[i], points: run });
  });

  lines.push(...linesBy(near));

  // The far end's naming, where a corner arriving or leaving makes it differ:
  // the wall it splits carries both patterns across the span.
  const other = far.every((x, i) => x === near[i]) ? null : { lines: linesBy(far), weight: apartAt };

  const amplitude = new Map(ids.map((id, i) => [id, after[i]]));

  // Which source corner each point of the eroded outline came of: the arcs
  // report it, so a run is named outright and nothing is matched to a line
  // within a tolerance. A point a crossing made is in no arc and names
  // nothing. See `Naming`.
  // Matched with a tolerance, not by equality: the arrangement the erosion
  // runs may hand a point back a hair from where `mitred` put it, as
  // `foldShaped`'s own `onArc` allows for.
  let big = 1;

  for (const ring of eroded) for (const p of ring) big = Math.max(big, Math.abs(p.x), Math.abs(p.y));

  const tol = big * 1e-9;
  const from: { p: Point, of: number }[] = [];

  corners.forEach((run, i) => run?.forEach(p => from.push({ p, of: i })));

  const owner = (p: Point): number | undefined => from.find(q => Math.abs(q.p.x - p.x) <= tol && Math.abs(q.p.y - p.y) <= tol)?.of;

  /** The naming that `aside` gives: a corner set aside names no run, so the
   * one before it keeps the whole of what it had. */
  const namingBy = (aside: readonly boolean[], of: readonly { id: number, a: Point, b: Point }[]): Naming => {
    const line = new Map(of.map(l => [l.id, l]));

    return (a: Point, b: Point) => {
      const mine = owner(a);

      // Inside an arc, both ends being points of the same corner's curve:
      // that is the arc's own to tooth, not a run's — unless the corner is
      // one set aside, whose arc is a sliver the run goes straight through.
      // Break the run there and a wall would lose its pattern the moment such
      // a corner lifted off it.
      if (mine === undefined || (mine === owner(b) && !aside[mine])) return null;

      let k = mine;

      while (aside[k]) {
        const back = prevOf(rings, n, k);

        if (back === mine) return null;

        k = back;
      }

      const l = line.get(ids[k]);

      if (l === undefined) return null;

      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);

      if (len === 0) return null;

      const mid = { x: (l.a.x + l.b.x) / 2, y: (l.a.y + l.b.y) / 2 };

      return {
        key: ids[k],
        from: ((mid.x - a.x) * dx + (mid.y - a.y) * dy) / len,
        reach: Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y) / 2,
      };
    };
  };

  const laid = foldShaped(eroded, [], [], lines, curves, SQUARE, 0, false, {
    e,
    amplitude: (key: number) => amplitude.get(key) ?? 0,

    // The teeth are the edge's, laid over its length wherever the erosion has
    // put the run's ends.
    reach: true,
    naming: namingBy(near, lines),
    over: other === null ? undefined : { ...other, naming: namingBy(far, other.lines) },
  }, 0);

  return { shape: laid.shape, ...rest };
});

/** The noise's name for a corner's arc: its own, told apart from the edge it
 * starts, which has the same id. */
function arcKey(id: number): number {
  return id ^ 0x5bd1e995;
}

/**
 * Where each corner's arc and each edge's deform points land in a polygon's
 * projection, in world units: `imaged`, taken the way `projection` takes it.
 * Nothing for a polygon with no effects.
 *
 * What the bake asks instead of `mitred` wherever effects are on, so that
 * where it thinks a point is and where the projection put it cannot differ.
 */
export function imagesOf(at: Omit<Resolved, 'shape'>): Imaged | null {
  const fx = at.effected ?? null;

  if (fx === null) return null;

  const s = similarity(at.frame);

  if (s === null) return imagedBy(at.source, at.rings, at.erosion, at.depths, effectKey(fx));

  const im = imagedBy(at.local, at.rings, at.erosion / s, scaled(at.depths, s), effectKey(fx, s));
  const run = (r: Point[] | null) => (r === null ? null : place(at.frame, r));

  return {
    shape: im.shape.map(ring => place(at.frame, ring)),
    corners: im.corners.map(run),
    teeth: place(at.frame, im.teeth ?? []),
    drawn: (im.drawn ?? []).map(r => place(at.frame, r)),
    rest: im.rest.map(r => place(at.frame, r)),
    restSquare: im.restSquare,
  };
}

/**
 * What a member of a sealed scope publishes about its outline, so that the
 * fold can name the pieces it is made of: see PLAN-bevel 2.9.
 *
 * A straight of the fold lies on the line of exactly one member edge — the
 * arrangement cuts edges up and drops the pieces inside, but it never moves
 * one off its line — and a run of the fold that is a member's arc is that
 * arc's own points. So each comes up named by the corner it belongs to, and
 * the group's teeth are keyed and anchored by that name rather than by where
 * the piece happens to lie today.
 *
 * In world units, as the member's projection is, and after its erosion: a
 * line is where the edge *is*, not where it was drawn.
 */
export interface Named {
  /** A source edge, named by the corner it leaves: two points on its line,
   * being where its ends are once its corners are rounded and eroded. */
  lines: { id: VertexId, a: Point, b: Point }[]
  /** A rounded corner's arc, named by that corner: its points in ring
   * order. Nothing for a corner that is not rounded, or whose arc has no
   * length. */
  arcs: { id: VertexId, points: Point[] }[]
}

/**
 * `Named` for one resolved polygon: an entry per edge that reaches the
 * projection and per arc that has any length.
 *
 * A tooth is not a corner of the source and names nothing; it belongs to the
 * edge its `root` names, and that edge's line runs from the arc at one end of
 * it to the arc at the other, which the teeth stand off but do not move.
 */
export function namesOf(at: Omit<Resolved, 'shape'>): Named {
  const lines: Named['lines'] = [], arcs: Named['arcs'] = [];
  const n = at.corners.length;
  const drawn = (i: number) => at.corners[i].root === undefined;
  const im = imagesOf(at);
  const same = (p: Point, q: Point) => p.x === q.x && p.y === q.y;

  // Where each corner's arc lies, or the corner's own image where it has
  // none: what an edge's ends are.
  const run = (i: number): Point[] | null => {
    if (im !== null) return im.corners[i];

    const p = mitred(at.source, at.rings, i, at.depths?.[i] ?? at.erosion);

    return p === null ? null : [p];
  };
  const runs = at.corners.map((_c, i) => (drawn(i) ? run(i) : null));

  runs.forEach((points, i) => {
    if (points === null || points.length < 2 || points.every(p => same(p, points[0]))) return;

    arcs.push({ id: at.corners[i].id, points });
  });

  for (let i = 0; i < n; i++) {
    if (!drawn(i)) continue;

    // The next corner of the source, whatever teeth the deform put between.
    let j = nextOf(at.rings, n, i);

    while (!drawn(j) && j !== i) j = nextOf(at.rings, n, j);

    const mine = runs[i], theirs = runs[j];

    if (mine === null || theirs === null) continue;

    const a = mine[mine.length - 1], b = theirs[0];

    if (same(a, b)) continue;

    lines.push({ id: at.corners[i].id, a, b });
  }

  return { lines, arcs };
}

/**
 * `Named` moved in by `depth`, the way the erosion moves what it names: a
 * line along its own normal, which is exactly where the erosion puts it, and
 * an arc's points each on the mitre of the two segments at it — the two
 * inside the run, and at its ends the line that leaves it, which is why the
 * lines and the arcs are moved together.
 *
 * Out of the material is to the right of the way round, so in is to the left.
 */
export function movedIn(named: Named, depth: number): Named {
  if (depth === 0) return named;

  const left = (a: Point, b: Point): Point | null => {
    const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy);

    return l === 0 ? null : { x: -dy / l, y: dx / l };
  };
  const by = (p: Point, n: Point) => ({ x: p.x + n.x * depth, y: p.y + n.y * depth });
  const same = (p: Point, q: Point) => p.x === q.x && p.y === q.y;
  const key = (p: Point) => `${p.x},${p.y}`;

  // What leaves and arrives at an arc's ends: the lines `namesOf` laid from
  // them, which share their points exactly.
  const before = (p: Point) => named.lines.find(l => same(l.b, p)) ?? null;
  const after = (p: Point) => named.lines.find(l => same(l.a, p)) ?? null;

  const arcs = named.arcs.map(arc => {
    const ends = [before(arc.points[0]), after(arc.points[arc.points.length - 1])];
    const ways = arc.points.map((p, i) => {
      const a = i === 0 ? (ends[0] === null ? null : left(ends[0].a, ends[0].b)) : left(arc.points[i - 1], p);
      const b = i === arc.points.length - 1
        ? (ends[1] === null ? null : left(ends[1].a, ends[1].b))
        : left(p, arc.points[i + 1]);

      return { a: a ?? b, b: b ?? a };
    });

    return {
      id: arc.id,
      points: arc.points.map((p, i) => {
        const { a, b } = ways[i];

        if (a === null || b === null) return p;

        // The two offset lines meet on the bisector, as far out along it as
        // the half angle between them makes it: `mitred`, for a point whose
        // two ways are already normals.
        const x = a.x + b.x, y = a.y + b.y, l = Math.hypot(x, y);

        if (l === 0) return p;

        const cos = Math.max(1e-6, l / 2);

        return { x: p.x + x / l * depth / cos, y: p.y + y / l * depth / cos };
      }),
    };
  });

  // A line ends where an arc does, and goes on doing: both are moved by the
  // same mitre there, so a scope holding this one still finds its lines and
  // its arcs by the points they share. Elsewhere a line moves by its own
  // normal, which is exactly where the erosion puts it.
  const ends = new Map<string, Point>();

  named.arcs.forEach((arc, i) => {
    const mine = arcs[i].points;

    ends.set(key(arc.points[0]), mine[0]);
    ends.set(key(arc.points[arc.points.length - 1]), mine[mine.length - 1]);
  });

  const lines = named.lines.flatMap(l => {
    const n = left(l.a, l.b);

    return n === null ? [] : [{ id: l.id, a: ends.get(key(l.a)) ?? by(l.a, n), b: ends.get(key(l.b)) ?? by(l.b, n) }];
  });

  return { lines, arcs };
}

/** The erosion alone: the first of the three, and all of it for a polygon
 * with no effects. */
function offsetOf(source: Ring, rings: readonly number[], erosion: number, depths: readonly number[] | null): Shape {
  // One ring is the case the winding still has to be settled for: a source ring
  // is whatever it was drawn as, and `erodeAt` is what decides which way is in.
  // A source with holes in it has already said, by how its rings are wound, and
  // settling each of them on its own would fill the holes.
  if (depths !== null) {
    return rings.length <= 1 ? erodeAt(source, depths) : erodeRingsAt(sliced(source, rings), depths);
  }

  const simple = simplify(sliced(source, rings));

  return erosion === 0 ? simple : erode(simple, erosion);
}

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
  const fx = at.effected ?? null;

  if (s === null) return project(at.source, at.rings, at.erosion, at.depths, fx === null ? null : effectKey(fx));

  return project(at.local, at.rings, at.erosion / s, scaled(at.depths, s), fx === null ? null : effectKey(fx, s))
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
 * The deforms a polygon's rings go through at keyframe `v`, in the order they
 * are done: its own, and then each group's holding it, outwards. A group's
 * deform is its members', each on its own rings — what a group deforms is
 * what it holds, and taking the deform off the group takes it off them all.
 *
 * Each with its options, and the amplitude of each edge by the corner it
 * starts at: the thing's own amplitude, and for a polygon's own deform the
 * edge's on top.
 */
/**
 * How much a thing is scaled at `v`, as one number: the square root of how
 * much its frame, and every frame holding it, scales area.
 *
 * What every amount is multiplied by — an erosion's depth, a bevel, a
 * deform's spacing and amplitude — so that a thing scaled is the same thing
 * bigger, eroded, rounded and toothed in proportion. At scale one, which is
 * where nearly everything stands, an amount is a length in the world, on the
 * grid and alike from room to room. See `scaledState`.
 */
export function scaleAt(world: World, id: Id, v: KeyframeId): number {
  const f = worldFrame(world, id, v);

  return Math.sqrt(Math.abs(f.a * f.d - f.b * f.c));
}

/**
 * A thing's state at `v` with its amounts taken into the world: every depth,
 * bevel and amplitude multiplied by `scaleAt`. What anything turning the
 * amounts into geometry reads; `stateAt` is the timeline's own numbers, which
 * is what anything writing keys reads.
 */
export function scaledState(world: World, id: Id, v: KeyframeId): State {
  const state = stateAt(world, id, v);
  const k = scaleAt(world, id, v);

  if (k === 1) return state;

  const by = (m: ReadonlyMap<VertexId, number>) => (m.size === 0 ? m : new Map([...m].map(([c, d]) => [c, d * k])));

  return {
    ...state,
    erosion: state.erosion * k,
    depths: by(state.depths),
    bevel: state.bevel * k,
    bevels: by(state.bevels),
    amplitude: state.amplitude * k,
    amplitudes: by(state.amplitudes),
  };
}

export function deforms(world: World, v: KeyframeId, id: Id): Deforming[] {
  const out: Deforming[] = [];

  for (const owner of [id, ...enclosing(world, id)]) {
    const fx = world.effects.get(owner);

    // A sealed group's deform is laid on its fold, not on its members: see
    // `groupDeform`.
    if (owner !== id && world.groups.get(owner)?.sealed === true) continue;

    if (fx?.deform === undefined || fx.deform.off === true || !(fx.deform.spacing > 0)) continue;

    const state = scaledState(world, owner, v);
    const ever = everDeformed(keyRigOf(world, owner));
    const own = owner === id;
    const e = effecting(fx);

    out.push({
      owner,
      // A loose group's deform is laid along each member's edges, the walls
      // they share included, and stays from their middles: offset, two
      // members' teeth along one wall fall wherever they fall, and the
      // arrangement flickers where they meet.
      e: { ...e, spacing: e.spacing * scaleAt(world, owner, v), offset: own },
      amplitude: own ? from => state.amplitude + (state.amplitudes.get(from) ?? 0) : () => state.amplitude,
      toothed: own ? from => ever.all || ever.edges.has(from) : () => ever.all,
    });
  }

  return out;
}

/**
 * A sealed group's own deform, which is laid along its fold rather than its
 * members' edges: see `foldShaped`. Nothing where it has none, or where its
 * timeline never deforms the whole of it — a union's edges have no ids for an
 * amount to be written about one of them by.
 */
export function groupDeform(world: World, id: Id, amplitude: number, scale: number): { e: Effecting, amplitude: number } | null {
  const fx = world.effects.get(id);

  if (fx?.deform === undefined || fx.deform.off === true || !(fx.deform.spacing > 0)) return null;
  if (!everDeformed(keyRigOf(world, id)).all) return null;

  const e = effecting(fx);

  return { e: { ...e, spacing: e.spacing * scale, offset: false }, amplitude };
}

/** What `diameterAt` has answered, for each world it was asked about. */
const diameters = new WeakMap<World, Map<string, number>>();

/**
 * How big a thing is at `v`: the diameter of every corner it stands on, in
 * the world, before any deform or erosion. What a deform's spacing is first
 * set from and shown against — see `sizedFor` and the pane — and nothing a
 * deform is laid by.
 *
 * A group's is of all its members together, which is the diameter of their
 * union: the union covers every corner, and nothing of it reaches past their
 * hull.
 */
export function diameterAt(world: World, v: KeyframeId, id: Id): number {
  let known = diameters.get(world);

  if (known === undefined) diameters.set(world, known = new Map());

  const key = `${v}:${id}`;
  const was = known.get(key);

  if (was !== undefined) return was;

  const from = new Set(chain(world, v));
  const points: Point[] = [];

  for (const p of polygonsIn(world, [id])) {
    if (!standingIn(world, p, from)) continue;

    points.push(...place(worldFrame(world, p, v), [...stateAt(world, p, v).corners.values()]));
  }

  const size = diameter(points);

  known.set(key, size);

  return size;
}

/**
 * One deform a polygon's rings go through. `toothed` is whether an edge gets
 * teeth at all: only one some amount somewhere in the timeline deforms, so an
 * edge deformed on its own leaves the others straight and their corners' bevels
 * whole.
 */
interface Deforming {
  owner: Id
  e: Effecting
  amplitude: (from: VertexId) => number
  toothed: (from: VertexId) => boolean
}

/**
 * What a thing's timeline ever deforms: all its edges, where an amount is
 * written about the whole thing, and the edges written about one by one.
 * Over every keyframe rather than at one, so an edge has its teeth at each —
 * flat where its amplitude is nought — and they never come or go with it.
 */
function everDeformed(rig: KeyRig): { all: boolean, edges: ReadonlySet<VertexId> } {
  const edges = new Set<VertexId>();
  let all = false;

  for (const list of rig.keys.values()) {
    for (const key of list) {
      if ((key.by?.deform ?? 0) !== 0) all = true;

      key.deforms?.forEach((a, from) => a !== 0 && edges.add(from));

      if (key.stand !== undefined) {
        if (key.stand.amplitude !== 0) all = true;

        key.stand.amplitudes.forEach((a, from) => a !== 0 && edges.add(from));
      }
    }
  }

  return { all, edges };
}

/**
 * A polygon's standing corners with its deforms done to them: its rings
 * subdivided and perturbed, in the world, before anything else happens to
 * them. See `subdivided` in `geometry.ts`.
 *
 * The teeth are corners from here on, each with an id of its own made from
 * who deforms it, the corner its edge starts at, and which tooth it is — so it
 * is the same corner at every keyframe, and the bake carries it as it carries
 * any other. A tooth's extra depth is its edge's, in proportion along it, so
 * a varying erosion leaves a straight edge straight. What has no deform comes
 * back as it came.
 *
 * Every deform keeps each drawn corner's bevel — `bevel`, as it is drawn —
 * free of teeth, which stop short of the arc there rather than run into it:
 * see `patternRun`. The arc takes teeth of its own: see `outlineOf`.
 */
function deformedAt(
  world: World,
  v: KeyframeId,
  id: Id,
  corners: readonly Vertex[],
  local: readonly Point[],
  frame: Affine,
  over: ReadonlyMap<VertexId, number>,
  bevel: (c: Vertex) => number,
): { corners: Vertex[], local: Point[], source: Point[], over: ReadonlyMap<VertexId, number> } {
  const chain = deforms(world, v, id);

  // Nothing here any more: the teeth are laid on the eroded outline, in the
  // projection, and a polygon's standing corners are the ones it was drawn
  // with. See PLAN-bevel 3.1 and `imagedBy`.
  if (chain.length >= 0) return { corners: [...corners], local: [...local], source: place(frame, local), over };

  let cs: Vertex[] = [...corners];
  let pts: Point[] = place(frame, local);
  let deep: number[] = cs.map(c => over.get(c.id) ?? 0);

  for (const { owner, e, amplitude, toothed } of chain) {
    const rings = ringsOf(cs);
    const slices = sliced(pts, rings);

    // Out of the material is to the right of a ring wound the way the outline
    // is, counter-clockwise, and a hole is wound the other way.
    const out: 1 | -1 = signedArea2(slices[0]) >= 0 ? 1 : -1;
    const next: Vertex[] = [], placed: Point[] = [], depths: number[] = [];

    slices.forEach((ring, r) => {
      const at = rings[r];

      const clear = (i: number) => (cs[at + i].root === undefined ? Math.max(0, bevel(cs[at + i])) : 0);
      const laid = subdivided(ring, e, i => amplitude(cs[at + i].id), i => cs[at + i].id, out, clear, i => toothed(cs[at + i].root ?? cs[at + i].id));

      for (const made of laid) {
        const from = cs[at + made.from];
        const d0 = deep[at + made.from], d1 = deep[at + (made.from + 1) % ring.length];

        placed.push(made.at);

        if (made.j === null) {
          next.push(from);
          depths.push(d0);
          continue;
        }

        next.push({ ...from, id: toothId(owner, from.id, made.j), root: from.root ?? from.id });
        depths.push(d0 + (d1 - d0) * made.along);
      }
    });

    cs = next;
    pts = placed;
    deep = depths;
  }

  const inverse = pts.map(p => unplace(frame, p));
  const deeper = over.size === 0 ? over : new Map(cs.flatMap((c, i) => (deep[i] === 0 ? [] : [[c.id, deep[i]] as const])));

  // A tooth is where it is, in the polygon's own frame, like any corner.
  return {
    corners: cs.map((c, i) => (c.root === undefined ? c : { ...c, at: inverse[i] })),
    local: inverse,
    source: pts,
    over: deeper,
  };
}

/**
 * A tooth's id: who deformed it, the corner its edge starts at, and which
 * tooth. Negative, so nothing counted out of `nextId` is ever one, and the
 * same numbers every time.
 */
function toothId(owner: Id, from: VertexId, j: number): VertexId {
  const text = `${owner}:${from}:${j}`;
  let a = 0x811c9dc5, b = 0x01000193;

  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);

    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
    b ^= b >>> 13;
  }

  return -((a >>> 0) * 0x100000 + ((b >>> 0) >>> 12)) - 1;
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
    const state = erodingOnly(world, id, scaledState(world, id, v));
    const corners = surviving(polygon.points, c => state.corners.has(c.id));

    // A polygon whose outline has gone is not geometry any more. It cannot
    // happen through the editor, which will not take a ring below three, but
    // resolving is not the place to be sure of that.
    if (corners.length < 3) continue;

    const frame = worldFrame(world, id, v);
    const fx = world.effects.get(id);
    const depth = (c: Vertex) => state.erosion + (state.depths.get(c.id) ?? 0);
    const rest = corners.map(c => state.corners.get(c.id)!);
    const bevels = drawnBevels(world, id, corners, rest, state, i => depth(corners[i]));
    const bevelOf = new Map(corners.map((c, i) => [c.id, bevels[i]]));
    const drawn = deformedAt(world, v, id, corners, rest, frame, state.depths, c => bevelOf.get(c.id) ?? 0);
    const deep = new Map(drawn.corners.map(c => [c.id, depth(c)]));

    out.push(resolved({
      id,
      polygon,
      corners: drawn.corners,
      local: drawn.local,
      frame,
      source: drawn.source,
      erosion: state.erosion,
      over: drawn.over,
      depths: varying(drawn.corners, state.erosion, drawn.over),
      effected: effectedOf(world, id, drawn.corners, drawn.local, state, i => deep.get(drawn.corners[i].id)!, scaleAt(world, id, v)),
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

/** A state with its erosion taken out where the thing's is switched off. */
function erodingOnly(world: World, id: Id, state: State): State {
  return eroding(world, id) ? state : { ...state, erosion: 0, depths: new Map() };
}

/** Everything written about a thing, as keys: what the world holds. */
export function keyRigOf(world: World, id: Id): KeyRig {
  return world.rigs.get(id) ?? EMPTY_KEYS;
}

/** A thing's timeline replaced. One with nothing in it is taken out. */
export function withKeyRig(world: World, id: Id, rig: KeyRig): World {
  const rigs = new Map(world.rigs);

  if (blankKeys(rig)) rigs.delete(id);
  else rigs.set(id, rig);

  return { ...world, rigs };
}

/**
 * Everything written about a thing, as entries, and a thing's timeline
 * replaced from entries.
 *
 * For the tests, which say what a timeline does as operations because that is
 * what an operation is for — one thing, plainly. Nothing the editor does goes
 * through here: a key is what it writes and what it reads. Reading a file
 * older than a 24 goes through `keysOf` too, in `save.ts`.
 */
export function rigOf(world: World, id: Id): Rig {
  return entriesFor(keyRigOf(world, id));
}

/** The keys it had are handed over with it, so that everything the write did
 * not touch comes back the same objects — see `kept` in `rig.ts`. */
export function withRig(world: World, id: Id, rig: Rig): World {
  return withKeyRig(world, id, keysOf(rig, world.rigs.get(id)));
}

/** What keyframe `v` does to a thing, as entries. For the tests, as `rigOf`. */
export function listAt(world: World, v: KeyframeId, id: Id): readonly Entry[] {
  return rigOf(world, id).keys.get(v) ?? [];
}

/** The keys keyframe `v` writes about a thing, in the order they play. */
export function keysOfAt(world: World, v: KeyframeId, id: Id): readonly RigKey[] {
  return keysAt(keyRigOf(world, id), v);
}

/** `k`'s list for `id`, written outright as operations. For the tests, as
 * `rigOf`. */
export function keyed(world: World, k: KeyframeId, id: Id, list: readonly (Op | Entry)[]): World {
  const entries = list.map(e => ('op' in e ? e : once(e)));

  return withRig(world, id, withKeys(rigOf(world, id), k, entries));
}

/**
 * The world as a thing's keyframe leaves it after `index` keys of it, rather
 * than after all of them: what standing on a key shows.
 *
 * A world of its own rather than a state read out of the walk, so that
 * everything that draws a keyframe — the resolve, the CSG, the outlines —
 * answers about that moment without being taught what a moment is. Nothing
 * else about it changes: every other thing is where that keyframe leaves it.
 */
export function upto(world: World, v: KeyframeId, id: Id, index: number): World {
  const rig = keyRigOf(world, id);
  const list = keysAt(rig, v);

  if (index >= list.length - 1) return world;

  return withKeyRig(world, id, withKeysAt(rig, v, list.slice(0, index + 1)));
}

/**
 * An empty key at the end of the keyframe for each of `ids`: the next thing
 * written there fills it rather than growing the one before.
 *
 * A gesture folds into the keyframe's last key — a hand that moves a thing and
 * then turns it leaves one key, which is one motion — so an author says that
 * one is finished by starting another. An empty key does nothing at all, and
 * says so: the keyframe view draws it hollow, and the gesture that fills it
 * fills it in.
 */
export function broken(world: World, v: KeyframeId, ids: readonly Id[]): World {
  let out = world;

  for (const id of ids) {
    const rig = keyRigOf(out, id);
    const list = keysAt(rig, v);
    const last = list[list.length - 1];

    // The first key where a thing is born is not shown — what it does there
    // is its shape, not a motion — so a break before anything was written
    // there makes that one and then the empty one it asked for.
    const birth = bornAt(out, id) === v;
    const first = last === undefined && birth;

    // One empty key is enough: breaking twice says what breaking once said.
    if (last?.by !== undefined && idle(last.by) && !(birth && list.length === 1)) continue;
    const under = first ? addedBy(rig, v, REST.t, NOTHING) : rig;

    out = withKeyRig(out, id, addedBy(under, v, REST.t, NOTHING));
  }

  return out;
}

/**
 * The last gesture taken out of the key it was folded into, into a key of its
 * own: what `was` does not say and the world does.
 *
 * The editor knows what the hand just did even though the key has absorbed it,
 * because it kept the world from before — see `EditorState.history`. What is
 * split off is the difference between the two, which is exact: a delta and a
 * delta about one painted point compose by adding their numbers, so they come
 * apart by taking them away again.
 *
 * The key is the one `on` names for each thing — the one the hand is on, which
 * is where its last gesture went — and the keyframe's last where it names
 * none. What is split off goes straight after it.
 *
 * Nothing where the key is not there in both, where the gesture wrote a key of
 * its own, or where it wrote about single corners, which is a key of its own
 * already.
 */
export function split(
  world: World,
  was: World,
  v: KeyframeId,
  ids: readonly Id[],
  on: ReadonlyMap<Id, number> = new Map(),
): World {
  let out = world;

  for (const id of ids) {
    const rig = keyRigOf(out, id);
    const list = keysAt(rig, v);
    const named = on.get(id);
    const at = named === undefined ? list.length - 1 : list.findIndex(k => k.id === named);
    const now = list[at];
    const before = keysAt(keyRigOf(was, id), v).find(k => k.id === now?.id);

    // The key's painted point is the gesture's where what was there before it
    // had none of its own — see `anywhere` in `rig.ts`.
    if (now?.by === undefined || before?.by === undefined) continue;
    if (!near(now.ref, before.ref) && !anywhere(before.by)) continue;

    const by = lessBy(now.by, before.by);

    if (idle(by)) continue;

    const key: RigKey = { id: nextKey(rig), ref: now.ref, by, times: 1 };

    out = withKeyRig(out, id, withKeysAt(rig, v, [...list.slice(0, at), before, key, ...list.slice(at + 1)]));
  }

  return out;
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
    && keysOfAt(world, v, id).some(key => key.stand !== undefined);
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

  // The steps of repeats begun earlier, which come before the keyframe's own
  // keys and are what a stand here has to have in it.
  const steps = base === null ? [] : playingAt(world, id, v).filter(p => p.at !== v).flatMap(everyOp);

  let frame = base === null ? REST : before.frame;
  let erosion = base === null ? 0 : before.erosion;
  let bevel = base === null ? 0 : before.bevel;
  let amplitude = base === null ? 0 : before.amplitude;

  for (const op of steps) {
    if (op.kind === 'erode') erosion += op.by;
    else if (op.kind === 'round') bevel += op.by;
    else if (op.kind === 'deform') amplitude += op.by;
    else frame = played(frame, op);
  }

  const here = stateAt(world, id, v);

  /** What `v`'s own keys say about one corner, of one kind, added up. */
  const ours = (held: 'corners' | 'depths' | 'rounds' | 'deforms', c: VertexId): number | Point => {
    let out: number | Point = held === 'corners' ? { x: 0, y: 0 } : 0;

    for (const key of keysOfAt(world, v, id)) {
      const by = key[held]?.get(c);

      if (by === undefined) continue;

      out = typeof out === 'number' ? out + (by as number) : { x: out.x + (by as Point).x, y: out.y + (by as Point).y };
    }

    return out;
  };

  const corners = new Map([...here.corners].map(([c, p]) => {
    const own = ours('corners', c) as Point;

    return [c, { x: p.x - own.x, y: p.y - own.y }];
  }));

  // Each corner's amounts less what `v` adds to them.
  const less = (
    amounts: ReadonlyMap<VertexId, number>,
    held: 'depths' | 'rounds' | 'deforms',
  ): Map<VertexId, number> => {
    const out = new Map<VertexId, number>();

    for (const [c, d] of amounts) {
      const left = d - (ours(held, c) as number);

      if (left !== 0) out.set(c, left);
    }

    return out;
  };

  return {
    kind: 'stand',
    frame,
    erosion,
    corners,
    depths: less(here.depths, 'depths'),
    bevel,
    amplitude,
    bevels: less(here.bevels, 'rounds'),
    amplitudes: less(here.amplitudes, 'deforms'),
  };
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

  for (const id of going) {
    const rig = keyRigOf(out, id);
    const stand: RigKey = { id: nextKey(rig), ref: REST.t, stand: handed(world, v, id), times: 1 };

    out = withKeyRig(out, id, withKeysAt(rig, v, [stand, ...keysAt(rig, v)]));
  }

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

  for (const id of going) {
    const rig = keyRigOf(out, id);

    out = withKeyRig(out, id, withKeysAt(rig, v, keysAt(rig, v).filter(key => key.stand === undefined)));
  }

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

  groups.set(id, { members: tops, sealed: false, birth: v });

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

      if (blankKeys(rig)) rigs.delete(member);
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
    case 'round':
    case 'deform':
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
): { rig: KeyRig, unrolled: Unrolled[] } | null {
  const rig = keyRigOf(world, m);
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

  return out === null ? null : { rig: { keys: out.keys }, unrolled: out.unrolled };
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
  source: Playing
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
): { keys: Map<KeyframeId, RigKey[]>, unrolled: Unrolled[] } | null {
  const rows: Crossed[][] = [];

  for (let i = first; i < world.keyframes.length; i++) {
    const k = world.keyframes[i].id;
    const before = keyAt(world, i - 1);

    let outer = across(i);
    let inner = i === first || before === null ? REST : stateAt(world, m, before).frame;

    if (outer === null) return null;

    const row: Crossed[] = [];

    // A key at a time, as the operations it is made of: what carries out of a
    // group is an operation, and a key that holds more than one carries as the
    // ones it holds. See `opsOf` in `rig.ts`.
    const mine = playingAt(world, m, k).flatMap(p => everyOp(p).map(op => ({ op, source: p })));

    // Born after the first keyframe, it begins at rest in whatever holds it
    // — which, on the other side of the frame, is the frame itself. Unless it
    // begins with a stand, which says where it is outright.
    if (i === first && before !== null && mine[0]?.op.kind !== 'stand') {
      for (const op of arrival(outer)) {
        const source: Playing = { ref: ORIGIN, by: deltaOf(op) ?? undefined, key: MADE, at: k, step: 0 };

        row.push({ source, group: false, ops: [op] });
      }
    }

    for (const { op, source } of mine) {
      const out = outward(op, outer, inner);

      if (out === null) return null;

      row.push({ source, group: false, ops: out });
      inner = played(inner, op);
    }

    if (g !== null) {
      let both = framed(compose(affineOf(outer), affineOf(inner)));

      if (both === null) return null;

      const theirs = playingAt(world, g, k).flatMap(p => everyOp(p).map(op => ({ op, source: p })));

      for (const { op, source } of theirs) {
        const out = inward1(world, k, m, op, outer, both);

        if (out === null) return null;

        outer = played(outer, op);

        for (const o of out) both = played(both, o);

        row.push({ source, group: true, ops: out });
      }
    }

    rows.push(row);
  }

  // Every repeat that played, with its steps in the order they were taken.
  const steps = new Map<RigKey, Crossed[]>();

  for (const row of rows) {
    for (const c of row) {
      if (c.source.key.times === 1 || c.source.stand !== undefined) continue;

      const all = steps.get(c.source.key) ?? [];

      all.push(c);
      steps.set(c.source.key, all);
    }
  }

  const kept = new Set<RigKey>();
  const unrolled: Unrolled[] = [];

  /** Written where, and which of that keyframe's keys. */
  const whose = (c: Crossed): Unrolled => {
    const id = c.group ? g! : m;
    const list = keysOfAt(world, c.source.at, id);

    return { id, at: c.source.at, nth: list.indexOf(c.source.key), why: 'order' };
  };

  // Each repeat is compared from the first step it takes here, which is its
  // own entry unless it was already running where `m` begins. A repeat's
  // steps from its n-th on are the n-th step repeated — a step of a step is a
  // step — so one already running is kept by writing that.
  for (const [key, all] of steps) {
    const head = all[0];
    const h = head.source.step;
    let why: Unrolled['why'] | null = null;

    if (all.some(c => c.ops.length !== 1)) why = 'squash';
    else if (all.some(c => !sameOp(c.ops[0], stepped(head.ops[0], c.source.step - h)))) {
      why = head.group ? 'moving' : 'reshaped';
    }

    if (why === null && keep) kept.add(key);
    else unrolled.push({ ...whose(head), why: why ?? 'order' });
  }

  // Where each kept repeat is in the order the walk will play kept steps in:
  // the keyframe it is written at, and its place in what that keyframe
  // played.
  const rank = new Map<RigKey, number>();

  rows.forEach((row, i) => row.forEach((c, j) => {
    if (!rank.has(c.source.key)) rank.set(c.source.key, i * 1e6 + j);
  }));

  const heads = new Set([...steps.values()].map(all => all[0]));

  let settled = false;

  while (!settled) {
    settled = true;

    for (const row of rows) {
      let prefix = true;
      let last = -Infinity;

      for (const c of row) {
        const step = kept.has(c.source.key) && !heads.has(c);

        if (!step) {
          prefix = false;
          continue;
        }

        const r = rank.get(c.source.key)!;

        if (!prefix || r < last) {
          kept.delete(c.source.key);
          unrolled.push({ ...whose(steps.get(c.source.key)![0]), why: 'order' });
          settled = false;
          break;
        }

        last = r;
      }

      if (!settled) break;
    }
  }

  const keys = new Map<KeyframeId, RigKey[]>();
  let made = nextKey(keyRigOf(world, m));

  rows.forEach((row, i) => {
    const at = world.keyframes[first + i].id;
    const list: RigKey[] = [];

    for (const c of row) {
      const e = c.source.key;

      if (!kept.has(e)) list.push(...c.ops.map(o => carriedKey(made++, c.source.ref, o)));
      else if (heads.has(c)) {
        const times = e.times === null ? null : e.times - c.source.step;

        list.push(skipping(world.keyframes, { ...carriedKey(e.id, c.source.ref, c.ops[0]), times, skip: e.skip }, at));
      }
    }

    // What a key says about single corners is in the thing's own rest frame,
    // which the group never reached: it comes across untouched, in a key of
    // its own, whatever became of the delta beside it.
    for (const key of keysOfAt(world, at, m)) {
      const corners = onlyCorners(key);

      if (corners !== null) list.push(corners);
    }

    if (list.length > 0) keys.set(at, list);
  });

  return { keys, unrolled };
}

/** What a key stood for before the fold, which is what `carried` writes about
 * a thing that is not one of the world's: only its repeat is read. */
const MADE: RigKey = { id: -1, ref: ORIGIN, times: 1 };

/** One operation as a key, about the point the key it came from painted. */
function carriedKey(id: number, ref: Point, op: Op): RigKey {
  if (op.kind === 'stand') return { id, ref, stand: op, times: 1 };

  return { id, ref: 'ref' in op ? op.ref : ref, by: deltaOf(op)!, times: 1 };
}

/** A key's writing about single corners, alone, or nothing where it has
 * none. */
function onlyCorners(key: RigKey): RigKey | null {
  if (key.corners === undefined && key.depths === undefined
    && key.rounds === undefined && key.deforms === undefined) return null;

  return {
    id: key.id,
    ref: key.ref,
    times: key.times,
    ...(key.skip === undefined ? {} : { skip: key.skip }),
    ...(key.group === undefined ? {} : { group: key.group }),
    ...(key.corners === undefined ? {} : { corners: key.corners }),
    ...(key.depths === undefined ? {} : { depths: key.depths }),
    ...(key.rounds === undefined ? {} : { rounds: key.rounds }),
    ...(key.deforms === undefined ? {} : { deforms: key.deforms }),
  };
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

    // A group's amounts are its union's, and never its members'.
    case 'erode':
    case 'round':
    case 'deform':
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

      return [{
        ...held,
        frame,
        erosion: inner.erosion,
        bevel: inner.bevel,
        amplitude: inner.amplitude,
      }];
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
 * about what it is; more than one is what the inspector shows as mixed. */
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

    if (p !== undefined) polygons.set(id, { ...unkinded(p), ...kind });
  }

  return { ...world, polygons };
}

/**
 * `ids` given `part` in `set`, or no part there where it is nothing, each
 * keeping what it plays in the other set where it can.
 *
 * Where it cannot — a solid over a floor, which says nothing a solid does not —
 * the other set's part goes, and the polygon is what was asked for alone. A
 * polygon left in neither set is not a kind, so taking a part away from one
 * with nothing in the other leaves it as it was.
 */
export function repartedPolygons(
  world: World,
  ids: readonly PolygonId[],
  set: SetName,
  part: LevelPart | FloorPart | null,
): World {
  const polygons = new Map(world.polygons);

  for (const id of ids) {
    const p = world.polygons.get(id);

    if (p === undefined) continue;

    const { [set]: _was, ...other } = kindOf(p);
    const kind: PolygonKind = part === null ? other : { ...other, [set]: part };
    const settled = offered(kind) ? kind : part === null ? kindOf(p) : { [set]: part };

    polygons.set(id, { ...unkinded(p), ...settled });
  }

  return { ...world, polygons };
}

/** Whether the editor offers this kind: see `KINDS`. */
export function offered(kind: PolygonKind): boolean {
  return KINDS.some(k => sameKind(k, kind));
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

  const rig = keyRigOf(world, it.id);

  return withKeyRig(world, it.id, nudgedBy(rig, nextKey(rig), it.corners[index].id, v, by));
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

  let rig = keyRigOf(world, id);
  const id0 = nextKey(rig);

  for (const corner of polygon.points) {
    if (corners.has(corner.id)) rig = amountedBy(rig, id0, 'erode', corner.id, v, by);
  }

  return withKeyRig(world, id, rig);
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
  // On the edge as drawn: a deform's teeth are not corners of the polygon's,
  // so an edge through them is the one between the drawn corners either side.
  const n = it.corners.length;

  while (it.corners[index].root !== undefined) index = prevOf(it.rings, n, index);

  // Round its own ring rather than round the list: the corner after the last
  // of a hole is the first of that hole, not the first of the outline.
  let next = nextOf(it.rings, n, index);

  while (it.corners[next].root !== undefined) next = nextOf(it.rings, n, next);

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
    const times = keysOfAt(world, u.at, u.id)[u.nth]?.times;

    return times === null || (times !== undefined && offset(u.at) + times - 1 > 0);
  };

  /** What happens to `id` after the copy keyframe: in world units for the
   * outermost, and in the frame of what holds it for the rest. */
  const timed = (id: Id, outermost: boolean): Timed => {
    const freeing = outermost ? freed(world, id) : { world, unrolled: [] };
    const src = freeing.world;
    const rig = keyRigOf(src, id);
    const state = stateAt(world, id, v);
    const mine = keysAt(rig, v);

    // A repeat's step, as a key of its own that carries on from there.
    const carrying = (p: Playing, k: KeyframeId): RigKey =>
      skipping(world.keyframes, {
        ...p.key,
        ...(p.stand === undefined ? { by: p.by } : { stand: p.stand }),
        ref: p.ref,
        times: p.key.times === null ? null : p.key.times - p.step,
      }, k);

    // Up to its last stand, the copy keyframe's own list is where the copy
    // starts: a stand holds nothing that can be written again elsewhere.
    const cut = mine.map(e => (e.stand === undefined ? '' : 'stand')).lastIndexOf('stand') + 1;
    const stand = cut > 0 ? mine[cut - 1].stand! : null;
    const was = at > 0 ? stateAt(src, id, world.keyframes[at - 1].id) : null;

    // With no stand, it starts where the keyframe before left it, and the
    // copy keyframe comes across as what it does: the steps of the repeats
    // running into it, as entries that carry on, and then its own list. So a
    // repeat begun there begins where the paste lands, in the same order.
    const running = stand !== null
      ? []
      : playingAt(src, id, v).flatMap(p => (p.at === v ? [] : [carrying(p, v)]));

    // Behind a stand, what is running goes on past it, and comes across as its
    // next step at the head of the keyframe after: the same rig with nothing
    // after the stand in it, walked on.
    const before = withKeyRig(src, id, {
      keys: new Map([...[...rig.keys].filter(([k]) => offset(k) < 0), ...(cut > 0 ? [[v, mine.slice(0, cut)] as const] : [])]),
    });

    const keys: [number, RigKey[]][] = [];

    if (running.length + mine.length - cut > 0) keys.push([0, [...running, ...mine.slice(cut)]]);

    for (let i = at + 1; i < n; i++) {
      const k = world.keyframes[i].id;
      const own = keysAt(rig, k);

      // Only the keyframe right after: from there, the walk steps them on.
      const steps: RigKey[] = stand === null || i > at + 1
        ? []
        : playingAt(before, id, k).map(p => carrying(p, k));

      if (steps.length + own.length > 0) keys.push([i - at, [...steps, ...own]]);
    }

    const frame = stand?.frame ?? was?.frame ?? REST;

    return {
      start: frame,
      erosion: stand?.erosion ?? was?.erosion ?? 0,
      bevel: stand?.bevel ?? was?.bevel ?? 0,
      amplitude: stand?.amplitude ?? was?.amplitude ?? 0,
      stood: {
        frame: outermost ? unheld(worldFrame(world, id, v)) : state.frame,
        erosion: state.erosion,
        bevel: state.bevel,
        amplitude: state.amplitude,
      },
      keys,
      // What the fold took apart matters only where it goes on past the copy.
      unrolled: freeing.unrolled.filter(reaches),
      ...(world.effects.has(id) ? { effects: world.effects.get(id)! } : {}),
    };
  };

  const clip = (id: Id, outermost: boolean): Clipping[] => {
    const here = new Set(chain(world, v));

    if (!standingIn(world, id, here)) return [];

    const thing = world.artefacts.get(id);

    if (thing !== undefined) {
      return [{ kind: 'artefact', type: thing.type, at: thing.at, death: outliving(world, thing, v), ...timed(id, outermost) }];
    }

    const walk = world.paths.get(id);

    if (walk !== undefined) {
      return [{ kind: 'path', points: walk.points, death: outliving(world, walk, v), ...timed(id, outermost) }];
    }

    const group = world.groups.get(id);

    if (group !== undefined) {
      const members = group.members.flatMap(m => clip(m, false));
      const time = timed(id, outermost);

      return members.length === 0 ? [] : [{ kind: 'group', sealed: group.sealed, members, ...time }];
    }

    const polygon = world.polygons.get(id);

    if (polygon === undefined) return [];

    const state = stateAt(world, id, v);
    const time = timed(id, outermost);

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
      bevels: [...state.bevels],
      amplitudes: [...state.amplitudes],
      cornerEffects: [...kept].flatMap(c => (world.cornerEffects.has(c) ? [[c, world.cornerEffects.get(c)!] as [VertexId, Partial<Effects>]] : [])),
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

  const out = withKeyRig({ ...world, groups }, id, fold.rig);

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
      : { world: withKeyRig(world, id, { keys: out.keys }), unrolled: out.unrolled };
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

      for (const p of playingAt(was, id, k)) expect = playingOn(expect, p);
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
  amounts: { depths: ReadonlyMap<VertexId, number>, bevels: ReadonlyMap<VertexId, number>, amplitudes: ReadonlyMap<VertexId, number> },
  into: Affine | null,
): World {
  const start = into === null ? clip.start : unheld(compose(into, affineOf(clip.start)));

  const stand: Stand = {
    kind: 'stand',
    frame: start,
    erosion: clip.erosion,
    corners,
    ...amounts,
    bevel: clip.bevel ?? 0,
    amplitude: clip.amplitude ?? 0,
  };

  let made = 0;
  const keys = new Map<KeyframeId, readonly RigKey[]>([
    [v, [{ id: made++, ref: ORIGIN, stand, times: 1 }]],
  ]);

  for (const [offset, list] of clip.keys) {
    const k = landingAt(world, v, offset);

    // Past the end of the keyframes, and there is nowhere for it to go. See the
    // note on `pasted`.
    if (k === null) break;

    // A skip names the keyframe it was meant for, and stays on it where the
    // paste still reaches it. What the copy keyframe did plays over the stand.
    keys.set(k, [...(keys.get(k) ?? []), ...list.map(e => skipping(world.keyframes, { ...e, id: made++ }, k))]);
  }

  return withKeyRig(world, id, { keys });
}

/** A pasted thing's effects, where it has some. */
function effectsPasted(world: World, id: Id, fx: Effects | undefined): World {
  return fx === undefined ? world : { ...world, effects: new Map(world.effects).set(id, fx) };
}

/**
 * A pasted timeline with its corners renamed: the copy's corner ids are the
 * original's, and what is pasted has ids of its own.
 *
 * What a key says about a corner the paste did not bring — one the original
 * had and the copy did not reach — goes, and a key left holding nothing but
 * that goes with it.
 */
function renamedCorners(rig: KeyRig, renamed: ReadonlyMap<VertexId, VertexId>): KeyRig {
  const named = <T>(m: ReadonlyMap<VertexId, T> | undefined): ReadonlyMap<VertexId, T> | undefined => {
    if (m === undefined) return undefined;

    const out = new Map<VertexId, T>();

    for (const [c, by] of m) {
      const now = renamed.get(c);

      if (now !== undefined) out.set(now, by);
    }

    return out.size === 0 ? undefined : out;
  };

  const keys = new Map<KeyframeId, RigKey[]>();

  for (const [at, list] of rig.keys) {
    const mine = list.flatMap(key => {
      const out: RigKey = {
        ...key,
        corners: named(key.corners),
        depths: named(key.depths),
        rounds: named(key.rounds),
        deforms: named(key.deforms),
      };

      const held = out.corners ?? out.depths ?? out.rounds ?? out.deforms;

      return out.by === undefined && out.stand === undefined && held === undefined ? [] : [out];
    });

    if (mine.length > 0) keys.set(at, mine);
  }

  return { keys };
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

    return { world: written(out, v, id, clip, none, { depths: none, bevels: none, amplitudes: none }, into), id };
  }

  if (clip.kind === 'path') {
    const id = world.nextId;
    const paths = new Map(world.paths);

    paths.set(id, { birth: v, death: landingAt(world, v, clip.death), points: clip.points });

    const out = { ...world, paths, nextId: id + 1 };

    return { world: written(out, v, id, clip, none, { depths: none, bevels: none, amplitudes: none }, into), id };
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

    groups.set(id, { members, sealed: clip.sealed, birth: v });
    out = effectsPasted({ ...out, groups, nextId: id + 1 }, id, clip.effects);

    return { world: written(out, v, id, clip, none, { depths: none, bevels: none, amplitudes: none }, into), id };
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

  let out: World = effectsPasted({ ...world, polygons, nextId: id + 1 + points.length }, id, clip.effects);

  if ((clip.cornerEffects ?? []).length > 0) {
    const cornerEffects = new Map(out.cornerEffects);

    for (const [c, fx] of clip.cornerEffects!) {
      const now = renamed.get(c);

      if (now !== undefined) cornerEffects.set(now, fx);
    }

    out = { ...out, cornerEffects };
  }

  const corners = new Map(points.filter(c => c.birth === v).map(c => [c.id, c.at]));
  const renaming = (amounts: readonly [VertexId, number][] | undefined) => new Map((amounts ?? []).flatMap(([c, d]) => {
    const now = renamed.get(c);

    return now === undefined ? [] : [[now, d] as const];
  }));

  out = written(out, v, id, clip, corners, {
    depths: renaming(clip.depths),
    bevels: renaming(clip.bevels),
    amplitudes: renaming(clip.amplitudes),
  }, into);
  out = withKeyRig(out, id, renamedCorners(keyRigOf(out, id), renamed));

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
      };

  return pasted(world, v, clips.map(now), by, where);
}

function still(clip: Timed): Pick<Timed, 'start' | 'erosion' | 'bevel' | 'amplitude'> {
  return { start: clip.stood.frame, erosion: clip.stood.erosion, bevel: clip.stood.bevel, amplitude: clip.stood.amplitude };
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


