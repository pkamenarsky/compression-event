// -----------------------------------------------------------------------------
// Editing one entry
//
// This is its own file for one reason, and it is not size. `editedAt` reads
// the thing as the entry leaves it, which means asking where it is painted,
// and `painted` asks what it is drawn as — `outlining`, over in `reading.ts`.
// Everything else in the core is independent of what the world *looks* like,
// and leaving this here would be the one edge that made the core read the
// reader: a cycle, and with it the chunk-order hazard the rule in CLAUDE.md
// is about. `outlining` cannot come the other way — it transitively needs
// about 1400 of `reading.ts`'s 1800 lines.
//
// So the hundred lines that want both sides sit on this side of the cut,
// where they may read either.
// -----------------------------------------------------------------------------

import { Point } from '@ce/game/world';
import { GroupId, Id, KeyframeId, World, standing } from '../types';
import { place } from '../affine';
import {
  Frame,
  Key as RigKey,
  Op,
  REST,
  deltaOf,
  foldedBy,
  keysAt,
  kindOf,
  placed,
  playingAt,
  playingOn,
  stateAt,
  withKeysAt,
} from '../rig';

import {
  Painted,
  keyRigOf,
  order,
  under,
  withKeyRig,
} from './core';
import {
  painted,
} from './reading';

// The gesture its kind is written by, read against the thing as that entry
// leaves it and about the entry's own anchor, so that what the hand does is
// the same kind of operation about the same centre — and folds into the entry
// exactly, the way a hand repeating itself does. See `merged` in `rig.ts`.
// -----------------------------------------------------------------------------

/** Where a thing is at keyframe `k` just before `entry` plays there, and just
 * after. Nothing where it is not one of `k`'s. */
export function around(world: World, k: KeyframeId, id: Id, key: RigKey): { before: Frame, after: Frame } | null {
  const i = order(world, k);
  let frame = i > 0 ? stateAt(world, id, world.keyframes[i - 1].id).frame : REST;

  for (const p of playingAt(world, id, k)) {
    if (p.key === key && p.step === 0) return { before: frame, after: playingOn(frame, p) };

    frame = playingOn(frame, p);
  }

  return null;
}

/**
 * What an edit of `key` is read against: the thing painted as the key leaves
 * it, at the key's own painted point, and the centre it acts about in world
 * units — the middle of the thing as it stands then, which is where the hand
 * sees it, and not wherever the key itself once turned or scaled about.
 */
export function editedAt(world: World, k: KeyframeId, id: Id, key: RigKey): { paint: Painted, pivot: Point } | null {
  const frames = around(world, k, id, key);

  if (frames === null || key.by === undefined) return null;

  const kind = kindOf(key);
  const held = under(world, k, id);
  const middle = painted(world, k, id).ref;
  const ref = kind === 'turn' || kind === 'scale' ? key.ref : middle;
  const paint = { ref, at: placed(frames.after, ref), frame: frames.after, held };

  return { paint, pivot: place(held, [placed(frames.after, middle)])[0] };
}

/**
 * The key at `index` of `k`'s list with `op` folded into it: what it did, and
 * then `op`, as one key repeating as it did. Taken out where the two come to
 * nothing, and left alone where they are not one — which an edit read by
 * `editedAt` never is.
 */
export function refolded(world: World, k: KeyframeId, id: Id, index: number, op: Op): World {
  const rig = keyRigOf(world, id);
  const list = keysAt(rig, k);
  const key = list[index];
  const by = deltaOf(op);

  if (key === undefined || by === null || key.by === undefined) return world;

  // Along the axes the key was written along, which only its repeats read.
  const also = kindOf(key) === 'scale' && by.scale !== undefined
    ? { ...by, along: key.by.along, lean: key.by.lean }
    : by;
  // Its own repeat is the key's, not the fold's: what is being asked is what
  // the two operations come to.
  const both = foldedBy({ ...key, times: 1, skip: undefined }, key.ref, also);

  if (both === null) return world;

  const kept = { times: key.times, ...(key.skip === undefined ? {} : { skip: key.skip }) };
  const now = both === 'gone'
    ? list.filter((_x, i) => i !== index)
    : list.map((x, i) => (i === index ? { ...both, ...kept } : x));

  return withKeyRig(world, id, withKeysAt(rig, k, now));
}

/**
 * Seal a group, or let it loose again.
 *
 * The gesture behind the two kinds of group. Not a layer and not versioned:
 * which of the two a group is, it is over the whole chain, because a group
 * that were one thing at v0 and another at v4 would change what the boundary
 * is *made of* half way along — the same reason a group's standing is settled
 * for a whole span rather than asked at each instant.
 *
 * Eroding a loose group does not do this. A depth is an offset of a union and
 * a loose group has none, so the gesture is refused rather than granted by
 * quietly turning the group into something else — see `erodible`.
 */
export function sealing(world: World, id: GroupId, sealed: boolean): World {
  const group = world.groups.get(id);

  if (group === undefined || group.sealed === sealed) return world;

  const groups = new Map(world.groups);

  groups.set(id, { ...group, sealed });

  return { ...world, groups };
}

