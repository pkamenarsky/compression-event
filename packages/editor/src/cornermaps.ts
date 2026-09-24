// -----------------------------------------------------------------------------
// The maps a rig keeps by corner
//
// The names of the maps — one, since a corner's own amounts went — what kind
// of operation each holds, and the two ways of going over them. Small, and its
// own file for one reason: both `rig.ts` and `types.ts` have to name them, and
// if either owned the list the other would read it. `rig.ts` already reads `types.ts` for `enclosing`, so
// owning it there put a runtime cycle through the two of them — the kind the
// rule in CLAUDE.md is about, and the kind a bundler turns into chunks that
// load in the wrong order.
//
// Nothing here is read at load: every import below is a type, so this file is
// a leaf at runtime and can be read by anything.
// -----------------------------------------------------------------------------

import type { Entry, Rig } from './rig';
import type { KeyframeId, VertexId } from './types';

/** The maps a rig keeps by corner, by name: the one place that lists them. */
export const CORNER_MAPS = ['nudges'] as const;

export type CornerMap = typeof CORNER_MAPS[number];

/** The kind of operation each corner map holds. */
export const CORNER_KINDS = { nudges: 'move' } as const;

export type CornerKind = typeof CORNER_KINDS[CornerMap];

/** The corner map holding entries of one kind. */
export function cornerMapOf(kind: CornerKind): CornerMap {
  return CORNER_MAPS.find(m => CORNER_KINDS[m] === kind)!;
}

/** Every corner map of a rig through `f`, keys left as they are. */
export function eachCornerMap(
  rig: Rig,
  f: <E extends Entry>(m: ReadonlyMap<VertexId, ReadonlyMap<KeyframeId, E>>) => ReadonlyMap<VertexId, ReadonlyMap<KeyframeId, E>>,
): Rig {
  return { ...rig, nudges: f(rig.nudges) };
}
