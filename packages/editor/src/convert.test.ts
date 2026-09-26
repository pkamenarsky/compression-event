// -----------------------------------------------------------------------------
// Files from before keys
//
// What `convert.ts` takes and what it leaves behind: a 20 to a 27 are read
// here and nowhere else, and what comes out is a 28 that `save.ts` opens like
// any other.
// -----------------------------------------------------------------------------

import { describe, expect, test } from 'vitest';
import { Point } from '@ce/game/world';
import { Old, OldEntry, OldRig, Saved27, SavedKey27, converted, layered, relative, uncornered, unmasked } from './convert';
import { Saved, SavedKey, restored, restoredKeyRig, saved } from './save';
import { AmountKind, Entry, KeyframeId, Op, Rig, entriesOf, keysOf } from './rig';
import { TOP, addPolygon, grouped, handed, keyed, resolveAt, scaleAt } from './scene';
import { withEffect } from './effects';
import { once } from './rig';
import { EditorState, Id, LayerId, PolygonKind, REMEMBERED, VertexId, World, emptyWorld, initialState } from './types';
import { amountAt, deform, erode, round, scaled, wrote } from './testing';

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
  const out = JSON.parse(JSON.stringify(as27(file))) as unknown as Old;
  const kinds = kindsIn(file);

  out.format = 23;
  out.world.rigs = file.world.rigs.map(([id, rig]) => [
    id,
    savedOldRig(entriesOf(restoredKeyRig(rig)), kinds),
  ]);

  return JSON.parse(JSON.stringify(out)) as Old;
}

/** Which kind each layer in a file is. */
function kindsIn(file: Saved): Map<LayerId, AmountKind> {
  return new Map(file.world.effects.flatMap(([, list]) => list.map(l => [l.id, l.kind] as const)));
}

/** A 28 written out as a 27: its lists as records, one of each, and its
 * amounts by name. What the older formats here start from. */
function as27(file: Saved): Saved27 {
  const kinds = kindsIn(file);
  const three = (pairs: [LayerId, number][] | undefined) => {
    const out = { erode: 0, round: 0, deform: 0 };

    for (const [layer, by] of pairs ?? []) out[kinds.get(layer)!] += by;

    return out;
  };
  const key = (k: SavedKey): SavedKey27 => {
    const { by, stand, ...rest } = k;
    const out: SavedKey27 = { ...rest };

    if (by !== undefined) {
      const { amounts, ...d } = by;

      out.by = { ...d, ...three(amounts) };
    }

    if (stand !== undefined) {
      const { amounts, ...st } = stand;
      const t = three(amounts);

      out.stand = { ...st, erosion: t.erode, bevel: t.round, amplitude: t.deform };
    }

    return out;
  };

  return {
    ...file,
    format: 27,
    world: {
      ...file.world,
      rigs: file.world.rigs.map(([id, rig]) => [id, { keys: rig.keys.map(([at, list]) => [at, list.map(key)]) }]),
      effects: file.world.effects.map(([id, list]) => [id, Object.fromEntries(list.map(({ id: _id, kind, ...o }) => [kind, o]))]),
    },
  };
}

/** A timeline of entries as a 23 wrote it. */
function savedOldRig(rig: Rig, kinds: Map<LayerId, AmountKind>): OldRig {
  const corners = (m: ReadonlyMap<VertexId, ReadonlyMap<KeyframeId, Entry>>): [VertexId, [KeyframeId, OldEntry][]][] =>
    [...m].map(([c, map]) => [c, [...map].map(([k, e]) => [k, savedOldEntry(e, kinds)])]);

  return {
    keys: [...rig.keys].map(([k, list]) => [k, list.map(e => savedOldEntry(e, kinds))]),
    nudges: corners(rig.nudges),
    depths: [],
    rounds: [],
    deforms: [],
  };
}

function savedOldEntry(e: Entry, kinds: Map<LayerId, AmountKind>): OldEntry {
  const of = (a: ReadonlyMap<LayerId, number>, kind: AmountKind) =>
    [...a].filter(([layer]) => kinds.get(layer) === kind).reduce((n, [, by]) => n + by, 0);
  const op = e.op.kind === 'stand'
    ? {
        kind: 'stand' as const,
        frame: e.op.frame,
        erosion: of(e.op.amounts, 'erode'),
        corners: [...e.op.corners],
        depths: [],
        bevel: of(e.op.amounts, 'round'),
        amplitude: of(e.op.amounts, 'deform'),
        bevels: [],
        amplitudes: [],
      }
    : e.op.kind === 'amount'
      ? { kind: kinds.get(e.op.layer)!, by: e.op.by }
      : e.op;

  const out: OldEntry = { op, times: e.times };

  return e.gesture === undefined ? out : { ...out, gesture: e.gesture };
}

/** A file taken through the converter and opened. */
function through(file: Old): EditorState {
  const keyed = converted(file);

  if ('refused' in keyed) throw new Error(keyed.refused);

  const out = relative(JSON.parse(JSON.stringify(keyed)) as Saved27);

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
    let w = wrote(before.world, 1, id, round(4));

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

    // Against the same world taken across as a 27, since a converted file's
    // layers take new ids.
    const now = layered(as27(saved({ ...before, world: w })));

    if ('refused' in now) throw new Error(now.refused);

    expect(stands).toBeGreaterThan(0);
    expect(through(file).world).toEqual(restored(JSON.parse(JSON.stringify(now)) as Saved).world);
  });

  test('effects saved with segments, verticals and no jitter read with a precision, without verticals and with none', () => {
    const before = world();
    const [id] = [...before.world.polygons.keys()];
    const corner = before.world.polygons.get(id)!.points[0].id;
    const file = asOld(saved(before));

    file.world.effects = [[id, { round: { segments: 3, verticals: false }, deform: { spacing: 12, pattern: 'sine', seed: 0, sides: 'out' } }]] as never;
    file.world.cornerEffects = [[corner, { round: { segments: 1, verticals: true, off: true } }]] as never;

    const w = through(file).world;

    expect(w.effects.get(id)).toEqual([
      { id: expect.any(Number), kind: 'round', precision: 0.5, tension: 0.5, chamfer: false },
      { id: expect.any(Number), kind: 'deform', spacing: 12, pattern: 'sine', seed: 0, sides: 'out', jitter: 0 },
    ]);
    // A corner's own effects are not a thing any more: an effect is one
    // amount over its whole ring. An old file may carry them, and they are
    // dropped on the way in. See `uncornered`.
    expect('cornerEffects' in w).toBe(false);
  });

  test('a 24 made a 25 is eroded, rounded and deformed where it was', () => {
    const [id] = [...world().world.polygons.keys()];

    // Scaled where it is made, so that its amounts are in the world at one
    // scale and in its own at another; eroded, rounded and deformed after.
    const made = (by: number) => {
      let w = wrote(world().world, 0, id, scaled(1.5, 1.5, { x: 50, y: 30 }));

      w = withEffect(w, id, 'deform', { ...REMEMBERED.deform, spacing: 12 * by, jitter: 0.5, seed: 4 });
      w = withEffect(w, id, 'round', REMEMBERED.round);

      return initialState(wrote(w, 1, id, deform(2 * by), erode(3 * by), round(4 * by)));
    };

    const k = scaleAt(made(1).world, id, 0);

    expect(k).toBeCloseTo(1.5, 9);

    // A 24 held them in the world: its own lengths, `k` times over.
    const now = made(1);
    const out = relative({ ...as27(saved(made(k))), format: 24 });

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
    const file = as27(saved(world()));
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
    const out = unmasked({ ...file, format: 25, world: { ...file.world, polygons } } as unknown as Saved27);

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

  test('a 26 made a 27 has its effects on single corners and edges dropped, and nothing else', () => {
    const file = as27(saved(world()));
    const [id] = [...world().world.polygons.keys()];
    const corner = world().world.polygons.get(id)!.points[0].id;
    const deform = { ...REMEMBERED.deform, spacing: 9 };
    const stand = {
      kind: 'stand', frame: { t: { x: 0, y: 0 }, angle: 0, skew: 0, scale: { x: 1, y: 1 } }, erosion: 1,
      corners: [], depths: [[corner, 2]], bevel: 3, amplitude: 4, bevels: [[corner, 5]], amplitudes: [],
    };
    const cornered = (keyed: boolean) => ({
      ...file,
      format: 26,
      world: {
        ...file.world,
        rigs: [[id, { keys: [[1, [
          { id: 0, ref: { x: 0, y: 0 }, times: 1, stand },
          { id: 1, ref: { x: 0, y: 0 }, times: 1, corners: [[corner, { x: 1, y: 0 }]], ...(keyed ? { depths: [[corner, 2]] } : {}) },
        ]]] }]],
        cornerEffects: keyed ? [[corner, { deform }]] : [],
      },
      baked: 'bake',
    }) as unknown as Saved27;

    const out = uncornered(cornered(true));

    if ('refused' in out) throw new Error(out.refused);

    expect(out.format).toBe(27);
    expect('cornerEffects' in out.world).toBe(false);
    const { depths: _depths, bevels: _bevels, amplitudes: _amplitudes, ...kept } = stand;

    expect(JSON.parse(JSON.stringify(out.world.rigs))).toStrictEqual([[id, { keys: [[1, [
      { id: 0, ref: { x: 0, y: 0 }, times: 1, stand: kept },
      { id: 1, ref: { x: 0, y: 0 }, times: 1, corners: [[corner, { x: 1, y: 0 }]] },
    ]]] }]]);

    // The drawing changes where anything was dropped, so the bake goes with
    // it; where nothing was, it stays.
    expect(out.baked).toBe(undefined);

    const clean = uncornered({ ...cornered(false), world: { ...cornered(false).world, rigs: file.world.rigs } } as Saved27);

    if ('refused' in clean) throw new Error(clean.refused);

    expect(clean.baked).toBe('bake');
    expect(uncornered({ ...file, format: 25 })).toEqual({ refused: expect.stringContaining('format 25') });

    // And the editor opens it.
    const now = layered(out);

    if ('refused' in now) throw new Error(now.refused);

    expect(restored(JSON.parse(JSON.stringify(now)) as Saved).world.rigs.get(id)!.keys.get(1)!.length).toBe(2);
  });

  test('a 27 made a 28 has its effects as layers in the order they were laid, its amounts on them, and draws the same', () => {
    const before = world();
    const [id, other] = [...before.world.polygons.keys()];
    let w = withEffect(before.world, id, 'deform', { ...REMEMBERED.deform, spacing: 12 });

    w = withEffect(w, id, 'round', REMEMBERED.round);
    w = wrote(w, 1, id, deform(2), erode(3), round(4));
    w = wrote(w, 1, other, erode(5));
    w = keyed(w, 2, id, [once(handed(w, 2, id))]);

    const file = as27(saved({ ...before, world: w }));
    const out = layered(file);

    if ('refused' in out) throw new Error(out.refused);

    expect(out.format).toBe(28);

    const opened = restored(JSON.parse(JSON.stringify(out)) as Saved).world;

    // Erode, round, deform, whatever order they were written in; and an
    // erosion with no effect record to it still has a layer to be on.
    expect(opened.effects.get(id)!.map(l => l.kind)).toEqual(['erode', 'round', 'deform']);
    expect(opened.effects.get(other)!.map(l => l.kind)).toEqual(['erode']);
    expect(new Set([...opened.effects.values()].flat().map(l => l.id)).size).toBe(4);
    expect(opened.nextId).toBe(file.world.nextId + 4);

    for (const v of [0, 1, 2, 3]) {
      for (const kind of ['erode', 'round', 'deform'] as const) {
        expect(amountAt(opened, id, v, kind), `v${v} ${kind}`).toBe(amountAt(w, id, v, kind));
      }

      expect(resolveAt(opened, v).map(it => it.shape)).toEqual(resolveAt(w, v).map(it => it.shape));
    }

    // Nothing else is touched, the bake included.
    expect(layered({ ...file, baked: 'bake' } as Saved27)).toMatchObject({ baked: 'bake' });
    expect(layered({ ...file, format: 26 })).toEqual({ refused: expect.stringContaining('format 26') });
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
          corners: new Map(),
          amounts: new Map(),
        }),
      ]]]),
      nudges: new Map(),
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
