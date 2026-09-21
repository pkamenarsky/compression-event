// -----------------------------------------------------------------------------
// Stepping back
//
// The history is not written by whoever changes the world — a drag writes one
// per pointer move and not one of those is a step — but by whoever finishes
// doing so, handing over the world as it was when they started. These are about
// that arrangement holding: that a gesture is one step however many worlds it
// wrote, that a step which changed nothing is not a step, and that coming back
// to a world does not leave the selection naming things it no longer has.
// -----------------------------------------------------------------------------

import { describe, expect, test } from 'vitest';
import { TOP, addPolygon, deepen, editedAt, keyRigOf, keysOfAt, moveOf, rigOf, withKeyRig, writtenInto } from './scene';
import { aimed, aiming, timed } from './keys';
import { NOTHING, withKeysAt } from './rig';
import { erode, move, turned, wrote } from './testing';
import {
  EMPTY_SELECTION,
  EditorState,
  FLOOR,
  PolygonKind,
  World,
  emptyWorld,
  initialState,
  marked,
  redone,
  undone,
} from './types';

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

function square(world: World, x: number): { world: World, id: number } {
  return addPolygon(
    world,
    kind('level'),
    [{ x, y: 0 }, { x: x + 10, y: 0 }, { x: x + 10, y: 10 }, { x, y: 10 }],
    0,
    TOP,
  );
}

/** One thing done: the world changes, and what it was before is handed over. */
function step(s: EditorState, to: World): EditorState {
  return marked({ ...s, world: to }, s.world);
}

describe('undo', () => {
  test('a step back and a step forward land on the same worlds', () => {
    const a = initialState(emptyWorld());
    const b = step(a, square(a.world, 0).world);
    const c = step(b, square(b.world, 20).world);

    expect(c.world.polygons.size).toEqual(2);
    expect(undone(c).world).toBe(b.world);
    expect(undone(undone(c)).world).toBe(a.world);
    expect(redone(undone(undone(c))).world).toBe(b.world);
    expect(redone(redone(undone(undone(c)))).world).toBe(c.world);
  });

  test('a gesture is one step, however many worlds it wrote on the way', () => {
    // What a drag does: a world per pointer move, and one `marked` at the end
    // naming the world it started from.
    const a = initialState(emptyWorld());
    const started = a.world;

    let s = a;
    for (let i = 0; i < 20; i++) s = { ...s, world: square(started, i).world };

    s = marked(s, started);

    expect(s.history.past.length).toEqual(1);
    expect(undone(s).world).toBe(started);
  });

  test('a gesture that moved nothing is not a step', () => {
    const a = initialState(emptyWorld());

    expect(marked(a, a.world).history.past.length).toEqual(0);
  });

  test('doing something after stepping back drops what was ahead', () => {
    const a = initialState(emptyWorld());
    const b = step(a, square(a.world, 0).world);
    const back = undone(b);

    expect(back.history.future.length).toEqual(1);

    const instead = step(back, square(back.world, 50).world);

    expect(instead.history.future).toEqual([]);
    expect(redone(instead)).toBe(instead);
  });

  test('stepping back past a birth leaves nothing picked that is gone', () => {
    const a = initialState(emptyWorld());
    const made = square(a.world, 0);
    const b = {
      ...step(a, made.world),
      selection: {
        polygons: [made.id],
        vertices: made.world.polygons.get(made.id)!.points.map(p => p.id),
        edges: [],
        artefacts: [],
        paths: [],
        start: false,
        eye: false,
      },
    };

    const back = undone(b);

    expect(back.world.polygons.size).toEqual(0);
    expect(back.selection.polygons).toEqual([]);
    expect(back.selection.vertices).toEqual([]);

    // And going forward again finds them, since the world has them again.
    expect(redone(back).world.polygons.size).toEqual(1);
  });

  test('there is nothing to step back to at the start, and nothing forward at the end', () => {
    const a = initialState(emptyWorld());

    expect(undone(a)).toBe(a);
    expect(redone(a)).toBe(a);
  });
});

describe('gestures', () => {
  const two = () => {
    const a = square(emptyWorld(), 0);
    const b = square(a.world, 20);

    return { world: b.world, ids: [a.id, b.id] };
  };

  test('what one step wrote carries one gesture, fresh from the id counter', () => {
    const { world, ids } = two();
    const s = step(initialState(world), ids.reduce((w, id) => wrote(w, 0, id, move(1, 0)), world));
    const [a, b] = ids.map(id => rigOf(s.world, id).keys.get(0)![0].gesture);

    expect(a).toEqual(world.nextId);
    expect(b).toEqual(a);
    expect(s.world.nextId).toEqual(world.nextId + 1);
  });

  test('a corner depth is a gesture too, and the key it is written in carries it', () => {
    const { world, ids } = two();
    const corners = world.polygons.get(ids[0])!.points.map(c => c.id);
    const first = step(initialState(world), deepen(world, 0, ids[0], new Set(corners.slice(0, 2)), 1));
    const second = step(first, deepen(first.world, 0, ids[0], new Set(corners.slice(1, 3)), 1));
    const of = (w: World, i: number) => rigOf(w, ids[0]).depths.get(corners[i])!.get(0)!.gesture;

    expect(of(first.world, 0), 'the first gesture').toEqual(world.nextId);
    expect(of(first.world, 1)).toEqual(of(first.world, 0));

    // A keyframe's corner writing is one key — see `cornerWrite` in `rig.ts` —
    // so deepening two of them again is that key written again, and the
    // gesture is the key's rather than each corner's. Three corners are deep
    // here and all three are picked together.
    expect(of(second.world, 2), 'the second').toEqual(world.nextId + 1);
    expect(of(second.world, 0)).toEqual(of(second.world, 2));
    expect(of(second.world, 1)).toEqual(of(second.world, 2));
  });

  test('told how often to repeat, an entry keeps its gesture', () => {
    const { world, ids } = two();
    const s = step(initialState(world), wrote(world, 0, ids[0], erode(1)));
    const was = rigOf(s.world, ids[0]).keys.get(0)![0].gesture;
    const out = timed(s.world, ids[0], 0, 0, null);

    if ('refused' in out) throw new Error(out.refused);

    const t = step(s, out);

    expect(rigOf(t.world, ids[0]).keys.get(0)![0]).toEqual({ op: erode(1), times: null, gesture: was });
    expect(t.world.nextId).toEqual(s.world.nextId);
  });
});

describe('the keys the hand is on', () => {
  /** A room with two keys at v1, picked, and the hand on the first of them. */
  const on = () => {
    const { world, id } = square(emptyWorld(), 0);
    const w = wrote(world, 1, id, move(10, 0), move(0, 20));
    const key = keysOfAt(w, 1, id)[0];
    const place = { id, at: 1, key: key.id };
    const s: EditorState = {
      ...initialState(w),
      keyframe: 1,
      selection: { ...EMPTY_SELECTION, polygons: [id] },
      target: { lead: place, all: [place] },
    };

    return { s, id, key };
  };

  test('stay on the same key across an edit of it, so the next gesture lands there too', () => {
    const { s, id, key } = on();
    const read = editedAt(s.world, 1, id, key)!;
    const out = writtenInto(s.world, 1, id, key.id, moveOf(read.paint, { x: 5, y: 0 }));
    const after = aimed(step(s, out.world));

    expect(out.key).toBe(key.id);
    expect(after.target).toBe(s.target);
    expect(keysOfAt(after.world, 1, id)[0].by!.move).toEqual({ x: 15, y: 0 });
  });

  test('and wherever an edit moved it along', () => {
    const { s, id } = on();
    const now = withKeyRig(s.world, id, withKeysAt(
      keyRigOf(s.world, id),
      1,
      [{ id: 99, ref: { x: 0, y: 0 }, by: { ...NOTHING, erode: 1 }, times: 1 }, ...keysOfAt(s.world, 1, id)],
    ));

    expect(aimed(step(s, now)).target).toBe(s.target);
  });

  test('let go where the key is taken out, the keyframe changes, or its thing is not picked', () => {
    const { s, id } = on();
    const gone = withKeyRig(s.world, id, withKeysAt(keyRigOf(s.world, id), 1, keysOfAt(s.world, 1, id).slice(1)));

    expect(aimed(step(s, gone)).target).toBeNull();
    expect(aimed({ ...s, keyframe: 2 }).target).toBeNull();
    expect(aimed({ ...s, selection: EMPTY_SELECTION }).target).toBeNull();
  });

  test('and an undo that takes the key back lets go of it', () => {
    const { s, id } = on();
    const out = writtenInto(s.world, 1, id, null, move(1, 1));
    const t = step({ ...s, target: aiming([{ id, at: 1, key: out.key! }]) }, out.world);

    expect(aimed(undone(t)).target).toBeNull();
  });
});

describe('a gesture', () => {
  test('with the hand on no key writes a new one, and the next goes into it whatever it is', () => {
    const { world, id } = square(emptyWorld(), 0);
    const w = wrote(world, 1, id, erode(2));
    const first = writtenInto(w, 1, id, null, move(10, 0));

    expect(keysOfAt(first.world, 1, id)).toHaveLength(2);

    // A turn after a move, and an erosion after both: no rule of its own
    // splits them off.
    const turn = turned(0.3, { x: 50, y: 0 });
    const second = writtenInto(first.world, 1, id, first.key, typeof turn === 'function' ? turn(first.world, 1, id) : turn);
    const third = writtenInto(second.world, 1, id, first.key, erode(1));
    const keys = keysOfAt(third.world, 1, id);

    expect(keys).toHaveLength(2);
    expect(keys[1].by!.angle).toBeCloseTo(0.3, 12);
    expect(keys[1].by!.erode).toBe(1);
  });

  test('into a key that repeats adjusts every step of it, and a new key does not repeat', () => {
    const { world, id } = square(emptyWorld(), 0);
    const timedOut = timed(wrote(world, 1, id, move(10, 0)), id, 1, 0, 3);

    if ('refused' in timedOut) throw new Error(timedOut.refused);

    const w = timedOut;
    const key = keysOfAt(w, 1, id)[0];
    const into = writtenInto(w, 1, id, key.id, erode(1));
    const fresh = writtenInto(w, 1, id, null, erode(1));

    expect(keysOfAt(into.world, 1, id)[0].times).toBe(3);
    expect(keysOfAt(fresh.world, 1, id)[1].times).toBe(1);
  });
});
