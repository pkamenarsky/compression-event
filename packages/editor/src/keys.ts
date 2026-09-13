// -----------------------------------------------------------------------------
// Moving operations, and the keyframes they are written at
//
// An entry is taken out, moved to the keyframe beside it, cut in two or told
// how often to repeat — each whole, nothing recomputed about the ones around
// it. Where a thing ends up afterwards is the list played again.
//
// Keyframes come and go the same way. Inserting one cuts in two what the next
// keyframe does and gives it the first half; deleting one hands what it does,
// and what is born and dies there, to the next. A repeat's span counts steps,
// so a keyframe inserted inside one adds a step to it and a keyframe deleted
// from inside one takes a step away: it ends where it ended.
// -----------------------------------------------------------------------------

import {
  Entry,
  Erode,
  Keyframe,
  KeyframeId,
  Move,
  Op,
  Rig,
  indexIn,
  near,
  once,
  sheared,
  slid,
  spun,
  unsheared,
  withKeys,
} from './rig';
import { rigOf, withRig, without } from './scene';
import { Id, Vertex, VertexId, World } from './types';

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

  return withRig(world, id, withKeys(rig, next, [...there.slice(0, head), ...going, ...there.slice(head)]));
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

/**
 * One entry cut in two where it is `fraction` of the way, the halves side by
 * side in its place. Played one after the other they are the entry exactly.
 *
 * A repeating move or erosion splits into two repeats, which add. A repeating
 * turn, scale or skew does not: each half's steps would keep to its own centre
 * with the other half moving it.
 */
export function split(world: World, id: Id, k: KeyframeId, index: number, fraction = 0.5): World | Refused {
  if (!(fraction > 0 && fraction < 1)) return { refused: 'a split falls inside the operation' };

  const list = listOf(world, id, k);
  const e = list[index];

  if (e === undefined) return world;

  if (e.times !== 1 && e.op.kind !== 'move' && e.op.kind !== 'erode') {
    return { refused: 'a repeating turn, scale or skew does not split' };
  }

  const two = parts(e.op, fraction);

  if (two === null) return { refused: `a ${e.op.kind} does not split` };

  const now = [...list.slice(0, index), { ...e, op: two[0] }, { ...e, op: two[1] }, ...list.slice(index + 1)];

  return withRig(world, id, withKeys(rigOf(world, id), k, now));
}

/**
 * An operation as two, the first doing `f` of it and the second the rest,
 * about the same centre: the second turn's `about` is the first's turned by
 * the first, which is where the painted point went, and a scale's slide is
 * shared the way playback shares it. Nothing for a stand.
 */
export function parts(op: Op, f: number): [Op, Op] | null {
  switch (op.kind) {
    case 'move':
      return [
        { kind: 'move', by: { x: op.by.x * f, y: op.by.y * f } },
        { kind: 'move', by: { x: op.by.x * (1 - f), y: op.by.y * (1 - f) } },
      ];

    case 'erode':
      return [{ kind: 'erode', by: op.by * f }, { kind: 'erode', by: op.by * (1 - f) }];

    case 'turn':
      return [
        { ...op, angle: op.angle * f },
        { ...op, angle: op.angle * (1 - f), about: spun(op.about, op.angle * f) },
      ];

    case 'scale': {
      if (op.by.x <= 0 || op.by.y <= 0) return null;

      // `(1 − Dᶠ) / (1 − D)` of the slide along each axis, and the rest after:
      // the first stretches about the gesture's centre, and so does the second,
      // from where the first left the painted point.
      const s = unsheared(op.shift, op.along, op.lean);
      const first = sheared({ x: s.x * slid(op.by.x, f), y: s.y * slid(op.by.y, f) }, op.along, op.lean);

      return [
        { ...op, by: { x: Math.pow(op.by.x, f), y: Math.pow(op.by.y, f) }, shift: first },
        {
          ...op,
          by: { x: Math.pow(op.by.x, 1 - f), y: Math.pow(op.by.y, 1 - f) },
          shift: { x: op.shift.x - first.x, y: op.shift.y - first.y },
        },
      ];
    }

    case 'skew':
      return [
        { ...op, by: op.by * f, shift: { x: op.shift.x * f, y: op.shift.y * f } },
        { ...op, by: op.by * (1 - f), shift: { x: op.shift.x * (1 - f), y: op.shift.y * (1 - f) } },
      ];

    case 'stand':
      return null;
  }
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

/** An entry written at index `i` with one step more or fewer, where it was
 * written before index `at` and its span reaches it. */
function respanned<E extends Entry>(e: E, i: number, at: number, by: 1 | -1): E {
  if (e.times === null || i >= at || i + e.times - 1 < at) return e;

  return { ...e, times: Math.max(1, e.times + by) };
}

/** An entry moved off a deleted keyframe onto the next, ending where it
 * ended. */
function fewer<E extends Entry>(e: E): E {
  return e.times === null || e.times === 1 ? e : { ...e, times: e.times - 1 };
}

function respannedMap<E extends Entry>(
  keyframes: readonly Keyframe[],
  map: ReadonlyMap<KeyframeId, E>,
  at: number,
  by: 1 | -1,
): Map<KeyframeId, E> {
  return new Map([...map].map(([k, e]) => [k, respanned(e, indexIn(keyframes, k), at, by)]));
}

export interface Inserted {
  world: World
  key: KeyframeId
  /** Things whose next keyframe could not be cut in two exactly — it turns
   * and scales about different points, whose halves would not agree in a
   * different order — and which stand still over the new one instead. */
  held: Id[]
}

/**
 * A keyframe put in after `after`.
 *
 * It takes the first half of what the keyframe after it does to each thing,
 * and leaves the second half there, so that keyframe is where it was. Only
 * the entries that happen once are cut: a repeat begun there begins there
 * still, and one already running takes a step at the new keyframe too.
 */
export function inserted(world: World, after: KeyframeId): Inserted | null {
  const keyframes = world.keyframes;
  const j = indexIn(keyframes, after);

  if (j < 0) return null;

  const key = Math.max(...keyframes.map(f => f.id)) + 1;
  const next = keyframes[j + 1]?.id ?? null;
  const rigs = new Map<Id, Rig>();
  const held: Id[] = [];
  const corners = cornersOf(world);

  // Spans that run past `after` reach the new keyframe at `j + 1`.
  for (const [id, rig] of world.rigs) {
    const keys = new Map([...rig.keys].map(([k, list]) => {
      const i = indexIn(keyframes, k);

      return [k, list.map(e => respanned(e, i, j + 1, 1))];
    }));

    const nudges = new Map([...rig.nudges].map(([v, m]) => [v, respannedMap(keyframes, m, j + 1, 1)]));
    const depths = new Map([...rig.depths].map(([v, m]) => [v, respannedMap(keyframes, m, j + 1, 1)]));

    const born = bornAt(world, id);
    const there = next === null ? [] : keys.get(next) ?? [];

    if (next !== null && born >= 0 && born <= j && !there.some(e => e.op.kind === 'stand')) {
      const halves = halved(there);

      if (halves === null) {
        held.push(id);
      }
      else if (halves[0].length > 0) {
        keys.set(key, halves[0]);
        keys.set(next, halves[1]);
      }

      // A corner's own moves commute with everything, so they always cut.
      for (const maps of [nudges, depths] as Map<VertexId, Map<KeyframeId, Entry>>[]) {
        for (const [v, m] of maps) {
          const e = m.get(next);
          const c = corners.get(v);

          if (e === undefined || e.times !== 1 || c === undefined || indexIn(keyframes, c.birth) > j) continue;

          const [a, b] = parts(e.op, 0.5)!;

          m.set(key, { ...e, op: a });
          m.set(next, { ...e, op: b });
        }
      }
    }

    rigs.set(id, { keys, nudges, depths } as Rig);
  }

  const order = numbered([...keyframes.slice(0, j + 1), { id: key, name: '', visible: true }, ...keyframes.slice(j + 1)]);

  return { world: { ...world, keyframes: order, rigs }, key, held };
}

/**
 * A list as its first halves and its second, or nothing where the halves
 * played apart would not be the list: the first halves all go before any of
 * the second, so they have to commute. Moves and erosions commute with
 * anything; turns about one painted point with each other, and scales, and
 * skews, but not with one another.
 */
function halved(list: readonly Entry[]): [Entry[], Entry[]] | null {
  const shaping = list.map(e => e.op).filter(op => op.kind !== 'move' && op.kind !== 'erode');
  const first = shaping[0];

  if (first !== undefined && !shaping.every(op => together(first, op))) return null;

  const a: Entry[] = [], b: Entry[] = [];

  for (const e of list) {
    if (e.times !== 1) {
      b.push(e);
      continue;
    }

    const two = parts(e.op, 0.5);

    if (two === null) return null;

    a.push(once(two[0]));
    b.push(once(two[1]));
  }

  return [a, b];
}

function together(x: Op, y: Op): boolean {
  if (x.kind === 'turn' && y.kind === 'turn') return near(x.ref, y.ref);

  if (x.kind === 'scale' && y.kind === 'scale') {
    return near(x.ref, y.ref) && x.along === y.along && x.lean === y.lean;
  }

  if (x.kind === 'skew' && y.kind === 'skew') return near(x.ref, y.ref) && x.along === y.along;

  return false;
}

function cornersOf(world: World): Map<VertexId, Vertex> {
  const out = new Map<VertexId, Vertex>();

  for (const p of world.polygons.values()) {
    for (const c of p.points) out.set(c.id, c);
  }

  return out;
}

/**
 * Keyframe `k` taken out.
 *
 * What it does to each thing goes to the front of the next keyframe's list,
 * and what is born or dies at it is born or dies at the next — a thing that
 * then lives nowhere goes entirely. The last keyframe's writing goes with it,
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
  const rigs = new Map<Id, Rig>();

  for (const [id, rig] of world.rigs) {
    const keys = new Map<KeyframeId, readonly Entry[]>();

    for (const [at, list] of rig.keys) {
      const i = indexIn(keyframes, at);

      if (at !== k) keys.set(at, list.map(e => respanned(e, i, d, -1)));
    }

    const mine = rig.keys.get(k) ?? [];

    if (next !== null && mine.length > 0) {
      keys.set(next, [...mine.map(e => fewer(e)), ...(keys.get(next) ?? [])]);
    }

    const nudges = cornerMaps<Move, Entry<Move>>(keyframes, rig.nudges, k, next, (a, b) => ({
      kind: 'move' as const,
      by: { x: a.by.x + b.by.x, y: a.by.y + b.by.y },
    }));
    const depths = cornerMaps<Erode, Entry<Erode>>(keyframes, rig.depths, k, next, (a, b) => ({ kind: 'erode' as const, by: a.by + b.by }));

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
    keyframes: numbered(keyframes.filter(f => f.id !== k)),
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
  keyframes: readonly Keyframe[],
  maps: ReadonlyMap<VertexId, ReadonlyMap<KeyframeId, E>>,
  k: KeyframeId,
  next: KeyframeId | null,
  add: (a: O, b: O) => O,
): Map<VertexId, Map<KeyframeId, E>> | null {
  const d = indexIn(keyframes, k);
  const out = new Map<VertexId, Map<KeyframeId, E>>();

  for (const [v, map] of maps) {
    const m = new Map<KeyframeId, E>();

    for (const [at, e] of map) {
      const i = indexIn(keyframes, at);

      if (at !== k) m.set(at, respanned(e, i, d, -1));
    }

    const mine = map.get(k);

    if (next !== null && mine !== undefined) {
      const moved = fewer(mine);
      const there = m.get(next);

      if (there === undefined) m.set(next, moved);
      else if (there.times === moved.times) m.set(next, { ...there, op: add(moved.op, there.op) });
      else return null;
    }

    if (m.size > 0) out.set(v, m);
  }

  return out;
}
