import { describe, expect, test } from 'vitest';
import { Point } from '@ce/game/world';
import { TOP, addPolygon, grouped, listAt, reachable } from './scene';
import { stateAt } from './rig';
import { Refused, dropped, pushed, skipToggled } from './keys';
import { barOf, rootsOf, rowsOf, timesTo } from './track';
import { erode, move, repeated, scaled, wrote } from './testing';
import { restored, saved } from './save';
import { EMPTY_SELECTION, Id, KeyframeId, World, clickable, emptyWorld, flagged, initialState, visible } from './types';

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

describe('rows', () => {
  test('a thing opens into a row per kind written, then its members', () => {
    const a = room();
    const b = room(a.world);
    const made = grouped(b.world, 0, [a.id, b.id], TOP)!;
    const w = wrote(wrote(made.world, 1, made.id, move(1, 0), erode(2)), 3, made.id, move(0, 1));

    const shut = rowsOf(w, [made.id], new Set());

    expect(shut.map(r => [r.label, r.kind])).toEqual([[`group ${made.id}`, null]]);
    expect(shut[0].opens).toBe(true);
    expect(shut[0].cells.map(c => c.entries.length)).toEqual([0, 2, 0, 1, 0, 0, 0, 0, 0]);

    const open = rowsOf(w, [made.id], new Set([made.id]));

    expect(open.map(r => [r.kind, r.depth])).toEqual([[null, 0], ['move', 1], ['erode', 1], [null, 1], [null, 1]]);
    expect(open[1].cells[1].entries).toEqual([0]);
    expect(open[2].cells[1].entries).toEqual([1]);
  });

  test('cells before a birth are not alive', () => {
    const { world, id } = room(emptyWorld(), 2);
    const [row] = rowsOf(world, [id], new Set());

    expect(row.cells.map(c => c.alive)).toEqual([false, false, true, true, true, true, true, true, true]);
  });

  test('picked roots leave out what a picked group already holds; all is the top level', () => {
    const a = room();
    const b = room(a.world);
    const c = room(b.world);
    const made = grouped(c.world, 0, [a.id, b.id], TOP)!;

    expect(rootsOf(made.world, { ...EMPTY_SELECTION, polygons: [a.id, made.id] }, false)).toEqual([made.id]);
    expect(rootsOf(made.world, EMPTY_SELECTION, true)).toEqual([c.id, made.id]);
  });
});

describe('bars', () => {
  test('a repeat runs to its last step, waiting over what it skips', () => {
    const { world, id } = room();
    const w = repeated(world, 1, id, move(1, 0), 3);
    const e = listAt(w, 1, id)[0];

    expect(barOf(w, e, 1, 0)).toMatchObject({ steps: [{ col: 2, skip: false }, { col: 3, skip: false }], end: 3, forever: false });

    const skipped = ok(skipToggled(w, id, 1, 0, 2));
    const bar = barOf(skipped, listAt(skipped, 1, id)[0], 1, 0)!;

    expect(bar.steps).toEqual([{ col: 2, skip: true }, { col: 3, skip: false }, { col: 4, skip: false }]);
    expect(bar.end).toBe(4);
    expect(stateAt(skipped, id, 2).frame.t.x).toBe(1);
    expect(stateAt(skipped, id, 4).frame.t.x).toBe(3);

    // And back.
    expect(listAt(ok(skipToggled(skipped, id, 1, 0, 2)), 1, id)[0].skip).toBeUndefined();
  });

  test('once has no bar, and to the end runs to the last column', () => {
    const { world, id } = room();
    const w = repeated(world, 6, id, move(1, 0), null);

    expect(barOf(w, { op: move(1, 0), times: 1 }, 6, 0)).toBeNull();
    expect(barOf(w, listAt(w, 6, id)[0], 6, 0)).toMatchObject({ end: 8, forever: true });
  });

  test('a repeating scale says where it is heading', () => {
    const { world, id } = room();
    const w = repeated(world, 0, id, scaled(2, 2), 4);

    expect(barOf(w, listAt(w, 0, id)[0], 0, 0)!.heading).toBe('×16');
  });

  test('dragging the end counts the columns it steps at', () => {
    const { world, id } = room();
    const w = ok(skipToggled(repeated(world, 1, id, move(1, 0), 2), id, 1, 0, 2));
    const e = listAt(w, 1, id)[0];

    expect(timesTo(w, e, 1, 1)).toBe(1);
    expect(timesTo(w, e, 1, 0)).toBe(1);
    // Column 2 is waited over, so column 4 is the third time.
    expect(timesTo(w, e, 1, 4)).toBe(3);
    expect(timesTo(w, e, 1, 8)).toBeNull();
  });

  test('a skip is only after the entry', () => {
    const { world, id } = room();
    const w = repeated(world, 3, id, move(1, 0), null);

    expect('refused' in skipToggled(w, id, 3, 0, 3)).toBe(true);
    expect('refused' in skipToggled(w, id, 3, 0, 1)).toBe(true);
  });
});

describe('whole keyframes', () => {
  test('all drops and pushes every entry at a keyframe', () => {
    const { world, id } = room();
    const w = wrote(world, 2, id, move(1, 0), erode(3));

    expect(listAt(dropped(w, id, 2, 'all'), 2, id)).toEqual([]);

    const there = ok(pushed(w, id, 2, 'all'));

    expect(listAt(there, 2, id)).toEqual([]);
    expect(listAt(there, 3, id).map(e => e.op.kind)).toEqual(['move', 'erode']);
  });
});

describe('flags', () => {
  test('hidden and locked are not picked, and a group\'s flag is its members\'', () => {
    const a = room();
    const b = room(a.world);
    const c = room(b.world);
    const made = grouped(c.world, 0, [a.id, c.id], TOP)!;

    expect(reachable(made.world, a.id, null)).toBe(true);

    const hidden = flagged(made.world, made.id, 'hidden', true);

    expect(visible(hidden, a.id)).toBe(false);
    expect(reachable(hidden, a.id, null)).toBe(false);
    expect(reachable(hidden, b.id, null)).toBe(true);

    const locked = flagged(made.world, a.id, 'locked', true);

    expect(visible(locked, a.id)).toBe(true);
    expect(clickable(locked, a.id)).toBe(false);
    expect(flagged(locked, a.id, 'locked', false).flags.size).toBe(0);
  });

  test('solo keeps what is soloed, what holds it and what it holds', () => {
    const a = room();
    const b = room(a.world);
    const c = room(b.world);
    const made = grouped(c.world, 0, [a.id, b.id], TOP)!;
    const solo = flagged(made.world, a.id, 'solo', true);

    expect([a.id, b.id, c.id, made.id].map(id => visible(solo, id))).toEqual([true, false, false, true]);

    const group = flagged(made.world, made.id, 'solo', true);

    expect([a.id, b.id, c.id].map(id => visible(group, id))).toEqual([true, true, false]);
  });

  test('flags are saved', () => {
    const { world, id } = room();
    const w = flagged(flagged(world, id, 'hidden', true), id, 'solo', true);
    const back = restored(JSON.parse(JSON.stringify(saved(initialState(w))))).world;

    expect(back.flags.get(id)).toEqual({ hidden: true, locked: false, solo: true });
  });
});
