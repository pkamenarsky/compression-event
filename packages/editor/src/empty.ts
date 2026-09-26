// -----------------------------------------------------------------------------
// Empty keys
//
// A leaf, reading nothing but types, so that `types.ts` can keep the rule at
// every edit it records without reading the rig. Two empty keys side by side
// are never wanted: the second says nothing the first does not.
// -----------------------------------------------------------------------------

import type { Key } from './rig';

/** Whether a key does nothing: what ⌘K puts in, before a gesture fills it. */
export function emptyKey(key: Key): boolean {
  const d = key.by;

  return key.stand === undefined && key.times === 1 && (key.corners?.size ?? 0) === 0 && (d === undefined || (
    d.move.x === 0 && d.move.y === 0 && d.angle === 0 && d.skew === 0 && d.scale.x === 1 && d.scale.y === 1
    && d.along === 0 && d.lean === 0 && [...d.amounts.values()].every(v => v === 0)));
}

/** The empty key a new empty key would be put beside at index `at` of `list`,
 * before it or after it, or nothing: the one to pick instead of making it. */
export function emptyBeside(list: readonly Key[], at: number): Key | undefined {
  return [list[at - 1], list[at]].find(key => key !== undefined && emptyKey(key));
}

/** A list with each empty key that follows another taken out, and what each
 * one taken out was folded into: the one before it. */
export function lonely(list: readonly Key[]): { list: readonly Key[], into: Map<number, number> } {
  const into = new Map<number, number>();
  const out: Key[] = [];

  for (const key of list) {
    const prev = out[out.length - 1];

    if (prev !== undefined && emptyKey(prev) && emptyKey(key)) into.set(key.id, prev.id);
    else out.push(key);
  }

  return { list: into.size === 0 ? list : out, into };
}
