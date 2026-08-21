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
import { addPolygon } from './scene';
import {
  EditorState,
  World,
  emptyWorld,
  initialState,
  marked,
  redone,
  undone,
} from './types';

function square(world: World, x: number): { world: World, id: number } {
  return addPolygon(
    world,
    'level',
    [{ x, y: 0 }, { x: x + 10, y: 0 }, { x: x + 10, y: 10 }, { x, y: 10 }],
    0,
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
