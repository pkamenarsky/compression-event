import { describe, expect, test } from 'vitest';
import { FORMAT, restored, saved } from './save';
import { addPolygon, editAt, withEdit } from './scene';
import { EditorState, emptyWorld, initialState } from './types';

function world(): EditorState {
  const a = addPolygon(emptyWorld(), 'level', [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ], 0);

  const b = addPolygon(a.world, 'solid', [
    { x: 4, y: 4 },
    { x: 8, y: 4 },
    { x: 8, y: 8 },
  ], 1);

  const edit = editAt(b.world, 2, b.id, 0);
  const vertices = new Map(edit.vertices);

  vertices.set(b.world.polygons.get(b.id)!.points[1].id, { x: 1, y: -1 });

  const w = withEdit(b.world, 2, b.id, {
    transform: {
      translation: { x: 3, y: -2 },
      rotation: 0.25,
      scale: { x: 1.5, y: 0.75 },
      erosion: 2,
    },
    vertices,
  });

  return {
    ...initialState(w),
    selection: { polygons: [b.id], vertices: [] },
    tool: 'polygon',
    currentVersion: 2,
  };
}

describe('save', () => {
  test('a state survives the trip through a file', () => {
    const before = world();
    const after = restored(JSON.parse(JSON.stringify(saved(before))));

    expect(after).toEqual(before);
  });

  test('a layer comes back as maps rather than as arrays', () => {
    // Everything a version names, it names by id. Read back as a list, an edit
    // would re-point at whatever now sits at that position.
    const before = world();
    const after = restored(JSON.parse(JSON.stringify(saved(before))));

    const edits = after.world.versions[2].edits;

    expect(edits).toBeInstanceOf(Map);
    expect([...edits.values()][0].vertices).toBeInstanceOf(Map);
    expect([...edits.keys()]).toEqual([...before.world.versions[2].edits.keys()]);
  });

  test('the polygons keep their ids, not their positions in a list', () => {
    const before = world();
    const ids = [...before.world.polygons.keys()];
    const file = saved(before);

    expect(file.world.polygons.map(([id]) => id)).toEqual(ids);
    expect([...restored(file).world.polygons.keys()]).toEqual(ids);
  });

  test('a file from a format this does not read is refused', () => {
    const file = { ...saved(world()), format: FORMAT + 1 };

    expect(() => restored(file)).toThrow(/format/);
  });
});
