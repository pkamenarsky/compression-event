import { describe, expect, test } from 'vitest';
import { addPath } from './paths';
import { FORMAT, restored, saved } from './save';
import {
  TOP,
  addArtefact,
  addPolygon,
  grouped,
  handed,
  keyed,
  placeAt,
  removeAt,
  resolveAt,
  rigOf,
  withRig,
} from './scene';
import { deepened, nudged, once, repeating } from './rig';
import { EditorState, FLOOR, emptyWorld, initialState, PolygonKind } from './types';
import { erode, move, scaled, spun, wrote } from './testing';

/**
 * A polygon kind by the short name these tests call it: a room, a pillar, a
 * floor, and a hole cut in a floor.
 *
 * Three of them are the kind's own name. `hole` is a void over the floors,
 * which is what a hole in one is. See `PolygonKind`.
 */
type Named = 'level' | 'solid' | 'floor' | 'hole';

const kind = (k: Named): PolygonKind =>
  k === 'hole' ? { type: 'void', from: FLOOR } : { type: k };

/** A world with something of every kind written about it: moves, a turn, a
 * stretch, depths, a repeat with a skip in it, a nudge and a corner depth. */
function world(): EditorState {
  const a = addPolygon(emptyWorld(), kind('level'), [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ], 0, TOP);

  const b = addPolygon(a.world, kind('solid'), [
    { x: 4, y: 4 },
    { x: 8, y: 4 },
    { x: 8, y: 8 },
  ], 1, TOP);

  const corners = b.world.polygons.get(b.id)!.points;

  let w = wrote(b.world, 2, b.id, move(3, -2), spun(0.25), scaled(1.5, 0.75), erode(2));

  w = keyed(w, 3, a.id, [repeating({ kind: 'erode', by: 1 }, null, new Set([5]))]);
  w = withRig(w, b.id, nudged(rigOf(w, b.id), corners[1].id, 2, { x: 1, y: -1 }));
  w = withRig(w, b.id, deepened(rigOf(w, b.id), corners[2].id, 2, -3));

  return {
    ...initialState(w),
    selection: { polygons: [b.id], vertices: [], artefacts: [], paths: [], start: false },
    tool: 'polygon',
    keyframe: 2,
  };
}

/** The state written out and read back in, through text. */
function trip(state: EditorState): EditorState {
  return restored(JSON.parse(JSON.stringify(saved(state))));
}

describe('save', () => {
  test('a state survives the trip through a file', () => {
    const before = world();

    expect(trip(before)).toEqual(before);
  });

  test('and so does everything it resolves to, at every keyframe', () => {
    const before = world();
    const after = trip(before);

    for (const k of before.world.keyframes) {
      expect(resolveAt(after.world, k.id).map(it => it.source))
        .toEqual(resolveAt(before.world, k.id).map(it => it.source));
      expect(resolveAt(after.world, k.id).map(it => it.depths))
        .toEqual(resolveAt(before.world, k.id).map(it => it.depths));
    }
  });

  test('a timeline comes back as maps and sets rather than as arrays', () => {
    // Everything a timeline names, it names by id. Read back as a list, an
    // entry would re-point at whatever now sits at that position.
    const after = trip(world());
    const rig = [...after.world.rigs.values()][0];

    expect(after.world.rigs).toBeInstanceOf(Map);
    expect(rig.keys).toBeInstanceOf(Map);

    const repeat = [...after.world.rigs.values()].flatMap(r => [...r.keys.values()].flat())
      .find(e => e.times === null)!;

    expect(repeat.skip).toBeInstanceOf(Set);
    expect([...repeat.skip]).toEqual([5]);
  });

  test('a stand comes back with its maps', () => {
    const before = world();
    const id = [...before.world.polygons.keys()][0];
    const stood = keyed(before.world, 4, id, [once(handed(before.world, 4, id))]);
    const after = trip({ ...before, world: stood });

    const [entry] = rigOf(after.world, id).keys.get(4)!;

    expect(entry.op.kind).toBe('stand');
    expect(entry.op.kind === 'stand' && entry.op.corners).toBeInstanceOf(Map);
    expect(after.world).toEqual(stood);
  });

  test('an empty skip is not written', () => {
    const file = saved(world());
    const entries = file.world.rigs.flatMap(([, rig]) => rig.keys.flatMap(([, list]) => list));

    expect(entries.filter(e => e.skip !== undefined)).toHaveLength(1);
  });

  test('the polygons keep their ids, not their positions in a list', () => {
    const before = world();
    const ids = [...before.world.polygons.keys()];
    const file = saved(before);

    expect(file.world.polygons.map(([id]) => id)).toEqual(ids);
    expect([...restored(file).world.polygons.keys()]).toEqual(ids);
  });

  test('a file from a format this does not read is refused', () => {
    expect(() => restored({ ...saved(world()), format: FORMAT + 1 })).toThrow(/format/);
  });

  test('and so is one from before timelines, rather than being half-read', () => {
    // A layer cannot be read as operations without inventing where every one
    // of them was aimed. See `FORMAT`.
    expect(() => restored({ ...saved(world()), format: FORMAT - 1 })).toThrow(/format/);
  });

  test('groups survive the trip', () => {
    const before = world();
    const ids = [...before.world.polygons.keys()];
    const made = grouped(before.world, 0, ids, TOP)!;
    const after = trip({ ...before, world: made.world });

    expect(after.world.groups).toBeInstanceOf(Map);
    expect(after.world.groups.get(made.id)).toEqual(made.world.groups.get(made.id));
  });

  test('measuring paths survive the trip', () => {
    const before = world();
    const drawn = addPath(before.world, [{ x: 0, y: 0 }, { x: 100, y: 0 }], before.keyframe, TOP);
    const after = trip({ ...before, world: drawn.world });

    expect([...after.world.paths.values()]).toEqual([
      { birth: before.keyframe, death: null, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
    ]);
  });

  test('artefacts survive the trip, places and all', () => {
    const before = world();
    const one = addArtefact(before.world, 'key', { x: 5, y: 6 }, 0, TOP);
    const moved = wrote(one.world, 2, one.id, move(45, 54));

    const after = trip({
      ...before,
      world: moved,
      selection: { ...before.selection, artefacts: [one.id] },
    });

    const back = after.world.artefacts.get(one.id)!;

    expect(back).toEqual({ type: 'key', birth: 0, death: null, at: { x: 5, y: 6 } });
    expect(placeAt(after.world, one.id, 2)).toEqual({ x: 50, y: 60 });
    expect(after.selection.artefacts).toEqual([one.id]);
  });

  test('the start survives the trip', () => {
    const before = world();
    const placed: EditorState = {
      ...before,
      world: { ...before.world, start: { at: { x: 7, y: -3 }, facing: Math.PI / 2 } },
    };

    expect(trip(placed).world.start).toEqual({ at: { x: 7, y: -3 }, facing: Math.PI / 2 });
  });

  test('every kind of polygon survives the trip', () => {
    let w = emptyWorld();

    for (const k of ['level', 'solid', 'floor', 'hole'] as const) {
      w = addPolygon(w, kind(k), [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], 0, TOP).world;
    }

    expect(trip({ ...world(), world: w }).world.polygons).toEqual(w.polygons);
  });

  test('what a keyframe took out comes back saying so', () => {
    const before = world();
    const ids = [...before.world.polygons.keys()];
    const gone = removeAt(before.world, 2, [ids[0]]);

    const after = trip({ ...before, world: gone });

    expect(after.world.polygons.get(ids[0])!.death).toEqual(2);
    expect(resolveAt(after.world, 1).map(r => r.id)).toContain(ids[0]);
    expect(resolveAt(after.world, 2).map(r => r.id)).not.toContain(ids[0]);
  });

  test('deleting a group writes it onto what it holds, and the group is kept', () => {
    const before = world();
    const ids = [...before.world.polygons.keys()];
    const put = addArtefact(before.world, 'key', { x: 1, y: 2 }, 0, TOP);
    const made = grouped(put.world, 0, [ids[0], put.id], TOP)!;
    const gone = removeAt(made.world, 3, [made.id]);

    const after = trip({ ...before, world: gone });

    expect(after.world.groups.get(made.id)).toEqual(made.world.groups.get(made.id));
    expect(after.world.artefacts.get(put.id)!.death).toEqual(3);
    expect(after.world.polygons.get(ids[0])!.death).toEqual(3);
  });

  test('the keyframes come back as they were, eyes and all', () => {
    const before = world();
    const keyframes = before.world.keyframes.map((k, i) => ({ ...k, visible: i % 2 === 0 }));
    const after = trip({ ...before, world: { ...before.world, keyframes } });

    expect(after.world.keyframes).toEqual(keyframes);
  });
});
