import { describe, expect, test } from 'vitest';
import { Point } from '@ce/game/world';
import {
  Frame,
  Span,
  TOLERANCE,
  bakeAll,
  bakeSpan,
  stretchAt,
  pruned,
  sample,
  spanAt,
  truth,
} from './bake';
import {
  TOP,
  addPolygon,
  addVertex,
  csg,
  editAt,
  removeVertices,
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
    const added = addPolygon(world, type, points, 0, TOP);

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
  return length(runs.map(points => ({ id: 0, points, corner: points.map(() => true) })));
}

/** The set the editor draws at a version, for the bake to be checked against. */
function editorAt(world: World, v: VersionId): number {
  return lengthOf(csg(world, v));
}

/**
 * The worst the replay is ever wrong across a span, against the CSG worked out
 * directly at the same instant.
 *
 * This is the test that matters. Everything else here is about the machinery;
 * this is about whether the game would draw the right thing, and it is what
 * caught both the signature scan's blind spot and the crossings sliding.
 */
function drift(world: World, from = 0, steps = 40): number {
  const span = run(bakeSpan(world, from));
  let worst = 0;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;

    worst = Math.max(worst, Math.abs(length(sample(span, t)) - length(truth(world, from, t))));
  }

  return worst;
}

/** Every t any track was cut at, in order and without repeats: the span's
 * keyframes, as one list. */
function cut(span: Span): number[] {
  const at = new Set<number>();

  for (const track of span.tracks) {
    for (const s of track.stretches) at.add(s.t0);
  }

  return [...at].sort((p, q) => p - q);
}

/** Where the span was cut, rounded to something a test can name. */
function cuts(world: World, from = 0): number[] {
  const span = run(bakeSpan(world, from));

  return cut(span).slice(1).map(t => Number(t.toFixed(4)));
}

/** What the bake says its own error was, which is the number that matters. */
function worst(world: World, from = 0): number {
  return run(bakeSpan(world, from)).worst;
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

    expect(span.tracks.every(t => t.stretches.length === 1)).toBe(true);
    expect(span.worst).toBe(0);
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

describe('a ring is cut the same way twice', () => {
  test('the two ends of a stretch agree about where a closed ring starts', () => {
    // A run that closes on itself comes back cut wherever the arrangement's
    // walk began, and that is not a fact about the ring: two readings of one
    // pillar can hand it back cut at different corners. The two ends of a
    // stretch are paired point for point, so a ring out of phase by one drags
    // every corner toward its neighbour — half way across, a square inscribed
    // in the pillar at forty-five degrees.
    const { world, ids } = drawn(
      ['level', rect(-200, -200, 500, 400)],
      ['solid', rect(-100, -100, 60, 60)],
      ['solid', rect(100, -100, 60, 60)],
    );

    const w = transformed(world, 1, ids[1], { erosion: 8 });

    for (const track of run(bakeSpan(w, 0)).tracks) {
      for (const stretch of track.stretches) {
        stretch.a.forEach((one, i) => {
          const two = stretch.b[i];

          if (two === undefined || two.points.length !== one.points.length) return;

          const n = one.points.length;
          const off = (k: number) => one.points.reduce((sum, p, j) => {
            const q = two.points[(j + k) % n];

            return sum + Math.hypot(p.x - q.x, p.y - q.y);
          }, 0);

          // Index for index is the best the two ends can be lined up. Any other
          // phase fitting better means they were cut at different corners.
          for (let k = 1; k < n; k++) expect(off(k)).toBeGreaterThanOrEqual(off(0));
        });
      }
    }
  });
});

describe('a track covers the span exactly once', () => {
  // What the shader needs and cannot work out for itself: at any instant there
  // is one stretch to draw, never none and never two. Converging on an event
  // leaves a hair of a gap; `abutting` closes it, because a fixed window in the
  // shader cannot — the stretches beside an event are narrower than any window
  // wide enough to cover the gaps, so it drew both sides of the event at once.
  const covers = (world: World) => {
    const span = run(bakeSpan(world, 0));

    for (const track of span.tracks) {
      expect(track.stretches[0].t0).toBe(0);
      expect(track.stretches[track.stretches.length - 1].t1).toBe(1);

      for (let i = 1; i < track.stretches.length; i++) {
        expect(track.stretches[i].t0).toBe(track.stretches[i - 1].t1);
      }
    }
  };

  test('two polygons meeting exactly, one of them eroding away from it', () => {
    const { world, ids } = drawn(
      ['level', rect(0, 0, 100, 100)],
      ['level', rect(100, 0, 100, 100)],
    );

    covers(transformed(world, 1, ids[0], { erosion: 20 }));
  });

  test('one polygon sliding into another', () => {
    const { world, ids } = drawn(
      ['level', rect(0, 0, 200, 100)],
      ['level', rect(0, 200, 40, 100)],
    );

    covers(transformed(world, 1, ids[1], { translation: { x: 0, y: -140 } }));
  });

  test('the instant two stretches share belongs to the later one', () => {
    // Half-open, because both readers have to agree about it and the shader
    // decides per vertex with nothing but its own range to go on. Claimed by
    // both, a frame landing exactly on a boundary draws the topology from
    // either side of an event at once — and a clock lands exactly on one often,
    // the bake's cuts being dyadic and a steady rate landing on dyadic instants.
    const { world, ids } = drawn(
      ['level', rect(0, 0, 200, 100)],
      ['level', rect(0, 200, 40, 100)],
    );

    const w = transformed(world, 1, ids[1], { translation: { x: 0, y: -140 } });

    for (const track of run(bakeSpan(w, 0)).tracks) {
      for (let i = 1; i < track.stretches.length; i++) {
        expect(stretchAt(track, track.stretches[i].t0)).toBe(track.stretches[i]);
      }

      // Except the last, which keeps its end: nothing follows it to take it on.
      const last = track.stretches[track.stretches.length - 1];

      expect(stretchAt(track, 1)).toBe(last);
    }
  });
});

describe('keyframes', () => {
  test('a room pinching in two is cut where the neck closes', () => {
    // Two rooms joined by a neck 40 across, so it pinches at a depth of 20 —
    // four fifths of the way to the 25 the version asks for.
    const { world, ids } = drawn(
      ['level', rect(0, 0, 200, 60)],
      ['level', rect(80, 60, 40, 40)],
      ['level', rect(0, 100, 200, 60)],
    );

    let w = world;
    for (const id of ids) w = transformed(w, 1, id, { erosion: 25 });

    expect(cuts(w)).toContain(0.8);
    expect(worst(w)).toBeLessThan(TOLERANCE);
    expect(drift(w)).toBeLessThan(TOLERANCE);
  });

  test('one polygon sliding through another is cut where it arrives and where it leaves', () => {
    const { world, ids } = drawn(
      ['level', rect(-300, -40, 200, 80)],
      ['level', rect(-100, -200, 80, 400)],
    );

    const w = transformed(world, 1, ids[0], { translation: { x: 240, y: 0 } });

    expect(cuts(w)).toContain(0.3333);
    expect(cuts(w)).toContain(0.8333);
    expect(drift(w)).toBeLessThan(TOLERANCE);
  });

  test('polygons drawn edge to edge are cut the instant one of them erodes', () => {
    // At rest they share an edge exactly, and the moment either shrinks they do
    // not. That is a moment the arrangement changes, and the version before it
    // is the one that renders the touching geometry.
    const { world, ids } = drawn(
      ['level', rect(0, 0, 100, 100)],
      ['level', rect(100, 0, 100, 100)],
    );

    const w = transformed(world, 1, ids[0], { erosion: 20 });

    const first = run(bakeSpan(w, 0)).tracks[0].stretches[0];

    // An instant at the start, holding the touching geometry. It carries as far
    // as the middle of the gap the convergence left, rather than having no
    // width at all — see `abutting` — and either end of it is the same
    // geometry, which is what makes it an instant.
    expect(first.t0).toBe(0);
    expect(first.t1).toBeLessThan(1e-4);
    expect(first.a).toBe(first.b);
    expect(drift(w)).toBeLessThan(TOLERANCE);
  });

  test('a polygon eroded away entirely is cut where it goes', () => {
    const { world, ids } = drawn(['level', rect(0, 0, 100, 100)]);
    const w = transformed(world, 1, ids[0], { erosion: 80 });

    const span = run(bakeSpan(w, 0));

    expect(span.tracks[0].stretches.length).toBeGreaterThan(1);
    expect(length(sample(span, 1))).toBeCloseTo(0, 6);
  });

  test('a polygon born into the later version appears at the boundary', () => {
    const { world } = drawn(['level', rect(0, 0, 100, 100)]);
    const added = addPolygon(world, 'level', rect(300, 300, 100, 100), 1, TOP);

    const span = run(bakeSpan(added.world, 0));

    expect(length(sample(span, 0))).toBeCloseTo(400, 6);
    expect(length(sample(span, 0.999))).toBeCloseTo(400, 6);
    expect(length(sample(span, 1))).toBeCloseTo(800, 6);
  });
});

describe('a pillar turning inside a wall', () => {
  // The case the doc singles out, and the one that showed the first version of
  // this was built on the wrong question. The pillar always cuts exactly two
  // crossings, so nothing about the arrangement's *size* ever changes; what
  // changes is which edge owns each crossing, as corner after corner sweeps
  // through. A search that watches counts sees nothing at all here.
  function wall(): World {
    const { world, ids } = drawn(
      ['level', rect(-200, -60, 400, 120)],
      ['level', rect(-40, -200, 80, 400)],
    );

    return transformed(world, 1, ids[1], { rotation: Math.PI / 3 });
  }

  test('the hole never closes and the geometry never tears', () => {
    expect(worst(wall())).toBeLessThan(TOLERANCE);
  });

  test('the crossings slide where they should, all the way across', () => {
    expect(drift(wall())).toBeLessThan(TOLERANCE);
  });

  test('and the same with a solid pillar, which subtracts instead', () => {
    const { world, ids } = drawn(
      ['level', rect(-200, -60, 400, 120)],
      ['solid', rect(-40, -200, 80, 400)],
    );

    expect(drift(transformed(world, 1, ids[1], { rotation: Math.PI / 3 }))).toBeLessThan(TOLERANCE);
  });
});

describe('the replay against the CSG worked out directly', () => {
  test('erosion', () => {
    const { world, ids } = drawn(['level', rect(0, 0, 200, 200)]);

    expect(drift(transformed(world, 1, ids[0], { erosion: 60 }))).toBeLessThan(TOLERANCE);
  });

  test('a turn', () => {
    const { world, ids } = drawn(['level', rect(-100, -100, 200, 200)]);

    expect(drift(transformed(world, 1, ids[0], { rotation: Math.PI / 2 }))).toBeLessThan(TOLERANCE);
  });

  test('a squash, which is where the scale stops being uniform', () => {
    const { world, ids } = drawn(['level', rect(-100, -100, 200, 200)]);

    expect(drift(transformed(world, 1, ids[0], { scale: { x: 0.3, y: 2 } }))).toBeLessThan(TOLERANCE);
  });

  test('a turn and an erosion sharing a stretch', () => {
    const { world, ids } = drawn(['level', rect(0, 0, 120, 120)]);

    expect(drift(transformed(world, 1, ids[0], { erosion: 22, rotation: 0.4 })))
      .toBeLessThan(TOLERANCE);
  });

  test('sliding and turning at once, which is where the closed form gives up', () => {
    const { world, ids } = drawn(
      ['level', rect(-300, -40, 200, 80)],
      ['level', rect(-100, -200, 80, 400)],
    );

    const w = transformed(world, 1, ids[0], {
      translation: { x: 240, y: 0 },
      rotation: 0.6,
    });

    expect(drift(w)).toBeLessThan(TOLERANCE);
    expect(worst(w)).toBeLessThan(TOLERANCE);
  });

  test('a nudge on its own', () => {
    const { world, ids } = drawn(['level', rect(0, 0, 120, 120)]);
    const it = resolveAt(world, 1).find(r => r.id === ids[0])!;
    const edit = editAt(world, 1, ids[0], 0);
    const vertices = new Map(edit.vertices);

    vertices.set(it.polygon.points[2].id, { x: 90, y: 40 });

    expect(drift(withEdit(world, 1, ids[0], { ...edit, vertices }))).toBeLessThan(TOLERANCE);
  });

  test('a nudge and an erosion together, which nothing analytic can cut', () => {
    // A corner moves along its mitre, and the mitre is a function of the corner
    // *angle*. Hold the ring still and the angle is constant, so the corner
    // travels in a straight line and interpolating its two ends is exact.
    // Nudge the ring while it erodes and the angle turns, so the true path
    // bends and the straight line between the ends of a stretch is a chord
    // across the bend.
    //
    // Nothing discrete happens, so there is no event to find and no keyframe
    // that fixes it — this is the case that decided the bake should measure
    // rather than prove. Splitting until the chord is close enough costs a few
    // extra stretches and answers it outright.
    const { world, ids } = drawn(['level', rect(0, 0, 120, 120)]);
    const it = resolveAt(world, 1).find(r => r.id === ids[0])!;
    const edit = editAt(world, 1, ids[0], 0);
    const vertices = new Map(edit.vertices);

    vertices.set(it.polygon.points[2].id, { x: 90, y: 40 });

    const nudged = withEdit(world, 1, ids[0], { ...edit, vertices });
    const w = transformed(nudged, 1, ids[0], { erosion: 22 });

    expect(drift(w)).toBeLessThan(TOLERANCE);
    expect(run(bakeSpan(w, 0)).tracks[0].stretches.length).toBeGreaterThan(1);
  });
});

describe('a turn goes round its pivot, not round the origin', () => {
  // The transform a rotation gesture leaves behind, for a turn of `angle`
  // about `at`: the pivot carried round to where the rotation would have sent
  // it, then put back. This is `turned` in the canvas, starting from identity.
  function about(at: Point, angle: number): Partial<Transform> {
    const c = Math.cos(angle), s = Math.sin(angle);

    return {
      rotation: angle,
      translation: {
        x: at.x - (at.x * c - at.y * s),
        y: at.y - (at.x * s + at.y * c),
      },
    };
  }

  function reach(frame: Frame, at: Point): { near: number, far: number } {
    let near = Infinity, far = 0;

    for (const run of frame) {
      for (const p of run.points) {
        const d = Math.hypot(p.x - at.x, p.y - at.y);

        near = Math.min(near, d);
        far = Math.max(far, d);
      }
    }

    return { near, far };
  }

  /** Every distance to the pivot, at its widest and its narrowest, across the
   * whole morph. A turn about a point moves nothing towards or away from it. */
  function held(world: World, at: Point): number {
    const start = reach(truth(world, 0, 0), at);
    let off = 0;

    for (let i = 0; i <= 40; i++) {
      const now = reach(truth(world, 0, i / 40), at);

      off = Math.max(off, Math.abs(now.near - start.near), Math.abs(now.far - start.far));
    }

    return off;
  }

  test('about the middle', () => {
    const { world, ids } = drawn(['level', rect(400, 300, 200, 120)]);
    const at = { x: 500, y: 360 };

    expect(held(transformed(world, 1, ids[0], about(at, Math.PI / 2)), at)).toBeLessThan(1e-6);
  });

  test('about a corner, well away from the origin', () => {
    const { world, ids } = drawn(['level', rect(400, 300, 200, 120)]);
    const at = { x: 400, y: 300 };

    expect(held(transformed(world, 1, ids[0], about(at, 1.1)), at)).toBeLessThan(1e-6);
  });

  test('and two turns about different pivots agree on a third', () => {
    // Composing them gives a rotation about neither, and the morph has to find
    // it rather than be told: nothing stores a pivot.
    const { world, ids } = drawn(['level', rect(400, 300, 200, 120)]);
    const one = about({ x: 500, y: 360 }, 0.7);
    const two = about({ x: 400, y: 300 }, 0.5);

    const c = Math.cos(0.5), s = Math.sin(0.5);
    const both: Partial<Transform> = {
      rotation: 1.2,
      translation: {
        x: two.translation!.x + one.translation!.x * c - one.translation!.y * s,
        y: two.translation!.y + one.translation!.x * s + one.translation!.y * c,
      },
    };

    // Where the composite holds still, which is neither of the two it was made
    // from, and which nothing wrote down.
    const c2 = Math.cos(1.2), s2 = Math.sin(1.2);
    const det = (1 - c2) * (1 - c2) + s2 * s2;
    const at = {
      x: ((1 - c2) * both.translation!.x - s2 * both.translation!.y) / det,
      y: (s2 * both.translation!.x + (1 - c2) * both.translation!.y) / det,
    };

    expect(at.x).not.toBeCloseTo(400, 1);
    expect(at.x).not.toBeCloseTo(500, 1);

    const w = transformed(world, 1, ids[0], both);

    expect(held(w, at)).toBeLessThan(1e-6);
    expect(drift(w)).toBeLessThan(TOLERANCE);
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

describe('a corner coming or going across a span', () => {
  // The editor's rule is that nothing a layer does reaches back past itself, so
  // a ring can have four corners at one version and five at the next. The span
  // between them still has to be one continuous move: the corner is there at
  // both ends of it, sitting on the edge it grows out of at the end where it is
  // not real, which is the same shape as not being there.
  //
  // `editorAt` goes through `csg(...)` rather than through the
  // bake's own `moving`, so these are checked against the editor rather than
  // against the machinery under test.

  test('adding one leaves the version before it exactly as it was', () => {
    const { world, ids } = drawn(['level', rect(-100, -100, 200, 200)]);
    const before = editorAt(world, 0);

    const it = resolveAt(world, 1).find(r => r.id === ids[0])!;
    const grown = addVertex(world, 1, it, 0, { x: 0, y: -100 }).world;

    expect(editorAt(grown, 0)).toBeCloseTo(before, 6);
    expect(resolveAt(grown, 0).find(r => r.id === ids[0])!.corners.length).toEqual(4);
    expect(resolveAt(grown, 1).find(r => r.id === ids[0])!.corners.length).toEqual(5);
  });

  test('the span agrees with the editor at both ends of it', () => {
    const { world, ids } = drawn(['level', rect(-100, -100, 200, 200)]);
    const it = resolveAt(world, 1).find(r => r.id === ids[0])!;
    const grown = addVertex(world, 1, it, 0, { x: 0, y: -100 }).world;

    // Pull the new corner off the edge, so the span has something to animate.
    const now = resolveAt(grown, 1).find(r => r.id === ids[0])!;
    const where = now.corners.findIndex(c => c.birth === 1);
    const edit = editAt(grown, 1, ids[0], now.erosion);
    const vertices = new Map(edit.vertices);
    vertices.set(now.corners[where].id, { x: 0, y: -80 });
    const pulled = withEdit(grown, 1, ids[0], { ...edit, vertices });

    const span = run(bakeSpan(pulled, 0));

    expect(length(sample(span, 0))).toBeCloseTo(editorAt(pulled, 0), 6);
    expect(length(sample(span, 1))).toBeCloseTo(editorAt(pulled, 1), 6);
  });

  test('a corner arriving is one stretch: it is a move, not an event', () => {
    // The whole point of putting it on the edge at the near end. Were it to
    // appear part way through, the span would have to be cut at that instant
    // and the outline would jump.
    const { world, ids } = drawn(['level', rect(-100, -100, 200, 200)]);
    const it = resolveAt(world, 1).find(r => r.id === ids[0])!;
    const grown = addVertex(world, 1, it, 0, { x: 0, y: -100 }).world;

    const now = resolveAt(grown, 1).find(r => r.id === ids[0])!;
    const where = now.corners.findIndex(c => c.birth === 1);
    const edit = editAt(grown, 1, ids[0], now.erosion);
    const vertices = new Map(edit.vertices);
    vertices.set(now.corners[where].id, { x: 0, y: -80 });
    const pulled = withEdit(grown, 1, ids[0], { ...edit, vertices });

    const span = run(bakeSpan(pulled, 0));

    expect(span.tracks.every(t => t.stretches.length === 1)).toBe(true);
    expect(drift(pulled)).toBeLessThan(TOLERANCE);
  });

  test('the outline grows steadily rather than in one step', () => {
    // A corner that appeared all at once would show up as the whole of the
    // change happening between two neighbouring instants.
    const { world, ids } = drawn(['level', rect(-100, -100, 200, 200)]);
    const it = resolveAt(world, 1).find(r => r.id === ids[0])!;
    const grown = addVertex(world, 1, it, 0, { x: 0, y: -100 }).world;

    const now = resolveAt(grown, 1).find(r => r.id === ids[0])!;
    const where = now.corners.findIndex(c => c.birth === 1);
    const edit = editAt(grown, 1, ids[0], now.erosion);
    const vertices = new Map(edit.vertices);
    vertices.set(now.corners[where].id, { x: 0, y: -80 });
    const pulled = withEdit(grown, 1, ids[0], { ...edit, vertices });

    const span = run(bakeSpan(pulled, 0));

    const steps: number[] = [];
    for (let i = 0; i <= 40; i++) steps.push(length(sample(span, i / 40)));

    const biggest = Math.max(...steps.slice(1).map((v, i) => Math.abs(v - steps[i])));
    const total = Math.abs(steps[steps.length - 1] - steps[0]);

    expect(total).toBeGreaterThan(1);
    // No single frame carries more than a small share of the whole change.
    expect(biggest).toBeLessThan(total * 0.2);
  });

  test('removing one leaves the versions before it exactly as they were', () => {
    const { world, ids } = drawn(['level', [
      { x: -100, y: -100 }, { x: 0, y: -170 }, { x: 100, y: -100 },
      { x: 100, y: 100 }, { x: -100, y: 100 },
    ]]);
    const before = editorAt(world, 0);
    const going = world.polygons.get(ids[0])!.points[1].id;
    const cut = removeVertices(world, 1, [going]);

    expect(editorAt(cut, 0)).toBeCloseTo(before, 6);

    const span = run(bakeSpan(cut, 0));

    expect(length(sample(span, 0))).toBeCloseTo(editorAt(cut, 0), 6);
    expect(length(sample(span, 1))).toBeCloseTo(editorAt(cut, 1), 6);
    expect(span.tracks.every(t => t.stretches.length === 1)).toBe(true);
  });
});

describe('a corner arriving right beside one that is leaving', () => {
  /**
   * The case that broke: the two are neighbours in the ring, so the corner
   * present at only one end is the very one the other needs to lean on.
   *
   * Anchoring on the nearest corner both ends have steps straight over it, onto
   * a chord across the polygon's inside — and the ring picks up a spur that
   * dives through the middle of the shape and back out. It shows up as a span
   * whose far end is not the shape the editor draws there.
   */
  function beside(): { world: World, ids: PolygonId[] } {
    const { world, ids } = drawn(['level', rect(-100, -100, 200, 200)]);
    const corners = world.polygons.get(ids[0])!.points;

    // A corner into the edge leaving the first, and the second one out: they
    // end up adjacent, added and removed by the same version.
    const it = resolveAt(world, 1).find(r => r.id === ids[0])!;
    const grown = addVertex(world, 1, it, 0, { x: 100, y: -20 }).world;

    return { world: removeVertices(grown, 1, [corners[1].id]), ids };
  }

  test('the span ends on the shape the editor draws, not beside it', () => {
    const { world } = beside();
    const span = run(bakeSpan(world, 0));

    expect(length(sample(span, 0))).toBeCloseTo(editorAt(world, 0), 6);
    expect(length(sample(span, 1))).toBeCloseTo(editorAt(world, 1), 6);
  });

  test('and gets there in one stretch, without a detour', () => {
    // A ring that folds through itself part way makes the outline wander far
    // outside the range its two ends bracket, and the bake cuts and cuts trying
    // to follow it. One stretch says the path is the straight one.
    const { world } = beside();
    const span = run(bakeSpan(world, 0));

    const ends = [length(sample(span, 0)), length(sample(span, 1))];
    const lo = Math.min(...ends), hi = Math.max(...ends);

    for (let i = 0; i <= 40; i++) {
      const now = length(sample(span, i / 40));

      // Room for the corner genuinely moving, but nowhere near enough for a
      // spur across the polygon.
      expect(now).toBeGreaterThan(lo - (hi - lo));
      expect(now).toBeLessThan(hi + (hi - lo));
    }

    expect(span.tracks.every(t => t.stretches.length === 1)).toBe(true);
    expect(drift(world)).toBeLessThan(TOLERANCE);
  });

  test('the corner that arrives starts on the boundary, not across it', () => {
    // Directly: at the near end every point of the interpolated ring has to sit
    // on the ring the editor resolves there. A chord anchor puts one inside.
    const { world, ids } = beside();
    const span = run(bakeSpan(world, 0));
    const drawn0 = resolveAt(world, 0).find(r => r.id === ids[0])!.source;

    const onRing = (p: Point): number => {
      let best = Infinity;

      for (let i = 0; i < drawn0.length; i++) {
        const a = drawn0[i], b = drawn0[(i + 1) % drawn0.length];
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = dx * dx + dy * dy;
        const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));

        best = Math.min(best, Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y));
      }

      return best;
    };

    for (const run of sample(span, 0)) {
      for (const p of run.points) expect(onRing(p)).toBeLessThan(1e-6);
    }
  });
});
