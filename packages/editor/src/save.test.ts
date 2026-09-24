import { describe, expect, test } from 'vitest';
import { addPath } from './paths';
import { FORMAT, SavedKeyRig, restored, restoredKeyRig, saved, savedKeyRig } from './save';
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
import {
  EMPTY_RIG,
  Keyframe,
  Op,
  Rig,
  Timeline,
  cornerRounded,
  deepened,
  edgeDeformed,
  nudged,
  once,
  repeating,
  stateAt,
  withKeys,
} from './rig';
import { NOTHING, entriesOf, keysOf, walkedBy } from './rig';
import { EditorState, Id, emptyWorld, gestured, initialState, PolygonKind, Vertex } from './types';
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
  k === 'hole' ? { floor: 'void' } : k === 'floor' ? { floor: 'floor' } : { level: k === 'level' ? 'hollow' : k };

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

    expect(repeat.by?.erode).toBe(1);
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
        [b, { round: { precision: 0.3, tension: 0.8, chamfer: false }, deform: { spacing: 12, pattern: 'noise', seed: 7, sides: 'in', jitter: 0, off: true } }],
        [a, { erode: { off: true } }],
      ]),
      cornerEffects: new Map([[corners[1].id, { deform: { spacing: 9, pattern: 'zigzag' as const, seed: 3, sides: 'both' as const, jitter: 0.2, off: true } }]]),
    };
    w = keyed(w, 4, b, [once(handed(w, 4, b))]);

    const stood = rigOf(w, b).keys.get(4)![0].op;

    expect(stood.kind === 'stand' && stood.bevel).toBe(4);
    expect(stood.kind === 'stand' && stood.bevels.get(corners[0].id)).toBe(3);

    const after = trip({ ...before, world: w });

    expect(after.world).toEqual(w);
  });

  test('the polygons keep their ids, not their positions in a list', () => {
    const before = world();
    const ids = [...before.world.polygons.keys()];
    const file = saved(before);

    expect(file.world.polygons.map(([id]) => id)).toEqual(ids);
    expect([...restored(file).world.polygons.keys()]).toEqual(ids);
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

// -----------------------------------------------------------------------------
// Keys
//
// What a 24 keeps: a rig of keys survives the trip whole, and a timeline read
// back out of a file plays what it played.
// -----------------------------------------------------------------------------

describe('keys in a file', () => {
  const KEYFRAMES: Keyframe[] = Array.from({ length: 6 }, (_unused, i) => ({ id: i, name: `v${i}`, visible: true }));

  const CORNERS: Vertex[] = [
    { id: 10, at: { x: 0, y: 0 }, ring: 0, birth: 0, death: null },
    { id: 11, at: { x: 20, y: 0 }, ring: 0, birth: 0, death: null },
    { id: 12, at: { x: 20, y: 20 }, ring: 0, birth: 1, death: 4 },
  ];

  /** A rig of entries with something of every kind in it, including a stand
   * and a corner's own writing. */
  function entries(): Rig {
    let rig = withKeys(EMPTY_RIG, 0, [
      once(move(10, 5)),
      repeating<Op>({ kind: 'turn', angle: 0.4, ref: { x: 3, y: 1 }, about: { x: 20, y: 0 } }, 3),
    ]);

    rig = withKeys(rig, 1, [
      repeating<Op>({ kind: 'scale', by: { x: 1.3, y: 0.7 }, ref: { x: 3, y: 1 }, shift: { x: 2, y: -1 }, along: 0.2, lean: 0.1 }, null, new Set([3])),
      once(erode(2)),
    ]);

    rig = withKeys(rig, 2, [
      once<Op>({
        kind: 'stand',
        frame: { t: { x: 5, y: 6 }, angle: 0.3, skew: 0.1, scale: { x: 1.2, y: 0.9 } },
        erosion: 1,
        corners: new Map([[10, { x: 1, y: 1 }]]),
        depths: new Map([[10, 0.5]]),
        bevel: 0.25,
        amplitude: 0.75,
        bevels: new Map([[10, 0.1]]),
        amplitudes: new Map([[10, 0.2]]),
      }),
    ]);

    rig = nudged(rig, 11, 1, { x: 4, y: -2 });
    rig = deepened(rig, 11, 3, 1.5);
    rig = cornerRounded(rig, 12, 2, 0.5);
    rig = edgeDeformed(rig, 12, 2, 0.25);

    return rig;
  }

  test('a rig of keys survives the trip whole', () => {
    const was = keysOf(entries());
    const now = restoredKeyRig(JSON.parse(JSON.stringify(savedKeyRig(was))) as ReturnType<typeof savedKeyRig>);

    expect([...now.keys.keys()]).toEqual([...was.keys.keys()]);

    for (const [at, list] of was.keys) {
      const mine = now.keys.get(at)!;

      expect(mine.length, `v${at}: how many keys`).toBe(list.length);

      for (let i = 0; i < list.length; i++) {
        expect(mine[i], `v${at}: key ${i}`).toEqual(list[i]);
      }
    }
  });

  test('its sets and maps come back as sets and maps', () => {
    const now = restoredKeyRig(savedKeyRig(keysOf(entries())));
    const all = [...now.keys.values()].flat();

    expect(all.some(k => k.skip instanceof Set)).toBe(true);
    expect(all.some(k => k.corners instanceof Map)).toBe(true);
    expect(all.some(k => k.stand?.corners instanceof Map)).toBe(true);
  });

  test('a delta saved without a field reads as one that does not do it', () => {
    const key = restoredKeyRig({ keys: [[0, [{ id: 0, ref: { x: 0, y: 0 }, by: { erode: 3 }, times: 1 }]]] })
      .keys.get(0)![0];

    expect(key.by).toEqual({ ...NOTHING, erode: 3 });
  });

  test('a timeline read back out of a file plays what it played', () => {
    const rig = entries();
    const tl: Timeline = {
      keyframes: KEYFRAMES,
      rigs: new Map([[1, keysOf(rig)]]),
      polygons: new Map([[1, { birth: 0, points: CORNERS }]]),
      groups: new Map(),
      artefacts: new Map(),
      paths: new Map(),
    };

    // Through a file, as opening one goes.
    const file = JSON.parse(JSON.stringify(savedKeyRig(keysOf(rig)))) as SavedKeyRig;
    const mine = walkedBy(KEYFRAMES, restoredKeyRig(file), CORNERS, 0).states;

    for (let i = 0; i < KEYFRAMES.length; i++) {
      const theirs = stateAt(tl, 1, KEYFRAMES[i].id);
      const ours = mine[i]!;

      expect(ours.frame.t.x, `v${i}: t.x`).toBeCloseTo(theirs.frame.t.x, 9);
      expect(ours.frame.t.y, `v${i}: t.y`).toBeCloseTo(theirs.frame.t.y, 9);
      expect(ours.frame.angle, `v${i}: angle`).toBeCloseTo(theirs.frame.angle, 12);
      expect(ours.frame.skew, `v${i}: skew`).toBeCloseTo(theirs.frame.skew, 12);
      expect(ours.frame.scale.x, `v${i}: scale.x`).toBeCloseTo(theirs.frame.scale.x, 12);
      expect(ours.frame.scale.y, `v${i}: scale.y`).toBeCloseTo(theirs.frame.scale.y, 12);
      expect(ours.erosion, `v${i}: erosion`).toBeCloseTo(theirs.erosion, 9);
      expect(ours.bevel, `v${i}: bevel`).toBeCloseTo(theirs.bevel, 9);
      expect(ours.amplitude, `v${i}: amplitude`).toBeCloseTo(theirs.amplitude, 9);
      expect([...ours.corners.keys()].sort(), `v${i}: which corners`).toEqual([...theirs.corners.keys()].sort());

      for (const [id, p] of theirs.corners) {
        expect(ours.corners.get(id)!.x, `v${i}: corner ${id} x`).toBeCloseTo(p.x, 9);
        expect(ours.corners.get(id)!.y, `v${i}: corner ${id} y`).toBeCloseTo(p.y, 9);
      }

      for (const [id, d] of theirs.depths) expect(ours.depths.get(id), `v${i}: depth ${id}`).toBeCloseTo(d, 9);
      for (const [id, d] of theirs.bevels) expect(ours.bevels.get(id), `v${i}: bevel ${id}`).toBeCloseTo(d, 9);
      for (const [id, d] of theirs.amplitudes) expect(ours.amplitudes.get(id), `v${i}: amplitude ${id}`).toBeCloseTo(d, 9);
    }
  });
});
