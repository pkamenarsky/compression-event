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
// here ships untagged whatever it was made of: what was subtracted has been
// subtracted by now and is a hole, and a hole is one by the way it is wound.
//
// What differs is the shape they arrive in, and that is the whole reason the
// second is a separate evaluation rather than a read of the first. A run
// belongs to one polygon and can be kept up to date on its own, which is what
// the editor wants of the drawing; a wall needs both its neighbours to mitre
// against, and a ring is where they are.
//
// So collision snaps at version boundaries while the walls morph between them,
// and during a transition the wall you see is a little behind the wall that
// stops you: the snap is to the version arriving, taken when the picture
// starts. That was chosen — see *Two clocks* in `play.ts` for why that end and
// not the other. The seams were not.
// -----------------------------------------------------------------------------

import { BakedLevel, EMPTY_BAKED } from './baked';

// -----------------------------------------------------------------------------
// The two numbers both halves are measured in
//
// Here rather than in the renderer, which is where they were, because the
// editor needs them too and has no business loading three.js to read a
// constant. This module is what the two halves already agree on, and a scale
// is exactly that kind of fact.
// -----------------------------------------------------------------------------

/** World units per editor unit: the editor's grid of 25 is one metre. */
export const SCALE = 1 / 25;

/**
 * One floor tile, in world units.
 *
 * The grid a level is worked on from above and the grid it is seen against
 * from inside have to be the same grid, or a room laid out on dots that fall
 * halfway across the tiles looked square in the editor and reads as nothing in
 * the level. So the editor's default grid is this, taken through `SCALE` —
 * see `defaultSettings` — and the sizes it can be taken to are divisions of it.
 */
export const TILE_SIZE = 4;

/**
 * How far, in editor units, the replay may sit from the CSG.
 *
 * A width rather than a tolerance in `t`, which is what makes it meaningful:
 * it is the thing the eye would see. Well under a pixel at any sane zoom.
 *
 * Here rather than only in the bake because it is a promise the bake makes to
 * whatever plays it back, and one reader takes it up: a fill has to stitch a
 * span's floor runs into rings, and the two readings of a junction come off
 * different tracks and agree only to this. See `looped` in `walls.ts`.
 */
export const TOLERANCE = 0.05;

/**
 * Which of the two sets a polygon ends up in.
 *
 * A `level` is somewhere to stand and a `floor` is somewhere to look at: the
 * first is resolved into the set collision and the walls are made of, the
 * second into a shape that is drawn flat underfoot and takes part in nothing.
 * Both arrive here already resolved — the level as untagged rings, the floor
 * in a list of its own — so this describes the editor's side of the agreement,
 * and nothing shipped carries it.
 */
export type SetName = 'level' | 'floor';

/** Both of them, wherever something has to be done to each in turn. */
export const SETS: readonly SetName[] = ['level', 'floor'];

/**
 * What a polygon is, as it was drawn.
 *
 * Four names rather than a set crossed with a direction, because the product
 * is not real: a subtraction from the level and an addition to the solids
 * would be two spellings of one thing, and there is no sense to be made of a
 * polygon that is a level and a floor at once. These are the states that
 * exist.
 *
 * `level` is somewhere to stand. `solid` is what stands in it — a pillar, a
 * wall, a block. `floor` is somewhere to look at. `void` is the one that took
 * a restructure to say: it cuts, and what it cuts is the solids and the
 * floors rather than the level. A pillar with a void across its edge is a
 * U-shaped pillar, which is a hole in a hole and a thing no flat sum of adds
 * and subtracts can express.
 */
export type PolygonType = 'level' | 'solid' | 'floor' | 'void';

/** What a `void` may cut, as flags, because it may cut both at once. */
export const SOLID = 1, FLOOR = 2;

/**
 * A polygon's type and, for the one type that has more than one thing to say,
 * what it says.
 *
 * A union rather than an interface with an optional mask, so that the
 * invariant is the type's rather than a convention: `from` exists exactly
 * where it means something. Nothing but a `void` has a choice of what to act
 * on — `level`, `solid` and `floor` each name one thing outright — and a mask
 * on those would be inventing options nobody can use.
 */
export type PolygonKind =
  | { type: 'level' }
  | { type: 'solid' }
  | { type: 'floor' }
  | { type: 'void', from: number }

/** The kinds the editor offers, in the order the number keys pick them. */
export const KINDS: readonly PolygonKind[] = [
  { type: 'level' },
  { type: 'solid' },
  { type: 'floor' },
  { type: 'void', from: SOLID },
  { type: 'void', from: FLOOR },
  { type: 'void', from: SOLID | FLOOR },
];

/**
 * Which kind fills each slot of each set, and so how many slots there are.
 *
 * A slot is one side of one set — the polygons playing one part in it — and a
 * point is in the set or not according to which slots cover it. The level has
 * three: what is added, what stands in it, and what is taken back out of what
 * stands in it. The floor has two.
 *
 * The count is here rather than inferred because `ground` has to lay out one
 * tree per slot before it has seen a single member, and a set with nothing in
 * one of its slots still has that slot.
 *
 * The kinds are the way back: `slotOf` says which slot a kind fills, and this
 * says which kind a slot is for. Two things want that — a scope's erosion,
 * which offsets each slot the way its depth in the rule means, and a scope's
 * own contribution, which is the first slot of each set and nothing else. A
 * void over both sets appears here as the void of whichever set the slot
 * belongs to; the two halves erode alike, being at the same depth in their own
 * set's rule.
 */
export const SLOT_KINDS: Record<SetName, readonly PolygonKind[]> = {
  level: [{ type: 'level' }, { type: 'solid' }, { type: 'void', from: SOLID }],
  floor: [{ type: 'floor' }, { type: 'void', from: FLOOR }],
};

export const SLOTS: Record<SetName, number> = {
  level: SLOT_KINDS.level.length,
  floor: SLOT_KINDS.floor.length,
};

/**
 * Which slot of `set` a polygon of this kind fills, or nothing where it has no
 * part in that set at all.
 *
 * The one place the authored names and the resolution's slots are related, so
 * that `inside` below can be read against it and nothing else has to know.
 */
export function slotOf(kind: PolygonKind, set: SetName): number | null {
  if (set === 'level') {
    if (kind.type === 'level') return 0;
    if (kind.type === 'solid') return 1;
    if (kind.type === 'void' && (kind.from & SOLID) !== 0) return 2;

    return null;
  }

  if (kind.type === 'floor') return 0;
  if (kind.type === 'void' && (kind.from & FLOOR) !== 0) return 1;

  return null;
}

/**
 * Whether a point covered by exactly these slots is in the set.
 *
 * ```
 * level = level − (solid − void)
 * floor = floor − void
 * ```
 *
 * Each slot is read on its own — nonzero over that slot's members and nothing
 * else — and only then are the answers combined. That is not the same as
 * summing the windings across slots and asking whether the total is nonzero,
 * and the difference is not academic: two rooms overlapping under one pillar
 * sum to `2 − 1 = 1` and the pillar stops cutting. Keeping the slots apart is
 * what makes the rule mean what it says at every depth.
 *
 * Which is also why the nesting costs nothing to name. The arrangement is cut
 * from the authored edges whatever this rule says about them — a boolean over
 * polygons never invents a boundary point that is not a corner of one or a
 * crossing of two — so a hole in a hole is a deeper rule over the same points,
 * not deeper geometry. See `Whither` in the editor's `geometry.ts`.
 */
export function inside(set: SetName, on: readonly boolean[]): boolean {
  return set === 'level'
    ? on[0] && !(on[1] && !on[2])
    : on[0] && !on[1];
}

/**
 * Whether offsetting a set by `d` offsets this kind's own union by `-d`.
 *
 * Eroding a whole set is eroding each of its slots, and the sign alternates
 * with how deeply the slot is nested, because eroding a complement is dilating:
 *
 * ```
 * erode(L − (S − V), d) = erode(L, d) − (erode(S, −d) − erode(V, d))
 * ```
 *
 * So the level and the floor erode with the set, the solids erode against it —
 * a pillar shrunk along with its room leaves a gap that never narrows — and a
 * void, being a hole in a hole, comes back round to eroding with it.
 */
export function inverted(kind: PolygonKind): boolean {
  return kind.type === 'solid';
}

/** One kind as a string, for the maps and sets that have to key by one.
 * Nothing but a key: it is never parsed back and never written to a file. */
export function kindKey(k: PolygonKind): string {
  return k.type === 'void' ? `void_${k.from}` : k.type;
}

/** Whether two kinds are the one kind. */
export function sameKind(a: PolygonKind, b: PolygonKind): boolean {
  return kindKey(a) === kindKey(b);
}

export type ArtefactType = 'exit' | 'key' | 'delay' | 'decompress' | 'anchor' | 'compass';

/**
 * What can be drawn standing in a level: the artefacts, and the start.
 *
 * The start is not an artefact — it is one place the level has, written in a
 * field of its own — but it is drawn from above like one, so the thing that
 * draws them is keyed by this rather than by `ArtefactType`.
 */
export type IconType = ArtefactType | 'start';

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
 * thing — the added ones were unioned and the subtracted ones taken back out
 * long before this, and what a subtraction left behind is a hole, which is one
 * by the way it is wound. There is nothing left for a tag to distinguish.
 */
export interface Polygon {
  points: PolygonPoint[]
}

/**
 * One floor: a shape drawn flat on the ground, and nothing else.
 *
 * Its own list rather than a tag on the one above, because it is not the same
 * kind of thing and every reader of that list would have to know to skip it. It
 * takes no part in the level, nothing walks into it, and nothing needs to know
 * which side of it is material — so it carries no normals either. An outline
 * and the holes cut in it, filled, is the whole of it.
 */
export interface Floor {
  points: Point[]
  /**
   * The rings taken back out of it, wound whichever way they came: a doorway
   * cut through a floor, and the pillar a floor was drawn around.
   *
   * Beside the outline rather than in the list next to it, because the fill is
   * a triangulation and a triangulator is told a contour and its holes. Which
   * ring is a hole in which outline is worked out where the set is resolved and
   * the containment is already in hand — see `filled` in the editor's
   * `export.ts` — rather than again, per frame, by whatever is drawing.
   *
   * Absent where there are none, which is nearly every floor ever drawn.
   */
  holes?: Point[][]
}

/**
 * One artefact, and where it stands at every version.
 *
 * A place per version rather than one place, because an artefact is carried by
 * whatever holds it: a key in a room that turns turns with it. `places` is
 * where it stands *at* a version, which is what collision and pickup ask
 * about; between two of them it rides the span's frame table off `at`, like
 * every corner of every wall. See `BakedSpan.artefacts`.
 *
 * Null where it does not exist yet: a version before the one that introduced
 * it cannot name it.
 */
export interface Artefact {
  type: ArtefactType
  /** In its own frame, before any version's transform: the point the frame
   * table is read against. */
  at: Point
  places: (Point | null)[]
}

/**
 * Where the player comes in, and which way they are looking.
 *
 * A field of the world rather than an artefact, because it is neither optional
 * nor repeatable: every level has exactly one and no level can do without it.
 * Said as an artefact it was a kind that had to be searched for, could be
 * deleted, and could be placed twice — three ways for a level to be broken
 * that the format itself can refuse instead.
 *
 * One place rather than one per version, and that is the point of it. The
 * player is put here once, when the level begins, and nothing later in the
 * chain has anywhere else to put them.
 *
 * The facing is a yaw in radians: zero looks up the negative z axis, growing
 * the way the player's yaw does.
 */
export interface Start {
  at: Point
  facing: number
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
  /** Where the player is put, and facing which way. See `Start`. */
  start: Start
  /** The morph between each adjacent pair of versions, as buffers. */
  baked: BakedLevel
}

export function emptyWorld(): World {
  return {
    paths: [],
    versions: [],
    artefacts: [],
    start: { at: { x: 0, y: 0 }, facing: 0 },
    baked: EMPTY_BAKED,
  };
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
/**
 * How far along a wall a corner's bisector may run, in player radii, before it
 * is held there.
 *
 * The bisector is the unit bisector over the cosine of the half angle, so its
 * component *across* the wall is exactly one and its component *along* the wall
 * is the cotangent of the half angle — which runs away to infinity as a corner
 * closes on a hairpin. There is a guard below for the hairpin itself, at 1e-8,
 * and between the two lies every corner that is not quite one: a spur eighteen
 * units long and a thousandth of a unit wide reads as an ordinary corner, comes
 * back with a bisector nineteen hundred long, and `hullOf` builds the wall's
 * expansion out of it — a quad whose far corner has slid two hundred units down
 * the wall rather than a radius across it. The strip beside that wall is then
 * not covered by anything and the player walks out through it.
 *
 * Rings like that are not authored, they are arrived at: an offset deep enough
 * to split a room leaves the two pieces meeting almost exactly, and almost is
 * what does it. So the bound is here rather than in whatever produced the ring.
 *
 * Held *along* rather than in length, which is the whole of why this works. The
 * component across the wall is what makes the moved edge a translate of the
 * original at exactly a radius, and scaling the whole bisector down loses it —
 * the wall then stops the player short of where it should and the strip beside
 * it is still uncovered, which is a fix that fixes nothing. Holding the
 * tangential part keeps the crossways part exact and only stops the corner
 * sliding; what it costs is that the two walls at a corner sharper than
 * `2 * atan(1 / 16)` — about seven degrees — no longer meet exactly at their
 * mitre, and the tip of that spike is a little thinner than a radius.
 *
 * Sixteen because nothing that has to be exact needs more. A level's worth of
 * uniformly eroded rooms wants at most fourteen; the one corner in a hundred
 * and twenty rooms that wanted forty was two point eight degrees wide, and
 * holding it changes nothing anyone can walk through.
 */
export const BISECTOR_LIMIT = 16;

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

    const bnx = bx / cosHalf, bny = by / cosHalf;

    // Along the wall rather than across it. The component across is exactly one
    // by construction and is the whole of what the bisector is for; what runs
    // away at a near-hairpin is the component along, and holding that is what
    // keeps the moved edge a translate of the original while stopping the far
    // corner sliding off down it.
    const tx = -here.ny, ty = here.nx;
    const along = bnx * tx + bny * ty;

    if (Math.abs(along) <= BISECTOR_LIMIT) {
      return { x: p.x, y: p.y, bnx, bny, enx: here.nx, eny: here.ny };
    }

    const held = Math.sign(along) * BISECTOR_LIMIT;

    return {
      x: p.x,
      y: p.y,
      bnx: here.nx + tx * held,
      bny: here.ny + ty * held,
      enx: here.nx,
      eny: here.ny,
    };
  });
}
