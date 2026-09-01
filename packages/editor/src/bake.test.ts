import { describe, expect, test } from 'vitest';
import { Point } from '@ce/game/world';
import {
  Frame,
  Origin,
  Span,
  TOLERANCE,
  bakeAll,
  bakeSpan,
  lined,
  pruned,
  sample,
  spanAt,
  stretchAt,
  truth,
} from './bake';
import {
  TOP,
  addPolygon,
  grouped,
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
  EMPTY_TRANSFORM,
  Id,
  PolygonId,
  PolygonType,
  Transform,
  VERSIONS,
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
  id: Id,
  t: Partial<Transform>,
): World {
  // A group has no geometry to read a depth off, and none to inherit either.
  const it = resolveAt(world, v).find(r => r.id === id);
  const edit = editAt(world, v, id, it?.erosion ?? 0);

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
  return length(runs.map(points => ({
    id: 0,
    points,
    corner: points.map(() => true),
    whence: points.map((_p, i) => ({ kind: 'vertex' as const, at: { id: 0, ring: 0, index: i } })),
    fill: false,
  })));
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

describe('two readings of one ring, lined up', () => {
  // A ring of `n` corners of one polygon, walked from `k`. The names are what
  // pairs them, so they are the whole of what the fixture has to get right: the
  // point positions could be anything at all.
  const ring = (n: number, k: number, id = 0) => {
    const at = (i: number) => (i + k) % n;

    return {
      id,
      points: Array.from({ length: n + 1 }, (_p, i) => ({ x: at(i), y: 0 })),
      corner: Array.from({ length: n + 1 }, () => true),
      whence: Array.from({ length: n + 1 }, (_p, i) =>
        ({ kind: 'vertex' as const, at: { id, ring: 0, index: at(i) } })),
      fill: false,
    };
  };

  test('a ring walked from another corner is turned back', () => {
    // The reported case: the same pillar, not moved at all, handed back cut one
    // corner along. Every walk of it comes back in the order the other end has.
    for (let k = 0; k < 4; k++) {
      expect(lined([ring(4, 0)], [ring(4, k)])[0].whence).toEqual(ring(4, 0).whence);
    }
  });

  test('the positions have nothing to do with it', () => {
    // Which is the point of naming them. The two readings here are a long way
    // apart — the shape eroded, or the polygon travelled — and they still pair
    // corner for corner.
    const far = ring(4, 3);

    far.points = far.points.map(p => ({ x: p.x * 100 + 5000, y: 7000 }));

    const back = lined([ring(4, 0)], [far])[0];

    expect(back.whence).toEqual(ring(4, 0).whence);
    expect(back.points[0]).toEqual({ x: 5000, y: 7000 });
  });

  test('runs are paired by name too, not by where they sit', () => {
    // A polygon's boundary can be several runs, and at an event the arrangement
    // reorders them. Paired by position, two pieces from opposite ends of the
    // level end up interpolating into each other.
    const one = ring(4, 0, 7), two = ring(3, 0, 7);

    const back = lined([one, two], [two, one]);

    expect(back[0].whence).toEqual(one.whence);
    expect(back[1].whence).toEqual(two.whence);
  });

  test('a reading that cannot be lined up is left alone', () => {
    // No counterpart means the arrangement changed, which is an event: not a
    // phase to be recovered from, and a stretch that spans one should have been
    // cut rather than fixed up here.
    const other = ring(4, 0, 9);
    const from = [other];

    expect(lined([ring(4, 0, 7)], from)).toBe(from);
  });

  test('an open run keeps the order it came in', () => {
    // Its ends are crossings with other polygons, so there is no choice in
    // where it starts and nothing to line up.
    const open = { ...ring(4, 0), whence: ring(4, 0).whence.slice(0, 4), points: ring(4, 0).points.slice(0, 4), corner: [true, true, true, true] };

    expect(lined([open], [open])[0].whence).toEqual(open.whence);
  });
});

describe('a track covers its span exactly, and a jump owns no interval', () => {
  // The invariant that was not stateable while the two lived in one list. A
  // stretch is an interval holding one arrangement; a jump is the geometry at
  // the instant an arrangement changes, true at a point and at neither side of
  // it. Mixed together, the cover had to be closed over the jumps to leave no
  // instant unowned, which gave each jump half the gap to its neighbours — and
  // an arrangement true for no length of time was then drawn for the length of
  // a frame. Kept apart, both halves are plain: the stretches tile [0, 1] and
  // the jumps are points.
  const holds = (world: World) => {
    const span = run(bakeSpan(world, 0));

    expect(span.tracks.length).toBeGreaterThan(0);

    for (const track of span.tracks) {
      const all = track.stretches;

      expect(all.length).toBeGreaterThan(0);
      expect(all[0].t0).toBe(0);
      expect(all[all.length - 1].t1).toBe(1);

      for (const s of all) expect(s.t1).toBeGreaterThan(s.t0);

      for (let i = 1; i < all.length; i++) expect(all[i].t0).toBe(all[i - 1].t1);

      for (const j of track.jumps) {
        expect(j.t1).toBe(j.t0);

        // Reachable only by its own instant. Anything else lands in the cover.
        expect(stretchAt(track, j.t0)).toBe(j);
      }
    }
  };

  test('two rooms drawn edge to edge, one of them eroding', () => {
    const { world, ids } = drawn(
      ['level', rect(0, 0, 100, 100)],
      ['level', rect(100, 0, 100, 100)],
    );

    holds(transformed(world, 1, ids[0], { erosion: 20 }));
  });

  test('a pillar turning inside a room that is eroding', () => {
    const { world, ids } = drawn(
      ['level', rect(0, 0, 300, 200)],
      ['solid', rect(120, 80, 60, 60)],
    );

    holds(transformed(transformed(world, 1, ids[0], { erosion: 20 }), 1, ids[1], { rotation: 1.1 }));
  });
});

describe('the two ends of a stretch are the same arrangement', () => {
  // The invariant the whole span rests on. A stretch is interpolated by pairing
  // its two ends run for run and point for point, so those pairs have to be the
  // same run and the same point — the same corner of the same outline, or the
  // same two edges crossing.
  //
  // Nothing about one reading can be trusted to line them up. A ring closes on
  // itself, so the arrangement hands it back cut wherever the walk began, and
  // it hands the runs themselves back in whatever order they came out. Names
  // look like they settle it and do not: a name carries the index the ring was
  // handed over with, so when the arrangement re-cuts the ring the names move
  // with the cut, and both readings then call different corners `index 0` in
  // perfect agreement.
  //
  // What is left is the shape. The two ends are one ring a moment apart, kept
  // in the polygon's own frame where nothing rigid moves it, so the right
  // pairing is the close one and every other pairing is an edge away. That is
  // what is asserted: turning either end by any amount at all can only make the
  // two ends agree less well than they already do.
  const holds = (world: World) => {
    let pairs = 0;

    for (const track of run(bakeSpan(world, 0)).tracks) {
      for (const stretch of track.stretches) {
        stretch.a.forEach((one, i) => {
          const two = stretch.b[i];

          if (two === undefined || two.points.length !== one.points.length) return;

          expect(two.id).toEqual(one.id);

          // Open runs have two ends and cannot be turned; only rings can.
          const n = one.points.length - 1;
          if (n < 3) return;
          if (one.points[0].x !== one.points[n].x) return;

          pairs++;

          const apart = (k: number) => {
            let far = 0;

            for (let j = 0; j < n; j++) {
              const p = one.points[j], q = two.points[(j + k) % n];

              far += (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
            }

            return far;
          };

          for (let k = 1; k < n; k++) expect(apart(0)).toBeLessThanOrEqual(apart(k));
        });
      }
    }

    // A test that asserted nothing would pass this too.
    expect(pairs).toBeGreaterThan(0);
  };

  test('a room with pillars in it, one of them eroding', () => {
    // Closed rings, which is where the phase can differ: a pillar's boundary is
    // its own whole outline, cut wherever the walk started.
    const { world, ids } = drawn(
      ['level', rect(-200, -200, 500, 400)],
      ['solid', rect(-100, -100, 60, 60)],
      ['solid', rect(100, -100, 60, 60)],
    );

    holds(transformed(world, 1, ids[1], { erosion: 8 }));
  });

  test('a polygon sliding into another, which reorders the runs', () => {
    // Where the run *order* changes: the arrangement puts a polygon's pieces
    // back in whatever order it walked them, and an event reorders them.
    const { world, ids } = drawn(
      ['level', rect(0, 0, 200, 100)],
      ['level', rect(0, 200, 40, 100)],
    );

    holds(transformed(world, 1, ids[1], { translation: { x: 0, y: -140 } }));
  });

  test('a group eroding round a pillar that is turning inside it', () => {
    const { world, ids } = drawn(
      ['level', rect(-200, -200, 400, 400)],
      ['solid', rect(-60, -60, 120, 120)],
    );

    const made = grouped(world, 0, ids, TOP)!;
    const turned = transformed(made.world, 1, ids[1], { rotation: 0.7 });

    holds(transformed(turned, 1, made.id, { erosion: 20 }));
  });
});

describe('the replay never leaves the truth, as a shape', () => {
  // The end-to-end version of the invariant above, and the one that says what
  // the author actually sees. A stretch pairs its two ends and interpolates
  // between them; if the pairing is wrong the interpolation is somewhere else
  // entirely, and the shape it draws half way across a stretch is the tell —
  // a pillar paired one corner along becomes a square inscribed in itself at
  // forty-five degrees, whose corners sit at the middles of the real edges.
  //
  // Measured as a point set, both ways round, because a name cannot be used as
  // an oracle here: the truth's own names turn with the arrangement's cut, so a
  // replay that is exactly right can still be a corner off by name. Distance
  // does not care, and the diamond is half an edge away from every real corner,
  // which is far past `TOLERANCE`.
  //
  // The instants crowd towards zero deliberately. A span's first stretch can be
  // a ten-thousandth of it wide, and a walk played backwards arrives there — it
  // ends at `t = 0`, easing in through 1e-6, 1e-5, 1e-4. Evenly spaced instants
  // step straight over the whole of it, which is how this survived a suite that
  // sampled twenty-three of them.
  const follows = (world: World, from: VersionId) => {
    const span = run(bakeSpan(world, from));
    let checked = 0;

    const ts = [0, 1e-7, 1e-6, 1e-5, 1e-4, 1e-3, 0.01];

    for (let k = 1; k < 24; k++) ts.push(k / 24);

    for (const t of ts) {
      const there: Point[] = [];

      for (const piece of truth(world, from, t)) there.push(...piece.points);

      const here: Point[] = [];

      for (const piece of sample(span, t)) here.push(...piece.points);

      const stray = (from: Point[], to: Point[]) => {
        let worst = 0;

        for (const p of from) {
          let near = Infinity;

          for (const q of to) near = Math.min(near, Math.hypot(p.x - q.x, p.y - q.y));

          worst = Math.max(worst, near);
        }

        return worst;
      };

      checked++;
      expect(stray(here, there)).toBeLessThan(TOLERANCE);
      expect(stray(there, here)).toBeLessThan(TOLERANCE);
    }

    expect(checked).toBeGreaterThan(0);
  };

  test('a group of pillars in a room, the group eroding', () => {
    // The reported shape: four pillars whose rings are their own whole
    // outlines, so every one of them is cut wherever the walk began.
    const { world, ids } = drawn(
      ['level', rect(-300, -200, 600, 400)],
      ['solid', rect(-200, -120, 80, 80)],
      ['solid', rect(120, -120, 80, 80)],
      ['solid', rect(-200, 40, 80, 80)],
      ['solid', rect(120, 40, 80, 80)],
    );

    const made = grouped(world, 0, ids, TOP)!;

    follows(transformed(made.world, 1, made.id, { erosion: 24 }), 0);
  });

  test('a polygon sliding into a wall it ends up touching', () => {
    const { world, ids } = drawn(
      ['level', rect(-200, 0, 400, 100)],
      ['level', rect(-40, 200, 80, 120)],
    );

    follows(transformed(world, 1, ids[1], { translation: { x: 0, y: -160 } }), 0);
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

    const track = run(bakeSpan(w, 0)).tracks[0];

    // The touching geometry is a jump at the very start: true at `t = 0` and at
    // no instant after it, which is what a jump is for. It used to be a narrow
    // first stretch instead, and a stretch is an interval — so the arrangement
    // that holds for an instant was drawn for the whole of the first frame of
    // every walk, which is a wall standing on a junction that has already come
    // apart.
    expect(track.jumps[0].t0).toBe(0);
    expect(track.jumps[0].t1).toBe(0);

    // And the cover starts there all the same, held by the stretch that follows
    // it: no instant of the span is unowned.
    expect(track.stretches[0].t0).toBe(0);
    expect(track.stretches[0].t1).toBeGreaterThan(0);
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

describe('a turning world is no worse than it says it is', () => {
  // `Span.worst` is the bake's statement about itself, and the whole point of
  // measuring rather than arguing about which events exist. It stopped being
  // true the moment a stretch could be kept without its check running: an
  // interval that ran out of width to split was accepted in silence, so the one
  // place the replay was worst was the one place nothing looked. Six boxes
  // turned by degrees rather than fractions of one put a whole unit of pop
  // behind a `worst` of two hundredths.
  //
  // Nothing here asks the error to be small. It asks the number to be honest,
  // which is the property everything else rests on.

  function boxes(spin: number): World {
    let world = emptyWorld();
    const ids: PolygonId[] = [];

    for (let i = 0; i < 6; i++) {
      const made = addPolygon(
        world,
        i % 3 === 2 ? 'solid' : 'level',
        rect(-140 + 60 * i, -90 + 40 * (i % 3), 150, 130),
        0,
        TOP,
      );

      world = made.world;
      ids.push(made.id);
    }

    ids.forEach((id, i) => {
      world = transformed(world, 1, id, {
        rotation: (i % 2 ? 1 : -1) * spin,
        translation: { x: 10 * i - 20, y: 6 * i },
      });
    });

    return world;
  }

  /** The furthest a point of one frame sits from the nearest point of the
   * other, both ways — blind to how the runs were cut up, so that two readings
   * starting their rings in different places do not read as a disagreement. */
  function asSets(a: Frame, b: Frame): number {
    const far = (from: Point[], to: Point[]): number => {
      let m = 0;

      for (const p of from) {
        let near = Infinity;

        for (const q of to) near = Math.min(near, Math.hypot(p.x - q.x, p.y - q.y));

        m = Math.max(m, near);
      }

      return m;
    };

    const one = a.flatMap(r => r.points), two = b.flatMap(r => r.points);

    return Math.max(far(one, two), far(two, one));
  }

  test('at instants the bake did not choose to look at', () => {
    for (const spin of [20]) {
      const world = boxes(spin);
      const span = run(bakeSpan(world, 0));

      let seen = 0, worst = 0;

      // Deliberately not the midpoints and quarters the bake checked itself at.
      for (let i = 0; i <= 997; i++) {
        const t = i / 997;
        const a = sample(span, t), b = truth(world, 0, t);
        // The bake's own idea of two readings being the same arrangement: not
        // how many points there are but where each one came from. Anything else
        // is a genuine event, which it owns as a jump and no stretch claims to
        // draw — and asking it to answer for those would be asking it to answer
        // for the world's discontinuities rather than its own error.
        const shape = (f: Frame) =>
          f.map(r => `${r.id}:${JSON.stringify(r.whence)}`).sort().join(' ');

        if (shape(a) !== shape(b)) continue;

        seen++;
        worst = Math.max(worst, asSets(a, b));
      }

      expect(seen).toBeGreaterThan(700);
      expect(worst).toBeLessThanOrEqual(span.worst + 1e-9);
    }
  }, 30_000);
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

    expect(pruned(bake, { ...w, versions }).spans.size).toBe(VERSIONS - 1);
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

describe('a floor morphs like everything else, taking part in nothing', () => {
  // A floor is in no set — `worldset` takes only `level` and `solid` — so its
  // boundary is its own projection and nothing else. What it is not is static:
  // it slides, turns and erodes with the version it belongs to, and the walls
  // standing on it move with it. So it gets a track like anything else, cut to
  // the same measure and read by the same lerp; only what is built on the
  // points differs.

  function floored(): { world: World, room: PolygonId, floor: PolygonId } {
    const { world, ids } = drawn(
      ['level', rect(-200, -200, 400, 400)],
      ['floor', rect(-50, -50, 100, 100)],
    );

    const it = resolveAt(world, 1).find(r => r.id === ids[1])!;
    const edit = editAt(world, 1, ids[1], it.erosion);

    return {
      world: withEdit(world, 1, ids[1], {
        ...edit,
        transform: {
          ...edit.transform,
          translation: { x: 120, y: 40 },
          rotation: 0.7,
        },
      }),
      room: ids[0],
      floor: ids[1],
    };
  }

  test('it has a track of its own, marked as a fill', () => {
    const { world, floor } = floored();
    const span = run(bakeSpan(world, 0));
    const track = span.tracks.find(t => t.id === floor)!;

    expect(track).toBeDefined();
    expect(track.fill).toBe(true);
    expect(span.tracks.find(t => t.id !== floor)!.fill).toBe(false);
  });

  test('and its runs are closed rings rather than open arcs', () => {
    const { world, floor } = floored();
    const span = run(bakeSpan(world, 0));
    const s = span.tracks.find(t => t.id === floor)!.stretches[0];

    for (const r of s.a) {
      const first = r.points[0], last = r.points[r.points.length - 1];

      expect(r.points.length).toBeGreaterThan(3);
      expect(last.x).toBeCloseTo(first.x, 9);
      expect(last.y).toBeCloseTo(first.y, 9);
    }
  });

  test('a turn goes round its pivot, exactly, all the way across', () => {
    // Nothing cuts it and nothing crosses it, so there is no tolerance in this
    // at all: the replay is the resolved geometry to the last digit.
    const { world, floor } = floored();
    const span = run(bakeSpan(world, 0));

    for (const t of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
      const mine = sample(span, t).filter(r => r.id === floor);
      const real = truth(world, 0, t).filter(r => r.id === floor);

      expect(mine.length).toEqual(real.length);

      mine.forEach((r, i) => r.points.forEach((p, j) => {
        expect(p.x).toBeCloseTo(real[i].points[j].x, 9);
        expect(p.y).toBeCloseTo(real[i].points[j].y, 9);
      }));
    }
  });

  test('and every run of it says it is a fill, so the canvas can tell', () => {
    // What the replay reads. A floor moves across a span like everything else,
    // but the bright line the replay draws is the *set*, and a floor is in no
    // set: drawn in it, it would be claiming to be a piece of outline. It gets
    // the line an unselected floor gets standing still instead.
    const { world, floor } = floored();
    const span = run(bakeSpan(world, 0));

    for (const t of [0, 0.5, 1]) {
      const frame = sample(span, t);

      expect(frame.filter(r => r.fill).every(r => r.id === floor)).toBe(true);
      expect(frame.filter(r => r.id === floor).every(r => r.fill)).toBe(true);
      expect(frame.some(r => r.fill)).toBe(true);
      expect(frame.some(r => !r.fill)).toBe(true);
    }
  });

  test('a wall sweeping across it does not cut it', () => {
    // The whole of "takes no part". A bar dragged over the floor is an event
    // for every room it touches and none at all for this.
    const { world, ids } = drawn(
      ['level', rect(-200, -200, 400, 400)],
      ['solid', rect(-300, -20, 40, 40)],
      ['floor', rect(-50, -50, 100, 100)],
    );

    const span = run(bakeSpan(transformed(world, 1, ids[1], {
      translation: { x: 600, y: 0 },
    }), 0));

    expect(span.tracks.find(t => t.id === ids[2])!.stretches.length).toEqual(1);
  });

  test('every layer a polygon has reaches it: its own, and its groups', () => {
    // The whole of "versioned like everything else". A floor is drawn rather
    // than built, and nothing else about it is special: it takes a transform,
    // it takes an erosion, it rides the groups holding it, and every one of
    // those is in flight across the span like anywhere else.
    const { world, ids } = drawn(
      ['level', rect(-400, -400, 800, 800)],
      ['floor', rect(-120, -80, 240, 160)],
    );

    const made = grouped(world, 0, ids, TOP)!;

    // The group turns and erodes; the floor slides and erodes inside it.
    const turning = withEdit(made.world, 1, made.id, {
      transform: { ...EMPTY_TRANSFORM, rotation: 0.8, erosion: 12 },
      vertices: new Map(),
      depths: new Map(),
    });

    const it = resolveAt(turning, 1).find(r => r.id === ids[1])!;
    const edit = editAt(turning, 1, ids[1], it.erosion);

    const moved = withEdit(turning, 1, ids[1], {
      ...edit,
      transform: {
        ...edit.transform,
        translation: { x: 60, y: -40 },
        rotation: -0.5,
        erosion: 18,
      },
    });

    const span = run(bakeSpan(moved, 0));

    for (const t of [0, 0.2, 0.5, 0.8, 1]) {
      const mine = sample(span, t).filter(r => r.fill);
      const real = truth(moved, 0, t).filter(r => r.id === ids[1]);

      expect(mine.length).toEqual(real.length);
      expect(mine.length).toBeGreaterThan(0);

      mine.forEach((r, i) => r.points.forEach((p, j) => {
        expect(p.x).toBeCloseTo(real[i].points[j].x, 9);
        expect(p.y).toBeCloseTo(real[i].points[j].y, 9);
      }));
    }
  });

  test('and a group eroding around it does not swallow it', () => {
    // An eroding group stands in front of its members' union, and a floor is
    // in no union. So it stays its own subject at its own depth, which is
    // exactly what `floorsAt` draws standing still.
    const { world, ids } = drawn(
      ['level', rect(-200, -200, 400, 400)],
      ['floor', rect(-50, -50, 100, 100)],
    );

    const held = grouped(world, 0, ids, TOP)!;
    const eroding = transformed(held.world, 1, held.id, { erosion: 20 });
    const span = run(bakeSpan(eroding, 0));
    const track = span.tracks.find(t => t.id === ids[1]);

    expect(track?.fill).toBe(true);

    // And it is still *there*. The track existing says nothing: the group used
    // to hand over one union per side, floors included, and the floor's own
    // track came back empty at every instant while looking perfectly healthy.
    for (const t of [0, 0.5, 1]) {
      const mine = sample(span, t).filter(r => r.id === ids[1]);

      expect(mine.length).toBeGreaterThan(0);
      expect(length(mine)).toBeCloseTo(length(truth(eroding, 0, t).filter(r => r.id === ids[1])), 9);
    }
  });
});

describe('a corner that was always there but flat at one end', () => {
  // The other way a corner arrives, and the one that was missed. Put a vertex
  // on an edge and leave it there, and it belongs to both versions — nothing is
  // born and nothing dies — but the arrangement drops it at the end where it is
  // exactly collinear and keeps it everywhere else. So the ring changes length
  // the instant anything moves, and a vertical stands up out of a flat wall for
  // the frame at that end of the span. See `straightened`.
  //
  // Three of them on one wall with the middle one dragged off it is the level
  // that found it: the two that never move are corners of the notch's mouth at
  // the far end and are straight at the near one, so all three arrive together.

  function notched(): { world: World, id: PolygonId, moved: Id } {
    const { world, ids } = drawn(['level', rect(-100, -100, 200, 200)]);
    let out = world;

    // Along the bottom edge, in the order they sit in the ring.
    for (const x of [50, 0, -50]) {
      const it = resolveAt(out, 0).find(r => r.id === ids[0])!;

      out = addVertex(out, 0, it, 0, { x, y: -100 }).world;
    }

    const at = resolveAt(out, 1).find(r => r.id === ids[0])!;
    const middle = at.corners.find(c => c.at.x === 0 && c.at.y === -100)!;
    const edit = editAt(out, 1, ids[0], at.erosion);
    const vertices = new Map(edit.vertices);

    vertices.set(middle.id, { x: 0, y: 80 });

    return {
      world: withEdit(out, 1, ids[0], { ...edit, vertices }),
      id: ids[0],
      moved: middle.id,
    };
  }

  test('all three stand in the ring at both ends, so it is one stretch', () => {
    const { world } = notched();
    const span = run(bakeSpan(world, 0));

    expect(span.tracks.every(t => t.stretches.length === 1)).toBe(true);
    expect(span.tracks.every(t => t.jumps.length === 0)).toBe(true);

    const at = (t: number) => sample(span, t).reduce((n, r) => n + r.points.length, 0);

    expect(at(0)).toEqual(at(1));
    expect(at(0)).toEqual(at(0.5));
  });

  test('and their lines fade in over the span rather than snapping on', () => {
    const { world } = notched();
    const span = run(bakeSpan(world, 0));
    const track = span.tracks[0];
    const s = track.stretches[0];

    // The three on the bottom wall, by where they stand at the near end.
    const flat: [number, number][] = [];

    s.a.forEach((r, i) => r.points.forEach((p, j) => {
      if (Math.abs(p.y + 100) < 1e-6 && Math.abs(p.x) < 99) flat.push([i, j]);
    }));

    expect(flat.length).toEqual(3);

    for (const [i, j] of flat) {
      expect(s.opacity[0][i][j]).toBeCloseTo(0, 9);
      expect(s.opacity[1][i][j]).toBeCloseTo(1, 9);
    }
  });

  test('and the span still draws what the editor draws at both ends', () => {
    const { world } = notched();
    const span = run(bakeSpan(world, 0));

    expect(length(sample(span, 0))).toBeCloseTo(editorAt(world, 0), 6);
    expect(length(sample(span, 1))).toBeCloseTo(editorAt(world, 1), 6);
  });
});

describe('a wall that is eroded while a corner leaves it', () => {
  // The fade used to be worked out by projecting the ring again without the
  // corners that change and keeping whatever the first projection had left over.
  // That reads the two as the same curve with one vertex fewer, and they only
  // are where the corner is already flat — which is one end of the span and
  // nowhere else. Anywhere in between, with an offset on, the leftovers did not
  // line up, the whole fade was given up on, and the line stood solid for the
  // length of the span and went out in its last frame.
  //
  // Without an offset the two projections agree point for point, so this needs
  // an eroded wall to show at all, which is why every case above missed it.

  function folding(): { world: World, id: PolygonId } {
    const { world, ids } = drawn(['level', [
      { x: -100, y: -100 }, { x: 0, y: -170 }, { x: 100, y: -100 },
      { x: 100, y: 100 }, { x: -100, y: 100 },
    ]]);

    const deep = withEdit(world, 0, ids[0], { ...editAt(world, 0, ids[0], 12) });
    const going = deep.polygons.get(ids[0])!.points[1].id;

    return { world: removeVertices(deep, 1, [going]), id: ids[0] };
  }

  /** How solid the faintest point of the outline is at `t`. */
  function dimmest(span: Span, id: PolygonId, t: number): number {
    const track = span.tracks.find(x => x.id === id)!;
    const s = stretchAt(track, t)!;
    const u = s.t1 === s.t0 ? 0 : (t - s.t0) / (s.t1 - s.t0);

    let least = 1;

    s.opacity[0].forEach((ring, r) => ring.forEach((v, i) => {
      least = Math.min(least, v + (s.opacity[1][r][i] - v) * u);
    }));

    return least;
  }

  test('the leaving corner fades over the whole span, not its last frame', () => {
    const { world, id } = folding();
    const span = run(bakeSpan(world, 0));

    expect(dimmest(span, id, 0)).toBeCloseTo(1, 9);
    expect(dimmest(span, id, 0.25)).toBeCloseTo(0.75, 2);
    expect(dimmest(span, id, 0.5)).toBeCloseTo(0.5, 2);
    expect(dimmest(span, id, 0.75)).toBeCloseTo(0.25, 2);
    expect(dimmest(span, id, 1)).toBeCloseTo(0, 9);
  });

  test('and the span still draws what the editor draws at both ends', () => {
    const { world } = folding();
    const span = run(bakeSpan(world, 0));

    expect(length(sample(span, 0))).toBeCloseTo(editorAt(world, 0), 6);
    expect(length(sample(span, 1))).toBeCloseTo(editorAt(world, 1), 6);
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
