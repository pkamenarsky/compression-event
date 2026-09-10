import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decoded, encoded, packed, unpacked } from '@ce/game';
import { describe, expect, test } from 'vitest';
import { bakeAll } from './bake';
import { bakedLevel } from './export';
import { Saved, restored, reopened, written } from './save';
import { EditorState } from './types';

/** A level off the scratch pile, baked. */
function bakedState(): EditorState {
  const file = JSON.parse(readFileSync(resolve(__dirname, '../../../scratch/world-2026-09-10T08-11-42Z.json'), 'utf8')) as Saved;
  const state = restored(file);
  const job = bakeAll(state.world);

  let step = job.next();
  while (!step.done) step = job.next();

  return { ...state, bake: { ...state.bake, spans: step.value } };
}

describe('the bake in a file', () => {
  const state = bakedState();
  const level = bakedLevel(state.bake, state.world);

  test('there is something to pack', () => {
    expect(level.spans.length).toBe(state.world.versions.length - 1);
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
