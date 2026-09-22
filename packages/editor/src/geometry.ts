// -----------------------------------------------------------------------------
// CSG on polygons
//
// One algorithm does all of it. Every edge of both operands is cut at every
// crossing — including crossings an operand has with itself — which leaves a
// planar arrangement whose faces are each wholly inside or wholly outside each
// operand. A piece of edge belongs to the answer exactly when the two faces it
// separates disagree about the answer, so each piece is classified by sampling
// a point just off either side and asking the fill rule. Surviving pieces are
// oriented interior-to-the-left and chained back into rings.
//
// Nothing here cares whether the input is convex, concave, self-intersecting or
// already several loops: those are all just arrangements. `simplify` is the
// same machinery run against an empty second operand, which is what turns one
// self-intersecting loop into a set of loops that do not cross themselves.
//
// Rings are filled by the nonzero winding rule, so a hole is a ring wound
// against its container. Output holds to the convention the traversal produces:
// outer rings counter-clockwise, holes clockwise.
// -----------------------------------------------------------------------------

import { Point } from '@ce/game/world';
import { containsBox, ofRings } from './aabb';
import { Packed, eachPacked, pack } from '@ce/game/bvh';

export type { Point };

/** A closed loop. The last point is *not* a repeat of the first. */
export type Ring = Point[];

/** A shape is any number of rings, filled by the nonzero winding rule. */
export type Shape = Ring[];

// -----------------------------------------------------------------------------
// Rings inside one list
//
// A polygon's corners are kept as one flat list in ring order, with the outer
// ring first and its holes after it, and a second list saying where each ring
// starts. Everything that pairs a corner with something — its position, its
// depth, whether it is standing, which vertex id it has — stays index for index
// with that one list, which is what the whole editor and the whole bake are
// built on.
//
// So a hole changes exactly one thing about walking corners: which corner comes
// after the last one. `nextOf` and `prevOf` are that difference, and they are
// the reason this could be done without unpicking the arrays.
// -----------------------------------------------------------------------------

/** Which ring index `i` falls in. */
export function ringAt(rings: readonly number[], i: number): number {
  let r = 0;

  while (r + 1 < rings.length && rings[r + 1] <= i) r++;

  return r;
}

/** Where the ring holding `i` starts, and where it ends — the half-open span
 * the walk wraps inside. */
function span(rings: readonly number[], n: number, i: number): [number, number] {
  const r = ringAt(rings, i);

  return [rings[r], r + 1 < rings.length ? rings[r + 1] : n];
}

/** The corner after `i`, wrapping at the end of its own ring rather than at the
 * end of the list. */
export function nextOf(rings: readonly number[], n: number, i: number): number {
  const [lo, hi] = span(rings, n, i);

  return i + 1 >= hi ? lo : i + 1;
}

/** And the one before it. */
export function prevOf(rings: readonly number[], n: number, i: number): number {
  const [lo, hi] = span(rings, n, i);

  return i <= lo ? hi - 1 : i - 1;
}

/** `step` corners along from `i`, round its own ring. */
export function alongOf(rings: readonly number[], n: number, i: number, step: number): number {
  const [lo, hi] = span(rings, n, i);
  const len = hi - lo;

  return lo + (((i - lo + step) % len) + len) % len;
}

/** How far it is from `i` to `j` going forwards round their ring. */
export function betweenOf(rings: readonly number[], n: number, i: number, j: number): number {
  const [lo, hi] = span(rings, n, i);

  return ((j - i) % (hi - lo) + (hi - lo)) % (hi - lo);
}

/** A flat list cut back into the rings it was kept in. */
export function sliced<T>(flat: readonly T[], rings: readonly number[]): T[][] {
  return rings.map((lo, r) => flat.slice(lo, r + 1 < rings.length ? rings[r + 1] : flat.length));
}

declare const walked: unique symbol;

/**
 * A shape the arrangement has been through: every ring wound its way round, and
 * therefore cut where it cuts them.
 *
 * Where a ring starts is not free. A ring closes on itself, so the only thing
 * fixing its first point is the walk that produced it — and the walk goes round
 * the way the winding says. Hand the same square in clockwise and it comes back
 * counter-clockwise, which moves every index along by one.
 *
 * The bake leans on this. It names a point by where it sits in the ring it came
 * out of and compares those names across two instants, so a ring cut one way at
 * one instant and another way a moment later is two names for one corner and
 * one name for two — which is drawn as a square collapsing into a diamond
 * inscribed in itself.
 *
 * So it is a type rather than a comment. Only the arrangement makes one, and
 * `erode` takes one, so a shape cannot reach a depth of zero down one path and
 * a depth of anything else down another and come out cut differently. The way
 * in is `simplify`, which is free for a shape that is already simple.
 */
export type Cut = Shape & { readonly [walked]: true };

/** Which of the two operands a point is in, and what that means for the answer. */
export type Op = (a: boolean, b: boolean) => boolean;

/**
 * The same question asked of any number of operands: which of them cover the
 * point, and whether that puts it in the answer.
 *
 * `Op` is the two-operand case and stays, because `union` and `subtract` really
 * do have two operands and reading them as arrays would say otherwise. A set
 * resolved out of slots has as many as it has — three for the level — and its
 * rule is not a composition of binary ones. See `inside` in the game's
 * `world.ts`.
 */
export type Rule = (on: readonly boolean[]) => boolean;

/**
 * Where in the input something came from: which operand, which of its rings,
 * and which vertex or edge of that ring. Vertices and edges share a numbering —
 * edge `i` runs from vertex `i` to vertex `i + 1`.
 */
export interface SourceRef {
  shape: number
  ring: number
  index: number
}

/**
 * Why an output point is where it is. Every point a boolean operation produces
 * is one of exactly two things, and both name only the input, so the same point
 * arrived at from differently placed geometry carries the same tag.
 */
export type Tag =
  | { kind: 'vertex', at: SourceRef }
  | { kind: 'cross', a: SourceRef, b: SourceRef }

/** Rings, and a tag per point of each — `tags[r][i]` describes `rings[r][i]`. */
export interface TaggedShape {
  rings: Ring[]
  tags: Tag[][]
}

export const OpUnion: Op = (a, b) => a || b;
export const OpSubtract: Op = (a, b) => a && !b;
export const OpIntersect: Op = (a, b) => a && b;
export const OpXor: Op = (a, b) => a !== b;

/**
 * How a boolean operation reads its operands: which points count as inside.
 *
 * Nonzero is what a shape means everywhere else and is the default. Erosion is
 * the one caller that needs another, because the raw offset it hands over is
 * not a shape yet — see `erode`.
 */
export type Fill = (f: Field, p: Point) => boolean;

/** Wound around at least once, counting direction. An alternative `Fill`. */
export function positive(f: Field, p: Point): boolean {
  return fieldWinding(f, p) >= 1;
}

// -----------------------------------------------------------------------------
// Public operations
// -----------------------------------------------------------------------------

export function union(a: Shape, b: Shape): Cut {
  return combine(a, b, OpUnion);
}

/**
 * Every shape unioned, in one arrangement rather than one per pair.
 *
 * `union(union(union(a, b), c), d)` cuts the accumulated answer up again at
 * every step, so what it costs grows with the square of how many there are —
 * and a group's projection asks for exactly this, at every instant of every
 * track the group falls near. Handing them all to the arrangement at once is
 * the same machinery `boundaryRuns` uses for a neighbourhood, where the members
 * were never going to be unioned two at a time either.
 *
 * Rank settles a shared edge, as it does there: the shapes are ranked by the
 * order they arrive in, coincident pieces classify alike, and the loser is
 * dropped without being built.
 */
export function unionAll(shapes: readonly Shape[]): Cut {
  const live = shapes.filter(s => s.length !== 0);

  // Not `return live[0]`: one shape still has to come back cut the way the
  // arrangement cuts it, or a group of one member is cut differently from the
  // same group once something joins it. `simplify` is the cheap way in.
  if (live.length === 0) return [] as unknown as Cut;
  if (live.length === 1) return simplify(live[0]);

  const rings: Shape = [];
  const ranks: number[] = [];

  live.forEach((shape, rank) => {
    for (const ring of shape) {
      rings.push(ring);
      ranks.push(rank);
    }
  });

  const raw = segments(rings, 0, ranks);
  const snap = scaleOf(raw) * 1e-9;

  // One field over all of them, and a point is in the union when it is in any:
  // the same reading `covers` gives a neighbourhood's level side.
  const slots = ground(live.map((shape, id) => ({ id, slot: 0, shape })), 1);

  // The arrangement's own output, which is what `Cut` means. This and
  // `combine` are the only two places one is made.
  return chain(
    arranged([p => covers(slots[0], p)], on => on[0], split(raw, snap), snap),
    snap,
  ).rings as Cut;
}

export function subtract(a: Shape, b: Shape): Cut {
  return combine(a, b, OpSubtract);
}

export function intersect(a: Shape, b: Shape): Cut {
  return combine(a, b, OpIntersect);
}

export function xor(a: Shape, b: Shape): Cut {
  return combine(a, b, OpXor);
}

/**
 * The same shape, with every self-intersection resolved: the result is a set of
 * rings that neither cross themselves nor each other, covering exactly the area
 * the nonzero rule gave the input.
 */
export function simplify(a: Shape): Cut {
  return combine(a, [], inA => inA);
}

/**
 * The plain mitred offset: every corner moves to where its two walls, moved
 * `depth` along their own normals, cross — and a wall that runs out of room
 * takes its endpoints with it.
 *
 * One depth for the whole shape, which is `erodeAt` with the same number
 * everywhere and nothing else: the two are the same construction and this is
 * the name for the ordinary case. See there for how it is built and what it
 * costs.
 *
 * It is done by taking away the band the boundary sweeps on its way in, rather
 * than by moving the vertices and filling the ring that comes out. That was a
 * page of code and got the easy half right, but the ring folds back on itself
 * once a wall collapses, and no fill rule tells a fold from material: a square
 * eroded past its own middle comes back inside out, wound the same way it
 * started, and reads as a smaller square of ground where there should be none.
 * The band has no such state. Where it covers a room the room is gone, where it
 * pinches one in two there are two rooms, and both answers come out of the
 * arrangement that was going to run anyway.
 *
 * Every surviving wall therefore lies on a translate of its own original line,
 * exactly parallel to where it started, at every depth. Nothing is clamped and
 * nothing is frozen, so vertices die freely — which costs no identity, because
 * erosion is a projection and never writes back to a source.
 *
 * Left is the material side for every ring the arrangement produces, outer or
 * hole alike, so a hole opens up as the material around it shrinks with no
 * special case. A negative depth grows the shape instead, by putting the band
 * on the other side and adding it. The input has to be simple; `simplify` is
 * what the caller has already run to make it so, and its winding is what says
 * which way is in — unlike `erodeAt`, which is handed a bare ring and settles
 * that itself.
 */
export function erode(shape: Cut, depth: number): Cut {
  if (depth === 0) return shape;

  return offset(shape, swept(shape, () => depth));
}

/**
 * The offset taken with a depth per vertex: every corner moves to the point
 * that is `depths[i]` from both of the walls meeting there, and the boundary
 * between two moved corners is the straight line joining them.
 *
 * The corner rather than the wall, which is the whole of what makes this
 * different from `erode`. A uniform depth cannot tell the two apart — a corner
 * at `d` from both its walls is exactly where the two walls moved `d` along
 * their own normals cross, so the mitre *is* the moved corner and either
 * reading builds the same band. Once the depths differ they part company, and
 * they part immediately: the scaled bisector slides a corner *along* its walls
 * as well as across them, so the wall joining two moved corners is a chord
 * between them rather than the original wall carrying a linear ramp of depth.
 *
 * What it buys is that there is no mitre to run away. `erode` has to build a
 * wedge at every corner the ring turns away from, and the wedge reaches to
 * where the two moved walls cross, which is off towards infinity as they close
 * on parallel — hence `MITRE_LIMIT`, and hence a spike as long as the limit
 * allows standing in the middle of a room. Here the corner *is* the crossing.
 * There is one quad per wall, they meet at the corners, and nothing reaches
 * anywhere the offset does not go.
 *
 * What it costs is that a quad can fold. A corner whose bisector is long enough
 * sends its moved point past the far end of the wall, and the quad crosses
 * itself; a bowtie's two lobes are wound against each other, so filled as one
 * ring it would cancel most of the band away. Each is cut into two triangles
 * and wound separately, which fills both lobes — and both lobes are ground the
 * wall genuinely sweeps on its way in.
 *
 * The ring rather than a `Cut`, and the winding settled here, for the reason
 * `erode` takes a `Cut`: the depths are named by where a corner sits in the
 * ring the caller has in hand, and an arrangement would not keep them there.
 */
export function erodeAt(source: Ring, depths: readonly number[]): Cut {
  const flip = !isCCW(source);
  const ring = flip ? [...source].reverse() : source;
  const at = flip ? [...depths].reverse() : depths;

  return offset(simplify([ring]), swept([ring], (_, i) => at[i]));
}

/**
 * The same for a source with holes in it: the depths flat and in ring order,
 * exactly as the corners they belong to are.
 *
 * The winding is taken as it stands rather than settled, which is the one
 * difference from `erodeAt` and is the same difference `erodeShapeAt` has from
 * it. There is no settling to do — a shape with a hole in it has already said
 * which of its rings is which by how they are wound, and reversing a ring here
 * because it happens to be clockwise would fill the hole in.
 */
export function erodeRingsAt(source: Shape, depths: readonly number[]): Cut {
  const starts = ringStarts(source);

  return offset(simplify(source), swept(source, (r, i) => depths[starts[r] + i]));
}

/** Where each ring of a shape begins, once its rings are laid end to end. */
export function ringStarts(shape: Shape): number[] {
  const out: number[] = [];

  let n = 0;

  for (const ring of shape) {
    out.push(n);
    n += ring.length;
  }

  return out;
}

/**
 * Where each corner of `source` goes under the same offset the projection
 * takes: index for index with the ring it was handed.
 *
 * The corner and not the outline, which is the only reason this can answer at
 * all. What comes back out of `erode` or `erodeAt` is an arrangement, and an
 * arrangement keeps no names — a corner can be cut away by a neighbour's band,
 * or land on a wall it now shares with three others, and asking which of the
 * points in the result *was* a given source vertex is a question the offset
 * threw away. The moved corner is upstream of all of that: it is `corners`,
 * the same one both paths sweep from, and it is where the vertex went whether
 * or not the vertex survived.
 *
 * So a line drawn to it is honest about the projection and not about the
 * outline: it says where this corner pushed to. Where the point it names is
 * not on the eroded boundary, that corner is one the erosion consumed, and the
 * line running past the outline into the interior is the picture of that.
 *
 * A number for a uniform depth, an array for one per corner — the same two
 * cases `erode` and `erodeAt` divide on, and the winding settled here the way
 * `erodeAt` settles it, so a clockwise ring moves inwards like any other.
 */
export function erodedCorners(source: Ring, depths: readonly number[] | number): Point[] {
  const flip = !isCCW(source);
  const ring = flip ? [...source].reverse() : source;
  const n = source.length;

  const depth = typeof depths === 'number'
    ? () => depths
    : (i: number) => depths[flip ? n - 1 - i : i];

  const moved = corners(ring, depth);

  return flip ? moved.reverse() : moved;
}

/**
 * The same for a whole arrangement offset uniformly: where each corner of each
 * ring goes, ring for ring and corner for corner with what it was handed.
 *
 * The winding is taken as it stands rather than settled, which is the one
 * difference from `erodedCorners` and is what makes this the counterpart to
 * `erode` rather than to `erodeAt`. Material is on the left of every ring an
 * arrangement produces, hole and outer alike, so the bisector already points
 * into the material and a hole opens up as the ground around it shrinks — the
 * same reason `erode` can take a `Cut` and offset every ring by one number.
 * Hand it a shape that has not been through one and the holes go the wrong way.
 *
 * A `Shape` and not a `Cut`, unlike `erode`, because the brand is about a ring
 * knowing where it starts and this is only ever asked about a shape the caller
 * has the indices of already — `Occupied.shape`, which is a union either way
 * and has lost the brand on its way through `Contributed`. Nothing here writes
 * back, so the worst a shape that is not walked can do is draw a wrong line.
 */
export function erodedRingCorners(
  source: Shape,
  depths: readonly number[] | number,
): Point[] {
  const starts = ringStarts(source);
  const out: Point[] = [];

  source.forEach((ring, r) => {
    const at = typeof depths === 'number' ? () => depths : (i: number) => depths[starts[r] + i];

    out.push(...corners(ring, at));
  });

  return out;
}

export function erodedShape(shape: Shape, depth: number): Point[][] {
  return shape.map(ring => corners(ring, () => depth));
}

/**
 * How big a shape is, as the arrangement measures it: the span of the box
 * round it, and 1 for a shape with no size to speak of.
 *
 * The unit every tolerance here is written in. An absolute epsilon is a
 * statement about the units the caller happens to be working in, and the same
 * level drawn at a tenth the scale would get a tenth the answer out of it —
 * which is exactly the bug it would be there to prevent. `scaleOf` is this
 * same measure taken over segments, for the arrangement's own snap.
 */
function extentOf(shape: Shape): number {
  let lo = Infinity, hi = -Infinity;

  for (const ring of shape) {
    for (const p of ring) {
      lo = Math.min(lo, p.x, p.y);
      hi = Math.max(hi, p.x, p.y);
    }
  }

  const d = hi - lo;

  return Number.isFinite(d) && d > 0 ? d : 1;
}

/**
 * Whether a point is a corner the offset kept: something the boundary it
 * produced still turns at.
 *
 * The other half of a correspondence. `erodedCorners` says where a vertex
 * pushed to whether or not it survived, which is what makes it answerable at
 * all — but a corner the erosion consumed pushed to somewhere that is not on
 * the outline any more, and a line drawn to it is a line to nothing. Asking
 * the arrangement whether the point came out the far end is the only way to
 * tell the two apart, because dying is exactly what the arrangement did to it.
 *
 * By position and not by name, since a name is the thing the arrangement threw
 * away. The tolerance is the arrangement's own, scaled off the extent of what
 * it produced the way `combine` scales its weld: a corner that survives comes
 * back welded to within that of where the band put it, and nothing else in the
 * outline is anywhere near it — the offset does not produce two corners a
 * billionth apart.
 *
 * A predicate rather than an answer per point, because a group asks ring after
 * ring against one outline and the index is worth building once.
 */
export function survived(shape: Shape): (p: Point) => boolean {
  const eps = extentOf(shape) * 1e-7;

  // Bucketed at the tolerance, so a lookup is nine cells rather than the whole
  // outline. A picked group can be a union of a hundred polygons, and this is
  // asked once per corner of it on every frame a drag draws.
  const at = new Map<string, Point[]>();
  const key = (x: number, y: number): string => `${Math.round(x / eps)}:${Math.round(y / eps)}`;

  for (const ring of shape) {
    for (const p of ring) {
      const k = key(p.x, p.y);
      const cell = at.get(k);

      if (cell === undefined) at.set(k, [p]);
      else cell.push(p);
    }
  }

  return p => {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = at.get(key(p.x + dx * eps, p.y + dy * eps));

        if (cell === undefined) continue;

        for (const q of cell) {
          if (Math.hypot(q.x - p.x, q.y - p.y) <= eps) return true;
        }
      }
    }

    return false;
  };
}

/**
 * Whether a point lies on a boundary of `shape` — anywhere along it, not only
 * where it turns.
 *
 * The question a group's handles ask. A group is drawn as one outline and its
 * members' corners are scattered over the ground under it: some are on that
 * outline and some are seams between two members, interior geometry that
 * shutting the group exists to put away. A handle on a seam is a handle on
 * nothing anyone can see, which is what makes a picked group full of them
 * confusing rather than useful.
 *
 * Anywhere along it, and not `survived`, because the two ask different things.
 * A corner where two members meet flush is dropped from the union — the walk
 * has no reason to turn there, so it is not a vertex of the outline — but it
 * sits squarely on the line that is drawn, and the shape it belongs to moves
 * when it is dragged. Hiding it would take a handle off a corner the eye can
 * see on the outline, which is the thing this is trying to avoid.
 *
 * Brute force over the segments, deliberately. It is asked once per corner of
 * one picked group, against that group's own union, and a grid over a boundary
 * that changes on every frame of a drag costs more to build than the walk it
 * saves.
 */
export function onBoundary(shape: Shape): (p: Point) => boolean {
  const eps = extentOf(shape) * 1e-7;

  return p => shape.some(ring => ring.some((a, i) => {
    const b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const l = Math.hypot(dx, dy);

    if (l <= eps) return Math.hypot(p.x - a.x, p.y - a.y) <= eps;

    // Along the wall and across it, taken apart: off either end is not on the
    // wall however close the line it lies on passes.
    const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (l * l);

    if (t < -eps / l || t > 1 + eps / l) return false;

    return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / l <= eps;
  }));
}

/**
 * The ground the boundary covers on its way in and on its way out, kept apart:
 * `offset` subtracts the one and adds the other.
 *
 * Two sides rather than one because a depth per corner is free to change sign
 * around a ring — one corner pulled in while its neighbour is pushed out — and
 * the two halves of that sweep are not the same operation. Where the sign turns
 * over it turns over at a point on a wall, and the wall's quad is cut there
 * into a piece per side.
 */
interface Band {
  inward: Shape
  outward: Shape
}

/** Where each corner goes: `depth` from both of the walls meeting there. */
function corners(ring: Ring, depth: (i: number) => number): Point[] {
  const n = ring.length;
  const normals: Point[] = [];

  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy);

    // A repeated point is not a wall and has no normal. It inherits the one
    // before it, so the corner either side of it still has two to bisect.
    normals.push(l === 0
      ? (normals[i - 1] ?? { x: 0, y: 0 })
      : { x: -dy / l, y: dx / l });
  }

  return ring.map((v, i) => {
    const d = depth(i);
    const p = normals[(i - 1 + n) % n], q = normals[i];

    let bx = p.x + q.x, by = p.y + q.y;
    const l = Math.hypot(bx, by);

    // A hairpin's two normals cancel and there is no bisector to scale. The
    // wall's own normal is the least wrong thing to move along, and it is what
    // the corner would have got had the ring simply carried on.
    if (l < 1e-12) return { x: v.x + q.x * d, y: v.y + q.y * d };

    bx /= l;
    by /= l;

    const cosHalf = bx * q.x + by * q.y;

    if (Math.abs(cosHalf) < 1e-12) return { x: v.x + q.x * d, y: v.y + q.y * d };

    return { x: v.x + bx / cosHalf * d, y: v.y + by / cosHalf * d };
  });
}

/**
 * The ground the boundary covers on its way in and on its way out, kept apart
 * for `offset`: one quad per wall, running from where it was to where it went.
 *
 * Two triangles per quad rather than the quad, so that a wall whose two moved
 * ends have crossed over fills both of its lobes instead of cancelling one
 * against the other. Where the depth changes sign along a wall the quad is cut
 * at the crossing first, because the two halves are not the same operation.
 */
function swept(shape: Shape, depth: (r: number, i: number) => number): Band {
  const out: Band = { inward: [], outward: [] };

  // A depth this side of the arrangement's own snap is no depth at all, and
  // saying so here is what keeps the answer from depending on the frame it was
  // taken in. A corner at 1e-15 of the shape's own size still has a *sign*,
  // and the sign is not a small thing: a wall between one of those and an
  // ordinary depth is a wall whose two ends went opposite ways, so it is cut
  // at the crossing and a slice of band is emitted on the far side. The slice
  // has the area its depth deserves — none — but it carries a vertex, and
  // whether the walk welds that vertex away or keeps it comes down to how the
  // numbers happened to round. Taken in a polygon's own frame and again in
  // world units, the same shape then came back with a different number of
  // corners. Rounded off first, both agree by construction.
  //
  // Relative, so it says the same thing at every scale: the depth and the size
  // of the shape go through a frame together, and their ratio comes out the
  // far side unchanged.
  const eps = extentOf(shape) * 1e-9;
  const at = (r: number, i: number): number => {
    const d = depth(r, i);

    return Math.abs(d) <= eps ? 0 : d;
  };

  for (let r = 0; r < shape.length; r++) sweep(shape[r], i => at(r, i), out);

  return out;
}

/** One ring's worth of it, into `out`. */
function sweep(ring: Ring, depth: (i: number) => number, out: Band): void {
  const moved = corners(ring, depth);
  const n = ring.length;

  const emit = (ring: Ring, side: number): void => {
    if (side > 0) out.inward.push(ccw(ring));
    else if (side < 0) out.outward.push(ccw(ring));
  };

  /**
   * One wall's worth of sweep: the quad from where it was to where it went,
   * whole where it is a quad and cut in two where it has folded over.
   *
   * Whole wherever it can be, and that is not tidiness. A quad split down its
   * diagonal leaves one piece of the order of the wall's length by the depth
   * and one of the order of the depth squared, and at a depth near the
   * arrangement's own tolerance the second is beneath it while the first is
   * not — so half the sweep lands and half does not, and a hole the band was
   * supposed to open up disappears instead. Only a fold needs the diagonal,
   * because a bowtie filled as one ring cancels a lobe against the other.
   */
  const put3 = (a: Point, b: Point, c: Point, side: number): void => {
    emit([a, b, c], side);
  };

  const put = (a: Point, b: Point, c: Point, d: Point, side: number): void => {
    if (crossing(a, b, c, d) || crossing(b, c, d, a)) {
      emit([a, b, c], side);
      emit([a, c, d], side);

      return;
    }

    emit([a, b, c, d], side);
  };

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = ring[i], b = ring[j];
    const da = depth(i), db = depth(j);

    if (da === 0 && db === 0) continue;

    if (da * db < 0) {
      // Where the moved wall crosses the wall it came from — the one place
      // along it the boundary has not moved at all — which is the point the
      // sweep's two sides meet at and the only place it can be cut. Not the
      // depths' own zero: a corner moved along its bisector slides along the
      // wall as well as across it, so where the offset passes through nothing
      // is a crossing to be solved for rather than a fraction to be read off.
      const x = met(a, b, moved[i], moved[j]);

      if (x !== null) {
        put3(a, x, moved[i], da);
        put3(x, b, moved[j], db);
        continue;
      }
    }

    const side = da !== 0 ? da : db;

    put(a, b, moved[j], moved[i], side);
  }
}

/** Where two segments cross, or nothing when they do not. */
function met(a: Point, b: Point, c: Point, d: Point): Point | null {
  const ux = b.x - a.x, uy = b.y - a.y;
  const vx = d.x - c.x, vy = d.y - c.y;
  const det = ux * vy - uy * vx;

  if (det === 0) return null;

  const t = ((c.x - a.x) * vy - (c.y - a.y) * vx) / det;
  const u = ((c.x - a.x) * uy - (c.y - a.y) * ux) / det;

  if (t < 0 || t > 1 || u < 0 || u > 1) return null;

  return { x: a.x + ux * t, y: a.y + uy * t };
}

/** Whether two segments cross, ends excluded: what tells a folded quad from a
 * quad. */
function crossing(a: Point, b: Point, c: Point, d: Point): boolean {
  const side = (p: Point, q: Point, r: Point) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);

  const a1 = side(a, b, c), a2 = side(a, b, d);
  const b1 = side(c, d, a), b2 = side(c, d, b);

  return a1 * a2 < 0 && b1 * b2 < 0;
}

/** The material left when the boundary has swept `swept`: what it covered on
 * the way in is gone, what it covered on the way out is ground. */
function offset(shape: Cut, swept: Band): Cut {
  let out: Cut = shape;

  if (swept.inward.length > 0) out = subtract(out, swept.inward);
  if (swept.outward.length > 0) out = union(out, swept.outward);

  return out;
}

/**
 * The same ring, wound counter-clockwise. Pieces of the band overlap all over
 * each other and are filled by the nonzero rule, so one wound against the rest
 * would cancel what it covers rather than add to it.
 */
function ccw(ring: Ring): Ring {
  return isCCW(ring) ? ring : [...ring].reverse();
}

/** One self-intersecting loop as a set of loops that are not. */
export function decompose(ring: Ring): Cut {
  return simplify([ring]);
}

// -----------------------------------------------------------------------------
// Ring arithmetic
// -----------------------------------------------------------------------------

/** Twice the signed area; positive when the ring winds counter-clockwise. */
export function signedArea2(ring: Ring): number {
  let s = 0;

  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    s += p.x * q.y - q.x * p.y;
  }

  return s;
}

export function area(ring: Ring): number {
  return Math.abs(signedArea2(ring)) / 2;
}

export function isCCW(ring: Ring): boolean {
  return signedArea2(ring) > 0;
}

/** The area a shape covers, holes taken out. */
export function shapeArea(shape: Shape): number {
  return Math.abs(shape.reduce((s, r) => s + signedArea2(r), 0)) / 2;
}

/** How many times the shape's rings wind around `p`. */
export function winding(shape: Shape, p: Point): number {
  let w = 0;

  for (const ring of shape) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];

      w += turn(a, b, p);
    }
  }

  return w;
}

/**
 * What one edge contributes to the winding number around `p`: the ray runs to
 * the right, so an edge counts only where it straddles `p.y` and crosses beyond
 * `p.x`, and which way it was going decides the sign.
 */
function turn(a: Point, b: Point, p: Point): number {
  if (a.y <= p.y) {
    if (b.y > p.y && cross(a, b, p) > 0) return 1;
  }
  else {
    if (b.y <= p.y && cross(a, b, p) < 0) return -1;
  }

  return 0;
}

// -----------------------------------------------------------------------------
// Shapes prepared for many point queries
//
// `winding` reads every edge, which is what a one-off query should do. The
// arrangement is not a one-off: it asks four times per surviving segment, and
// there are as many segments as edges, so the pair of them is quadratic and it
// is by a distance the most expensive thing in a `combine`. At ten thousand
// polygons it measured near a minute on its own.
//
// The ray only meets edges that straddle `p.y` and reach past `p.x`, so a tree
// over the edges answers the rest without looking. What comes back is a
// superset — a box can reach past `p.x` while its edge crosses behind — and the
// same `turn` sorts those out, so the answer is the one `winding` gives.
//
// A field is per shape, and deliberately not per world. The ray runs to
// infinity, so pouring every polygon into one field makes every query walk
// everything to the right of it, and the cost of a point starts growing with
// the map. `Ground` is what a world wants instead: one field each, and a tree
// to find the one or two that could possibly contain the point.
// -----------------------------------------------------------------------------

export interface Field {
  shape: Shape
  tree: Packed
  /** `a` and `b` of each edge, flattened, four numbers apiece. */
  edges: Float64Array
}

export function field(shape: Shape): Field {
  let n = 0;

  for (const ring of shape) n += ring.length;

  const edges = new Float64Array(n * 4);
  const boxes = new Float64Array(n * 4);
  let id = 0;

  for (const ring of shape) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const at = id * 4;

      edges[at] = a.x;
      edges[at + 1] = a.y;
      edges[at + 2] = b.x;
      edges[at + 3] = b.y;

      boxes[at] = Math.min(a.x, b.x);
      boxes[at + 1] = Math.min(a.y, b.y);
      boxes[at + 2] = Math.max(a.x, b.x);
      boxes[at + 3] = Math.max(a.y, b.y);

      id++;
    }
  }

  return { shape, tree: pack(boxes), edges };
}

export function fieldWinding(f: Field, p: Point): number {
  const e = f.edges;
  let w = 0;

  // Everything the ray could meet: to the right of `p`, and level with it.
  eachPacked(f.tree, p.x, p.y, Infinity, p.y, id => {
    const at = id * 4;

    w += turn(
      { x: e[at], y: e[at + 1] },
      { x: e[at + 2], y: e[at + 3] },
      p,
    );
  });

  return w;
}

/** Nonzero fill, over a prepared shape. */
export function fieldContains(f: Field, p: Point): boolean {
  return fieldWinding(f, p) !== 0;
}

/** Nonzero fill. Points exactly on an edge are not to be relied on. */
export function contains(shape: Shape, p: Point): boolean {
  return winding(shape, p) !== 0;
}

/**
 * Whether `inner` lies wholly inside `outer` — and *strictly* inside, nothing
 * of it touching the boundary.
 *
 * Answered so that a `false` costs almost nothing and never lies the other way:
 * it is asked in front of an `intersect` to find out whether that intersect
 * would be the identity, so a `true` has to mean the clip changes nothing and a
 * `false` need only mean *cannot say cheaply*. The caller then pays the boolean
 * it was going to pay anyway.
 *
 * Three things are checked, over the edge tree the outer shape is already
 * indexed by, so each is a query about one edge's neighbourhood rather than a
 * walk over the whole boundary:
 *
 * - No edge of `inner` meets an edge of `outer`. A ring that never crosses the
 *   boundary is wholly on one side of it.
 * - Nothing of `inner` lies *on* the boundary, within the same hair the rest of
 *   this file measures coincidence by. That is where a winding number is
 *   nobody's business, and a floor drawn exactly around a pillar — every corner
 *   of it on the hole's own ring — is the case that turns on it: it is outside
 *   the level everywhere, and asking a point of it which side it is on is
 *   asking a question with no answer.
 * - Every corner and every edge's midpoint is inside. The corners alone are not
 *   enough: a chord from one corner of a concave outline to another has both
 *   ends inside and its middle out in the notch. It crosses two edges getting
 *   there and the first test has it — the midpoint is what stands behind that
 *   for the case where the crossing is exactly through a vertex.
 *
 * A floor drawn flush against the walls of its room is the price: it lies on
 * the boundary and this says no, so the clip is taken. It is the one answer a
 * cheap test cannot give, and the shape that has to be intersected there is the
 * simplest one there is.
 */
export function encloses(outer: Shape, inner: Shape): boolean {
  if (inner.length === 0) return true;
  if (outer.length === 0) return false;
  if (!containsBox(ofRings(outer), ofRings(inner))) return false;

  const f = field(outer);
  const e = f.edges;
  const eps = extentOf(outer) * 1e-7;

  for (const ring of inner) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

      let clear = true;

      eachPacked(
        f.tree,
        Math.min(a.x, b.x) - eps,
        Math.min(a.y, b.y) - eps,
        Math.max(a.x, b.x) + eps,
        Math.max(a.y, b.y) + eps,
        id => {
          if (!clear) return;

          const at = id * 4;
          const c = { x: e[at], y: e[at + 1] }, d = { x: e[at + 2], y: e[at + 3] };

          clear = met(a, b, c, d) === null && !hugs(a, c, d, eps) && !hugs(mid, c, d, eps);
        },
      );

      if (!clear) return false;
      if (!fieldContains(f, a) || !fieldContains(f, mid)) return false;
    }
  }

  return true;
}

/** Whether `p` is within `eps` of the segment `a`-`b`, ends included. */
function hugs(p: Point, a: Point, b: Point, eps: number): boolean {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;

  if (l2 === 0) return Math.hypot(p.x - a.x, p.y - a.y) <= eps;

  const t = Math.min(Math.max(((p.x - a.x) * dx + (p.y - a.y) * dy) / l2, 0), 1);

  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)) <= eps;
}

function cross(a: Point, b: Point, p: Point): number {
  return (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
}

// -----------------------------------------------------------------------------
// The arrangement
// -----------------------------------------------------------------------------

interface Seg {
  a: Point
  b: Point
  /** The input edge this is a piece of. */
  edge: SourceRef
  ta: Tag
  tb: Tag
  /**
   * Which operand owns it, in the order that settles a shared edge: where two
   * of them lie on exactly the same ground only the lowest rank may claim it,
   * or the boundary would be counted twice.
   */
  rank: number
  /** The lowest rank lying on top of this piece, or `Infinity` where nothing
   * does. Filled in by `split`, read by `arranged`. */
  shadow: number
}

/** A stretch of one segment that a lower-ranked segment lies along. */
interface Cover {
  t0: number
  t1: number
  rank: number
}

/** A cut parameter along a segment, and what the point there is. */
interface Param {
  t: number
  tag: Tag
  /**
   * Where the cut is, when that is not simply how far along the segment it
   * sits.
   *
   * A vertex a hair off a segment cuts it, and the point of cutting it there is
   * that the vertex and the cut are the *same* point of the arrangement. Left to
   * the parameter, the cut lands at the vertex's foot instead — a hair away —
   * and whether the two ever become one node is then up to a weld further down
   * that has its own idea of how close is close. Carrying the point settles it
   * here: the two are one because they are the same pair of numbers.
   */
  at?: Point
}

/**
 * Tolerances are relative to how big the input is: a scene measured in
 * thousands of world units needs a coarser idea of "the same point" than one
 * measured in fractions.
 */
function scaleOf(segs: Seg[]): number {
  let lo = Infinity, hi = -Infinity;

  for (const s of segs) {
    lo = Math.min(lo, s.a.x, s.a.y, s.b.x, s.b.y);
    hi = Math.max(hi, s.a.x, s.a.y, s.b.x, s.b.y);
  }

  const d = hi - lo;

  return Number.isFinite(d) && d > 0 ? d : 1;
}

/**
 * `ranks` gives each ring its owner, for a shape that is several polygons
 * concatenated. A shape that is one operand is one owner, which is `which`.
 */
function segments(shape: Shape, which: number, ranks?: readonly number[]): Seg[] {
  const out: Seg[] = [];

  for (let r = 0; r < shape.length; r++) {
    const ring = shape[r];
    const rank = ranks === undefined ? which : ranks[r];

    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length;
      const a = ring[i], b = ring[j];
      if (a.x === b.x && a.y === b.y) continue;

      out.push({
        a,
        b,
        edge: { shape: which, ring: r, index: i },
        ta: { kind: 'vertex', at: { shape: which, ring: r, index: i } },
        tb: { kind: 'vertex', at: { shape: which, ring: r, index: j } },
        rank,
        shadow: Infinity,
      });
    }
  }

  return out;
}

// -----------------------------------------------------------------------------
// Tags
// -----------------------------------------------------------------------------

function cmpRef(p: SourceRef, q: SourceRef): number {
  return p.shape - q.shape || p.ring - q.ring || p.index - q.index;
}

/** Ordered, so that the same pair of edges names the same crossing either way
 * round. */
function crossTag(e: SourceRef, f: SourceRef): Tag {
  return cmpRef(e, f) <= 0
    ? { kind: 'cross', a: e, b: f }
    : { kind: 'cross', a: f, b: e };
}

/**
 * Which of two tags for the same point to keep. A point that is an input vertex
 * is called that, whatever else happens to pass through it; among equals the
 * lower reference wins, so the choice does not depend on the order the
 * arrangement happened to be walked in.
 */
function betterTag(x: Tag, y: Tag): Tag {
  if (x.kind !== y.kind) return x.kind === 'vertex' ? x : y;
  if (x.kind === 'vertex' && y.kind === 'vertex') return cmpRef(x.at, y.at) <= 0 ? x : y;

  const a = x as { kind: 'cross', a: SourceRef, b: SourceRef };
  const b = y as { kind: 'cross', a: SourceRef, b: SourceRef };

  return (cmpRef(a.a, b.a) || cmpRef(a.b, b.b)) <= 0 ? x : y;
}

/**
 * Every segment cut at every point another segment touches it. Collinear
 * overlaps count: their endpoints are projected back onto each other so that a
 * shared edge ends up split identically on both sides.
 *
 * Only the first `primary` segments come back cut up. The rest are still
 * consulted — they are what does the cutting — but their own pieces are never
 * built, which is the whole saving when a caller wants one polygon's edges out
 * of a neighbourhood of eight. Every pair with a primary in it is still visited
 * exactly once; the pairs skipped are the ones with no primary at all, and
 * those can only cut each other.
 */
function split(segs: Seg[], eps: number, primary = segs.length): Seg[] {
  const ts: Param[][] = segs.map(s => [{ t: 0, tag: s.ta }, { t: 1, tag: s.tb }]);
  const covers: Cover[][] = [];

  for (let i = 0; i < primary; i++) covers.push([]);

  // Two segments whose boxes miss each other cannot touch, so the tree answers
  // for almost every pair at once. This used to be every pair against every
  // other, which is fine at the scale a single room is drawn at and quadratic
  // everywhere else: ten thousand polygons is eighty thousand segments and
  // three billion tests, which measured at two minutes for one combine.
  //
  // The boxes are grown by `eps` because `intersectInto` counts anything within
  // that distance as touching, so two segments can meet without their exact
  // boxes overlapping.
  const boxes = boxesOf(segs, eps);
  const tree = pack(boxes);
  const near: number[] = [];

  for (let i = 0; i < primary; i++) {
    near.length = 0;

    // A pair of primaries would be visited from both ends, so it is taken from
    // the lower one only. A pair with a secondary in it is reached from the
    // primary end alone, so it is always taken.
    eachPacked(tree, boxes[i * 4], boxes[i * 4 + 1], boxes[i * 4 + 2], boxes[i * 4 + 3], j => {
      if (j !== i && (j > i || j >= primary)) near.push(j);
    });

    // In index order, so the pairs are visited exactly as the nested loops
    // visited them. Points that land within a hair of each other collapse onto
    // whichever arrived first, so the order is not quite free to change.
    near.sort((x, y) => x - y);

    for (const j of near) {
      intersectInto(
        segs[i], segs[j],
        ts[i], ts[j],
        covers[i], covers[j] ?? null,
        eps,
      );
    }
  }

  const out: Seg[] = [];

  for (let i = 0; i < primary; i++) {
    const { a, b } = segs[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    const tol = eps / Math.max(len, eps);

    const sorted = ts[i].sort((p, q) => p.t - q.t);
    const kept: Param[] = [];

    // Points that collapse together keep the first one's position and the best
    // of their tags: three edges meeting is one point, not three.
    for (const p of sorted) {
      const last = kept[kept.length - 1];

      if (last === undefined || p.t - last.t > tol) {
        kept.push(p);
      }
      else {
        last.tag = betterTag(last.tag, p.tag);
      }
    }

    for (let k = 0; k + 1 < kept.length; k++) {
      const t0 = kept[k], t1 = kept[k + 1];
      const mid = (t0.t + t1.t) / 2;

      let shadow = Infinity;

      for (const c of covers[i]) {
        if (c.t0 <= mid && mid <= c.t1) shadow = Math.min(shadow, c.rank);
      }

      out.push({
        a: t0.at ?? { x: a.x + dx * t0.t, y: a.y + dy * t0.t },
        b: t1.at ?? { x: a.x + dx * t1.t, y: a.y + dy * t1.t },
        edge: segs[i].edge,
        ta: t0.tag,
        tb: t1.tag,
        rank: segs[i].rank,
        shadow,
      });
    }
  }

  return out;
}

/**
 * Parameters at which `s` and `u` meet, appended to their respective lists.
 *
 * Where the two run along each other the stretch is recorded as well, on
 * whichever of them is outranked. That is the one thing a segment cannot work
 * out from its own pieces later: that something else is lying on it.
 */
function intersectInto(
  s: Seg,
  u: Seg,
  ts: Param[],
  us: Param[],
  cs: Cover[] | null,
  cu: Cover[] | null,
  eps: number,
): void {
  const rx = s.b.x - s.a.x, ry = s.b.y - s.a.y;
  const sx = u.b.x - u.a.x, sy = u.b.y - u.a.y;
  const d = rx * sy - ry * sx;
  const qx = u.a.x - s.a.x, qy = u.a.y - s.a.y;

  const rl = Math.hypot(rx, ry), sl = Math.hypot(sx, sy);

  if (Math.abs(d) <= eps * rl * sl) {
    // Parallel. Only collinear pairs can meet, and then along a whole stretch.
    if (Math.abs(qx * ry - qy * rx) > eps * rl) return;

    const rr = rx * rx + ry * ry;
    const t0 = (qx * rx + qy * ry) / rr;
    const t1 = t0 + (sx * rx + sy * ry) / rr;

    // A collinear overlap meets at the other segment's *endpoints*, so these
    // are input vertices rather than crossings — and the point is that vertex,
    // not the parameter's idea of where it projects to.
    addParam(ts, t0, u.ta, u.a);
    addParam(ts, t1, u.tb, u.b);

    const ss = sx * sx + sy * sy;
    const u0 = (-qx * sx - qy * sy) / ss;
    const u1 = (rx * sx + ry * sy - qx * sx - qy * sy) / ss;

    addParam(us, u0, s.ta, s.a);
    addParam(us, u1, s.tb, s.b);

    if (cs !== null && u.rank < s.rank) {
      cs.push({ t0: Math.min(t0, t1), t1: Math.max(t0, t1), rank: u.rank });
    }

    if (cu !== null && s.rank < u.rank) {
      cu.push({ t0: Math.min(u0, u1), t1: Math.max(u0, u1), rank: s.rank });
    }

    return;
  }

  // An end of one lying all but on the other is *on* it, and where that end sits
  // is where these two meet — not the crossing a hair further along. Both are
  // true of the same configuration and only one of them can be the node: keep
  // the crossing as well and the boundary gets two nodes a rounding apart where
  // it has one corner, which is a sliver of a face that nothing can classify
  // and, when the walk gives up on it, a chord drawn across the shape.
  //
  // This is the reading `welder` is going to take further down anyway, taken
  // here, where there is still something to be done about it. Left to the weld
  // the two disagree over a whole band of separations — near enough that the
  // weld makes one node of them, far enough that the cut has already made two.
  if (touching(s, u, ts, us, eps * NEARBY)) return;

  const t = (qx * sy - qy * sx) / d;
  const u0 = (qx * ry - qy * rx) / d;

  // The lines always meet; the segments only do when both parameters land on
  // them. Without that check a segment would be cut where its neighbour's
  // *line* passes, which litters the result with points that are not corners.
  const tol = eps / Math.max(rl, sl, eps);
  if (t < -tol || t > 1 + tol || u0 < -tol || u0 > 1 + tol) return;

  const tag = crossTag(s.edge, u.edge);

  // One point, handed to both. Worked out twice — once from `t` along this
  // segment and once from `u0` along that one — it comes back as two points a
  // last bit or two apart, and something downstream then has to notice they are
  // the same place. They are the same place because they are the same object.
  const meet = { x: s.a.x + rx * t, y: s.a.y + ry * t };

  addParam(ts, t, tag, meet);
  addParam(us, u0, tag, meet);
}

/**
 * How much further than the weld's own reach a vertex may sit from an edge and
 * still be read as on it.
 *
 * The band this has to cover is the one between "close enough that the weld will
 * make these one node anyway" and "far enough that the crossing is honestly a
 * separate point". Below it everything already worked; above it everything
 * already worked; inside it the cut said two points and the weld said one, and
 * what came out was a room with half its ground missing.
 *
 * Measured rather than reasoned to, and the window is narrow enough to be worth
 * writing down: at two and above the sweeps below are clean, and at six a
 * pillar inside an eroding group starts coming apart, because a reach this
 * generous begins swallowing crossings that are really there. Three is the
 * middle of that, and it is a factor of two from trouble in each direction
 * rather than a decade — so anything that widens the arrangement's other
 * tolerances should be run past `a vertex landing on a wall` in
 * `geometry.test.ts` before it is believed.
 *
 * What it costs is that a vertex within this of a wall is treated as touching
 * it, which moves the boundary by at most that much — a few hundred-millionths
 * of a unit on a level this size, against the half a room it buys.
 */
const NEARBY = 3;

/**
 * Ends of either segment that lie within `reach` of the other one, cut in where
 * they land.
 *
 * A vertex a hair off a wall is a vertex on the wall, and saying so is what
 * makes a level that is nearly flush behave like one that is exactly flush —
 * which the arrangement has always handled exactly right.
 *
 * The cut is placed at the vertex itself rather than at its foot on the edge, so
 * that the two readings of it are the same pair of numbers and not two points a
 * rounding apart hoping to be welded. The edge picks up a kink of at most
 * `reach`, which is a great deal less than the edge's own idea of straight.
 *
 * True when it found any, and then the crossing is not looked for: these two
 * meet where the vertex is.
 */
function touching(s: Seg, u: Seg, ts: Param[], us: Param[], reach: number): boolean {
  // Written out rather than looped over pairs: this is asked of every pair of
  // segments whose boxes meet, and the loop was allocating its own arrays to
  // walk four points.
  // All four, in this order, whatever the first ones found.
  const one = landed(s, u.a, u.ta, ts, reach);
  const two = landed(s, u.b, u.tb, ts, reach);
  const three = landed(u, s.a, s.ta, us, reach);
  const four = landed(u, s.b, s.tb, us, reach);

  return one || two || three || four;
}

/** `p` cut into `host` where it lands, when it lands on it at all. */
function landed(host: Seg, p: Point, tag: Tag, into: Param[], reach: number): boolean {
  const at = footOf(host, p, reach);

  if (at === null) return false;

  addParam(into, at, tag, p);

  return true;
}

/** How far along a segment a point within `reach` of it sits, or nothing where
 * it is further off than that, or past either end. */
function footOf(s: Seg, p: Point, reach: number): number | null {
  const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y;
  const len = Math.hypot(dx, dy);

  if (len <= reach) return null;

  const at = ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / (len * len);

  if (at <= 0 || at >= 1) return null;

  const off = Math.abs((p.x - s.a.x) * dy - (p.y - s.a.y) * dx) / len;

  return off <= reach ? at : null;
}

function addParam(ts: Param[], t: number, tag: Tag, at?: Point): void {
  if (t > 0 && t < 1) ts.push({ t, tag, at });
}

// -----------------------------------------------------------------------------
// Classification and chaining
// -----------------------------------------------------------------------------

/** Any of the above, and the only thing that actually does the work. */
export function combine(a: Shape, b: Shape, op: Op, fill: Fill = fieldContains): Cut {
  return combineTagged(a, b, op, fill).rings as Cut;
}

/**
 * `combine`, keeping every output point's provenance. The bake needs to know
 * which points of one version's result are the same points as in the next, and
 * position cannot answer that: geometry moves. A tag names only the input, so
 * matching is exact for as long as the tag set and their ring order hold.
 */
export function combineTagged(
  a: Shape,
  b: Shape,
  op: Op,
  fill: Fill = fieldContains,
): TaggedShape {
  const raw = [...segments(a, 0), ...segments(b, 1)];
  const snap = scaleOf(raw) * 1e-9;

  // Prepared once and asked four times per segment, which is the whole reason
  // they exist.
  const fa = field(a), fb = field(b);

  return chain(
    arranged(
      [p => fill(fa, p), p => fill(fb, p)],
      on => op(on[0], on[1]),
      split(raw, snap),
      snap,
    ),
    snap,
  );
}

/**
 * How far each segment's middle can be stepped off without leaving the face
 * it is stepping into — half the distance to the nearest other segment, and
 * `Infinity` where nothing is within reach at all, which is nearly everywhere.
 *
 * `arranged` reads the field a step off either side of a segment's middle and
 * keeps the segment when the two readings differ. That is only a statement about
 * *this* segment while both readings stay inside the two faces it separates.
 * Nothing after `split` crosses anything else, so the only way another segment
 * gets between them is to run alongside at a hair's distance — which is what two
 * edges do just past a crossing they made at a very shallow angle.
 *
 * The stub past such a crossing lies nearer to the edge it crossed than a fixed
 * step is long. Both readings then straddle that edge instead of this one, come
 * back different, and the stub is kept as a boundary it is not on. Chaining
 * cannot use it — it dead-ends — so the walk closes the ring across a chord and
 * hands back two rings with a triangle of ground missing between them, which is
 * what a wall flat enough to have almost stopped turning used to do at the end of
 * a span.
 *
 * Only segments within the fixed step are asked about, so this is a tree query
 * that comes back empty for all but a handful of a level's segments.
 */
function clearance(segs: Seg[], reach: number, snap: number): number[] {
  const tree = pack(boxesOf(segs, 0));
  const out = segs.map(() => Infinity);

  segs.forEach((s, i) => {
    const mx = (s.a.x + s.b.x) / 2, my = (s.a.y + s.b.y) / 2;

    eachPacked(tree, mx - reach, my - reach, mx + reach, my + reach, j => {
      if (j === i) return;

      const d = toSegment(segs[j], mx, my);

      // Something lying along this segment rather than beside it is the same
      // boundary arriving twice — that is what `shadow` is for — and stepping
      // off it is stepping off this one. Only a *different* boundary running
      // close by can put a reading in the wrong face.
      if (d > snap && d < out[i]) out[i] = d;
    });
  });

  return out.map(d => d / 2);
}

/** Each segment's box grown by `by`, four numbers apiece, for `pack`. */
function boxesOf(segs: readonly Seg[], by: number): Float64Array {
  const out = new Float64Array(segs.length * 4);

  for (let i = 0; i < segs.length; i++) {
    const { a, b } = segs[i];

    out[i * 4] = Math.min(a.x, b.x) - by;
    out[i * 4 + 1] = Math.min(a.y, b.y) - by;
    out[i * 4 + 2] = Math.max(a.x, b.x) + by;
    out[i * 4 + 3] = Math.max(a.y, b.y) + by;
  }

  return out;
}

/** How far `(x, y)` is from the segment, endpoints included. */
function toSegment(s: Seg, x: number, y: number): number {
  const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((x - s.a.x) * dx + (y - s.a.y) * dy) / len));

  return Math.hypot(x - (s.a.x + dx * t), y - (s.a.y + dy * t));
}

/**
 * Whether a point is in the set, by asking each slot and handing the answers to
 * the rule.
 *
 * `where` is the caller's scratch array, filled again per point rather than
 * built. This runs twice per segment of every arrangement in the editor and
 * the bake alike, and there is no reason to allocate an array per call in a
 * loop that size. The rule reads it and does not keep it.
 *
 * It is not where the slots cost anything, measured: a level's third slot is
 * worth about two percent of the bake whether this allocates or not, and
 * skipping the empty ones outright bought nothing either.
 */
function reading(
  on: readonly ((p: Point) => boolean)[],
  rule: Rule,
  where: boolean[],
  p: Point,
): boolean {
  for (let k = 0; k < on.length; k++) where[k] = on[k](p);

  return rule(where);
}

/**
 * The pieces of the arrangement that belong to the answer, each turned so the
 * answer's interior is on its left.
 *
 * Shared by `combineTagged`, which chains them into rings, and `boundaryRuns`,
 * which asks about one polygon's own edges and nobody else's. They disagree
 * about how much of the operands is worth preparing in advance, so each hands
 * in its own way of asking whether a point is inside one rather than a shape.
 */
function arranged(
  on: readonly ((p: Point) => boolean)[],
  rule: Rule,
  segs: Seg[],
  snap: number,
): Seg[] {
  // `snap` was scaled off the input the same way, so this recovers it.
  const scale = snap / 1e-9;

  const kept: Seg[] = [];
  const seen = new Set<string>();
  const weld = welder(snap);
  const room = clearance(segs, scale * 1e-7, snap);
  const where = new Array<boolean>(on.length);

  for (let k = 0; k < segs.length; k++) {
    const s = segs[k];
    const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y;
    const len = Math.hypot(dx, dy);
    if (len <= snap) continue;

    // A step off either side of the middle, far enough to clear rounding and
    // short enough to stay inside whichever face the side belongs to. The last
    // of those is a fact about the neighbourhood rather than about this segment,
    // which is why `clearance` had to go and measure it.
    const off = Math.min(scale * 1e-7, len * 0.25, room[k]);
    const nx = -dy / len * off, ny = dx / len * off;
    const mx = s.a.x + dx / 2, my = s.a.y + dy / 2;

    const left = { x: mx + nx, y: my + ny };
    const right = { x: mx - nx, y: my - ny };

    const inLeft = reading(on, rule, where, left);
    const inRight = reading(on, rule, where, right);

    if (inLeft === inRight) continue;

    // Something lower-ranked lies along exactly this piece and has as good a
    // claim to it. Coincident pieces are the same geometry, so they classified
    // alike, and the loser would have survived for the same reason the winner
    // did — which is why losing can be decided without classifying the winner
    // at all.
    if (s.shadow < s.rank) continue;

    // Orient so the answer's interior is on the left. Coincident edges of the
    // two operands land on the same directed segment and collapse to one.
    const dir: Seg = inLeft
      ? s
      : { ...s, a: s.b, b: s.a, ta: s.tb, tb: s.ta };
    const key = weld.id(dir.a) + '|' + weld.id(dir.b);

    if (seen.has(key)) continue;

    seen.add(key);
    kept.push(dir);
  }

  return kept;
}

// -----------------------------------------------------------------------------
// One polygon's share of the boundary
//
// The answer's outline is made of pieces of the inputs' edges, and every piece
// belongs to exactly one input polygon. That partition is what makes an
// incremental set possible: a piece of A's boundary survives exactly when
// nothing lying over A buries it, so A's share depends on A and on the polygons
// A actually overlaps — never on what those overlap in turn.
//
// So the caller hands over the polygon and its neighbours, and gets back the
// runs of its own edges that reached the outline. Two polygons that touch
// neither A nor each other cannot change this answer, however the union happens
// to connect them up somewhere else.
//
// The runs are open on purpose. A closed ring is generally made of several
// polygons' runs and belongs to none of them, and assembling one is a separate
// job that most callers turn out not to need: collision wants edge normals, and
// a corner needs only the run that carries on past it rather than the whole
// loop.
//
// Asking about the neighbours costs nothing extra
// ----------------------------------------------
// A neighbourhood is asked about many times over — once per polygon in it, by
// whoever wants that polygon's share — and the neighbours overlap, so the same
// polygon turns up in eight of these. Everything a call does that is not about
// its own subject is therefore work some other call is doing too, and work this
// one is about to throw away.
//
// Two things follow. The subject's edges are the only ones cut up and
// classified: the neighbours do the cutting, and where a shared edge decides
// who owns it `rank` settles that without the loser ever being built. And the
// point queries run off a `Ground` prepared once for everybody, rather than a
// field assembled per subject out of shapes it has in common with the next
// subject along. Together those took a ten thousand polygon world from four and
// a half seconds to under two.
// -----------------------------------------------------------------------------

/**
 * A polygon taking part in the set, as `boundaryRuns` needs to see it.
 *
 * `slot` is which part of the set it plays and nothing else. It used to be a
 * direction — added or subtracted — which was the two-slot case written out as
 * though two were all there could be. A level is resolved out of three and a
 * floor out of two, and both go through here on exactly this machinery: what
 * the slots *mean* is settled by the `Rule` and never reaches this file.
 */
export interface Member {
  id: number
  slot: number
  shape: Shape
}

/**
 * Every member's edges, prepared for the point queries the classification
 * makes.
 *
 * A neighbourhood's own field gives the same answers as the whole world's: a
 * ring contributes to the winding at a point only when it contains that point,
 * and a polygon containing a point a hair off `subject`'s edge is a polygon
 * overlapping `subject`. So the field can be built once for everybody instead
 * of once per member — which matters because the members overlap, and a world
 * of ten thousand polygons was putting each polygon's edges into a tree once
 * for every neighbour it had.
 *
 * Nothing in here is a tolerance. Those stay local, worked out from the
 * neighbourhood actually being asked about.
 */
export type Ground = readonly Slot[];

/** One slot's members, each prepared on its own and findable by where it is. */
interface Slot {
  tree: Packed
  parts: Field[]
}

/**
 * `slots` rather than however many the members happen to fill, because a set
 * with nothing in one of its slots still has that slot: the rule asks about it
 * either way, and an empty one answers no.
 */
export function ground(members: Iterable<Member>, slots: number): Ground {
  const all: Slot[] = [];
  const boxes: number[][] = [];

  for (let k = 0; k < slots; k++) {
    all.push({ tree: pack(new Float64Array(0)), parts: [] });
    boxes.push([]);
  }

  for (const m of members) {
    if (m.shape.length === 0) continue;

    const slot = all[m.slot];

    const b = ofRings(m.shape);

    boxes[m.slot].push(b.minX, b.minY, b.maxX, b.maxY);
    slot.parts.push(field(m.shape));
  }

  for (let k = 0; k < slots; k++) all[k].tree = pack(Float64Array.from(boxes[k]));

  return all;
}

/**
 * Nonzero fill over a whole slot. Winding is additive over rings, and a member
 * that does not have `p` in its box contributes none of it, so the tree hands
 * back the one or two members that could and the rest are never read.
 */
function covers(slot: Slot, p: Point): boolean {
  let w = 0;

  eachPacked(slot.tree, p.x, p.y, p.x, p.y, i => {
    w += fieldWinding(slot.parts[i], p);
  });

  return w !== 0;
}

/**
 * Where an output point came from, in the members' own terms: whose ring, which
 * ring of theirs, and which vertex or edge of it.
 *
 * `Tag` says the same thing about the operands a boolean was handed, which is
 * an accident of how the call was assembled. This says it about the level, and
 * is the same answer wherever the polygons were put in the argument list.
 */
export interface Whence {
  id: number
  ring: number
  index: number
}

/**
 * Why a boundary point is where it is, named rather than measured.
 *
 * A point of the boundary is one of exactly two things: a corner of one
 * member's own outline, or the crossing of two members' edges. Both name only
 * the input, so two readings taken at two instants agree about a point exactly
 * when they agree about its name — and disagree only when the arrangement
 * really has changed, which is an event and not something to be recovered from.
 *
 * This is the thing the bake used to work out again by hand, hunting each point
 * for a vertex or an edge near it. Near is a tolerance, and a tolerance in
 * something this load-bearing is a bug with a schedule.
 */
export type Whither =
  | { kind: 'vertex', at: Whence }
  | { kind: 'cross', a: Whence, b: Whence }

export interface BoundaryRun {
  points: Point[]
  /**
   * Per point of `points`: whether the boundary actually turns there, which is
   * whether a vertical standing on it is telling the truth. See `cornering`,
   * and see the header of `walls.ts` for why the answer belongs here rather
   * than with whoever draws the wall.
   */
  corner: boolean[]
  /** Per point of `points`: what it is, in the members' own terms. */
  whence: Whither[]
}

/**
 * The parts of `subject`'s edges that lie on the boundary of the set the
 * members make — each slot unioned on its own and `rule` deciding what the
 * slots together mean — as open runs in the order they are walked.
 *
 * `others` is everything overlapping `subject`; nothing further away can make a
 * difference, which is the point.
 *
 * Only `subject`'s edges are ever cut up and classified. The others take part
 * — they do the cutting, and their crossings with `subject` are where its runs
 * end — but their own pieces are not built, because this call would throw them
 * away and the next one is going to build them again anyway.
 *
 * Where two polygons share an edge exactly, only one of them may claim it or
 * the boundary would be counted twice. Rank settles it: the members are ordered
 * by slot and then by id, and a piece with something lower-ranked lying along
 * it is dropped. Two coincident edges are the same geometry, so they classify
 * alike and the loser would have been kept or dropped for the same reason the
 * winner was — which is why the loser never has to be classified to know it
 * lost.
 *
 * `on` is the shared field, when the caller has one. Without it the
 * neighbourhood builds its own, which gives the same answer at more cost.
 */
export function boundaryRuns(
  subject: Member,
  others: readonly Member[],
  slots: number,
  rule: Rule,
  on?: Ground,
): BoundaryRun[] {
  const all = [subject, ...others];
  const shapes: Shape[] = [];
  const ranks: number[][] = [];

  let rank = 0, mine = -1;

  // Which member each ring of each operand came off, so that what the
  // arrangement names in its own terms can be handed back in the level's.
  const whose: { id: number, ring: number }[][] = [];

  for (let slot = 0; slot < slots; slot++) {
    shapes.push([]);
    ranks.push([]);
    whose.push([]);

    for (const m of all.filter(x => x.slot === slot).sort((p, q) => p.id - q.id)) {
      if (m.id === subject.id) mine = rank;

      m.shape.forEach((ring, r) => {
        shapes[slot].push(ring);
        ranks[slot].push(rank);
        whose[slot].push({ id: m.id, ring: r });
      });

      rank++;
    }
  }

  // Subject first, so that `split` can cut it and leave the rest alone. The
  // order no longer decides anything: rank does.
  const raw = shapes.flatMap((shape, slot) => segments(shape, slot, ranks[slot]));
  const ours = raw.filter(s => s.rank === mine);
  const rest = raw.filter(s => s.rank !== mine);

  const snap = scaleOf(raw) * 1e-9;
  const shared = on ?? ground(all, slots);

  const inSlot = shared.map(slot => (p: Point) => covers(slot, p));

  const made = runs(
    arranged(inSlot, rule, split([...ours, ...rest], snap, ours.length), snap),
    snap,
  );

  // Against everything taking part rather than against `ours`: which way the
  // boundary carries on past the end of a run is exactly the question the
  // neighbours are here to answer.
  const turning = cornering(made.map(r => r.points), raw, inSlot, rule, snap);

  const named = (ref: SourceRef): Whence => {
    const from = whose[ref.shape][ref.ring];

    return { id: from.id, ring: from.ring, index: ref.index };
  };

  // Where a member's outline crosses itself, that point is one point of the
  // boundary and two vertices of the shape: resolving the crossing closes one
  // lobe and opens the next, so the same coordinates come back in both rings,
  // and either ring's index is a true name for it.
  //
  // Which one the walk arrives through is not a fact about the boundary. It is
  // a fact about where the walk started, and it flips between one instant and
  // the next for no reason the geometry can see — so the bake read the name
  // changing, called it an event, and pinned it. A hexagon with one vertex
  // dragged across itself came back as 11,922 discontinuities in one span, and
  // looking a decade closer found 30,437: not events, the same handful of
  // crossings renaming themselves over and over.
  //
  // So one of the two is chosen and it is always the same one. Exact, not near:
  // the two vertices are the one crossing computed once and handed to both
  // lobes, equal to the bit. Only within a member — two members touching at a
  // point are two names, and rightly.
  const settled = new Map<string, SourceRef>();

  for (let which = 0; which < slots; which++) {
    shapes[which].forEach((ring, r) => {
      const from = whose[which][r];

      ring.forEach((p, i) => {
        const key = `${from.id}|${p.x}|${p.y}`;
        const was = settled.get(key);

        // Every entry under one key is the same member, so its own ring order
        // is this one and the first met is the first in it.
        if (was === undefined || r < was.ring || (r === was.ring && i < was.index)) {
          settled.set(key, { shape: which, ring: r, index: i });
        }
      });
    });
  }

  /** `named`, with a self-crossing always named by the same one of its two
   * vertices. Vertices only: an edge belongs to one ring and is not doubled. */
  const naming = (ref: SourceRef): Whence => {
    const at = shapes[ref.shape][ref.ring][ref.index];

    return named(settled.get(`${whose[ref.shape][ref.ring].id}|${at.x}|${at.y}`) ?? ref);
  };

  return made.map((run, i) => ({
    points: run.points,
    corner: turning[i],
    whence: run.tags.map(tag => tag.kind === 'vertex'
      ? { kind: 'vertex' as const, at: naming(tag.at) }
      : { kind: 'cross' as const, a: named(tag.a), b: named(tag.b) }),
  }));
}

/**
 * How far off straight the boundary has to turn at a point for a corner to be
 * there, as the sine of the angle it turns through.
 */
const TURNED = 1e-6;

/** Whether two unit directions point the same way, to within `TURNED`. */
function alike(a: Point, b: Point): boolean {
  return a.x * b.x + a.y * b.y > 0 && Math.abs(a.x * b.y - a.y * b.x) <= TURNED;
}

/** And whether they point exactly against each other, which is the boundary
 * running straight through. */
function opposed(a: Point, b: Point): boolean {
  return a.x * b.x + a.y * b.y < 0 && Math.abs(a.x * b.y - a.y * b.x) <= TURNED;
}

/** An angle brought into `(0, 2pi]`, which is how far round it is from where
 * the sweep started rather than which way it went. */
function turned(a: number): number {
  const at = a % (2 * Math.PI);

  return at <= 0 ? at + 2 * Math.PI : at;
}

/** A direction something leaves a point in, and how much of the edge it is
 * travelling there is left to go. */
interface Way {
  d: Point
  reach: number
}

/**
 * Whether the boundary actually turns at each point of each run.
 *
 * The walls are extruded from these runs and a vertical is drawn at every point
 * of them, which is a claim that there is a corner there. The CSG leaves a point
 * wherever two edges met, and where the set runs straight through one — two
 * rooms overlapping, a solid cutting across the pair, a ring cut open by the
 * arrangement — the point it leaves sits in the middle of what is now one flat
 * wall. The wall is right; the vertical is not.
 *
 * Why this is answered here rather than by whoever draws the walls
 * ---------------------------------------------------------------
 * Because this is the only place that sees a polygon *and its neighbours* in
 * one frame, and the question needs both.
 *
 * A run is one arc, open at both ends, and the boundary carries on past them
 * into a run belonging to some other polygon. Asked of the runs alone, an end
 * has nothing to compare against and its vertical stands by default — a line
 * down the middle of a flat wall wherever two rooms abut, which is the ordinary
 * way to author a level here. Asked of *all* the runs, it comes out right, but
 * only for the caller that holds all of them: `worldset` does and the bake does
 * not, because the bake cuts a track per polygon and that is what makes it
 * cheap. Two callers with two answers is a vertical that appears for the length
 * of a transition and goes away again — see the header of `walls.ts`, where the
 * two must draw the same walls or the crossing between them flickers.
 *
 * Both of them call this, with the same subject and the same neighbourhood, so
 * both get the same answer.
 *
 * How
 * ---
 * By asking which directions the boundary leaves a point in. Exactly two, at
 * exactly 180 degrees, is the boundary running straight through; anything else
 * — one, three, a hairpin doubling back — is a corner and keeps its vertical.
 *
 * Every edge lying on the point offers a direction, and which of them the
 * boundary actually goes is decided by the wedges between them: sort them round
 * the point, ask whether the set fills the middle of each wedge, and a direction
 * is on the boundary exactly when the two wedges it separates disagree. Which is
 * the same rule `arranged` classifies a piece by, asked at a point where several
 * pieces meet rather than along one.
 *
 * By the wedge rather than by stepping along each direction and looking to
 * either side of it, which is what this did first and got wrong. Two edges can
 * meet at a very shallow angle — eight degrees, in the case that found it — and
 * a step to either side of one of them then lands on either side of the *other*,
 * so the two samples disagree about a boundary that has nothing to do with the
 * direction being asked about. Every buried wall crossing a real one at a
 * glancing angle came back a corner. A wedge has no such trouble: its sample is
 * in the middle of it and is therefore as far from every edge as the geometry
 * allows.
 *
 * What it costs
 * -------------
 * Nothing at all along a run. A point that nothing else lies on has only the
 * two directions the run itself gave it, and those are boundary by
 * construction, so the answer is whether they are opposite and no classifying
 * is done. Only a junction is sampled, and there are few of those.
 */
function cornering(
  runs: readonly Point[][],
  segs: readonly Seg[],
  on: readonly ((p: Point) => boolean)[],
  rule: Rule,
  snap: number,
): boolean[][] {
  if (runs.length === 0) return [];

  // `snap` was scaled off the input the same way, so this recovers it.
  const scale = snap / 1e-9;
  const weld = welder(snap);
  const where = new Array<boolean>(on.length);

  /** `d` added to `into` unless something already points that way, keeping
   * whichever of the two has less edge to go. */
  const add = (into: Way[], d: Point, reach: number) => {
    const same = into.find(w => alike(w.d, d));

    if (same === undefined) into.push({ d, reach });
    else same.reach = Math.min(same.reach, reach);
  };

  const away = (from: Point, to: Point): Way | null => {
    const dx = to.x - from.x, dy = to.y - from.y;
    const l = Math.hypot(dx, dy);

    return l <= snap ? null : { d: { x: dx / l, y: dy / l }, reach: l };
  };

  // Where the boundary is already known to go, by welded point: along the runs
  // themselves, which are boundary because `arranged` kept them. Gathered over
  // every run before any of them is answered, so that a ring handed back with
  // its first point repeated at the last has both copies' neighbours under the
  // one key, and both copies therefore answer alike.
  const known = new Map<number, Way[]>();
  const ids = runs.map(run => run.map(p => weld.id(p)));

  ids.forEach((run, r) => run.forEach((id, i) => {
    const at = known.get(id) ?? [];

    for (const j of [i - 1, i + 1]) {
      const q = runs[r][j];
      const w = q === undefined ? null : away(runs[r][i], q);

      if (w !== null) add(at, w.d, w.reach);
    }

    known.set(id, at);
  }));

  // Everything the neighbourhood could put on a point, found by where it is.
  // The boxes are grown by `snap` because a neighbour's edge only has to come
  // within that of a point to be lying on it.
  const tree = pack(boxesOf(segs, snap));
  const near: number[] = [];

  const answered = new Map<number, boolean>();

  const at = (id: number, p: Point): boolean => {
    const held = answered.get(id);
    if (held !== undefined) return held;

    const mine = known.get(id) ?? [];
    const ways: Way[] = mine.map(w => ({ ...w }));

    // In index order: two edges pointing all but the same way are one way, and
    // which of them it keeps should not depend on how the tree fell.
    near.length = 0;
    eachPacked(tree, p.x, p.y, p.x, p.y, i => near.push(i));
    near.sort((x, y) => x - y);

    for (const i of near) {
      const s = segs[i];
      const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y;
      const l = Math.hypot(dx, dy);

      if (l === 0) continue;

      const ux = dx / l, uy = dy / l;
      const t = (p.x - s.a.x) * ux + (p.y - s.a.y) * uy;

      // Off the end of it, or off to one side: not an edge lying on this point.
      if (t < -snap || t > l + snap) continue;
      if (Math.abs((p.x - s.a.x) * uy - (p.y - s.a.y) * ux) > snap) continue;

      // One direction for each way there is still edge to go — and only for
      // those. An edge that ends on this point offers nothing in the direction
      // it came from, and a direction with no length is not one.
      if (l - t > snap) add(ways, { x: ux, y: uy }, l - t);
      if (t > snap) add(ways, { x: -ux, y: -uy }, t);
    }

    // Nothing lies on it but the run itself, so there is nothing to classify:
    // the two directions it came with are the boundary, and the only question
    // left is whether they are opposite.
    const out = ways.length === mine.length ? mine : boundaryWays(p, ways);
    const turns = out.length !== 2 || !opposed(out[0].d, out[1].d);

    answered.set(id, turns);

    return turns;
  };

  /** Which of the directions at `p` the boundary actually goes, by the wedges
   * between them. */
  function boundaryWays(p: Point, ways: Way[]): Way[] {
    const step = Math.min(scale * 1e-7, ...ways.map(w => w.reach * 0.25));

    if (!(step > 0)) return ways;

    const round = [...ways].sort((u, v) =>
      Math.atan2(u.d.y, u.d.x) - Math.atan2(v.d.y, v.d.x));

    // Whether the set fills the wedge that starts at each direction and runs
    // round to the next, sampled in the middle of it — which is as far from
    // every edge lying on `p` as there is room to be.
    const fills = round.map((w, k) => {
      const next = round[(k + 1) % round.length];

      const a = Math.atan2(w.d.y, w.d.x);
      const b = Math.atan2(next.d.y, next.d.x);

      // Round to the next one the way the sort went, which for the last of them
      // is round the back. One direction on its own sweeps the whole circle.
      const across = round.length === 1 ? 2 * Math.PI : turned(b - a);
      const mid = a + across / 2;

      const s = { x: p.x + Math.cos(mid) * step, y: p.y + Math.sin(mid) * step };

      return reading(on, rule, where, s);
    });

    // A direction separates two wedges, and is on the boundary exactly when
    // they disagree about which side of it is the set. One direction on its own
    // separates nothing: the wedge before it and the wedge after it are the
    // same wedge, and it is not a boundary however it got here.
    return round.filter((_unused, k) =>
      fills[(k - 1 + fills.length) % fills.length] !== fills[k]);
  }

  return ids.map((run, r) => run.map((id, i) => at(id, runs[r][i])));
}

/**
 * Segments chained end to end into the longest runs they make, without closing
 * them. Where a run does close on itself the loop is returned with its first
 * point repeated at the end, so that every edge is present either way.
 */
function runs(segs: Seg[], snap: number): { points: Point[], tags: Tag[] }[] {
  const weld = welder(snap);
  const next = new Map<number, number[]>();
  const incoming = new Map<number, number>();

  segs.forEach((s, i) => {
    const from = weld.id(s.a), to = weld.id(s.b);

    (next.get(from) ?? next.set(from, []).get(from)!).push(i);
    incoming.set(to, (incoming.get(to) ?? 0) + 1);
  });

  const used = segs.map(() => false);
  const out: { points: Point[], tags: Tag[] }[] = [];

  const walk = (start: number) => {
    const points: Point[] = [segs[start].a];
    const tags: Tag[] = [segs[start].ta];
    let e = start;

    while (true) {
      used[e] = true;
      points.push(segs[e].b);
      tags.push(segs[e].tb);

      const on = next.get(weld.id(segs[e].b));
      const step = on?.find(i => !used[i]);

      // A junction where several runs meet is where this one ends: which of
      // them carries on is a question about the whole outline, not about this
      // polygon, and nothing here needs the answer.
      if (step === undefined || (on !== undefined && on.length > 1)) break;

      e = step;
    }

    out.push({ points, tags });
  };

  // Open runs first, from their loose ends, so a run is never entered halfway.
  segs.forEach((s, i) => {
    if (!used[i] && (incoming.get(weld.id(s.a)) ?? 0) === 0) walk(i);
  });

  segs.forEach((_s, i) => {
    if (!used[i]) walk(i);
  });

  return out;
}

/** Points meant to be one point, made one point. See `welder`. */
interface Welder {
  /** Which point this is, joining anything already standing within `snap`. */
  id: (p: Point) => number
  /** The representative of each, by that id. */
  at: Point[]
}

/**
 * The same place, arrived at by different arithmetic, given one identity.
 *
 * Two edges crossing used to be the whole of this: the crossing was worked out
 * once as the split of each of them and the two answers differed in their last
 * bits. That one is gone — `intersectInto` now works the point out once and
 * hands the same one to both — and what is left is the case no sharing reaches.
 * Three edges through a point make three pairwise crossings, each solved from a
 * different pair, and they are the same place computed three ways. Nothing short
 * of exact arithmetic makes those the same numbers.
 *
 * A grid on its own is very nearly enough and fails exactly when a pair straddles
 * a cell boundary: then one point becomes two, a ring cannot be stitched through
 * it, and out comes the outline with a corner missing or nothing at all. Nor is
 * that the rare accident it looks — a boundary sits at a half, and the
 * coordinates this editor deals in divide into the cell size exactly and land on
 * one, where a single ulp decides the side.
 *
 * So the cell is where to look rather than the answer: a point takes the identity
 * of anything already standing within `snap` of it, and starts a new one only
 * where there is nothing to join. Only a point near a wall can have a twin on the
 * far side of it, so only that one pays to look, and the common path stays at the
 * single lookup it always was.
 *
 * How much room `snap` leaves here is now enormous and deliberately unspent. The
 * widest gap it has ever been measured bridging is a ten-millionth of it, across
 * a quarter of a million welds of input chosen to be as awkward as possible, and
 * the whole suite still passes with it divided by a million. It stopped being a
 * tuning parameter when `touching` moved the decision it used to arbitrate up to
 * the cut, where there is something to be done about it.
 */
function welder(snap: number): Welder {
  // Keyed by a hash of the cell rather than by its name written out, which is
  // what this spent most of its time doing: a weld is asked about every end of
  // every segment of every arrangement. Cells that share a hash share a list,
  // so each point also remembers its own cell and a lookup reads only those.
  const cells = new Map<number, number[]>();
  const at: Point[] = [];
  const inX: number[] = [], inY: number[] = [];

  const hash = (cx: number, cy: number) => Math.imul(cx | 0, 0x9e3779b1) ^ (cy | 0);

  const look = (cx: number, cy: number, p: Point): number | null => {
    const here = cells.get(hash(cx, cy));

    if (here === undefined) return null;

    for (const i of here) {
      if (inX[i] !== cx || inY[i] !== cy) continue;
      if (Math.abs(at[i].x - p.x) <= snap && Math.abs(at[i].y - p.y) <= snap) return i;
    }

    return null;
  };

  return {
    at,

    id: p => {
      const fx = p.x / snap, fy = p.y / snap;
      const cx = Math.round(fx), cy = Math.round(fy);
      const ex = edge(fx - cx), ey = edge(fy - cy);

      const found = look(cx, cy, p)
        ?? (ex === 0 ? null : look(cx + ex, cy, p))
        ?? (ey === 0 ? null : look(cx, cy + ey, p))
        ?? (ex === 0 || ey === 0 ? null : look(cx + ex, cy + ey, p));

      if (found !== null) return found;

      const key = hash(cx, cy);
      const here = cells.get(key);
      const i = at.length;

      at.push(p);
      inX.push(cx);
      inY.push(cy);

      if (here === undefined) {
        cells.set(key, [i]);
      }
      else {
        here.push(i);
      }

      return i;
    },
  };
}

/**
 * Which way the cell next door lies, for a coordinate close enough to the wall
 * that its own last bits could have put it on the wrong side, and zero for one
 * sitting safely inside.
 *
 * The doubt in a coordinate is a part in about ten million of a cell, `snap`
 * being that much larger than the last bit of the numbers it is scaled from.
 * This allows three orders of magnitude more than that, and still sends all but
 * a few points in ten thousand straight down the single-cell path.
 */
function edge(off: number): number {
  const EDGE = 1e-4;

  return off > 0.5 - EDGE ? 1 : off < EDGE - 0.5 ? -1 : 0;
}

/**
 * Kept segments back into rings. Where more than two edges meet, the successor
 * is the sharpest left turn available: with the interior on the left, hugging
 * it traces each face separately instead of driving straight through the
 * crossing and coming back out as one self-intersecting loop.
 */
function chain(segs: Seg[], snap: number): TaggedShape {
  const weld = welder(snap);
  const nodes = weld.at;
  const tags: Tag[] = [];

  const node = (p: Point, tag: Tag): number => {
    const i = weld.id(p);

    tags[i] = i < tags.length ? betterTag(tags[i], tag) : tag;

    return i;
  };

  const from = segs.map(s => node(s.a, s.ta));
  const to = segs.map(s => node(s.b, s.tb));

  const out: number[][] = nodes.map(() => []);
  segs.forEach((_s, i) => out[from[i]].push(i));

  const used = segs.map(() => false);
  const rings: Ring[] = [];
  const ringTags: Tag[][] = [];

  for (let start = 0; start < segs.length; start++) {
    if (used[start]) continue;

    const ring: Ring = [];
    const ringTag: Tag[] = [];
    let e = start;

    while (true) {
      used[e] = true;
      ring.push(nodes[from[e]]);
      ringTag.push(tags[from[e]]);

      const at = to[e];
      if (at === from[start] && ring.length > 1) break;

      const next = successor(e, at, out, used, nodes, from, to);
      if (next < 0) break;

      e = next;
    }

    if (ring.length >= 3 && Math.abs(signedArea2(ring)) > snap * snap) {
      const kept = cornersOnly(ring, ringTag, snap);

      if (kept !== null) {
        rings.push(kept.ring);
        ringTags.push(kept.tags);
      }
    }
  }

  return { rings, tags: ringTags };
}

/**
 * The ring without the vertices it does not turn at.
 *
 * An arrangement puts a vertex wherever two of its input segments met, and
 * plenty of those meetings are along a straight line rather than at a corner.
 * `erode` is the worst of it: the band it subtracts is one quad per edge and
 * one mitred wedge per corner, and where a quad meets its wedge the boundary
 * carries straight on. A dilated rectangle came out with twelve vertices, eight
 * of which were not corners; an eroded reflex corner came out with two. Convex
 * corners under erosion skip the wedge, which is why a plain shrinking box
 * never showed it.
 *
 * Nothing wants them. They are extra segments for every later boolean to split
 * against, extra points for the bake to carry at both ends of every stretch,
 * and — the reason this was noticed — a wall draws a vertical line at every
 * point of its outline, so each one stood a line up in the middle of a flat
 * wall.
 *
 * A ring that says it turns where it does not is wrong at the source, so this
 * is where it is put right rather than in whichever reader was bothered. What
 * the bake needs kept in spite of this, it asks for by name: see `keeping`.
 *
 * `null` where nothing is left worth having — three collinear points enclose no
 * area, and taking their middles out leaves something that is not a ring.
 */
function cornersOnly(
  ring: Ring,
  tags: Tag[],
  snap: number,
): { ring: Ring, tags: Tag[] } | null {
  const n = ring.length;

  const turns = (i: number): boolean => {
    const a = ring[(i - 1 + n) % n], b = ring[i], c = ring[(i + 1) % n];
    const ux = b.x - a.x, uy = b.y - a.y;
    const vx = c.x - b.x, vy = c.y - b.y;

    // Against the longer of the two, so this is a distance off the line rather
    // than an area, and is comparable with the arrangement's own tolerance.
    const reach = Math.max(Math.hypot(ux, uy), Math.hypot(vx, vy));

    return reach > 0 && Math.abs(ux * vy - uy * vx) / reach > snap;
  };

  const keep: number[] = [];

  for (let i = 0; i < n; i++) {
    if (turns(i)) keep.push(i);
  }

  if (keep.length === n) return { ring, tags };
  if (keep.length < 3) return null;

  return { ring: keep.map(i => ring[i]), tags: keep.map(i => tags[i]) };
}


function successor(
  e: number,
  at: number,
  out: number[][],
  used: boolean[],
  nodes: Point[],
  from: number[],
  to: number[],
): number {
  const candidates = out[at].filter(i => !used[i]);
  if (candidates.length === 0) return -1;
  if (candidates.length === 1) return candidates[0];

  const back = angleOf(nodes[to[e]], nodes[from[e]]);

  let best = -1, bestTurn = -Infinity;

  for (const i of candidates) {
    const turn = norm(angleOf(nodes[from[i]], nodes[to[i]]) - back);
    if (turn > bestTurn) {
      bestTurn = turn;
      best = i;
    }
  }

  return best;
}

function angleOf(a: Point, b: Point): number {
  return Math.atan2(b.y - a.y, b.x - a.x);
}

/** Into [0, 2π), so that turning straight back the way we came scores 0 and is
 * only ever taken when there is nothing else. */
function norm(t: number): number {
  let x = t;
  while (x < 0) x += Math.PI * 2;
  while (x >= Math.PI * 2) x -= Math.PI * 2;

  return x;
}

// -----------------------------------------------------------------------------
// Effects: deform and round
//
// A deform happens to a thing's rings before anything else does: each edge is
// subdivided and its new corners pushed off it in a pattern, as though they
// had been drawn by hand (`subdivided`). From there they are corners like any
// other — eroded and carried by the bake — so they appear, go and move the
// way corners do, and the machinery for that is the one already there.
//
// A polygon's round is drawn next, before the erosion: each drawn corner
// becomes a curve leaving each of its two edges along it and with no
// curvature, so it runs into them with no seam (`outlineOf`, `arcs`, and see
// `Curve`). The teeth along an edge stop short of it (`patternRun`'s
// `clear`), and the deform lays teeth of its own along the curve, as it lays
// them along an edge: pushing the curve off itself between them, so that a
// tooth sliding along it as the bevel changes goes past its points without a
// jump. Then the erosion takes the lot, as it would take corners drawn by
// hand. A round's amount is its bevel: how deep from the corner, along each
// edge, its curve starts — the same at any angle, so a sharp corner and a
// blunt one are cut back alike — and, held, the depth on top of that, so
// that what the erosion leaves is the bevel asked for (`drawnBevels` in
// `scene/core.ts`). It is faceted where it bends: see `spread`.
//
// A group's round is still laid after its erosion, on its union, so the
// joins between its rooms are not rounded, and it leaves its members' teeth
// square (`imaged`, `effectedSquare`).
//
// A rounded corner is always `n + 1` points, whatever its bevel, nought
// included, and in the thing's own frame every point is linear in the bevel:
// each is the corner plus multiples of it along its two edge directions, the
// multiples of the corner's angle alone. A corner running straight through
// never collapses: its arc is a sliver of a run along its wall, which lies on
// an edge whatever the edges beside it do, so `keeping` can always put it
// back.
// -----------------------------------------------------------------------------

/** How a deformed edge is pushed: sharp teeth, a wave, or seeded noise. */
export type Pattern = 'zigzag' | 'sine' | 'noise';

/** Which way off its line: out of the material, into it, or both. */
export type Sides = 'in' | 'out' | 'both';

/**
 * The effects on a boundary, for the geometry: how many points each makes,
 * and how a deform goes. The amounts are asked for per corner and per edge.
 */
export interface Effecting {
  /** How far apart a deformed edge's teeth are, as a length in the world —
   * see `patternRun`. Nought where edges are not deformed. */
  spacing: number
  pattern: Pattern
  seed: number
  sides: Sides
  /** How far the gaps between teeth may stray from the spacing: at one a gap
   * is anywhere from a `GAPS`th of the spacing to `GAPS` times it, evenly on a
   * log scale, at two the square of that, and at nought every gap is the
   * spacing.
   * A gap is never nothing, so no two teeth pass each other. */
  jitter: number
  /** How far along an arc a tooth's flanks run before they meet the curve,
   * either side of it, as a share of the spacing — never less than
   * `NARROWEST`: see `arcsWith`. Small, a tooth is a spike standing on the
   * curve; at one, each flank runs to the next tooth, as an edge's do. */
  falloff: number
  /** Whether each edge's teeth start off its middle by a share of the
   * spacing its seed gives it, rather than at it: see `patternRun`. */
  offset: boolean
}

/** The falloff a deform starts with: spikes on the curve. */
export const FALLOFF = 0.15;

/** The narrowest a tooth on an arc stands, as a share of the spacing. A
 * tooth any narrower is all but a hairpin, whose two flanks an erosion takes
 * off towards infinity, and flips over as it tips past straight. */
export const NARROWEST = 0.05;

/**
 * The largest distance between any two of `points`: the size a deform is
 * measured against, since it is the same however the points are turned.
 * Nought for fewer than two.
 *
 * Over the convex hull, which is where the two farthest points are, so that
 * a group of many rooms costs its outline rather than every pair.
 */
export function diameter(points: readonly Point[]): number {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const turn = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const half = (from: Point[]): Point[] => {
    const out: Point[] = [];

    for (const p of from) {
      while (out.length >= 2 && turn(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }

    return out;
  };
  const hull = [...half(sorted), ...half([...sorted].reverse())];
  let most = 0;

  for (let i = 0; i < hull.length; i++) {
    for (let j = i + 1; j < hull.length; j++) {
      most = Math.max(most, Math.hypot(hull[j].x - hull[i].x, hull[j].y - hull[i].y));
    }
  }

  return most;
}

/** The most a jitter stretches a gap by, or squeezes it by: see
 * `Effecting.jitter`. */
export const GAPS = 4;

/** No effects at all: every corner a point and every edge straight. */
export const PLAIN: Effecting = { spacing: 0, pattern: 'zigzag', seed: 0, sides: 'both', jitter: 0, falloff: FALLOFF, offset: false };

/** An edge's teeth: each a fraction of the way along it, a distance off it
 * out of the material where positive, and which tooth it is, counted from
 * the middle of the edge. */
export interface EdgeRun {
  along: readonly number[]
  across: readonly number[]
  teeth: readonly number[]
}

/**
 * An edge's teeth as the pattern lays them along an edge of `length`: a tooth
 * every `spacing` out from its middle, as far as the edge goes either way,
 * each off it by `amplitude` of the pattern.
 *
 * A tooth near an end of the edge is only as tall as it has room to be: one
 * spacing from the end and nearer, it shrinks with the distance, and at the
 * end it is nothing. So the pattern is continuous in where the edge's ends
 * are. An edge growing gains teeth at its ends out of nothing, and shrinking
 * loses them into nothing; none of the others moves off the spacing, and the
 * pattern is about as dense on every edge. Tooth `j` is the same tooth
 * however long the edge is.
 *
 * With a jitter, each gap is the spacing stretched or squeezed by the seed
 * (see `Effecting.jitter`), and a tooth is where the gaps between it and the
 * middle add up to. Its gaps are its own and so is its place, the same however
 * long the edge is, so the pattern stays continuous. With none, every gap is
 * the spacing.
 *
 * `clear` and `clearTo` are how much of each end is kept free of teeth, for
 * the round of the corner there: a tooth inside a bevel would be a corner the
 * bevel cannot reach past, and would cut it down to the tooth. The teeth
 * shrink to nothing at that line as they do at an end, and stay where the
 * spacing puts them, so they are continuous in the bevel too.
 */
export function patternRun(e: Effecting, key: number, amplitude: number, length: number, clear = 0, clearTo = 0, ramp = e.spacing): EdgeRun {
  // From the middle — or, offset, off it by a share of the spacing the seed
  // gives the edge: so no tooth is sure to stand in the middle of every edge,
  // and one shorter than the spacing may have none.
  const anchor = length / 2 + (e.offset ? (hashed(e.seed, key ^ OFFSET, 0) - 0.5) * e.spacing : 0);
  const along: number[] = [], across: number[] = [], teeth: number[] = [];

  if (!(e.spacing > 0) || !(length > 0)) return { along, across, teeth };

  // Tooth `j`'s gap is the one between it and its neighbour towards the
  // middle, so the middle tooth has none.
  const gap = (j: number): number => e.spacing * Math.pow(GAPS, e.jitter * (2 * hashed(e.seed, ~key, j) - 1));
  const next = (j: number, at: number): number => at + Math.sign(j) * gap(j);

  // Outward from the middle both ways, as far as the edge goes, then laid
  // end to end in order along it.
  const before: [number, number][] = [], after: [number, number][] = [];

  for (let j = 0, at = anchor; at <= length; j++, at = next(j, at)) after.push([j, at]);
  for (let j = -1, at = next(-1, anchor); at >= 0; j--, at = next(j, at)) before.push([j, at]);

  const places = [...before.reverse(), ...after];

  for (const [j, at] of places) {
    // Clear of the arcs either end, where the edge has a straight for it to
    // stand on, and laid flat where the ramp has taken it to nothing rather
    // than left off: a tooth that is there and flat draws no line, and its
    // line comes up as it rises. Outside the straight there is nowhere for
    // it to be at all.
    if (at <= clear || at >= length - clearTo) continue;

    const room = Math.min(1, Math.min(at - clear, length - clearTo - at) / ramp);

    along.push(at / length);
    across.push(amplitude * Math.max(0, room) * patterned(e, key, j));
    teeth.push(j);
  }

  return { along, across, teeth };
}

/**
 * How far off its line tooth `j` of an edge is pushed, as a fraction of the
 * amplitude: out of the material where it is positive.
 *
 * `j` counts out from the middle of the edge, either way. `key` is the edge's
 * own, so that noise belongs to the edge rather than to wherever it is in the
 * ring today.
 */
export function patterned(e: Effecting, key: number, j: number): number {
  let v: number;

  switch (e.pattern) {
    case 'zigzag':
      v = j % 2 === 0 ? 1 : -1;
      break;
    case 'sine':
      // Six to a wave, and none on a zero: three points about a zero crossing
      // of anything so even are in a line, and the arrangement would drop the
      // middle one.
      v = Math.cos(Math.PI * j / 3);
      break;
    case 'noise':
      v = hashed(e.seed, key, j) * 2 - 1;
      break;
  }

  // One way only, the pattern is lifted off the line rather than folded onto
  // it: a zigzag stays teeth, which folded it would not.
  if (e.sides === 'out') return (1 + v) / 2;
  if (e.sides === 'in') return -(1 + v) / 2;

  return v;
}

/** What an edge's key is told apart by, for its offset: see `patternRun`. */
const OFFSET = 0x2545f491;

/** Three integers to a number in [0, 1), the same every time. */
function hashed(a: number, b: number, c: number): number {
  let h = 0x9e3779b9 ^ Math.imul(a | 0, 0x85ebca6b);

  h = Math.imul(h ^ (b | 0), 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h ^ (c | 0), 0x27d4eb2f);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;

  return (h >>> 0) / 4294967296;
}

/**
 * One corner of a ring a deform has been through: an input corner (`j` is
 * null), or tooth `j` of the edge starting at input corner `from`.
 */
export interface Subdivision {
  at: Point
  from: number
  j: number | null
  /** How far along its edge, as a fraction: nought for an input corner. */
  along: number
}

/**
 * A ring with its edges subdivided and perturbed, before anything else is
 * done to it: as though its teeth had been drawn by hand. Each edge gets a
 * tooth every `e.spacing` out from its middle, off it by `amplitude(i)` of the
 * pattern, and the teeth are corners like any other from here on — eroded,
 * rounded, and carried by the bake — so they appear, go and move as corners
 * do. See `patternRun` for how they are laid and why they are continuous in
 * where the edge's ends are.
 *
 * `out` is which side of the ring's edges is out of the material: 1 for the
 * right, which a counter-clockwise outline has, and -1 for the left. `key`
 * names each edge to the noise. `clear` is how far from each corner its round
 * keeps the teeth: see `patternRun`. An edge that is not `toothed` is left
 * as it is.
 */
export function subdivided(
  ring: Ring,
  e: Effecting,
  amplitude: (i: number) => number,
  key: (i: number) => number,
  out: 1 | -1,
  clear: (i: number) => number = () => 0,
  toothed: (i: number) => boolean = () => true,
): Subdivision[] {
  const n = ring.length;
  const done: Subdivision[] = [];

  ring.forEach((a, i) => {
    done.push({ at: a, from: i, j: null, along: 0 });

    const b = ring[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy);

    if (l === 0 || !toothed(i)) return;

    const nx = dy / l * out, ny = -dx / l * out;
    const run = patternRun(e, key(i), amplitude(i), l, clear(i), clear((i + 1) % n));

    run.along.forEach((u, k) => done.push({
      at: { x: a.x + dx * u + nx * run.across[k], y: a.y + dy * u + ny * run.across[k] },
      from: i,
      j: run.teeth[k],
      along: u,
    }));
  });

  return done;
}

/**
 * The shape with each of `points` present as a vertex, splitting whatever edge
 * it lies on.
 *
 * The exception `cornersOnly` leaves room for. A point of a drawn outline
 * that the outline runs straight through — a tooth laid flat, a corner
 * standing in its wall — is not a corner and would be dropped, and then it
 * would not be there for a span to turn it. Kept, it is a point that draws
 * no line, and the line comes up as it starts to turn: see `flatOf`.
 *
 * Asked for by position, off the same instant's own geometry, so nothing is
 * carried from one instant to another. Anything that does not land on an
 * edge is not put anywhere: an eroded ring that has swallowed the edge a
 * point sat on genuinely does not have it.
 */
export function keeping(shape: Shape, points: readonly Point[]): Shape {
  if (points.length === 0) return shape;

  // The same tolerance the arrangement works to, taken off the same geometry.
  let scale = 1;

  for (const ring of shape) {
    for (const p of ring) scale = Math.max(scale, Math.abs(p.x), Math.abs(p.y));
  }

  const snap = scale * 1e-9;
  const out = shape.map(ring => [...ring]);

  for (const p of points) {
    let best: { ring: number, index: number, off: number } | null = null;

    for (let r = 0; r < out.length; r++) {
      const ring = out[r];

      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const dx = b.x - a.x, dy = b.y - a.y;
        const l = Math.hypot(dx, dy);

        if (l === 0) continue;

        const off = Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / l;
        const along = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l;

        if (along <= snap || along >= l - snap) continue;
        if (best === null || off < best.off) best = { ring: r, index: i, off };
      }
    }

    if (best !== null && best.off <= snap) out[best.ring].splice(best.index + 1, 0, p);
  }

  return out;
}

/**
 * How a corner's arc is faceted: in `n` segments, `n + 1` points. `n` of
 * nought is a corner not rounded. `tension` is the curve's: see `curveOf`.
 */
export interface Facets {
  n: number
  tension: number
}

/** The tension a round starts with. See `curveOf`. */
export const TENSION = 0.5;

/** A corner rounded in `n` segments, standing still. */
export function facetsOf(n: number, tension = TENSION): Facets {
  return { n, tension };
}

/** A corner not rounded. */
export const SQUARE: Facets = facetsOf(0);

/**
 * The curve a corner is rounded along, for a corner at the origin whose edges
 * leave it along `a` and `b` and a bevel of one: `a · A(u) + b · B(u)`, `u`
 * from nought at the tangent point on `a` to one at the one on `b`.
 *
 * A quintic Bézier whose first three control points lie along `a` — at one,
 * `near` and `inner` of the bevel from the corner — and whose last three
 * mirror them along `b`. Three in a line at each end is what makes it leave
 * each edge not only along it but with no curvature at all, so the edge runs
 * into it with no seam to be seen, where a circle's curvature jumps from
 * nothing to all of it at the tangent point. It bends least at its ends and
 * most in its middle, and that is where `spread` puts its points.
 *
 * How far in the two stand is its tension (see `TENSION`): at nought they
 * are out along the edges, and the curve bends about as evenly as a circle;
 * at one they are pulled into the corner, and it runs straight off its edges
 * and turns hard in its middle.
 *
 * `A` and `B` are of `u` alone, not of the corner, so every point of it is
 * the bevel times something of the corner's angle: linear in the bevel.
 */
interface Curve {
  alongA: number[]
  alongB: number[]
  /** At each of the samples: both weights' first and second derivatives,
   * which are all the curvature needs and are the same at every corner. */
  sampled: { a1: number, b1: number, a2: number, b2: number }[]
  /** How far a bevel of one in one segment can be off it: see `sagging`. */
  sagging: number
}

const curves = new Map<number, Curve>();

/** The curve at a tension, worked out once for each. */
function curveOf(tension: number): Curve {
  const known = curves.get(tension);

  if (known !== undefined) return known;

  const t = Math.min(1, Math.max(0, tension));
  const near = 0.7 - 0.3 * t, inner = 0.45 * (1 - t);
  const alongA = [1, near, inner, 0, 0, 0];
  const alongB = [0, 0, 0, inner, near, 1];

  const sampled = Array.from({ length: SAMPLES + 1 }, (_s, k) => {
    const u = k / SAMPLES;

    return {
      a1: bezier(differenced(alongA), u),
      b1: bezier(differenced(alongB), u),
      a2: bezier(differenced(differenced(alongA)), u),
      b2: bezier(differenced(differenced(alongB)), u),
    };
  });

  const partial = { alongA, alongB, sampled, sagging: 0 };
  const curve = { ...partial, sagging: sagging(partial) };

  curves.set(tension, curve);

  return curve;
}

/** A one-dimensional Bézier of `c`'s control values at `u`. */
function bezier(c: readonly number[], u: number): number {
  const d = c.length - 1;
  let out = 0;

  for (let k = 0; k <= d; k++) out += c[k] * binomial(d, k) * Math.pow(u, k) * Math.pow(1 - u, d - k);

  return out;
}

function binomial(n: number, k: number): number {
  let out = 1;

  for (let i = 1; i <= k; i++) out = out * (n - k + i) / i;

  return out;
}

/** A Bézier's control values differenced: its derivative's, over `d`. */
function differenced(c: readonly number[]): number[] {
  return c.slice(1).map((x, k) => (x - c[k]) * (c.length - 1));
}

/** How finely `spread` reads the curve. */
const SAMPLES = 48;

/**
 * How much each sample of the curve counts, for a corner whose edges' ways
 * out meet at a cosine of `c`: `√κ · |C′|`, less the `√(sin θ)` every sample
 * has alike. A facet over a stretch where that adds to `e` is off the curve
 * by about `e² / 8`, so points laid where it adds up evenly are off by the
 * same everywhere: close where the curve bends, far apart where it does not.
 */
function weights(curve: Curve, c: number): number[] {
  return curve.sampled.map(({ a1, b1, a2, b2 }) => {
    const speed = Math.sqrt(Math.max(0, a1 * a1 + b1 * b1 + 2 * a1 * b1 * c));

    return Math.sqrt(Math.abs(a1 * b2 - b1 * a2) / Math.max(speed, 1e-12));
  });
}

/** The weights added up along the curve, from nought. */
function added(w: readonly number[]): number[] {
  const out = [0];

  for (let k = 1; k < w.length; k++) out.push(out[k - 1] + (w[k - 1] + w[k]) / 2 / SAMPLES);

  return out;
}

/**
 * Where on the curve `s` segments turn, for a corner whose ways out meet at a
 * cosine of `c`: `s + 1` values of `u`, from nought to one, spread evenly by
 * `weights`. Of the corner's angle alone — so the points are still linear in
 * the bevel — and continuous in it, a corner running straight through
 * included: every sample's `√(sin θ)` has been taken out, so what is left
 * does not vanish there. Evenly along the curve where nothing is to be read.
 */
export function spread(c: number, s: number, tension = TENSION): number[] {
  return spreadOn(curveOf(tension), c, s);
}

function spreadOn(curve: Curve, c: number, s: number): number[] {
  const sum = added(weights(curve, c));
  const total = sum[SAMPLES];

  return Array.from({ length: s + 1 }, (_q, q) => {
    if (q === 0) return 0;
    if (q === s) return 1;
    if (!(total > 1e-12)) return q / s;

    const want = total * q / s;
    let k = 0;

    while (k < SAMPLES - 1 && sum[k + 1] < want) k++;

    const f = (want - sum[k]) / Math.max(sum[k + 1] - sum[k], 1e-300);

    return (k + Math.min(1, Math.max(0, f))) / SAMPLES;
  });
}

/**
 * How far a bevel of one in one segment can be off its curve, whatever the
 * corner's angle, such that `k` segments are off by that over `k²` at most.
 *
 * Measured rather than worked out: the facets `spread` lays, held against the
 * curve read finely, over a spread of angles and of counts, the worst of each
 * taken times its count squared. `e² / 8` over `weights` is what that comes
 * to for many short facets, and is why the square; a few long ones sag a
 * little more than it says, which is why it is measured. With a twentieth
 * over, for the angles between the ones measured.
 */
function sagging(curve: Curve): number {
  const FINE = 256;
  let worst = 0;

  for (let d = 1; d < 90; d++) {
    const theta = Math.PI * d / 90;
    const c = Math.cos(theta), s = Math.sin(theta);
    const at = (u: number): Point => {
      const p = bezier(curve.alongA, u), q = bezier(curve.alongB, u);

      return { x: p + c * q, y: s * q };
    };
    const fine = Array.from({ length: FINE + 1 }, (_f, f) => at(f / FINE));

    for (const k of [1, 2, 3, 4, 6, 8, 12]) {
      const facets = spreadOn(curve, c, k).map(at);
      let off = 0;

      for (const p of fine) off = Math.max(off, Math.min(...facets.slice(1).map((q, j) => fromSegment(p, facets[j], q))));

      worst = Math.max(worst, off * k * k);
    }
  }

  return worst * 1.05;
}

/** How far `p` is from the segment `a`–`b`. */
function fromSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const f = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));

  return Math.hypot(p.x - a.x - dx * f, p.y - a.y - dy * f);
}

/** The most segments a round is given, however fine it is asked to be. */
export const FINEST = 64;

/**
 * How many segments a bevel of `bevel` needs to lie within `precision` of
 * its curve at any angle: the fewest that do, one at the least. A length, as the
 * bevel is, so a round is as smooth to the eye wherever it is.
 *
 * Of the bevel and nothing else — not the corner's angle, nor what its
 * neighbours leave it — so that a span knows every corner's count at both
 * ends from its amounts alone. What the angle and the clamping take off the
 * arc only makes it sag less.
 */
export function segmentsFor(bevel: number, precision: number, tension = TENSION): number {
  if (!(bevel > 0) || !(precision > 0)) return 1;

  return Math.min(FINEST, Math.max(1, Math.ceil(Math.sqrt(curveOf(tension).sagging * bevel / precision))));
}

/** The precision that makes `segments` of `bevel`, and no fewer: for tests. */
export function precisionFor(segments: number, bevel: number, tension = TENSION): number {
  return curveOf(tension).sagging * bevel / (segments * segments) * (1 + 1e-9);
}

/**
 * A ring with its corners rounded: for each corner in order, the `n + 1`
 * points of its arc from the edge coming in to the edge going out, faceted
 * as `Facets` says.
 *
 * The arc is tangent to both edges, `bevel` along each from the corner, or
 * less where the corner barely turns (see `BLUNT`), and clamped to half of
 * each edge less what the neighbour takes of it — all of what is left, where
 * the neighbour wants less than half. A bevel of nought is its arc's points
 * all on the corner.
 *
 * Nothing here cares which way the ring is wound: an arc lies inside the
 * angle of its corner, which takes material off a corner that turns in and
 * adds it to one that turns out.
 */
function arcs(ring: Ring, facetsOf: (i: number) => Facets, bevel: (i: number) => number): Point[][] {
  return arcsWith(ring, facetsOf, bevel).map(a => a.arc);
}

/**
 * The teeth a deform lays along one corner's arc: as it lays them along an
 * edge (`patternRun`), over the arc's length, from its middle, each put back
 * on the curve where its length falls and pushed along the curve's own
 * normal there — not the facet's — so they follow the curve. Their height is
 * the amplitude of the edge the arc leaves, going over to the one it joins.
 * `key` names the arc to the noise.
 */
export interface ArcTeeth {
  e: Effecting
  before: number
  after: number
  key: number
  /** The arc as it is seen against the arc as it is drawn: other than one
   * where a round is held, and the erosion takes the drawn one back to the
   * seen. The teeth are laid along the arc as seen, and carried onto the
   * drawn one where they fall on its curve, so the erosion growing the drawn
   * arc does not slide them along it. Never more than one: an arc drawn
   * shorter than it is seen — down to nought, eroded out of the material —
   * keeps the teeth its own length has, rather than the seen arc's crammed
   * into it. See `drawnBevels`. */
  seen: number
}

/**
 * One corner's arc as `arcsWith` lays it: `arc` is its `n + 1` points, pushed
 * off the curve with the teeth either side of each, `all` the same with the
 * teeth among them in order along the curve, and `arcAt` where each of `arc`
 * is in `all`. `point` where the arc has no length, so that all its points
 * are the corner.
 */
interface ArcLaid {
  arc: Point[]
  all: Point[]
  arcAt: number[]
  /** Where in `all` the teeth are, their tips and their feet. */
  teethAt: number[]
  point: boolean
}

/** `a · x = b` for a square `a`, by elimination with partial pivoting. */
function solved(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);

  for (let c = 0; c < n; c++) {
    let p = c;

    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;

    [m[c], m[p]] = [m[p], m[c]];

    for (let r = c + 1; r < n; r++) {
      const f = m[r][c] / m[c][c];

      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }

  const x = new Array<number>(n).fill(0);

  for (let r = n - 1; r >= 0; r--) {
    let sum = m[r][n];

    for (let k = r + 1; k < n; k++) sum -= m[r][k] * x[k];

    x[r] = sum / m[r][r];
  }

  return x;
}

/** How far in, against the radius it bends at, an arc may be pushed. */
const FOLD = 0.9;

/** How finely an arc's length is read, to put its teeth back on it. */
const LENGTHS = 64;

/**
 * `arcs`, with the teeth `teeth` asks for laid along each arc. `out` is which
 * side of the ring is out of the material, as `subdivided` takes it.
 */
function arcsWith(
  ring: Ring,
  facetsOf: (i: number) => Facets,
  bevel: (i: number) => number,
  teeth: (i: number) => ArcTeeth | null = () => null,
  out: 1 | -1 = 1,
): ArcLaid[] {
  const n = ring.length;
  const lengths = ring.map((p, i) => Math.hypot(ring[(i + 1) % n].x - p.x, ring[(i + 1) % n].y - p.y));
  const unit = (from: Point, to: Point, l: number): Point | null =>
    l === 0 ? null : { x: (to.x - from.x) / l, y: (to.y - from.y) / l };

  // Each corner's two ways out, towards the corner before and the one after.
  const ways = ring.map((v, i) => ({
    a: unit(v, ring[(i - 1 + n) % n], lengths[(i - 1 + n) % n]),
    b: unit(v, ring[(i + 1) % n], lengths[i]),
  }));

  // A corner that barely turns is cut back less than its bevel, down to a
  // sliver of it where it runs straight through. A corner arriving on an edge
  // is flat as it comes, and at its whole bevel it would take room from the
  // arcs beside it the instant it appeared, and move them. A sliver rather
  // than none: its arc is then a short straight run along the wall, not all
  // of its points on one, so it keeps every one of them whatever lies beside
  // it. Still linear in the bevel.
  const wants = ring.map((_v, i) => {
    const { a, b } = ways[i];
    const d = Math.max(0, bevel(i));

    if (facetsOf(i).n === 0 || d === 0 || a === null || b === null) return 0;

    const turn = Math.PI - Math.atan2(Math.abs(a.x * b.y - a.y * b.x), a.x * b.x + a.y * b.y);

    return d * Math.max(SEEDING, Math.sin(Math.PI / 2 * Math.min(1, turn / BLUNT)));
  });

  const room = (i: number, other: number): number => lengths[i] - Math.min(wants[other], lengths[i] / 2);

  return ring.map((v, i) => withTeeth(v, i));

  function withTeeth(v: Point, i: number): ArcLaid {
    const laid = arc(v, i);
    const at = laid.points.map((_p, k) => k);
    const tt = teeth(i);

    if (laid.point || tt === null || laid.on === null) return { arc: laid.points, all: laid.points, arcAt: at, teethAt: [], point: laid.point };

    const { on, normal, bend } = laid;

    // The arc's length, read along the curve, and where along it each `u` is.
    const lengths = [0];

    for (let k = 1; k <= LENGTHS; k++) {
      const p = on((k - 1) / LENGTHS), q = on(k / LENGTHS);

      lengths.push(lengths[k - 1] + Math.hypot(q.x - p.x, q.y - p.y));
    }

    // As it is seen: the same curve, as much shorter as its bevel is.
    for (let k = 0; k <= LENGTHS; k++) lengths[k] *= tt.seen;

    const total = lengths[LENGTHS];
    const reach = Math.max(tt.e.falloff, NARROWEST) * tt.e.spacing;
    const run = patternRun(tt.e, tt.key, 1, total);

    // Where along the curve a length falls, and how far along it a `u` is.
    const uAt = (want: number): number => {
      let j = 0;

      while (j < LENGTHS - 1 && lengths[j + 1] < want) j++;

      return Math.min(1, Math.max(0, (j + (want - lengths[j]) / Math.max(lengths[j + 1] - lengths[j], 1e-300)) / LENGTHS));
    };
    const lengthAt = (u: number): number => {
      const x = Math.min(LENGTHS, Math.max(0, u * LENGTHS)), j = Math.min(LENGTHS - 1, Math.floor(x));

      return mix(lengths[j], lengths[j + 1], x - j);
    };

    // How far the arc is pushed off the curve at a length along it: each
    // tooth a triangle standing on the curve, its flanks straight down to it
    // `falloff` of the spacing either side. One function of the length for
    // the teeth and the arc's own points alike: a point of the arc near a
    // tooth is on its flank, so a tooth sliding past one as the bevel changes
    // goes past it without a jump, and its flanks never fold onto each other
    // however near one it comes. At one, the flanks run tooth to tooth.
    //
    // Each tooth's share is scaled so that the whole passes through every
    // tooth at its own height, as an edge's teeth stand at theirs, whatever
    // the teeth beside it add where their flanks overlap: the kernel's matrix
    // is positive definite, so the shares are one answer, and continuous in
    // where the teeth are.
    const teethAt = run.along.map((f, k) => ({ s: f * total, h: run.across[k] * mix(tt.before, tt.after, uAt(f * total)) }));
    const kernel = (a: number, b: number) => Math.max(0, 1 - Math.abs(a - b) / reach);
    const shares = solved(teethAt.map(p => teethAt.map(q => kernel(p.s, q.s))), teethAt.map(t => t.h));
    const heightAt = (at: number): number => teethAt.reduce((sum, t, k) => sum + shares[k] * kernel(at, t.s), 0);
    // Never pushed further in than the curve's own radius there, less a
    // little: past it the arc would fold back on itself into loops, which the
    // arrangement cannot be trusted to take the same way twice. Out, there is
    // nothing to fold. `normal` is to the right of the way round, and the
    // curve bends towards its left where `bend` is positive.
    const pushed = (u: number, h: number): Point => {
      const m = normal(u), p = on(u), k = bend(u);
      let off = h * out;

      if (k !== 0 && -Math.sign(k) * off > FOLD / Math.abs(k)) off = -Math.sign(k) * FOLD / Math.abs(k);

      return { x: p.x + m.x * off, y: p.y + m.y * off };
    };

    const along = laid.us.map(lengthAt);
    const arcPoints = laid.points.map((p, j) => (j === 0 || j === laid.points.length - 1 ? p : pushed(laid.us[j], heightAt(along[j]))));

    // Each tooth is its tip and a foot on the curve either side of it where
    // its flanks come down, and the arc's own points under a flank are left
    // out: so no point of the arc ever stands close by a tip. One that did
    // made the edge out of the tip too short to have the flank's direction,
    // and the erosion, which moves a tip along the mitre of the two edges
    // there, flipped it about as the point passed, or was welded to it, or
    // not. A point is left out as it reaches a foot, where it is the foot,
    // and a foot as it reaches another tooth's, where it is that foot: so
    // nothing jumps. A foot past the arc's ends is not laid; the flank runs
    // to the end instead.
    const under = (at: number, but = -1): boolean => teethAt.some((t, k) => k !== but && Math.abs(at - t.s) < reach);
    const laidAt: { s: number, p: Point, arc: number }[] = [];

    teethAt.forEach((t, k) => {
      laidAt.push({ s: t.s, p: pushed(uAt(t.s), heightAt(t.s)), arc: -1 });

      for (const foot of [t.s - reach, t.s + reach]) {
        if (foot > 0 && foot < total && !under(foot, k)) laidAt.push({ s: foot, p: pushed(uAt(foot), heightAt(foot)), arc: -1 });
      }
    });

    arcPoints.forEach((p, j) => {
      const end = j === 0 || j === arcPoints.length - 1;

      laidAt.push({ s: along[j], p, arc: end || !teethAt.some(t => Math.abs(along[j] - t.s) <= reach) ? j : -2 - j });
    });

    // By length, an arc's end before anything at its length and after.
    laidAt.sort((x, y) => x.s - y.s || (x.arc === 0 ? -1 : y.arc === 0 ? 1 : x.arc === arcPoints.length - 1 ? 1 : y.arc === arcPoints.length - 1 ? -1 : 0));

    const all: Point[] = [], arcAt: number[] = new Array<number>(arcPoints.length).fill(0), teethIn: number[] = [];

    for (const x of laidAt) {
      // An arc's point left out takes the place of whatever comes next.
      if (x.arc <= -2) {
        arcAt[-2 - x.arc] = all.length;
        continue;
      }

      if (x.arc >= 0) arcAt[x.arc] = all.length;

      const last = all[all.length - 1];

      if (last !== undefined && last.x === x.p.x && last.y === x.p.y) {
        if (x.arc >= 0) arcAt[x.arc] = all.length - 1;
        continue;
      }

      if (x.arc === -1) teethIn.push(all.length);

      all.push(x.p);
    }

    // One left out after the last point laid takes the last.
    arcAt.forEach((k, j) => (arcAt[j] = Math.min(k, all.length - 1)));

    return { arc: arcPoints, all, arcAt, teethAt: teethIn, point: false };
  }

  function arc(v: Point, i: number): { points: Point[], us: number[], point: boolean, on: ((u: number) => Point) | null, normal: (u: number) => Point, bend: (u: number) => number } {
    const { a, b } = ways[i];
    const before = (i - 1 + n) % n, after = (i + 1) % n;
    const t = Math.max(0, Math.min(wants[i], room(before, before), room(i, after)));
    const facets = facetsOf(i);
    const out: Point[] = [];
    const none = { x: 0, y: 0 };

    if (t === 0 || a === null || b === null) {
      for (let k = 0; k <= facets.n; k++) out.push(v);

      return { points: out, us: out.map((_p, k) => (facets.n === 0 ? 0 : k / facets.n)), point: true, on: null, normal: () => none, bend: () => 0 };
    }

    const t1 = { x: v.x + a.x * t, y: v.y + a.y * t };
    const t2 = { x: v.x + b.x * t, y: v.y + b.y * t };

    // Along the curve: the corner plus `t` times a combination of its two
    // ways out that is of `u` alone — see `Curve` — so linear in the bevel. A
    // corner running straight through is a straight run along its wall, from
    // one tangent point to the other.
    const c = a.x * b.x + a.y * b.y;
    const curve = curveOf(facets.tension);

    /** The point `u` of the way along the curve; both tangent points exact. */
    const on = (u: number): Point => {
      if (u <= 0) return t1;
      if (u >= 1) return t2;

      const p = bezier(curve.alongA, u) * t, q = bezier(curve.alongB, u) * t;

      return { x: v.x + a.x * p + b.x * q, y: v.y + a.y * p + b.y * q };
    };

    // Out of the material is to the right of the way round, for `out` of one:
    // the curve's tangent turned a quarter clockwise.
    const d1A = differenced(curve.alongA), d1B = differenced(curve.alongB);
    const normal = (u: number): Point => {
      const p = bezier(d1A, u), q = bezier(d1B, u);
      const x = a.x * p + b.x * q, y = a.y * p + b.y * q;
      const l = Math.hypot(x, y);

      return l === 0 ? none : { x: y / l, y: -x / l };
    };

    // How much the curve bends at `u`, signed: positive where it turns left,
    // the way round, and one over the radius it bends at there.
    const d2A = differenced(d1A), d2B = differenced(d1B);
    const bend = (u: number): number => {
      const p = bezier(d1A, u), q = bezier(d1B, u), p2 = bezier(d2A, u), q2 = bezier(d2B, u);
      const x = (a.x * p + b.x * q) * t, y = (a.y * p + b.y * q) * t;
      const x2 = (a.x * p2 + b.x * q2) * t, y2 = (a.y * p2 + b.y * q2) * t;
      const l = Math.hypot(x, y);

      return l === 0 ? 0 : (x * y2 - y * x2) / (l * l * l);
    };

    /** The `n + 1` points laid as an arc of `s` segments: its own points at
     * `n / s` apart, as near as whole points go, and the rest along the
     * facets between them. Each is linear in `t`, as `on` is. With where on
     * the curve each is, as near as a point on a facet has one. */
    const laid = (s: number): { points: Point[], us: number[] } => {
      const us = spreadOn(curve, c, s);
      const turns = us.map(on);
      const index = (q: number): number => Math.round(q * facets.n / s);
      const out: Point[] = [], at: number[] = [];

      for (let q = 0; q < s; q++) {
        const p = turns[q], r = turns[q + 1], from = index(q), to = index(q + 1);

        for (let j = from; j < to; j++) {
          const f = (j - from) / (to - from);

          out.push(f === 0 ? p : { x: mix(p.x, r.x, f), y: mix(p.y, r.y, f) });
          at.push(mix(us[q], us[q + 1], f));
        }
      }

      out.push(turns[s]);
      at.push(1);

      return { points: out, us: at };
    };

    return { ...laid(Math.max(1, facets.n)), point: false, on, normal, bend };
  }
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** A ring with each corner an arc of `segments + 1` points, tangent to both
 * its edges. See `arcs`. */
export function rounded(ring: Ring, bevel: (i: number) => number, segments: number, tension = TENSION): Ring {
  return arcs(ring, () => facetsOf(segments, tension), bevel).flat();
}

/** The arcs of a whole shape, rounded alike everywhere, one run per corner:
 * what `effected` builds, before the arrangement. */
export function arcRuns(shape: Shape, facets: Facets, bevel: number): Point[][] {
  if (bevel <= 0 || facets.n <= 0) return [];

  return shape.flatMap(ring => arcs(ring, () => facets, () => bevel));
}




/** A ring subdivided and perturbed by a deform, as points: see `subdivided`.
 * Out is to the right of the way round, as a counter-clockwise ring has it. */
export function deformed(ring: Ring, amplitude: (i: number) => number, e: Effecting, key: (i: number) => number = i => i): Ring {
  return subdivided(ring, e, amplitude, key, 1).map(c => c.at);
}

/**
 * A whole shape rounded alike everywhere, and taken through the arrangement:
 * what a group does to its union, which has no corners of its own to name.
 */
export function effected(shape: Shape, facets: Facets, bevel: number): Cut {
  if (bevel <= 0 || facets.n <= 0) return simplify(shape);

  return simplify(shape.map(ring => arcs(ring, () => facets, () => bevel).flat()));
}

/**
 * A union of `shapes` eroded by `depth` into `eroded` and rounded alike
 * everywhere, but for its deformed geometry: the vertices of `all` at a point
 * of `square` are left square, and so are those the union made beside them —
 * where a tooth crosses another's wall — with whatever the erosion makes of
 * them. See `imaged`.
 *
 * With the arcs of the corners that are rounded, as `arcRuns` has them, and
 * the points left square, for a group holding this one to leave square too.
 */
export function effectedSquare(
  shapes: readonly Shape[],
  all: Shape,
  eroded: Shape,
  depth: number,
  facets: Facets,
  bevel: number,
  square: readonly Point[],
): { shape: Cut, runs: Point[][], square: Point[] } {
  const source = all.flat();
  const rings = all.reduce<number[]>((out, _ring, r) => [...out, r === 0 ? 0 : out[r - 1] + all[r - 1].length], []);
  const n = source.length;

  // The points by cell, so each vertex looks at its own and those around it.
  const snap = extentOf(all) * 1e-7, cell = snap * 4;
  const cellOf = (p: Point): [number, number] => [Math.round(p.x / cell), Math.round(p.y / cell)];
  const cellsOf = (points: Iterable<Point>) => new Set([...points].map(p => cellOf(p).join(',')));
  const near = (cells: ReadonlySet<string>, p: Point): boolean => {
    const [x, y] = cellOf(p);

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (cells.has(`${x + dx},${y + dy}`)) return true;
      }
    }

    return false;
  };

  const squares = cellsOf(square), theirs = cellsOf(shapes.flat(2));
  const hit = source.map(p => near(squares, p));
  const made = source.map(p => !near(theirs, p));
  const flat = hit.map((h, i) => h || (made[i] && (hit[prevOf(rings, n, i)] || hit[nextOf(rings, n, i)])));
  const im = imaged(eroded, source, rings, () => depth, i => (flat[i] ? SQUARE : facets), () => bevel, { bevel, facets }, i => flat[i]);
  const runs: Point[][] = [], left: Point[] = [];

  im.corners.forEach((run, i) => {
    if (run === null) return;

    if (flat[i]) left.push(...run);
    else runs.push(run);
  });
  im.rest.forEach((run, k) => (im.restSquare[k] ? left.push(...run) : runs.push(run)));

  return { shape: simplify(im.shape), runs, square: left };
}

/**
 * Where corner `i` of a ring lands once the ring is offset by `depth` — the
 * meeting point of its two edges after each has moved to its left.
 *
 * This is `erode`'s own construction rather than a guess at it: every surviving
 * edge lies on a translate of its own line, so the corner between two of them is
 * where those translates cross. Two edges that run exactly straight through the
 * corner never cross, and then the answer is the corner moved along the shared
 * normal, which is that construction's limit rather than a case beside it.
 *
 * `null` where the corner is not on the offset boundary at all: a ring that
 * doubles back on itself sends the meeting point off towards infinity, and a
 * deep enough offset eats the edges the corner stood between.
 */
export function mitred(ring: Ring, rings: readonly number[], i: number, depth: number): Point | null {
  const n = ring.length;
  const a = ring[prevOf(rings, n, i)], b = ring[i], c = ring[nextOf(rings, n, i)];

  const ux = b.x - a.x, uy = b.y - a.y, ul = Math.hypot(ux, uy);
  const vx = c.x - b.x, vy = c.y - b.y, vl = Math.hypot(vx, vy);

  if (ul === 0 || vl === 0) return null;

  const p = { x: ux / ul, y: uy / ul };
  const q = { x: vx / vl, y: vy / vl };

  // Both moved lines pass through the corner's own offset, one for each edge.
  const pa = { x: b.x - p.y * depth, y: b.y + p.x * depth };
  const qa = { x: b.x - q.y * depth, y: b.y + q.x * depth };

  const turn = p.x * q.y - p.y * q.x;

  if (Math.abs(turn) < 1e-12) return pa;

  const s = ((qa.x - pa.x) * q.y - (qa.y - pa.y) * q.x) / turn;

  return { x: pa.x + p.x * s, y: pa.y + p.y * s };
}

/**
 * A polygon's ring as its effects draw it, before it is eroded: every drawn
 * corner rounded, the arc laid along the drawn corners either side of it and
 * not the teeth between, a deform's teeth along each arc, and the teeth a
 * deform already laid along the straights (`tooth`) left where they are. The
 * erosion takes what this makes as it would take corners drawn by hand, so a
 * round is a drawn curve, deformed as one, and then eroded.
 *
 * `owner` is the corner of `source` each point came of; `arcs` is where each
 * corner's `n + 1` arc points are in the ring — one point `n + 1` times where
 * the arc has no length, so that nothing is two points in one place — or just
 * the corner for one not rounded; `teeth` where the arcs' teeth are.
 *
 * A corner `apart` is rounded on its own, from the points either side of it,
 * with no teeth, and the arcs around it are laid as though it were not there:
 * a corner the bake has had to invent, sitting wherever its neighbours put it.
 */
export interface Outline {
  ring: Ring
  rings: number[]
  owner: number[]
  arcs: number[][]
  teeth: number[]
}

export function outlineOf(
  source: Ring,
  rings: readonly number[],
  tooth: (i: number) => boolean,
  facets: (i: number) => Facets,
  bevel: (i: number) => number,
  teeth: (i: number) => ArcTeeth | null,
  apart: (i: number) => boolean = () => false,
): Outline {
  const n = source.length;
  const starts = rings.length === 0 ? [0] : [...rings];
  const ring: Point[] = [], owner: number[] = [], out: number[] = [], toothAt: number[] = [];
  const arcAt: number[][] = source.map(() => []);

  // Out of the material is to the right of a ring wound the way the outline
  // is, and a hole is wound the other way: see `deformedAt`.
  const first = source.slice(0, starts[1] ?? n);
  const side: 1 | -1 = signedArea2(first) >= 0 ? 1 : -1;

  starts.forEach((start, r) => {
    const end = starts[r + 1] ?? n;
    const here = Array.from({ length: end - start }, (_x, k) => start + k);
    const drawn = here.filter(i => !tooth(i) && !apart(i));
    const laid = drawn.length < 3
      ? null
      : arcsWith(drawn.map(i => source[i]), k => facets(drawn[k]), k => bevel(drawn[k]), k => teeth(drawn[k]), side);

    out.push(ring.length);

    let k = 0;

    here.forEach((i, h) => {
      if (laid === null || tooth(i)) {
        arcAt[i] = [ring.length];
        ring.push(source[i]);
        owner.push(i);
        return;
      }

      const beside = [source[here[(h - 1 + here.length) % here.length]], source[i], source[here[(h + 1) % here.length]]];
      const arc = apart(i)
        ? arcsWith(beside, j => (j === 1 ? facets(i) : SQUARE), j => (j === 1 ? bevel(i) : 0), () => null, side)[1]
        : laid[k++];

      if (arc.point) {
        arcAt[i] = arc.arc.map(() => ring.length);
        ring.push(source[i]);
        owner.push(i);
        return;
      }

      const base = ring.length;

      arcAt[i] = arc.arcAt.map(j => base + j);
      toothAt.push(...arc.teethAt.map(j => base + j));
      arc.all.forEach(p => {
        ring.push(p);
        owner.push(i);
      });
    });
  });

  return { ring, rings: out, owner, arcs: arcAt, teeth: toothAt };
}

/**
 * One deform a polygon's straights go through, as the projection lays it:
 * its options, the amplitude of the edge starting at each point of the ring
 * it is laid on, which edges it teeth at all, and each edge's name to the
 * noise.
 *
 * An edge it teeth is toothed at every amplitude, nought included: the teeth
 * are laid flat there, and are points of the outline that draw no line until
 * they rise. An edge its timeline never deforms is left alone. See
 * `toothedRing` and `flatOf`.
 */
export interface Straights {
  e: Effecting
  amplitude: readonly number[]
  toothed: readonly boolean[]
  keys: readonly number[]
}

/**
 * A ring with its straights toothed, laid afresh wherever it is asked for
 * rather than carried as corners: each deform of `chain` in turn subdivides
 * what the one before left, the first one's amplitudes and keys by the
 * source's corners and a later one's by the edges they became. `clear` is
 * each source corner's drawn bevel, which the first deform's teeth stop
 * short of; `depths` is each corner's own, if it has one, and a tooth's is
 * its edge's in proportion along it, so a varying erosion leaves a straight
 * edge straight.
 *
 * A corner `apart` is not there to the teeth: they are laid along the edge
 * as though it were not, and it is put back on them where it falls along
 * that edge. It is one the bake invented, flat on the edge at this end, and
 * the pattern is the edge's the editor draws. See `effectsOver`.
 *
 * `owner` is the source corner each point is, or -1 for a tooth.
 */
export function toothedRing(
  source: Ring,
  rings: readonly number[],
  chain: readonly Straights[],
  clear: (i: number) => number,
  depths: readonly number[] | null,
  apart: (i: number) => boolean = () => false,
): { ring: Ring, rings: number[], owner: number[], depths: number[] | null } {
  const all = rings.length === 0 ? [0] : [...rings];
  const n0 = source.length;

  // Those apart taken out, where a ring keeps three without them.
  const skipped = new Set<number>();

  if (chain.length > 0) {
    all.forEach((start, r) => {
      const end = all[r + 1] ?? n0;
      const out = Array.from({ length: end - start }, (_x, k) => start + k).filter(i => apart(i));

      if (end - start - out.length >= 3) out.forEach(i => skipped.add(i));
    });
  }

  let pts: Point[] = [];
  let starts: number[] = [];
  let owner: number[] = [];

  all.forEach((start, r) => {
    starts.push(pts.length);

    for (let i = start; i < (all[r + 1] ?? n0); i++) {
      if (skipped.has(i)) continue;

      pts.push(source[i]);
      owner.push(i);
    }
  });

  let root = [...owner];
  let keys: number[] = [];
  let deep = depths === null ? null : owner.map(i => depths[i]);

  chain.forEach((d, c) => {
    const slices = sliced(pts, starts);
    const out: 1 | -1 = signedArea2(slices[0]) >= 0 ? 1 : -1;
    const next: Point[] = [], nextOwner: number[] = [], nextRoot: number[] = [], nextKeys: number[] = [], nextStarts: number[] = [];
    const nextDeep: number[] | null = deep === null ? null : [];

    slices.forEach((ring, r) => {
      const at = starts[r];
      // A tooth's edge is part of the source edge it was laid on.
      const amp = (i: number) => d.amplitude[root[at + i]];
      const key = (i: number) => (owner[at + i] >= 0 ? d.keys[owner[at + i]] : keys[at + i]);
      const laid = subdivided(ring, d.e, amp, key, out, i => (c === 0 ? Math.max(0, clear(owner[at + i])) : 0), i => d.toothed[root[at + i]]);

      nextStarts.push(next.length);

      for (const made of laid) {
        next.push(made.at);
        nextRoot.push(root[at + made.from]);

        if (made.j === null) {
          nextOwner.push(owner[at + made.from]);
          nextKeys.push(key(made.from));
          nextDeep?.push(deep![at + made.from]);
        }
        else {
          nextOwner.push(-1);
          nextKeys.push(Math.floor(hashed(key(made.from), made.j, c) * 4294967296) | 0);

          const d0 = deep?.[at + made.from] ?? 0, d1 = deep?.[at + (made.from + 1) % ring.length] ?? 0;

          nextDeep?.push(d0 + (d1 - d0) * made.along);
        }
      }
    });

    pts = next;
    owner = nextOwner;
    root = nextRoot;
    keys = nextKeys;
    starts = nextStarts;
    deep = nextDeep;
  });

  if (skipped.size === 0) return { ring: pts, rings: starts, owner, depths: deep };

  // Each one apart back where it falls along the edge it was left off: at
  // the same share of the way from the corner before it to the one after,
  // on whatever the teeth made between them.
  const ring: Point[] = [], outRings: number[] = [], outOwner: number[] = [];
  const outDeep: number[] | null = deep === null ? null : [];

  all.forEach((start, r) => {
    const end = all[r + 1] ?? n0;
    const from = starts[r], to = starts[r + 1] ?? pts.length;

    outRings.push(ring.length);

    // The laid points of this ring, and where each source corner is in them.
    const laid = Array.from({ length: to - from }, (_x, k) => from + k);
    const kept = Array.from({ length: end - start }, (_x, k) => start + k).filter(i => !skipped.has(i));

    kept.forEach((i, m) => {
      const j = kept[(m + 1) % kept.length];
      const a = laid.indexOf(laid.find(k => owner[k] === i)!);
      const b = laid.indexOf(laid.find(k => owner[k] === j)!);
      const span = a <= b ? laid.slice(a, b + 1) : [...laid.slice(a), laid[0]];

      // Its own and the teeth after it.
      span.slice(0, -1).forEach(k => {
        ring.push(pts[k]);
        outOwner.push(owner[k]);
        outDeep?.push(deep![k]);
      });

      // And those apart between it and the next, in order.
      const between: number[] = [];

      for (let x = (i + 1 - start) % (end - start) + start; x !== j; x = (x + 1 - start) % (end - start) + start) between.push(x);

      const p = source[i], q = source[j];
      const dx = q.x - p.x, dy = q.y - p.y, l2 = dx * dx + dy * dy;
      const lengths = [0];

      for (let k = 1; k < span.length; k++) lengths.push(lengths[k - 1] + Math.hypot(pts[span[k]].x - pts[span[k - 1]].x, pts[span[k]].y - pts[span[k - 1]].y));

      // Where each tooth is along the edge, by its foot on it.
      const along = span.map(k => (l2 === 0 ? 0 : ((pts[k].x - p.x) * dx + (pts[k].y - p.y) * dy) / l2));

      along[along.length - 1] = 1;

      for (const x of between) {
        const u = l2 === 0 ? 0 : Math.min(1, Math.max(0, ((source[x].x - p.x) * dx + (source[x].y - p.y) * dy) / l2));
        let k = 0;

        while (k < span.length - 2 && along[k + 1] < u) k++;

        const w = (u - along[k]) / Math.max(along[k + 1] - along[k], 1e-300);
        const s0 = pts[span[k]], s1 = pts[span[k + 1]];

        // Put in after the teeth before it: the ring has them in order.
        const at = ring.length - (span.length - 2 - k);

        ring.splice(at, 0, { x: s0.x + (s1.x - s0.x) * w, y: s0.y + (s1.y - s0.y) * w });
        outOwner.splice(at, 0, x);
        outDeep?.splice(at, 0, depths![x]);
      }
    });
  });

  return { ring, rings: outRings, owner: outOwner, depths: outDeep };
}

/**
 * A sealed group's fold as its own effects draw it: what `outlineOf` does to
 * a polygon, done to the union of its members at depth nought — every corner
 * rounded, the group's deform laid along its straights and its arcs — and
 * eroded by the group's depth last. See PLAN-bevel, phase 2.
 *
 * A straight is a maximal run of the fold's outline in one line, so two
 * members side by side along a wall are one straight with one pattern, from
 * its middle. The points in `square` are deformed geometry of the members',
 * which the round leaves as it is and the deform does not tooth again. The
 * teeth are keyed nought, every straight alike: a
 * union's edges have no ids to tell them apart by.
 *
 * Held, as a polygon's round is (see `drawnBevels`), a corner is drawn at
 * `bevel` and as much again as the erosion takes back off it, so the round
 * that comes out is the one asked for. `square` is what came out deformed,
 * for a scope holding this one to leave square.
 */
export interface FoldShaped {
  shape: Shape
  square: Point[]
}

export function foldShaped(
  fold: Shape,
  square: readonly Point[],
  facets: Facets,
  bevel: number,
  held: boolean,
  deform: { e: Effecting, amplitude: number } | null,
  depth: number,
): FoldShaped {
  if (fold.length === 0) return { shape: [], square: [] };

  let scale = 1;

  for (const ring of fold) for (const p of ring) scale = Math.max(scale, Math.abs(p.x), Math.abs(p.y));

  const tol = scale * 1e-9;
  const same = (p: Point, q: Point) => Math.abs(p.x - q.x) <= tol && Math.abs(p.y - q.y) <= tol;
  const isSquare = (p: Point) => square.some(q => same(p, q));

  // An arrangement's rings all have their material to the left: an outline
  // counter-clockwise and its holes the other way. See `deformedAt`.
  const out: 1 | -1 = 1;

  // Each ring down to its corners: a point in line with its neighbours is not
  // one, and would split a straight's pattern in two.
  const cleaned = fold.map(ring => {
    let pts = ring.filter((p, i) => !same(p, ring[(i + 1) % ring.length]));

    while (pts.length > 3) {
      const at = pts.findIndex((b, i) => {
        const a = pts[(i - 1 + pts.length) % pts.length], c = pts[(i + 1) % pts.length];
        const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - b.x, vy = c.y - b.y;
        const cross = ux * vy - uy * vx, dot = ux * vx + uy * vy;

        return !isSquare(b) && dot > 0 && Math.abs(cross) <= 1e-9 * Math.hypot(ux, uy) * Math.hypot(vx, vy);
      });

      if (at < 0) break;

      pts = pts.filter((_p, i) => i !== at);
    }

    return pts;
  }).filter(ring => ring.length >= 3);

  const turnAt = (ring: Ring, i: number): number => {
    const a = ring[(i - 1 + ring.length) % ring.length], b = ring[i], c = ring[(i + 1) % ring.length];

    return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
  };
  const drawnAt = (ring: Ring, i: number): number => {
    if (!(bevel > 0) || facets.n <= 0) return 0;

    return Math.max(0, held ? bevel + depth * Math.sign(turnAt(ring, i)) : bevel);
  };

  const source: Point[] = [], starts: number[] = [], tooth: boolean[] = [], drawn: number[] = [];

  cleaned.forEach((ring, r) => {
    const sq = ring.map(isSquare);
    const bevels = ring.map((_p, i) => (sq[i] ? 0 : drawnAt(ring, i)));
    const laid = deform === null
      ? ring.map((at, i) => ({ at, from: i, j: null as number | null, along: 0 }))
      : subdivided(ring, deform.e, () => deform.amplitude, () => 0, out, i => bevels[i], i => !sq[i] && !sq[(i + 1) % ring.length]);

    starts.push(source.length);

    for (const made of laid) {
      source.push(made.at);
      tooth.push(made.j !== null || sq[made.from]);
      drawn.push(made.j === null ? bevels[made.from] : 0);
    }
  });

  const arcTeeth = (i: number): ArcTeeth | null => (deform === null || deform.amplitude === 0 || !(drawn[i] > 0)
    ? null
    : { e: deform.e, before: deform.amplitude, after: deform.amplitude, key: 0, seen: Math.min(1, bevel / drawn[i]) });
  const o = outlineOf(source, starts, i => tooth[i], i => (tooth[i] ? SQUARE : facets), i => drawn[i], arcTeeth);

  const simple = simplify(sliced(o.ring, o.rings));
  const shape = depth === 0 ? simple : erode(simple, depth);
  const image = (k: number): Point | null => (depth === 0 ? o.ring[k] : mitred(o.ring, o.rings, k, depth));

  const squared = [
    ...tooth.flatMap((t, i) => (t ? o.arcs[i] : [])),
    ...o.teeth,
  ].map(image).filter((p): p is Point => p !== null);

  return { shape, square: squared };
}

/**
 * An eroded boundary rounded, and where each corner of the source landed in
 * it: corner `i` as the run of its arc, or `null` for a corner not on the
 * eroded boundary at all.
 *
 * The one construction for both. A source corner's image is where `mitred`
 * puts it, matched to a vertex of `eroded` by position; that vertex takes the
 * corner's bevel and facets. A corner that is flat in the source is not a
 * vertex of `eroded` — the arrangement dropped it — so its image is put back
 * into the edge it lies on first, where its arc is a sliver along it. What is
 * the image of nothing — a corner the erosion made — takes `rest`, unless the
 * source corner nearest it either way round is `flat`: deformed geometry,
 * which a round leaves square, and so what the erosion makes of it too.
 *
 * The shape is the rings as the construction leaves them, before any
 * arrangement: every arc there, coincident points or not. `rest` is the arcs
 * of the corners the erosion made, which no source corner names.
 */
export interface Imaged {
  shape: Shape
  corners: (Point[] | null)[]
  /** The teeth along the arcs, where a polygon's effects laid any: see
   * `outlineOf`. */
  teeth?: Point[]
  /** The teeth along the straights, where the projection laid them: see
   * `toothedRing`. */
  straight?: Point[]
  /** Where the outline runs straight through a point of it, which the
   * arrangement drops and the projection asks back: see `flatOf`. */
  flat?: Point[]
  /** Each corner's arc as it is drawn, before the erosion, where a polygon's
   * effects drew one: see `outlineOf`. */
  drawn?: Point[][]
  rest: Point[][]
  /** Which of `rest` were left square, beside deformed geometry. */
  restSquare: boolean[]
}

export function imaged(
  eroded: Shape,
  source: Ring,
  rings: readonly number[],
  depth: (i: number) => number,
  facets: (i: number) => Facets,
  bevel: (i: number) => number,
  rest: { bevel: number, facets: Facets },
  flat: (i: number) => boolean = () => false,
): Imaged {
  const n = source.length;
  const images = source.map((_p, i) => mitred(source, rings, i, depth(i)));
  const snap = extentOf(eroded.length > 0 ? eroded : [source]) * 1e-7;
  const at = (p: Point, q: Point): boolean => Math.hypot(p.x - q.x, p.y - q.y) <= snap;

  // Each ring's vertices, with the source corner each is the image of.
  const owned = eroded.map(ring => ring.map(p => ({ p, owner: images.findIndex(m => m !== null && at(m, p)) })));
  const placed = new Set(owned.flatMap(ring => ring.map(v => v.owner)));

  // The flat corners, put back on the edge they lie on.
  for (let i = 0; i < n; i++) {
    const m = images[i];

    if (m === null || placed.has(i)) continue;

    let best: { ring: number, index: number, along: number } | null = null;

    owned.forEach((ring, r) => ring.forEach((v, k) => {
      const w = ring[(k + 1) % ring.length].p;
      const dx = w.x - v.p.x, dy = w.y - v.p.y, l = Math.hypot(dx, dy);

      if (l === 0) return;

      const off = Math.abs((m.x - v.p.x) * dy - (m.y - v.p.y) * dx) / l;
      const along = ((m.x - v.p.x) * dx + (m.y - v.p.y) * dy) / l;

      if (off <= snap && along > snap && along < l - snap && best === null) best = { ring: r, index: k, along };
    }));

    if (best === null) continue;

    const { ring, index } = best;

    owned[ring].splice(index + 1, 0, { p: m, owner: i });
    placed.add(i);
  }

  const corners: (Point[] | null)[] = source.map(() => null);
  const made: Point[][] = [];
  const madeSquare: boolean[] = [];

  const shape = owned.map(ring => {
    /** Whether a corner the erosion made is next to deformed geometry: the
     * source corner nearest it, one way round or the other, is flat. */
    const beside = (k: number): boolean => [1, -1].some(way => {
      for (let s = 1; s < ring.length; s++) {
        const { owner } = ring[(k + way * s + ring.length * s) % ring.length];

        if (owner >= 0) return flat(owner);
      }

      return false;
    });
    const taking = ring.map((v, k) => (v.owner >= 0 ? null : beside(k) ? { facets: SQUARE, bevel: 0 } : rest));
    const run = arcs(
      ring.map(v => v.p),
      k => taking[k]?.facets ?? facets(ring[k].owner),
      k => taking[k]?.bevel ?? bevel(ring[k].owner),
    );

    ring.forEach((v, k) => {
      if (v.owner >= 0) corners[v.owner] = run[k];
      else {
        made.push(run[k]);
        madeSquare.push(taking[k] !== rest);
      }
    });

    return run.flat();
  });

  return { shape, corners, rest: made, restSquare: madeSquare };
}

/** How little a corner may turn and still be cut back its whole bevel: less,
 * and it is cut back in proportion, down to `SEEDING` of it. See `arcs`. */
const BLUNT = Math.PI / 6;

/** How far apart what would otherwise be one point is laid, against what it
 * grows to: small enough to read as a point, and far above the arrangement's
 * own tolerance. A straight corner's cut against its bevel, and the bake's
 * amount at nought against the other end's. */
export const SEEDING = 1e-3;

// -----------------------------------------------------------------------------
// Rings that are made rather than drawn
// -----------------------------------------------------------------------------

/**
 * A regular polygon: `sides` corners on a circle, the first one straight up.
 *
 * Straight up so that a triangle points the way a triangle is drawn, and with
 * a further eighth of a turn at four sides so that a square is a square rather
 * than a diamond — at four, and only at four, the corners of a ring starting
 * at the top land on the diagonals, and a level is built out of squares that
 * sit on the grid their centre sits on.
 */
export function ngon(centre: Point, radius: number, sides: number): Ring {
  const turn = sides === 4 ? -Math.PI / 4 : 0;

  return Array.from({ length: sides }, (_unused, i) => {
    const a = -Math.PI / 2 + turn + (i * 2 * Math.PI) / sides;

    return { x: centre.x + radius * Math.cos(a), y: centre.y + radius * Math.sin(a) };
  });
}

// -----------------------------------------------------------------------------
// Points against a segment
// -----------------------------------------------------------------------------

/** How far along `a`–`b` the foot of `p` falls, clamped to the segment. */
export function fraction(a: Point, b: Point, p: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = dx * dx + dy * dy;

  if (len === 0) return 0;

  return Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
}

/** The point of `a`–`b` closest to `p`. */
export function along(a: Point, b: Point, p: Point): Point {
  const t = fraction(a, b, p);

  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}
