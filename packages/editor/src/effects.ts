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
// An effect is one amount over its whole ring, and one set of options: there
// is nothing here about single corners or edges.
//
// Edges are named by the drawn corner they start at. A deform's teeth are not
// drawn corners, so an edge runs from one drawn corner to the next, through
// whatever teeth lie between.
// -----------------------------------------------------------------------------

import { nextOf } from './geometry';
import { AmountKind } from './rig';
import { Resolved, diameterAt, scaleAt } from './scene';
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

/** A deform's first spacing, as a share of the size of what it goes on:
 * see `sizedFor`. */
export const FIRST_SPACING = 0.2;

/**
 * How big `id` is at `v` at its own scale: its diameter (`diameterAt`) taken
 * out of its scale (`scaleAt`), which is what a spacing is a length in. What
 * the pane shows a spacing against, and a first spacing is a share of.
 */
export function sizeOf(world: World, v: KeyframeId, id: Id): number {
  const k = scaleAt(world, id, v);

  return k > 0 ? diameterAt(world, v, id) / k : 0;
}

/**
 * `options` with the deform's spacing made to fit `ids` as they stand at `v`:
 * `FIRST_SPACING` of the biggest of them, whole. What a deform is given the
 * first time it goes on something, so that its teeth come out a size the
 * thing can carry however big it is drawn — the spacing last used was chosen
 * for something else. From there the spacing is a length, and a scale takes
 * the teeth along with it. Left alone where nothing stands.
 */
export function sizedFor(world: World, v: KeyframeId, ids: readonly Id[], options: Options): Options {
  const size = Math.max(0, ...ids.map(id => sizeOf(world, v, id)));

  if (!(size > 0)) return options;

  return { ...options, deform: { ...options.deform, spacing: Math.max(1, Math.round(FIRST_SPACING * size)) } };
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
