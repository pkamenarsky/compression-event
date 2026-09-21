// -----------------------------------------------------------------------------
// Real files, converted
//
// Every world in `scratch/` that the converter takes, taken: read as
// operations, written as keys, and opened. What is checked is that nothing
// refuses, and that everything the file holds stands somewhere real at every
// keyframe with the corners its life says it has.
//
// What the random rigs in `key.test.ts` cannot say: these are worlds somebody
// made by hand, with groups, deaths, and whatever repeats a hand actually
// writes.
// -----------------------------------------------------------------------------

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { NEWEST, OLDEST, Old, converted } from './convert';
import { Saved, restored } from './save';
import { stateAt } from './rig';
import { Id, World, standing } from './types';

const here = new URL('../../../scratch/', import.meta.url);

/** The worlds the converter takes: a 20 through to a 23. Older than that is
 * `convert-19-20.ts`, and this is not its test. */
function worlds(): [string, Old][] {
  return readdirSync(here)
    .filter(name => name.endsWith('.json'))
    .map(name => [name, JSON.parse(readFileSync(new URL(name, here), 'utf8')) as Old] as [string, Old])
    .filter(([, file]) => file.format >= OLDEST && file.format <= NEWEST);
}

/** Every thing with a timeline, and when it begins. */
function things(world: World): Id[] {
  return [...world.rigs.keys()];
}

describe('a world converts and opens', () => {
  const all = worlds();

  test('there are worlds to convert', () => {
    expect(all.length).toBeGreaterThan(0);
  });

  for (const [name, file] of all) {
    test(name, () => {
      const out = converted(file);

      expect(out, name).not.toHaveProperty('refused');

      const world = restored(JSON.parse(JSON.stringify(out)) as Saved).world;

      expect(world.keyframes).toEqual(file.world.keyframes);
      expect([...world.rigs.keys()].sort()).toEqual(file.world.rigs.map(([id]) => id).sort());

      for (const id of things(world)) {
        for (const k of world.keyframes) {
          const state = stateAt(world, id, k.id);

          expect(Number.isFinite(state.frame.t.x), `${name}: thing ${id} at v${k.id}`).toBe(true);
          expect(Number.isFinite(state.frame.angle)).toBe(true);
          expect(state.frame.scale.x).not.toBe(0);

          const polygon = world.polygons.get(id);

          if (polygon === undefined) continue;

          // The corners standing there are the ones whose lives say so. Past
          // the polygon's own death the walk goes on — a death is about what
          // is drawn — so there is nothing to say about it here.
          const upto = new Set(world.keyframes.slice(0, world.keyframes.findIndex(f => f.id === k.id) + 1).map(f => f.id));

          if (!standing(polygon, upto)) continue;

          expect([...state.corners.keys()].sort(), `${name}: thing ${id} at v${k.id}`)
            .toEqual(polygon.points.filter(c => standing(c, upto)).map(c => c.id).sort());
        }
      }
    });
  }
});
