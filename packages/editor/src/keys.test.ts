import { describe, expect, test } from 'vitest';
import { Point } from '@ce/game/world';
import { TOP, addPolygon, listAt, rigOf, withRig } from './scene';
import { Frame, nudged, stateAt } from './rig';
import { Refused, deleted, dropped, inserted, pulled, pushed, split, timed } from './keys';
import { erode, move, moved, repeated, scaled, spun, turned, wrote } from './testing';
import { Id, KeyframeId, World, emptyWorld } from './types';

function rect(x: number, y: number, w: number, h: number): Point[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

function room(world: World = emptyWorld(), birth: KeyframeId = 0): { world: World, id: Id } {
  return addPolygon(world, { type: 'level' }, rect(0, 0, 100, 60), birth, TOP);
}

function ok(out: World | Refused): World {
  if ('refused' in out) throw new Error(out.refused);

  return out;
}

function expectFrame(a: Frame, b: Frame): void {
  expect(a.t.x).toBeCloseTo(b.t.x, 9);
  expect(a.t.y).toBeCloseTo(b.t.y, 9);
  expect(a.angle).toBeCloseTo(b.angle, 9);
  expect(a.skew).toBeCloseTo(b.skew, 9);
  expect(a.scale.x).toBeCloseTo(b.scale.x, 9);
  expect(a.scale.y).toBeCloseTo(b.scale.y, 9);
}

/** Every keyframe of `a` in `b` where they share it, the same. */
function expectSame(a: World, b: World, id: Id): void {
  for (const f of a.keyframes) {
    if (b.keyframes.some(g => g.id === f.id)) expectFrame(stateAt(a, id, f.id).frame, stateAt(b, id, f.id).frame);
  }
}

describe('entries', () => {
  test('a split turn is the turn, and its halves meet halfway', () => {
    const { world, id } = room();
    const w = wrote(world, 1, id, turned(1.2, { x: 300, y: -40 }), moved(10, 5));
    const cut = ok(split(w, id, 1, 0));

    expect(listAt(cut, 1, id).length).toBe(3);
    expectSame(w, cut, id);

    const half = ok(split(wrote(world, 1, id, turned(1.2, { x: 300, y: -40 })), id, 1, 0, 0.25));

    expect(stateAt(half, id, 1).frame.angle).toBeCloseTo(1.2, 12);
  });

  test('a split non-uniform scale after a turn is the scale', () => {
    const { world, id } = room();
    const w = wrote(world, 1, id, spun(0.7), scaled(2, 0.5, { x: 50, y: 400 }));

    expectSame(w, ok(split(w, id, 1, 1, 0.3)), id);
  });

  test('a repeating turn does not split; a repeating move does, and stays the same', () => {
    const { world, id } = room();
    const w = repeated(world, 1, id, turned(0.3, { x: 200, y: 0 }), 4);

    expect('refused' in split(w, id, 1, 0)).toBe(true);

    const m = repeated(world, 1, id, move(10, 0), null);

    expectSame(m, ok(split(m, id, 1, 0)), id);
  });

  test('drop takes out one entry or every one of a kind', () => {
    const { world, id } = room();
    const w = wrote(world, 2, id, move(1, 0), erode(3), move(0, 1), turned(0.5));

    expect(listAt(dropped(w, id, 2, 1), 2, id).map(e => e.op.kind)).toEqual(['move', 'move', 'turn']);
    expect(listAt(dropped(w, id, 2, 'move'), 2, id).map(e => e.op.kind)).toEqual(['erode', 'turn']);
  });

  test('push goes to the front of the next keyframe, and pull brings it back to the end', () => {
    const { world, id } = room();
    const w = wrote(wrote(world, 2, id, move(1, 0), turned(0.5)), 3, id, move(0, 7));
    const there = ok(pushed(w, id, 2, 'turn'));

    expect(listAt(there, 2, id).map(e => e.op.kind)).toEqual(['move']);
    expect(listAt(there, 3, id).map(e => e.op.kind)).toEqual(['turn', 'move']);

    const back = ok(pulled(there, id, 2, 0));

    expect(listAt(back, 2, id)).toEqual(listAt(w, 2, id));
    expect(listAt(back, 3, id)).toEqual(listAt(w, 3, id));
  });

  test('nothing is pushed off the end, or pulled to before a birth', () => {
    const { world, id } = room(emptyWorld(), 3);
    const last = world.keyframes[world.keyframes.length - 1].id;

    expect('refused' in pushed(wrote(world, last, id, move(1, 0)), id, last, 0)).toBe(true);
    expect('refused' in pulled(wrote(world, 3, id, move(1, 0)), id, 2, 0)).toBe(true);
  });

  test('times is set, and a repeat that runs out stops', () => {
    const { world, id } = room();
    const w = ok(timed(wrote(world, 1, id, move(10, 0)), id, 1, 0, 3));

    expect(stateAt(w, id, 5).frame.t.x).toBe(30);
    expect('refused' in timed(w, id, 1, 0, 0)).toBe(true);
  });
});

describe('keyframes', () => {
  test('an inserted keyframe takes half of the next, which stays where it was', () => {
    const { world, id } = room();
    const w = wrote(world, 2, id, turned(1, { x: 300, y: 0 }), moved(40, 0), turned(0.4, { x: 300, y: 0 }));
    const out = inserted(w, 1)!;

    expect(out.held).toEqual([]);
    expect(out.world.keyframes.length).toBe(w.keyframes.length + 1);
    expect(out.world.keyframes[2].id).toBe(out.key);
    expect(out.world.keyframes.map(f => f.name)).toEqual(out.world.keyframes.map((_f, i) => `v${i}`));
    expectSame(w, out.world, id);
    expect(stateAt(out.world, id, out.key).frame.angle).toBeCloseTo(0.7, 12);
  });

  test('where the next keyframe turns and scales, the thing holds still over the new one', () => {
    const { world, id } = room();
    const w = wrote(world, 2, id, spun(0.5), scaled(2, 1));
    const out = inserted(w, 1)!;

    expect(out.held).toEqual([id]);
    expectSame(w, out.world, id);
    expectFrame(stateAt(out.world, id, out.key).frame, stateAt(w, id, 1).frame);
  });

  test('a thing born at the next keyframe is not cut', () => {
    const { world, id } = room(emptyWorld(), 2);
    const w = wrote(world, 2, id, move(10, 0));
    const out = inserted(w, 1)!;

    expect(listAt(out.world, out.key, id)).toEqual([]);
    expectSame(w, out.world, id);
  });

  test('a repeat running across an inserted keyframe takes a step there, and ends where it ended', () => {
    const { world, id } = room();
    const w = repeated(world, 1, id, move(10, 0), 4);
    const out = inserted(w, 2)!;

    expect(listAt(out.world, 1, id)[0].times).toBe(5);
    expect(stateAt(out.world, id, 4).frame.t.x).toBe(50);
    expect(stateAt(out.world, id, 5).frame.t.x).toBe(50);
  });

  test('corner nudges at the next keyframe are cut too', () => {
    const { world, id } = room();
    const corner = world.polygons.get(id)!.points[0].id;
    const w = withRig(world, id, nudged(rigOf(world, id), corner, 2, { x: 8, y: 0 }));
    const out = inserted(w, 1)!;
    const rest = stateAt(w, id, 1).corners.get(corner)!.x;

    expect(stateAt(out.world, id, out.key).corners.get(corner)!.x - rest).toBe(4);
    expect(stateAt(out.world, id, 2).corners.get(corner)!.x - rest).toBe(8);
  });

  test('a deleted keyframe hands what it does to the next', () => {
    const { world, id } = room();
    const w = wrote(wrote(world, 2, id, move(5, 0), turned(0.3)), 3, id, move(0, 9));
    const out = ok(deleted(w, 2));

    expect(out.keyframes.some(f => f.id === 2)).toBe(false);
    expect(listAt(out, 3, id).map(e => e.op.kind)).toEqual(['move', 'turn', 'move']);
    expectFrame(stateAt(out, id, 3).frame, stateAt(w, id, 3).frame);
    expect(out.keyframes.map(f => f.name)).toEqual(out.keyframes.map((_f, i) => `v${i}`));
  });

  test('births and deaths move to the next; a life left empty goes', () => {
    let { world, id: a } = room(emptyWorld(), 2);
    const b = room(world, 2);

    world = b.world;
    world = { ...world, polygons: new Map(world.polygons).set(b.id, { ...world.polygons.get(b.id)!, death: 3 }) };

    const out = ok(deleted(world, 2));

    expect(out.polygons.get(a)!.birth).toBe(3);
    expect(out.polygons.has(b.id)).toBe(false);
  });

  test('deleting the last keyframe lets what died there live, and drops what was born there', () => {
    const last = emptyWorld().keyframes.length - 1;
    const early = room();
    const late = room(early.world, last);
    const world = {
      ...late.world,
      polygons: new Map(late.world.polygons).set(early.id, { ...late.world.polygons.get(early.id)!, death: last }),
    };
    const out = ok(deleted(world, last));

    expect(out.polygons.get(early.id)!.death).toBe(null);
    expect(out.polygons.has(late.id)).toBe(false);
  });

  test('a repeat a deleted keyframe was inside loses a step, and ends where it ended', () => {
    const { world, id } = room();
    const w = repeated(world, 1, id, move(10, 0), 4);
    const out = ok(deleted(w, 2));

    expect(listAt(out, 1, id)[0].times).toBe(3);
    expect(stateAt(out, id, 4).frame.t.x).toBe(30);
  });

  test('a repeat begun at a deleted keyframe begins at the next', () => {
    const { world, id } = room();
    const out = ok(deleted(repeated(world, 2, id, move(10, 0), 3), 2));

    expect(listAt(out, 3, id)[0].times).toBe(2);
    expect(stateAt(out, id, 4).frame.t.x).toBe(20);
    expect(stateAt(out, id, 5).frame.t.x).toBe(20);
  });

  test('corner nudges at a deleted keyframe add to the next', () => {
    const { world, id } = room();
    const corner = world.polygons.get(id)!.points[0].id;
    let rig = nudged(rigOf(world, id), corner, 2, { x: 3, y: 0 });

    rig = nudged(rig, corner, 3, { x: 4, y: 0 });

    const out = ok(deleted(withRig(world, id, rig), 2));

    expect(rigOf(out, id).nudges.get(corner)!.get(3)!.op.by.x).toBe(7);
  });

  test('the only keyframe stays', () => {
    const world = { ...emptyWorld(), keyframes: [{ id: 0, name: 'v0', visible: true }] };

    expect('refused' in deleted(world, 0)).toBe(true);
  });
});
