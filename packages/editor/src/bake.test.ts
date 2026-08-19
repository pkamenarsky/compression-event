import { describe, expect, test } from 'vitest';
import { Point } from '@ce/game/world';
import {
  Frame,
  Span,
  bakeAll,
  bakeSpan,
  pruned,
  sample,
  spanAt,
} from './bake';
import {
  addPolygon,
  csg,
  editAt,
  resolveAt,
  withEdit,
} from './scene';
import {
  EMPTY_BAKE,
} from './bake';
import {
  PolygonId,
  PolygonType,
  Transform,
  VersionId,
  World,
  emptyWorld,
} from './types';

function rect(x: number, y: number, w: number, h: number): Point[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

function drawn(...specs: [PolygonType, Point[]][]): { world: World, ids: PolygonId[] } {
  let world = emptyWorld();
  const ids: PolygonId[] = [];

  for (const [type, points] of specs) {
    const added = addPolygon(world, type, points, 0);

    world = added.world;
    ids.push(added.id);
  }

  return { world, ids };
}

function transformed(
  world: World,
  v: VersionId,
  id: PolygonId,
  t: Partial<Transform>,
): World {
  const it = resolveAt(world, v).find(r => r.id === id)!;
  const edit = editAt(world, v, id, it.erosion);

  return withEdit(world, v, id, { ...edit, transform: { ...edit.transform, ...t } });
}

/** The generator run to the end, which is what a test wants and the editor
 * deliberately does not do. */
function run<T>(g: Generator<number, T, void>): T {
  let step = g.next();

  while (!step.done) step = g.next();

  return step.value;
}

/** Total length of everything in a frame, which is enough of a fingerprint for
 * geometry two paths are supposed to agree on. */
function length(frame: Frame): number {
  let out = 0;

  for (const run of frame) {
    for (let i = 1; i < run.points.length; i++) {
      out += Math.hypot(
        run.points[i].x - run.points[i - 1].x,
        run.points[i].y - run.points[i - 1].y,
      );
    }
  }

  return out;
}

function lengthOf(runs: Point[][]): number {
  return length(runs.map(points => ({ id: 0, points })));
}

/** The set the editor draws at a version, for the bake to be checked against. */
function editorAt(world: World, v: VersionId): number {
  return lengthOf(csg(resolveAt(world, v)));
}

describe('the ends of a span', () => {
  test('agree with the editor at both versions', () => {
    const { world, ids } = drawn(['level', rect(0, 0, 200, 200)]);
    const w = transformed(world, 1, ids[0], { erosion: 30, translation: { x: 40, y: 0 } });

    const span = run(bakeSpan(w, 0));

    expect(length(sample(span, 0))).toBeCloseTo(editorAt(w, 0), 6);
    expect(length(sample(span, 1))).toBeCloseTo(editorAt(w, 1), 6);
  });

  test('a span nothing happens in is one stretch', () => {
    const { world } = drawn(['level', rect(0, 0, 200, 200)]);

    const span = run(bakeSpan(world, 0));

    expect(span.stretches).toHaveLength(1);
    expect(span.stretches[0].torn).toBe(false);
  });
});

describe('interpolation', () => {
  test('is in components, so a turn turns rather than collapsing', () => {
    const { world, ids } = drawn(['level', rect(-100, -100, 200, 200)]);
    const w = transformed(world, 1, ids[0], { rotation: Math.PI / 2 });

    const span = run(bakeSpan(w, 0));

    // Lerping the corner positions instead would pull every one of them a
    // quarter of the way toward the centre.
    const half = sample(span, 0.5);

    expect(length(half)).toBeCloseTo(800, 3);
  });

  test('carries a vertex nudge with it rather than popping at the boundary', () => {
    const { world, ids } = drawn(['level', rect(0, 0, 100, 100)]);

    const it = resolveAt(world, 1).find(r => r.id === ids[0])!;
    const edit = editAt(world, 1, ids[0], 0);
    const vertices = new Map(edit.vertices);

    vertices.set(it.polygon.points[2].id, { x: 100, y: 0 });

    const w = withEdit(world, 1, ids[0], { ...edit, vertices });
    const span = run(bakeSpan(w, 0));

    const at = (t: number) => length(sample(span, t));

    expect(at(0)).toBeCloseTo(400, 6);
    expect(at(1)).toBeCloseTo(editorAt(w, 1), 6);
    expect(at(0.5)).toBeGreaterThan(at(0));
    expect(at(0.5)).toBeLessThan(at(1));
  });
});

describe('keyframes', () => {
  test('an erosion that splits a room in two is cut', () => {
    // A dumbbell: two rooms joined by a neck thin enough to pinch through.
    const { world, ids } = drawn(
      ['level', rect(0, 0, 200, 60)],
      ['level', rect(80, 60, 40, 40)],
      ['level', rect(0, 100, 200, 60)],
    );

    let w = world;
    for (const id of ids) w = transformed(w, 1, id, { erosion: 25 });

    const span = run(bakeSpan(w, 0));

    expect(span.stretches.length).toBeGreaterThan(1);
    expect(span.stretches.every(s => !s.torn)).toBe(true);
  });

  test('a polygon eroded away entirely is cut where it goes', () => {
    const { world, ids } = drawn(['level', rect(0, 0, 100, 100)]);
    const w = transformed(world, 1, ids[0], { erosion: 80 });

    const span = run(bakeSpan(w, 0));

    expect(span.stretches.length).toBeGreaterThan(1);
    expect(length(sample(span, 1))).toBeCloseTo(0, 6);
  });

  test('a polygon born into the later version appears at the boundary', () => {
    const { world } = drawn(['level', rect(0, 0, 100, 100)]);
    const added = addPolygon(world, 'level', rect(300, 300, 100, 100), 1);

    const span = run(bakeSpan(added.world, 0));

    expect(length(sample(span, 0))).toBeCloseTo(400, 6);
    expect(length(sample(span, 0.999))).toBeCloseTo(400, 6);
    expect(length(sample(span, 1))).toBeCloseTo(800, 6);
  });
});

describe('the incremental set', () => {
  test('leaves a polygon the version does not touch out of the work', () => {
    const still: [PolygonType, Point[]][] = Array.from(
      { length: 20 },
      (_unused, i) => ['level', rect(1000 + i * 200, 0, 100, 100)] as [PolygonType, Point[]],
    );

    const { world, ids } = drawn(['level', rect(0, 0, 200, 200)], ...still);
    const w = transformed(world, 1, ids[0], { erosion: 40 });

    const span = run(bakeSpan(w, 0));

    // Twenty polygons that never move, and their share of the outline is
    // identical at every sample. If they were being re-CSG'd this would be the
    // same number either way — what it checks is that the answer is right, and
    // the timing is what the editor shows.
    expect(length(sample(span, 0.5))).toBeGreaterThan(20 * 400);
  });
});

describe('a bake against a world that moved', () => {
  test('is kept while the chain it depends on is untouched', () => {
    const { world, ids } = drawn(['level', rect(0, 0, 200, 200)]);
    const w = transformed(world, 1, ids[0], { erosion: 20 });

    const spans = run(bakeAll(w));
    const bake = { spans, progress: null };

    expect(spanAt(bake, w, 0)).not.toBeNull();
    expect(spanAt(bake, w, 3)).not.toBeNull();
  });

  test('is dropped for every span an edit reached, and no others', () => {
    const { world, ids } = drawn(['level', rect(0, 0, 200, 200)]);
    const w = transformed(world, 1, ids[0], { erosion: 20 });

    const bake = { spans: run(bakeAll(w)), progress: null };

    // v2 changes: the spans 1-2 and 2-3 are what saw it, and so is nothing
    // before them.
    const later = transformed(w, 2, ids[0], { erosion: 35 });

    expect(spanAt(bake, later, 0)).not.toBeNull();
    expect(spanAt(bake, later, 1)).toBeNull();
    expect(spanAt(bake, later, 2)).toBeNull();
    expect(spanAt(bake, later, 3)).toBeNull();

    expect(pruned(bake, later).spans.size).toBe(1);
  });

  test('is dropped downstream when an upstream version changes', () => {
    const { world, ids } = drawn(['level', rect(0, 0, 200, 200)]);
    const w = transformed(world, 3, ids[0], { erosion: 20 });

    const bake = { spans: run(bakeAll(w)), progress: null };
    const early = transformed(w, 0, ids[0], { rotation: 0.3 });

    expect(pruned(bake, early).spans.size).toBe(0);
  });

  test('survives an eye being opened, which changes no geometry', () => {
    const { world, ids } = drawn(['level', rect(0, 0, 200, 200)]);
    const w = transformed(world, 1, ids[0], { erosion: 20 });

    const bake = { spans: run(bakeAll(w)), progress: null };

    const versions = [...w.versions];
    versions[2] = { ...versions[2], visible: false };

    expect(pruned(bake, { ...w, versions }).spans.size).toBe(4);
  });
});

describe('progress', () => {
  test('runs from nothing to everything, in order', () => {
    const { world, ids } = drawn(['level', rect(0, 0, 200, 200)]);
    const w = transformed(world, 1, ids[0], { erosion: 40 });

    const g = bakeAll(w);
    const seen: number[] = [];

    let step = g.next();

    while (!step.done) {
      seen.push(step.value);
      step = g.next();
    }

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBeCloseTo(1, 6);
    expect(seen.every((x, i) => i === 0 || x >= seen[i - 1])).toBe(true);
  });
});
