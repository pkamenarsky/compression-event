// -----------------------------------------------------------------------------
// Editing effects
//
// Which effects a thing has is one fact about it over every keyframe, and how
// much is its timeline — see `Layer`. So there are two kinds of edit here: an
// effect switched on or off, which is the fact, and an amount written at a
// keyframe, which is an entry against the layer's id. Switching one off takes
// nothing away: its options and its amounts stay, and apply again when it is
// switched back on.
//
// The editor gives a thing at most one layer of each kind, deliberately: every
// layer is a step of the fold and a resample, and the bake pays for each, so a
// list is kept to three. A new one goes at the end, to be moved from there:
// see `reordered`. The format and the fold take any list — the laws are
// tested over the same kind twice — but here a layer is addressed by its
// kind, as `layerOf` finds it.
//
// Edges are named by the drawn corner they start at. A deform's teeth are not
// drawn corners, so an edge runs from one drawn corner to the next, through
// whatever teeth lie between.
// -----------------------------------------------------------------------------

import { nextOf } from './geometry';
import { AmountKind } from './rig';
import { Resolved, diameterAt, layerOf, layersOf, scaleAt } from './scene';
import { Id, KeyframeId, Layer, LayerId, Options, Point, VertexId, World } from './types';

export type { AmountKind };

/** The effects with options. */
export type EffectName = keyof Options;

/** What a box in the pane switches: an effect, or the erosion. */
export type Switch = AmountKind;

/** Whether a switch applies to a thing: a layer of that kind it has, not
 * switched off. */
export function applies(world: World, id: Id, name: Switch): boolean {
  const l = layerOf(world, id, name);

  return l !== undefined && l.off !== true;
}

/** An effect's options on a thing, given or changed: its first layer of that
 * kind, or a new one. */
export function withEffect<N extends EffectName>(world: World, id: Id, name: N, options: Options[N]): World {
  const l: Layer | undefined = layerOf(world, id, name as EffectName);

  if (l === undefined) return added(world, id, { kind: name, ...options } as Omit<Layer, 'id'>).world;

  return withLayer(world, id, { ...options, kind: name, id: l.id, ...(l.off === true ? { off: true } : {}) } as Layer);
}

/** A new layer at the end of a thing's list, with an id from the world's
 * counter. */
export function added(world: World, id: Id, layer: Omit<Layer, 'id'>): { world: World, layer: LayerId } {
  const made = { ...layer, id: world.nextId } as Layer;
  const list = [...layersOf(world, id), made];

  return { world: { ...world, nextId: world.nextId + 1, effects: new Map(world.effects).set(id, list) }, layer: made.id };
}

/**
 * Each of `ids`' layers put in the order of their kinds in `kinds`, the
 * layers of one kind keeping theirs, and a kind not named after every one
 * that is.
 */
export function reordered(world: World, ids: readonly Id[], kinds: readonly AmountKind[]): World {
  const rank = (l: Layer) => {
    const i = kinds.indexOf(l.kind);

    return i < 0 ? kinds.length : i;
  };
  let effects: Map<Id, readonly Layer[]> | undefined;

  for (const id of ids) {
    const layers = layersOf(world, id);
    const sorted = [...layers].sort((a, b) => rank(a) - rank(b));

    if (sorted.some((l, i) => l !== layers[i])) (effects ??= new Map(world.effects)).set(id, sorted);
  }

  // Left as it is where nothing moved, so that nothing reads it as an edit.
  return effects === undefined ? world : { ...world, effects };
}

/** One of a thing's layers replaced, by its id. */
function withLayer(world: World, id: Id, layer: Layer): World {
  const list = layersOf(world, id).map(l => (l.id === layer.id ? layer : l));

  return { ...world, effects: new Map(world.effects).set(id, list) };
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
 * A switch on for every one of `ids`: a layer it has switched back on with its
 * options as they were, and one it has never had given `options`.
 */
export function switchedOn(world: World, ids: readonly Id[], name: Switch, options: Options): World {
  let w = world;

  for (const id of ids) {
    if (applies(w, id, name)) continue;

    const l = layerOf(w, id, name);

    if (l !== undefined) {
      const { off: _off, ...on } = l;

      w = withLayer(w, id, on as Layer);
    }
    else {
      w = added(w, id, (name === 'erode' ? { kind: 'erode' } : { kind: name, ...options[name] }) as Omit<Layer, 'id'>).world;
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

    w = withLayer(w, id, { ...layerOf(w, id, name)!, off: true });
  }

  return w;
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
