import { decoded, encoded, packed, unpacked } from '@ce/game';
import { describe, expect, test } from 'vitest';
import { bakeAll } from './bake';
import { bakedLevel } from './export';
import { Saved, reopened, written } from './save';
import { EditorState, initialState } from './types';
import { level as rooms, version } from '../../../bench/level';

/** A level of the kind the bench measures, with something happening in each
 * of its first few keyframes, baked. */
function bakedState(): EditorState {
  const built = rooms(12);
  let world = built.world;

  for (const v of [1, 2, 3]) world = version(world, built.ids, 0.5, v);

  const state = initialState(world);
  const job = bakeAll(state.world);

  let step = job.next();
  while (!step.done) step = job.next();

  return { ...state, bake: { ...state.bake, spans: step.value } };
}

describe('the bake in a file', () => {
  const state = bakedState();
  const level = bakedLevel(state.bake, state.world);

  test('there is something to pack', () => {
    expect(level.spans.length).toBe(state.world.keyframes.length - 1);
  });

  test('bytes come back as they went', () => {
    expect(decoded(encoded(level))).toEqual(level);
  });

  test('and so does the string', async () => {
    const s = await packed(level);

    expect(await unpacked(s)).toEqual(level);

    // Against the obvious spelling of the same thing, to say what it earns.
    const plain = JSON.stringify(level, (_key, v) => ArrayBuffer.isView(v) ? [...(v as Float32Array)] : v);

    console.log(`bake: ${plain.length} as JSON, ${encoded(level).length} as bytes, ${s.length} packed`);
    expect(s.length).toBeLessThan(plain.length / 4);
  });

  test('a written file opens with its bake standing', async () => {
    const file = JSON.parse(JSON.stringify(await written(state))) as Saved;

    expect(file.baked).toBeDefined();

    const back = await reopened(file);

    expect(bakedLevel(back.bake, back.world)).toEqual(level);
  });

  test('and an edit throws it away', async () => {
    const back = await reopened(JSON.parse(JSON.stringify(await written(state))) as Saved);
    const edited = { ...back.world, polygons: new Map(back.world.polygons) };

    expect(bakedLevel(back.bake, edited).spans).toEqual([]);
  });
});
