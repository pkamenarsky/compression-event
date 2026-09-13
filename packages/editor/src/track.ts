// -----------------------------------------------------------------------------
// The timeline, as rows
//
// What the keyframe view draws, worked out from the world and nothing else, so
// that the view is a picture of it and this is what is tested. Columns are the
// keyframes in order; rows are things in their group tree, each opening into
// one row per kind of operation written about it and then its members.
// -----------------------------------------------------------------------------

import { Entry, Op, counted1, indexIn } from './rig';
import { rigOf } from './scene';
import { Flags, Id, Selection, World, enclosing, flagsOf, parentOf } from './types';

export type Kind = Op['kind'];

/** The kinds, in the order their rows go: a stand first, since everything
 * else at its keyframe plays over it. */
export const KINDS: readonly Kind[] = ['stand', 'move', 'turn', 'scale', 'skew', 'erode'];

export interface Row {
  id: Id
  depth: number
  /** Nothing for the thing's own row, whose cells hold every kind at once. */
  kind: Kind | null
  label: string
  /** The thing's own row only: whether it is open, and whether there is
   * anything under it to open to. */
  open: boolean
  opens: boolean
  flags: Flags
  /** One per keyframe. */
  cells: Cell[]
  bars: Bar[]
}

export interface Cell {
  /** Where each entry the row shows is in its keyframe's list. */
  entries: number[]
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
  /** The column its entry is written at, and where it is in that list. */
  from: number
  index: number
  /** Every column it has reached, the ones it waits over included. */
  steps: { col: number, skip: boolean }[]
  /** The column of its last step: the last column, for one that runs to the
   * end. */
  end: number
  forever: boolean
  /** Where a repeating scale has got to by `end`, since `byⁿ` runs away. */
  heading: string | null
}

/**
 * The things the view starts from: what is picked, or everything at the top
 * level. A pick inside a picked group is under it already.
 */
export function rootsOf(world: World, selection: Selection, all: boolean): Id[] {
  if (all) {
    const up = parentOf(world);
    const ids = [...world.polygons.keys(), ...world.groups.keys(), ...world.artefacts.keys(), ...world.paths.keys()];

    return ids.filter(id => !up.has(id)).sort((a, b) => a - b);
  }

  const picked = [...new Set([...selection.polygons, ...selection.artefacts, ...selection.paths])];
  const has = new Set(picked);

  return picked.filter(id => !enclosing(world, id).some(g => has.has(g)));
}

export function rowsOf(world: World, roots: readonly Id[], open: ReadonlySet<Id>): Row[] {
  const out: Row[] = [];

  const add = (id: Id, depth: number): void => {
    const rig = rigOf(world, id);
    const lists = [...rig.keys.values()];
    const kinds = KINDS.filter(k => lists.some(l => l.some(e => e.op.kind === k)));
    const members = world.groups.get(id)?.members ?? [];
    const opens = kinds.length > 0 || members.length > 0;
    const isOpen = opens && open.has(id);
    const flags = flagsOf(world, id);

    out.push({
      id,
      depth,
      kind: null,
      label: labelOf(world, id),
      open: isOpen,
      opens,
      flags,
      cells: cellsOf(world, id, null),
      bars: [],
    });

    if (!isOpen) return;

    for (const kind of kinds) {
      out.push({
        id,
        depth: depth + 1,
        kind,
        label: kind,
        open: false,
        opens: false,
        flags,
        cells: cellsOf(world, id, kind),
        bars: barsOf(world, id, kind),
      });
    }

    for (const m of members) add(m, depth + 1);
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

function cellsOf(world: World, id: Id, kind: Kind | null): Cell[] {
  const rig = rigOf(world, id);
  const life = lifeOf(world, id);

  return world.keyframes.map((f, i) => {
    const list = rig.keys.get(f.id) ?? [];
    const entries = list.flatMap((e, n) => (kind === null || e.op.kind === kind ? [n] : []));

    return { entries, kinds: entries.map(n => list[n].op.kind), alive: i >= life.birth && i < life.death };
  });
}

/** Where a thing is there, as indices: from its birth to before its death. */
function lifeOf(world: World, id: Id): { birth: number, death: number } {
  const it = world.polygons.get(id) ?? world.artefacts.get(id) ?? world.paths.get(id);

  if (it === undefined) return { birth: 0, death: Infinity };

  const death = it.death === null ? -1 : indexIn(world.keyframes, it.death);

  return { birth: indexIn(world.keyframes, it.birth), death: death < 0 ? Infinity : death };
}

/** The repeats of one kind. */
function barsOf(world: World, id: Id, kind: Kind): Bar[] {
  return world.keyframes.flatMap((f, j) =>
    (rigOf(world, id).keys.get(f.id) ?? []).flatMap((e, n) => {
      const bar = e.op.kind === kind ? barOf(world, e, j, n) : null;

      return bar === null ? [] : [bar];
    }));
}

/** An entry's bar, or nothing where it happens once. */
export function barOf(world: World, e: Entry, from: number, index: number): Bar | null {
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

  return { from, index, steps, end, forever, heading };
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
