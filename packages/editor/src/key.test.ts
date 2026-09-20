import { describe, expect, test } from 'vitest';
import { Point } from '@ce/game/world';
import { Frame, Op, played, stepped } from './rig';
import { deltaOf, playedBy, steppedBy } from './key';

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
