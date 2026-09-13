import { describe, expect, test } from 'vitest';
import { Point } from '@ce/game/world';
import { Affine, compose, place, unplace } from './affine';
import {
  EMPTY_RIG,
  Entry,
  Frame,
  Keyframe,
  KeyframeId,
  Move,
  Op,
  REST,
  Rig,
  Timeline,
  affineOf,
  appending,
  deepened,
  framed,
  nudged,
  once,
  placed,
  played,
  playedAt,
  repeating,
  sheared,
  spun,
  stateAt,
  unsheared,
  withKeys,
  worldFrame,
} from './rig';
import { Id, Vertex } from './types';

const KEYFRAMES: Keyframe[] = Array.from({ length: 6 }, (_unused, i) => ({
  id: i,
  name: `v${i}`,
  visible: true,
}));

/** A square's corners, ids off the polygon's own. */
function square(id: Id, x: number, y: number, size: number, birth: KeyframeId = 0): Vertex[] {
  return [
    { x, y },
    { x: x + size, y },
    { x: x + size, y: y + size },
    { x, y: y + size },
  ].map((at, i) => ({ id: id * 100 + i, at, ring: 0, birth, death: null }));
}

function empty(): Timeline {
  return {
    keyframes: KEYFRAMES,
    rigs: new Map(),
    polygons: new Map(),
    groups: new Map(),
    artefacts: new Map(),
    paths: new Map(),
  };
}

function withSquare(tl: Timeline, id: Id, x: number, y: number, size = 10, birth: KeyframeId = 0): Timeline {
  const polygons = new Map(tl.polygons);

  polygons.set(id, { birth, points: square(id, x, y, size, birth) });

  return { ...tl, polygons };
}

function withGroup(tl: Timeline, id: Id, members: Id[]): Timeline {
  const groups = new Map(tl.groups);

  groups.set(id, { members });

  return { ...tl, groups };
}

function rigOf(tl: Timeline, id: Id): Rig {
  return tl.rigs.get(id) ?? EMPTY_RIG;
}

function rigged(tl: Timeline, id: Id, rig: Rig): Timeline {
  const rigs = new Map(tl.rigs);

  rigs.set(id, rig);

  return { ...tl, rigs };
}

/** `k`'s list for `id`, written outright. Bare operations happen once. */
function keyed(tl: Timeline, k: KeyframeId, id: Id, list: (Op | Entry)[]): Timeline {
  const entries = list.map(e => ('op' in e ? e : once(e)));

  return rigged(tl, id, withKeys(rigOf(tl, id), k, entries));
}

const move = (x: number, y: number): Op => ({ kind: 'move', by: { x, y } });

const turn = (degrees: number, ref: Point, about: Point = { x: 0, y: 0 }): Op => ({
  kind: 'turn',
  angle: degrees * Math.PI / 180,
  ref,
  about,
});

const erode = (by: number): Op => ({ kind: 'erode', by });

/**
 * A scale about `c` as the gesture writes it: `by` along the thing's axes, which
 * stand at `along`, with `p` where its painted point is.
 */
function scaleAbout(by: Point, ref: Point, p: Point, c: Point, along = 0): Op {
  const w = spun({ x: c.x - p.x, y: c.y - p.y }, -along);

  return {
    kind: 'scale',
    by,
    ref,
    shift: spun({ x: (1 - by.x) * w.x, y: (1 - by.y) * w.y }, along),
    along,
    lean: 0,
  };
}

/** A turn about `c` as the gesture writes it. */
function turnAbout(degrees: number, ref: Point, p: Point, c: Point): Op {
  return turn(degrees, ref, { x: c.x - p.x, y: c.y - p.y });
}

function near(p: Point, q: Point, digits = 9): void {
  expect(p.x).toBeCloseTo(q.x, digits);
  expect(p.y).toBeCloseTo(q.y, digits);
}

function rotated(p: Point, degrees: number, about: Point = { x: 0, y: 0 }): Point {
  const d = spun({ x: p.x - about.x, y: p.y - about.y }, degrees * Math.PI / 180);

  return { x: about.x + d.x, y: about.y + d.y };
}

function at(m: Affine, p: Point): Point {
  return place(m, [p])[0];
}

/** Where the painted point of `id` is at `k`, in its holder's frame. */
function refAt(tl: Timeline, id: Id, k: KeyframeId, ref: Point): Point {
  return placed(stateAt(tl, id, k).frame, ref);
}

const P = 1, Q = 2, G = 10, H = 11;

// A room off to the side of the origin, so that anything turning about the
// origin is visibly not turning about the room.
const room = withSquare(empty(), P, 100, 0);
const MIDDLE = { x: 105, y: 5 };
const ORIGIN = { x: 0, y: 0 };

describe('upstream edits carry downstream as they were seen', () => {
  // The room turned a quarter about the origin at v1, which is a turn about a
  // point other than its own middle: a selection's centre, say.
  const turned = keyed(room, 1, P, [turnAbout(90, MIDDLE, MIDDLE, ORIGIN)]);

  test('a move at v0 is carried unturned past a turn at v1', () => {
    const moved = keyed(turned, 0, P, [move(50, 0)]);

    for (const corner of square(P, 100, 0, 10)) {
      const was = at(worldFrame(turned, P, 1), corner.at);

      near(at(worldFrame(moved, P, 1), corner.at), { x: was.x + 50, y: was.y });
    }
  });

  test('a spin in place at v0 leaves a turn at v1 where it was', () => {
    const spun = keyed(turned, 0, P, [turn(30, MIDDLE)]);

    near(refAt(spun, P, 1, MIDDLE), refAt(turned, P, 1, MIDDLE));
    near(refAt(spun, P, 1, MIDDLE), rotated(MIDDLE, 90));

    // The room itself is turned the thirty degrees further, and only that.
    expect(stateAt(spun, P, 1).frame.angle - stateAt(turned, P, 1).frame.angle)
      .toBeCloseTo(Math.PI / 6, 12);
  });

  test('and leaves a non-uniform selection scale at v1 where it was', () => {
    const scaled = keyed(room, 1, P, [scaleAbout({ x: 2, y: 0.5 }, MIDDLE, MIDDLE, ORIGIN)]);
    const spun = keyed(scaled, 0, P, [turn(30, MIDDLE)]);

    near(refAt(spun, P, 1, MIDDLE), refAt(scaled, P, 1, MIDDLE));

    // Where scaling about the origin puts the middle.
    near(refAt(scaled, P, 1, MIDDLE), { x: 210, y: 2.5 });
  });

  test('corners added and taken away upstream leave a turn downstream alone', () => {
    const polygons = new Map(turned.polygons);
    const points = [...square(P, 100, 0, 10)];

    // A corner well off the square, which moves its box and its middle.
    points.splice(1, 0, { id: 199, at: { x: 130, y: -20 }, ring: 0, birth: 0, death: null });
    points[2] = { ...points[2], death: 0 };
    polygons.set(P, { birth: 0, points });

    const reshaped = { ...turned, polygons };

    expect(worldFrame(reshaped, P, 1)).toEqual(worldFrame(turned, P, 1));
    expect([...stateAt(reshaped, P, 1).corners.keys()]).toEqual([100, 199, 102, 103]);
  });
});

describe('groups', () => {
  // Two rooms held together, one of which is gone from v1 on.
  const pair = withGroup(withSquare(withSquare(empty(), P, 0, 0), Q, 100, 0), G, [P, Q]);
  const BOTH = { x: 55, y: 5 };
  const LEFT = { x: 5, y: 5 };

  test('a group down to one member turns about that one from then on', () => {
    // A quarter turn of the whole group about its middle at v0, while both
    // rooms were in it.
    let tl = keyed(pair, 0, G, [turn(90, BOTH)]);

    // At v1 its middle is the one room left, which is where a turn of the
    // group written there is painted.
    const left = at(worldFrame(tl, P, 1), LEFT);
    const ref = unplace(worldFrame(tl, G, 1), left);

    tl = keyed(tl, 1, G, [turn(90, ref)]);

    // And the room's own spin in place at v2.
    tl = keyed(tl, 2, P, [turn(45, LEFT)]);

    near(at(worldFrame(tl, P, 1), LEFT), left);
    near(at(worldFrame(tl, P, 2), LEFT), left);

    // The v0 turn took the left room round the pair's middle.
    near(left, rotated(LEFT, 90, BOTH));
  });

  test('nested groups compose, innermost first', () => {
    let tl = withGroup(withGroup(withSquare(empty(), P, 0, 0), H, [P]), G, [H]);

    tl = keyed(tl, 0, G, [move(10, 0)]);
    tl = keyed(tl, 1, H, [turn(90, ORIGIN)]);
    tl = keyed(tl, 1, P, [move(0, 5)]);

    // P moves down five inside H, H turns a quarter about its own origin, and
    // G carries the lot ten to the right.
    near(at(worldFrame(tl, P, 1), { x: 1, y: 0 }), { x: 10 - 5, y: 1 });
  });
});

describe('frames', () => {
  test('a scale along the thing\'s own axes after a turn is not a shear', () => {
    let tl = keyed(room, 0, P, [turn(30, MIDDLE)]);

    tl = keyed(tl, 1, P, [scaleAbout({ x: 2, y: 1 }, MIDDLE, MIDDLE, MIDDLE, Math.PI / 6)]);

    const m = worldFrame(tl, P, 1);

    expect(m.a * m.c + m.b * m.d).toBeCloseTo(0, 12);
    expect(Math.hypot(m.a, m.b)).toBeCloseTo(2, 12);
    expect(Math.hypot(m.c, m.d)).toBeCloseTo(1, 12);
    expect(framed(m)).not.toBeNull();
  });

  test('a frame read back off its matrix is itself', () => {
    const f: Frame = { t: { x: 3, y: -4 }, angle: 1.2, skew: 0, scale: { x: 2, y: 0.5 } };
    const back = framed(affineOf(f))!;

    near(back.t, f.t, 12);
    expect(back.angle).toBeCloseTo(f.angle, 12);
    near(back.scale, f.scale, 12);
  });

  test('a sheared matrix is a frame, exactly', () => {
    const m: Affine = { a: 1.3, b: 0.4, c: 0.9, d: 1.7, tx: 5, ty: -2 };
    const f = framed(m)!;
    const back = affineOf(f);

    expect(Math.abs(f.skew)).toBeGreaterThan(0.1);

    for (const k of ['a', 'b', 'c', 'd', 'tx', 'ty'] as const) expect(back[k]).toBeCloseTo(m[k], 12);
  });

  test('a mirrored matrix is not', () => {
    expect(framed({ a: 1, b: 0, c: 0, d: -1, tx: 0, ty: 0 })).toBeNull();
  });
});

describe('a keyframe\'s list', () => {
  const r = MIDDLE;
  const first = once(turnAbout(30, r, r, ORIGIN));

  test('turns about different centres are kept apart', () => {
    const second = once(turnAbout(30, r, rotated(r, 30), { x: 50, y: 50 }));

    expect(appending([first], second)).toHaveLength(2);
  });

  test('turns about the same centre are one entry, and it is exact', () => {
    // The second is written where the first left the room: its painted point
    // has gone round with it, so its offset from the centre has too.
    const after = rotated(r, 30);
    const second = once(turnAbout(45, r, after, ORIGIN));
    const list = appending([first], second);

    expect(list).toHaveLength(1);
    expect(list[0].op).toEqual({ ...first.op, angle: expect.closeTo(75 * Math.PI / 180, 12) });

    const apart = keyed(room, 0, P, [first, second]);
    const together = keyed(room, 0, P, [...list]);

    near(refAt(together, P, 0, r), refAt(apart, P, 0, r));
    near(refAt(together, P, 0, r), rotated(r, 75));
  });

  test('a turn that comes back to nothing goes', () => {
    const back = once(turnAbout(-30, r, rotated(r, 30), ORIGIN));

    expect(appending([first], back)).toEqual([]);
  });

  test('two moves add, and two scales about one point are one scale', () => {
    expect(appending([once(move(1, 2))], once(move(3, 4)))).toEqual([once(move(4, 6))]);

    const one = once(scaleAbout({ x: 2, y: 3 }, r, r, ORIGIN));
    const p = refAt(keyed(room, 0, P, [one]), P, 0, r);
    const two = once(scaleAbout({ x: 0.5, y: 2 }, r, p, ORIGIN));
    const list = appending([one], two);

    expect(list).toHaveLength(1);

    const apart = keyed(room, 0, P, [one, two]);
    const together = keyed(room, 0, P, [...list]);

    near(refAt(together, P, 0, r), refAt(apart, P, 0, r));
    near(refAt(together, P, 0, r), { x: 105, y: 30 });
  });

  test('a gesture that does nothing writes nothing', () => {
    const list = [first];

    expect(appending(list, once(move(0, 0)))).toBe(list);
  });

  test('dropping one entry leaves the rest as it would have been alone', () => {
    const both = keyed(room, 0, P, [move(0, 50), turnAbout(90, r, { x: 105, y: 55 }, ORIGIN)]);
    const alone = keyed(room, 0, P, [turnAbout(90, r, r, ORIGIN)]);

    // The turn was written with the move under it, so its offset is from where
    // the move had put the room. Without the move it still turns about the
    // point it was aimed at, less the move.
    near(refAt(both, P, 0, r), rotated({ x: 105, y: 55 }, 90));

    const dropped = keyed(both, 0, P, [both.rigs.get(P)!.keys.get(0)![1]]);

    near(refAt(dropped, P, 0, r), rotated(r, 90, { x: 0, y: -50 }));
    expect(refAt(alone, P, 0, r)).not.toEqual(refAt(dropped, P, 0, r));
  });
});

describe('repeats', () => {
  const r = MIDDLE;

  test('a repeated turn orbits one centre', () => {
    const tl = keyed(room, 0, P, [repeating(turnAbout(30, r, r, ORIGIN), null)]);

    for (let k = 0; k < KEYFRAMES.length; k++) {
      near(refAt(tl, P, k, r), rotated(r, 30 * (k + 1)));
    }
  });

  test('a repeated scale spreads from one centre', () => {
    const tl = keyed(room, 0, P, [repeating(scaleAbout({ x: 2, y: 2 }, r, r, ORIGIN), null)]);

    for (let k = 0; k < KEYFRAMES.length; k++) {
      const f = 2 ** (k + 1);

      near(refAt(tl, P, k, r), { x: 105 * f, y: 5 * f }, 6);
      expect(stateAt(tl, P, k).frame.scale.x).toBeCloseTo(f, 12);
    }
  });

  test('a non-uniform repeated scale on turned axes keeps its centre', () => {
    const along = Math.PI / 5;
    let tl = keyed(room, 0, P, [turn(36, r)]);

    tl = keyed(tl, 1, P, [repeating(scaleAbout({ x: 1.5, y: 0.75 }, r, r, ORIGIN, along), 3)]);

    const f = affineOf(stateAt(tl, P, 3).frame);

    // The centre the scale was aimed at goes nowhere, at every step.
    for (let k = 1; k <= 3; k++) {
      const before = affineOf(stateAt(tl, P, k - 1).frame);
      const now = affineOf(stateAt(tl, P, k).frame);

      near(at(now, unplace(before, ORIGIN)), ORIGIN, 9);
    }

    expect(framed(f)).not.toBeNull();
  });

  test('a skipped keyframe is left out and not counted', () => {
    const tl = keyed(room, 0, P, [repeating(turnAbout(30, r, r, ORIGIN), null, new Set([2]))]);

    near(refAt(tl, P, 1, r), rotated(r, 60));
    near(refAt(tl, P, 2, r), rotated(r, 60));
    near(refAt(tl, P, 3, r), rotated(r, 90));
  });

  test('a repeat stops after its count', () => {
    const tl = keyed(room, 0, P, [repeating(move(10, 0), 3)]);

    expect(stateAt(tl, P, 2).frame.t).toEqual({ x: 30, y: 0 });
    expect(stateAt(tl, P, 5).frame.t).toEqual({ x: 30, y: 0 });
  });

  test('a move by hand part way through carries the centre along', () => {
    let tl = keyed(room, 0, P, [repeating(turnAbout(30, r, r, ORIGIN), null)]);

    tl = keyed(tl, 2, P, [move(0, 50)]);

    const was = refAt(tl, P, 2, r);

    near(refAt(tl, P, 3, r), rotated(was, 30, { x: 0, y: 50 }));
    near(refAt(tl, P, 4, r), rotated(was, 60, { x: 0, y: 50 }));
  });

  test('a spin in place part way through leaves the centre alone', () => {
    let tl = keyed(room, 0, P, [repeating(turnAbout(30, r, r, ORIGIN), null)]);
    const plain = tl;

    tl = keyed(tl, 2, P, [turn(15, r)]);

    near(refAt(tl, P, 4, r), refAt(plain, P, 4, r));
  });

  test('stacked erosion', () => {
    const tl = keyed(room, 1, P, [repeating(erode(5), null)]);

    expect([0, 1, 2, 3].map(k => stateAt(tl, P, k).erosion)).toEqual([0, 5, 10, 15]);
  });

  test('what a keyframe plays is the keyframe before carried to it', () => {
    let tl = keyed(room, 0, P, [repeating(turnAbout(30, r, r, ORIGIN), null), move(3, 4)]);

    tl = keyed(tl, 2, P, [scaleAbout({ x: 2, y: 1 }, r, refAt(tl, P, 1, r), { x: 7, y: 7 }), turn(10, r)]);

    for (let k = 1; k < KEYFRAMES.length; k++) {
      const f = playedAt(tl, P, k).reduce((f, op) => played(f, op), stateAt(tl, P, k - 1).frame);

      expect(f).toEqual(stateAt(tl, P, k).frame);
    }

    // The repeat's steps come first, then the keyframe's own.
    expect(playedAt(tl, P, 2).map(op => op.kind)).toEqual(['turn', 'scale', 'turn']);
  });
});

describe('birth', () => {
  test('something born part way is at rest before it, and walks from there', () => {
    let tl = withSquare(empty(), P, 0, 0, 10, 2);

    tl = keyed(tl, 2, P, [move(5, 0)]);

    expect(stateAt(tl, P, 1).frame).toEqual(REST);
    expect(stateAt(tl, P, 1).corners.size).toBe(0);
    expect(stateAt(tl, P, 2).frame.t).toEqual({ x: 5, y: 0 });
    expect(stateAt(tl, P, 2).corners.size).toBe(4);
  });
});

describe('corners', () => {
  test('a nudge is in the rest frame, and repeats like anything else', () => {
    let rig = nudged(EMPTY_RIG, 101, 1, { x: 2, y: 0 });

    rig = { ...rig, nudges: new Map([[101, new Map([[1, { ...rig.nudges.get(101)!.get(1)!, times: 2 }]])]]) };

    const tl = rigged(room, P, rig);

    expect(stateAt(tl, P, 0).corners.get(101)).toEqual({ x: 110, y: 0 });
    expect(stateAt(tl, P, 1).corners.get(101)).toEqual({ x: 112, y: 0 });
    expect(stateAt(tl, P, 4).corners.get(101)).toEqual({ x: 114, y: 0 });
  });

  test('a nudge that comes back to nothing is taken out', () => {
    const rig = nudged(nudged(EMPTY_RIG, 101, 1, { x: 2, y: 0 }), 101, 1, { x: -2, y: 0 });

    expect(rig.nudges.size).toBe(0);
  });

  test('depths add up on single corners', () => {
    const rig = deepened(deepened(EMPTY_RIG, 102, 0, 3), 102, 2, 1);
    const tl = rigged(room, P, rig);

    expect(stateAt(tl, P, 1).depths.get(102)).toBe(3);
    expect(stateAt(tl, P, 2).depths.get(102)).toBe(4);
    expect(stateAt(tl, P, 2).depths.has(101)).toBe(false);
  });
});

describe('stands', () => {
  const r = MIDDLE;
  const held: Frame = { t: { x: 7, y: 8 }, angle: 0.5, skew: 0, scale: { x: 1, y: 2 } };

  const stand: Op = {
    kind: 'stand',
    frame: held,
    erosion: 4,
    corners: new Map([[100, { x: 0, y: 0 }], [101, { x: 20, y: 0 }], [102, { x: 20, y: 20 }]]),
    depths: new Map([[101, 1]]),
  };

  test('a stand is what it says, and upstream stops being heard', () => {
    let tl = keyed(room, 0, P, [move(20, 0), erode(2)]);

    tl = keyed(tl, 3, P, [stand, move(1, 0)]);

    expect(stateAt(tl, P, 3).frame).toEqual({ ...held, t: { x: 8, y: 8 } });
    expect(stateAt(tl, P, 4).frame).toEqual({ ...held, t: { x: 8, y: 8 } });
    expect(stateAt(tl, P, 4).erosion).toBe(4);

    const edited = keyed(tl, 0, P, [move(500, 500), erode(7)]);

    expect(stateAt(edited, P, 4)).toEqual(stateAt(tl, P, 4));
  });

  test('a repeat begun before a stand goes on stepping after it', () => {
    let tl = keyed(room, 0, P, [repeating(move(10, 0), null), repeating(erode(1), null)]);

    tl = keyed(tl, 3, P, [stand]);

    expect(stateAt(tl, P, 3).frame).toEqual(held);
    expect(stateAt(tl, P, 5).frame.t).toEqual({ x: 27, y: 8 });
    expect(stateAt(tl, P, 5).erosion).toBe(6);
  });

  test('so does a corner\'s, from what the stand holds', () => {
    let rig = nudged(EMPTY_RIG, 101, 0, { x: 1, y: 0 });

    rig = { ...rig, nudges: new Map([[101, new Map([[0, repeating(move(1, 0) as Move, null)]])]]) };

    let tl = rigged(room, P, rig);

    tl = keyed(tl, 3, P, [stand]);

    expect(stateAt(tl, P, 3).corners.get(101)).toEqual({ x: 20, y: 0 });
    expect(stateAt(tl, P, 5).corners.get(101)).toEqual({ x: 22, y: 0 });
  });

  test('corners come from the stand, and nudges from before it do not reach past it', () => {
    let rig = nudged(EMPTY_RIG, 100, 0, { x: 5, y: 5 });

    rig = nudged(rig, 101, 3, { x: 1, y: 0 });
    rig = deepened(rig, 102, 0, 9);

    let tl = rigged(room, P, rig);

    tl = keyed(tl, 3, P, [stand]);

    expect(stateAt(tl, P, 2).corners.get(100)).toEqual({ x: 105, y: 5 });
    expect([...stateAt(tl, P, 3).corners]).toEqual([
      [100, { x: 0, y: 0 }],
      [101, { x: 21, y: 0 }],
      [102, { x: 20, y: 20 }],
    ]);
    expect([...stateAt(tl, P, 3).depths]).toEqual([[101, 1]]);
  });
});

describe('playing part of an operation', () => {
  const f: Frame = { t: { x: 3, y: -2 }, angle: 0.4, skew: 0, scale: { x: 1.5, y: 0.5 } };
  const r = { x: 1, y: 1 };
  const c = { x: 10, y: -7 };
  const p = placed(f, r);

  const ops: Op[] = [
    move(4, 5),
    turnAbout(170, r, p, c),
    scaleAbout({ x: 3, y: 0.25 }, r, p, c, f.angle),
    { kind: 'stand', frame: REST, erosion: 0, corners: new Map(), depths: new Map() },
  ];

  test('none of it is where it started, and all of it is exactly the whole', () => {
    for (const op of ops) {
      const none = played(f, op, 0);

      near(none.t, f.t, 12);
      expect(none.angle).toBeCloseTo(f.angle, 12);
      near(none.scale, f.scale, 12);
      expect(played(f, op, 1)).toEqual(played(f, op));
    }
  });

  test('a turn goes round its centre, and a scale holds its centre still', () => {
    for (const op of ops.slice(1, 3)) {
      for (const u of [0.1, 0.5, 0.9]) {
        const now = affineOf(played(f, op, u));

        near(at(now, unplace(affineOf(f), c)), c, 9);
      }
    }
  });

  test('a turn of more than a whole one plays as more than a whole one', () => {
    const twice = turn(720, r);

    expect(played(f, twice, 0.25).angle).toBeCloseTo(f.angle + Math.PI, 12);
    near(placed(played(f, twice, 0.25), r), p, 9);
  });
});

describe('skew', () => {
  const f: Frame = { t: { x: 3, y: -4 }, angle: 0.7, skew: 0.2, scale: { x: 2, y: 0.5 } };
  const r = { x: 1, y: 2 };

  const skew = (by: number, shift: Point = ORIGIN): Op => ({ kind: 'skew', by, ref: r, shift });

  /** A frame's linear part. */
  const linear = (g: Frame): Affine => ({ ...affineOf(g), tx: 0, ty: 0 });

  test('a skew shears along the thing\'s first axis about the painted point', () => {
    const g = played(f, skew(0.5));

    near(placed(g, r), placed(f, r), 12);
    expect(g.skew).toBeCloseTo(0.7, 12);

    // `R · K(by) · R⁻¹`, the shear along the first axis as it lies, over what
    // the frame did before.
    const along = compose(
      compose(affineOf({ ...REST, angle: f.angle, skew: 0.5 }), affineOf({ ...REST, angle: -f.angle })),
      linear(f),
    );

    for (const k of ['a', 'b', 'c', 'd'] as const) expect(linear(g)[k]).toBeCloseTo(along[k], 12);
  });

  test('half a skew twice is the whole of it, slide and all', () => {
    const whole = played(f, skew(0.5, { x: 4, y: -1 }));
    const half = skew(0.25, { x: 2, y: -0.5 });
    const twice = played(played(f, half), half);

    near(twice.t, whole.t, 12);
    expect(twice.skew).toBeCloseTo(whole.skew, 12);

    // And played half way, it is where the first half left it.
    const part = played(f, skew(0.5, { x: 4, y: -1 }), 0.5);

    near(part.t, played(f, half).t, 12);
    expect(part.skew).toBeCloseTo(f.skew + 0.25, 12);
  });

  test('a scale on a skewed thing is a stretch along its own axes', () => {
    const scale: Op = { kind: 'scale', by: { x: 3, y: 0.25 }, ref: r, shift: ORIGIN, along: f.angle, lean: f.skew };
    const g = played(f, scale);

    near(placed(g, r), placed(f, r), 12);
    expect(g.angle).toEqual(f.angle);
    expect(g.skew).toEqual(f.skew);
    near(g.scale, { x: 6, y: 0.125 }, 12);
  });

  test('a repeated scale on skewed axes keeps its centre', () => {
    const c = { x: -40, y: 25 };
    const by = { x: 1.5, y: 0.75 };
    let tl = keyed(room, 0, P, [{ kind: 'skew', by: 0.6, ref: MIDDLE, shift: ORIGIN }, turn(36, MIDDLE)]);

    const g = stateAt(tl, P, 0).frame;
    const p = placed(g, MIDDLE);
    const w = unsheared({ x: c.x - p.x, y: c.y - p.y }, g.angle, g.skew);

    tl = keyed(tl, 1, P, [repeating<Op>({
      kind: 'scale',
      by,
      ref: MIDDLE,
      shift: sheared({ x: (1 - by.x) * w.x, y: (1 - by.y) * w.y }, g.angle, g.skew),
      along: g.angle,
      lean: g.skew,
    }, 3)]);

    for (let k = 1; k <= 3; k++) {
      const before = affineOf(stateAt(tl, P, k - 1).frame);
      const now = affineOf(stateAt(tl, P, k).frame);

      near(at(now, unplace(before, c)), c, 9);
    }
  });
});
