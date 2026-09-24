// -----------------------------------------------------------------------------
// Files from before keys
//
// What `convert.ts` takes and what it leaves behind: a 20, a 21, a 22 and a 23
// are read here and nowhere else, and what comes out is a 24 that `save.ts`
// opens like any other.
// -----------------------------------------------------------------------------

import { describe, expect, test } from 'vitest';
import { Point } from '@ce/game/world';
import { Old, OldEntry, OldRig, converted, relative, unmasked } from './convert';
import { Saved, restored, restoredKeyRig, saved } from './save';
import { Entry, KeyframeId, Op, Rig, entriesOf, keysOf } from './rig';
import { TOP, addPolygon, grouped, handed, keyed, resolveAt, rigOf, scaleAt, withRig } from './scene';
import { withEffect } from './effects';
import { cornerRounded, once } from './rig';
import { EditorState, Id, PolygonKind, REMEMBERED, VertexId, World, emptyWorld, initialState } from './types';
import { scaled, wrote } from './testing';

type Named = 'level' | 'solid' | 'floor' | 'hole';

const kind = (k: Named): PolygonKind =>
  k === 'hole' ? { floor: 'void' } : k === 'floor' ? { floor: 'floor' } : { level: k === 'level' ? 'hollow' : k };

function rect(x: number, y: number, w: number, h: number): Point[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

/** Two rooms and a group over them, with something written about each. */
function world(): EditorState {
  let w = emptyWorld();
  const ids: Id[] = [];

  for (const [i, box] of [rect(0, 0, 100, 60), rect(200, 0, 80, 80)].entries()) {
    const made = addPolygon(w, kind(i === 0 ? 'level' : 'solid'), box, 0, TOP);

    w = made.world;
    ids.push(made.id);
  }

  w = wrote(w, 1, ids[0], { kind: 'move', by: { x: 3, y: -2 } });
  w = wrote(w, 2, ids[1], { kind: 'turn', angle: 0.25, ref: { x: 0, y: 0 }, about: { x: 0, y: 0 } });
  w = grouped(w, 0, ids, TOP)!.world;

  return initialState(w);
}

describe('the converter', () => {
/**
 * A 24 written out the way a 23 wrote it: timelines as lists of operations,
 * corner by corner. What these start from, there being no 23 to hand.
 */
function asOld(file: Saved): Old {
  const out = JSON.parse(JSON.stringify(file)) as unknown as Old;

  out.format = 23;
  out.world.rigs = file.world.rigs.map(([id, rig]) => [
    id,
    savedOldRig(entriesOf(restoredKeyRig(rig))),
  ]);

  return JSON.parse(JSON.stringify(out)) as Old;
}

/** A timeline of entries as a 23 wrote it. */
function savedOldRig(rig: Rig): OldRig {
  const corners = (m: ReadonlyMap<VertexId, ReadonlyMap<KeyframeId, Entry>>): [VertexId, [KeyframeId, OldEntry][]][] =>
    [...m].map(([c, map]) => [c, [...map].map(([k, e]) => [k, savedOldEntry(e)])]);

  return {
    keys: [...rig.keys].map(([k, list]) => [k, list.map(savedOldEntry)]),
    nudges: corners(rig.nudges),
    depths: corners(rig.depths),
    rounds: corners(rig.rounds),
    deforms: corners(rig.deforms),
  };
}

function savedOldEntry(e: Entry): OldEntry {
  const op = e.op.kind === 'stand'
    ? {
        kind: 'stand' as const,
        frame: e.op.frame,
        erosion: e.op.erosion,
        corners: [...e.op.corners],
        depths: [...e.op.depths],
        bevel: e.op.bevel,
        amplitude: e.op.amplitude,
        bevels: [...e.op.bevels],
        amplitudes: [...e.op.amplitudes],
      }
    : e.op;

  const out: OldEntry = e.skip === undefined ? { op, times: e.times } : { op, times: e.times, skip: [...e.skip] };

  return e.gesture === undefined ? out : { ...out, gesture: e.gesture };
}

/** A file taken through the converter and opened. */
function through(file: Old): EditorState {
  const keyed = converted(file);

  if ('refused' in keyed) throw new Error(keyed.refused);

  const out = relative(JSON.parse(JSON.stringify(keyed)) as Saved);

  if ('refused' in out) throw new Error(out.refused);

  return restored(JSON.parse(JSON.stringify(out)) as Saved);
}

  test('a 21, which had no effects, reads as one with none', () => {
    const before = world();
    const file = asOld(saved(before));

    file.format = 21;
    delete file.world.effects;
    delete file.world.cornerEffects;

    for (const [, rig] of file.world.rigs as [Id, OldRig][]) {
      delete rig.rounds;
      delete rig.deforms;
    }

    expect(through(file).world).toEqual(before.world);
  });

  test('a stand saved when its bevels were radii keeps them', () => {
    const before = world();
    const [id] = [...before.world.polygons.keys()];
    const corner = before.world.polygons.get(id)!.points[0].id;
    let w = wrote(before.world, 1, id, { kind: 'round', by: 4 });

    w = withRig(w, id, cornerRounded(rigOf(w, id), corner, 1, 3));
    w = keyed(w, 2, id, [once(handed(w, 2, id))]);

    const file = asOld(saved({ ...before, world: w }));
    let stands = 0;

    for (const [, rig] of file.world.rigs as [Id, OldRig][]) {
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
    expect(through(file).world).toEqual(w);
  });

  test('effects saved with segments, verticals and no jitter read with a precision, without verticals and with none', () => {
    const before = world();
    const [id] = [...before.world.polygons.keys()];
    const corner = before.world.polygons.get(id)!.points[0].id;
    const file = asOld(saved(before));

    file.world.effects = [[id, { round: { segments: 3, verticals: false }, deform: { spacing: 12, pattern: 'sine', seed: 0, sides: 'out' } }]] as never;
    file.world.cornerEffects = [[corner, { round: { segments: 1, verticals: true, off: true } }]] as never;

    const w = through(file).world;

    expect(w.effects.get(id)).toEqual({
      round: { precision: 0.5, tension: 0.5, chamfer: false },
      deform: { spacing: 12, pattern: 'sine', seed: 0, sides: 'out', jitter: 0 },
    });
    // A corner's own round is not a thing any more: a round is an opening and
    // an opening is a statement about the whole ring. An old file may carry
    // one, and it is dropped on the way in. See `World.cornerEffects`.
    expect(w.cornerEffects.get(corner)).toBe(undefined);
  });

  test('a 24 made a 25 is eroded, rounded and deformed where it was', () => {
    const [id] = [...world().world.polygons.keys()];

    // Scaled where it is made, so that its amounts are in the world at one
    // scale and in its own at another; eroded, rounded and deformed after.
    const made = (by: number) => {
      let w = wrote(world().world, 0, id, scaled(1.5, 1.5, { x: 50, y: 30 }));

      w = withEffect(w, id, 'deform', { ...REMEMBERED.deform, spacing: 12 * by, jitter: 0.5, seed: 4 });
      w = withEffect(w, id, 'round', REMEMBERED.round);

      return initialState(wrote(w, 1, id, { kind: 'deform', by: 2 * by }, { kind: 'erode', by: 3 * by }, { kind: 'round', by: 4 * by }));
    };

    const k = scaleAt(made(1).world, id, 0);

    expect(k).toBeCloseTo(1.5, 9);

    // A 24 held them in the world: its own lengths, `k` times over.
    const now = made(1);
    const out = relative({ ...saved(made(k)), format: 24 });

    if ('refused' in out) throw new Error(out.refused);

    const opened = restored(JSON.parse(JSON.stringify(out)) as Saved).world;
    const ring = (w: World, v: KeyframeId) => resolveAt(w, v).find(it => it.id === id)!.shape.flat();

    for (const v of [0, 1, 2]) {
      const want = ring(now.world, v), got = ring(opened, v);

      expect(got.length).toBe(want.length);
      got.forEach((p, i) => {
        expect(p.x).toBeCloseTo(want[i].x, 6);
        expect(p.y).toBeCloseTo(want[i].y, 6);
      });
    }
  });

  test('a 25 made a 26 has each kind as the parts it played', () => {
    const file = saved(world());
    const old: [string, number | undefined][] = [
      ['level', undefined],
      ['solid', undefined],
      ['floor', undefined],
      ['void', 1],
      ['void', 2],
      ['void', 3],
    ];
    const [first] = file.world.polygons;
    const polygons = old.map(([type, from], i) => [
      i + 1000,
      { ...first[1], level: undefined, floor: undefined, type, ...(from === undefined ? {} : { from }) },
    ]);
    const out = unmasked({ ...file, format: 25, world: { ...file.world, polygons } } as unknown as Saved);

    if ('refused' in out) throw new Error(out.refused);

    expect(out.format).toBe(26);
    expect(out.world.polygons.map(([, p]) => ({ level: p.level, floor: p.floor, type: 'type' in p }))).toEqual([
      { level: 'hollow', floor: undefined, type: false },
      { level: 'solid', floor: undefined, type: false },
      { level: undefined, floor: 'floor', type: false },
      { level: 'void', floor: undefined, type: false },
      { level: undefined, floor: 'void', type: false },
      { level: 'void', floor: 'void', type: false },
    ]);
    expect(unmasked({ ...file, format: 24 })).toEqual({ refused: expect.stringContaining('format 24') });
  });

  test('a format this does not take is refused rather than half-read', () => {
    expect(converted({ ...asOld(saved(world())), format: 19 })).toEqual({ refused: expect.stringContaining('format 19') });
    expect(converted({ ...asOld(saved(world())), format: 24 })).toEqual({ refused: expect.stringContaining('format 24') });
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

    const file = asOld(saved({
      ...before,
      world: { ...before.world, rigs: new Map([[id, keysOf(rig)]]) },
    }));

    // As 20 wrote them: no `lean`, and no `skew` in a stand's frame.
    file.format = 20;

    for (const [, mine] of file.world.rigs as [Id, OldRig][]) {
      for (const [, list] of mine.keys) {
        for (const e of list) {
          delete (e.op as { lean?: number }).lean;
          if (e.op.kind === 'stand') delete (e.op.frame as { skew?: number }).skew;
        }
      }
    }

    expect(through(file).world.rigs.get(id)).toEqual(keysOf(rig));
  });});
