// -----------------------------------------------------------------------------
// Moving keys, and the keyframes they are written at
//
// A key is taken out, moved to the keyframe beside it, or told how often to
// repeat — each whole, nothing recomputed about the ones around it. Where a
// thing ends up afterwards is the list played again.
//
// Moving one between keyframes is a splice and nothing else: it leaves its
// column's list and goes on the end of the one before, or the front of the one
// after. The keys either side are untouched and the order they play in is the
// order they were already in. See `PLAN-keys.md`.
//
// Keyframes come and go the same way. An inserted one is a keyframe where
// nothing happens: every repeat running across it skips it. A deleted one
// hands what it does, and what is born and dies there, to the next, and a
// repeat that stepped there takes a step fewer, so it ends where it ended.
// -----------------------------------------------------------------------------

import {
  CornerKind,
  Key,
  KeyRig,
  Keyframe,
  KeyframeId,
  NOTHING,
  REST,
  Repeat,
  Typed,
  blankKeys,
  counted1,
  emptyBeside,
  foldedBy,
  heldOf,
  indexIn,
  keyOnce,
  keysAt,
  nextKey,
  retyped,
  kindOf,
  skipping,
  withKeysAt,
} from './rig';
import { keyRigOf, withKeyRig, without } from './scene';
import { EditorState, Id, Target, VertexId, World, within } from './types';

/** A key by its place in the list, several by theirs, every key of one kind,
 * or the whole list. */
export type Which = number | readonly number[] | string | 'all';

/**
 * Where one key is written: the key with id `key` among what keyframe `at`
 * does to a thing, or one corner's nudge, depth, round or deform there, which
 * is in a key with whatever else that gesture wrote about corners. What the
 * keyframe view picks.
 *
 * By the key's id and never by where it is in the list: a place is kept
 * across edits, and every edit that adds, takes out or moves a key moves the
 * ones after it along.
 */
export type Place = Listed | Cornered;

export interface Listed {
  id: Id
  at: KeyframeId
  key: number
}

export interface Cornered {
  id: Id
  at: KeyframeId
  corner: VertexId
  kind: CornerKind
}

/** The place of the `index`-th key of what `k` does to `id`, as it is now. A
 * place that names nothing where there is none. */
export function listedAt(world: World, id: Id, k: KeyframeId, index: number): Listed {
  return { id, at: k, key: listOf(world, id, k)[index]?.id ?? -1 };
}

export function samePlace(a: Place, b: Place): boolean {
  if (a.id !== b.id || a.at !== b.at) return false;
  if ('key' in a) return 'key' in b && a.key === b.key;

  return 'corner' in b && a.corner === b.corner && a.kind === b.kind;
}

/** Why a change to a timeline was not made, for the status line. */
export interface Refused {
  refused: string
}

function chosen(key: Key, i: number, which: Which): boolean {
  if (which === 'all') return true;
  if (typeof which === 'number') return i === which;
  if (typeof which === 'string') return kindOf(key) === which;

  return which.includes(i);
}

function listOf(world: World, id: Id, k: KeyframeId): readonly Key[] {
  return keysAt(keyRigOf(world, id), k);
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

/** The chosen keys at `k` taken out. */
export function dropped(world: World, id: Id, k: KeyframeId, which: Which): World {
  const list = listOf(world, id, k);
  const kept = list.filter((e, i) => !chosen(e, i, which));

  return kept.length === list.length ? world : withKeyRig(world, id, withKeysAt(keyRigOf(world, id), k, kept));
}

/**
 * The chosen entries at `k` moved, whole and in order, to the front of the
 * next keyframe's list — behind a stand there, which is its head.
 *
 * Only the last of the list: a key pushed past the ones after it would play
 * after them, and keys are not put in another order by being moved along.
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
  if (going.some(e => e.stand !== undefined)) return { refused: 'an unchaining stays where it is' };
  if (!list.every((e, i) => chosen(e, i, which) || i < list.length - going.length)) {
    return { refused: 'only the last keys go on to the next keyframe' };
  }

  const there = listOf(world, id, next);
  const head = stands(there);
  const rig = withKeysAt(keyRigOf(world, id), k, list.filter((e, i) => !chosen(e, i, which)));

  const moved = going.map(e => skipping(world.keyframes, e, next));

  return withKeyRig(world, id, withKeysAt(rig, next, [...there.slice(0, head), ...moved, ...there.slice(head)]));
}

/** The chosen entries of the keyframe after `k` moved, whole and in order, to
 * the end of `k`'s list. Only the first of it, for the same reason as
 * `pushed`. */
export function pulled(world: World, id: Id, k: KeyframeId, which: Which): World | Refused {
  const next = after(world, k);

  if (next === null) return { refused: 'nothing after the last keyframe to pull from' };

  const born = bornAt(world, id);

  if (born < 0 || born > indexIn(world.keyframes, k)) return { refused: 'not there yet to pull into' };

  const there = listOf(world, id, next);
  const going = there.filter((e, i) => chosen(e, i, which));

  if (going.length === 0) return world;
  if (going.some(e => e.stand !== undefined)) return { refused: 'an unchaining stays where it is' };
  if (!there.every((e, i) => chosen(e, i, which) || i >= going.length)) {
    return { refused: 'only the first keys go back to the keyframe before' };
  }

  const rig = withKeysAt(keyRigOf(world, id), next, there.filter((e, i) => !chosen(e, i, which)));

  return withKeyRig(world, id, withKeysAt(rig, k, [...listOf(world, id, k), ...going]));
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
  return skipToggledAt(world, listedAt(world, id, k, index), at);
}

export function skipToggledAt(world: World, p: Place, at: KeyframeId): World | Refused {
  const keyframes = world.keyframes;
  const e = entryAt(world, p);
  const j = indexIn(keyframes, p.at), i = indexIn(keyframes, at);

  if (e === undefined) return world;
  if (e.stand !== undefined) return { refused: 'an unchaining does not repeat' };
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
function stands(list: readonly Key[]): number {
  const i = list.findIndex(key => key.stand === undefined);

  return i < 0 ? list.length : i;
}

/** How many keyframes an entry contributes to: `null` to the end. */
export function timed(world: World, id: Id, k: KeyframeId, index: number, times: number | null): World | Refused {
  return timedAt(world, listedAt(world, id, k, index), times);
}

export function timedAt(world: World, p: Place, times: number | null): World | Refused {
  if (times !== null && !(Number.isInteger(times) && times >= 1)) return { refused: 'a repeat runs once or more' };

  const e = entryAt(world, p);

  if (e === undefined || e.times === times) return world;
  if (e.stand !== undefined) return { refused: 'an unchaining does not repeat' };

  return rewritten(world, p, { ...e, times });
}

/**
 * The key at `p` with some of its numbers typed over: see `retyped` in
 * `rig.ts`. A key about corners alone gets a delta to hold them.
 */
export function retypedAt(world: World, p: Place, typed: Typed): World | Refused {
  const e = entryAt(world, p);

  if (e === undefined) return world;
  if (e.stand !== undefined) return { refused: 'an unchaining is a state, not a change to type into' };

  return rewritten(world, p, { ...e, by: retyped(e.by ?? NOTHING, typed) });
}

// -----------------------------------------------------------------------------
// Entries by where they are written
//
// What the keyframe view picks, one entry or several at once, from lists and
// corners alike. Several in one list go together, since taking one out moves
// the places of the ones after it.
// -----------------------------------------------------------------------------

/**
 * The key a place names: the `index`-th of its keyframe's, or the one holding
 * that corner's writing of that kind.
 *
 * A corner's writing is in a key with whatever else was written about corners
 * by the same gesture, so a corner names a key rather than having a timeline
 * of its own. Which key that is is a question the list answers: the first that
 * holds it. Two of them holding one corner's writing of one kind at one
 * keyframe is a thing the model allows and the editor does not write.
 */
export function entryAt(world: World, p: Place): Key | undefined {
  const list = listOf(world, p.id, p.at);

  if ('key' in p) return list.find(key => key.id === p.key);

  return list.find(key => key[heldOf(p.kind)]?.has(p.corner));
}

/** Where in its keyframe's list the key a place names is, or -1. */
function placed(world: World, p: Place): number {
  const list = listOf(world, p.id, p.at);

  if ('key' in p) return list.findIndex(key => key.id === p.key);

  return list.findIndex(key => key[heldOf(p.kind)]?.has(p.corner));
}

/** The key at `p` written over with `key`, or taken out. */
function rewritten(world: World, p: Place, key: Key | null): World {
  const rig = keyRigOf(world, p.id);
  const list = keysAt(rig, p.at);
  const at = placed(world, p);

  if (at < 0) return world;

  const now = key === null
    ? list.filter((_x, i) => i !== at)
    : list.map((x, i) => (i === at ? key : x));

  return withKeyRig(world, p.id, withKeysAt(rig, p.at, now));
}

/** One corner's writing of one kind taken out of the key holding it, and the
 * key with it where it held nothing else. */
function unwritten(world: World, p: Cornered): World {
  const key = entryAt(world, p);

  if (key === undefined) return world;

  return rewritten(world, p, lessCorner(key, p.kind, p.corner));
}

function lessCorner(key: Key, kind: CornerKind, corner: VertexId): Key | null {
  const held = heldOf(kind);
  const mine = new Map(key[held] ?? []);

  mine.delete(corner);

  const out: Key = { ...key, [held]: mine.size === 0 ? undefined : mine };

  return bare(out) ? null : out;
}

/** A key with everything about the corners in `gone` taken out, or nothing
 * where that was all it held. */
function lessCorners(key: Key, gone: ReadonlySet<VertexId>): Key | null {
  const mine = key.corners;

  if (mine === undefined || ![...mine.keys()].some(v => gone.has(v))) return key;

  const kept = new Map([...mine].filter(([v]) => !gone.has(v)));
  const out = { ...key, corners: kept.size === 0 ? undefined : kept };

  return bare(out) ? null : out;
}

/** Whether a key says nothing at all any more. */
function bare(key: Key): boolean {
  return key.by === undefined && key.stand === undefined
    && key.corners === undefined;
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

/** Where in their list the keys `places` name are, now — the ones still
 * there. */
function indices(world: World, places: readonly Listed[]): number[] {
  return places.map(p => placed(world, p)).filter(i => i >= 0);
}

/** The entries at `places` taken out. */
export function droppedAt(world: World, places: readonly Place[]): World {
  const { lists, corners } = split(places);
  let out = world;

  for (const ps of lists.values()) out = dropped(out, ps[0].id, ps[0].at, indices(out, ps));
  for (const p of corners) out = unwritten(out, p);

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
      : pushed(out, p.id, p.at, indices(out, ps as Listed[]));

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
      : pulled(out, p.id, before, indices(out, ps as Listed[]));

    if ('refused' in next) return next;

    out = next;
  }

  return out;
}

/**
 * One corner's writing moved to keyframe `to`, added to what it has there.
 *
 * It goes into the key that already holds that corner's writing of that kind,
 * or the keyframe's last key about corners alone, or one of its own. Refused
 * where the key it would land in repeats differently from the one it came
 * from: what is being moved is a repeat as well as an amount, and two of them
 * in one key would be one.
 */
function cornerMoved(world: World, p: Cornered, to: KeyframeId): World | Refused {
  const from = entryAt(world, p);

  if (from === undefined) return world;

  const held = heldOf(p.kind);
  const by = from[held]!.get(p.corner)!;
  const moved = skipping(world.keyframes, from, to);
  const out = unwritten(world, p);
  const rig = keyRigOf(out, p.id);
  const list = keysAt(rig, to);
  const at = list.findIndex(key => key[held]?.has(p.corner));
  const into = at < 0 ? list.findIndex(key => bareCorners(key)) : at;

  if (into >= 0 && !sameRepeat(list[into], moved)) {
    return { refused: 'a corner would have two repeats at one keyframe' };
  }

  if (into < 0) {
    const key: Key = {
      id: nextKey(rig),
      ref: REST.t,
      [held]: new Map([[p.corner, by]]),
      times: moved.times,
      ...(moved.skip === undefined ? {} : { skip: moved.skip }),
    };

    return withKeyRig(out, p.id, withKeysAt(rig, to, [...list, key]));
  }

  const was = list[into];
  const mine = new Map(was[held] ?? []);
  const there = mine.get(p.corner);

  mine.set(p.corner, there === undefined ? by : { x: by.x + there.x, y: by.y + there.y });

  return withKeyRig(out, p.id, withKeysAt(rig, to, list.map((x, i) => (i === into ? { ...was, [held]: mine } : x))));
}

/** Whether a key is about single corners and nothing else. */
function bareCorners(key: Key): boolean {
  return key.by === undefined && key.stand === undefined;
}

/** Whether two things repeat the same way. */
function sameRepeat(a: Repeat, b: Repeat): boolean {
  if (a.times !== b.times) return false;

  const x = a.skip ?? new Set<KeyframeId>(), y = b.skip ?? new Set<KeyframeId>();

  return x.size === y.size && [...x].every(k => y.has(k));
}

/**
 * A thing just made, with its first key open where it is born: empty, drawn
 * in its row from the start, and what its first gesture goes into. `world`
 * itself where it has one there already.
 */
export function firstKeyed(world: World, id: Id): World {
  const born = world.keyframes[bornAt(world, id)]?.id;

  if (born === undefined || listOf(world, id, born).length > 0) return world;

  const rig = keyRigOf(world, id);

  return withKeyRig(world, id, withKeysAt(rig, born, [keyOnce(nextKey(rig), REST.t, NOTHING)]));
}

/**
 * An empty key put in `id`'s list at `k`, before the `index`-th — at the end
 * where that is past the last, and never ahead of a stand, which is the
 * list's head. Its place, or why there is none: a thing takes no key where it
 * is not there.
 */
export function keyInserted(world: World, id: Id, k: KeyframeId, index: number): { world: World, place: Listed } | Refused {
  const i = indexIn(world.keyframes, k);
  const born = bornAt(world, id);
  const it = world.polygons.get(id) ?? world.artefacts.get(id) ?? world.paths.get(id);
  const death = it?.death == null ? world.keyframes.length : indexIn(world.keyframes, it.death);

  if (i < 0 || born < 0 || born > i || i >= death) return { refused: 'not there to take a key' };

  const rig = keyRigOf(world, id);
  const list = keysAt(rig, k);
  const at = Math.max(stands(list), Math.min(index, list.length));
  const there = emptyBeside(list, at);

  if (there !== undefined) return { world, place: { id, at: k, key: there.id } };

  const key = keyOnce(nextKey(rig), REST.t, NOTHING);

  return {
    world: withKeyRig(world, id, withKeysAt(rig, k, [...list.slice(0, at), key, ...list.slice(at)])),
    place: { id, at: k, key: key.id },
  };
}

/**
 * The key at `from` merged into the one at `into`, of the same thing: one key
 * where `into` was, doing what the two did, the one earlier in the timeline
 * first. Refused where they cannot be one — a repeat or an unchaining, or two
 * that turn or stretch about different points or axes. See `foldedBy`.
 */
export function merged(world: World, from: Listed, into: Listed): World | Refused {
  if (from.id !== into.id) return { refused: 'a key merges only with a key of the same thing' };
  if (samePlace(from, into)) return world;

  const a = entryAt(world, from), b = entryAt(world, into);

  if (a === undefined || b === undefined) return world;
  if (a.stand !== undefined || b.stand !== undefined) return { refused: 'an unchaining does not merge' };
  if (a.times !== 1 || b.times !== 1 || a.skip !== undefined || b.skip !== undefined) {
    return { refused: 'a repeating key does not merge' };
  }

  const i = indexIn(world.keyframes, from.at), j = indexIn(world.keyframes, into.at);
  const [first, then] = i < j || (i === j && placed(world, from) < placed(world, into)) ? [a, b] : [b, a];

  let ref = first.ref;
  let by = first.by;

  if (by === undefined) {
    ref = then.ref;
    by = then.by;
  }
  else if (then.by !== undefined) {
    const both = foldedBy(first, then.ref, then.by);

    if (both === null) return { refused: 'these two keys do not make one' };

    ref = both === 'gone' ? first.ref : both.ref;
    by = both === 'gone' ? NOTHING : both.by;
  }

  const corners = new Map(first.corners ?? []);

  for (const [v, d] of then.corners ?? []) {
    const there = corners.get(v);

    corners.set(v, there === undefined ? d : { x: there.x + d.x, y: there.y + d.y });
  }

  const key: Key = {
    ...b,
    ref,
    ...(by === undefined ? {} : { by }),
    ...(corners.size === 0 ? {} : { corners }),
  };

  if (by === undefined) delete key.by;
  if (corners.size === 0) delete key.corners;

  return rewritten(rewritten(world, into, key), from, null);
}

// -----------------------------------------------------------------------------
// Keyframes
// -----------------------------------------------------------------------------

/** Keyframes that go by their place are renamed to it. */
function numbered(keyframes: readonly Keyframe[]): Keyframe[] {
  return keyframes.map((f, i) => (/^v\d+$/.test(f.name) || f.name === '' ? { ...f, name: `v${i}` } : f));
}

/** Whether a key written at index `j` has steps left to take after index
 * `i`. */
function going(keyframes: readonly Keyframe[], e: Repeat, j: number, i: number): boolean {
  return e.times === null || counted1(keyframes, e, j, i) < e.times;
}

/** Whether a key written at index `j` takes a step at index `i`. */
function stepsAt(keyframes: readonly Keyframe[], e: Repeat, j: number, i: number): boolean {
  return i > j && !e.skip?.has(keyframes[i].id) && going(keyframes, e, j, i - 1);
}

/** Every key of a rig, through `f`. */
function everyKey(rig: KeyRig, f: (key: Key, k: KeyframeId) => Key): KeyRig {
  return { keys: new Map([...rig.keys].map(([k, list]) => [k, list.map(key => f(key, k))])) };
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

  const skipped = (e: Key, k: KeyframeId): Key => {
    const i = indexIn(keyframes, k);

    if (i > j || !going(keyframes, e, i, j)) return e;

    return { ...e, skip: new Set([...(e.skip ?? []), key]) };
  };

  const rigs = new Map([...world.rigs].map(([id, rig]) => [id, everyKey(rig, skipped)]));
  const order = numbered([...keyframes.slice(0, j + 1), { id: key, name: '', visible: true }, ...keyframes.slice(j + 1)]);

  return { world: { ...world, keyframes: order, rigs }, key };
}

/**
 * A keyframe put in before `k`, where nothing happens: `inserted` after the
 * one before it, or in front of the first.
 *
 * In front of the first there is no keyframe before to be over again, so it is
 * where things are made: what was born at `k` is born there instead, and what
 * `k` does to it is then the first thing it does rather than how it was made.
 */
export function insertedBefore(world: World, k: KeyframeId): Inserted | null {
  const keyframes = world.keyframes;
  const j = indexIn(keyframes, k);

  if (j < 0) return null;
  if (j > 0) return inserted(world, keyframes[j - 1].id);

  const key = Math.max(...keyframes.map(f => f.id)) + 1;
  const moved = <T extends { birth?: KeyframeId }>(it: T): T => (it.birth === k ? { ...it, birth: key } : it);

  const polygons = new Map([...world.polygons].map(([id, p]) => [id, { ...moved(p), points: p.points.map(moved) }]));
  const artefacts = new Map([...world.artefacts].map(([id, a]) => [id, moved(a)]));
  const paths = new Map([...world.paths].map(([id, p]) => [id, moved(p)]));
  const groups = new Map([...world.groups].map(([id, g]) => [id, moved(g)]));
  const order = numbered([{ id: key, name: '', visible: true }, ...keyframes]);

  return { world: { ...world, keyframes: order, polygons, artefacts, paths, groups }, key };
}

/**
 * Keyframe `k` taken out.
 *
 * `'handed'`, what it does to each thing goes to the front of the next
 * keyframe's list; `'dropped'`, it goes with it; `'merged'`, it is handed on
 * and what is born at it is born at the next instead of going with it.
 * what dies at it dies at the next, and what is born at it goes with it. A
 * repeat that stepped there has one step fewer, so it ends where it ended. The
 * last keyframe's writing goes with it, and what dies there lives to the end.
 *
 * Refused where one corner would end up with two repeats at one keyframe,
 * which a corner has no room for, and for the only keyframe there is.
 */
export function deleted(world: World, k: KeyframeId, how: 'handed' | 'dropped' | 'merged' = 'handed'): World | Refused {
  const keyframes = world.keyframes;
  const d = indexIn(keyframes, k);

  if (d < 0) return world;
  if (keyframes.length === 1) return { refused: 'the only keyframe stays' };

  const next = keyframes[d + 1]?.id ?? null;
  const left = keyframes.filter(f => f.id !== k);

  // Written before it and stepping there, or written there and stepping at
  // the next, which is now where it begins: a step fewer either way. Its skips
  // are the ones still ahead of where it is written.
  const shortened = (e: Key, at: KeyframeId): Key => {
    const i = indexIn(keyframes, at);
    const lost = i < d
      ? stepsAt(keyframes, e, i, d)
      : i === d && next !== null && stepsAt(keyframes, e, d, d + 1);
    const out = lost && e.times !== null ? { ...e, times: e.times - 1 } : e;

    return skipping(left, out, i === d && next !== null ? next : at);
  };

  const rigs = new Map<Id, KeyRig>();

  // What the keyframe did is handed to the next, in front of what that one
  // does: a splice, and no question about a corner written in both, since two
  // keys at one keyframe each holding some of a corner's writing add up the
  // way they did when they were a keyframe apart.
  for (const [id, was] of world.rigs) {
    const rig = everyKey(was, shortened);
    const keys = new Map(rig.keys);
    const mine = keys.get(k) ?? [];

    keys.delete(k);

    if (how !== 'dropped' && next !== null && mine.length > 0) keys.set(next, [...mine, ...(keys.get(next) ?? [])]);

    rigs.set(id, { keys });
  }
  // A death moved off `k`, or nothing for what was born there.
  const life = <T extends { birth: KeyframeId, death: KeyframeId | null }>(it: T): T | null => {
    if (it.birth === k && (how !== 'merged' || next === null)) return null;

    const birth = it.birth === k ? next! : it.birth;
    const death = it.death === k ? next : it.death;

    // Born at `k` and gone by the next, it lived in `k` alone.
    if (birth === death) return null;

    return death === it.death && birth === it.birth ? it : { ...it, birth, death };
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

  // What a corner that has gone had written about it goes with it, and a key
  // left holding nothing goes too.
  if (corners.size > 0) {
    for (const [id, rig] of rigs) {
      rigs.set(id, { keys: new Map([...rig.keys].flatMap(([at, list]) => {
        const kept = list.map(key => lessCorners(key, corners)).flatMap(key => (key === null ? [] : [key]));

        return kept.length === 0 ? [] : [[at, kept] as const];
      })) });
    }
  }

  // A group made at `k` was made at the one its keys went to, or where `k` was
  // the last, at the one before. See `bornAt`.
  const groups = new Map([...world.groups].map(([id, g]) => [
    id,
    g.birth === k ? { ...g, birth: next ?? keyframes[d - 1].id } : g,
  ]));

  const out: World = {
    ...world,
    keyframes: numbered(left),
    groups,
    polygons,
    artefacts,
    paths,
    rigs: new Map([...rigs].filter(([, r]) => !blankKeys(r))),
  };

  return gone.size === 0 ? out : without(out, gone);
}

/**
 * Keyframe `from` merged into `into`, the one beside it: one keyframe doing
 * what the two did, in the order they did it, and what is born or dies at
 * either born or dying there. Only beside: past keyframes between, what they
 * do would have to play in another order.
 *
 * Either way it is the earlier of the two handed on to the later — see
 * `deleted` — and the one left is named and shown as `into` was.
 */
export function mergedKeyframes(world: World, from: KeyframeId, into: KeyframeId): World | Refused {
  const i = indexIn(world.keyframes, from), j = indexIn(world.keyframes, into);

  if (i < 0 || j < 0 || i === j) return world;
  if (Math.abs(i - j) !== 1) return { refused: 'a keyframe merges only with the one beside it' };

  const early = world.keyframes[Math.min(i, j)], late = world.keyframes[Math.max(i, j)];
  const out = deleted(world, early.id, 'merged');

  if ('refused' in out || into === late.id) return out;

  // Left as the later, shown as the earlier it was dropped on.
  return { ...out, keyframes: out.keyframes.map(f => (f.id === late.id ? { ...f, name: early.name, visible: early.visible } : f)) };
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

  const entry = (e: Key): Key => {
    if (e.skip === undefined) return e;

    const skip = new Set([...e.skip].flatMap(s => shifted(s) ?? []));
    const { skip: _was, ...rest } = e;

    return skip.size === 0 ? rest : { ...rest, skip };
  };

  const entries = <E>(map: ReadonlyMap<KeyframeId, E>, f: (e: E) => E): Map<KeyframeId, E> =>
    new Map([...map].flatMap(([k, e]) => {
      const there = shifted(k);

      return there === null ? [] : [[there, f(e)] as const];
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

  const rig = keyRigOf(world, id);
  const keys = entries(rig.keys, list => list.map(key => entry(lessCorners(key, gone) ?? key)));

  return withKeyRig(out, id, { keys: new Map([...keys].flatMap(([at, list]) => {
    const kept = list.map(key => lessCorners(key, gone)).flatMap(key => (key === null ? [] : [key]));

    return kept.length === 0 ? [] : [[at, kept] as const];
  })) });
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


// -----------------------------------------------------------------------------
// Where the hand is
// -----------------------------------------------------------------------------

/**
 * `s` with the keys the hand is on kept true: every one still there, at the
 * keyframe on screen, and on something picked or inside something picked —
 * the only things whose keys the keyframe view shows. Where the lead goes, the
 * hand is on nothing.
 *
 * The one place this is decided. Run over every change to the store, so that
 * nothing which moves a key, takes one out, steps to another keyframe, undoes
 * or picks something else has to remember to let go. `s` itself where nothing
 * changed.
 */
export function aimed(s: EditorState): EditorState {
  const t = s.target;

  if (t === null) return s;
  if (t.lead.at !== s.keyframe) return { ...s, target: null };

  const w = s.world;
  const sel = s.selection;
  const shown = new Set([...sel.polygons, ...sel.artefacts, ...sel.paths].flatMap(id => within(w, id)));
  const there = (p: Place) => shown.has(p.id) && entryAt(w, p) !== undefined;

  if (!there(t.lead)) return { ...s, target: null };

  const all = t.all.filter(there);

  return all.length === t.all.length ? s : { ...s, target: { lead: t.lead, all } };
}

/** The hand on `places`, led by the first of them, or on nothing where there
 * are none. */
export function aiming(places: readonly Place[]): Target | null {
  return places.length === 0 ? null : { lead: places[0], all: [...places] };
}

/** Each of `ids`' last key at `k`, where it has one. What a break leaves the
 * hand on. */
export function lastKeys(world: World, k: KeyframeId, ids: readonly Id[]): Listed[] {
  return ids.flatMap(id => {
    const list = listOf(world, id, k);
    const last = list[list.length - 1];

    return last === undefined ? [] : [{ id, at: k, key: last.id }];
  });
}

/** The keys each of `ids` has at `k` in `now` that it did not have in `was`.
 * What a split leaves the hand on. */
export function newKeys(was: World, now: World, k: KeyframeId, ids: readonly Id[]): Listed[] {
  return ids.flatMap(id => {
    const before = new Set(listOf(was, id, k).map(key => key.id));

    return listOf(now, id, k).filter(key => !before.has(key.id)).map(key => ({ id, at: k, key: key.id }));
  });
}
