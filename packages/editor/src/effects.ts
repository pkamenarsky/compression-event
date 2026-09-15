// -----------------------------------------------------------------------------
// Editing effects
//
// Which effects a thing has is one fact about it over every keyframe, and how
// much is its timeline — see `Effects`. So there are two kinds of edit here:
// an effect given or taken away, which is the fact, and an amount written at a
// keyframe, which is an entry like any erosion. Taking an effect away drops
// every entry of its kind with it, since an amount of an effect a thing does
// not have is a number waiting to surprise whoever gives it back.
//
// Erosion is the odd one: it has no options, so there is nothing to give, and
// a thing is eroded exactly when something in its timeline says so. Taking it
// away is the same drop.
//
// Edges are named by the drawn corner they start at, which is the corner an
// edge's own amplitude is kept by. A deform's teeth are not drawn corners, so
// an edge runs from one drawn corner to the next, through whatever teeth lie
// between.
// -----------------------------------------------------------------------------

import { nextOf } from './geometry';
import { Amount, Entry, Rig, Stand, cornerMapOf, cornerRounded, deepened, edgeDeformed } from './rig';
import { Resolved, appended, rigOf, withRig } from './scene';
import { Effects, Id, KeyframeId, Point, VertexId, World } from './types';

export type AmountKind = Amount['kind'];

export type EffectName = keyof Effects;

/** Whether a thing has an effect. */
export function hasEffect(world: World, id: Id, name: EffectName): boolean {
  return world.effects.get(id)?.[name] !== undefined;
}

/** An effect's options on a thing, given or changed. */
export function withEffect<N extends EffectName>(world: World, id: Id, name: N, options: Required<Effects>[N]): World {
  const effects = new Map(world.effects);

  effects.set(id, { ...world.effects.get(id), [name]: options });

  return { ...world, effects };
}

/** An effect given to every one of `ids` that does not have it yet, with
 * `options`. Those that have it keep theirs. */
export function givenEffect<N extends EffectName>(world: World, ids: readonly Id[], name: N, options: Required<Effects>[N]): World {
  return ids.reduce((w, id) => (hasEffect(w, id, name) ? w : withEffect(w, id, name, options)), world);
}

/**
 * An effect taken off a thing: its options, its corners' own, and every
 * amount of it written anywhere in its timeline.
 */
export function withoutEffect(world: World, id: Id, name: EffectName): World {
  let w = dropped(world, id, name);

  const fx = w.effects.get(id);

  if (fx?.[name] !== undefined) {
    const effects = new Map(w.effects);
    const rest = lacking(fx, name);

    if (rest === null) effects.delete(id);
    else effects.set(id, rest);

    w = { ...w, effects };
  }

  const corners = w.polygons.get(id)?.points ?? [];

  if (corners.some(c => w.cornerEffects.get(c.id)?.[name] !== undefined)) {
    const cornerEffects = new Map(w.cornerEffects);

    for (const c of corners) {
      const own = cornerEffects.get(c.id);

      if (own?.[name] === undefined) continue;

      const rest = lacking(own, name);

      if (rest === null) cornerEffects.delete(c.id);
      else cornerEffects.set(c.id, rest);
    }

    w = { ...w, cornerEffects };
  }

  return w;
}

/** Options without one effect's, or nothing where that was all there was. */
function lacking(fx: Partial<Effects>, name: EffectName): Effects | null {
  const rest: Effects = { ...fx };

  delete rest[name];

  return rest.round === undefined && rest.deform === undefined ? null : rest;
}

/** Whether anything in a thing's timeline erodes it, itself or a corner. */
export function eroded(world: World, id: Id): boolean {
  return amounts(rigOf(world, id), 'erode');
}

/** Every erosion a thing has written about it taken out. */
export function unEroded(world: World, id: Id): World {
  return dropped(world, id, 'erode');
}

/** Whether a rig has an amount of a kind anywhere: an entry, a corner's, or
 * a stand's. */
function amounts(rig: Rig, kind: AmountKind): boolean {
  const map = cornerMapOf(kind);

  for (const list of rig.keys.values()) {
    for (const e of list) {
      if (e.op.kind === kind) return true;
      if (e.op.kind === 'stand' && standing(e.op, kind)) return true;
    }
  }

  return rig[map].size > 0;
}

/** Whether a stand holds any of an amount. */
function standing(op: Stand, kind: AmountKind): boolean {
  if (kind === 'erode') return op.erosion !== 0 || op.depths.size > 0;
  if (kind === 'round') return op.radius !== 0 || op.radii.size > 0;

  return op.amplitude !== 0 || op.amplitudes.size > 0;
}

/** Every amount of a kind out of a thing's timeline: its entries, its
 * corners', and what its stands hold of it. */
function dropped(world: World, id: Id, kind: AmountKind): World {
  const rig = rigOf(world, id);

  if (!amounts(rig, kind)) return world;

  const keys = new Map<KeyframeId, readonly Entry[]>();

  for (const [k, list] of rig.keys) {
    const kept = list
      .filter(e => e.op.kind !== kind)
      .map(e => (e.op.kind === 'stand' && standing(e.op, kind) ? { ...e, op: unstood(e.op, kind) } : e));

    if (kept.length > 0) keys.set(k, kept);
  }

  return withRig(world, id, { ...rig, keys, [cornerMapOf(kind)]: new Map() });
}

function unstood(op: Stand, kind: AmountKind): Stand {
  if (kind === 'erode') return { ...op, erosion: 0, depths: new Map() };
  if (kind === 'round') return { ...op, radius: 0, radii: new Map() };

  return { ...op, amplitude: 0, amplitudes: new Map() };
}

/** An amount written at `v` about a whole thing, folded into the entry
 * before where the two are one. */
export function amountWritten(world: World, v: KeyframeId, id: Id, kind: AmountKind, by: number): World {
  return appended(world, v, id, { kind, by } as Amount);
}

/**
 * An amount written at `v` about single corners of a polygon — or, for a
 * deform, the edges starting at them. Added to what `v` already said about
 * each. See `deepened`.
 */
export function cornersAmounted(
  world: World,
  v: KeyframeId,
  id: Id,
  kind: AmountKind,
  corners: ReadonlySet<VertexId>,
  by: number,
): World {
  const polygon = world.polygons.get(id);

  if (polygon === undefined || by === 0) return world;

  const write = kind === 'erode' ? deepened : kind === 'round' ? cornerRounded : edgeDeformed;
  let rig = rigOf(world, id);

  for (const c of polygon.points) {
    if (corners.has(c.id)) rig = write(rig, c.id, v, by);
  }

  return withRig(world, id, rig);
}

// -----------------------------------------------------------------------------
// Edges
// -----------------------------------------------------------------------------

/** The edge the `index`-th source edge of `it` is part of, by the drawn corner
 * it starts at: a tooth's edge is its root's. */
export function edgeOf(it: Resolved, index: number): VertexId {
  const c = it.corners[index];

  return c.root ?? c.id;
}

/**
 * Where an edge runs in `it`'s source, from its drawn corner to the next,
 * teeth included, as indices. Nothing where `it` has no such corner standing.
 */
export function edgeRun(it: Resolved, from: VertexId): number[] {
  const start = it.corners.findIndex(c => c.id === from);

  if (start < 0) return [];

  const n = it.corners.length;
  const out = [start];
  let i = nextOf(it.rings, n, start);

  while (it.corners[i].root !== undefined && i !== start) {
    out.push(i);
    i = nextOf(it.rings, n, i);
  }

  out.push(i);

  return out;
}

/** The drawn corners an edge joins, or nothing where it is not standing. */
export function edgeEnds(it: Resolved, from: VertexId): [VertexId, VertexId] | null {
  const run = edgeRun(it, from);

  return run.length < 2 ? null : [it.corners[run[0]].id, it.corners[run[run.length - 1]].id];
}

/** Both ends of every edge named, among `items`. */
export function endsOf(items: readonly Resolved[], edges: readonly VertexId[]): VertexId[] {
  const named = new Set(edges);
  const out = new Set<VertexId>();

  for (const it of items) {
    for (const c of it.corners) {
      if (!named.has(c.id)) continue;

      const ends = edgeEnds(it, c.id);

      if (ends !== null) ends.forEach(e => out.add(e));
    }
  }

  return [...out];
}

/** The edges both of whose ends are among `corners`: what a pick of corners
 * says about edges, the way picking both anchors of a segment picks it. */
export function edgesBetween(items: readonly Resolved[], corners: readonly VertexId[]): VertexId[] {
  const picked = new Set(corners);
  const out: VertexId[] = [];

  for (const it of items) {
    for (const c of it.corners) {
      if (!picked.has(c.id)) continue;

      const ends = edgeEnds(it, c.id);

      if (ends !== null && ends[0] !== ends[1] && picked.has(ends[1])) out.push(c.id);
    }
  }

  return out;
}

/** Every drawn edge of `items` lying wholly inside the box. */
export function edgesWithinBox(items: readonly Resolved[], a: Point, b: Point): VertexId[] {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  const inside = (p: Point) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
  const out: VertexId[] = [];

  for (const it of items) {
    it.corners.forEach((c, i) => {
      if (c.root !== undefined) return;

      const run = edgeRun(it, c.id);

      if (run.length >= 2 && inside(it.source[i]) && inside(it.source[run[run.length - 1]])) out.push(c.id);
    });
  }

  return out;
}
