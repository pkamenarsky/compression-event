import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { SCENES, digest } from './baseline';

// What master made of each world, which a world without effects has to come
// out as exactly. See `baseline.ts`.
const file = new URL('./baseline.golden.json', import.meta.url);

describe('worlds without effects come out as master made them', () => {
  // Writes the golden file instead, which is only ever done on master.
  if (process.env.GOLDEN) {
    test('golden', () => {
      writeFileSync(file, JSON.stringify(Object.fromEntries(SCENES.map(([name, make]) => [name, digest(make())])), null, 2) + '\n');
    });

    return;
  }

  const golden: Record<string, Record<string, string>> = JSON.parse(readFileSync(file, 'utf8'));

  for (const [name, make] of SCENES) {
    test(name, () => {
      expect(digest(make())).toEqual(golden[name]);
    });
  }
});
