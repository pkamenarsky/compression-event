// -----------------------------------------------------------------------------
// Moving operations, and the keyframes they are written at
//
// An entry is taken out, moved to the keyframe beside it, or told how often
// to repeat — each whole, nothing recomputed about the ones around it. Where a
// thing ends up afterwards is the list played again.
//
// Keyframes come and go the same way. An inserted one is a keyframe where
// nothing happens: every repeat running across it skips it. A deleted one
// hands what it does, and what is born and dies there, to the next, and a
// repeat that stepped there takes a step fewer, so it ends where it ended.
// -----------------------------------------------------------------------------

import { Entry, Erode, Keyframe, KeyframeId, Move, Op, Rig, counted1, indexIn, skipping, withKeys } from './rig';
import { rigOf, withRig, without } from './scene';
import { Id, VertexId, World } from './types';

/** An entry by its place in the list, or every entry of one kind. */
export type Which = number | Op['kind'];

/** Why a change to a timeline was not made, for the status line. */
export interface Refused {
  refused: string
}

function chosen(e: Entry, i: number, which: Which): boolean {
  return typeof which === 'number' ? i === which : e.op.kind === which;
}

function listOf(world: World, id: Id, k: KeyframeId): readonly Entry[] {
  return rigOf(world, id).keys.get(k) ?? [];
}

/** The keyframe after `k`, or nothing after the last. */
function after(world: World, k: KeyframeId): KeyframeId | null {
  const i = indexIn(world.keyframes, k);

  return i < 0 ? null : world.keyframes[i + 1]?.id ?? null;
}

/** Where a thing starts, as an index: a group at the first keyframe. */
function bornAt(world: World, id: Id): number {
  if (world.groups.has(id)) return 0;

  const it = world.polygons.get(id) ?? world.artefacts.get(id) ?? world.paths.get(id);

  return it === undefined ? -1 : indexIn(world.keyframes, it.birth);
}

// -----------------------------------------------------------------------------
// Entries
// -----------------------------------------------------------------------------

/** The chosen entries at `k` taken out. */
export function dropped(world: World, id: Id, k: KeyframeId, which: Which): World {
  const list = listOf(world, id, k);
  const kept = list.filter((e, i) => !chosen(e, i, which));

  return kept.length === list.length ? world : withRig(world, id, withKeys(rigOf(world, id), k, kept));
}

/**
 * The chosen entries at `k` moved, whole and in order, to the front of the
 * next keyframe's list — behind a stand there, which is its head.
 *
 * A stand does not move: it is where the thing stops hearing from upstream,
 * and anywhere else it says something else.
 */
export function pushed(world: World, id: Id, k: KeyframeId, which: Which): World | Refused {
  const next = after(world, k);

  if (next === null) return { refused: 'nothing after the last keyframe to push to' };

  const list = listOf(world, id, k);
  const going = list.filter((e, i) => chosen(e, i, which));

  if (going.length === 0) return world;
  if (going.some(e => e.op.kind === 'stand')) return { refused: 'an unchaining stays where it is' };

  const there = listOf(world, id, next);
  const head = stands(there);
  const rig = withKeys(rigOf(world, id), k, list.filter((e, i) => !chosen(e, i, which)));

  const moved = going.map(e => skipping(world.keyframes, e, next));

  return withRig(world, id, withKeys(rig, next, [...there.slice(0, head), ...moved, ...there.slice(head)]));
}

/** The chosen entries of the keyframe after `k` moved, whole and in order, to
 * the end of `k`'s list. */
export function pulled(world: World, id: Id, k: KeyframeId, which: Which): World | Refused {
  const next = after(world, k);

  if (next === null) return { refused: 'nothing after the last keyframe to pull from' };

  const born = bornAt(world, id);

  if (born < 0 || born > indexIn(world.keyframes, k)) return { refused: 'not there yet to pull into' };

  const there = listOf(world, id, next);
  const going = there.filter((e, i) => chosen(e, i, which));

  if (going.length === 0) return world;
  if (going.some(e => e.op.kind === 'stand')) return { refused: 'an unchaining stays where it is' };

  const rig = withKeys(rigOf(world, id), next, there.filter((e, i) => !chosen(e, i, which)));

  return withRig(world, id, withKeys(rig, k, [...listOf(world, id, k), ...going]));
}

/** How many stands a list opens with. */
function stands(list: readonly Entry[]): number {
  const i = list.findIndex(e => e.op.kind !== 'stand');

  return i < 0 ? list.length : i;
}

/** How many keyframes an entry contributes to: `null` to the end. */
export function timed(world: World, id: Id, k: KeyframeId, index: number, times: number | null): World | Refused {
  if (times !== null && !(Number.isInteger(times) && times >= 1)) return { refused: 'a repeat runs once or more' };

  const list = listOf(world, id, k);
  const e = list[index];

  if (e === undefined || e.times === times) return world;
  if (e.op.kind === 'stand') return { refused: 'an unchaining does not repeat' };

  const now = list.map((x, i) => (i === index ? { ...x, times } : x));

  return withRig(world, id, withKeys(rigOf(world, id), k, now));
}

// -----------------------------------------------------------------------------
// Keyframes
// -----------------------------------------------------------------------------

/** Keyframes that go by their place are renamed to it. */
function numbered(keyframes: readonly Keyframe[]): Keyframe[] {
  return keyframes.map((f, i) => (/^v\d+$/.test(f.name) || f.name === '' ? { ...f, name: `v${i}` } : f));
}

/** Whether an entry written at index `j` has steps left to take after index
 * `i`. */
function going(keyframes: readonly Keyframe[], e: Entry, j: number, i: number): boolean {
  return e.times === null || counted1(keyframes, e, j, i) < e.times;
}

/** Whether an entry written at index `j` takes a step at index `i`. */
function stepsAt(keyframes: readonly Keyframe[], e: Entry, j: number, i: number): boolean {
  return i > j && !e.skip?.has(keyframes[i].id) && going(keyframes, e, j, i - 1);
}

/** Every entry of a rig, wherever it is written, through `f`: the lists and
 * both corner maps. */
function everyEntry(rig: Rig, f: <E extends Entry>(e: E, k: KeyframeId) => E): Rig {
  const maps = <E extends Entry>(m: ReadonlyMap<VertexId, ReadonlyMap<KeyframeId, E>>) =>
    new Map([...m].map(([v, map]) => [v, new Map([...map].map(([k, e]) => [k, f(e, k)]))]));

  return {
    keys: new Map([...rig.keys].map(([k, list]) => [k, list.map(e => f(e, k))])),
    nudges: maps(rig.nudges),
    depths: maps(rig.depths),
  };
}

export interface Inserted {
  world: World
  key: KeyframeId
}

/**
 * A keyframe put in after `after`, where nothing happens.
 *
 * It is the keyframe before it over again, and every keyframe after it is
 * where it was: nothing is written there, and every repeat running across it
 * skips it. What goes on there is then brought in by hand — pulled from the
 * next keyframe, pushed from the one before, or done there.
 */
export function inserted(world: World, after: KeyframeId): Inserted | null {
  const keyframes = world.keyframes;
  const j = indexIn(keyframes, after);

  if (j < 0) return null;

  const key = Math.max(...keyframes.map(f => f.id)) + 1;

  const skipped = <E extends Entry>(e: E, k: KeyframeId): E => {
    const i = indexIn(keyframes, k);

    if (i > j || !going(keyframes, e, i, j)) return e;

    return { ...e, skip: new Set([...(e.skip ?? []), key]) };
  };

  const rigs = new Map([...world.rigs].map(([id, rig]) => [id, everyEntry(rig, skipped)]));
  const order = numbered([...keyframes.slice(0, j + 1), { id: key, name: '', visible: true }, ...keyframes.slice(j + 1)]);

  return { world: { ...world, keyframes: order, rigs }, key };
}

/**
 * Keyframe `k` taken out.
 *
 * What it does to each thing goes to the front of the next keyframe's list,
 * and what is born or dies at it is born or dies at the next — a thing that
 * then lives nowhere goes entirely. A repeat that stepped there has one step
 * fewer, so it ends where it ended. The last keyframe's writing goes with it,
 * what dies there lives to the end, and what is born there goes.
 *
 * Refused where one corner would end up with two repeats at one keyframe,
 * which a corner has no room for, and for the only keyframe there is.
 */
export function deleted(world: World, k: KeyframeId): World | Refused {
  const keyframes = world.keyframes;
  const d = indexIn(keyframes, k);

  if (d < 0) return world;
  if (keyframes.length === 1) return { refused: 'the only keyframe stays' };

  const next = keyframes[d + 1]?.id ?? null;
  const left = keyframes.filter(f => f.id !== k);

  // Written before it and stepping there, or written there and stepping at
  // the next, which is now where it begins: a step fewer either way. Its skips
  // are the ones still ahead of where it is written.
  const shortened = <E extends Entry>(e: E, at: KeyframeId): E => {
    const i = indexIn(keyframes, at);
    const lost = i < d
      ? stepsAt(keyframes, e, i, d)
      : i === d && next !== null && stepsAt(keyframes, e, d, d + 1);
    const out = lost && e.times !== null ? { ...e, times: e.times - 1 } : e;

    return skipping(left, out, i === d && next !== null ? next : at);
  };

  const rigs = new Map<Id, Rig>();

  for (const [id, was] of world.rigs) {
    const rig = everyEntry(was, shortened);
    const keys = new Map(rig.keys);
    const mine = keys.get(k) ?? [];

    keys.delete(k);

    if (next !== null && mine.length > 0) keys.set(next, [...mine, ...(keys.get(next) ?? [])]);

    const nudges = cornerMaps<Move, Entry<Move>>(rig.nudges, k, next, (a, b) => ({
      kind: 'move' as const,
      by: { x: a.by.x + b.by.x, y: a.by.y + b.by.y },
    }));
    const depths = cornerMaps<Erode, Entry<Erode>>(rig.depths, k, next, (a, b) => ({
      kind: 'erode' as const,
      by: a.by + b.by,
    }));

    if (nudges === null || depths === null) {
      return { refused: 'a corner would have two repeats at one keyframe' };
    }

    rigs.set(id, { keys, nudges, depths });
  }
  // A life moved off `k`, or nothing where none is left.
  const life = <T extends { birth: KeyframeId, death: KeyframeId | null }>(it: T): T | null => {
    const moved = (x: KeyframeId): KeyframeId | null => (x === k ? next : x);
    const birth = moved(it.birth);
    const death = it.death === null ? null : moved(it.death);

    if (birth === null || birth === death) return null;

    return birth === it.birth && death === it.death ? it : { ...it, birth, death };
  };

  const gone = new Set<Id>();
  const polygons = new Map(world.polygons);
  const artefacts = new Map(world.artefacts);
  const paths = new Map(world.paths);
  const corners = new Set<VertexId>();

  for (const [id, p] of world.polygons) {
    const lived = life(p);

    if (lived === null) {
      polygons.delete(id);
      gone.add(id);
      continue;
    }

    const points = lived.points.flatMap(c => {
      const kept = life(c);

      if (kept === null) corners.add(c.id);

      return kept === null ? [] : [kept];
    });

    polygons.set(id, points.length === lived.points.length && points.every((c, i) => c === lived.points[i])
      ? lived
      : { ...lived, points });
  }

  for (const [map, source] of [[artefacts, world.artefacts], [paths, world.paths]] as const) {
    for (const [id, it] of source) {
      const lived = life(it);

      if (lived === null) {
        map.delete(id);
        gone.add(id);
      }
      else {
        (map as Map<Id, typeof lived>).set(id, lived);
      }
    }
  }

  for (const id of gone) rigs.delete(id);

  if (corners.size > 0) {
    for (const [id, rig] of rigs) {
      const nudges = new Map([...rig.nudges].filter(([v]) => !corners.has(v)));
      const depths = new Map([...rig.depths].filter(([v]) => !corners.has(v)));

      rigs.set(id, { ...rig, nudges, depths });
    }
  }

  const out: World = {
    ...world,
    keyframes: numbered(left),
    polygons,
    artefacts,
    paths,
    rigs: new Map([...rigs].filter(([, r]) => r.keys.size > 0 || r.nudges.size > 0 || r.depths.size > 0)),
  };

  return gone.size === 0 ? out : without(out, gone);
}

/** A rig's corner maps with `k` taken out: its entries handed to `next`, and
 * added to what is there where both happen as often. */
function cornerMaps<O extends Op, E extends Entry<O>>(
  maps: ReadonlyMap<VertexId, ReadonlyMap<KeyframeId, E>>,
  k: KeyframeId,
  next: KeyframeId | null,
  add: (a: O, b: O) => O,
): Map<VertexId, Map<KeyframeId, E>> | null {
  const out = new Map<VertexId, Map<KeyframeId, E>>();

  for (const [v, map] of maps) {
    const m = new Map(map);
    const mine = m.get(k);

    m.delete(k);

    if (next !== null && mine !== undefined) {
      const there = m.get(next);

      if (there === undefined) m.set(next, mine);
      else if (there.times === mine.times && sameSkips(there, mine)) m.set(next, { ...there, op: add(mine.op, there.op) });
      else return null;
    }

    if (m.size > 0) out.set(v, m);
  }

  return out;
}

function sameSkips(a: Entry, b: Entry): boolean {
  const x = a.skip ?? new Set(), y = b.skip ?? new Set();

  return x.size === y.size && [...x].every(s => y.has(s));
}
