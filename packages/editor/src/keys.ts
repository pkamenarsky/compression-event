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

import {
  Amount,
  CornerKind,
  Entry,
  Keyframe,
  KeyframeId,
  Move,
  Op,
  Rig,
  blank,
  cornerMapOf,
  cornered,
  counted1,
  eachCornerMap,
  indexIn,
  skipping,
  withKeys,
  entriesFor,
  keysOf,
} from './rig';
import { rigOf, withRig, without } from './scene';
import { Id, VertexId, World } from './types';

/** An entry by its place in the list, several by theirs, every entry of one
 * kind, or the whole list. */
export type Which = number | readonly number[] | Op['kind'] | 'all';

/**
 * Where one entry is written: the `index`-th of what keyframe `at` does to a
 * thing, or a corner's nudge, depth, round or deform there, which have maps of
 * their own — see `Rig`. What the keyframe view picks.
 */
export type Place = Listed | Cornered;

export interface Listed {
  id: Id
  at: KeyframeId
  index: number
}

export interface Cornered {
  id: Id
  at: KeyframeId
  corner: VertexId
  kind: CornerKind
}

export function samePlace(a: Place, b: Place): boolean {
  if (a.id !== b.id || a.at !== b.at) return false;
  if ('index' in a) return 'index' in b && a.index === b.index;

  return 'corner' in b && a.corner === b.corner && a.kind === b.kind;
}

/** Why a change to a timeline was not made, for the status line. */
export interface Refused {
  refused: string
}

function chosen(e: Entry, i: number, which: Which): boolean {
  if (which === 'all') return true;
  if (typeof which === 'number') return i === which;
  if (typeof which === 'string') return e.op.kind === which;

  return which.includes(i);
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

/**
 * A repeat told to wait over keyframe `at`, or to step there again where it
 * was waiting.
 *
 * Where it stops stays put: a step taken out is one fewer, and a wait inside
 * the span stepped over again is one more. Only taking out the last step moves
 * the end, back to the step before, since there is then nothing there to stop
 * on. How far it runs is changed by saying so — see `timed`.
 */
export function skipToggled(world: World, id: Id, k: KeyframeId, index: number, at: KeyframeId): World | Refused {
  return skipToggledAt(world, { id, at: k, index }, at);
}

export function skipToggledAt(world: World, p: Place, at: KeyframeId): World | Refused {
  const keyframes = world.keyframes;
  const e = entryAt(world, p);
  const j = indexIn(keyframes, p.at), i = indexIn(keyframes, at);

  if (e === undefined) return world;
  if (e.op.kind === 'stand') return { refused: 'an unchaining does not repeat' };
  if (i <= j) return { refused: 'a repeat skips only after it starts' };

  const skip = new Set(e.skip ?? []);
  let times = e.times;

  if (skip.has(at)) {
    skip.delete(at);

    // Inside the span: it steps there now, and one more keeps the end.
    if (times !== null && going(keyframes, e, j, i)) times += 1;
  }
  else {
    if (times !== null && stepsAt(keyframes, e, j, i)) times -= 1;

    skip.add(at);
  }

  const { skip: _was, ...rest } = e;
  const out = { ...rest, times };

  return rewritten(world, p, skip.size === 0 ? out : { ...out, skip });
}

/** How many stands a list opens with. */
function stands(list: readonly Entry[]): number {
  const i = list.findIndex(e => e.op.kind !== 'stand');

  return i < 0 ? list.length : i;
}

/** How many keyframes an entry contributes to: `null` to the end. */
export function timed(world: World, id: Id, k: KeyframeId, index: number, times: number | null): World | Refused {
  return timedAt(world, { id, at: k, index }, times);
}

export function timedAt(world: World, p: Place, times: number | null): World | Refused {
  if (times !== null && !(Number.isInteger(times) && times >= 1)) return { refused: 'a repeat runs once or more' };

  const e = entryAt(world, p);

  if (e === undefined || e.times === times) return world;
  if (e.op.kind === 'stand') return { refused: 'an unchaining does not repeat' };

  return rewritten(world, p, { ...e, times });
}

// -----------------------------------------------------------------------------
// Entries by where they are written
//
// What the keyframe view picks, one entry or several at once, from lists and
// corners alike. Several in one list go together, since taking one out moves
// the places of the ones after it.
// -----------------------------------------------------------------------------

export function entryAt(world: World, p: Place): Entry | undefined {
  const rig = rigOf(world, p.id);

  if ('index' in p) return rig.keys.get(p.at)?.[p.index];

  return rig[cornerMapOf(p.kind)].get(p.corner)?.get(p.at);
}

/** The entry at `p` written over with `e`, or taken out. */
function rewritten(world: World, p: Place, e: Entry | null): World {
  const rig = rigOf(world, p.id);

  if ('index' in p) {
    const list = rig.keys.get(p.at) ?? [];
    const now = e === null ? list.filter((_x, i) => i !== p.index) : list.map((x, i) => (i === p.index ? e : x));

    return withRig(world, p.id, withKeys(rig, p.at, now));
  }

  const map = cornerMapOf(p.kind);

  return withRig(world, p.id, { ...rig, [map]: cornered(rig[map] as ReadonlyMap<VertexId, ReadonlyMap<KeyframeId, Entry>>, p.corner, p.at, e) });
}

/** Places in one thing's list at one keyframe, together, and the corners' one
 * by one. */
function split(places: readonly Place[]): { lists: Map<string, Listed[]>, corners: Cornered[] } {
  const lists = new Map<string, Listed[]>();
  const corners: Cornered[] = [];

  for (const p of places) {
    if ('corner' in p) {
      corners.push(p);
      continue;
    }

    const key = `${p.id}:${p.at}`;

    lists.set(key, [...(lists.get(key) ?? []), p]);
  }

  return { lists, corners };
}

/** The entries at `places` taken out. */
export function droppedAt(world: World, places: readonly Place[]): World {
  const { lists, corners } = split(places);
  let out = world;

  for (const ps of lists.values()) out = dropped(out, ps[0].id, ps[0].at, ps.map(p => p.index));
  for (const p of corners) out = rewritten(out, p, null);

  return out;
}

/** The entries at `places`, each at the keyframe after its own: a list's at
 * the front of the next one's, and a corner's added to what it has there. */
export function pushedAt(world: World, places: readonly Place[]): World | Refused {
  const { lists, corners } = split(places);
  let out: World = world;

  for (const ps of [...lists.values(), ...corners.map(p => [p])]) {
    const p = ps[0];
    const next = after(out, p.at);

    if (next === null) return { refused: 'nothing after the last keyframe to push to' };

    const now: World | Refused = 'corner' in p
      ? cornerMoved(out, p, next)
      : pushed(out, p.id, p.at, (ps as Listed[]).map(q => q.index));

    if ('refused' in now) return now;

    out = now;
  }

  return out;
}

/** The entries at `places`, each at the end of the keyframe before its own. */
export function pulledAt(world: World, places: readonly Place[]): World | Refused {
  const { lists, corners } = split(places);
  let out: World = world;

  for (const ps of [...lists.values(), ...corners.map(p => [p])]) {
    const p = ps[0];
    const i = indexIn(out.keyframes, p.at);
    const before: KeyframeId | undefined = out.keyframes[i - 1]?.id;

    if (before === undefined) return { refused: 'nothing before the first keyframe to pull into' };

    const next: World | Refused = 'corner' in p
      ? bornAt(out, p.id) > i - 1 ? { refused: 'not there yet to pull into' } : cornerMoved(out, p, before)
      : pulled(out, p.id, before, (ps as Listed[]).map(q => q.index));

    if ('refused' in next) return next;

    out = next;
  }

  return out;
}

/** A corner's entry moved to keyframe `to`, added to one there that repeats
 * the same way — a corner has room for one entry of each kind a keyframe. */
function cornerMoved(world: World, p: Cornered, to: KeyframeId): World | Refused {
  const e = entryAt(world, p);

  if (e === undefined) return world;

  const there = entryAt(world, { ...p, at: to });
  const moved = skipping(world.keyframes, e, to);
  let landed: Entry = moved;

  if (there !== undefined) {
    if (there.times !== moved.times || !sameSkips(there, moved)) {
      return { refused: 'a corner would have two repeats at one keyframe' };
    }

    landed = { ...there, op: added(moved.op as Move | Amount, there.op as Move | Amount) };
  }

  return rewritten(rewritten(world, p, null), { ...p, at: to }, landed);
}

/** Two of one corner's entries of one kind, as one. */
function added<O extends Move | Amount>(a: O, b: O): O {
  if (a.kind === 'move' && b.kind === 'move') return { kind: 'move', by: { x: a.by.x + b.by.x, y: a.by.y + b.by.y } } as O;
  if (a.kind !== 'move' && b.kind === a.kind) return { kind: a.kind, by: a.by + (b as Amount).by } as O;

  return b;
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
 * every corner map. */
function everyEntry(rig: Rig, f: <E extends Entry>(e: E, k: KeyframeId) => E): Rig {
  const maps = <E extends Entry>(m: ReadonlyMap<VertexId, ReadonlyMap<KeyframeId, E>>) =>
    new Map([...m].map(([v, map]) => [v, new Map([...map].map(([k, e]) => [k, f(e, k)]))]));

  return eachCornerMap({ ...rig, keys: new Map([...rig.keys].map(([k, list]) => [k, list.map(e => f(e, k))])) }, maps);
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

  const rigs = new Map([...world.rigs].map(([id, rig]) => [id, keysOf(everyEntry(entriesFor(rig), skipped))]));
  const order = numbered([...keyframes.slice(0, j + 1), { id: key, name: '', visible: true }, ...keyframes.slice(j + 1)]);

  return { world: { ...world, keyframes: order, rigs }, key };
}

/**
 * Keyframe `k` taken out.
 *
 * What it does to each thing goes to the front of the next keyframe's list,
 * what dies at it dies at the next, and what is born at it goes with it. A
 * repeat that stepped there has one step fewer, so it ends where it ended. The
 * last keyframe's writing goes with it, and what dies there lives to the end.
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

  for (const [id, keyed] of world.rigs) {
    const was = entriesFor(keyed);
    const rig = everyEntry(was, shortened);
    const keys = new Map(rig.keys);
    const mine = keys.get(k) ?? [];

    keys.delete(k);

    if (next !== null && mine.length > 0) keys.set(next, [...mine, ...(keys.get(next) ?? [])]);

    let refused = false;

    const handed = eachCornerMap({ ...rig, keys }, m => {
      const out = cornerMaps(m, k, next, added);

      if (out === null) refused = true;

      return out ?? m;
    });

    if (refused) return { refused: 'a corner would have two repeats at one keyframe' };

    rigs.set(id, handed);
  }
  // A death moved off `k`, or nothing for what was born there.
  const life = <T extends { birth: KeyframeId, death: KeyframeId | null }>(it: T): T | null => {
    if (it.birth === k) return null;

    const death = it.death === k ? next : it.death;

    return death === it.death ? it : { ...it, death };
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
      rigs.set(id, eachCornerMap(rig, m => new Map([...m].filter(([v]) => !corners.has(v)))));
    }
  }

  const out: World = {
    ...world,
    keyframes: numbered(left),
    polygons,
    artefacts,
    paths,
    rigs: new Map([...rigs].filter(([, r]) => !blank(r)).map(([id, r]) => [id, keysOf(r)])),
  };

  return gone.size === 0 ? out : without(out, gone);
}

/**
 * A thing's birth moved to keyframe `to`, and its whole life with it: its
 * death, everything written about it, and when each of its corners is born and
 * dies, all move as many keyframes as the birth did.
 *
 * What is moved past the last keyframe goes — a corner born there, and an
 * entry written there — and a death there becomes living to the end.
 */
export function reborn(world: World, id: Id, to: KeyframeId): World | Refused {
  const keyframes = world.keyframes;
  const it = world.polygons.get(id) ?? world.artefacts.get(id) ?? world.paths.get(id);
  const t = indexIn(keyframes, to);

  if (it === undefined || t < 0) return world;

  const by = t - indexIn(keyframes, it.birth);

  if (by === 0) return world;

  const shifted = (k: KeyframeId): KeyframeId | null => {
    const i = indexIn(keyframes, k);

    return i < 0 ? null : keyframes[i + by]?.id ?? null;
  };

  const entry = <E extends Entry>(e: E): E => {
    if (e.skip === undefined) return e;

    const skip = new Set([...e.skip].flatMap(s => shifted(s) ?? []));
    const { skip: _was, ...rest } = e;

    return (skip.size === 0 ? rest : { ...rest, skip }) as E;
  };

  const entries = <E>(map: ReadonlyMap<KeyframeId, E>, f: (e: E) => E): Map<KeyframeId, E> =>
    new Map([...map].flatMap(([k, e]) => {
      const there = shifted(k);

      return there === null ? [] : [[there, f(e)] as const];
    }));

  const corners = <E extends Entry>(maps: ReadonlyMap<VertexId, ReadonlyMap<KeyframeId, E>>) =>
    new Map([...maps].flatMap(([v, map]) => {
      const m = entries(map, entry);

      return m.size === 0 || gone.has(v) ? [] : [[v, m] as const];
    }));

  const death = it.death === null ? null : shifted(it.death);
  const end = death === null ? keyframes.length : indexIn(keyframes, death);
  const gone = new Set<VertexId>();
  let out: World = world;
  const polygon = world.polygons.get(id);

  if (polygon !== undefined) {
    const points = polygon.points.flatMap(c => {
      const birth = c.birth === polygon.birth ? to : shifted(c.birth);

      if (birth === null || indexIn(keyframes, birth) >= end) {
        gone.add(c.id);
        return [];
      }

      return [{ ...c, birth, death: c.death === null ? null : shifted(c.death) }];
    });

    out = { ...out, polygons: new Map(out.polygons).set(id, { ...polygon, birth: to, death, points }) };
  }
  else if (world.artefacts.has(id)) {
    out = { ...out, artefacts: new Map(out.artefacts).set(id, { ...world.artefacts.get(id)!, birth: to, death }) };
  }
  else {
    out = { ...out, paths: new Map(out.paths).set(id, { ...world.paths.get(id)!, birth: to, death }) };
  }

  const rig = rigOf(world, id);

  return withRig(out, id, eachCornerMap({ ...rig, keys: entries(rig.keys, list => list.map(entry)) }, corners));
}

/**
 * A thing taken out at keyframe `at` instead, or living to the end for
 * nothing. What is written about it stays where it is: past its death it is
 * inert, and there again if it is brought back.
 *
 * Refused where it would die before it is born.
 */
export function redied(world: World, id: Id, at: KeyframeId | null): World | Refused {
  const keyframes = world.keyframes;
  const it = world.polygons.get(id) ?? world.artefacts.get(id) ?? world.paths.get(id);

  if (it === undefined || it.death === at) return world;
  if (at !== null && indexIn(keyframes, at) <= indexIn(keyframes, it.birth)) {
    return { refused: 'it would be gone before it is born' };
  }

  if (world.polygons.has(id)) return { ...world, polygons: new Map(world.polygons).set(id, { ...world.polygons.get(id)!, death: at }) };
  if (world.artefacts.has(id)) return { ...world, artefacts: new Map(world.artefacts).set(id, { ...world.artefacts.get(id)!, death: at }) };

  return { ...world, paths: new Map(world.paths).set(id, { ...world.paths.get(id)!, death: at }) };
}

/** A rig's corner maps with `k` taken out: its entries handed to `next`, and
 * added to what is there where both happen as often. */
function cornerMaps<E extends Entry>(
  maps: ReadonlyMap<VertexId, ReadonlyMap<KeyframeId, E>>,
  k: KeyframeId,
  next: KeyframeId | null,
  add: <O extends Move | Amount>(a: O, b: O) => O,
): Map<VertexId, Map<KeyframeId, E>> | null {
  const out = new Map<VertexId, Map<KeyframeId, E>>();

  for (const [v, map] of maps) {
    const m = new Map(map);
    const mine = m.get(k);

    m.delete(k);

    if (next !== null && mine !== undefined) {
      const there = m.get(next);

      if (there === undefined) m.set(next, mine);
      else if (there.times === mine.times && sameSkips(there, mine)) m.set(next, { ...there, op: add(mine.op as Move | Amount, there.op as Move | Amount) });
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
