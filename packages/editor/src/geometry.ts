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

export type { Point };

/** A closed loop. The last point is *not* a repeat of the first. */
export type Ring = Point[];

/** A shape is any number of rings, filled by the nonzero winding rule. */
export type Shape = Ring[];

/** Which of the two operands a point is in, and what that means for the answer. */
export type Op = (a: boolean, b: boolean) => boolean;

export const OpUnion: Op = (a, b) => a || b;
export const OpSubtract: Op = (a, b) => a && !b;
export const OpIntersect: Op = (a, b) => a && b;
export const OpXor: Op = (a, b) => a !== b;

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
  return combine(a, [], (inA) => inA);
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

      if (a.y <= p.y) {
        if (b.y > p.y && cross(a, b, p) > 0) w++;
      }
      else {
        if (b.y <= p.y && cross(a, b, p) < 0) w--;
      }
    }
  }

  return w;
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

function segments(shape: Shape): Seg[] {
  const out: Seg[] = [];

  for (const ring of shape) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      if (a.x !== b.x || a.y !== b.y) out.push({ a, b });
    }
  }

  return out;
}

/**
 * Every segment cut at every point another segment touches it. Collinear
 * overlaps count: their endpoints are projected back onto each other so that a
 * shared edge ends up split identically on both sides.
 */
function split(segs: Seg[], eps: number): Seg[] {
  const ts: number[][] = segs.map(() => [0, 1]);

  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      intersectInto(segs[i], segs[j], ts[i], ts[j], eps);
    }
  }

  const out: Seg[] = [];

  for (let i = 0; i < segs.length; i++) {
    const { a, b } = segs[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    const tol = eps / Math.max(len, eps);

    const sorted = ts[i].sort((p, q) => p - q);
    const kept: number[] = [];

    for (const t of sorted) {
      if (kept.length === 0 || t - kept[kept.length - 1] > tol) kept.push(t);
    }

    for (let k = 0; k + 1 < kept.length; k++) {
      const t0 = kept[k], t1 = kept[k + 1];
      out.push({
        a: { x: a.x + dx * t0, y: a.y + dy * t0 },
        b: { x: a.x + dx * t1, y: a.y + dy * t1 },
      });
    }
  }

  return out;
}

/** Parameters at which `s` and `u` meet, appended to their respective lists. */
function intersectInto(s: Seg, u: Seg, ts: number[], us: number[], eps: number): void {
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

    addParam(ts, t0);
    addParam(ts, t1);

    const ss = sx * sx + sy * sy;
    addParam(us, (-qx * sx - qy * sy) / ss);
    addParam(us, (rx * sx + ry * sy - qx * sx - qy * sy) / ss);

    return;
  }

  const t = (qx * sy - qy * sx) / d;
  const u0 = (qx * ry - qy * rx) / d;

  // The lines always meet; the segments only do when both parameters land on
  // them. Without that check a segment would be cut where its neighbour's
  // *line* passes, which litters the result with points that are not corners.
  const tol = eps / Math.max(rl, sl, eps);
  if (t < -tol || t > 1 + tol || u0 < -tol || u0 > 1 + tol) return;

  addParam(ts, t);
  addParam(us, u0);
}

function addParam(ts: number[], t: number): void {
  if (t > 0 && t < 1) ts.push(t);
}

// -----------------------------------------------------------------------------
// Classification and chaining
// -----------------------------------------------------------------------------

/** Any of the above, and the only thing that actually does the work. */
export function combine(a: Shape, b: Shape, op: Op): Shape {
  const raw = [...segments(a), ...segments(b)];
  const scale = scaleOf(raw);
  const snap = scale * 1e-9;
  const segs = split(raw, snap);

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

    const inLeft = op(contains(a, left), contains(b, left));
    const inRight = op(contains(a, right), contains(b, right));

    if (inLeft === inRight) continue;

    // Orient so the answer's interior is on the left. Coincident edges of the
    // two operands land on the same directed segment and collapse to one.
    const dir = inLeft ? s : { a: s.b, b: s.a };
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
function chain(segs: Seg[], snap: number): Shape {
  const nodes: Point[] = [];
  const byKey = new Map<string, number>();

  const node = (p: Point): number => {
    const k = keyOf(p, snap);
    const found = byKey.get(k);
    if (found !== undefined) return found;

    const i = nodes.length;
    nodes.push(p);
    byKey.set(k, i);

    return i;
  };

  const from = segs.map(s => node(s.a));
  const to = segs.map(s => node(s.b));

  const out: number[][] = nodes.map(() => []);
  segs.forEach((_s, i) => out[from[i]].push(i));

  const used = segs.map(() => false);
  const rings: Shape = [];

  for (let start = 0; start < segs.length; start++) {
    if (used[start]) continue;

    const ring: Ring = [];
    let e = start;

    while (true) {
      used[e] = true;
      ring.push(nodes[from[e]]);

      const at = to[e];
      if (at === from[start] && ring.length > 1) break;

      const next = successor(e, at, out, used, nodes, from, to);
      if (next < 0) break;

      e = next;
    }

    if (ring.length >= 3 && Math.abs(signedArea2(ring)) > snap * snap) rings.push(ring);
  }

  return rings;
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
