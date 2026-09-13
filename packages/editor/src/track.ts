// -----------------------------------------------------------------------------
// The timeline, as rows
//
// What the keyframe view draws, worked out from the world and nothing else, so
// that the view is a picture of it and this is what is tested. Columns are the
// keyframes in order; rows are things in their group tree, each with its
// repeats in lanes under it.
// -----------------------------------------------------------------------------

import { Point } from '@ce/game/world';
import { hitPath } from './paths';
import { Cornered, Place, entryAt } from './keys';
import { Entry, KeyframeId, Op, counted1, indexIn } from './rig';
import { artefactsAt, hitPolygons, pathsAt, resolveAt, rigOf } from './scene';
import { Flags, Id, Selection, VertexId, World, enclosing, flagsOf } from './types';

export type Kind = Op['kind'];

/**
 * A thing's row: an icon for every entry written about it, side by side in
 * its keyframe's column, and a lane under it for every repeat.
 *
 * Stands are not in it. A stand is where a thing stops hearing from upstream,
 * and taking one out moves the thing to wherever upstream says it is — a
 * question about the chain, asked with Cmd+U and Cmd+Shift+U, not an entry to
 * be dragged about.
 *
 * A corner's row is under its polygon's, and holds its nudges and depths.
 */
export interface Row {
  id: Id
  /** The corner the row is about, or nothing for the thing itself. */
  corner: VertexId | null
  depth: number
  label: string
  flags: Flags
  /** One per keyframe. */
  cells: Cell[]
  /** Its repeats, the one nearest the row first: the rightmost entry's, so
   * that no line down from an entry crosses another's lane. */
  bars: Bar[]
}

export interface Cell {
  /** Where each entry the row shows is written. */
  places: Place[]
  /** Their kinds, one for one. */
  kinds: Kind[]
  /** Whether the thing is there at that keyframe. */
  alive: boolean
}

/**
 * A repeat, trailing its entry: the keyframes it steps at and the ones it
 * waits over, as far as it runs.
 */
export interface Bar {
  /** The column its entry is written at, where it is written, and where
   * among the row's icons in that column. */
  from: number
  place: Place
  slot: number
  /** Every column it has reached, the ones it waits over included. */
  steps: { col: number, skip: boolean }[]
  /** The column of its last step: the last column, for one that runs to the
   * end. */
  end: number
  forever: boolean
  /** Where a repeating scale has got to by `end`, since `byⁿ` runs away. */
  heading: string | null
}

/** The things the view starts from: what is picked. A pick inside a picked
 * group is under it already. */
export function rootsOf(world: World, selection: Selection): Id[] {
  const picked = [...new Set([...selection.polygons, ...selection.artefacts, ...selection.paths])];
  const has = new Set(picked);

  return picked.filter(id => !enclosing(world, id).some(g => has.has(g)));
}

/**
 * Every root's row, and under a group its members', all the way down. With
 * `corners`, under a polygon a row for each of its corners that has something
 * written about it, in the order of its ring.
 */
export function rowsOf(world: World, roots: readonly Id[], corners = false): Row[] {
  const out: Row[] = [];

  const add = (id: Id, depth: number): void => {
    const cells = cellsOf(world, id);
    const flags = flagsOf(world, id);

    out.push({ id, corner: null, depth, label: labelOf(world, id), flags, cells, bars: barsOf(world, cells) });

    if (corners) {
      const rig = rigOf(world, id);

      world.polygons.get(id)?.points.forEach((c, i) => {
        if (!rig.nudges.has(c.id) && !rig.depths.has(c.id)) return;

        const cells = cornerCellsOf(world, id, c.id);

        out.push({ id, corner: c.id, depth: depth + 1, label: `corner ${i}`, flags, cells, bars: barsOf(world, cells) });
      });
    }

    for (const m of world.groups.get(id)?.members ?? []) add(m, depth + 1);
  };

  for (const id of roots) add(id, 0);

  return out;
}

/** What a thing is called in its row. */
export function labelOf(world: World, id: Id): string {
  const p = world.polygons.get(id);

  if (p !== undefined) return `${p.type} ${id}`;
  if (world.groups.has(id)) return `group ${id}`;

  const a = world.artefacts.get(id);

  if (a !== undefined) return `${a.type} ${id}`;

  return `path ${id}`;
}

function cellsOf(world: World, id: Id): Cell[] {
  const rig = rigOf(world, id);
  const life = lifeOf(world, id);

  return world.keyframes.map((f, i) => {
    const list = rig.keys.get(f.id) ?? [];
    const entries = list.flatMap((e, n) => (e.op.kind === 'stand' ? [] : [n]));

    return {
      places: entries.map(index => ({ id, at: f.id, index })),
      kinds: entries.map(n => list[n].op.kind),
      alive: i >= life.birth && i < life.death,
    };
  });
}

/** A corner's nudge and depth at each keyframe, in that order, where it has
 * them. */
function cornerCellsOf(world: World, id: Id, corner: VertexId): Cell[] {
  const rig = rigOf(world, id);
  const life = lifeOf(world, id);
  const c = world.polygons.get(id)?.points.find(v => v.id === corner);
  const birth = c === undefined ? life.birth : Math.max(life.birth, indexIn(world.keyframes, c.birth));
  const gone = c === undefined || c.death === null ? -1 : indexIn(world.keyframes, c.death);
  const death = gone < 0 ? life.death : Math.min(life.death, gone);

  return world.keyframes.map((f, i) => {
    const places: Place[] = [];

    if (rig.nudges.get(corner)?.has(f.id)) places.push({ id, at: f.id, corner, kind: 'move' });
    if (rig.depths.get(corner)?.has(f.id)) places.push({ id, at: f.id, corner, kind: 'erode' });

    return { places, kinds: places.map(p => (p as Cornered).kind), alive: i >= birth && i < death };
  });
}

/** Where a thing is there, as indices: from its birth to before its death. */
function lifeOf(world: World, id: Id): { birth: number, death: number } {
  const it = world.polygons.get(id) ?? world.artefacts.get(id) ?? world.paths.get(id);

  if (it === undefined) return { birth: 0, death: Infinity };

  const death = it.death === null ? -1 : indexIn(world.keyframes, it.death);

  return { birth: indexIn(world.keyframes, it.birth), death: death < 0 ? Infinity : death };
}

/** A row's repeats, rightmost first. */
function barsOf(world: World, cells: readonly Cell[]): Bar[] {
  const out: Bar[] = [];

  cells.forEach((c, j) => {
    c.places.forEach((p, slot) => {
      const e = entryAt(world, p);
      const bar = e === undefined ? null : barOf(world, e, j, p, slot);

      if (bar !== null) out.push(bar);
    });
  });

  return out.reverse();
}

/** An entry's bar, or nothing where it happens once. */
export function barOf(world: World, e: Entry, from: number, place: Place, slot = 0): Bar | null {
  if (e.times === 1 || e.op.kind === 'stand') return null;

  const keyframes = world.keyframes;
  const steps: Bar['steps'] = [];
  let taken = 0;
  let end = from;

  for (let col = from + 1; col < keyframes.length; col++) {
    if (e.times !== null && taken >= e.times - 1) break;

    const skip = e.skip?.has(keyframes[col].id) ?? false;

    steps.push({ col, skip });

    if (!skip) {
      taken++;
      end = col;
    }
  }

  const forever = e.times === null;

  if (forever) end = keyframes.length - 1;

  let heading: string | null = null;

  if (e.op.kind === 'scale') {
    const n = counted1(keyframes, e, from, end);

    heading = factor(Math.pow(e.op.by.x, n), Math.pow(e.op.by.y, n));
  }

  return { from, place, slot, steps, end, forever, heading };
}

/**
 * The `times` that puts an entry's last step at column `col`: once where that
 * is its own column or before, and to the end at the last column.
 */
export function timesTo(world: World, e: Entry, from: number, col: number): number | null {
  if (col <= from) return 1;
  if (col >= world.keyframes.length - 1) return null;

  return counted1(world.keyframes, { ...e, times: null }, from, col);
}

function factor(x: number, y: number): string {
  return Math.abs(x - y) < 1e-9 ? `×${short(x)}` : `×${short(x)}, ${short(y)}`;
}

/** A number in three figures, or as a power of ten past where those read. */
export function short(n: number): string {
  if (n === 0) return '0';

  const a = Math.abs(n);

  if (a >= 1e4 || a < 1e-3) return n.toExponential(1);

  return String(parseFloat(n.toPrecision(3)));
}

/** An entry, said in a line: what it does, and how often. */
export function entryLabel(e: Entry): string {
  const what = ((): string => {
    const op = e.op;

    switch (op.kind) {
      case 'move':
        return `move ${short(op.by.x)}, ${short(op.by.y)}`;
      case 'turn':
        return `turn ${short(op.angle * 180 / Math.PI)}°`;
      case 'scale':
        return `scale ${factor(op.by.x, op.by.y)}`;
      case 'skew':
        return `skew ${short(op.by)}`;
      case 'erode':
        return `erode ${short(op.by)}`;
      case 'stand':
        return 'unchained';
    }
  })();

  if (e.times === 1) return what;

  return `${what}  ↻ ${e.times === null ? '∞' : e.times}`;
}

/** One thing under the cursor, and how deep in the groups above it it is. */
export interface Beneath {
  id: Id
  depth: number
}

/**
 * Everything at a point at keyframe `k`, whatever its flags: each room there,
 * topmost first, under the groups that hold it, then the artefacts and the
 * tape within `reach`.
 *
 * The one place a locked or hidden thing can still be found by where it is,
 * which is how it is found to be let go of.
 */
export function beneath(world: World, k: KeyframeId, p: Point, reach: number): Beneath[] {
  const hit: Id[] = hitPolygons(resolveAt(world, k), p);

  for (const it of artefactsAt(world, k)) {
    if (Math.hypot(it.at.x - p.x, it.at.y - p.y) <= reach) hit.push(it.id);
  }

  const tape = hitPath(pathsAt(world, k), p, reach);

  if (tape !== null) hit.push(tape);

  // Each hit with every group over it, laid out as the tree they make: the
  // outermost in the order they were hit, and under a group what of it is here.
  const here = new Set(hit.flatMap(id => [id, ...enclosing(world, id)]));
  const roots = [...new Set(hit.map(id => enclosing(world, id).at(-1) ?? id))];
  const out: Beneath[] = [];

  const add = (id: Id, depth: number) => {
    out.push({ id, depth });

    for (const m of world.groups.get(id)?.members ?? []) {
      if (here.has(m)) add(m, depth + 1);
    }
  };

  for (const r of roots) add(r, 0);

  return out;
}
