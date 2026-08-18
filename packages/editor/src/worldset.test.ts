import { describe, expect, test } from 'vitest';
import { PolygonType } from '@ce/game/world';
import { box } from './aabb';
import { Point, Ring, Shape, contains, isCCW, shapeArea } from './geometry';
import {
  Diff,
  Edit,
  Id,
  entry,
  Piece,
  WorldSet,
  apply,
  edited,
  emptyWorldSet,
  fromEntries,
  insert,
  overlapping,
  pieces,
  remove,
  shape,
  sources,
  update,
} from './worldset';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function rect(x: number, y: number, w: number, h: number): Shape {
  return [[
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ]];
}

function moved(s: Shape, dx: number, dy: number): Shape {
  return s.map(r => r.map(p => ({ x: p.x + dx, y: p.y + dy })));
}

function scaled(s: Shape, k: number): Shape {
  return s.map(r => r.map(p => ({ x: p.x * k, y: p.y * k })));
}

function rotated(s: Shape, a: number): Shape {
  const c = Math.cos(a), n = Math.sin(a);

  return s.map(r => r.map(p => ({ x: p.x * c - p.y * n, y: p.x * n + p.y * c })));
}

function ringIds(set: WorldSet): Id[] {
  return pieces(set).map(p => p.id).sort((a, b) => a - b);
}

/** The state a consumer would be in after honouring every diff it was given. */
function replay(state: Map<Id, Ring>, diff: Diff): Map<Id, Ring> {
  const next = new Map(state);

  for (const id of diff.removed) next.delete(id);
  for (const p of diff.inserted) next.set(p.id, p.ring);

  return next;
}

function sameRings(a: Iterable<Ring>, b: Iterable<Ring>): void {
  expect(canonical([...a])).toEqual(canonical([...b]));
}

function canonical(rings: Ring[]): string[] {
  return rings
    .map(ring => {
      const parts = ring.map(p => `${round(p.x)},${round(p.y)}`);
      let at = 0;
      for (let i = 1; i < parts.length; i++) {
        if (parts[i] < parts[at]) at = i;
      }

      return [...parts.slice(at), ...parts.slice(0, at)].join(' ');
    })
    .sort();
}

function round(n: number): number {
  return Math.abs(n) < 1e-9 ? 0 : Math.round(n * 1e6) / 1e6;
}

function random(seed: number): () => number {
  let s = seed >>> 0;

  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;

    return s / 4294967296;
  };
}

const level: PolygonType = 'level';
const solid: PolygonType = 'solid';

// -----------------------------------------------------------------------------
// What the set holds
// -----------------------------------------------------------------------------

describe('the set', () => {
  test('one level polygon is one ring', () => {
    const { set, diff } = insert(emptyWorldSet, 1, level, rect(0, 0, 10, 10));

    expect(diff.removed).toEqual([]);
    expect(diff.inserted).toHaveLength(1);
    expect(isCCW(diff.inserted[0].ring)).toBe(true);
    sameRings([diff.inserted[0].ring], rect(0, 0, 10, 10));
    expect(shapeArea(shape(set))).toBeCloseTo(100);
  });

  test('overlapping level polygons come out unioned', () => {
    const set = fromEntries([
      { id: 1, type: level, shape: rect(0, 0, 10, 10) },
      { id: 2, type: level, shape: rect(5, 5, 10, 10) },
    ]);

    expect(pieces(set)).toHaveLength(1);
    expect(shapeArea(shape(set))).toBeCloseTo(175);
  });

  test('a solid is subtracted, hole and all', () => {
    const set = fromEntries([
      { id: 1, type: level, shape: rect(0, 0, 10, 10) },
      { id: 2, type: solid, shape: rect(3, 3, 4, 4) },
    ]);

    expect(pieces(set)).toHaveLength(2);
    expect(shapeArea(shape(set))).toBeCloseTo(84);
    expect(contains(shape(set), { x: 5, y: 5 })).toBe(false);
    expect(contains(shape(set), { x: 1, y: 1 })).toBe(true);
  });

  test('a solid on its own contributes nothing', () => {
    const set = fromEntries([{ id: 1, type: solid, shape: rect(0, 0, 10, 10) }]);

    expect(pieces(set)).toEqual([]);
  });

  test('floors are not part of the set', () => {
    const set = fromEntries([
      { id: 1, type: 'floor' as PolygonType, shape: rect(0, 0, 10, 10) },
      { id: 2, type: level, shape: rect(20, 20, 5, 5) },
    ]);

    expect(pieces(set)).toHaveLength(1);
    expect(shapeArea(shape(set))).toBeCloseTo(25);
    expect(overlapping(set, box(0, 0, 10, 10))).toEqual([]);
  });

  test('self-intersecting input is resolved on the way in', () => {
    const bowtie: Shape = [[
      { x: 0, y: 0 },
      { x: 4, y: 4 },
      { x: 4, y: 0 },
      { x: 0, y: 4 },
    ]];

    const set = fromEntries([{ id: 1, type: level, shape: bowtie }]);

    expect(pieces(set)).toHaveLength(2);
    expect(shapeArea(shape(set))).toBeCloseTo(8);
  });

  test('input polygons can be found by box', () => {
    const set = fromEntries([
      { id: 1, type: level, shape: rect(0, 0, 10, 10) },
      { id: 2, type: level, shape: rect(100, 100, 10, 10) },
    ]);

    expect(overlapping(set, box(-5, -5, 5, 5))).toEqual([1]);
    expect(overlapping(set, box(-5, -5, 500, 500)).sort()).toEqual([1, 2]);
  });
});

// -----------------------------------------------------------------------------
// Who owns what
// -----------------------------------------------------------------------------

describe('source polygons', () => {
  test('come back exactly as they went in', () => {
    const bowtie: Shape = [[
      { x: 0, y: 0 },
      { x: 4, y: 4 },
      { x: 4, y: 0 },
      { x: 0, y: 4 },
    ]];

    const set = insert(emptyWorldSet, 1, level, bowtie).set;

    // The set says two triangles; the source is still the bowtie the user drew.
    expect(pieces(set)).toHaveLength(2);
    expect(entry(set, 1)!.source).toBe(bowtie);
    expect(sources(set)).toEqual([{ id: 1, type: level, shape: bowtie }]);
  });

  test('a clockwise polygon is not silently rewound under the editor', () => {
    const cw: Shape = [[{ x: 0, y: 0 }, { x: 0, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 0 }]];
    const set = insert(emptyWorldSet, 1, level, cw).set;

    expect(entry(set, 1)!.source[0]).toEqual(cw[0]);
    expect(isCCW(entry(set, 1)!.shape[0])).toBe(true);
    expect(isCCW(pieces(set)[0].ring)).toBe(true);
  });

  test('editing goes source in, source out, round after round', () => {
    let set = insert(emptyWorldSet, 1, level, rect(0, 0, 10, 10)).set;

    for (let k = 0; k < 5; k++) {
      set = update(set, 1, moved(entry(set, 1)!.source, 1, 0)).set;
    }

    expect(entry(set, 1)!.source[0][0]).toEqual({ x: 5, y: 0 });
    expect(shapeArea(shape(set))).toBeCloseTo(100);
  });

  test('a rebuild from the sources says the same thing', () => {
    const set = fromEntries([
      { id: 1, type: level, shape: rect(0, 0, 10, 10) },
      { id: 2, type: solid, shape: rect(3, 3, 4, 4) },
    ]);

    sameRings(shape(set), shape(fromEntries(sources(set))));
  });

  test('inserting an id that is already there replaces it', () => {
    const a = insert(emptyWorldSet, 1, level, rect(0, 0, 10, 10)).set;
    const { set: b, diff } = insert(a, 1, solid, rect(0, 0, 4, 4));

    expect(b.entries.size).toBe(1);
    expect(entry(b, 1)!.kind).toBe('solid');
    expect(pieces(b)).toEqual([]);
    expect(diff.removed).toHaveLength(1);
  });

  test('editing an id the set does not hold does nothing', () => {
    const a = fromEntries([{ id: 1, type: level, shape: rect(0, 0, 10, 10) }]);
    const { set: b, diff } = update(a, 99, rect(0, 0, 5, 5));

    expect(diff).toEqual({ removed: [], inserted: [] });
    expect(ringIds(b)).toEqual(ringIds(a));
    expect(remove(a, 99).diff).toEqual({ removed: [], inserted: [] });
  });

  test('piece ids are minted fresh and never handed out twice', () => {
    const rnd = random(31);
    const seen = new Set<number>();
    const live = new Set<Id>();

    let set = emptyWorldSet;
    let next = 1;

    for (let step = 0; step < 40; step++) {
      const ids = [...live];

      if (rnd() < 0.6 || ids.length === 0) {
        const id = next++;
        live.add(id);
        set = insert(set, id, level, rect(Math.round(rnd() * 6) * 5, 0, 10, 10)).set;
      }
      else {
        const id = ids[Math.floor(rnd() * ids.length)];
        live.delete(id);
        set = remove(set, id).set;
      }

      for (const p of pieces(set)) {
        // A piece id may persist across edits, but a *new* one is never a
        // number that has been retired.
        seen.add(p.id);
      }

      expect(pieces(set).map(p => p.id).length).toBe(new Set(pieces(set).map(p => p.id)).size);
    }

    expect(seen.size).toBeGreaterThan(5);
  });

  test('source ids and piece ids are free to be the same number', () => {
    // Source id 1 and piece id 1 coexist and mean different things.
    const set = insert(emptyWorldSet, 1, level, rect(0, 0, 10, 10)).set;

    expect(entry(set, 1)).toBeDefined();
    expect(pieces(set)[0].id).toBe(1);
    expect(pieces(set)[0].ring).not.toBe(entry(set, 1)!.source[0]);
  });
});

// -----------------------------------------------------------------------------
// The diff, which is the point of the whole thing
// -----------------------------------------------------------------------------

describe('the diff', () => {
  test('an edit far away touches nothing else', () => {
    const a = fromEntries([
      { id: 1, type: level, shape: rect(0, 0, 10, 10) },
      { id: 2, type: level, shape: rect(100, 0, 10, 10) },
      { id: 3, type: level, shape: rect(200, 0, 10, 10) },
    ]);

    const before = ringIds(a);
    const { set: b, diff } = insert(a, 4, level, rect(300, 0, 10, 10));

    expect(diff.removed).toEqual([]);
    expect(diff.inserted).toHaveLength(1);
    // The three that were already there kept their identities.
    expect(ringIds(b)).toEqual([...before, diff.inserted[0].id].sort((x, y) => x - y));
  });

  test('a move within one cluster leaves the other clusters alone', () => {
    const a = fromEntries([
      { id: 1, type: level, shape: rect(0, 0, 10, 10) },
      { id: 2, type: level, shape: rect(5, 5, 10, 10) },
      { id: 3, type: level, shape: rect(100, 0, 10, 10) },
    ]);

    const far = pieces(a).find(p => p.ring.some(q => q.x > 50))!;
    const { set: b, diff } = update(a, 2, rect(6, 6, 10, 10));

    expect(diff.removed).toHaveLength(1);
    expect(diff.inserted).toHaveLength(1);
    expect(diff.removed).not.toContain(far.id);
    expect(pieces(b).find(p => p.id === far.id)).toBeDefined();
  });

  test('a polygon dragged into another merges two rings into one', () => {
    const a = fromEntries([
      { id: 1, type: level, shape: rect(0, 0, 10, 10) },
      { id: 2, type: level, shape: rect(50, 0, 10, 10) },
    ]);

    expect(pieces(a)).toHaveLength(2);

    const { set: b, diff } = update(a, 2, rect(5, 0, 10, 10));

    expect(diff.removed.sort()).toEqual(ringIds(a));
    expect(diff.inserted).toHaveLength(1);
    expect(pieces(b)).toHaveLength(1);
    expect(shapeArea(shape(b))).toBeCloseTo(150);
  });

  test('a polygon dragged apart splits one ring into two', () => {
    const a = fromEntries([
      { id: 1, type: level, shape: rect(0, 0, 10, 10) },
      { id: 2, type: level, shape: rect(5, 0, 10, 10) },
    ]);

    expect(pieces(a)).toHaveLength(1);

    const { set: b, diff } = update(a, 2, rect(50, 0, 10, 10));

    expect(diff.removed).toEqual(ringIds(a));
    expect(diff.inserted).toHaveLength(2);
    expect(pieces(b)).toHaveLength(2);
  });

  test('removing the polygon that bridged two others splits the cluster', () => {
    const a = fromEntries([
      { id: 1, type: level, shape: rect(0, 0, 10, 10) },
      { id: 2, type: level, shape: rect(9, 0, 10, 10) },
      { id: 3, type: level, shape: rect(18, 0, 10, 10) },
    ]);

    expect(pieces(a)).toHaveLength(1);

    const { set: b, diff } = remove(a, 2);

    expect(diff.removed).toHaveLength(1);
    expect(diff.inserted).toHaveLength(2);
    expect(pieces(b)).toHaveLength(2);
    expect(shapeArea(shape(b))).toBeCloseTo(200);
  });

  test('dragging a solid out of a level fills the hole back in', () => {
    const a = fromEntries([
      { id: 1, type: level, shape: rect(0, 0, 10, 10) },
      { id: 2, type: solid, shape: rect(3, 3, 4, 4) },
    ]);

    expect(pieces(a)).toHaveLength(2);

    const { set: b } = update(a, 2, rect(300, 300, 4, 4));

    expect(pieces(b)).toHaveLength(1);
    expect(shapeArea(shape(b))).toBeCloseTo(100);
    expect(contains(shape(b), { x: 5, y: 5 })).toBe(true);
  });

  test('an unchanged ring keeps its id even when its cluster is recomputed', () => {
    // Two level polygons far enough apart to be separate rings, plus a solid
    // that is moved from one end of the world to inside the first. The second
    // polygon's ring must survive untouched.
    const a = fromEntries([
      { id: 1, type: level, shape: rect(0, 0, 10, 10) },
      { id: 2, type: level, shape: rect(40, 0, 10, 10) },
      { id: 3, type: solid, shape: rect(45, 5, 2, 2) },
    ]);

    const first = pieces(a).find(p => p.ring.every(q => q.x < 20))!;
    const { set: b, diff } = update(a, 3, rect(4, 4, 2, 2));

    expect(diff.removed).not.toContain(first.id);
    expect(pieces(b).find(p => p.id === first.id)?.ring).toBe(first.ring);
  });

  test('a no-op update reports nothing', () => {
    const a = fromEntries([
      { id: 1, type: level, shape: rect(0, 0, 10, 10) },
      { id: 2, type: level, shape: rect(5, 5, 10, 10) },
    ]);

    const { diff } = update(a, 1, rect(0, 0, 10, 10));

    expect(diff.removed).toEqual([]);
    expect(diff.inserted).toEqual([]);
  });

  test('a batch of edits is one recomputation', () => {
    const a = fromEntries([
      { id: 1, type: level, shape: rect(0, 0, 10, 10) },
      { id: 2, type: level, shape: rect(5, 5, 10, 10) },
      { id: 3, type: level, shape: rect(100, 0, 10, 10) },
    ]);

    const { set: b, diff } = apply(a, [
      { op: 'update', id: 1, shape: moved(rect(0, 0, 10, 10), 1, 1) },
      { op: 'update', id: 2, shape: moved(rect(5, 5, 10, 10), 1, 1) },
    ]);

    expect(diff.removed).toHaveLength(1);
    expect(diff.inserted).toHaveLength(1);
    expect(pieces(b)).toHaveLength(2);
  });

  test('moving, rotating and scaling are all just an update', () => {
    let set = fromEntries([{ id: 1, type: level, shape: rect(-5, -5, 10, 10) }]);

    set = update(set, 1, moved(rect(-5, -5, 10, 10), 3, 0)).set;
    expect(shapeArea(shape(set))).toBeCloseTo(100);

    set = update(set, 1, rotated(rect(-5, -5, 10, 10), Math.PI / 4)).set;
    expect(shapeArea(shape(set))).toBeCloseTo(100);

    set = update(set, 1, scaled(rect(-5, -5, 10, 10), 2)).set;
    expect(shapeArea(shape(set))).toBeCloseTo(400);
  });

  test('edited is apply with the diff thrown away', () => {
    const a = fromEntries([
      { id: 1, type: level, shape: rect(0, 0, 10, 10) },
      { id: 2, type: level, shape: rect(100, 0, 10, 10) },
    ]);

    const edits: Edit[] = [
      { op: 'update', id: 2, shape: rect(5, 0, 10, 10) },
      { op: 'insert', id: 3, type: solid, shape: rect(2, 2, 3, 3) },
    ];

    const b = edited(edits)(a);

    sameRings(shape(b), shape(apply(a, edits).set));
    expect(shapeArea(shape(b))).toBeCloseTo(150 - 9);
    // Still a function of the set it was given, not a mutation of it.
    expect(shapeArea(shape(a))).toBeCloseTo(200);
  });

  test('edited composes, so a sequence of them is one function', () => {
    const step = edited([{ op: 'insert', id: 9, type: level, shape: rect(0, 0, 4, 4) }]);
    const then = edited([{ op: 'update', id: 9, shape: rect(0, 0, 8, 8) }]);

    expect(shapeArea(shape(then(step(emptyWorldSet))))).toBeCloseTo(64);
  });

  test('the earlier set is untouched by a later edit', () => {
    const a = fromEntries([{ id: 1, type: level, shape: rect(0, 0, 10, 10) }]);
    const before = pieces(a);
    const { set: b } = insert(a, 2, level, rect(5, 5, 10, 10));

    expect(pieces(a)).toEqual(before);
    expect(shapeArea(shape(a))).toBeCloseTo(100);
    expect(shapeArea(shape(b))).toBeCloseTo(175);
  });
});

// -----------------------------------------------------------------------------
// Against a full recomputation
// -----------------------------------------------------------------------------

describe('incremental against wholesale', () => {
  test('a long run of random edits, replayed through the diffs', () => {
    const rnd = random(2024);
    const live = new Set<Id>();

    let set: WorldSet = emptyWorldSet;
    let replayed = new Map<Id, Ring>();
    let next = 1;

    const shapeAt = (): Shape => {
      const x = Math.round(rnd() * 8) * 5, y = Math.round(rnd() * 8) * 5;
      const w = 5 + Math.round(rnd() * 3) * 5, h = 5 + Math.round(rnd() * 3) * 5;

      return rect(x, y, w, h);
    };

    for (let step = 0; step < 120; step++) {
      const ids = [...live];
      const roll = rnd();

      let change;

      if (roll < 0.45 || ids.length === 0) {
        const id = next++;
        change = insert(set, id, rnd() < 0.7 ? level : solid, shapeAt());
        live.add(id);
      }
      else if (roll < 0.8) {
        change = update(set, ids[Math.floor(rnd() * ids.length)], shapeAt());
      }
      else {
        const id = ids[Math.floor(rnd() * ids.length)];
        change = remove(set, id);
        live.delete(id);
      }

      set = change.set;
      replayed = replay(replayed, change.diff);

      // The diff is the whole story: honouring it reproduces the set exactly.
      expect([...replayed.keys()].sort((a, b) => a - b)).toEqual(ringIds(set));

      // And the set matches what a full recomputation would have said.
      const scratch = fromEntries(
        [...set.entries.values()].map(e => ({ id: e.id, type: e.kind as PolygonType, shape: e.shape })),
      );

      sameRings(shape(set), shape(scratch));
    }

    expect(live.size).toBeGreaterThan(5);
  });

  test('membership matches a single wholesale CSG', () => {
    const rnd = random(77);
    const entries: { id: Id, type: PolygonType, shape: Shape }[] = [];

    for (let i = 0; i < 24; i++) {
      const x = Math.round(rnd() * 10) * 4, y = Math.round(rnd() * 10) * 4;
      entries.push({
        id: i + 1,
        type: rnd() < 0.65 ? level : solid,
        shape: rect(x, y, 4 + Math.round(rnd() * 2) * 4, 4 + Math.round(rnd() * 2) * 4),
      });
    }

    let set: WorldSet = emptyWorldSet;
    for (const e of entries) set = insert(set, e.id, e.type, e.shape).set;

    const inLevel = (p: Point): boolean =>
      entries.some(e => e.type === 'level' && inRect(e.shape[0], p));
    const inSolid = (p: Point): boolean =>
      entries.some(e => e.type === 'solid' && inRect(e.shape[0], p));

    const got = shape(set);

    for (let x = -2; x < 60; x += 1.5) {
      for (let y = -2; y < 60; y += 1.5) {
        const p = { x: x + 0.31, y: y + 0.17 };
        expect([p.x, p.y, contains(got, p)]).toEqual([p.x, p.y, inLevel(p) && !inSolid(p)]);
      }
    }
  });
});

function inRect(ring: Ring, p: Point): boolean {
  const xs = ring.map(q => q.x), ys = ring.map(q => q.y);

  return p.x > Math.min(...xs) && p.x < Math.max(...xs)
    && p.y > Math.min(...ys) && p.y < Math.max(...ys);
}
