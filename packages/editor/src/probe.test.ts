// -----------------------------------------------------------------------------
// Does every signature change have geometry behind it?
//
// The question the analytic route rests on. `bake.ts` files one reason the old
// event search was abandoned as *not every change in the output is a change in
// the geometry* — the CSG's run decomposition shifting with no coincidence near
// it — and `divergence.test.ts` names six overlapping boxes as where that was
// seen. Whether it is true decides whether an analytic cut can ever be complete,
// so it is measured.
//
// How a change is interrogated
// ----------------------------
// A span is sampled densely and every instant where `signature` changes is
// bisected to where two adjacent doubles disagree. Then the *names* are diffed,
// and each name that appeared or disappeared is asked whether its own degeneracy
// holds at that instant:
//
// - A crossing `x A|B` can only appear or vanish by passing through an end of A
//   or of B. So one of those four endpoints is on the other segment, and the
//   distance from it says so.
// - A vertex `v C` can only join or leave the outline by crossing somebody
//   else's edge. So `C` is on some other polygon's edge.
//
// Both are absolute readings at one instant. Nothing is compared across two, and
// that matters: the eroded shape comes out of an arrangement, an arrangement
// keeps no names, and index `k` of a ring is a different corner either side of an
// event. Comparing signs across the bracket — the obvious thing, and the first
// thing tried here — reads that re-cutting as evidence and reports every event as
// unexplained.
//
// A residual is a distance in world units, and the geometry is moving, so it can
// only be as small as the bisection is tight. `LOOSE` is where a residual stops
// being rounding and starts being a claim that nothing was there.
// -----------------------------------------------------------------------------

import { Point } from '@ce/game/world';
import { expect, test } from 'vitest';
import { Frame, Origin, probed } from './bake';
import { Shape } from './geometry';
import { TOP, addPolygon, editAt, resolveAt, withEdit } from './scene';
import { Id, PolygonId, PolygonKind, Transform, VersionId, World, emptyWorld } from './types';

/**
 * How near an endpoint has to sit to the thing it is supposed to be on before
 * the degeneracy counts as holding.
 *
 * A residual is a distance in world units and the geometry is moving, so it can
 * only ever be as small as the bisection is tight — and two events landing in
 * one bracket leave the second one's residual at whatever the first one's
 * bisection stopped at. Six orders under the extent of these levels, which is
 * some four hundred units. The margin is reported either way, because a
 * threshold nobody can see the distance to is a threshold doing the arguing.
 */
const LOOSE = 1e-3;

const kind = (k: string): PolygonKind => ({
  type: 'level',
  op: k === 'solid' ? 'subtract' : 'add',
});

function rect(x: number, y: number, w: number, h: number): Point[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

function transformed(world: World, v: VersionId, id: PolygonId, t: Partial<Transform>): World {
  const it = resolveAt(world, v).find(r => r.id === id)!;
  const edit = editAt(world, v, id, it.erosion);

  return withEdit(world, v, id, { ...edit, transform: { ...edit.transform, ...t } });
}

// -----------------------------------------------------------------------------
// Names
// -----------------------------------------------------------------------------

interface Ref {
  id: number
  ring: number
  index: number
}

type Name =
  | { kind: 'vertex', at: Ref }
  | { kind: 'cross', a: Ref, b: Ref };

function named(o: Origin): Name {
  return o.kind === 'vertex' ? { kind: 'vertex', at: o.at } : { kind: 'cross', a: o.a, b: o.b };
}

function spell(n: Name): string {
  const ref = (r: Ref) => `${r.id}.${r.ring}.${r.index}`;

  return n.kind === 'vertex' ? `v${ref(n.at)}` : `x${ref(n.a)}|${ref(n.b)}`;
}

/** `signature` in `bake.ts`, transcribed: a set of names per run. */
function signature(frame: Frame): string {
  return frame
    .map(r => `${r.id}:${[...new Set(r.whence.map(o => spell(named(o))))].sort().join(',')}`)
    .sort()
    .join(' ');
}

/**
 * Every name the frame holds, per polygon, with the run boundaries taken out.
 * What a repartition leaves alone and an event does not.
 *
 * Keyed by the polygon whose share of the boundary the name is *on*, not by the
 * name alone. A crossing belongs to both of the polygons that make it, and it
 * can leave one of their outlines while staying on the other's — which is a real
 * event, and pooling the two together hides it. Doing exactly that is what made
 * the first pass of this report a third of its changes as unexplained
 * repartitions when every one of them had geometry behind it.
 */
function pooled(frame: Frame): Map<string, Name> {
  const out = new Map<string, Name>();

  for (const r of frame) {
    for (const o of r.whence) {
      const n = named(o);

      out.set(`${r.id}|${spell(n)}`, n);
    }
  }

  return out;
}

/** Which ids have any boundary at all. A birth or a death shows up here and
 * nowhere else. */
function living(frame: Frame): string {
  return [...new Set(frame.map(r => r.id))].sort((p, q) => p - q).join(',');
}

// -----------------------------------------------------------------------------
// Degeneracies
// -----------------------------------------------------------------------------

function dist(p: Point, q: Point): number {
  return Math.hypot(p.x - q.x, p.y - q.y);
}

function toSeg(p: Point, a: Point, b: Point): number {
  const ux = b.x - a.x, uy = b.y - a.y;
  const len = ux * ux + uy * uy;

  if (len === 0) return dist(p, a);

  const u = Math.min(1, Math.max(0, ((p.x - a.x) * ux + (p.y - a.y) * uy) / len));

  return dist(p, { x: a.x + ux * u, y: a.y + uy * u });
}

/** Where two segments cross, or null where they do not. */
function meeting(a: Point, b: Point, c: Point, d: Point): Point | null {
  const ux = b.x - a.x, uy = b.y - a.y;
  const vx = d.x - c.x, vy = d.y - c.y;
  const det = ux * vy - uy * vx;

  if (det === 0) return null;

  const s = ((c.x - a.x) * vy - (c.y - a.y) * vx) / det;

  return { x: a.x + ux * s, y: a.y + uy * s };
}

/** How near `p` is to the boundary of any polygon but the ones named. */
function buried(shapes: Map<Id, Shape>, p: Point, but: readonly number[]): number {
  let best = Infinity;

  for (const [id, shape] of shapes) {
    if (but.includes(id)) continue;

    for (const ring of shape) {
      for (let i = 0; i < ring.length; i++) {
        best = Math.min(best, toSeg(p, ring[i], ring[(i + 1) % ring.length]));
      }
    }
  }

  return best;
}

/** The edge a `Ref` names, in the shapes of the instant its name came from. */
function edgeAt(shapes: Map<Id, Shape>, r: Ref): [Point, Point] | null {
  const ring = shapes.get(r.id)?.[r.ring];

  if (ring === undefined || ring.length < 2) return null;

  return [ring[r.index % ring.length], ring[(r.index + 1) % ring.length]];
}

function cornerAt(shapes: Map<Id, Shape>, r: Ref): Point | null {
  const ring = shapes.get(r.id)?.[r.ring];

  return ring === undefined || ring.length === 0 ? null : ring[r.index % ring.length];
}

/**
 * How near the name is to the degeneracy that is the only way it can arrive or
 * leave, and which degeneracy that was.
 *
 * `how` is the useful half: it is the catalogue of conditions an analytic cut
 * would have to solve, read off the events that actually happen rather than
 * guessed at. `corner-edge` is `incident.ts` as it stands. `three-lines` is not
 * — it is a third polygon's edge arriving over the crossing of two others, and
 * it wants a determinant of three edge lines rather than a cross product of two.
 */
interface Why {
  at: number
  how: string
}

function residual(shapes: Map<Id, Shape>, n: Name): Why {
  if (n.kind === 'cross') {
    const a = edgeAt(shapes, n.a), b = edgeAt(shapes, n.b);

    if (a === null || b === null) return { at: Infinity, how: 'unresolvable' };

    // Through an end of one or the other, which is how a crossing of two
    // straight segments stops being a crossing at all.
    const ends = Math.min(
      toSeg(a[0], b[0], b[1]),
      toSeg(a[1], b[0], b[1]),
      toSeg(b[0], a[0], a[1]),
      toSeg(b[1], a[0], a[1]),
    );

    // Or the crossing stays a crossing and stops being on the *outline*: a third
    // polygon's boundary arrives over it and buries it, or leaves and exposes
    // it. That is three curves through one point, and it is the case the first
    // pass of this missed — three changes came back unexplained with residuals
    // of eight and seventeen units, all of them this.
    const p = meeting(a[0], a[1], b[0], b[1]);
    const third = p === null ? Infinity : buried(shapes, p, [n.a.id, n.b.id]);

    return ends <= third
      ? { at: ends, how: 'corner-edge' }
      : { at: third, how: 'three-lines' };
  }

  const p = cornerAt(shapes, n.at);

  if (p === null) return { at: Infinity, how: 'unresolvable' };

  // Onto or off somebody else's edge, which is the only way a corner joins or
  // leaves the outline.
  return { at: buried(shapes, p, [n.at.id]), how: 'corner-edge' };
}

// -----------------------------------------------------------------------------

/** One case interrogated: how many changes, and how many of them had geometry.
 * Returns the ones it could not account for. */
function interrogate(label: string, m: World, N: number): string[] {
  const sig: string[] = [];

  for (let i = 0; i <= N; i++) sig.push(signature(probed(m, 0, i / N).frame));

  const brackets: [number, number][] = [];

  for (let i = 0; i < N; i++) if (sig[i] !== sig[i + 1]) brackets.push([i / N, (i + 1) / N]);

  const tally = new Map<string, number>();
  const trouble: string[] = [];
  const margins: number[] = [];
  const catalogue = new Map<string, number>();

  for (const [lo0, hi0] of brackets) {
    let lo = lo0, hi = hi0;
    const was = signature(probed(m, 0, lo).frame);

    for (let k = 0; k < 60 && hi - lo > 1e-15; k++) {
      const mid = (lo + hi) / 2;

      if (signature(probed(m, 0, mid).frame) === was) lo = mid;
      else hi = mid;
    }

    const before = probed(m, 0, lo), after = probed(m, 0, hi);
    const pa = pooled(before.frame), pb = pooled(after.frame);

    // A name that went is read in the instant that had it, and one that came in
    // the instant that has it: the indices are only meaningful there.
    const moved: { what: string, why: Why }[] = [];

    for (const [key, n] of pa) {
      if (!pb.has(key)) moved.push({ what: `-${key}`, why: residual(before.shapes, n) });
    }

    for (const [key, n] of pb) {
      if (!pa.has(key)) moved.push({ what: `+${key}`, why: residual(after.shapes, n) });
    }

    const born = living(before.frame) !== living(after.frame);
    const worst = moved.length === 0 ? Infinity : Math.max(...moved.map(x => x.why.at));

    const kind = born
      ? 'birth/death'
      : moved.length === 0
        ? 'REPARTITION — no name moved'
        : worst <= LOOSE
          ? 'explained'
          : 'UNEXPLAINED — a name moved with no degeneracy';

    tally.set(kind, (tally.get(kind) ?? 0) + 1);

    if (kind === 'explained') {
      margins.push(worst);

      for (const x of moved) catalogue.set(x.why.how, (catalogue.get(x.why.how) ?? 0) + 1);
    }

    if (kind.startsWith('REPARTITION') || kind.startsWith('UNEXPLAINED')) {
      const runs = (f: Frame) => f
        .map(r => `${r.id}[${r.whence.map(o => spell(named(o))).join(' ')}]`)
        .sort()
        .join('\n            ');

      trouble.push(`    t=${hi.toFixed(12)}  ${kind}\n` +
        (moved.length === 0
          ? `        before: ${runs(before.frame)}\n        after:  ${runs(after.frame)}`
          : moved.map(x =>
            `        ${x.what}  ${x.why.how} residual ${x.why.at.toExponential(2)}`).join('\n')));
    }
  }

  margins.sort((p, q) => p - q);

  const parts = [...tally]
    .sort((p, q) => q[1] - p[1])
    .map(([k, n]) => `${n} ${k.split(' —')[0]}`)
    .join(', ');

  console.log(`${label.padEnd(34)} ${String(brackets.length).padStart(4)} changes  ${parts}`);

  if (margins.length > 0) {
    console.log(`${' '.repeat(34)}      residual median ${
      margins[margins.length >> 1].toExponential(1)}  worst ${
      margins[margins.length - 1].toExponential(1)}  by ${
      [...catalogue].sort((p, q) => q[1] - p[1]).map(([k, n]) => `${n} ${k}`).join(', ')}`);
  }

  for (const t of trouble.slice(0, Number(process.env.SHOW ?? 4))) console.log(t);

  return trouble;
}

function drawn(...specs: [string, Point[]][]): { world: World, ids: PolygonId[] } {
  let world = emptyWorld();
  const ids: PolygonId[] = [];

  for (const [type, points] of specs) {
    const added = addPolygon(world, kind(type), points, 0, TOP);

    world = added.world;
    ids.push(added.id);
  }

  return { world, ids };
}

function boxes(): { world: World, ids: PolygonId[] } {
  let world = emptyWorld();
  const ids: PolygonId[] = [];

  for (let i = 0; i < 6; i++) {
    const a = addPolygon(
      world,
      kind(i % 3 === 2 ? 'solid' : 'level'),
      rect(-140 + 60 * i, -90 + 40 * (i % 3), 150, 130),
      0,
      TOP,
    );

    world = a.world;
    ids.push(a.id);
  }

  return { world, ids };
}

test('every signature change, and what was near it', () => {
  const N = Number(process.env.N ?? 4000);
  const trouble: string[] = [];

  {
    const { world, ids } = boxes();

    let e = world, r = world, m = world;

    ids.forEach((id, i) => {
      e = transformed(e, 1, id, { erosion: 4 * i });
      r = transformed(r, 1, id, { rotation: (i % 2 ? 1 : -1) * (0.2 + 0.15 * i) });
      m = transformed(m, 1, id, {
        rotation: (i % 2 ? 1 : -1) * (0.2 + 0.15 * i),
        erosion: 4 * i,
        translation: { x: 10 * i - 20, y: 6 * i },
      });
    });

    trouble.push(...interrogate('six boxes, eroding only', e, N));
    trouble.push(...interrogate('six boxes, turning only', r, N));
    trouble.push(...interrogate('six boxes, all moving', m, N));
  }

  {
    const { world, ids } = drawn(
      ['level', rect(-200, -60, 400, 120)],
      ['level', rect(-40, -200, 80, 400)],
    );

    trouble.push(...interrogate(
      'pillar turning in a wall',
      transformed(world, 1, ids[1], { rotation: Math.PI / 3 }),
      N,
    ));
  }

  {
    const { world, ids } = drawn(
      ['level', rect(-300, -40, 200, 80)],
      ['level', rect(-100, -200, 80, 400)],
    );

    trouble.push(...interrogate(
      'sliding and turning',
      transformed(world, 1, ids[0], { translation: { x: 240, y: 0 }, rotation: 0.6 }),
      N,
    ));
  }

  {
    // The one case the analytic model is known not to cover: a nudge in flight
    // turns the corner angle, so the mitre turns with it and a corner's path is
    // no longer the lerp of its two ends. See `incident.ts`.
    const { world, ids } = drawn(['level', rect(0, 0, 120, 120)]);
    const it = resolveAt(world, 1).find(r => r.id === ids[0])!;
    const edit = editAt(world, 1, ids[0], 0);
    const vertices = new Map(edit.vertices);

    vertices.set(it.polygon.points[2].id, { x: 90, y: 40 });

    const nudged = withEdit(world, 1, ids[0], { ...edit, vertices });

    trouble.push(...interrogate(
      'nudge, erode and turn',
      transformed(nudged, 1, ids[0], { erosion: 22, rotation: 0.4 }),
      N,
    ));
  }

  // The premise, asserted. Every change the CSG's signature makes has a
  // coincidence sitting on it, so an analytic cut has something to solve for at
  // every one of them. A failure here says the opposite, and is the finding —
  // print it and read what it says about the change it could not account for.
  expect(trouble).toEqual([]);
}, 3_600_000);
