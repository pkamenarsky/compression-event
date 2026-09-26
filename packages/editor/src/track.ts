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
import { Cornered, Place, entryAt, samePlace } from './keys';
import {
  CORNER_KINDS,
  CORNER_MAPS,
  Key,
  KeyframeId,
  AmountKind,
  Op,
  channelsOf,
  counted1,
  heldOf,
  indexIn,
  keysAt,
  kindOf,
} from './rig';
import { artefactsAt, hitPolygons, keyRigOf, layerNamer, pathsAt, resolveAt } from './scene';
import { EditorState, Flags, Id, LayerId, Selection, VertexId, World, enclosing, flagsOf, kindName } from './types';

export type Kind = Op['kind'] | AmountKind | 'corners';

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
  /** Where each key the row shows is written. */
  places: Place[]
  /**
   * What each of them does, one list for one key: a gesture's kind, or
   * several where a hand did several things into one key. In the order the
   * key does them.
   */
  kinds: Kind[][]
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
  steps: { col: number }[]
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
      const rig = keyRigOf(world, id);
      const written = new Set<VertexId>();

      for (const list of rig.keys.values()) {
        for (const key of list) {
          for (const m of CORNER_MAPS) {
            for (const v of key[heldOf(CORNER_KINDS[m])]?.keys() ?? []) written.add(v);
          }
        }
      }

      world.polygons.get(id)?.points.forEach((c, i) => {
        if (!written.has(c.id)) return;

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

  if (p !== undefined) return `${kindName(p)} ${id}`;
  if (world.groups.has(id)) return `group ${id}`;

  const a = world.artefacts.get(id);

  if (a !== undefined) return `${a.type} ${id}`;

  return `path ${id}`;
}

function cellsOf(world: World, id: Id): Cell[] {
  const rig = keyRigOf(world, id);
  const life = lifeOf(world, id);

  return world.keyframes.map((f, i) => {
    const list = keysAt(rig, f.id);
    // The first key where it is born is shown like any other: it is how the
    // thing was made, and after a break it is still there to be adjusted.
    const shown = list.flatMap((key, n) => (key.stand === undefined && key.by !== undefined ? [n] : []));

    return {
      places: shown.map(n => ({ id, at: f.id, key: list[n].id })),
      kinds: shown.map(n => channelsOf(list[n], layerNamer(world, id)) as Kind[]),
      alive: i >= life.birth && i < life.death,
    };
  });
}

/** A corner's nudge and depth at each keyframe, in that order, where it has
 * them. */
function cornerCellsOf(world: World, id: Id, corner: VertexId): Cell[] {
  const rig = keyRigOf(world, id);
  const life = lifeOf(world, id);
  const c = world.polygons.get(id)?.points.find(v => v.id === corner);
  const birth = c === undefined ? life.birth : Math.max(life.birth, indexIn(world.keyframes, c.birth));
  const gone = c === undefined || c.death === null ? -1 : indexIn(world.keyframes, c.death);
  const death = gone < 0 ? life.death : Math.min(life.death, gone);

  return world.keyframes.map((f, i) => {
    const places: Place[] = [];

    // A corner's writing is in a key, so what the corner's row shows is the
    // keys of its keyframe that name it — see `Place` in `keys.ts`.
    for (const m of CORNER_MAPS) {
      const kind = CORNER_KINDS[m];

      if (keysAt(rig, f.id).some(key => key[heldOf(kind)]?.has(corner))) {
        places.push({ id, at: f.id, corner, kind });
      }
    }

    return { places, kinds: places.map(p => [(p as Cornered).kind]), alive: i >= birth && i < death };
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
export function barOf(world: World, e: Key, from: number, place: Place, slot = 0): Bar | null {
  if (e.times === 1 || e.stand !== undefined) return null;

  const keyframes = world.keyframes;
  const steps: Bar['steps'] = [];
  let taken = 0;
  let end = from;

  for (let col = from + 1; col < keyframes.length; col++) {
    if (e.times !== null && taken >= e.times - 1) break;

    steps.push({ col });
    taken++;
    end = col;
  }

  const forever = e.times === null;

  if (forever) end = keyframes.length - 1;

  let heading: string | null = null;

  if (e.by !== undefined && kindOf(e) === 'scale') {
    const n = counted1(e, from, end);

    heading = factor(Math.pow(e.by.scale.x, n), Math.pow(e.by.scale.y, n));
  }

  return { from, place, slot, steps, end, forever, heading };
}

/**
 * The entry at `place` and every other in column `col` of `rows` that the
 * same gesture wrote, in the order of the rows: what a click on it picks. Only
 * what is shown, since what is not could not be seen to be acted on. Alone,
 * where it has no gesture.
 */
export function gestureOf(world: World, rows: readonly Row[], col: number, place: Place): Place[] {
  const gesture = entryAt(world, place)?.group;

  if (gesture === undefined) return [place];

  const all = rows.flatMap(r => r.cells[col].places).filter(p => entryAt(world, p)?.group === gesture);

  return all.filter((p, i) => all.findIndex(q => samePlace(p, q)) === i);
}

/**
 * The `times` that puts an entry's last step at column `col`: once where that
 * is its own column or before, and to the end at the last column.
 */
export function timesTo(world: World, e: Key, from: number, col: number): number | null {
  if (col <= from) return 1;
  if (col >= world.keyframes.length - 1) return null;

  return counted1({ ...e, times: null }, from, col);
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

/** A key, said in a line: everything it does, and how often. */
export function entryLabel(e: Key, named: (layer: LayerId) => string = () => 'amount'): string {
  const what = ((): string => {
    if (e.stand !== undefined) return 'unchained';

    const d = e.by;

    if (d === undefined) return 'corners';

    const amounts = [...d.amounts];
    let nth = 0;

    const said = (kind: string): string => {
      switch (kind) {
        case 'turn':
          return `turn ${short(d.angle * 180 / Math.PI)}°`;
        case 'scale':
          return `scale ${factor(d.scale.x, d.scale.y)}`;
        case 'skew':
          return `skew ${short(d.skew)}`;
        case 'erode':
        case 'round':
        case 'deform':
        case 'amount':
          return `${kind} ${short(amounts[nth++][1])}`;
        default:
          return `move ${short(d.move.x)}, ${short(d.move.y)}`;
      }
    };

    return channelsOf(e, named).map(said).join(', ');
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

/**
 * The needle moved to the stop before or after the one it is on, `by` −1 or
 * 1. The stops are each keyframe and then its key slots, in order: a slot is
 * the `i`-th key of every thing whose row is shown, and the hand goes on all
 * of them, led by the key of the thing it was led by. On a keyframe the hand
 * is on nothing. `s` itself where there is nowhere to go. The keyframe it lands
 * in is the result's, for the caller to switch to.
 */
export function steppedKey(s: EditorState, by: 1 | -1): EditorState {
  const w = s.world;
  const rows = rowsOf(w, rootsOf(w, s.selection), false).filter(r => r.corner === null);

  if (rows.length === 0) return s;

  const width = (col: number) => Math.max(0, ...rows.map(r => r.cells[col].places.length));
  const lead = s.target?.lead;
  const led = lead === undefined ? undefined : rows.find(r => r.id === lead.id);
  let col = indexIn(w.keyframes, s.keyframe);
  // −1 is the keyframe itself.
  let i = (lead === undefined || led === undefined ? -1 : led.cells[col].places.findIndex(p => samePlace(p, lead))) + by;

  if (i >= width(col)) {
    col++;
    i = -1;
  }
  else if (i < -1) {
    col--;
    i = col < 0 ? -1 : width(col) - 1;
  }

  if (col < 0 || col >= w.keyframes.length) return s;
  if (i < 0) return { ...s, keyframe: w.keyframes[col].id, target: null };

  const all = rows.flatMap(r => r.cells[col].places[i] ?? []);
  const first = led?.cells[col].places[i] ?? all[0];

  return { ...s, keyframe: w.keyframes[col].id, target: { lead: first, all: [first, ...all.filter(p => p !== first)] } };
}
