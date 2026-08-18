import { describe, expect, test } from 'vitest';
import { FORMAT, restored, saved } from './save';
import { EMPTY_TRANSFORM, EditorState, initialState } from './types';

function world(): EditorState {
  const s = initialState({
    sourcePolygons: new Map([
      [0, {
        type: 'level' as const,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
        transform: EMPTY_TRANSFORM,
      }],
      [7, {
        type: 'solid' as const,
        points: [{ x: 4, y: 4 }, { x: 8, y: 4 }, { x: 8, y: 8 }],
        transform: { translation: { x: 3, y: -2 }, scale: 1.5, rotation: 0.25, erosion: 2 },
      }],
    ]),
    nextId: 8,
    versions: [{ children: [0, 7] }],
  });

  return { ...s, selection: [7], tool: 'polygon', currentVersion: 0 };
}

describe('save', () => {
  test('a state survives the trip through a file', () => {
    const before = world();
    const after = restored(JSON.parse(JSON.stringify(saved(before))));

    expect(after).toEqual(before);
  });

  test('the polygons keep their ids, not their positions in a list', () => {
    // 0 and 7, with nothing at 1..6: reading them back as an array would
    // silently renumber every edit that names one.
    const file = saved(world());

    expect(file.world.polygons.map(([id]) => id)).toEqual([0, 7]);
    expect([...restored(file).world.sourcePolygons.keys()]).toEqual([0, 7]);
  });

  test('a file from a format this does not read is refused', () => {
    const file = { ...saved(world()), format: FORMAT + 1 };

    expect(() => restored(file)).toThrow(/format/);
  });
});
