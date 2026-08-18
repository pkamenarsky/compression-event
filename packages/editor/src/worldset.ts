// -----------------------------------------------------------------------------
// The game world polygon set, kept up to date incrementally
//
// What the game wants is one set of rings: every `level` polygon unioned, with
// every `solid` polygon taken back out. Computing that costs O(n²) in edges, so
// doing it for the whole world after each nudge of a vertex is out.
//
// The way out is that polygons which cannot touch cannot affect each other.
// Split the input into clusters — connected components of the "their boxes
// overlap" graph — and the answer is the disjoint union of each cluster's own
// CSG. An edit can only change the clusters its polygon's box reaches, before
// and after the edit, so everything else keeps the rings it already had.
//
// Hence the diff. An edit returns the new set together with exactly which
// output rings died and which were born, which is what a renderer or a physics
// body list wants to hear rather than "here, all of it again".
//
// Everything is immutable. The tree shares structure with the version it came
// from; the bookkeeping maps are copied, which is O(n) in polygons and nothing
// at all next to the CSG it saves.
//
// What the caller owns, and what this owns
// ----------------------------------------
// Source polygons are the caller's, ids and all. They are kept exactly as they
// came in — `entry(set, id).source` gives back the same points that went in,
// which is what the editor draws handles on and hands to the next edit. The
// simplified copy used for the CSG sits beside it and is nobody's business but
// this module's.
//
// Output rings are ours, and so are their ids. `Id` and `PieceId` are separate
// namespaces that never meet: a piece id is minted here, handed out in a diff,
// and only ever means "that ring". The two can hold the same number without
// anything going wrong, because nothing ever compares one to the other — but
// the consumer that keeps a wall mesh per piece id should keep it in a map of
// its own, not one shared with source polygons.
// -----------------------------------------------------------------------------

import { PolygonType } from '@ce/game/world';
import { AABB, Tree, each, emptyTree, ofRings } from './aabb';
import { OpSubtract, Ring, Shape, combine, simplify } from './geometry';
import * as aabb from './aabb';

/** A source polygon, named by the caller. */
export type Id = number;

/**
 * An output ring, named here. Minted fresh, never reused: a ring that comes
 * back byte for byte through an edit keeps its id, and one that changes at all
 * gets a new one. Distinct from `Id` in meaning, though not in type — brand
 * both if the compiler should enforce it.
 */
export type PieceId = number;

/** `floor` and anything else is scenery: it is not part of the set. */
export type Kind = 'level' | 'solid';

export interface Entry {
  id: Id
  kind: Kind
  /** The points that came in, untouched. The editor's to draw and to edit. */
  source: Shape
  /** The same polygon simplified — outer rings counter-clockwise, holes
   * clockwise, no self-intersections — which is what the CSG runs on. */
  shape: Shape
  /** Of `source`, so it covers `shape` too. */
  box: AABB
}

/** One ring of the result, with an id that survives as long as the ring does. */
export interface Piece {
  id: PieceId
  ring: Ring
}

/**
 * What changed. `removed` names pieces handed out earlier that are gone;
 * `inserted` are new. A piece that came through an edit unchanged appears in
 * neither, even when the cluster around it was recomputed.
 */
export interface Diff {
  removed: PieceId[]
  inserted: Piece[]
}

export interface Change {
  set: WorldSet
  diff: Diff
}

interface Cluster {
  members: Id[]
  pieces: Piece[]
}

export interface WorldSet {
  entries: Map<Id, Entry>
  tree: Tree
  clusters: Map<number, Cluster>
  /** Which cluster an input polygon currently belongs to. */
  owner: Map<Id, number>
  nextCluster: number
  nextPiece: PieceId
}

export type Edit =
  | { op: 'insert', id: Id, type: PolygonType, shape: Shape }
  | { op: 'update', id: Id, shape: Shape }
  | { op: 'remove', id: Id };

export const emptyWorldSet: WorldSet = {
  entries: new Map(),
  tree: emptyTree,
  clusters: new Map(),
  owner: new Map(),
  nextCluster: 1,
  nextPiece: 1,
};

// -----------------------------------------------------------------------------
// Reading the result
// -----------------------------------------------------------------------------

export function pieces(set: WorldSet): Piece[] {
  const out: Piece[] = [];

  for (const c of set.clusters.values()) out.push(...c.pieces);

  return out;
}

/** The whole set as one shape, ready for `contains` and friends. */
export function shape(set: WorldSet): Shape {
  return pieces(set).map(p => p.ring);
}

export function entry(set: WorldSet, id: Id): Entry | undefined {
  return set.entries.get(id);
}

/** Input polygons whose box overlaps `b` — picking, marquee selection, hover. */
export function overlapping(set: WorldSet, b: AABB): Id[] {
  return aabb.search(set.tree, b);
}

// -----------------------------------------------------------------------------
// Editing
// -----------------------------------------------------------------------------

export function insert(set: WorldSet, id: Id, type: PolygonType, s: Shape): Change {
  return apply(set, [{ op: 'insert', id, type, shape: s }]);
}

/** A move, a rotation, a scale, a dragged vertex: all of them are new points. */
export function update(set: WorldSet, id: Id, s: Shape): Change {
  return apply(set, [{ op: 'update', id, shape: s }]);
}

export function remove(set: WorldSet, id: Id): Change {
  return apply(set, [{ op: 'remove', id }]);
}

/**
 * The edits without the diff, curried the way the store likes its updates:
 *
 * ```ts
 * update(s => ({ ...s, world: edited(edits)(s.world) }));
 * ```
 *
 * For when the caller is going to redraw everything regardless and has nothing
 * to do with knowing which rings moved.
 */
export function edited(edits: readonly Edit[]): (set: WorldSet) => WorldSet {
  return set => apply(set, edits).set;
}

/**
 * Several edits at once, recomputing each affected cluster only the once. A
 * drag that moves twenty selected polygons belongs here rather than in twenty
 * calls to `update`.
 */
export function apply(set: WorldSet, edits: readonly Edit[]): Change {
  const entries = new Map(set.entries);
  const seeds: AABB[] = [];
  const touched: Id[] = [];

  let tree = set.tree;

  for (const e of edits) {
    const was = entries.get(e.id);

    if (was) {
      tree = aabb.remove(tree, e.id, was.box);
      entries.delete(e.id);
      seeds.push(was.box);
      touched.push(e.id);
    }

    if (e.op === 'remove') continue;

    const kind = e.op === 'insert' ? kindOf(e.type) : was?.kind;
    if (kind === undefined) continue;

    // Self-intersections are resolved once, here, rather than every time the
    // polygon takes part in a cluster's CSG. The points that came in are kept
    // as they are: the editor goes on editing those, not this.
    const s = simplify(e.shape);
    if (s.length === 0) continue;

    // The source box covers the simplified one, so it is safe for clustering
    // and it is the box the editor wants for picking.
    const box = ofRings(e.shape);

    entries.set(e.id, { id: e.id, kind, source: e.shape, shape: s, box });
    tree = aabb.insert(tree, e.id, box);
    seeds.push(box);
    touched.push(e.id);
  }

  const dirty = spread(set, entries, tree, seeds, touched);

  return rebuild(set, entries, tree, dirty);
}

function kindOf(type: PolygonType): Kind | undefined {
  return type === 'level' || type === 'solid' ? type : undefined;
}

// -----------------------------------------------------------------------------
// Which clusters an edit disturbs
// -----------------------------------------------------------------------------

interface Dirty {
  items: Set<Id>
  clusters: Set<number>
}

/**
 * Outward from the edits until nothing new is reached. Touching an item pulls
 * in its old cluster whole — the edit may have split it, and every piece of it
 * has to be reconsidered — and pulls in everything it now overlaps, since the
 * edit may instead have merged two clusters into one. The result is closed:
 * nothing outside it neighbours anything inside it.
 */
function spread(
  set: WorldSet,
  entries: Map<Id, Entry>,
  tree: Tree,
  seeds: readonly AABB[],
  touched: readonly Id[],
): Dirty {
  const items = new Set<Id>();
  const clusters = new Set<number>();
  const queue: Id[] = [...touched];

  for (const b of seeds) {
    each(set.tree, b, id => queue.push(id));
    each(tree, b, id => queue.push(id));
  }

  while (queue.length > 0) {
    const id = queue.pop()!;
    if (items.has(id)) continue;

    items.add(id);

    const c = set.owner.get(id);

    if (c !== undefined && !clusters.has(c)) {
      clusters.add(c);
      for (const m of set.clusters.get(c)!.members) queue.push(m);
    }

    const e = entries.get(id);
    if (e) each(tree, e.box, n => queue.push(n));
  }

  return { items, clusters };
}

// -----------------------------------------------------------------------------
// Recomputing the disturbed part
// -----------------------------------------------------------------------------

function rebuild(set: WorldSet, entries: Map<Id, Entry>, tree: Tree, dirty: Dirty): Change {
  const clusters = new Map(set.clusters);
  const owner = new Map(set.owner);

  // What the dirty clusters used to say, held on to so that rings which come
  // out the same can keep their ids and stay out of the diff.
  const spare = new Map<string, Piece[]>();

  for (const c of dirty.clusters) {
    const cluster = clusters.get(c)!;

    for (const p of cluster.pieces) {
      const key = keyOf(p.ring);
      spare.set(key, [...(spare.get(key) ?? []), p]);
    }

    for (const m of cluster.members) owner.delete(m);
    clusters.delete(c);
  }

  for (const id of dirty.items) {
    if (!entries.has(id)) owner.delete(id);
  }

  const inserted: Piece[] = [];

  let nextCluster = set.nextCluster;
  let nextPiece = set.nextPiece;

  for (const group of components(dirty.items, entries, tree)) {
    const id = nextCluster++;
    const built: Piece[] = [];

    for (const ring of csg(group, entries)) {
      const kept = spare.get(keyOf(ring))?.pop();

      if (kept) {
        built.push(kept);
      }
      else {
        const piece = { id: nextPiece++, ring };
        built.push(piece);
        inserted.push(piece);
      }
    }

    clusters.set(id, { members: group, pieces: built });
    for (const m of group) owner.set(m, id);
  }

  // Whatever is still in hand was not recognised in the new rings: it is gone.
  const removed: PieceId[] = [];
  for (const ps of spare.values()) {
    for (const p of ps) removed.push(p.id);
  }

  return {
    set: { entries, tree, clusters, owner, nextCluster, nextPiece },
    diff: { removed, inserted },
  };
}

/** Connected components of "boxes overlap", among the dirty items only. */
function components(items: Set<Id>, entries: Map<Id, Entry>, tree: Tree): Id[][] {
  const left = new Set<Id>();
  for (const id of items) {
    if (entries.has(id)) left.add(id);
  }

  const out: Id[][] = [];

  while (left.size > 0) {
    const seed: Id = left.values().next().value!;
    left.delete(seed);

    const group: Id[] = [];
    const queue: Id[] = [seed];

    while (queue.length > 0) {
      const id = queue.pop()!;
      group.push(id);

      each(tree, entries.get(id)!.box, n => {
        if (left.delete(n)) queue.push(n);
      });
    }

    out.push(group.sort((a, b) => a - b));
  }

  return out;
}

/**
 * One cluster's contribution. Rings arriving here are already oriented, so the
 * nonzero rule unions all the level polygons on its own and the whole cluster
 * comes down to a single subtraction.
 */
function csg(group: readonly Id[], entries: Map<Id, Entry>): Ring[] {
  const level: Ring[] = [], solid: Ring[] = [];

  for (const id of group) {
    const e = entries.get(id)!;
    (e.kind === 'level' ? level : solid).push(...e.shape);
  }

  if (level.length === 0) return [];
  if (solid.length === 0) return simplify(level);

  return combine(level, solid, OpSubtract);
}

/** A ring as text, starting from its lowest point so that where the traversal
 * happened to begin does not make an unchanged ring look new. */
function keyOf(ring: Ring): string {
  const parts = ring.map(p => `${round(p.x)},${round(p.y)}`);

  let at = 0;
  for (let i = 1; i < parts.length; i++) {
    if (parts[i] < parts[at]) at = i;
  }

  return [...parts.slice(at), ...parts.slice(0, at)].join(' ');
}

function round(n: number): number {
  return Math.abs(n) < 1e-9 ? 0 : Math.round(n * 1e6) / 1e6;
}

// -----------------------------------------------------------------------------
// Building from scratch
// -----------------------------------------------------------------------------

/** Everything at once, for loading a world. */
export function fromEntries(items: readonly { id: Id, type: PolygonType, shape: Shape }[]): WorldSet {
  return apply(emptyWorldSet, items.map(i => ({ op: 'insert' as const, ...i }))).set;
}

/** The set as it would come out of a full rebuild — a check on the incremental
 * path, and the way back if one is ever needed. */
export function recomputed(set: WorldSet): WorldSet {
  return fromEntries(sources(set));
}

/** Every source polygon, as it was handed in. */
export function sources(set: WorldSet): { id: Id, type: PolygonType, shape: Shape }[] {
  return [...set.entries.values()].map(e => ({ id: e.id, type: e.kind, shape: e.source }));
}
