// -----------------------------------------------------------------------------
// The game world's boundary, kept up to date incrementally
//
// What the game wants is the outline of one set: every `level` polygon unioned,
// with every `solid` polygon taken back out. Recomputing that from scratch is
// nowhere near a frame at ten thousand polygons, so an edit has to be able to
// touch a bounded amount of work.
//
// What makes that possible is that the outline is *partitioned by source*.
// Every piece of it lies on some polygon's edge and belongs to that polygon
// alone, and a piece of A survives exactly when nothing lying over A buries it.
// So A's share is a question about A and the polygons A actually overlaps, and
// about nothing else — however the union happens to join things up further
// away. `boundaryRuns` in `geometry.ts` answers it.
//
// An edit therefore disturbs the polygon it names and that polygon's
// overlappers, before the edit and after it, and nothing beyond. That set does
// not grow with the world.
//
// An earlier design grouped polygons into clusters — connected components of
// the "their boxes overlap" graph — and recomputed a whole cluster per edit.
// The reasoning was right and the unit was wrong: a level is connected by
// construction, because that is what makes it a level, so the whole world was
// one cluster and every edit rebuilt all of it. At ten thousand polygons,
// moving one cost 2.2 of the 2.5 seconds a full rebuild cost.
//
// Runs, not rings
// ---------------
// A piece is an open run of one polygon's edges, not a closed ring. A ring is
// generally made of several polygons' runs and belongs to none of them, so
// keeping ring identity would put back exactly the global bookkeeping this
// exists to avoid: adding a polygon can merge two rings or split one, at any
// distance.
//
// Nothing needs the ring. Collision is edge-normal based and wants segments,
// and the corner at a run's end needs the run carrying on past it — a lookup at
// that point, not a walk of the loop. The editor's overlay is stroked rather
// than filled. The bake runs offline and rebuilds whatever it wants per
// keyframe, from tags, without consulting this at all.
//
// What the caller owns, and what this owns
// ----------------------------------------
// Source polygons are the caller's, ids and all. They are kept exactly as they
// came in — `entry(set, id).source` gives back the same points that went in,
// which is what the editor draws handles on and hands to the next edit. The
// simplified copy used for the geometry sits beside it and is nobody's business
// but this module's.
//
// Output runs are ours, and so are their ids. `Id` and `PieceId` are separate
// namespaces that never meet: a piece id is minted here, handed out in a diff,
// and only ever means "that run". A piece does name the polygon it came off, in
// `source`, which is the one place the two are deliberately connected.
//
// Everything is immutable. The tree shares structure with the version it came
// from; the bookkeeping maps are copied, which is O(n) in polygons and nothing
// next to the geometry it saves.
// -----------------------------------------------------------------------------

import { PolygonType } from '@ce/game/world';
import { AABB, Tree, emptyTree, ofRings } from './aabb';
import * as aabb from './aabb';
import { Member, Point, Shape, boundaryRuns, simplify } from './geometry';

export type Id = number;

/** Minted here, and never confused with an `Id`. */
export type PieceId = number;

export type Kind = 'level' | 'solid';

export interface Entry {
  id: Id
  kind: Kind
  /** The points that came in, untouched. The editor's to draw and to edit. */
  source: Shape
  /**
   * The same polygon simplified — outer rings counter-clockwise, holes
   * clockwise, no self-intersections — which is what the geometry runs on.
   *
   * May be empty, when the polygon has nothing left: eroded past its own
   * middle, or drawn with no area to begin with. The entry stays, because the
   * caller's id and kind outlive the geometry and an update has to be able to
   * bring it back.
   */
  shape: Shape
  /** Of `source`, so it covers `shape` too. */
  box: AABB
}

/**
 * One run of the outline: a stretch of a single polygon's edges that nothing
 * buried. Open, in the order it is walked, with the set's interior on the left.
 */
export interface Piece {
  id: PieceId
  /** The polygon this came off. */
  source: Id
  points: Point[]
}

/**
 * What changed. `removed` names pieces handed out earlier that are gone;
 * `inserted` are new. A piece belonging to a polygon the edit never reached
 * appears in neither.
 */
export interface Diff {
  removed: PieceId[]
  inserted: Piece[]
}

export interface Change {
  set: WorldSet
  diff: Diff
}

export interface WorldSet {
  entries: Map<Id, Entry>
  tree: Tree
  /** Each polygon's share of the outline. */
  runs: Map<Id, Piece[]>
  nextPiece: PieceId
}

export type Edit =
  | { op: 'insert', id: Id, type: PolygonType, shape: Shape }
  | { op: 'update', id: Id, shape: Shape }
  | { op: 'remove', id: Id };

export const emptyWorldSet: WorldSet = {
  entries: new Map(),
  tree: emptyTree,
  runs: new Map(),
  nextPiece: 1,
};

// -----------------------------------------------------------------------------
// Reading the result
// -----------------------------------------------------------------------------

export function pieces(set: WorldSet): Piece[] {
  const out: Piece[] = [];

  for (const rs of set.runs.values()) out.push(...rs);

  return out;
}

/** Just the runs, for drawing and for collision. */
export function outline(set: WorldSet): Point[][] {
  return pieces(set).map(p => p.points);
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
 * to do with knowing which runs moved.
 */
export function edited(edits: readonly Edit[]): (set: WorldSet) => WorldSet {
  return set => apply(set, edits).set;
}

/**
 * Several edits at once, recomputing each disturbed polygon only the once. A
 * drag that moves twenty selected polygons belongs here rather than in twenty
 * calls to `update`.
 */
export function apply(set: WorldSet, edits: readonly Edit[]): Change {
  const entries = new Map(set.entries);
  const runs = new Map(set.runs);
  const dirty = new Set<Id>();

  let tree = set.tree;

  const disturb = (b: AABB) => {
    for (const id of aabb.search(tree, b)) dirty.add(id);
  };

  for (const e of edits) {
    const was = entries.get(e.id);

    if (was !== undefined) {
      // Whatever it used to lie over stops being buried by it.
      disturb(was.box);

      // In the tree exactly when it has geometry, so this is where that is
      // undone rather than unconditionally.
      if (was.shape.length !== 0) tree = aabb.remove(tree, e.id, was.box);

      entries.delete(e.id);
      dirty.add(e.id);
    }

    if (e.op === 'remove') continue;

    const kind = e.op === 'insert' ? kindOf(e.type) : was?.kind;
    if (kind === undefined) continue;

    // Self-intersections are resolved once, here, rather than every time the
    // polygon takes part in a boundary. The points that came in are kept as
    // they are: the editor goes on editing those, not this.
    const shape = simplify(e.shape);

    // The source box covers the simplified one, so it is safe to search with
    // and it is the box the editor wants for picking.
    const box = ofRings(e.shape);

    // The entry goes in whether or not there is any geometry left. Dropping it
    // for an empty shape loses the kind, which is the one thing an update
    // cannot supply — so a polygon eroded away to nothing could never be
    // eroded back, and the caller had no way to know it had to insert instead.
    // A version scrubbing a depth past a collapse and back does exactly that.
    entries.set(e.id, { id: e.id, kind, source: e.shape, shape, box });

    // The tree is about what can bury something, so nothing goes in it. An
    // empty box would be unfindable by the search that removes it, too.
    if (shape.length !== 0) {
      tree = aabb.insert(tree, e.id, box);

      // And whatever it now lies over starts being buried by it.
      disturb(box);
    }

    dirty.add(e.id);
  }

  return rebuild(set, { entries, tree, runs, nextPiece: set.nextPiece }, dirty);
}

function kindOf(type: PolygonType): Kind | undefined {
  return type === 'level' || type === 'solid' ? type : undefined;
}

// -----------------------------------------------------------------------------
// Recomputing what the edit disturbed
// -----------------------------------------------------------------------------

function member(e: Entry): Member {
  return { id: e.id, kind: e.kind, shape: e.shape };
}

/**
 * Every disturbed polygon's share, worked out again from itself and whatever
 * overlaps it *now*.
 *
 * Neighbours that were not themselves disturbed are still consulted — they are
 * what decides how much of this polygon is buried — but their own shares are
 * left alone, because nothing that could have changed them has.
 */
function rebuild(before: WorldSet, next: WorldSet, dirty: Set<Id>): Change {
  const removed: PieceId[] = [];
  const inserted: Piece[] = [];

  let nextPiece = next.nextPiece;

  for (const id of dirty) {
    for (const p of before.runs.get(id) ?? []) removed.push(p.id);

    const e = next.entries.get(id);

    if (e === undefined) {
      next.runs.delete(id);
      continue;
    }

    // Present, but with nothing to contribute and nothing able to bury it.
    if (e.shape.length === 0) {
      next.runs.set(id, []);
      continue;
    }

    const others: Member[] = [];

    for (const other of aabb.search(next.tree, e.box)) {
      const o = next.entries.get(other);
      if (o !== undefined && o.id !== id) others.push(member(o));
    }

    const mine = boundaryRuns(member(e), others).map(points => ({
      id: nextPiece++,
      source: id,
      points,
    }));

    next.runs.set(id, mine);
    inserted.push(...mine);
  }

  return { set: { ...next, nextPiece }, diff: { removed, inserted } };
}

// -----------------------------------------------------------------------------

/** Everything at once, for loading a world. */
export function fromEntries(
  items: readonly { id: Id, type: PolygonType, shape: Shape }[],
): WorldSet {
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
