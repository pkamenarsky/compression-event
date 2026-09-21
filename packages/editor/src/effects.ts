// -----------------------------------------------------------------------------
// Editing effects
//
// Which effects a thing has is one fact about it over every keyframe, and how
// much is its timeline — see `Effects`. So there are two kinds of edit here:
// an effect switched on or off, which is the fact, and an amount written at a
// keyframe, which is an entry like any erosion. Switching one off takes
// nothing away: its options and its amounts stay, and apply again when it is
// switched back on.
//
// Erosion is the odd one: it has no options, so it applies unless switched
// off, and there is nothing to give it.
//
// Edges are named by the drawn corner they start at, which is the corner an
// edge's own amplitude is kept by. A deform's teeth are not drawn corners, so
// an edge runs from one drawn corner to the next, through whatever teeth lie
// between.
// -----------------------------------------------------------------------------

import { nextOf } from './geometry';
import { Amount, AmountKind, amountedBy, nextKey } from './rig';
import { Resolved, appended, keyRigOf, optionOf, withKeyRig } from './scene';
import { Effects, Id, KeyframeId, Options, Point, VertexId, World } from './types';

export type { AmountKind };

/** The effects with options. */
export type EffectName = keyof Options;

/** What a box in the pane switches: an effect, or the erosion. */
export type Switch = EffectName | 'erode';

/** Whether a switch applies to a thing: an effect it has, not switched off,
 * or its erosion, unless that is. */
export function applies(world: World, id: Id, name: Switch): boolean {
  const fx = world.effects.get(id);

  if (name === 'erode') return fx?.erode?.off !== true;

  return fx?.[name] !== undefined && fx[name].off !== true;
}

/** An effect's options on a thing, given or changed. */
export function withEffect<N extends EffectName>(world: World, id: Id, name: N, options: Options[N]): World {
  const effects = new Map(world.effects);

  effects.set(id, { ...world.effects.get(id), [name]: options });

  return { ...world, effects };
}

/**
 * A switch on for every one of `ids`: an effect it has switched back on with
 * its options as they were, one it has never had given `options`, and its
 * erosion let apply.
 */
export function switchedOn(world: World, ids: readonly Id[], name: Switch, options: Options): World {
  let w = world;

  for (const id of ids) {
    if (applies(w, id, name)) continue;

    const fx = w.effects.get(id);

    if (name === 'erode') {
      w = withEffects(w, id, { ...fx, erode: undefined });
    }
    else {
      const { off: _off, ...was } = fx?.[name] ?? options[name];

      w = withEffect(w, id, name, was as Options[typeof name]);
    }
  }

  return w;
}

/**
 * A switch off for every one of `ids`. Nothing is taken away: its options and
 * every amount in its timeline stay, to apply again when it is switched on.
 */
export function switchedOff(world: World, ids: readonly Id[], name: Switch): World {
  let w = world;

  for (const id of ids) {
    if (!applies(w, id, name)) continue;

    const fx = w.effects.get(id);

    w = name === 'erode'
      ? withEffects(w, id, { ...fx, erode: { off: true } })
      : withEffect(w, id, name, { ...fx![name]!, off: true } as Options[typeof name]);
  }

  return w;
}

/** A thing's effects replaced, and taken out of the map where none is left. */
function withEffects(world: World, id: Id, fx: Effects): World {
  const effects = new Map(world.effects);
  const kept = Object.fromEntries(Object.entries(fx).filter(([, v]) => v !== undefined)) as Effects;

  if (Object.keys(kept).length === 0) effects.delete(id);
  else effects.set(id, kept);

  return { ...world, effects };
}

// -----------------------------------------------------------------------------
// A corner's own round
//
// Over its polygon's, and switched on and off on its own: a corner can be
// left square on a rounded room, or rounded finer than the rest.
// Its polygon's round switched off leaves it square whatever it says itself.
// -----------------------------------------------------------------------------

/** The polygon each corner is on. */
function ownersOf(world: World, corners: readonly VertexId[]): Map<VertexId, Id> {
  const wanted = new Set(corners);
  const out = new Map<VertexId, Id>();

  for (const [id, polygon] of world.polygons) {
    for (const c of polygon.points) {
      if (wanted.has(c.id)) out.set(c.id, id);
    }
  }

  return out;
}

/** The round a corner would have were everything switched on: its own
 * options, or its polygon's. Nothing where neither has one. */
export function cornerRound(world: World, corner: VertexId): Options['round'] | undefined {
  const owner = ownersOf(world, [corner]).get(corner);
  const own = world.cornerEffects.get(corner)?.round;

  return own ?? (owner === undefined ? undefined : world.effects.get(owner)?.round);
}

/** Whether a corner is rounded: its round applies, switched off neither on
 * it nor on its polygon. */
export function cornerRounding(world: World, corner: VertexId): boolean {
  const owner = ownersOf(world, [corner]).get(corner);

  return owner !== undefined && optionOf(world.effects.get(owner), 'round', world.cornerEffects.get(corner)) !== undefined;
}

/** Whether a corner has options of its own. */
export function ownRound(world: World, corner: VertexId): boolean {
  return world.cornerEffects.get(corner)?.round !== undefined;
}

function withCornerRound(world: World, corner: VertexId, round: Options['round'] | undefined): World {
  const cornerEffects = new Map(world.cornerEffects);
  const { round: _was, ...rest } = cornerEffects.get(corner) ?? {};
  const now: Partial<Effects> = round === undefined ? rest : { ...rest, round };

  if (Object.keys(now).length === 0) cornerEffects.delete(corner);
  else cornerEffects.set(corner, now);

  return { ...world, cornerEffects };
}

/**
 * Corners rounded, or left square. On switches their polygons' round on —
 * given `options` where they have none — and their own back on where it was
 * off; off switches their own off, taking their polygon's options as their
 * own to keep, so that switched on again they are as they were.
 */
export function cornersSwitched(world: World, corners: readonly VertexId[], on: boolean, options: Options): World {
  const owners = ownersOf(world, corners);
  let w = on ? switchedOn(world, [...new Set(owners.values())], 'round', options) : world;

  for (const c of owners.keys()) {
    const round = cornerRound(w, c) ?? options.round;

    if (on) {
      if (ownRound(w, c) && round.off === true) w = withCornerRound(w, c, { ...round, off: false });
    }
    else {
      w = withCornerRound(w, c, { ...round, off: true });
    }
  }

  return w;
}

/** An option of corners' own rounds changed, starting from what each has
 * now: its own, its polygon's, or `options`. */
export function cornersOptioned(world: World, corners: readonly VertexId[], patch: Partial<Options['round']>, options: Options): World {
  let w = world;

  for (const c of ownersOf(world, corners).keys()) w = withCornerRound(w, c, { ...(cornerRound(w, c) ?? options.round), ...patch });

  return w;
}

/** Corners back to their polygon's round, their own options dropped. */
export function cornersInheriting(world: World, corners: readonly VertexId[]): World {
  return corners.reduce((w, c) => (ownRound(w, c) ? withCornerRound(w, c, undefined) : w), world);
}

/** An amount written at `v` about a whole thing, folded into the entry
 * before where the two are one. */
export function amountWritten(world: World, v: KeyframeId, id: Id, kind: AmountKind, by: number): World {
  return appended(world, v, id, { kind, by } satisfies Amount);
}

/**
 * An amount written at `v` about single corners of a polygon — or, for a
 * deform, the edges starting at them. Added to what `v` already said about
 * each. See `amounted`.
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

  let rig = keyRigOf(world, id);
  const made = nextKey(rig);

  for (const c of polygon.points) {
    if (corners.has(c.id)) rig = amountedBy(rig, made, kind, c.id, v, by);
  }

  return withKeyRig(world, id, rig);
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
