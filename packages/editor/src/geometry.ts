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
import { AABB, Tree, box, build, each, emptyTree, expand, ofRings } from './aabb';

export type { Point };

/** A closed loop. The last point is *not* a repeat of the first. */
export type Ring = Point[];

/** A shape is any number of rings, filled by the nonzero winding rule. */
export type Shape = Ring[];

/** Which of the two operands a point is in, and what that means for the answer. */
export type Op = (a: boolean, b: boolean) => boolean;

/**
 * Where in the input something came from: which operand, which of its rings,
 * and which vertex or edge of that ring. Vertices and edges share a numbering —
 * edge `i` runs from vertex `i` to vertex `i + 1`.
 */
export interface SourceRef {
  shape: 0 | 1
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

export function union(a: Shape, b: Shape): Shape {
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
export function unionAll(shapes: readonly Shape[]): Shape {
  const live = shapes.filter(s => s.length !== 0);

  if (live.length <= 1) return live[0] ?? [];

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
  const on = ground(live.map((shape, id) => ({ id, kind: 'level' as const, shape })));

  return chain(
    arranged(p => covers(on.level, p), () => false, OpUnion, split(raw, snap), snap),
    snap,
  ).rings;
}

export function subtract(a: Shape, b: Shape): Shape {
  return combine(a, b, OpSubtract);
}

export function intersect(a: Shape, b: Shape): Shape {
  return combine(a, b, OpIntersect);
}

export function xor(a: Shape, b: Shape): Shape {
  return combine(a, b, OpXor);
}

/**
 * The same shape, with every self-intersection resolved: the result is a set of
 * rings that neither cross themselves nor each other, covering exactly the area
 * the nonzero rule gave the input.
 */
export function simplify(a: Shape): Shape {
  return combine(a, [], inA => inA);
}

/**
 * The plain mitred offset: every edge moves inward by `depth`, each corner goes
 * where its two moved lines meet, and an edge that runs out of room takes its
 * endpoints with it.
 *
 * It is done by taking away the band the boundary sweeps on its way in — one
 * quad per edge, one mitred wedge per corner that opens as it turns — rather
 * than by moving the vertices and trying to sort out the mess. Moving the
 * vertices is a page of code and gets the easy half right, but the ring it
 * produces folds back on itself once an edge collapses, and no fill rule tells
 * a fold from material: a square eroded past its own middle comes back inside
 * out, wound the same way it started, and reads as a smaller square of ground
 * where there should be none. Subtracting the band has no such state. Where the
 * band covers a room the room is gone, where it pinches one in two there are
 * two rooms, and both answers come out of the arrangement that was going to run
 * anyway.
 *
 * Every surviving edge therefore lies on a translate of its own original line,
 * exactly parallel to where it started, at every depth. Nothing is clamped and
 * nothing is frozen, so vertices die freely — which costs no identity, because
 * erosion is a projection and never writes back to a source.
 *
 * Left is the material side for every ring the arrangement produces, outer or
 * hole alike, so a hole opens up as the material around it shrinks with no
 * special case. A negative depth grows the shape instead, by putting the band
 * on the other side and adding it. The input has to be simple; `simplify` is
 * what the caller has already run to make it so.
 */
export function erode(shape: Shape, depth: number): Shape {
  if (depth === 0) return shape;

  const swept = band(shape, depth);

  return depth > 0 ? subtract(shape, swept) : union(shape, swept);
}

/**
 * How far a corner's mitre may reach, as a multiple of the depth, before it is
 * cut off square. A corner turning back on itself sends the two moved lines
 * very nearly parallel and their meeting point off towards infinity; past this
 * the wedge is closed with a straight edge instead. It only bites on a slit.
 */
const MITRE_LIMIT = 8;

/** The ground the boundary covers on its way in: `erode` subtracts this. */
function band(shape: Shape, depth: number): Shape {
  const out: Shape = [];

  for (const ring of shape) {
    const edges = moved(ring, depth);

    for (const e of edges) {
      out.push(ccw([e.a, e.b, e.mb, e.ma]));
    }

    // Between two edges the ring turns away from, the band would leave a wedge
    // of ground standing on nothing. The corner it wants is where the two moved
    // lines meet, which is the mitre.
    for (let i = 0; i < edges.length; i++) {
      const p = edges[(i - 1 + edges.length) % edges.length], q = edges[i];
      const turn = p.ux * q.uy - p.uy * q.ux;

      if (turn * depth >= 0) continue;

      const corner = meet(p, q);
      const reach = Math.abs(depth) * MITRE_LIMIT;

      out.push(corner === null || Math.hypot(corner.x - q.a.x, corner.y - q.a.y) > reach
        ? ccw([q.a, p.mb, q.ma])
        : ccw([q.a, p.mb, corner, q.ma]));
    }
  }

  return out;
}

/** One edge of a ring, and where moving it `depth` to its left put it. */
interface Moved {
  a: Point
  b: Point
  ma: Point
  mb: Point
  ux: number
  uy: number
}

function moved(ring: Ring, depth: number): Moved[] {
  const out: Moved[] = [];

  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const l = Math.hypot(dx, dy);

    // A repeated point is not an edge and has no line to move.
    if (l === 0) continue;

    const ux = dx / l, uy = dy / l;
    const ox = -uy * depth, oy = ux * depth;

    out.push({
      a,
      b,
      ma: { x: a.x + ox, y: a.y + oy },
      mb: { x: b.x + ox, y: b.y + oy },
      ux,
      uy,
    });
  }

  return out;
}

/** Where two moved edges' lines cross, or nothing when they are parallel. */
function meet(p: Moved, q: Moved): Point | null {
  const d = p.ux * q.uy - p.uy * q.ux;

  if (Math.abs(d) < 1e-12) return null;

  const t = ((q.ma.x - p.ma.x) * q.uy - (q.ma.y - p.ma.y) * q.ux) / d;

  return { x: p.ma.x + p.ux * t, y: p.ma.y + p.uy * t };
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
export function decompose(ring: Ring): Shape {
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
  tree: Tree
  /** `a` and `b` of each edge, flattened, four numbers apiece. */
  edges: Float64Array
}

export function field(shape: Shape): Field {
  const boxes: { id: number, box: AABB }[] = [];
  let n = 0;

  for (const ring of shape) n += ring.length;

  const edges = new Float64Array(n * 4);
  let id = 0;

  for (const ring of shape) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const at = id * 4;

      edges[at] = a.x;
      edges[at + 1] = a.y;
      edges[at + 2] = b.x;
      edges[at + 3] = b.y;

      boxes.push({
        id,
        box: box(
          Math.min(a.x, b.x),
          Math.min(a.y, b.y),
          Math.max(a.x, b.x),
          Math.max(a.y, b.y),
        ),
      });

      id++;
    }
  }

  return { shape, tree: build(boxes), edges };
}

export function fieldWinding(f: Field, p: Point): number {
  const e = f.edges;
  let w = 0;

  // Everything the ray could meet: to the right of `p`, and level with it.
  each(f.tree, box(p.x, p.y, Infinity, p.y), id => {
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
function segments(shape: Shape, which: 0 | 1, ranks?: readonly number[]): Seg[] {
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
  const boxes = segs.map((g, id) => ({
    id,
    box: expand(
      box(
        Math.min(g.a.x, g.b.x),
        Math.min(g.a.y, g.b.y),
        Math.max(g.a.x, g.b.x),
        Math.max(g.a.y, g.b.y),
      ),
      eps,
    ),
  }));

  const tree = build(boxes);
  const near: number[] = [];

  for (let i = 0; i < primary; i++) {
    near.length = 0;

    // A pair of primaries would be visited from both ends, so it is taken from
    // the lower one only. A pair with a secondary in it is reached from the
    // primary end alone, so it is always taken.
    each(tree, boxes[i].box, j => {
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
        a: { x: a.x + dx * t0.t, y: a.y + dy * t0.t },
        b: { x: a.x + dx * t1.t, y: a.y + dy * t1.t },
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
    // are input vertices rather than crossings.
    addParam(ts, t0, u.ta);
    addParam(ts, t1, u.tb);

    const ss = sx * sx + sy * sy;
    const u0 = (-qx * sx - qy * sy) / ss;
    const u1 = (rx * sx + ry * sy - qx * sx - qy * sy) / ss;

    addParam(us, u0, s.ta);
    addParam(us, u1, s.tb);

    if (cs !== null && u.rank < s.rank) {
      cs.push({ t0: Math.min(t0, t1), t1: Math.max(t0, t1), rank: u.rank });
    }

    if (cu !== null && s.rank < u.rank) {
      cu.push({ t0: Math.min(u0, u1), t1: Math.max(u0, u1), rank: s.rank });
    }

    return;
  }

  const t = (qx * sy - qy * sx) / d;
  const u0 = (qx * ry - qy * rx) / d;

  // The lines always meet; the segments only do when both parameters land on
  // them. Without that check a segment would be cut where its neighbour's
  // *line* passes, which litters the result with points that are not corners.
  const tol = eps / Math.max(rl, sl, eps);
  if (t < -tol || t > 1 + tol || u0 < -tol || u0 > 1 + tol) return;

  const tag = crossTag(s.edge, u.edge);

  addParam(ts, t, tag);
  addParam(us, u0, tag);
}

function addParam(ts: Param[], t: number, tag: Tag): void {
  if (t > 0 && t < 1) ts.push({ t, tag });
}

// -----------------------------------------------------------------------------
// Classification and chaining
// -----------------------------------------------------------------------------

/** Any of the above, and the only thing that actually does the work. */
export function combine(a: Shape, b: Shape, op: Op, fill: Fill = fieldContains): Shape {
  return combineTagged(a, b, op, fill).rings;
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
    arranged(p => fill(fa, p), p => fill(fb, p), op, split(raw, snap), snap),
    snap,
  );
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
  inA: (p: Point) => boolean,
  inB: (p: Point) => boolean,
  op: Op,
  segs: Seg[],
  snap: number,
): Seg[] {
  // `snap` was scaled off the input the same way, so this recovers it.
  const scale = snap / 1e-9;

  const kept: Seg[] = [];
  const seen = new Set<string>();
  const weld = welder(snap);

  for (const s of segs) {
    const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y;
    const len = Math.hypot(dx, dy);
    if (len <= snap) continue;

    // A step off either side of the middle, far enough to clear rounding and
    // short enough to stay inside whichever face the side belongs to.
    const off = Math.min(scale * 1e-7, len * 0.25);
    const nx = -dy / len * off, ny = dx / len * off;
    const mx = s.a.x + dx / 2, my = s.a.y + dy / 2;

    const left = { x: mx + nx, y: my + ny };
    const right = { x: mx - nx, y: my - ny };

    const inLeft = op(inA(left), inB(left));
    const inRight = op(inA(right), inB(right));

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

/** A polygon taking part in the set, as `boundaryRuns` needs to see it. */
export interface Member {
  id: number
  kind: 'level' | 'solid'
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
export interface Ground {
  level: Side
  solid: Side
}

/** One kind's members, each prepared on its own and findable by where it is. */
interface Side {
  tree: Tree
  parts: Field[]
}

export function ground(members: Iterable<Member>): Ground {
  const sides: Side[] = [{ tree: emptyTree, parts: [] }, { tree: emptyTree, parts: [] }];
  const boxes: { id: number, box: AABB }[][] = [[], []];

  for (const m of members) {
    if (m.shape.length === 0) continue;

    const which = m.kind === 'level' ? 0 : 1;
    const side = sides[which];

    boxes[which].push({ id: side.parts.length, box: ofRings(m.shape) });
    side.parts.push(field(m.shape));
  }

  for (const which of [0, 1]) sides[which].tree = build(boxes[which]);

  return { level: sides[0], solid: sides[1] };
}

/**
 * Nonzero fill over a whole side. Winding is additive over rings, and a member
 * that does not have `p` in its box contributes none of it, so the tree hands
 * back the one or two members that could and the rest are never read.
 */
function covers(side: Side, p: Point): boolean {
  let w = 0;

  each(side.tree, box(p.x, p.y, p.x, p.y), i => {
    w += fieldWinding(side.parts[i], p);
  });

  return w !== 0;
}

export interface BoundaryRun {
  points: Point[]
  /**
   * Per point of `points`: whether the boundary actually turns there, which is
   * whether a vertical standing on it is telling the truth. See `cornering`,
   * and see the header of `walls.ts` for why the answer belongs here rather
   * than with whoever draws the wall.
   */
  corner: boolean[]
}

/**
 * The parts of `subject`'s edges that lie on the boundary of the set the
 * members make — every `level` unioned, every `solid` taken back out — as open
 * runs in the order they are walked.
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
 * by kind and then by id, and a piece with something lower-ranked lying along
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
  on?: Ground,
): BoundaryRun[] {
  const all = [subject, ...others];
  const a: Shape = [], b: Shape = [];
  const ranks: number[][] = [[], []];

  let rank = 0, mine = -1;

  for (const kind of ['level', 'solid'] as const) {
    const which = kind === 'level' ? 0 : 1;
    const into = which === 0 ? a : b;

    for (const m of all.filter(x => x.kind === kind).sort((p, q) => p.id - q.id)) {
      if (m.id === subject.id) mine = rank;

      for (const ring of m.shape) {
        into.push(ring);
        ranks[which].push(rank);
      }

      rank++;
    }
  }

  // Subject first, so that `split` can cut it and leave the rest alone. The
  // order no longer decides anything: rank does.
  const raw = [...segments(a, 0, ranks[0]), ...segments(b, 1, ranks[1])];
  const ours = raw.filter(s => s.rank === mine);
  const rest = raw.filter(s => s.rank !== mine);

  const snap = scaleOf(raw) * 1e-9;
  const shared = on ?? ground(all);

  const inLevel = (p: Point) => covers(shared.level, p);
  const inSolid = (p: Point) => covers(shared.solid, p);

  const made = runs(
    arranged(inLevel, inSolid, OpSubtract, split([...ours, ...rest], snap, ours.length), snap),
    snap,
  );

  // Against everything taking part rather than against `ours`: which way the
  // boundary carries on past the end of a run is exactly the question the
  // neighbours are here to answer.
  const turning = cornering(made, raw, inLevel, inSolid, OpSubtract, snap);

  return made.map((points, i) => ({ points, corner: turning[i] }));
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
 * The directions along the runs themselves are boundary by construction and are
 * taken for free. The rest come from the neighbours' edges lying on the point,
 * and each is put to the same test `arranged` puts a piece to: step off either
 * side of it and ask whether the two sides disagree about the answer. A step
 * just past the point rather than at a midpoint, because the neighbours' edges
 * were never cut and there is no midpoint of theirs to trust — the piece that
 * matters is the one leaving the point, and only its first hair is being asked
 * about.
 *
 * So the extra classification is a handful of point queries per junction, and
 * none at all along a run, rather than the arrangement of every neighbour that
 * answering this the obvious way would have cost.
 */
function cornering(
  runs: readonly Point[][],
  segs: readonly Seg[],
  inA: (p: Point) => boolean,
  inB: (p: Point) => boolean,
  op: Op,
  snap: number,
): boolean[][] {
  if (runs.length === 0) return [];

  // `snap` was scaled off the input the same way, so this recovers it.
  const scale = snap / 1e-9;
  const weld = welder(snap);

  // Where the boundary is already known to go, by welded point. Gathered over
  // every run before any of them is answered, so that a ring handed back with
  // its first point repeated at the last has both copies' neighbours under the
  // one key, and both copies therefore answer alike.
  const known = new Map<number, Point[]>();

  const add = (into: Point[], d: Point) => {
    if (!into.some(o => alike(o, d))) into.push(d);
  };

  const away = (from: Point, to: Point): Point | null => {
    const dx = to.x - from.x, dy = to.y - from.y;
    const l = Math.hypot(dx, dy);

    return l <= snap ? null : { x: dx / l, y: dy / l };
  };

  const ids = runs.map(run => run.map(p => weld.id(p)));

  ids.forEach((run, r) => run.forEach((id, i) => {
    const at = known.get(id) ?? [];

    for (const j of [i - 1, i + 1]) {
      const q = runs[r][j];
      const d = q === undefined ? null : away(runs[r][i], q);

      if (d !== null) add(at, d);
    }

    known.set(id, at);
  }));

  // Everything the neighbourhood could put on a point, found by where it is.
  // The boxes are grown by `snap` because a neighbour's edge only has to come
  // within that of a point to be lying on it.
  const tree = build(segs.map((s, id) => ({
    id,
    box: expand(
      box(
        Math.min(s.a.x, s.b.x),
        Math.min(s.a.y, s.b.y),
        Math.max(s.a.x, s.b.x),
        Math.max(s.a.y, s.b.y),
      ),
      snap,
    ),
  })));

  /** Whether the boundary leaves `p` along `d`, with `reach` of the edge it is
   * travelling to go. The step is bounded by the edge for the same reason
   * `arranged` bounds its own: a fixed step is only small enough where the
   * geometry is big enough. */
  const going = (p: Point, d: Point, reach: number): boolean => {
    const off = Math.min(scale * 1e-7, reach * 0.25);
    const mx = p.x + d.x * off, my = p.y + d.y * off;

    const left = { x: mx - d.y * off, y: my + d.x * off };
    const right = { x: mx + d.y * off, y: my - d.x * off };

    return op(inA(left), inB(left)) !== op(inA(right), inB(right));
  };

  const answered = new Map<number, boolean>();

  const at = (id: number, p: Point): boolean => {
    const held = answered.get(id);
    if (held !== undefined) return held;

    const out = [...(known.get(id) ?? [])];

    each(tree, box(p.x, p.y, p.x, p.y), i => {
      const s = segs[i];
      const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y;
      const l = Math.hypot(dx, dy);

      if (l === 0) return;

      const ux = dx / l, uy = dy / l;
      const t = ((p.x - s.a.x) * ux + (p.y - s.a.y) * uy);

      // Off the end of it, or off to one side: not an edge lying on this point.
      if (t < -snap || t > l + snap) return;
      if (Math.abs((p.x - s.a.x) * uy - (p.y - s.a.y) * ux) > snap) return;

      // One direction for each way there is still edge to go.
      for (const [d, reach] of [
        [{ x: ux, y: uy }, l - t],
        [{ x: -ux, y: -uy }, t],
      ] as [Point, number][]) {
        if (reach <= snap) continue;
        if (out.some(o => alike(o, d))) continue;
        if (going(p, d, reach)) out.push(d);
      }
    });

    const turns = out.length !== 2 || !opposed(out[0], out[1]);

    answered.set(id, turns);

    return turns;
  };

  return ids.map((run, r) => run.map((id, i) => at(id, runs[r][i])));
}

/**
 * Segments chained end to end into the longest runs they make, without closing
 * them. Where a run does close on itself the loop is returned with its first
 * point repeated at the end, so that every edge is present either way.
 */
function runs(segs: Seg[], snap: number): Point[][] {
  const weld = welder(snap);
  const next = new Map<number, number[]>();
  const incoming = new Map<number, number>();

  segs.forEach((s, i) => {
    const from = weld.id(s.a), to = weld.id(s.b);

    (next.get(from) ?? next.set(from, []).get(from)!).push(i);
    incoming.set(to, (incoming.get(to) ?? 0) + 1);
  });

  const used = segs.map(() => false);
  const out: Point[][] = [];

  const walk = (start: number) => {
    const run: Point[] = [segs[start].a];
    let e = start;

    while (true) {
      used[e] = true;
      run.push(segs[e].b);

      const on = next.get(weld.id(segs[e].b));
      const step = on?.find(i => !used[i]);

      // A junction where several runs meet is where this one ends: which of
      // them carries on is a question about the whole outline, not about this
      // polygon, and nothing here needs the answer.
      if (step === undefined || (on !== undefined && on.length > 1)) break;

      e = step;
    }

    out.push(run);
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
 * A crossing is worked out twice — once as the split of each edge that runs
 * through it — and the two answers differ in their last bits. Rounding to a
 * grid is very nearly enough to reunite them, and fails exactly when the pair
 * straddles a cell boundary: then one crossing becomes two, a ring cannot be
 * stitched through it, and what comes out is the outline with a corner missing
 * or nothing at all.
 *
 * That is not the rare accident it looks. A cell boundary sits at a half, and
 * the coordinates this editor deals in — a grid snap, a drag quantised to a
 * pixel — divide into the cell size exactly and land on one, where a single ulp
 * decides which side each copy falls. Erosion depths taken off a slider put
 * roughly one in six of them there.
 *
 * So the cell is where to look rather than the answer: a point takes the
 * identity of anything already standing within `snap` of it, and starts a new
 * one only when there is nothing to join. Only a point near a wall can have a
 * twin on the other side of it, so only that one pays to look — which leaves
 * the common path at the single lookup it always was.
 */
function welder(snap: number): Welder {
  const cells = new Map<string, number[]>();
  const at: Point[] = [];

  const look = (cx: number, cy: number, p: Point): number | null => {
    for (const i of cells.get(`${cx},${cy}`) ?? []) {
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

      const key = `${cx},${cy}`;
      const here = cells.get(key);
      const i = at.length;

      at.push(p);

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

/**
 * The shape with each of `points` present as a vertex, splitting whatever edge
 * it lies on.
 *
 * The exception `cornersOnly` leaves room for. A corner the bake invented so
 * that both ends of a span could be written over the same ring sits exactly on
 * the edge between its neighbours at the end that does not have it — which is
 * to say it is not a corner there, and would be dropped. It has to survive
 * anyway: the ring changing length part way through a span is the one event
 * `spanning` exists to prevent, and without it a corner leaving jumps to the
 * wall rather than sliding onto it.
 *
 * So the bake asks for those back, by position, and gets a ring whose
 * combinatorics hold across the span while every other flat vertex is gone.
 * Anything that does not land on an edge is not put anywhere: an eroded ring
 * that has swallowed the edge a corner sat on genuinely does not have it.
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
