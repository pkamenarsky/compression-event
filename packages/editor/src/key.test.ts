import { describe, expect, test } from 'vitest';
import { Point } from '@ce/game/world';
import {
  EMPTY_RIG,
  Entry,
  Frame,
  Keyframe,
  KeyframeId,
  Move,
  Op,
  Rig,
  Stand,
  Timeline,
  once,
  played,
  repeating,
  stateAt,
  stepped,
  withKeys,
} from './rig';
import { Vertex, VertexId } from './types';
import {
  Delta,
  NOTHING,
  deltaOf,
  entriesOf,
  flying,
  keysOf,
  opsOf,
  playedBy,
  playingOn,
  steppedBy,
  walkedBy,
} from './rig';

// A handful of frames a key might be played over: at rest, moved, turned,
// stretched, sheared, and all of it at once. What a delta does must not depend
// on which of these it lands on, since an operation's does not.
const FRAMES: Frame[] = [
  { t: { x: 0, y: 0 }, angle: 0, skew: 0, scale: { x: 1, y: 1 } },
  { t: { x: 37, y: -12 }, angle: 0, skew: 0, scale: { x: 1, y: 1 } },
  { t: { x: -5, y: 9 }, angle: 0.7, skew: 0, scale: { x: 1, y: 1 } },
  { t: { x: 4, y: 4 }, angle: 0, skew: 0, scale: { x: 2, y: 0.5 } },
  { t: { x: 0, y: 11 }, angle: 0, skew: 0.3, scale: { x: 1, y: 1 } },
  { t: { x: -20, y: 6 }, angle: -1.2, skew: 0.4, scale: { x: 1.7, y: 0.6 } },
];

const REFS: Point[] = [
  { x: 0, y: 0 },
  { x: 13, y: -7 },
  { x: -40, y: 25 },
];

const OPS: Op[] = [
  { kind: 'move', by: { x: 15, y: -3 } },
  { kind: 'turn', angle: 0.5, ref: { x: 0, y: 0 }, about: { x: 0, y: 0 } },
  { kind: 'turn', angle: -1.1, ref: { x: 13, y: -7 }, about: { x: 60, y: 20 } },
  { kind: 'scale', by: { x: 1.4, y: 0.8 }, ref: { x: 13, y: -7 }, shift: { x: 0, y: 0 }, along: 0, lean: 0 },
  { kind: 'scale', by: { x: 0.6, y: 1.9 }, ref: { x: -40, y: 25 }, shift: { x: 11, y: -4 }, along: 0.7, lean: 0.2 },
  { kind: 'skew', by: 0.35, ref: { x: 13, y: -7 }, shift: { x: -6, y: 2 }, along: 0.9 },
  { kind: 'erode', by: 3 },
  { kind: 'round', by: 1.5 },
  { kind: 'deform', by: 0.25 },
];

/** The painted point a delta is played about: the operation's, where it has
 * one. The others mean the same about any point of the thing, and are checked
 * about every one of `REFS`. */
function refsFor(op: Op): Point[] {
  return 'ref' in op ? [op.ref] : REFS;
}

function near(f: Frame, g: Frame, what: string): void {
  expect(f.t.x, `${what}: t.x`).toBeCloseTo(g.t.x, 9);
  expect(f.t.y, `${what}: t.y`).toBeCloseTo(g.t.y, 9);
  expect(f.angle, `${what}: angle`).toBeCloseTo(g.angle, 12);
  expect(f.skew, `${what}: skew`).toBeCloseTo(g.skew, 12);
  expect(f.scale.x, `${what}: scale.x`).toBeCloseTo(g.scale.x, 12);
  expect(f.scale.y, `${what}: scale.y`).toBeCloseTo(g.scale.y, 12);
}

describe('a delta says what an operation says', () => {
  for (const op of OPS) {
    test(`${op.kind} ${JSON.stringify(op)}`, () => {
      const d = deltaOf(op);

      expect(d).not.toBeNull();

      for (const f of FRAMES) {
        for (const ref of refsFor(op)) {
          near(playedBy(f, ref, d!), played(f, op), `${op.kind} over ${JSON.stringify(f)}`);
        }
      }
    });
  }
});

describe('a step says what a step says', () => {
  for (const op of OPS) {
    test(`${op.kind} repeated`, () => {
      const d = deltaOf(op)!;

      for (let n = 1; n <= 4; n++) {
        for (const f of FRAMES) {
          for (const ref of refsFor(op)) {
            near(playedBy(f, ref, steppedBy(d, n)), played(f, stepped(op, n)), `${op.kind} step ${n}`);
          }
        }
      }
    });
  }
});

describe('a run of steps lands where a run of steps lands', () => {
  for (const op of OPS) {
    test(`${op.kind} five keyframes running`, () => {
      const d = deltaOf(op)!;

      for (const f of FRAMES) {
        for (const ref of refsFor(op)) {
          let mine = f, theirs = f;

          for (let n = 0; n < 5; n++) {
            mine = playedBy(mine, ref, steppedBy(d, n));
            theirs = played(theirs, stepped(op, n));
            near(mine, theirs, `${op.kind} after ${n + 1}`);
          }
        }
      }
    });
  }
});

describe('several deltas in a row say what several operations say', () => {
  test('a turn, a stretch, a shear and a move, in every order', () => {
    const list = OPS.filter(op => op.kind !== 'erode' && op.kind !== 'round' && op.kind !== 'deform');

    for (const a of list) {
      for (const b of list) {
        for (const f of FRAMES) {
          const theirs = played(played(f, a), b);
          const mine = playedBy(playedBy(f, refsFor(a)[0], deltaOf(a)!), refsFor(b)[0], deltaOf(b)!);

          near(mine, theirs, `${a.kind} then ${b.kind}`);
        }
      }
    }
  });
});

/**
 * The same operations, written against the frame they are played over: a
 * stretch and a shear record the axes the thing had when the hand wrote them,
 * and part way through, those are the axes the easing follows. They are the
 * frame's own at every keyframe the walk reaches, which is what this is.
 */
function wroteAt(f: Frame): Op[] {
  return [
    { kind: 'move', by: { x: 15, y: -3 } },
    { kind: 'turn', angle: 0.5, ref: { x: 0, y: 0 }, about: { x: 0, y: 0 } },
    { kind: 'turn', angle: -1.1, ref: { x: 13, y: -7 }, about: { x: 60, y: 20 } },
    { kind: 'scale', by: { x: 1.4, y: 0.8 }, ref: { x: 13, y: -7 }, shift: { x: 0, y: 0 }, along: f.angle, lean: f.skew },
    { kind: 'scale', by: { x: 0.6, y: 1.9 }, ref: { x: -40, y: 25 }, shift: { x: 11, y: -4 }, along: f.angle, lean: f.skew },
    // Stretched along one axis only: eased along that one and a line along the
    // other, which is the case a matrix inverse cannot see.
    { kind: 'scale', by: { x: 2.2, y: 1 }, ref: { x: 13, y: -7 }, shift: { x: 9, y: 5 }, along: f.angle, lean: f.skew },
    { kind: 'skew', by: 0.35, ref: { x: 13, y: -7 }, shift: { x: -6, y: 2 }, along: f.angle },
    { kind: 'erode', by: 3 },
  ];
}

const WAYS = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];

describe('part way through, a delta goes where the operation goes', () => {
  test('every kind, every way through', () => {
    for (const f of FRAMES) {
      for (const op of wroteAt(f)) {
        const d = deltaOf(op)!;

        for (const u of WAYS) {
          for (const ref of refsFor(op)) {
            near(playedBy(f, ref, d, u), played(f, op, u), `${op.kind} ${u} of the way`);
          }
        }
      }
    }
  });

  test('and so does a step of a repeat', () => {
    for (const f of FRAMES) {
      for (const op of wroteAt(f)) {
        const d = deltaOf(op)!;

        for (let n = 1; n <= 3; n++) {
          for (const u of WAYS) {
            for (const ref of refsFor(op)) {
              near(
                playedBy(f, ref, steppedBy(d, n), u),
                played(f, stepped(op, n), u),
                `${op.kind} step ${n}, ${u} of the way`,
              );
            }
          }
        }
      }
    }
  });

  test('a whole turn keeps its centre, which its move cannot say', () => {
    const op: Op = { kind: 'turn', angle: 2 * Math.PI, ref: { x: 13, y: -7 }, about: { x: 60, y: 20 } };
    const d = deltaOf(op)!;

    expect(d.move.x).toBeCloseTo(0, 9);
    expect(d.move.y).toBeCloseTo(0, 9);
    expect(d.about).toEqual(op.about);

    for (const f of FRAMES) {
      for (const u of WAYS) {
        near(playedBy(f, op.ref, d, u), played(f, op, u), `a whole turn ${u} of the way`);
      }
    }
  });
});

// -----------------------------------------------------------------------------
// The walk
//
// Random rigs of entries, played both ways: `rig.ts`'s walk over the entries,
// and `key.ts`'s over the same rig converted to keys. Every state at every
// keyframe has to agree — the frame, the amounts, which corners stand, where
// they stand, and what each of them holds of its own.
// -----------------------------------------------------------------------------

/** A run of numbers that is the same every time, so a failure can be looked
 * at twice. */
function rolling(seed: number): () => number {
  let s = seed >>> 0;

  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;

    return s / 4294967296;
  };
}

const WALK_KEYFRAMES: Keyframe[] = Array.from({ length: 7 }, (_unused, i) => ({
  id: i,
  name: `v${i}`,
  visible: true,
}));

function corner(id: number, at: Point, birth: KeyframeId, death: KeyframeId | null): Vertex {
  return { id, at, ring: 0, birth, death };
}

const CORNERS: Vertex[] = [
  corner(1, { x: 0, y: 0 }, 0, null),
  corner(2, { x: 20, y: 0 }, 0, null),
  corner(3, { x: 20, y: 20 }, 0, 5),
  corner(4, { x: 0, y: 20 }, 2, null),
];

/** A rig of entries of every kind, with repeats, waits, corner writing and the
 * odd stand: what the walk has to carry. */
function someRig(seed: number): Rig {
  const roll = rolling(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(roll() * xs.length)];
  const span = (): number => (roll() - 0.5) * 40;

  let rig = EMPTY_RIG;

  for (const f of WALK_KEYFRAMES) {
    const list: Entry[] = [];

    for (let n = Math.floor(roll() * 3); n > 0; n--) {
      const ref = { x: span(), y: span() };
      const op: Op = pick<() => Op>([
        () => ({ kind: 'move', by: { x: span(), y: span() } }),
        () => ({ kind: 'turn', angle: (roll() - 0.5) * 3, ref, about: { x: span(), y: span() } }),
        () => ({
          kind: 'scale',
          by: { x: 0.5 + roll(), y: 0.5 + roll() },
          ref,
          shift: { x: span(), y: span() },
          along: (roll() - 0.5) * 2,
          lean: (roll() - 0.5) * 0.5,
        }),
        () => ({ kind: 'skew', by: (roll() - 0.5), ref, shift: { x: span(), y: span() }, along: (roll() - 0.5) * 2 }),
        () => ({ kind: 'erode', by: roll() * 4 }),
        () => ({ kind: 'round', by: roll() * 2 }),
        () => ({ kind: 'deform', by: roll() }),
      ])();

      const times = pick([1, 1, 2, 3, null]);
      const skip = roll() < 0.2 ? new Set([f.id + 2]) : undefined;

      list.push(times === 1 && skip === undefined ? once(op) : repeating(op, times, skip));
    }

    // Now and then a stand: the state outright, which nothing before it
    // reaches past. Its numbers are made up — what is under test is that both
    // walks stop hearing from upstream in the same way.
    if (roll() < 0.15) {
      const held = CORNERS.filter(() => roll() < 0.75);

      list.push(once<Stand>({
        kind: 'stand',
        frame: { t: { x: span(), y: span() }, angle: roll() * 2, skew: roll() * 0.4, scale: { x: 0.8, y: 1.3 } },
        erosion: roll() * 3,
        corners: new Map(held.map(c => [c.id, { x: span(), y: span() }])),
        depths: new Map(held.map(c => [c.id, roll() * 2])),
        bevel: roll(),
        amplitude: roll(),
        bevels: new Map(held.map(c => [c.id, roll()])),
        amplitudes: new Map(held.map(c => [c.id, roll()])),
      }));
    }

    if (list.length > 0) rig = withKeys(rig, f.id, list);

    // A corner's own: nudges, depths, bevels and amplitudes, each repeating as
    // it pleases.
    for (const c of CORNERS) {
      if (roll() < 0.7) continue;

      const times = pick([1, 2, null]);

      if (roll() < 0.5) {
        const was = rig.nudges.get(c.id) ?? new Map();
        const nudges = new Map(rig.nudges);

        nudges.set(c.id, new Map(was).set(f.id, repeating<Move>({ kind: 'move', by: { x: span(), y: span() } }, times)));
        rig = { ...rig, nudges };
      }
      else if (roll() < 0.34) {
        rig = { ...rig, depths: written(rig.depths, c.id, f.id, repeating({ kind: 'erode', by: roll() * 3 }, times)) };
      }
      else if (roll() < 0.5) {
        rig = { ...rig, rounds: written(rig.rounds, c.id, f.id, repeating({ kind: 'round', by: roll() * 3 }, times)) };
      }
      else {
        rig = { ...rig, deforms: written(rig.deforms, c.id, f.id, repeating({ kind: 'deform', by: roll() }, times)) };
      }
    }
  }

  return rig;
}

/** One corner's entry at one keyframe, into the map its kind is kept in. */
function written<E>(
  was: ReadonlyMap<VertexId, ReadonlyMap<KeyframeId, E>>,
  vertex: VertexId,
  at: KeyframeId,
  e: E,
): Map<VertexId, ReadonlyMap<KeyframeId, E>> {
  return new Map(was).set(vertex, new Map(was.get(vertex) ?? []).set(at, e));
}

function timelineOf(rig: Rig): Timeline {
  return {
    keyframes: WALK_KEYFRAMES,
    rigs: new Map([[1, keysOf(rig)]]),
    polygons: new Map([[1, { birth: 0, points: CORNERS }]]),
    groups: new Map(),
    artefacts: new Map(),
    paths: new Map(),
  };
}

function sameNumbers(mine: ReadonlyMap<VertexId, number>, theirs: ReadonlyMap<VertexId, number>, what: string): void {
  expect([...mine.keys()].sort(), `${what}: which corners`).toEqual([...theirs.keys()].sort());

  for (const [id, n] of theirs) expect(mine.get(id), `${what}: corner ${id}`).toBeCloseTo(n, 9);
}

describe('the walk over keys is the walk over entries', () => {
  for (let seed = 1; seed <= 40; seed++) {
    test(`rig ${seed}`, () => {
      const rig = someRig(seed);
      const tl = timelineOf(rig);
      const keys = keysOf(rig);

      // And the way back, while there is one: entries out of the keys, keys
      // out of those again, and the walk over the result. See `entriesOf`.
      expect(
        walkedBy(WALK_KEYFRAMES, keysOf(entriesOf(keys)), CORNERS, 0).states,
        'there and back',
      ).toEqual(walkedBy(WALK_KEYFRAMES, keys, CORNERS, 0).states);

      const mine = walkedBy(WALK_KEYFRAMES, keys, CORNERS, 0).states;

      for (let i = 0; i < WALK_KEYFRAMES.length; i++) {
        const at = WALK_KEYFRAMES[i].id;
        const theirs = stateAt(tl, 1, at);
        const ours = mine[i];

        expect(ours, `v${at}: a state`).toBeDefined();
        near(ours!.frame, theirs.frame, `v${at}`);

        expect(ours!.erosion, `v${at}: erosion`).toBeCloseTo(theirs.erosion, 9);
        expect(ours!.bevel, `v${at}: bevel`).toBeCloseTo(theirs.bevel, 9);
        expect(ours!.amplitude, `v${at}: amplitude`).toBeCloseTo(theirs.amplitude, 9);

        expect([...ours!.corners.keys()].sort(), `v${at}: which corners stand`)
          .toEqual([...theirs.corners.keys()].sort());

        for (const [id, p] of theirs.corners) {
          expect(ours!.corners.get(id)!.x, `v${at}: corner ${id} x`).toBeCloseTo(p.x, 9);
          expect(ours!.corners.get(id)!.y, `v${at}: corner ${id} y`).toBeCloseTo(p.y, 9);
        }

        sameNumbers(ours!.depths, theirs.depths, `v${at}: depths`);
        sameNumbers(ours!.bevels, theirs.bevels, `v${at}: bevels`);
        sameNumbers(ours!.amplitudes, theirs.amplitudes, `v${at}: amplitudes`);
      }
    });
  }
});

// -----------------------------------------------------------------------------
// As operations
//
// What the shipped table holds, until it holds deltas: a key as the operations
// it is made of. A key that came from one operation has to give back that
// operation, numbers and all, or a bake would move where nothing changed.
// -----------------------------------------------------------------------------

describe('a key as the operations it is made of', () => {
  test('one that came from an operation gives it back exactly', () => {
    for (const f of FRAMES) {
      for (const op of wroteAt(f)) {
        const d = deltaOf(op)!;
        const ref = refsFor(op)[0];
        const back = opsOf({ ref, by: d });

        if (op.kind === 'erode' || op.kind === 'round' || op.kind === 'deform') {
          expect(back, 'an amount does not move the frame').toEqual([]);
          continue;
        }

        expect(back).toEqual([op]);
      }
    }
  });

  test('and so does every step of its repeat', () => {
    for (const f of FRAMES) {
      for (const op of wroteAt(f)) {
        if (op.kind === 'erode' || op.kind === 'round' || op.kind === 'deform') continue;

        const d = deltaOf(op)!;
        const ref = refsFor(op)[0];

        for (let n = 1; n <= 3; n++) {
          const back = opsOf({ ref, by: steppedBy(d, n) });

          expect(back, `${op.kind} step ${n}`).toEqual([stepped(op, n)]);
        }
      }
    }
  });

  test('one that holds two at once is exact at the ends', () => {
    // What a gesture folded into the open key will make, which no single
    // operation says: its path between the ends is the operations', and its
    // ends are its own.
    const both: Delta = {
      ...NOTHING,
      angle: 0.6,
      scale: { x: 1.4, y: 0.75 },
      move: { x: 12, y: -5 },
      along: 0.2,
      lean: 0.1,
    };

    for (const f of FRAMES) {
      for (const ref of REFS) {
        const p = { ref, by: both };

        near(playingOn(f, p), playedBy(f, ref, both), 'two channels at once');
        near(playingOn(f, p, 0), f, 'nought of the way through');
      }
    }
  });

  test('a stand is itself, and moves the frame', () => {
    const stand: Stand = {
      kind: 'stand',
      frame: { t: { x: 1, y: 2 }, angle: 0.5, skew: 0, scale: { x: 1, y: 1 } },
      erosion: 0,
      corners: new Map(),
      depths: new Map(),
      bevel: 0,
      amplitude: 0,
      bevels: new Map(),
      amplitudes: new Map(),
    };
    const p = { ref: { x: 0, y: 0 }, stand };

    expect(opsOf(p)).toEqual([stand]);
    expect(flying(p)).toBe(true);
    expect(flying({ ref: { x: 0, y: 0 }, by: { ...NOTHING, erode: 3 } })).toBe(false);
    expect(flying({ ref: { x: 0, y: 0 }, by: { ...NOTHING, move: { x: 1, y: 0 } } })).toBe(true);
  });
});

