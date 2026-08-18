import { describe, expect, test } from 'vitest';
import {
  AABB,
  bounds,
  box,
  build,
  containsBox,
  depth,
  each,
  emptyTree,
  expand,
  ids,
  insert,
  merge,
  ofPoints,
  overlaps,
  perimeter,
  remove,
  search,
  searchPoint,
  size,
  update,
} from './aabb';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Deterministic, so a failure is a failure again next time. */
function random(seed: number): () => number {
  let s = seed >>> 0;

  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;

    return s / 4294967296;
  };
}

function boxes(n: number, seed: number): { id: number, box: AABB }[] {
  const rnd = random(seed);

  return Array.from({ length: n }, (_v, i) => {
    const x = rnd() * 1000 - 500, y = rnd() * 1000 - 500;

    return { id: i, box: box(x, y, x + rnd() * 40, y + rnd() * 40) };
  });
}

function brute(items: { id: number, box: AABB }[], b: AABB): number[] {
  return items.filter(i => overlaps(i.box, b)).map(i => i.id).sort((p, q) => p - q);
}

function sorted(xs: number[]): number[] {
  return [...xs].sort((a, b) => a - b);
}

// -----------------------------------------------------------------------------
// Boxes
// -----------------------------------------------------------------------------

describe('boxes', () => {
  test('bounds of points', () => {
    expect(ofPoints([{ x: 1, y: 2 }, { x: -3, y: 5 }])).toEqual(box(-3, 2, 1, 5));
  });

  test('overlap includes touching', () => {
    expect(overlaps(box(0, 0, 1, 1), box(1, 1, 2, 2))).toBe(true);
    expect(overlaps(box(0, 0, 1, 1), box(1.0001, 0, 2, 2))).toBe(false);
    expect(overlaps(box(0, 0, 10, 10), box(4, 4, 5, 5))).toBe(true);
  });

  test('merge, containment, expansion, perimeter', () => {
    expect(merge(box(0, 0, 1, 1), box(2, -1, 3, 0))).toEqual(box(0, -1, 3, 1));
    expect(containsBox(box(0, 0, 10, 10), box(1, 1, 2, 2))).toBe(true);
    expect(containsBox(box(0, 0, 10, 10), box(-1, 1, 2, 2))).toBe(false);
    expect(expand(box(0, 0, 1, 1), 1)).toEqual(box(-1, -1, 2, 2));
    expect(perimeter(box(0, 0, 2, 3))).toBe(10);
  });
});

// -----------------------------------------------------------------------------
// The tree
// -----------------------------------------------------------------------------

describe('tree', () => {
  test('an empty tree answers nothing', () => {
    expect(size(emptyTree)).toBe(0);
    expect(search(emptyTree, box(0, 0, 1, 1))).toEqual([]);
    expect(depth(emptyTree)).toBe(-1);
  });

  test('a single leaf', () => {
    const t = insert(emptyTree, 7, box(0, 0, 2, 2));

    expect(size(t)).toBe(1);
    expect(search(t, box(1, 1, 1, 1))).toEqual([7]);
    expect(search(t, box(5, 5, 6, 6))).toEqual([]);
    expect(bounds(t)).toEqual(box(0, 0, 2, 2));
  });

  test('queries agree with brute force', () => {
    const items = boxes(300, 1);
    const tree = items.reduce((t, i) => insert(t, i.id, i.box), emptyTree);

    expect(size(tree)).toBe(300);
    expect(sorted(ids(tree))).toEqual(items.map(i => i.id));

    const rnd = random(99);

    for (let k = 0; k < 200; k++) {
      const x = rnd() * 1200 - 600, y = rnd() * 1200 - 600;
      const q = box(x, y, x + rnd() * 120, y + rnd() * 120);

      expect(sorted(search(tree, q))).toEqual(brute(items, q));
    }
  });

  test('point queries agree with brute force', () => {
    const items = boxes(200, 4);
    const tree = build(items);
    const rnd = random(5);

    for (let k = 0; k < 200; k++) {
      const p = { x: rnd() * 1000 - 500, y: rnd() * 1000 - 500 };

      expect(sorted(searchPoint(tree, p))).toEqual(brute(items, box(p.x, p.y, p.x, p.y)));
    }
  });

  test('insertion leaves the tree it was given alone', () => {
    const a = insert(insert(emptyTree, 1, box(0, 0, 1, 1)), 2, box(5, 5, 6, 6));
    const b = insert(a, 3, box(10, 10, 11, 11));

    expect(sorted(ids(a))).toEqual([1, 2]);
    expect(sorted(ids(b))).toEqual([1, 2, 3]);
    expect(size(a)).toBe(2);
  });

  test('removal leaves the tree it was given alone', () => {
    const items = boxes(64, 7);
    const a = items.reduce((t, i) => insert(t, i.id, i.box), emptyTree);
    const b = remove(a, 13, items[13].box);

    expect(sorted(ids(a))).toEqual(items.map(i => i.id));
    expect(sorted(ids(b))).toEqual(items.filter(i => i.id !== 13).map(i => i.id));
    expect(size(b)).toBe(63);
  });

  test('removing an id it does not hold changes nothing at all', () => {
    const t = insert(emptyTree, 1, box(0, 0, 1, 1));

    expect(remove(t, 2, box(0, 0, 1, 1))).toBe(t);
    expect(remove(t, 1, box(50, 50, 51, 51))).toBe(t);
  });

  test('everything can be removed, in any order', () => {
    const items = boxes(120, 11);
    let tree = items.reduce((t, i) => insert(t, i.id, i.box), emptyTree);

    const order = [...items].sort((a, b) => (a.id * 7919) % 120 - (b.id * 7919) % 120);

    for (const i of order) {
      tree = remove(tree, i.id, i.box);
    }

    expect(tree).toBe(null);
    expect(size(tree)).toBe(0);
  });

  test('update moves a leaf', () => {
    const items = boxes(40, 13);
    let tree = items.reduce((t, i) => insert(t, i.id, i.box), emptyTree);

    tree = update(tree, 5, items[5].box, box(9000, 9000, 9001, 9001));

    expect(search(tree, items[5].box).includes(5)).toBe(false);
    expect(search(tree, box(8999, 8999, 9002, 9002))).toEqual([5]);
    expect(size(tree)).toBe(40);
  });

  test('the tree stays shallow', () => {
    const items = boxes(1000, 17);
    const tree = items.reduce((t, i) => insert(t, i.id, i.box), emptyTree);
    const ideal = Math.log2(1000);

    expect(size(tree)).toBe(1000);
    expect(depth(tree)).toBeLessThan(ideal * 2);
  });

  test('bulk build beats one-by-one on shape, and answers the same', () => {
    const items = boxes(500, 19);
    const one = items.reduce((t, i) => insert(t, i.id, i.box), emptyTree);
    const bulk = build(items);

    expect(size(bulk)).toBe(500);
    expect(depth(bulk)).toBeLessThanOrEqual(Math.ceil(Math.log2(500)));
    expect(depth(bulk)).toBeLessThanOrEqual(depth(one));

    const q = box(-100, -100, 100, 100);
    expect(sorted(search(bulk, q))).toEqual(sorted(search(one, q)));
  });

  test('a query only visits what it has to', () => {
    // A thousand boxes spread over a wide field; a small query should touch a
    // handful of leaves, not the field.
    const items = boxes(1000, 23);
    const tree = build(items);

    let visited = 0;
    each(tree, box(0, 0, 5, 5), () => visited++);

    expect(visited).toBe(brute(items, box(0, 0, 5, 5)).length);
    expect(visited).toBeLessThan(60);
  });

  test('degenerate boxes are ordinary boxes', () => {
    const t = insert(insert(emptyTree, 1, box(0, 0, 0, 0)), 2, box(0, 0, 0, 0));

    expect(sorted(search(t, box(0, 0, 0, 0)))).toEqual([1, 2]);
  });
});
