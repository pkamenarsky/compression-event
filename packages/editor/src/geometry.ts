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
import { AABB, Tree, box, build, each, expand } from './aabb';

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

/** `simplify`, keeping provenance. Both operand slots of a tag name shape 0. */
export function simplifyTagged(a: Shape): TaggedShape {
  return combineTagged(a, [], inA => inA);
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

function segments(shape: Shape, which: 0 | 1): Seg[] {
  const out: Seg[] = [];

  for (let r = 0; r < shape.length; r++) {
    const ring = shape[r];

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
 */
function split(segs: Seg[], eps: number): Seg[] {
  const ts: Param[][] = segs.map(s => [{ t: 0, tag: s.ta }, { t: 1, tag: s.tb }]);

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

  for (let i = 0; i < segs.length; i++) {
    near.length = 0;
    each(tree, boxes[i].box, j => {
      if (j > i) near.push(j);
    });

    // In index order, so the pairs are visited exactly as the nested loops
    // visited them. Points that land within a hair of each other collapse onto
    // whichever arrived first, so the order is not quite free to change.
    near.sort((x, y) => x - y);

    for (const j of near) intersectInto(segs[i], segs[j], ts[i], ts[j], eps);
  }

  const out: Seg[] = [];

  for (let i = 0; i < segs.length; i++) {
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
      out.push({
        a: { x: a.x + dx * t0.t, y: a.y + dy * t0.t },
        b: { x: a.x + dx * t1.t, y: a.y + dy * t1.t },
        edge: segs[i].edge,
        ta: t0.tag,
        tb: t1.tag,
      });
    }
  }

  return out;
}

/** Parameters at which `s` and `u` meet, appended to their respective lists. */
function intersectInto(s: Seg, u: Seg, ts: Param[], us: Param[], eps: number): void {
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
    addParam(us, (-qx * sx - qy * sy) / ss, s.ta);
    addParam(us, (rx * sx + ry * sy - qx * sx - qy * sy) / ss, s.tb);

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
  const scale = scaleOf(raw);
  const snap = scale * 1e-9;
  const segs = split(raw, snap);

  // Prepared once and asked four times per segment, which is the whole reason
  // they exist.
  const fa = field(a), fb = field(b);

  const kept: Seg[] = [];
  const seen = new Set<string>();

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

    const inLeft = op(fill(fa, left), fill(fb, left));
    const inRight = op(fill(fa, right), fill(fb, right));

    if (inLeft === inRight) continue;

    // Orient so the answer's interior is on the left. Coincident edges of the
    // two operands land on the same directed segment and collapse to one.
    const dir: Seg = inLeft
      ? s
      : { a: s.b, b: s.a, edge: s.edge, ta: s.tb, tb: s.ta };
    const key = keyOf(dir.a, snap) + '|' + keyOf(dir.b, snap);

    if (seen.has(key)) continue;

    seen.add(key);
    kept.push(dir);
  }

  return chain(kept, snap);
}

function keyOf(p: Point, snap: number): string {
  return `${Math.round(p.x / snap)},${Math.round(p.y / snap)}`;
}

/**
 * Kept segments back into rings. Where more than two edges meet, the successor
 * is the sharpest left turn available: with the interior on the left, hugging
 * it traces each face separately instead of driving straight through the
 * crossing and coming back out as one self-intersecting loop.
 */
function chain(segs: Seg[], snap: number): TaggedShape {
  const nodes: Point[] = [];
  const tags: Tag[] = [];
  const byKey = new Map<string, number>();

  const node = (p: Point, tag: Tag): number => {
    const k = keyOf(p, snap);
    const found = byKey.get(k);

    if (found !== undefined) {
      tags[found] = betterTag(tags[found], tag);
      return found;
    }

    const i = nodes.length;
    nodes.push(p);
    tags.push(tag);
    byKey.set(k, i);

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
      rings.push(ring);
      ringTags.push(ringTag);
    }
  }

  return { rings, tags: ringTags };
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
