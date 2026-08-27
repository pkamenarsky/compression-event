import { describe, expect, test } from 'vitest';
import { addPath } from './paths';
import { FORMAT, restored, saved } from './save';
import { resolveAt } from './scene';
import { TOP, addArtefact, addPolygon, editAt, placeAt, withEdit } from './scene';
import { EMPTY_TRANSFORM, EditorState, emptyWorld, initialState } from './types';

function world(): EditorState {
  const a = addPolygon(emptyWorld(), 'level', [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ], 0, TOP);

  const b = addPolygon(a.world, 'solid', [
    { x: 4, y: 4 },
    { x: 8, y: 4 },
    { x: 8, y: 8 },
  ], 1, TOP);

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
    selection: { polygons: [b.id], vertices: [], artefacts: [] },
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

  test('groups survive the trip, and a format-4 file has none', () => {
    const before = world();
    const ids = [...before.world.polygons.keys()];

    const grouped: EditorState = {
      ...before,
      world: {
        ...before.world,
        groups: new Map([[100, { birth: 0, members: ids }]]),
        nextId: 101,
      },
    };

    const after = restored(JSON.parse(JSON.stringify(saved(grouped))));

    expect(after.world.groups).toBeInstanceOf(Map);
    expect(after.world.groups.get(100)).toEqual({ birth: 0, members: ids });

    // A file written before there were any says nothing about them rather than
    // saying there are none, and both read the same way.
    const file = saved(grouped);
    const old = { ...file, format: 4, world: { ...file.world, groups: undefined } };

    expect(restored(JSON.parse(JSON.stringify(old)) as typeof file).world.groups.size)
      .toEqual(0);
  });

  test('measuring paths survive the trip, and a format-7 file has none', () => {
    const before = world();
    const drawn: EditorState = {
      ...before,
      world: addPath(before.world, [{ x: 0, y: 0 }, { x: 100, y: 0 }]).world,
    };

    const file = saved(drawn);
    const after = restored(JSON.parse(JSON.stringify(file)) as typeof file);

    expect([...after.world.paths.values()]).toEqual([
      { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
    ]);

    // And the tool it was drawing with was called something else then.
    const old = {
      ...file,
      format: 7,
      tool: 'path' as const,
      world: { ...file.world, paths: undefined },
    };

    const back = restored(JSON.parse(JSON.stringify(old)) as typeof file);

    expect(back.world.paths.size).toBe(0);
    expect(back.tool).toBe('create');
  });

  test('artefacts survive the trip, places and all, and a format-5 file has none', () => {
    const before = world();
    const one = addArtefact(before.world, 'key', { x: 5, y: 6 }, 0, TOP);
    const moved = withEdit(one.world, 2, one.id, {
      transform: { ...EMPTY_TRANSFORM, translation: { x: 45, y: 54 } },
      vertices: new Map(),
    });

    const placed: EditorState = {
      ...before,
      world: moved,
      selection: { ...before.selection, artefacts: [one.id] },
    };

    const after = restored(JSON.parse(JSON.stringify(saved(placed))));
    const back = after.world.artefacts.get(one.id)!;

    expect(back.type).toEqual('key');
    expect(back.birth).toEqual(0);
    expect(back.at).toEqual({ x: 5, y: 6 });

    // What it goes on to do is in the versions, where everything else's is.
    expect(after.world.versions[2].edits.get(one.id)!.transform.translation)
      .toEqual({ x: 45, y: 54 });
    expect(after.selection.artefacts).toEqual([one.id]);

    const file = saved(placed);
    const old = {
      ...file,
      format: 5,
      artefacts: undefined,
      world: { ...file.world, artefacts: undefined },
    };

    const opened = restored(JSON.parse(JSON.stringify(old)) as typeof file);

    expect(opened.world.artefacts.size).toEqual(0);
    expect(opened.selection.artefacts).toEqual([]);
  });

  test('a format-6 file says the same places the long way round', () => {
    // There an artefact held a move per version. The first is where it was put
    // and each of the rest is a translation that version was making, which is
    // what a transform's translation is — so it converts exactly rather than
    // being approximated or dropped.
    const before = world();
    const one = addArtefact(before.world, 'exit', { x: 0, y: 0 }, 0, TOP);
    const file = saved({ ...before, world: one.world });

    const old = {
      ...file,
      format: 6,
      world: {
        ...file.world,
        artefacts: [[one.id, {
          type: 'exit',
          birth: 1,
          at: [[1, { x: 10, y: 0 }], [3, { x: 5, y: 5 }]],
        }]],
      },
    };

    const after = restored(JSON.parse(JSON.stringify(old)) as typeof file);
    const back = after.world.artefacts.get(one.id)!;

    expect(back.birth).toEqual(1);
    expect(back.at).toEqual({ x: 10, y: 0 });
    expect(after.world.versions[1].edits.get(one.id)).toBeUndefined();
    expect(after.world.versions[3].edits.get(one.id)!.transform.translation)
      .toEqual({ x: 5, y: 5 });

    // Which is the same sequence of places it was saying before.
    expect(placeAt(after.world, one.id, 0)).toBeNull();
    expect(placeAt(after.world, one.id, 2)).toEqual({ x: 10, y: 0 });
    expect(placeAt(after.world, one.id, 4)).toEqual({ x: 15, y: 5 });
  });

  test('a format-3 file opens, with every corner standing throughout', () => {
    // Before 4 there was no way for a corner to say it came or went, so a file
    // that says nothing is read as one where none of them did.
    const file = saved(world());
    const old = {
      ...file,
      format: 3,
      world: {
        ...file.world,
        polygons: file.world.polygons.map(([id, p]) => [
          id,
          { ...p, points: p.points.map(({ id: v, at }) => ({ id: v, at })) },
        ]),
      },
    };

    const after = restored(JSON.parse(JSON.stringify(old)) as typeof file);

    for (const [id, p] of after.world.polygons) {
      expect(p.points.length).toBeGreaterThan(2);

      for (const c of p.points) {
        expect(c.birth).toEqual(p.birth);
        expect(c.death).toEqual(null);
      }

      // And it resolves to the same ring the format-4 file does.
      expect(resolveAt(after.world, 4).find(r => r.id === id)!.corners.length)
        .toEqual(p.points.length);
    }
  });
});
