import { describe, expect, test } from 'vitest';
import {
  EASINGS,
  Group,
  Id,
  World,
  ZOOM_MAX,
  ZOOM_MIN,
  coarser,
  defaultView,
  emptyWorld,
  enclosing,
  finer,
  onGrid,
  outermost,
  parentOf,
  toStep,
  within,
  zoomedAt,
} from './types';

/** A world with nothing in it but structure: the helpers read `groups` and
 * `groups` only, and giving them polygons to hold would say otherwise. */
function nested(groups: [Id, Group][]): World {
  return { ...emptyWorld(), groups: new Map(groups) };
}

// 10 ⊃ 20 ⊃ { 1, 2 }, and 3 on its own.
const w = nested([
  [10, { birth: 0, death: null, members: [20] }],
  [20, { birth: 0, death: null, members: [1, 2] }],
]);

describe('groups', () => {
  test('who holds whom is read off who holds what', () => {
    expect([...parentOf(w)]).toEqual([[20, 10], [1, 20], [2, 20]]);
  });

  test('the index is derived once per structure', () => {
    // It is asked on every pick and every resolve, and the map it is derived
    // from is persistent, so the cache key is the map itself.
    expect(parentOf(w)).toBe(parentOf(w));
    expect(parentOf({ ...w })).toBe(parentOf(w));
    expect(parentOf(nested([...w.groups]))).not.toBe(parentOf(w));
  });

  test('a member knows everything it is inside, innermost first', () => {
    expect(enclosing(w, 1)).toEqual([20, 10]);
    expect(enclosing(w, 20)).toEqual([10]);
    expect(enclosing(w, 10)).toEqual([]);
    expect(enclosing(w, 3)).toEqual([]);
  });

  test('a click takes the outermost thing that moves with it', () => {
    expect(outermost(w, 1)).toEqual(10);
    expect(outermost(w, 10)).toEqual(10);
    expect(outermost(w, 3)).toEqual(3);
  });

  test('a group is everything under it', () => {
    expect(within(w, 10)).toEqual([10, 20, 1, 2]);
    expect(within(w, 20)).toEqual([20, 1, 2]);
    expect(within(w, 1)).toEqual([1]);
  });

  test('a cycle stops rather than spinning', () => {
    // Joining is what makes this unrepresentable. Reading it is not the place
    // for the loop to be discovered, so it ends where it came in.
    const bad = nested([
      [10, { birth: 0, death: null, members: [20] }],
      [20, { birth: 0, death: null, members: [10] }],
    ]);

    expect(enclosing(bad, 10)).toEqual([20]);
    expect(enclosing(bad, 20)).toEqual([10]);
  });
});

describe('the curve a version switch plays on', () => {
  test('every one of them pins both ends', () => {
    // The walk is over when the clock reaches 1, so a curve that arrived early
    // would cut the last frames off and one that arrived late would leave the
    // geometry short of the version it landed on.
    for (const [name, curve] of Object.entries(EASINGS)) {
      expect([name, curve(0)]).toEqual([name, 0]);
      expect([name, curve(1)]).toEqual([name, 1]);
    }
  });

  test('none of them goes backwards', () => {
    for (const [name, curve] of Object.entries(EASINGS)) {
      let was = -Infinity;

      for (let i = 0; i <= 100; i++) {
        const at = curve(i / 100);

        expect([name, at >= was]).toEqual([name, true]);
        was = at;
      }
    }
  });

  test('ease-out leaves at speed and settles', () => {
    expect(EASINGS.out(0.25)).toBeGreaterThan(0.25);
    expect(EASINGS.out(0.75)).toBeGreaterThan(0.75);

    // Slower at the end than at the start, which is the whole of what it is.
    expect(EASINGS.out(1) - EASINGS.out(0.9)).toBeLessThan(EASINGS.out(0.1) - EASINGS.out(0));
  });
});


describe('the grid', () => {
  test('a point lands on the nearest dot', () => {
    expect(onGrid({ x: 17, y: -17 }, 10)).toEqual({ x: 20, y: -20 });
  });

  test('a step lands on a whole number of cells', () => {
    expect(toStep(74, 32)).toBe(64);
    expect(toStep(-74, 32)).toBe(-64);
  });

  test('finer and coarser halve and double, and stop', () => {
    expect(coarser(finer(32))).toBe(32);
    expect(finer(1)).toBe(1);
    expect(coarser(1024)).toBe(1024);
  });
});

describe('zooming about a point', () => {
  const view = { ...defaultView, width: 800, height: 600, zoom: 1, x: 100, y: 50 };

  test('the world point under the cursor does not move', () => {
    const on = { x: 320, y: 240 };
    const after = zoomedAt(view, 2.5, on);

    expect(after.x + on.x / after.zoom).toBeCloseTo(view.x + on.x / view.zoom);
    expect(after.y + on.y / after.zoom).toBeCloseTo(view.y + on.y / view.zoom);
  });

  test('it stops at both ends', () => {
    expect(zoomedAt(view, 1e6, { x: 0, y: 0 }).zoom).toBe(ZOOM_MAX);
    expect(zoomedAt(view, 1e-6, { x: 0, y: 0 }).zoom).toBe(ZOOM_MIN);
  });
});
