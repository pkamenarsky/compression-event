// -----------------------------------------------------------------------------
// Real files, read as keys
//
// Every world in `scratch/` that this can open, restored twice: once as
// entries, the way the editor reads it today, and once through `keysOfSaved`.
// Every thing in it has to stand in the same place at every keyframe, with the
// same amounts and the same corners.
//
// What the random rigs in `key.test.ts` cannot say: these are worlds somebody
// made by hand, with groups, deaths, and whatever repeats a hand actually
// writes.
// -----------------------------------------------------------------------------

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { Saved, restored } from './save';
import { Keyframe, State, stateAt } from './rig';
import { walkedBy } from './rig';
import { Id, Vertex, World } from './types';

const here = new URL('../../../scratch/', import.meta.url);

/** The worlds this reads: a file the current format can open, and nothing
 * older — the converter (`pnpm convert`) is what takes those. */
function worlds(): [string, Saved][] {
  return readdirSync(here)
    .filter(name => name.endsWith('.json'))
    .map(name => [name, JSON.parse(readFileSync(new URL(name, here), 'utf8')) as Saved] as [string, Saved])
    .filter(([, file]) => file.format >= 20);
}

/** Every thing with a timeline, and the corners it has ever had. */
function things(world: World): [Id, readonly Vertex[]][] {
  return [...world.rigs.keys()].map(id => [id, world.polygons.get(id)?.points ?? []]);
}

/** When a thing begins: a group's is the first keyframe, having none of its
 * own. */
function birthOf(world: World, id: Id): number | null {
  const first = world.keyframes[0];

  if (world.groups.has(id)) return first === undefined ? null : first.id;

  const it = world.polygons.get(id) ?? world.artefacts.get(id) ?? world.paths.get(id);

  return it?.birth ?? null;
}

function same(mine: State, theirs: State, what: string): void {
  expect(mine.frame.t.x, `${what}: t.x`).toBeCloseTo(theirs.frame.t.x, 6);
  expect(mine.frame.t.y, `${what}: t.y`).toBeCloseTo(theirs.frame.t.y, 6);
  expect(mine.frame.angle, `${what}: angle`).toBeCloseTo(theirs.frame.angle, 9);
  expect(mine.frame.skew, `${what}: skew`).toBeCloseTo(theirs.frame.skew, 9);
  expect(mine.frame.scale.x, `${what}: scale.x`).toBeCloseTo(theirs.frame.scale.x, 9);
  expect(mine.frame.scale.y, `${what}: scale.y`).toBeCloseTo(theirs.frame.scale.y, 9);
  expect(mine.erosion, `${what}: erosion`).toBeCloseTo(theirs.erosion, 6);
  expect(mine.bevel, `${what}: bevel`).toBeCloseTo(theirs.bevel, 6);
  expect(mine.amplitude, `${what}: amplitude`).toBeCloseTo(theirs.amplitude, 6);

  expect([...mine.corners.keys()].sort(), `${what}: which corners`).toEqual([...theirs.corners.keys()].sort());

  for (const [id, p] of theirs.corners) {
    expect(mine.corners.get(id)!.x, `${what}: corner ${id} x`).toBeCloseTo(p.x, 6);
    expect(mine.corners.get(id)!.y, `${what}: corner ${id} y`).toBeCloseTo(p.y, 6);
  }

  for (const held of ['depths', 'bevels', 'amplitudes'] as const) {
    expect([...mine[held].keys()].sort(), `${what}: which ${held}`).toEqual([...theirs[held].keys()].sort());

    for (const [id, n] of theirs[held]) expect(mine[held].get(id), `${what}: ${held} ${id}`).toBeCloseTo(n, 6);
  }
}

describe('a world read as keys stands where it stood', () => {
  const all = worlds();

  test('there are worlds to read', () => {
    expect(all.length).toBeGreaterThan(0);
  });

  for (const [name, file] of all) {
    test(name, () => {
      const world = restored(file).world;
      const keyframes: readonly Keyframe[] = world.keyframes;
      const tl = { ...world, rigs: world.rigs };

      for (const [id, corners] of things(world)) {
        const birth = birthOf(world, id);

        if (birth === null) continue;

        const rig = world.rigs.get(id)!;

        // What the world holds, which is what reading the file made of it.
        for (const keys of [rig]) {
          const mine = walkedBy(keyframes, keys, corners, birth).states;

          for (let i = 0; i < keyframes.length; i++) {
            const at = keyframes[i].id;
            const theirs = stateAt(tl, id, at);

            if (mine[i] === undefined) continue;

            same(mine[i]!, theirs, `${name}: thing ${id} at v${at}`);
          }
        }
      }
    });
  }
});
