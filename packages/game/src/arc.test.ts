import { describe, expect, test } from 'vitest';
import { ARC, angleAt, breaksOf, piecesOf, turnAt } from './arc';

const angles = [0, 0.3, -0.3, Math.PI / 2, -Math.PI / 2, Math.PI, 2.5 * Math.PI, -7];

describe('a rational turn', () => {
  test('is the identity at 0 and the whole turn at 1', () => {
    for (const a of angles) {
      expect(turnAt(a, 0).cos).toBeCloseTo(1, 12);
      expect(turnAt(a, 0).sin).toBeCloseTo(0, 12);
      expect(turnAt(a, 1).cos).toBeCloseTo(Math.cos(a), 12);
      expect(turnAt(a, 1).sin).toBeCloseTo(Math.sin(a), 12);
    }
  });

  test('stays on the unit circle', () => {
    for (const a of angles) {
      for (let i = 0; i <= 40; i++) {
        const { cos, sin } = turnAt(a, i / 40);

        expect(Math.hypot(cos, sin)).toBeCloseTo(1, 12);
      }
    }
  });

  // The whole point of easing the angle at all: a turn goes round, it does not
  // slew through a shear or double back.
  test('turns one way, without stopping', () => {
    for (const a of angles) {
      let last = 0, total = 0;

      for (let i = 1; i <= 400; i++) {
        const { cos, sin } = turnAt(a, i / 400);
        const here = Math.atan2(sin, cos);
        let step = here - last;

        while (step > Math.PI) step -= 2 * Math.PI;
        while (step < -Math.PI) step += 2 * Math.PI;

        expect(step * Math.sign(a || 1)).toBeGreaterThanOrEqual(-1e-12);

        total += step;
        last = here;
      }

      expect(total).toBeCloseTo(a, 6);
    }
  });

  test('is continuous where its pieces meet', () => {
    for (const a of angles) {
      for (const b of breaksOf(a)) {
        const before = turnAt(a, b - 1e-12), after = turnAt(a, b + 1e-12);

        expect(after.cos).toBeCloseTo(before.cos, 8);
        expect(after.sin).toBeCloseTo(before.sin, 8);
      }
    }
  });

  test('cuts a turn into pieces no longer than ARC', () => {
    for (const a of angles) {
      expect(Math.abs(a) / piecesOf(a)).toBeLessThanOrEqual(ARC + 1e-12);
      expect(breaksOf(a)).toHaveLength(piecesOf(a) - 1);
    }
  });

  // How much unevenness the rational easing is buying the bake. See `arc.ts`.
  test('is within a degree of a linear angle', () => {
    for (const a of angles) {
      for (let i = 0; i <= 100; i++) {
        const t = i / 100;
        const off = Math.abs(wrapped(angleAt(a, t) - wrapped(a * t)));

        expect(off).toBeLessThan(Math.PI / 180);
      }
    }
  });
});

function wrapped(a: number): number {
  let x = a;

  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;

  return x;
}
