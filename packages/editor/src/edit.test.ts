import { describe, expect, test } from 'vitest';
import { Point } from '@ce/game/world';
import { TOP, addPolygon, editedAt, grouped, listAt, moveOf, refolded, scaleOf, turnOf } from './scene';
import { Frame, framed, worldFrame } from './rig';
import { erode, moved, repeated, scaled, turned, wrote } from './testing';
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
  const e = listAt(world, k, id)[index];
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
