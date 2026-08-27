import { describe, expect, test } from 'vitest';
import { PACE, addPath, hitPathEdge, hitPathPoint, seconds, setPath, timings } from './paths';
import { emptyWorld } from './types';

describe('timings', () => {
  test('start at zero and add up along the legs', () => {
    const t = timings([{ x: 0, y: 0 }, { x: PACE, y: 0 }, { x: PACE, y: PACE * 2 }]);

    expect(t[0]).toBe(0);
    expect(t[1]).toBeCloseTo(1);
    expect(t[2]).toBeCloseTo(3);
  });

  test('one point takes no time, and no points is no answer', () => {
    expect(timings([{ x: 5, y: 5 }])).toEqual([0]);
    expect(timings([])).toEqual([]);
  });

  test('are written to a tenth', () => {
    expect(seconds(1.234)).toBe('1.2s');
  });
});

describe('editing', () => {
  test('a path is added under its own id and read back', () => {
    const { world, id } = addPath(emptyWorld(), [{ x: 0, y: 0 }, { x: 10, y: 0 }]);

    expect(world.paths.get(id)!.points).toHaveLength(2);
  });

  test('what is left of a walk that is not one any more is nothing', () => {
    const { world, id } = addPath(emptyWorld(), [{ x: 0, y: 0 }, { x: 10, y: 0 }]);

    expect(setPath(world, id, [{ x: 0, y: 0 }]).paths.has(id)).toBe(false);
    expect(setPath(world, id, []).paths.has(id)).toBe(false);
  });

  test('the world it came from is untouched', () => {
    const { world, id } = addPath(emptyWorld(), [{ x: 0, y: 0 }, { x: 10, y: 0 }]);

    setPath(world, id, []);

    expect(world.paths.has(id)).toBe(true);
  });
});

describe('hit testing', () => {
  const { world, id } = addPath(emptyWorld(), [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ]);

  test('a point is found within reach and not beyond it', () => {
    expect(hitPathPoint(world.paths, { x: 98, y: 2 }, 5)).toEqual({ id, index: 1 });
    expect(hitPathPoint(world.paths, { x: 50, y: 50 }, 5)).toBe(null);
  });

  test('a leg is found by its first point, with the place on it', () => {
    const on = hitPathEdge(world.paths, { x: 40, y: 3 }, 5)!;

    expect(on.index).toBe(0);
    expect(on.at).toEqual({ x: 40, y: 0 });
  });

  test('past the end of a leg is not on it', () => {
    expect(hitPathEdge(world.paths, { x: -20, y: 0 }, 5)).toBe(null);
  });
});
