import { describe, expect, test } from 'vitest';
import { Point } from '@ce/game/world';
import { TOP, addPolygon, copied, grouped, listAt, pasted, rigOf, ungrouped, withRig } from './scene';
import { Frame, deepened, framed, nudged, repeating, stateAt, worldFrame } from './rig';
import { Place, Refused, deleted, droppedAt, dropped, entryAt, inserted, pulled, pulledAt, pushed, pushedAt, skipToggledAt, timed, timedAt } from './keys';
import { erode, move, moved, repeated, scaled, spun, turned, wrote } from './testing';
import { restored, saved } from './save';
import { Id, KeyframeId, World, emptyWorld, initialState } from './types';

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

function framedWorld(world: World, id: Id, k: KeyframeId): Frame {
  return framed(worldFrame(world, id, k))!;
}

/** Every keyframe of `a` in `b` where they share it, the same. */
function expectSame(a: World, b: World, id: Id): void {
  for (const f of a.keyframes) {
    if (b.keyframes.some(g => g.id === f.id)) expectFrame(stateAt(a, id, f.id).frame, stateAt(b, id, f.id).frame);
  }
}

describe('entries', () => {
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
  test('an inserted keyframe is the one before over again, and nothing after it moves', () => {
    const { world, id } = room();
    let w = wrote(world, 2, id, turned(1, { x: 300, y: 0 }), moved(40, 0), scaled(2, 1));

    w = repeated(w, 1, id, spun(0.3), null);
    w = repeated(w, 0, id, turned(0.2, { x: -100, y: 50 }), 5);

    const out = inserted(w, 2)!;

    expect(out.world.keyframes.length).toBe(w.keyframes.length + 1);
    expect(out.world.keyframes[3].id).toBe(out.key);
    expect(out.world.keyframes.map(f => f.name)).toEqual(out.world.keyframes.map((_f, i) => `v${i}`));
    expectSame(w, out.world, id);
    expectFrame(stateAt(out.world, id, out.key).frame, stateAt(w, id, 2).frame);
    expect(listAt(out.world, 1, id)[0].skip).toEqual(new Set([out.key]));
  });

  test('a repeat that has run out by then is not told to skip', () => {
    const { world, id } = room();
    const out = inserted(repeated(world, 1, id, move(10, 0), 2), 3)!;

    expect(listAt(out.world, 1, id)[0].skip).toBe(undefined);
  });

  test('a repeating corner nudge skips it too', () => {
    const { world, id } = room();
    const corner = world.polygons.get(id)!.points[0].id;
    const rig = { ...rigOf(world, id), nudges: new Map([[corner, new Map([[1, repeating(move(5, 0), null)]])]]) };
    const w = withRig(world, id, rig);
    const out = inserted(w, 2)!;

    for (const f of w.keyframes) {
      expect(stateAt(out.world, id, f.id).corners.get(corner)).toEqual(stateAt(w, id, f.id).corners.get(corner));
    }

    expect(stateAt(out.world, id, out.key).corners.get(corner)).toEqual(stateAt(w, id, 2).corners.get(corner));
  });

  test('deleting an inserted keyframe gives back what there was', () => {
    const { world, id } = room();
    const w = repeated(world, 1, id, spun(0.3), 4);
    const out = inserted(w, 2)!;
    const back = ok(deleted(out.world, out.key));

    expect(listAt(back, 1, id)).toEqual(listAt(w, 1, id));
    expectSame(w, back, id);
  });

  test('a push takes a skip of the keyframe it now starts at off', () => {
    const { world, id } = room();
    const out = inserted(repeated(world, 1, id, move(10, 0), null), 1)!;
    const there = ok(pushed(out.world, id, 1, 0));

    expect(listAt(there, out.key, id)[0].skip).toBe(undefined);
  });

  test('ungrouping keeps a skip on the repeats it carries, and everything where it was', () => {
    const one = room();
    const two = addPolygon(one.world, { type: 'level' }, rect(300, 0, 50, 50), 0, TOP);
    const made = grouped(two.world, 0, [one.id, two.id], TOP)!;
    let w = repeated(made.world, 1, one.id, spun(0.3), null);

    w = repeated(w, 1, made.id, move(20, 0), null);

    const out = inserted(w, 2)!;
    const apart = ungrouped(out.world, made.id)!;

    for (const e of listAt(apart, 1, one.id).filter(e => e.times === null)) {
      expect(e.skip).toEqual(new Set([out.key]));
    }

    for (const f of out.world.keyframes) {
      expectFrame(stateAt(apart, one.id, f.id).frame, framedWorld(out.world, one.id, f.id));
    }
  });

  test('skips are saved', () => {
    const { world, id } = room();
    const out = inserted(repeated(world, 1, id, move(10, 0), null), 2)!;
    const back = restored(saved(initialState(out.world)))!;

    expect(listAt(back.world, 1, id)[0].skip).toEqual(new Set([out.key]));
  });

  test('a pasted repeat keeps its skip on the keyframe it names, where it reaches it', () => {
    const { world, id } = room();
    const out = inserted(repeated(world, 1, id, move(10, 0), null), 3)!;
    const clips = copied(out.world, 1, [id]);
    const at = (i: number): KeyframeId => out.world.keyframes[i].id;
    const early = pasted(out.world, at(0), clips, { x: 0, y: 0 }, TOP);
    const late = pasted(out.world, at(5), clips, { x: 0, y: 0 }, TOP);
    const a = early.ids[0], b = late.ids[0];

    expect(listAt(early.world, at(0), a).find(e => e.times === null)!.skip).toEqual(new Set([out.key]));
    expect(listAt(late.world, at(5), b).find(e => e.times === null)!.skip).toBe(undefined);
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

  test('what is born at a deleted keyframe goes with it; what dies there dies at the next', () => {
    let { world, id: a } = room(emptyWorld(), 2);
    const b = room(world, 1);

    world = b.world;
    world = { ...world, polygons: new Map(world.polygons).set(b.id, { ...world.polygons.get(b.id)!, death: 2 }) };

    const out = ok(deleted(world, 2));

    expect(out.polygons.has(a)).toBe(false);
    expect(out.polygons.get(b.id)!.death).toBe(3);
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

describe('places', () => {
  /** A room with one corner nudged and deepened at 1, and another nudged at
   * 2; and a list of three at 1. */
  const rigged = () => {
    const { world, id } = room();
    const corners = world.polygons.get(id)!.points.map(c => c.id);
    let rig = nudged(rigOf(world, id), corners[0], 1, { x: 1, y: 0 });

    rig = deepened(rig, corners[0], 1, 2);
    rig = nudged(rig, corners[1], 2, { x: 0, y: 1 });

    const w = wrote(withRig(world, id, rig), 1, id, move(1, 0), erode(1), move(0, 1));

    return { w, id, corners };
  };

  test('several in one list go together, and a corner by its kind', () => {
    const { w, id, corners } = rigged();
    const out = droppedAt(w, [{ id, at: 1, index: 0 }, { id, at: 1, index: 2 }, { id, at: 1, corner: corners[0], kind: 'erode' }]);

    expect(listAt(out, 1, id).map(e => e.op)).toEqual([erode(1)]);
    expect(rigOf(out, id).depths.size).toBe(0);
    expect(rigOf(out, id).nudges.get(corners[0])?.get(1)?.op).toEqual(move(1, 0));
  });

  test('a corner pushed along lands on the next keyframe, added to what it has there', () => {
    const { w, id, corners } = rigged();
    const nudge: Place = { id, at: 1, corner: corners[0], kind: 'move' };
    const once = ok(pushedAt(w, [nudge]));

    expect(entryAt(once, nudge)).toBeUndefined();
    expect(entryAt(once, { ...nudge, at: 2 })?.op).toEqual(move(1, 0));

    const other: Place = { id, at: 1, corner: corners[1], kind: 'move' };
    const back = ok(pulledAt(w, [{ ...other, at: 2 }]));

    expect(entryAt(back, other)?.op).toEqual(move(0, 1));
    expect(entryAt(ok(pulledAt(back, [nudge, other])), { ...nudge, at: 0 })?.op).toEqual(move(1, 0));
  });

  test('a corner repeating unlike the one it would land on stays where it is', () => {
    const { w, id, corners } = rigged();
    const nudge: Place = { id, at: 1, corner: corners[1], kind: 'move' };
    const two = withRig(w, id, nudged(rigOf(w, id), corners[1], 1, { x: 2, y: 0 }));

    expect(pushedAt(ok(timedAt(two, nudge, 3)), [nudge])).toEqual({ refused: 'a corner would have two repeats at one keyframe' });
    expect(entryAt(ok(pushedAt(two, [nudge])), { ...nudge, at: 2 })?.op).toEqual(move(2, 1));
  });

  test('a corner repeats and skips like an entry in a list', () => {
    const { w, id, corners } = rigged();
    const depth: Place = { id, at: 1, corner: corners[0], kind: 'erode' };
    const out = ok(skipToggledAt(ok(timedAt(w, depth, 3)), depth, 2));

    expect(entryAt(out, depth)).toEqual({ op: erode(2), times: 2, skip: new Set([2]) });
  });
});
