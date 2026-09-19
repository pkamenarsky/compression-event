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
import { Op, Rig, cornerRounded, deepened, edgeDeformed, nudged, once, repeating } from './rig';
import { EditorState, FLOOR, emptyWorld, gestured, initialState, PolygonKind } from './types';
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
 * stretch, depths, a repeat with a skip in it, a nudge and a corner depth,
 * each carrying the gesture that wrote it. */
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

  w = keyed(w, 3, a.id, [repeating({ kind: 'erode', by: 1 }, null)]);
  w = withRig(w, b.id, nudged(rigOf(w, b.id), corners[1].id, 2, { x: 1, y: -1 }));
  w = withRig(w, b.id, deepened(rigOf(w, b.id), corners[2].id, 2, -3));
  w = gestured(w, a.world);

  return {
    ...initialState(w),
    selection: {
      polygons: [b.id], vertices: [], edges: [], artefacts: [], paths: [], start: false, eye: false,
    },
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

    expect(repeat.op).toEqual({ kind: 'erode', by: 1 });
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

  test('effects survive the trip: options, a corner\'s own, amounts, and a stand\'s', () => {
    const before = world();
    const [a, b] = [...before.world.polygons.keys()];
    const corners = before.world.polygons.get(b)!.points;
    let w = wrote(before.world, 1, b, { kind: 'round', by: 4 }, { kind: 'deform', by: 2 });

    w = withRig(w, b, cornerRounded(rigOf(w, b), corners[0].id, 2, 3));
    w = withRig(w, b, edgeDeformed(rigOf(w, b), corners[1].id, 2, -1));
    w = {
      ...w,
      effects: new Map([
        [b, { round: { precision: 0.3, tension: 0.8, chamfer: false }, deform: { spacing: 12, pattern: 'noise', seed: 7, sides: 'in', jitter: 0, clear: false, off: true } }],
        [a, { erode: { off: true } }],
      ]),
      cornerEffects: new Map([[corners[0].id, { round: { precision: 0.5, tension: 0.5, chamfer: true, off: true } }]]),
    };
    w = keyed(w, 4, b, [once(handed(w, 4, b))]);

    const stood = rigOf(w, b).keys.get(4)![0].op;

    expect(stood.kind === 'stand' && stood.bevel).toBe(4);
    expect(stood.kind === 'stand' && stood.bevels.get(corners[0].id)).toBe(3);

    const after = trip({ ...before, world: w });

    expect(after.world).toEqual(w);
  });

  test('a 21, which had no effects, reads as one with none', () => {
    const before = world();
    const file = JSON.parse(JSON.stringify(saved(before)));

    file.format = 21;
    delete file.world.effects;
    delete file.world.cornerEffects;

    for (const [, rig] of file.world.rigs) {
      delete rig.rounds;
      delete rig.deforms;
    }

    expect(restored(file).world).toEqual(before.world);
  });

  test('a stand saved when its bevels were radii keeps them', () => {
    const before = world();
    const [id] = [...before.world.polygons.keys()];
    const corner = before.world.polygons.get(id)!.points[0].id;
    let w = wrote(before.world, 1, id, { kind: 'round', by: 4 });

    w = withRig(w, id, cornerRounded(rigOf(w, id), corner, 1, 3));
    w = keyed(w, 2, id, [once(handed(w, 2, id))]);

    const file = JSON.parse(JSON.stringify(saved({ ...before, world: w })));
    let stands = 0;

    for (const [, rig] of file.world.rigs) {
      for (const [, entries] of rig.keys) {
        for (const e of entries) {
          if (e.op.kind !== 'stand') continue;

          stands++;
          e.op.radius = e.op.bevel;
          e.op.radii = e.op.bevels;
          delete e.op.bevel;
          delete e.op.bevels;
        }
      }
    }

    expect(stands).toBeGreaterThan(0);
    expect(restored(file).world).toEqual(w);
  });

  test('effects saved with segments, verticals and no jitter read with a precision, without verticals and with none', () => {
    const before = world();
    const [id] = [...before.world.polygons.keys()];
    const corner = before.world.polygons.get(id)!.points[0].id;
    const file = JSON.parse(JSON.stringify(saved(before)));

    file.world.effects = [[id, { round: { segments: 3, verticals: false }, deform: { spacing: 12, pattern: 'sine', seed: 0, sides: 'out' } }]];
    file.world.cornerEffects = [[corner, { round: { segments: 1, verticals: true, off: true } }]];

    const w = restored(file).world;

    expect(w.effects.get(id)).toEqual({
      round: { precision: 0.5, tension: 0.5, chamfer: false },
      deform: { spacing: 12, pattern: 'sine', seed: 0, sides: 'out', jitter: 0, clear: false },
    });
    expect(w.cornerEffects.get(corner)).toEqual({ round: { precision: 0.5, tension: 0.5, chamfer: true, off: true } });
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
    expect(() => restored({ ...saved(world()), format: 19 })).toThrow(/format/);
  });

  test('a 20, which had no skews, reads as one with every skew nought', () => {
    const before = world();
    const id = [...before.world.polygons.keys()][0];
    const rig: Rig = {
      keys: new Map([[0, [
        once<Op>({ kind: 'scale', by: { x: 2, y: 1 }, ref: { x: 0, y: 0 }, shift: { x: 0, y: 0 }, along: 0.3, lean: 0 }),
        once<Op>({
          kind: 'stand',
          frame: { t: { x: 1, y: 2 }, angle: 0.5, skew: 0, scale: { x: 1, y: 1 } },
          erosion: 0,
          corners: new Map(),
          depths: new Map(),
          bevel: 0,
          amplitude: 0,
          bevels: new Map(),
          amplitudes: new Map(),
        }),
      ]]]),
      nudges: new Map(),
      depths: new Map(),
      rounds: new Map(),
      deforms: new Map(),
    };

    const file = JSON.parse(JSON.stringify(saved({
      ...before,
      world: { ...before.world, rigs: new Map([[id, rig]]) },
    })));

    // As 20 wrote them: no `lean`, and no `skew` in a stand's frame.
    file.format = 20;

    for (const [, keys] of file.world.rigs) {
      for (const [, list] of keys.keys) {
        for (const e of list) {
          delete e.op.lean;
          if (e.op.kind === 'stand') delete e.op.frame.skew;
        }
      }
    }

    expect(restored(file).world.rigs.get(id)).toEqual(rig);
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
