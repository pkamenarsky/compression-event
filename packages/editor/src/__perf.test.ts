import { describe, expect, test } from 'vitest';
import { TOP, addPolygon, csg, grouped, resolveAt, sealing, withEdit, editAt } from './scene';
import { bakeSpan } from './bake';
import { EMPTY_TRANSFORM, emptyWorld, World } from './types';

const rect = (x: number, y: number, w: number, h: number) =>
  [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];

/** `rooms` rooms in a row, optionally grouped in pairs, each pair turned at v1. */
function built(rooms: number, group: boolean, inner = false, seal = false): World {
  let w: World = emptyWorld();
  const ids: number[] = [];

  for (let i = 0; i < rooms; i++) {
    const a = addPolygon(w, { type: 'level' }, rect(i * 90, 0, 100, 100), 0, TOP);
    w = a.world;
    ids.push(a.id);
  }

  const turn = (world: World, on: number): World => withEdit(world, 1, on, {
    ...editAt(world, 1, on, 0),
    transform: { ...EMPTY_TRANSFORM, rotation: 0.05 },
  });

  // Ungrouped: every other room turns on its own, which is the same set of
  // moving polygons the grouped runs have.
  if (!group) {
    for (let i = 0; i + 1 < ids.length; i += 2) w = turn(w, ids[i]);

    return w;
  }

  for (let i = 0; i + 1 < ids.length; i += 2) {
    const g = grouped(w, 0, [ids[i], ids[i + 1]], TOP)!;
    w = sealing(g.world, g.id, seal);

    // Either the whole group turns — members riding one frame together — or
    // one member turns inside it, which is the motion a scope cannot carry as
    // a frame and has to follow by subdividing.
    w = turn(w, inner ? ids[i] : g.id);
  }

  return w;
}

const run = <T>(g: Generator<number, T, void>): T => {
  let s = g.next();
  while (!s.done) s = g.next();
  return s.value;
};

describe('what a scope costs', () => {
  for (const [name, group, inner, seal] of [
    ['ungrouped, one turning        ', false, true, false],
    ['loose group,  member turning  ', true, true, false],
    ['sealed group, member turning  ', true, true, true],
    ['sealed group, group turning   ', true, false, true],
  ] as const) {
    test(name, () => {
      const w = built(60, group, inner, seal);

      let t = performance.now();
      for (let i = 0; i < 20; i++) csg(w, 0);
      const set = performance.now() - t;

      t = performance.now();
      const span = run(bakeSpan(w, 0));
      const bake = performance.now() - t;

      console.log(`${name}  csg x20 ${set.toFixed(0)}ms  bake ${bake.toFixed(0)}ms  stretches ${span.tracks.reduce((n, k) => n + k.stretches.length, 0)}`);
      expect(true).toBe(true);
    });
  }
});
