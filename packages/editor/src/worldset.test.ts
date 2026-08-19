import { describe, expect, test } from 'vitest';
import { Point, Ring, Shape } from './geometry';
import {
  Diff,
  Edit,
  Id,
  PieceId,
  WorldSet,
  apply,
  emptyWorldSet,
  entry,
  fromEntries,
  insert,
  outline,
  overlapping,
  pieces,
  recomputed,
  remove,
  update,
} from './worldset';
import { box } from './aabb';

const level = 'level' as const;
const solid = 'solid' as const;

const rect = (x: number, y: number, w: number, h: number): Shape =>
  [[{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]];

/** Total length of every run in the set: the outline, each piece once. */
function length(set: WorldSet): number {
  return outline(set).reduce((t, r) => t + r.slice(1).reduce(
    (u, p, i) => u + Math.hypot(p.x - r[i].x, p.y - r[i].y), 0), 0);
}

/** The state a consumer would be in after honouring every diff it was given. */
function replay(state: Map<PieceId, Point[]>, diff: Diff): Map<PieceId, Point[]> {
  const next = new Map(state);

  for (const id of diff.removed) next.delete(id);
  for (const p of diff.inserted) next.set(p.id, p.points);

  return next;
}

const held = (set: WorldSet) => new Map(pieces(set).map(p => [p.id, p.points]));

describe('the set', () => {
  test('a lone polygon contributes its whole outline', () => {
    const { set, diff } = insert(emptyWorldSet, 1, level, rect(0, 0, 10, 10));

    expect(diff.removed).toEqual([]);
    expect(diff.inserted.length).toBeGreaterThan(0);
    expect(diff.inserted.every(p => p.source === 1)).toBe(true);
    expect(length(set)).toBeCloseTo(40, 6);
  });

  test('overlapping polygons share the outline instead of doubling it', () => {
    // 10x10 and 10x10 overlapping by 5: the union is 15x10, perimeter 50.
    const set = fromEntries([
      { id: 1, type: level, shape: rect(0, 0, 10, 10) },
      { id: 2, type: level, shape: rect(5, 0, 10, 10) },
    ]);

    expect(length(set)).toBeCloseTo(50, 6);
  });

  test('a polygon buried whole contributes nothing', () => {
    const set = fromEntries([
      { id: 1, type: level, shape: rect(0, 0, 20, 20) },
      { id: 2, type: level, shape: rect(5, 5, 4, 4) },
    ]);

    expect(pieces(set).filter(p => p.source === 2)).toEqual([]);
    expect(length(set)).toBeCloseTo(80, 6);
  });

  test('a solid cuts a hole and contributes its own outline', () => {
    const set = fromEntries([
      { id: 1, type: level, shape: rect(0, 0, 20, 20) },
      { id: 2, type: solid, shape: rect(8, 8, 4, 4) },
    ]);

    expect(length(set)).toBeCloseTo(80 + 16, 6);
  });

  test('an unsupported type is refused rather than guessed at', () => {
    const set = insert(emptyWorldSet, 1, 'floor', rect(0, 0, 4, 4)).set;

    expect(entry(set, 1)).toBeUndefined();
    expect(pieces(set)).toEqual([]);
  });
});

describe('sources', () => {
  test('the points that came in come back out untouched', () => {
    const cw: Shape = [[{ x: 0, y: 0 }, { x: 0, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 0 }]];
    const set = insert(emptyWorldSet, 1, level, cw).set;

    expect(entry(set, 1)!.source[0]).toEqual(cw[0]);
  });

  test('editing goes source in, source out, round after round', () => {
    let set = insert(emptyWorldSet, 1, level, rect(0, 0, 10, 10)).set;

    for (let k = 1; k <= 5; k++) {
      set = update(set, 1, rect(k, 0, 10, 10)).set;
      expect(entry(set, 1)!.source).toEqual(rect(k, 0, 10, 10));
    }
  });

  test('picking finds the polygons whose box covers a point', () => {
    const set = fromEntries([
      { id: 1, type: level, shape: rect(0, 0, 10, 10) },
      { id: 2, type: level, shape: rect(50, 50, 10, 10) },
    ]);

    expect(overlapping(set, box(1, 1, 2, 2))).toEqual([1]);
    expect(overlapping(set, box(51, 51, 52, 52))).toEqual([2]);
    expect(overlapping(set, box(100, 100, 101, 101))).toEqual([]);
  });
});

describe('incremental equals rebuilt', () => {
  /** The property the whole module exists for: whatever route the set was
   * reached by, it holds what a rebuild from the same sources would. */
  function same(set: WorldSet, what: string) {
    const fresh = recomputed(set);

    expect(length(set), what).toBeCloseTo(length(fresh), 6);
    expect(pieces(set).length, what).toBe(pieces(fresh).length);
  }

  test('after a move that leaves the neighbours alone', () => {
    let set = fromEntries([
      { id: 1, type: level, shape: rect(0, 0, 10, 10) },
      { id: 2, type: level, shape: rect(100, 0, 10, 10) },
    ]);

    set = update(set, 1, rect(2, 2, 10, 10)).set;
    same(set, 'apart');
  });

  test('after a move into and back out of an overlap', () => {
    let set = fromEntries([
      { id: 1, type: level, shape: rect(0, 0, 10, 10) },
      { id: 2, type: level, shape: rect(40, 0, 10, 10) },
    ]);

    set = update(set, 1, rect(35, 0, 10, 10)).set;
    same(set, 'overlapping');

    set = update(set, 1, rect(0, 0, 10, 10)).set;
    same(set, 'apart again');
  });

  test('across a chain, where the edit never touches the far end', () => {
    // A-B-C: moving A must leave C's share alone and still come out right.
    let set = fromEntries([
      { id: 1, type: level, shape: rect(0, 0, 10, 10) },
      { id: 2, type: level, shape: rect(8, 0, 10, 10) },
      { id: 3, type: level, shape: rect(16, 0, 10, 10) },
    ]);

    const far = pieces(set).filter(p => p.source === 3).map(p => p.id);

    set = update(set, 1, rect(1, 0, 10, 10)).set;

    expect(pieces(set).filter(p => p.source === 3).map(p => p.id)).toEqual(far);
    same(set, 'chain');
  });

  test('after inserting and removing, over and over', () => {
    let set = fromEntries([{ id: 1, type: level, shape: rect(0, 0, 20, 20) }]);

    for (let k = 0; k < 6; k++) {
      set = insert(set, 2, solid, rect(5 + k, 5, 4, 4)).set;
      same(set, `solid in, round ${k}`);

      set = remove(set, 2).set;
      same(set, `solid out, round ${k}`);
    }
  });

  test('several edits at once match the same edits rebuilt', () => {
    let set = fromEntries([
      { id: 1, type: level, shape: rect(0, 0, 10, 10) },
      { id: 2, type: level, shape: rect(8, 0, 10, 10) },
      { id: 3, type: solid, shape: rect(4, 4, 3, 3) },
    ]);

    const edits: Edit[] = [
      { op: 'update', id: 1, shape: rect(1, 1, 10, 10) },
      { op: 'update', id: 2, shape: rect(9, 1, 10, 10) },
      { op: 'remove', id: 3 },
    ];

    set = apply(set, edits).set;
    same(set, 'batch');
  });
});

describe('a polygon with nothing left', () => {
  // The editor's erosion is a projection that may erase a polygon entirely: a
  // room eroded past its own middle resolves to no rings at all. Scrubbing the
  // depth back has to bring it straight back, including inside a single drag,
  // which is where this was first seen — the yellow overlay went and stayed
  // gone for the rest of the session.

  test('an update to nothing empties its share of the outline', () => {
    let set = insert(emptyWorldSet, 1, level, rect(0, 0, 10, 10)).set;

    set = update(set, 1, []).set;

    expect(outline(set)).toEqual([]);
    expect(length(set)).toBeCloseTo(0, 6);
  });

  test('and an update back brings it back', () => {
    let set = insert(emptyWorldSet, 1, level, rect(0, 0, 10, 10)).set;

    set = update(set, 1, []).set;
    set = update(set, 1, rect(0, 0, 10, 10)).set;

    expect(length(set)).toBeCloseTo(40, 6);
    expect(pieces(set).every(p => p.source === 1)).toBe(true);
  });

  test('scrubbing a depth down through nothing and back, one step at a time', () => {
    // A drag, frame by frame. Every step goes in as an update, because from
    // the caller's side the polygon never stopped existing.
    let set = insert(emptyWorldSet, 1, level, rect(0, 0, 100, 100)).set;

    const at = (d: number): Shape => (d >= 50 ? [] : rect(d, d, 100 - 2 * d, 100 - 2 * d));

    for (const d of [0, 10, 20, 30, 40, 45, 49, 50, 60, 70, 60, 50, 49, 40, 20, 0]) {
      set = update(set, 1, at(d)).set;
    }

    expect(length(set)).toBeCloseTo(400, 6);
  });

  test('the entry keeps its id and kind while it has no geometry', () => {
    // The kind is the thing an update cannot supply, so losing it is what made
    // the polygon unrecoverable. A `solid` has to come back a `solid`.
    let set = fromEntries([
      { id: 1, type: level, shape: rect(0, 0, 20, 20) },
      { id: 2, type: solid, shape: rect(5, 5, 10, 10) },
    ]);

    set = update(set, 2, []).set;

    expect(entry(set, 2)?.kind).toBe(solid);
    expect(entry(set, 2)?.shape).toEqual([]);

    // Nothing to bury the room, so the room is whole.
    expect(length(set)).toBeCloseTo(80, 6);

    set = update(set, 2, rect(5, 5, 10, 10)).set;

    // And back to a room with a pillar taken out of the middle of it.
    expect(length(set)).toBeCloseTo(120, 6);
  });

  test('it is not returned by an overlap search while it is empty', () => {
    let set = insert(emptyWorldSet, 1, level, rect(0, 0, 10, 10)).set;

    expect(overlapping(set, box(0, 0, 10, 10))).toEqual([1]);

    set = update(set, 1, []).set;

    expect(overlapping(set, box(0, 0, 10, 10))).toEqual([]);
  });

  test('removing one that is already empty leaves the set alone', () => {
    let set = fromEntries([
      { id: 1, type: level, shape: rect(0, 0, 10, 10) },
      { id: 2, type: level, shape: rect(100, 0, 10, 10) },
    ]);

    set = update(set, 2, []).set;
    set = remove(set, 2).set;

    expect(entry(set, 2)).toBeUndefined();
    expect(length(set)).toBeCloseTo(40, 6);
  });
});

describe('the diff', () => {
  test('replaying every diff lands where the set is', () => {
    let set = emptyWorldSet;
    let state = new Map<PieceId, Point[]>();

    const step = (edits: Edit[]) => {
      const { set: after, diff } = apply(set, edits);

      set = after;
      state = replay(state, diff);

      expect(new Set(state.keys())).toEqual(new Set(held(set).keys()));
    };

    step([{ op: 'insert', id: 1, type: level, shape: rect(0, 0, 10, 10) }]);
    step([{ op: 'insert', id: 2, type: level, shape: rect(5, 0, 10, 10) }]);
    step([{ op: 'update', id: 1, shape: rect(0, 2, 10, 10) }]);
    step([{ op: 'insert', id: 3, type: solid, shape: rect(6, 3, 2, 2) }]);
    step([{ op: 'remove', id: 2 }]);
    step([{ op: 'remove', id: 1 }]);
    step([{ op: 'remove', id: 3 }]);

    expect(pieces(set)).toEqual([]);
  });

  test('a polygon the edit never reaches keeps its pieces', () => {
    let set = fromEntries([
      { id: 1, type: level, shape: rect(0, 0, 10, 10) },
      { id: 2, type: level, shape: rect(200, 0, 10, 10) },
    ]);

    const far = pieces(set).filter(p => p.source === 2).map(p => p.id);
    const { diff } = apply(set, [{ op: 'update', id: 1, shape: rect(1, 0, 10, 10) }]);

    expect(diff.removed).not.toEqual(expect.arrayContaining(far));
    expect(diff.inserted.every(p => p.source !== 2)).toBe(true);
  });

  test('removing a polygon frees its neighbour, and says so', () => {
    let set = fromEntries([
      { id: 1, type: level, shape: rect(0, 0, 20, 20) },
      { id: 2, type: level, shape: rect(10, 0, 20, 20) },
    ]);

    const { set: after, diff } = remove(set, 2);

    expect(diff.inserted.some(p => p.source === 1)).toBe(true);
    expect(length(after)).toBeCloseTo(80, 6);
  });

  test('piece ids are never handed out twice', () => {
    let set = fromEntries([{ id: 1, type: level, shape: rect(0, 0, 10, 10) }]);
    const seen = new Set<PieceId>(pieces(set).map(p => p.id));

    for (let k = 1; k <= 8; k++) {
      const { set: after, diff } = update(set, 1, rect(k, 0, 10, 10));

      set = after;

      for (const p of diff.inserted) {
        expect(seen.has(p.id)).toBe(false);
        seen.add(p.id);
      }
    }
  });
});

describe('runs', () => {
  test('every piece belongs to exactly one source, and it exists', () => {
    const set = fromEntries([
      { id: 1, type: level, shape: rect(0, 0, 10, 10) },
      { id: 2, type: level, shape: rect(8, 0, 10, 10) },
      { id: 3, type: solid, shape: rect(4, 4, 2, 2) },
    ]);

    for (const p of pieces(set)) {
      expect(entry(set, p.source)).toBeDefined();
    }
  });

  test('a run is open and carries at least one edge', () => {
    const set = fromEntries([
      { id: 1, type: level, shape: rect(0, 0, 10, 10) },
      { id: 2, type: level, shape: rect(5, 0, 10, 10) },
    ]);

    for (const p of pieces(set)) {
      expect(p.points.length).toBeGreaterThanOrEqual(2);
    }
  });

  test('every run lies on its own polygon and nowhere else', () => {
    const set = fromEntries([
      { id: 1, type: level, shape: rect(0, 0, 10, 10) },
      { id: 2, type: level, shape: rect(6, 0, 10, 10) },
    ]);

    for (const p of pieces(set)) {
      const b = entry(set, p.source)!.box;

      for (const q of p.points) {
        expect(q.x).toBeGreaterThanOrEqual(b.minX - 1e-6);
        expect(q.x).toBeLessThanOrEqual(b.maxX + 1e-6);
        expect(q.y).toBeGreaterThanOrEqual(b.minY - 1e-6);
        expect(q.y).toBeLessThanOrEqual(b.maxY + 1e-6);
      }
    }
  });
});
