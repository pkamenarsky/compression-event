import { describe, expect, test } from 'vitest';
import { Point } from '@ce/game/world';
import {
  TOP,
  addPolygon,
  broken,
  editedAt,
  grouped,
  keysOfAt,
  listAt,
  moveOf,
  refolded,
  scaleOf,
  split,
  turnOf,
  upto,
} from './scene';
import { Frame, NOTHING, framed, playingAt, playingOn, stateAt, worldFrame } from './rig';
import { erode, move, moved, repeated, scaled, turned, wrote, wroteOne } from './testing';
import { Id, KeyframeId, World, emptyWorld } from './types';

function rect(x: number, y: number, w: number, h: number): Point[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

function room(world: World = emptyWorld()): { world: World, id: Id } {
  return addPolygon(world, { type: 'level' }, rect(0, 0, 100, 60), 0, TOP);
}

function expectFrame(a: Frame, b: Frame): void {
  expect(a.t.x).toBeCloseTo(b.t.x, 9);
  expect(a.t.y).toBeCloseTo(b.t.y, 9);
  expect(a.angle).toBeCloseTo(b.angle, 9);
  expect(a.scale.x).toBeCloseTo(b.scale.x, 9);
  expect(a.scale.y).toBeCloseTo(b.scale.y, 9);
}

function at(world: World, id: Id, k: KeyframeId): Frame {
  return framed(worldFrame(world, id, k))!;
}

/** The entry at `index` edited the way the canvas edits it, by the gesture
 * `op` writes against what `editedAt` reads. */
function edit(world: World, k: KeyframeId, id: Id, index: number, gesture: Parameters<typeof editedWith>[0]): World {
  const e = keysOfAt(world, k, id)[index];
  const { paint, pivot } = editedAt(world, k, id, e)!;

  return refolded(world, k, id, index, editedWith(gesture, paint, pivot));
}

function editedWith(
  g: { turn: number } | { scale: { x: number, y: number } } | { move: Point } | { erode: number },
  paint: Parameters<typeof turnOf>[0],
  pivot: Point,
) {
  if ('turn' in g) return turnOf(paint, pivot, g.turn);
  if ('scale' in g) return scaleOf(paint, pivot, g.scale);
  if ('move' in g) return moveOf(paint, g.move);

  return erode(g.erode);
}

describe('editing one entry', () => {
  test('a turn edited goes further about its own centre, one entry, whatever comes after it', () => {
    const { world, id } = room();
    const c = { x: 300, y: -40 };
    const w = wrote(world, 1, id, turned(0.3, c), moved(20, 5));
    const once = wrote(world, 1, id, turned(0.8, c), moved(20, 5));

    const out = edit(w, 1, id, 0, { turn: 0.5 });

    expect(listAt(out, 1, id)).toHaveLength(2);
    expectFrame(at(out, id, 1), at(once, id, 1));
  });

  test('a turn in a group edits about the same centre', () => {
    const a = room();
    const b = addPolygon(a.world, { type: 'level' }, rect(200, 0, 50, 50), 0, TOP);
    const g = grouped(b.world, 0, [a.id, b.id], TOP)!;
    const w = wrote(wrote(g.world, 0, g.id, turned(0.4, { x: 10, y: 10 })), 1, a.id, turned(0.2, { x: 50, y: 50 }));
    const once = wrote(wrote(g.world, 0, g.id, turned(0.4, { x: 10, y: 10 })), 1, a.id, turned(-0.1, { x: 50, y: 50 }));

    expectFrame(at(edit(w, 1, a.id, 0, { turn: -0.3 }), a.id, 1), at(once, a.id, 1));
  });

  test('a scale edited stretches further about the point it was about', () => {
    const { world, id } = room();
    const c = { x: -50, y: 80 };
    const w = wrote(wrote(world, 0, id, turned(0.7)), 1, id, scaled(2, 0.5, c));
    const once = wrote(wrote(world, 0, id, turned(0.7)), 1, id, scaled(3, 0.25, c));

    const out = edit(w, 1, id, 0, { scale: { x: 1.5, y: 0.5 } });

    expect(listAt(out, 1, id)).toHaveLength(1);
    expectFrame(at(out, id, 1), at(once, id, 1));
  });

  test('a repeat edited keeps repeating, every step the further', () => {
    const { world, id } = room();
    const c = { x: 200, y: 0 };
    const w = repeated(world, 1, id, turned(0.1, c), 4);
    const once = repeated(world, 1, id, turned(0.25, c), 4);
    const out = edit(w, 1, id, 0, { turn: 0.15 });

    expect(listAt(out, 1, id)[0].times).toBe(4);

    for (const k of [1, 2, 3, 4]) expectFrame(at(out, id, k), at(once, id, k));
  });

  test('a move and an erosion add, and one edited back to nothing goes', () => {
    const { world, id } = room();
    const w = wrote(world, 1, id, moved(10, 0), erode(4));

    expect(listAt(edit(w, 1, id, 0, { move: { x: 5, y: 5 } }), 1, id)[0].op).toEqual({ kind: 'move', by: { x: 15, y: 5 } });
    expect(listAt(edit(w, 1, id, 1, { erode: -4 }), 1, id).map(e => e.op.kind)).toEqual(['move']);
  });
});

// -----------------------------------------------------------------------------
// Break and split
//
// The two that say where one key ends. Breaking says the next thing written is
// a key of its own; splitting says the last thing written was.
// -----------------------------------------------------------------------------

describe('break and split', () => {
  /** A room, and a hand that moves it and then turns it without letting go of
   * the keyframe. */
  const both = () => {
    const { world, id } = room();
    const one = wroteOne(world, 1, id, move(10, 0));

    return { world, id, moved: one, turned: wroteOne(one, 1, id, turned(0.5, { x: 200, y: 0 })) };
  };

  test('two gestures at one keyframe are one key', () => {
    const { id, turned } = both();
    const keys = keysOfAt(turned, 1, id);

    expect(keys).toHaveLength(1);
    expect(keys[0].by!.angle).toBeCloseTo(0.5, 12);
    expect(keys[0].by!.move).not.toEqual({ x: 0, y: 0 });
  });

  test('broken, the next gesture is a key of its own, and nothing moves', () => {
    const { id, moved, turned: together } = both();
    const apart = wroteOne(broken(moved, 1, [id]), 1, id, turned(0.5, { x: 200, y: 0 }));

    expect(keysOfAt(apart, 1, id)).toHaveLength(2);

    // Where it stands at the keyframe is the same either way: what breaking
    // changes is the way between, not the ends.
    expectFrame(at(apart, id, 1), at(together, id, 1));
    expectFrame(at(apart, id, 2), at(together, id, 2));
  });

  test('split takes the last gesture out and leaves the one before it', () => {
    const { id, moved, turned } = both();
    const apart = split(turned, moved, 1, [id]);
    const keys = keysOfAt(apart, 1, id);

    expect(keys).toHaveLength(2);
    expect(keys[0].by!.angle).toBe(0);
    expect(keys[0].by!.move).toEqual(keysOfAt(moved, 1, id)[0].by!.move);
    expect(keys[1].by!.angle).toBeCloseTo(0.5, 12);


    expectFrame(at(apart, id, 1), at(turned, id, 1));
  });

  /** Where the thing is half way from the keyframe before to `v`, which is
   * what the bake puts in flight. See `flown` in `bake.ts`. */
  const half = (world: World, id: Id): Frame =>
    playingAt(world, id, 1).reduce((f, p) => playingOn(f, p, 0.5), stateAt(world, id, 0).frame);

  test('folded, the way between the keyframes is one motion', () => {
    const { world, id } = room();
    const first = wroteOne(world, 1, id, turned(0.5, { x: 200, y: 0 }));
    const together = wroteOne(first, 1, id, scaled(2, 0.5));
    const apart = wroteOne(broken(first, 1, [id]), 1, id, scaled(2, 0.5));

    // The ends are the same and the way between is not: one key is one motion
    // — the painted point round the point the pair leave still — where two are
    // one after the other. That is what breaking is for, and what a fold
    // costs: see *Known and accepted* in `PLAN-keys.md`.
    expectFrame(stateAt(apart, id, 1).frame, stateAt(together, id, 1).frame);
    expect(half(together, id).t.x).not.toBeCloseTo(half(apart, id).t.x, 6);
  });

  test('a gesture that wrote a key of its own is already split', () => {
    const { world, id } = room();
    const one = wroteOne(world, 1, id, move(10, 0));

    expect(keysOfAt(split(one, world, 1, [id]), 1, id)).toHaveLength(1);
  });

  test('split gives back exactly what the hand did, whatever it did', () => {
    const { world, id } = room();
    const first = wroteOne(world, 1, id, scaled(2, 0.5));
    const now = wroteOne(first, 1, id, turned(0.3, { x: 0, y: 0 }), move(4, -7));
    const apart = split(now, first, 1, [id]);
    const keys = keysOfAt(apart, 1, id);

    expect(keys).toHaveLength(2);
    expect(keys[0].by).toEqual(keysOfAt(first, 1, id)[0].by);

    // The two of them still land where the one did.
    for (const v of [1, 2] as const) expectFrame(at(apart, id, v), at(now, id, v));
  });
});

// -----------------------------------------------------------------------------
// Standing on a key
//
// What the canvas draws when one is stood on: the world that keyframe leaves
// after that key, and nothing else moved. See `upto`.
// -----------------------------------------------------------------------------

describe('standing on a key', () => {
  const two = () => {
    const { world, id } = room();
    const other = addPolygon(world, { type: 'level' }, rect(300, 0, 40, 40), 0, TOP);
    const w = wrote(other.world, 1, id, move(10, 0), move(0, 20));

    return { world: wrote(w, 1, other.id, move(-5, 0)), id, other: other.id };
  };

  test('the world upto a key is that keyframe less what it does after it', () => {
    const { world, id } = two();
    const first = upto(world, 1, id, 0);

    expect(keysOfAt(first, 1, id)).toHaveLength(1);
    expectFrame(at(first, id, 1), at(wrote(room(emptyWorld()).world, 1, room(emptyWorld()).id, move(10, 0)), id, 1));
  });

  test('and every other thing is where the keyframe leaves it', () => {
    const { world, id, other } = two();
    const first = upto(world, 1, id, 0);

    expect(keysOfAt(first, 1, other)).toEqual(keysOfAt(world, 1, other));
    expectFrame(at(first, other, 1), at(world, other, 1));
  });

  test('the keyframes after it are where they were, since a key carries', () => {
    const { world, id } = two();
    const first = upto(world, 1, id, 0);

    // What is dropped is dropped for good in the world that is drawn, so the
    // keyframes after it move too: it is a view of a moment, not an edit.
    expect(at(first, id, 2).t.y).not.toBeCloseTo(at(world, id, 2).t.y, 6);
  });

  test('standing on the last key of a keyframe is the keyframe itself', () => {
    const { world, id } = two();

    expect(upto(world, 1, id, keysOfAt(world, 1, id).length - 1)).toBe(world);
  });
});

describe('an empty key', () => {
  test('breaking leaves one, and the next gesture fills it', () => {
    const { world, id } = room();
    const moved = wroteOne(world, 1, id, move(10, 0));
    const after = broken(moved, 1, [id]);
    const keys = keysOfAt(after, 1, id);

    expect(keys).toHaveLength(2);
    expect(keys[1].by).toEqual(NOTHING);

    // It does nothing, so the thing is where it was.
    expectFrame(at(after, id, 1), at(moved, id, 1));

    const spun = wroteOne(after, 1, id, turned(0.5, { x: 200, y: 0 }));

    expect(keysOfAt(spun, 1, id)).toHaveLength(2);
    expect(keysOfAt(spun, 1, id)[1].by!.angle).toBeCloseTo(0.5, 12);
  });

  test('breaking twice says what breaking once said', () => {
    const { world, id } = room();
    const once = broken(wroteOne(world, 1, id, move(10, 0)), 1, [id]);

    expect(broken(once, 1, [id])).toBe(once);
  });

  test('and one where nothing is written at all is still one', () => {
    const { world, id } = room();

    expect(keysOfAt(broken(world, 1, [id]), 1, id)).toHaveLength(1);
  });
});

describe('a gesture while standing on a key', () => {
  test('folds into that key rather than writing one after it', () => {
    const { world, id } = room();
    const w = wrote(world, 1, id, move(10, 0), move(0, 20));

    // What the canvas does while standing on the first of the two: the same
    // operation the gesture would write, read against the thing as that key
    // leaves it and folded back into it. See `editedAt` and `refolded`.
    const key = keysOfAt(w, 1, id)[0];
    const { paint, pivot } = editedAt(w, 1, id, key)!;
    const after = refolded(w, 1, id, 0, editedWith({ move: { x: 5, y: 0 } }, paint, pivot));
    const keys = keysOfAt(after, 1, id);

    expect(keys).toHaveLength(2);
    expect(keys[0].by!.move).toEqual({ x: 15, y: 0 });
    expect(keys[1].by).toEqual(keysOfAt(w, 1, id)[1].by);

    // And the keyframe ends up five further along, the second key carrying.
    expect(at(after, id, 1).t.x - at(w, id, 1).t.x).toBeCloseTo(5, 9);
  });

  test('and a turn about the key\'s own centre, not the selection\'s', () => {
    const { world, id } = room();
    const w = wrote(world, 1, id, turned(0.5, { x: 200, y: 0 }), move(0, 40));
    const key = keysOfAt(w, 1, id)[0];
    const read = editedAt(w, 1, id, key)!;

    // The centre the key turned about, which is where the hand aimed it and
    // not where the thing is now.
    expect(read.pivot.x).toBeCloseTo(200, 6);
    expect(read.pivot.y).toBeCloseTo(0, 6);

    const after = refolded(w, 1, id, 0, editedWith({ turn: 0.25 }, read.paint, read.pivot));

    expect(keysOfAt(after, 1, id)[0].by!.angle).toBeCloseTo(0.75, 9);
  });
});
