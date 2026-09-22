import { describe, expect, test } from 'vitest';
import { Point } from '@ce/game/world';
import {
  EXACT_GAP,
  Frame,
  Origin,
  Span,
  TOLERANCE,
  bakeAll,
  bakeSpan,
  ready,
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
  removeAt,
  grouped,
  sealing,
  addVertex,
  csg,
  depths,
  removeVertices,
  resolveAt,
  keyRigOf,
  rigOf,
  sideOf,
  unchained,
  withKeyRig,
  withRig,
} from './scene';
import { nudged, stateAt } from './rig';
import { Writing, erode, inSegments, move, scaled, spun, turned as turning, wrote } from './testing';
import {
  EMPTY_BAKE,
} from './bake';
import {
  Effects,
  Id,
  PolygonId,
  PolygonKind,
  KeyframeId,
  World,
  emptyWorld,
} from './types';

/**
 * A polygon kind by the short name these tests call it: a room, a pillar, a
 * floor, and a hole cut in a floor.
 *
 * Three of them are the kind's own name. `hole` is a void over the floors,
 * which is what a hole in one is. See `PolygonKind`.
 */
type Named = 'level' | 'solid' | 'floor' | 'hole';

const kind = (k: Named): PolygonKind =>
  k === 'hole' ? { floor: 'void' } : k === 'floor' ? { floor: 'floor' } : { level: k === 'level' ? 'hollow' : k };

function rect(x: number, y: number, w: number, h: number): Point[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

function drawn(...specs: [Named, Point[]][]): { world: World, ids: PolygonId[] } {
  let world = emptyWorld();
  const ids: PolygonId[] = [];

  for (const [type, points] of specs) {
    const added = addPolygon(world, kind(type), points, 0, TOP);

    world = added.world;
    ids.push(added.id);
  }

  return { world, ids };
}

/** A layer as these tests were first written against: a squash, a turn and a
 * move, each about the origin, and a depth stated outright rather than added.
 * Written as the operations that say it now, at the end of `v`'s list. */
interface Layer {
  translation: Point
  rotation: number
  scale: { x: number, y: number }
  erosion: number
}

function transformed(world: World, v: KeyframeId, id: Id, t: Partial<Layer>): World {
  const ops: Writing[] = [];

  if (t.scale !== undefined) ops.push(scaled(t.scale.x, t.scale.y));
  if (t.rotation !== undefined) ops.push(turning(t.rotation));
  if (t.translation !== undefined) ops.push(move(t.translation.x, t.translation.y));

  if (t.erosion !== undefined) {
    ops.push((w, k, of) => erode(
      t.erosion! - (resolveAt(w, k).find(r => r.id === of)?.erosion ?? depths(w, k).get(of) ?? 0),
    ));
  }

  return wrote(world, v, id, ...ops);
}

/** One corner moved by `by` at `v`, in its polygon's rest frame. */
function nudging(world: World, v: KeyframeId, id: Id, vertex: number, by: Point): World {
  return withRig(world, id, nudged(rigOf(world, id), vertex, v, by));
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

/**
 * The middle of a frame's bounding box: enough to say where a shape sits and
 * blind to how big it is, which is what a growing polygon needs asking.
 *
 * The box rather than the mean of the points, because a frame is open runs with
 * shared ends and the mean counts some corners twice — which reads as a drift
 * of its own.
 */
/**
 * The half of a frame on the far side of the line `x + y = 0`.
 *
 * A group is a scope, so what a grouped polygon contributes is part of the
 * group's track and carries the group's id, not its own — there is no run to
 * pick out by asking whose it is. Two rooms placed opposite each other through
 * the origin stay opposite each other under any turn about it, so which side
 * of that line a point is on says which room it came off, at every instant.
 */
function beyond(frame: Frame): Frame {
  return frame
    .map(r => ({ ...r, points: r.points.filter(p => p.x + p.y > 0) }))
    .filter(r => r.points.length !== 0);
}

function middle(frame: Frame): Point {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const run of frame) {
    for (const p of run.points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }

  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
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
function editorAt(world: World, v: KeyframeId): number {
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
  const span = run(bakeSpan(world, from, TOLERANCE, EXACT_GAP));
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
  const span = run(bakeSpan(world, from, TOLERANCE, EXACT_GAP));

  return cut(span).slice(1).map(t => Number(t.toFixed(4)));
}

/** What the bake says its own error was, which is the number that matters. */
function worst(world: World, from = 0): number {
  return run(bakeSpan(world, from, TOLERANCE, EXACT_GAP)).worst;
}


/**
 * A group that is a scope.
 *
 * Grouping produces a loose one now — a handle and nothing else — so every
 * test about what a group *does* to the set has to say so. See `Group.sealed`.
 */
function sealed(
  ...args: Parameters<typeof grouped>
): { world: World, id: number } | null {
  const made = grouped(...args);

  return made === null ? null : { id: made.id, world: sealing(made.world, made.id, true) };
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
    const w = nudging(world, 1, ids[0], it.polygon.points[2].id, { x: 100, y: 0 });
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

    const made = sealed(world, 0, ids, TOP)!;
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
  const follows = (world: World, from: KeyframeId) => {
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

    const made = sealed(world, 0, ids, TOP)!;

    follows(transformed(made.world, 1, made.id, { erosion: 24 }), 0);
  });

  test('an eroding group taken out, which shrinks and stops eroding at once', () => {
    // Two things going to nothing over the same span: the members into their
    // own middles, and the group's depth to zero because a group that is not
    // there is not eroding either. The bake has to stay inside its own
    // tolerance while both do.
    const { world, ids } = drawn(
      ['level', rect(-300, -100, 200, 200)],
      ['level', rect(100, -100, 200, 200)],
    );

    const made = sealed(world, 0, ids, TOP)!;
    const eroding = transformed(made.world, 0, made.id, { erosion: 20 });

    follows(removeAt(eroding, 1, [made.id]), 0);
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

  test('a polygon born into the later version grows out of its middle', () => {
    const { world } = drawn(['level', rect(0, 0, 100, 100)]);
    const added = addPolygon(world, kind('level'), rect(300, 300, 100, 100), 1, TOP);

    const span = run(bakeSpan(added.world, 0));

    // A point at the near end — not nothing, and not the whole polygon either.
    expect(length(sample(span, 0))).toBeGreaterThan(400);
    expect(length(sample(span, 0))).toBeLessThan(401);
    expect(length(sample(span, 1))).toBeCloseTo(800, 6);

    // And a perimeter that climbs in step with the scale the whole way, rather
    // than holding still and then arriving.
    for (const t of [0.25, 0.5, 0.75]) {
      expect(length(sample(span, t)) - 400).toBeCloseTo(400 * t, 0);
    }
  });

  test('and grows about its own centre, so it does not drift into place', () => {
    const { world } = drawn(['level', rect(0, 0, 100, 100)]);
    const added = addPolygon(world, kind('level'), rect(300, 300, 100, 100), 1, TOP);

    const span = run(bakeSpan(added.world, 0));

    for (const t of [0, 0.4, 1]) {
      const mine = sample(span, t).filter(r => r.id === added.id);

      expect(mine.length).toBeGreaterThan(0);
      expect(middle(mine).x).toBeCloseTo(350, 4);
      expect(middle(mine).y).toBeCloseTo(350, 4);
    }
  });

  test('and the span says the same thing the editor does all the way across', () => {
    const { world } = drawn(['level', rect(0, 0, 100, 100)]);
    const added = addPolygon(world, kind('level'), rect(300, 300, 100, 100), 1, TOP);

    expect(drift(added.world)).toBeLessThan(TOLERANCE);
  });

  test('a loose group is not a scope to the bake either', () => {
    // The editor and the bake have to answer this the same way or the bake is
    // of a different world. A loose group's members go into the set one by one,
    // so each of them is a track of its own and the group is none.
    const { world, ids } = drawn(
      ['level', rect(0, 0, 100, 100)],
      ['level', rect(200, 0, 100, 100)],
    );

    const made = grouped(world, 0, ids, TOP)!;
    const w = transformed(made.world, 1, ids[0], { rotation: 0.3 });

    expect(run(bakeSpan(w, 0)).tracks.map(t => t.id).sort()).toEqual([...ids].sort());

    // Sealed, the same world is one track: the scope's own boundary.
    const shut = sealing(made.world, made.id, true);

    expect(run(bakeSpan(transformed(shut, 1, ids[0], { rotation: 0.3 }), 0)).tracks
      .map(t => t.id)).toEqual([made.id]);
  });

  test('one born into a group that turns rides the group while it grows', () => {
    const { world, ids } = drawn(['level', rect(-300, -100, 200, 200)]);
    const added = addPolygon(world, kind('level'), rect(100, -100, 200, 200), 1, TOP);
    const group = sealed(added.world, 0, [ids[0], added.id], TOP)!;
    const w = transformed(group.world, 1, group.id, { rotation: Math.PI / 2 });

    const span = run(bakeSpan(w, 0));

    // A quarter turn about the origin takes (200, 0) to (0, 200), so half of it
    // takes the newborn's middle to the diagonal. Growing where it will end up
    // instead would leave it sitting at (200, 0) the whole way.
    const half = middle(beyond(sample(span, 0.5)));

    expect(half.x).toBeCloseTo(200 / Math.SQRT2, 4);
    expect(half.y).toBeCloseTo(200 / Math.SQRT2, 4);

    // And it is a point that rode there, not a polygon.
    expect(length(sample(span, 0)) - editorAt(w, 0)).toBeLessThan(1);
  });

  test('a polygon taken out of the later version shrinks into its middle', () => {
    const { world, ids } = drawn(
      ['level', rect(0, 0, 100, 100)],
      ['level', rect(300, 300, 100, 100)],
    );

    const span = run(bakeSpan(removeAt(world, 1, [ids[1]]), 0));

    expect(length(sample(span, 0))).toBeCloseTo(800, 6);
    expect(length(sample(span, 1))).toBeGreaterThan(400);
    expect(length(sample(span, 1))).toBeLessThan(401);

    // Falling away in step with the scale rather than standing there and then
    // being gone: a birth read backwards.
    for (const t of [0.25, 0.5, 0.75]) {
      expect(length(sample(span, t)) - 400).toBeCloseTo(400 * (1 - t), 0);
    }
  });

  test('and shrinks about its own centre, so it does not slide off to die', () => {
    const { world, ids } = drawn(
      ['level', rect(0, 0, 100, 100)],
      ['level', rect(300, 300, 100, 100)],
    );

    const span = run(bakeSpan(removeAt(world, 1, [ids[1]]), 0));

    for (const t of [0, 0.6, 1]) {
      const mine = sample(span, t).filter(r => r.id === ids[1]);

      expect(mine.length).toBeGreaterThan(0);
      expect(middle(mine).x).toBeCloseTo(350, 4);
      expect(middle(mine).y).toBeCloseTo(350, 4);
    }
  });

  test('and a removal reads against the editor all the way across too', () => {
    const { world, ids } = drawn(
      ['level', rect(0, 0, 100, 100)],
      ['level', rect(300, 300, 100, 100)],
    );

    expect(drift(removeAt(world, 1, [ids[1]]))).toBeLessThan(TOLERANCE);
  });

  test('one taken out of a group that turns rides the group while it goes', () => {
    const { world, ids } = drawn(
      ['level', rect(-300, -100, 200, 200)],
      ['level', rect(100, -100, 200, 200)],
    );

    const group = sealed(world, 0, [ids[0], ids[1]], TOP)!;
    const gone = removeAt(group.world, 1, [ids[1]]);
    const w = transformed(gone, 1, group.id, { rotation: Math.PI / 2 });

    const span = run(bakeSpan(w, 0));
    const half = middle(beyond(sample(span, 0.5)));

    expect(half.x).toBeCloseTo(200 / Math.SQRT2, 4);
    expect(half.y).toBeCloseTo(200 / Math.SQRT2, 4);
  });

  test('one shrinking out of its neighbour is cut where it leaves the wall', () => {
    const { world, ids } = drawn(
      ['level', rect(0, 0, 200, 200)],
      ['level', rect(150, 50, 200, 100)],
    );

    const span = run(bakeSpan(removeAt(world, 1, [ids[1]]), 0));
    const track = span.tracks.find(t => t.id === ids[1])!;

    expect(track.stretches.length).toBeGreaterThan(1);
    expect(span.worst).toBeLessThan(TOLERANCE);
  });

  test('one growing into its neighbour is cut where it reaches the wall', () => {
    const { world } = drawn(['level', rect(0, 0, 200, 200)]);
    const added = addPolygon(world, kind('level'), rect(150, 50, 200, 100), 1, TOP);

    const span = run(bakeSpan(added.world, 0));
    const track = span.tracks.find(t => t.id === added.id)!;

    // It starts as a point clear of the room and ends overlapping it, so two
    // rooms join part way through — an event, and one that only exists at all
    // because the birth is a motion rather than an appearance.
    expect(track.stretches.length).toBeGreaterThan(1);
    expect(span.worst).toBeLessThan(TOLERANCE);
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
        kind(i % 3 === 2 ? 'solid' : 'level'),
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
      const span = run(bakeSpan(world, 0, TOLERANCE, EXACT_GAP));

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

    expect(drift(nudging(world, 1, ids[0], it.polygon.points[2].id, { x: 90, y: 40 })))
      .toBeLessThan(TOLERANCE);
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

    const bent = nudging(world, 1, ids[0], it.polygon.points[2].id, { x: 90, y: 40 });
    const w = transformed(bent, 1, ids[0], { erosion: 22 });

    expect(drift(w)).toBeLessThan(TOLERANCE);
    expect(run(bakeSpan(w, 0)).tracks[0].stretches.length).toBeGreaterThan(1);
  });
});

describe('a turn goes round its pivot, not round the origin', () => {
  // What a turn gesture writes, for a turn of `angle` about `at`: the thing's
  // middle painted on, and the pivot as an offset from it.
  function about(world: World, id: Id, at: Point, angle: number): World {
    return wrote(world, 1, id, turning(angle, at));
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

    expect(held(about(world, ids[0], at, Math.PI / 2), at)).toBeLessThan(1e-6);
  });

  test('about a corner, well away from the origin', () => {
    const { world, ids } = drawn(['level', rect(400, 300, 200, 120)]);
    const at = { x: 400, y: 300 };

    expect(held(about(world, ids[0], at, 1.1), at)).toBeLessThan(1e-6);
  });

  test('and two turns about different pivots are two turns, one after the other', () => {
    // Each part way, each from where the one before left the room. The first
    // goes round its own pivot; the second goes round a point the first is
    // still carrying, since its anchor is an offset from the room's painted
    // middle. So what is seen is the hand's two gestures, not the one motion
    // that happens to join the ends — and nothing holds still but what does.
    const { world, ids } = drawn(['level', rect(400, 300, 200, 120)]);
    const a = { x: 500, y: 360 }, b = { x: 400, y: 300 };
    const w = wrote(world, 1, ids[0], turning(0.7, a), turning(0.5, b));

    const round = (p: Point, c: Point, angle: number): Point => {
      const cos = Math.cos(angle), sin = Math.sin(angle);

      return { x: c.x + (p.x - c.x) * cos - (p.y - c.y) * sin, y: c.y + (p.x - c.x) * sin + (p.y - c.y) * cos };
    };

    // The room's middle, which is where both turns were painted.
    const m = { x: 500, y: 360 };

    // Where the second turn's anchor sits relative to the middle, as written:
    // after the first turn, the middle is where the first left it.
    const offset = { x: b.x - round(m, a, 0.7).x, y: b.y - round(m, a, 0.7).y };

    for (const t of [0.25, 0.5, 0.75, 1]) {
      const first = round(m, a, 0.7 * t);
      const anchor = { x: first.x + offset.x, y: first.y + offset.y };
      const want = round(first, anchor, 0.5 * t);
      const got = middle(truth(w, 0, t));

      expect(got.x).toBeCloseTo(want.x, 6);
      expect(got.y).toBeCloseTo(want.y, 6);
    }

    expect(drift(w)).toBeLessThan(TOLERANCE);
  });
});

describe('a keyframe in flight plays its operations one after another', () => {
  // Each partway, each from the frame the one before it left, and each about
  // its own anchor — so what is seen between two keyframes is what the hand
  // did, rather than whichever single motion happens to join the two ends.

  /** Where the middle of one polygon's share of the outline is, part way. */
  function whereAt(world: World, id: PolygonId, t: number): Point {
    return middle(sample(run(bakeSpan(world, 0)), t).filter(r => r.id === id));
  }

  function near(p: Point, q: Point, digits = 6): void {
    expect(p.x).toBeCloseTo(q.x, digits);
    expect(p.y).toBeCloseTo(q.y, digits);
  }

  test('a room spinning in place keeps its size and its place', () => {
    const { world, ids } = drawn(['level', rect(100, 0, 100, 60)]);
    const w = wrote(world, 1, ids[0], spun(Math.PI / 2));
    const span = run(bakeSpan(w, 0));

    for (const t of [0.25, 0.5, 0.75]) {
      expect(length(sample(span, t))).toBeCloseTo(320, 6);
      near(whereAt(w, ids[0], t), { x: 150, y: 30 });
    }
  });

  test('a turned selection arcs about its centre', () => {
    const { world, ids } = drawn(
      ['level', rect(-200, -20, 40, 40)],
      ['level', rect(160, -20, 40, 40)],
    );

    // Both turned by one gesture about the middle of the two of them.
    let w = world;

    for (const id of ids) w = wrote(w, 1, id, turning(Math.PI / 2, { x: 0, y: 0 }));

    for (const t of [0.25, 0.5, 0.75]) {
      const a = t * Math.PI / 2;

      near(whereAt(w, ids[1], t), { x: 180 * Math.cos(a), y: 180 * Math.sin(a) });
      near(whereAt(w, ids[0], t), { x: -180 * Math.cos(a), y: -180 * Math.sin(a) });
    }
  });

  test('720° plays as two turns', () => {
    const { world, ids } = drawn(['level', rect(100, -20, 40, 40)]);
    const w = wrote(world, 1, ids[0], turning(4 * Math.PI, { x: 0, y: 0 }));

    // A quarter of the way through is a half turn about the origin, and an
    // eighth is a quarter turn: all the way round twice, rather than nowhere.
    near(whereAt(w, ids[0], 0.125), { x: 0, y: 120 });
    near(whereAt(w, ids[0], 0.25), { x: -120, y: 0 });
    near(whereAt(w, ids[0], 1), { x: 120, y: 0 });
  });

  test('a spin with a drag in the same keyframe spins while it slides', () => {
    const { world, ids } = drawn(['level', rect(-40, -20, 80, 40)]);
    const w = wrote(world, 1, ids[0], spun(Math.PI), move(100, 0));
    const span = run(bakeSpan(w, 0));

    // Half way: half of the slide, and half of the turn about a middle that is
    // itself sliding. As one motion joining the two ends it would swing out
    // round the point the two of them together leave alone.
    near(whereAt(w, ids[0], 0.5), { x: 50, y: 0 });

    // A quarter turn is an 80 by 40 room standing on its end.
    const box = sample(span, 0.5).flatMap(r => r.points);
    const tall = Math.max(...box.map(p => p.y)) - Math.min(...box.map(p => p.y));

    expect(tall).toBeCloseTo(80, 6);
  });

  test('a selection scale slides the room with it', () => {
    const { world, ids } = drawn(
      ['level', rect(-200, -20, 40, 40)],
      ['level', rect(160, -20, 40, 40)],
    );

    let w = world;

    for (const id of ids) w = wrote(w, 1, id, scaled(2, 2, { x: 0, y: 0 }));

    // The centre goes nowhere, and everything else goes out from it as the
    // scale grows: by twice at the end, and by the root of two half way.
    for (const t of [0, 0.5, 1]) {
      const f = 2 ** t;

      near(whereAt(w, ids[1], t), { x: 180 * f, y: 0 });
      near(whereAt(w, ids[0], t), { x: -180 * f, y: 0 });
    }
  });
});

describe('the incremental set', () => {
  test('leaves a polygon the version does not touch out of the work', () => {
    const still: [Named, Point[]][] = Array.from(
      { length: 20 },
      (_unused, i) => ['level', rect(1000 + i * 200, 0, 100, 100)] as [Named, Point[]],
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

    const keyframes = [...w.keyframes];
    keyframes[2] = { ...keyframes[2], visible: false };

    expect(pruned(bake, { ...w, keyframes }).spans.size).toBe(w.keyframes.length - 1);
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
    const pulled = nudging(grown, 1, ids[0], now.corners[where].id, { x: 0, y: -80 });

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
    const pulled = nudging(grown, 1, ids[0], now.corners[where].id, { x: 0, y: -80 });

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
    const pulled = nudging(grown, 1, ids[0], now.corners[where].id, { x: 0, y: -80 });

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

    return {
      world: transformed(world, 1, ids[1], { translation: { x: 120, y: 40 }, rotation: 0.7 }),
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

      // To the bake's own tolerance rather than to the digit. A floor under an
      // eroding group is kept in the *group's* frame, like every other member,
      // and a member turning inside a group that is itself turning is a
      // displacement in that frame — interpolated straight, and cut into
      // stretches until the chord is within `TOLERANCE` of the arc. Exactness
      // was what a floor had while it stood outside every union; standing in
      // one costs it the same thing it costs a room.
      mine.forEach((r, i) => r.points.forEach((p, j) => {
        const q = real[i].points[j];

        expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeLessThan(TOLERANCE);
      }));
    }

    expect(span.worst).toBeLessThan(TOLERANCE);
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

    const made = sealed(world, 0, ids, TOP)!;

    // The group turns and erodes; the floor slides and erodes inside it.
    const turned = transformed(made.world, 1, made.id, { rotation: 0.8, erosion: 12 });
    const moved = transformed(turned, 1, ids[1], {
      translation: { x: 60, y: -40 },
      rotation: -0.5,
      erosion: 18,
    });

    const span = run(bakeSpan(moved, 0));

    // Under the group's floor side, not the floor's own id: the group erodes,
    // so it stands for its members on every side it has one, and its floors
    // union like its rooms do. See `subjects`.
    const side = sideOf(made.id, kind('floor'));

    for (const t of [0, 0.2, 0.5, 0.8, 1]) {
      const mine = sample(span, t).filter(r => r.fill);
      const real = truth(moved, 0, t).filter(r => r.id === side);

      expect(mine.length).toEqual(real.length);
      expect(mine.length).toBeGreaterThan(0);

      // To the bake's own tolerance rather than to the digit. A floor under an
      // eroding group is kept in the *group's* frame, like every other member,
      // and a member turning inside a group that is itself turning is a
      // displacement in that frame — interpolated straight, and cut into
      // stretches until the chord is within `TOLERANCE` of the arc. Exactness
      // was what a floor had while it stood outside every union; standing in
      // one costs it the same thing it costs a room.
      mine.forEach((r, i) => r.points.forEach((p, j) => {
        const q = real[i].points[j];

        expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeLessThan(TOLERANCE);
      }));
    }

    expect(span.worst).toBeLessThan(TOLERANCE);
  });

  test('and a group eroding around it erodes it, as it does everything else', () => {
    // A group is one thing, and it erodes as one shape. Its floors are a set
    // like its rooms are, so what it hands over on that side is their union
    // pulled in by its own depth — which is what `floorsAt` draws standing
    // still, both of them through `contributing`, so the still and the morph
    // agree at the ends of the span by construction.
    const { world, ids } = drawn(
      ['level', rect(-200, -200, 400, 400)],
      ['floor', rect(-50, -50, 100, 100)],
    );

    const held = sealed(world, 0, ids, TOP)!;
    const eroding = transformed(held.world, 1, held.id, { erosion: 20 });
    const span = run(bakeSpan(eroding, 0));
    const side = sideOf(held.id, kind('floor'));
    const track = span.tracks.find(t => t.id === side);

    expect(track?.fill).toBe(true);

    // And it is still *there*. The track existing says nothing on its own: a
    // side that hands back an empty union at every instant looks perfectly
    // healthy from here.
    for (const t of [0, 0.5, 1]) {
      const mine = sample(span, t).filter(r => r.id === side);

      expect(mine.length).toBeGreaterThan(0);
      expect(length(mine)).toBeCloseTo(length(truth(eroding, 0, t).filter(r => r.id === side)), 9);
    }

    // Pulled in by the group's depth at the far end, where the depth is whole.
    // The floor is 100 square and the group takes 20 off every side of it.
    expect(length(sample(span, 1).filter(r => r.id === side))).toBeCloseTo(4 * 60, 6);
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

    return {
      world: nudging(out, 1, ids[0], middle.id, { x: 0, y: 80 }),
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

    const deep = wrote(world, 0, ids[0], erode(12));
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

describe('a corner arriving on a room inside a sealed group', () => {
  // The group's union is an arrangement, and dropped the point the room keeps
  // on its wall at the near end: the ring was a point short there, and the
  // corner's vertical stood all at once. See `slotted` in `scene.ts` and
  // `groupFading`.
  function arriving(depth: number): World {
    const { world, ids } = drawn(['level', rect(-100, -100, 200, 200)], ['level', rect(300, 0, 50, 50)]);
    const g = sealed(world, 0, ids, TOP)!;
    const w = depth === 0 ? g.world : wrote(g.world, 0, g.id, erode(depth));
    const it = resolveAt(w, 1).find(r => r.id === ids[0])!;
    const grown = addVertex(w, 1, it, 0, { x: 0, y: -100 });

    return nudging(grown.world, 1, ids[0], grown.vertex, { x: 0, y: -80 });
  }

  for (const depth of [0, 10]) {
    test(`is one stretch, and its vertical fades in${depth === 0 ? '' : ', the group eroding'}`, () => {
      const w = arriving(depth);
      const span = run(bakeSpan(w, 0));
      const s = span.tracks[0].stretches[0];

      expect(span.tracks.every(t => t.jumps.length === 0)).toBe(true);
      expect(drift(w)).toBeLessThan(TOLERANCE);
      expect(length(sample(span, 0))).toBeCloseTo(editorAt(w, 0), 6);

      // The one on the floor, off the corners, dark at the near end.
      const floor = s.a.flatMap((r, i) => r.points.flatMap((p, j) => (
        Math.abs(p.y + 100 - depth) < 1e-6 && Math.abs(p.x) < 50 ? [s.opacity[0][i][j]] : []
      )));

      expect(floor).toEqual([0]);
    });
  }
});

describe('a crossing is rebuilt from the edges it was named against', () => {
  // A crossing is not a position, it is two edges, and `drawn` rebuilds it at
  // every instant by indexing into each polygon's own shape. So the index has to
  // mean the same vertex at both ends of a stretch — and the boundary's names
  // agreeing does not say that. A shape can gain a vertex somewhere the boundary
  // does not reach, and then one end's index 6 and the other's are two different
  // edges, the stretch interpolates between them, and the error is however far
  // apart those edges happen to be. Nothing to do with the width of the interval,
  // so bisecting never touched it: a level sat at 5.86 against 0.05 with the
  // offending stretch's two ends 6e-8 apart. See `numbered`.

  /** Every crossing in the bake, checked against the shapes it will be rebuilt
   * from: the ring it names must be the same length at both ends of its
   * stretch, or the two indices are not the same vertex. */
  function mismatched(span: Span): number {
    let n = 0;

    for (const track of span.tracks) {
      for (const s of [...track.stretches, ...track.jumps]) {
        for (const run of s.origins) {
          for (const o of run) {
            if (o === null || o.kind !== 'cross') continue;

            for (const r of [o.a, o.b]) {
              const both = s.table.get(r.id);

              if (both === undefined) continue;
              if ((both.a[r.ring]?.length ?? 0) !== (both.b[r.ring]?.length ?? 0)) n++;
            }
          }
        }
      }
    }

    return n;
  }

  test('so a stretch never spans a change in its own vertex numbering', () => {
    // A wedge with one shallow corner. Eroding it kills that vertex partway
    // through the span, so the polygon's own count changes; the neighbour turning
    // across it supplies the crossings. Without the check these come back with
    // four to eight crossings rebuilt from mismatched edges.
    const wedge = [
      { x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 },
      { x: 120, y: 108 }, { x: 40, y: 100 }, { x: 0, y: 100 },
    ];

    for (const depth of [50, 52, 56, 70]) {
      const { world, ids } = drawn(['level', wedge], ['level', rect(60, 20, 240, 200)]);
      const w = transformed(
        transformed(world, 1, ids[0], { erosion: depth }),
        1,
        ids[1],
        { rotation: 0.4 },
      );

      const span = run(bakeSpan(w, 0));

      expect(mismatched(span)).toEqual(0);
      expect(span.worst).toBeLessThan(TOLERANCE);
    }
  });
});

describe('the bake chases its own error', () => {
  // `Span.worst` used to be a number the bake reported and did nothing about: a
  // level came back at eleven and a half against a tolerance of five hundredths
  // and the only lever was `GAP`, which charges every track for the depth two of
  // them need. Now a track outside the tolerance is cut again a decade finer,
  // and only that track pays. See `chased`.

  /** Six overlapping boxes turning against each other, which is where the
   * boundary bends hardest: the crossings between them travel, and a chord
   * across one of those is what `worst` is measuring. */
  function turning(): World {
    let world = emptyWorld();
    const ids: PolygonId[] = [];

    for (let i = 0; i < 6; i++) {
      const made = addPolygon(
        world,
        kind(i % 3 === 2 ? 'solid' : 'level'),
        rect(-140 + 60 * i, -90 + 40 * (i % 3), 150, 130),
        0,
        TOP,
      );

      world = made.world;
      ids.push(made.id);
    }

    ids.forEach((id, i) => {
      world = transformed(world, 1, id, { rotation: (i % 2 ? 1 : -1) * 0.6 });
    });

    return world;
  }

  test('a tolerance the first cut misses is reached by cutting again', () => {
    const world = turning();
    const tol = 1e-3;

    // Outside at the widths every track starts at — otherwise this test is
    // measuring nothing, so it is asserted rather than assumed.
    expect(run(bakeSpan(world, 0)).worst).toBeGreaterThan(tol);

    const span = run(bakeSpan(world, 0, tol));

    expect(span.worst).toBeLessThanOrEqual(tol);
    expect(span.strained).toEqual([]);
  });

  test('and a tolerance it reaches is not paid for by a tolerance it does not', () => {
    // The chase goes a decade at a time and stops when a decade stops paying,
    // so what it costs is bounded by how far it actually got — a track it
    // cannot help is one wasted decade, not five. Asking for four more digits
    // than the default costs a handful of times the work, not thousands.
    const world = turning();

    const loose = run(bakeSpan(world, 0));
    const tight = run(bakeSpan(world, 0, 1e-6));

    expect(tight.worst).toBeLessThanOrEqual(1e-6);
    expect(tight.evaluations).toBeLessThan(loose.evaluations * 20);
  });

  test('and what it gives up on it names, so nothing is buried', () => {
    // The invariant, which is the whole point of the field: a span that names
    // nothing is a span that is inside its tolerance. `divergence.test.ts`
    // checks it again across every world it draws.
    //
    // No world here strains it — the levels that do are pathological and slow,
    // and the numbers from one are recorded against `PAYING`. What is checked
    // here is the promise, on a level that keeps it.
    for (const tol of [TOLERANCE, 1e-3, 1e-5]) {
      const span = run(bakeSpan(turning(), 0, tol));
      const strained = span.strained ?? [];

      if (strained.length === 0) {
        expect(span.worst).toBeLessThanOrEqual(tol);
        continue;
      }

      expect(Math.max(...strained.map(s => s.worst))).toBeCloseTo(span.worst, 10);

      for (const s of strained) {
        expect(s.worst).toBeGreaterThan(tol);
        expect(s.gap).toBeLessThanOrEqual(1e-4);
        expect(span.tracks.some(t => t.id === s.id)).toBe(true);
      }
    }
  });

  test('and a ring that crosses itself does not need chasing at all', () => {
    // Straight out of a level that hung the bake at thirteen percent: a hexagon
    // with one vertex dragged across it, so the ring crosses itself five ways.
    // Nothing else in the world — it did this on its own.
    //
    // It came back as 11,922 discontinuities and an error of 7.6, and looking a
    // decade closer found 30,437 of them, so the chase kept paying for depth
    // until the heap gave out. None of them were events: a self-crossing is one
    // point of the boundary and two vertices of the arrangement, and the walk
    // named it by whichever it arrived through. Six now, and inside tolerance.
    // See `boundaryRuns`.
    const tangle = [[800, -600], [1319.6, -300], [1319.6, 300], [800, 600], [280.4, 300], [1400, 500]];
    const { world, ids } = drawn(['level', tangle.map(([x, y]) => ({ x, y }))]);

    const it = resolveAt(world, 1).find(r => r.id === ids[0])!;
    const span = run(bakeSpan(nudging(world, 1, ids[0], it.polygon.points[1].id, { x: -500, y: 900 }), 0));
    const track = span.tracks[0];

    expect(span.worst).toBeLessThan(TOLERANCE);
    expect(span.strained).toEqual([]);

    // The numbers, because the tolerance alone would pass on a bake that got
    // there by pinning ten thousand things that are not there.
    expect(track.jumps.length).toBeLessThan(50);
    expect(span.evaluations).toBeLessThan(2_000);
  }, 20_000);

  test('and a track that is already inside it is cut once', () => {
    // The property the whole thing rests on: a level that behaves pays nothing.
    const { world, ids } = drawn(['level', rect(0, 0, 200, 200)]);
    const w = transformed(world, 1, ids[0], { translation: { x: 40, y: 0 } });

    expect(run(bakeSpan(w, 0)).evaluations).toEqual(run(bakeSpan(w, 0, TOLERANCE)).evaluations);
    expect(run(bakeSpan(w, 0)).strained).toEqual([]);
  });
});

describe('a polygon grown into a neighbour its source never reaches', () => {
  // A track is cut against the polygons whose boxes meet its own, and the boxes
  // were taken off the source ring on the reasoning that erosion only shrinks.
  // A negative depth grows, and so does a group's depth on a solid, so a solid
  // dilated into a room was never in the room's neighbourhood: the room's
  // track drew its wall straight through the solid, and ended its runs at
  // whatever else happened to cross there, with a vertical standing on a flat
  // wall. The still sees everything and drew neither. See `grown`.

  /** Every point drawn, and whether a vertical stands on it. */
  function drawnAt(frame: Frame): string[] {
    return frame
      .flatMap(r => r.points.map((p, i) => `${p.x.toFixed(3)},${p.y.toFixed(3)}:${r.corner[i]}`))
      .sort();
  }

  function agrees(world: World): void {
    const span = run(bakeSpan(world, 0));

    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      expect(drawnAt(sample(span, t))).toEqual(drawnAt(truth(world, 0, t)));
    }
  }

  test('by a depth of its own', () => {
    const { world, ids } = drawn(
      ['level', rect(-200, -200, 400, 400)],
      ['solid', rect(-50, 250, 100, 100)],
    );

    // Grown at the near end and held, so that no instant of the span has the
    // source anywhere near the room.
    agrees(transformed(world, 0, ids[1], { erosion: -80 }));
  });

  test('by the depth of a group holding it', () => {
    // Two rooms grown as one by their group, up into a solid standing clear
    // of both sources. The solid's track has to see the group to find the
    // room it now cuts.
    const { world, ids } = drawn(
      ['level', rect(-200, -200, 190, 400)],
      ['level', rect(10, -200, 190, 400)],
      ['solid', rect(-50, 250, 100, 100)],
    );

    const held = sealed(world, 0, [ids[0], ids[1]], TOP)!;

    agrees(transformed(held.world, 0, held.id, { erosion: -80 }));
  });

  test('flush with a wall, and crossed there by a third', () => {
    // The level that found it: a room grown up to a dilated solid's edge, and
    // a big room over both whose edge crosses the shared wall. The room's
    // track, not seeing the solid, ended its wall at that crossing and stood a
    // vertical there.
    const { world, ids } = drawn(
      ['level', rect(-300, -300, 200, 200)],
      ['solid', rect(-400, 0, 400, 100)],
      ['level', [{ x: -250, y: -250 }, { x: 300, y: -250 }, { x: 300, y: 300 }, { x: -150, y: 300 }]],
    );

    agrees(transformed(world, 0, ids[1], { erosion: -100 }));
  });
});

describe('effects', () => {
  const ROUND: Effects = { round: inSegments(4, 20) };
  const ZIGZAG: Effects = { deform: { spacing: 66, pattern: 'zigzag', seed: 0, sides: 'both', jitter: 0 } };
  const round = (by: number): Writing => ({ kind: 'round', by });
  const deform = (by: number): Writing => ({ kind: 'deform', by });

  function room(fx: Effects): { world: World, id: PolygonId } {
    const { world, ids } = drawn(['level', rect(-100, -100, 200, 200)]);

    return { world: { ...world, effects: new Map([[ids[0], fx]]) }, id: ids[0] };
  }

  /** How many points the span draws at `t`. */
  const count = (span: Span, t: number) => sample(span, t).reduce((n, r) => n + r.points.length, 0);

  /**
   * The furthest the truth moves between two neighbouring instants of four
   * hundred across the span: every point of each from the other's outline. A
   * boundary that popped would be as far as what popped; one that moves
   * steadily is as far as it moves.
   */
  function steadiest(w: World): number {
    const segments = (f: Frame) => f.flatMap(r => r.points.slice(1).map((q, i) => [r.points[i], q] as const));
    const off = (p: Point, f: Frame) => Math.min(...segments(f).map(([a, c]) => {
      const dx = c.x - a.x, dy = c.y - a.y, l2 = dx * dx + dy * dy;
      const u = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));

      return Math.hypot(a.x + dx * u - p.x, a.y + dy * u - p.y);
    }));
    const apart = (a: Frame, c: Frame) => Math.max(...a.flatMap(r => r.points.map(p => off(p, c))), ...c.flatMap(r => r.points.map(p => off(p, a))));

    let worst = 0;
    let was = truth(w, 0, 0);

    for (let i = 1; i <= 400; i++) {
      const now = truth(w, 0, i / 400);

      worst = Math.max(worst, apart(was, now));
      was = now;
    }

    return worst;
  }

  test('a bevel growing from nought is one stretch, the ring as long at both ends', () => {
    const { world, id } = room(ROUND);
    const w = wrote(world, 1, id, round(30));
    const span = run(bakeSpan(w, 0));

    expect(span.tracks.every(t => t.stretches.length === 1)).toBe(true);
    expect(count(span, 0)).toEqual(count(span, 0.5));
    expect(count(span, 1)).toEqual(count(span, 0.5));
    expect(drift(w)).toBeLessThan(TOLERANCE);
    expect(length(sample(span, 1))).toBeCloseTo(editorAt(w, 1), 6);

    // Seeded, not collapsed: at the near end the arcs are a sliver of what
    // they grow to, and the outline is the editor's to within it.
    expect(Math.abs(length(sample(span, 0)) - editorAt(w, 0))).toBeLessThan(30 * 1e-2);
  });

  test('a bevel growing finer keeps its ring, draws the editor\'s outline at both ends, and fades its new points in', () => {
    // At a precision of `inSegments(4, 20)`, ten deep is three segments and
    // forty is six: the span lays six at both ends, three of them on facets
    // at the near one.
    const { world, id } = room({ round: inSegments(4, 20) });
    const w = wrote(wrote(world, 0, id, round(10)), 1, id, round(30));
    const span = run(bakeSpan(w, 0));

    expect(span.tracks.every(t => t.jumps.length === 0)).toBe(true);
    expect(span.tracks.every(t => t.stretches.length === 1)).toBe(true);
    expect(count(span, 0)).toEqual(count(span, 0.5));
    expect(count(span, 1)).toEqual(count(span, 0.5));
    expect(drift(w)).toBeLessThan(TOLERANCE);
    expect(length(sample(span, 0))).toBeCloseTo(editorAt(w, 0), 6);
    expect(length(sample(span, 1))).toBeCloseTo(editorAt(w, 1), 6);

    // Dark at the near end where they lie on a facet, and coming up.
    const s = span.tracks[0].stretches[0];
    const later = s.opacity[1].flat();

    expect(s.opacity[0].flat().filter((v, k) => v === 0 && later[k] > 0)).toHaveLength(4 * 3);
  });

  test('a turning room at a fixed bevel costs no stretches', () => {
    const { world, id } = room(ROUND);
    const w = wrote(wrote(world, 0, id, round(30)), 1, id, spun(Math.PI / 3));
    const span = run(bakeSpan(w, 0));

    expect(span.tracks.every(t => t.stretches.length === 1)).toBe(true);
    expect(drift(w)).toBeLessThan(TOLERANCE);
  });

  test('a corner arriving into a rounded ring arrives as its arc, and nothing jumps', () => {
    const { world, id } = room(ROUND);
    const w0 = wrote(world, 0, id, round(20));
    const it = resolveAt(w0, 1).find(r => r.id === id)!;
    const grown = addVertex(w0, 1, it, 0, { x: 0, y: -100 }).world;
    const now = resolveAt(grown, 1).find(r => r.id === id)!;
    const where = now.corners.findIndex(c => c.birth === 1);
    const pulled = nudging(grown, 1, id, now.corners[where].id, { x: 0, y: -80 });

    const span = run(bakeSpan(pulled, 0));

    // Cut more than once — an arc whose corner turns is not a lerp of its
    // ends, as a corner alone is — but never jumping: the arriving arc is in
    // the ring from the start, laid along the wall.
    expect(span.tracks.every(t => t.jumps.length === 0)).toBe(true);
    expect(count(span, 0)).toEqual(count(span, 0.5));
    expect(count(span, 1)).toEqual(count(span, 0.5));
    expect(drift(pulled)).toBeLessThan(TOLERANCE);
    expect(length(sample(span, 0))).toBeCloseTo(editorAt(pulled, 0), 6);
    expect(length(sample(span, 1))).toBeCloseTo(editorAt(pulled, 1), 6);

    // Its five points, seeded along the wall about where it grows from, are
    // dark there.
    const s = span.tracks[0].stretches[0];
    const seeds: number[] = [];

    s.a[0].points.forEach((p, j) => {
      if (Math.abs(p.x) < 1 && Math.abs(p.y + 100) < 1e-6) seeds.push(s.opacity[0][0][j]);
    });

    expect(seeds).toEqual([0, 0, 0, 0, 0]);
  });

  /** A room with a corner arriving on its deformed floor at v1, pulled out
   * of it. */
  function arriving(fx: Effects, ...ops: Writing[]): World {
    const { world, id } = room(fx);
    const w0 = wrote(world, 0, id, ...ops);
    const it = resolveAt(w0, 1).find(r => r.id === id)!;
    const grown = addVertex(w0, 1, it, 0, { x: 0, y: -100 }).world;
    const now = resolveAt(grown, 1).find(r => r.id === id)!;
    const where = now.corners.findIndex(c => c.birth === 1);

    return nudging(grown, 1, id, now.corners[where].id, { x: 0, y: -80 });
  }

  test('a corner arriving on a deformed floor starts from the editor\'s pattern, and nothing jumps', () => {
    // At the near end the floor is one edge with one pattern; at the far end
    // it is two, each with its own. The teeth are corners, so the ones the
    // halves gain arrive as corners do, and the ones the floor loses go.
    const w = arriving(ZIGZAG, deform(5));
    const span = run(bakeSpan(w, 0));

    expect(span.tracks.every(t => t.jumps.length === 0)).toBe(true);
    expect(count(span, 0)).toEqual(count(span, 1));
    expect(drift(w)).toBeLessThan(TOLERANCE);
    expect(length(sample(span, 0))).toBeCloseTo(editorAt(w, 0), 6);
    expect(length(sample(span, 1))).toBeCloseTo(editorAt(w, 1), 6);
  });

  test('rounded as well, its outline never pops', () => {
    // Where a rounded tooth goes through straight on its way, its arc lies on
    // a line for an instant and the arrangement drops it there, and the bake
    // pins that instant; nothing moves either side of it.
    const w = arriving({ ...ROUND, ...ZIGZAG }, round(10), deform(5));
    const span = run(bakeSpan(w, 0));

    expect(steadiest(w)).toBeLessThan(0.5);
    expect(drift(w)).toBeLessThan(TOLERANCE);
    expect(length(sample(span, 0))).toBeCloseTo(editorAt(w, 0), 6);
    expect(length(sample(span, 1))).toBeCloseTo(editorAt(w, 1), 6);
  });

  test('an edge growing longer gets more points, and they fade in', () => {
    // The right wall pulled out to twice its length: three teeth at the near
    // end, five at the far.
    const { world, id } = room(ZIGZAG);
    const w0 = wrote(world, 0, id, deform(5));
    const w = nudging(w0, 1, id, w0.polygons.get(id)!.points[2].id, { x: 0, y: 200 });

    const span = run(bakeSpan(w, 0));
    const s = span.tracks[0].stretches[0];

    // A tooth going from out to in lies on its line for an instant half way,
    // and the bake pins it there; the outline is the same either side.
    expect(count(span, 0)).toEqual(count(span, 1));
    expect(drift(w)).toBeLessThan(TOLERANCE);
    expect(length(sample(span, 0))).toBeCloseTo(editorAt(w, 0), 6);
    expect(length(sample(span, 1))).toBeCloseTo(editorAt(w, 1), 6);

    // The ones it gains are dark at the near end, and coming up.
    const later = s.opacity[1].flat();

    expect(s.opacity[0].flat().filter((v, k) => v === 0 && later[k] > 0).length).toBeGreaterThanOrEqual(2);
  });

  test('a corner arriving inside a rounded corner\'s reach starts on the editor\'s outline', () => {
    // Ten along from a corner rounded fifteen deep: on the stretch of wall
    // the arc has rounded away. Put there, it would clamp the arc short at the
    // near end, where the editor has it whole.
    //
    // Not asked to be free of jumps: as it turns it wants more than half of
    // the short wall between it and the corner, as that corner does, and the
    // two arcs meet in the middle of it — an event, which the bake keeps as
    // one.
    const { world, id } = room(ROUND);
    const w0 = wrote(world, 0, id, round(15));
    const it = resolveAt(w0, 1).find(r => r.id === id)!;
    const grown = addVertex(w0, 1, it, 0, { x: -90, y: -100 }).world;
    const now = resolveAt(grown, 1).find(r => r.id === id)!;
    const where = now.corners.findIndex(c => c.birth === 1);
    const w = nudging(grown, 1, id, now.corners[where].id, { x: 0, y: -60 });
    const span = run(bakeSpan(w, 0));

    expect(count(span, 0)).toEqual(count(span, 1));
    expect(drift(w)).toBeLessThan(TOLERANCE);
    expect(Math.abs(length(sample(span, 0)) - editorAt(w, 0))).toBeLessThan(15 * 1e-3);
    expect(length(sample(span, 1))).toBeCloseTo(editorAt(w, 1), 6);
  });

  test('a deform starting from nought fades its verticals in', () => {
    const { world, id } = room(ZIGZAG);
    const w = wrote(world, 1, id, deform(10));
    const span = run(bakeSpan(w, 0));
    const s = span.tracks[0].stretches[0];

    expect(span.tracks.every(t => t.stretches.length === 1)).toBe(true);
    expect(count(span, 0)).toEqual(count(span, 1));
    expect(length(sample(span, 0))).toBeCloseTo(editorAt(w, 0), 6);
    expect(length(sample(span, 1))).toBeCloseTo(editorAt(w, 1), 6);
    expect(drift(w)).toBeLessThan(TOLERANCE);

    // The twelve deform points, flat on the walls at the near end.
    const flat: [number, number][] = [];

    s.a.forEach((r, i) => r.points.forEach((p, j) => {
      if (Math.abs(Math.abs(p.x) - 100) + Math.abs(Math.abs(p.y) - 100) > 1e-6) flat.push([i, j]);
    }));

    expect(new Set(flat.map(([i, j]) => `${s.a[i].points[j].x},${s.a[i].points[j].y}`)).size).toEqual(12);

    for (const [i, j] of flat) {
      expect(s.opacity[0][i][j]).toBeCloseTo(0, 9);
      expect(s.opacity[1][i][j]).toBeCloseTo(1, 9);
    }
  });

  test('a room scaled and eroded in one span is eroded in proportion, and nothing jumps', () => {
    // Its depth is a length at its own scale, so doubled it is twice as deep
    // at the far end, and the bake and the editor agree all the way across.
    const { world, id } = room({});
    let w = wrote(world, 0, id, erode(10));

    w = wrote(w, 1, id, scaled(2, 2, { x: 0, y: 0 }), erode(10));

    const span = run(bakeSpan(w, 0));

    expect(stateAt(w, id, 1).erosion).toBe(20);
    expect(resolveAt(w, 1).find(r => r.id === id)!.erosion).toBeCloseTo(40, 9);
    expect(span.tracks.every(t => t.jumps.length === 0)).toBe(true);

    // Exactly: in its own frame the depth is a lerp, and so is where the
    // shader puts each corner. A depth in the world could only be chased.
    expect(drift(w)).toBeLessThan(1e-6);
    expect(length(sample(span, 0))).toBeCloseTo(editorAt(w, 0), 6);
    expect(length(sample(span, 1))).toBeCloseTo(editorAt(w, 1), 6);
  });

  test('a growing wall\'s reach follows a scale that peaks inside the span', () => {
    // A stand plays its scale axis by axis in a line, so tall to wide passes
    // through square: (1, 4) to (4, 1) is (2.5, 2.5) half way, a scale of 2.5
    // against 2 at either end. With its walls pushed a long way out, the room
    // reaches furthest sideways there, past where it reaches at either end —
    // far enough to touch a room it touches nowhere else. So it is that
    // room's neighbour, or where they meet goes unsolved.
    const room = rect(-5, -5, 10, 10);
    // Unchained at the far keyframe, which writes the state there outright,
    // and that stand turned from tall to wide.
    const growing = (world: World, id: PolygonId): World => {
      const w = unchained(wrote(world, 0, id, scaled(1, 4, { x: 0, y: 0 }), erode(-40)), 1, [id]);
      const rig = keyRigOf(w, id);
      const keys = rig.keys.get(1)!.map(k => (k.stand === undefined
        ? k
        : { ...k, stand: { ...k.stand, frame: { ...k.stand.frame, scale: { x: 4, y: 1 } } } }));

      return withKeyRig(w, id, { ...rig, keys: new Map(rig.keys).set(1, keys) });
    };

    // On its own, sideways: 5 + 40·2 at the near end, 20 + 40·2 at the far
    // and 12.5 + 40·2.5 half way, the most of it.
    const alone = drawn(['level', room]);
    const w0 = growing(alone.world, alone.ids[0]);
    const reach = (t: number) => Math.max(...truth(w0, 0, t).flatMap(r => r.points).map(p => p.x));

    expect(reach(0)).toBeLessThan(106);
    expect(reach(1)).toBeLessThan(106);
    expect(reach(0.5)).toBeGreaterThan(106);

    // And with the other room there, where only the peak reaches it.
    const { world, ids } = drawn(['level', room], ['level', rect(106, -5, 10, 10)]);
    const [a, b] = ids;
    const w = growing(world, a);
    const near = ready(w, 0).near.find(n => n[0].at.id === a)!;

    expect(near.map(m => m.at.id)).toContain(b);
  });

  test('a group growing keeps the teeth on its rooms, and nothing jumps', () => {
    // Its deform is its rooms': each has teeth of its own, spaced in the
    // group's scale, so scaled they are the same teeth further apart.
    const { world, ids } = drawn(['level', rect(0, 0, 100, 100)], ['level', rect(160, 0, 100, 100)]);
    const g = sealed(world, 0, ids, TOP)!;
    let w = wrote({ ...g.world, effects: new Map([[g.id, ZIGZAG]]) }, 0, g.id, deform(5));

    w = wrote(w, 1, g.id, scaled(1.8, 1.8, { x: 130, y: 50 }));

    const span = run(bakeSpan(w, 0));

    expect(span.tracks.every(t => t.jumps.length === 0)).toBe(true);
    expect(count(span, 0)).toEqual(count(span, 1));
    expect(drift(w)).toBeLessThan(TOLERANCE);
    expect(length(sample(span, 0))).toBeCloseTo(editorAt(w, 0), 6);
    expect(length(sample(span, 1))).toBeCloseTo(editorAt(w, 1), 6);

    const s = span.tracks[0].stretches[0];
    const later = s.opacity[1].flat();

    expect(s.opacity[0].flat().filter((v, k) => v === 0 && later[k] > 0)).toHaveLength(0);
  });

  test('where a deformed group\'s rooms overlap, their teeth cross, and the outline never pops', () => {
    // Two rooms on one line: along the stretch they share, each has its own
    // teeth, and the union is whichever is further out. Where one tooth
    // passes another, a crossing comes or goes, which the bake pins.
    const { world, ids } = drawn(['level', rect(0, 0, 100, 100)], ['level', rect(60, 0, 140, 100)]);
    const g = sealed(world, 0, ids, TOP)!;
    let w = wrote({ ...g.world, effects: new Map([[g.id, ZIGZAG]]) }, 0, g.id, deform(5));

    w = wrote(w, 1, g.id, scaled(1.8, 1.8, { x: 100, y: 50 }));

    const span = run(bakeSpan(w, 0));

    expect(steadiest(w)).toBeLessThan(0.5);
    expect(span.worst).toBeLessThan(TOLERANCE);
    expect(length(sample(span, 1))).toBeCloseTo(editorAt(w, 1), 6);
  });

  test('a group eroding loses teeth, and nothing moves at the pops', () => {
    // Its teeth are laid on its fold, whose straights have no names yet: a
    // tooth that comes or goes as the clear by an arc grows is a jump, at
    // nought height. See PLAN-bevel, phase 2.
    const { world, ids } = drawn(['level', rect(0, 0, 100, 100)], ['level', rect(60, 0, 140, 100)]);
    const g = sealed(world, 0, ids, TOP)!;
    let w = wrote({ ...g.world, effects: new Map([[g.id, { ...ROUND, ...ZIGZAG }]]) }, 0, g.id, round(10), deform(5));

    w = wrote(w, 1, g.id, erode(30));

    const span = run(bakeSpan(w, 0));

    expect(steadiest(w)).toBeLessThan(0.5);

    // Off the pop itself, at four fifths: exactly there, the bake and the
    // editor may each be on either side of it. Twice the tolerance: a held
    // arc's teeth are carried onto one the erosion grows, which is no lerp.
    expect(drift(w, 0, 39)).toBeLessThan(2 * TOLERANCE);
    expect(length(sample(span, 0))).toBeCloseTo(editorAt(w, 0), 6);
    expect(length(sample(span, 1))).toBeCloseTo(editorAt(w, 1), 6);
  });

  test('a union edge cut in two lays its teeth from the middles of the two', () => {
    // A room rising through the top wall of the room it is sealed in with,
    // point first: part way, the wall's union edge becomes two, either side
    // of it. The teeth are counted from the wall's own middle, so the two
    // pieces show the teeth it had. Only within a spacing of the cut does
    // anything change at that instant: the teeth there shrink to the new
    // ends, which are on the wall's line where the pattern was not — a jump
    // the union makes, being cut before it is deformed.
    const diamond = [{ x: 104, y: 20 }, { x: 124, y: 40 }, { x: 104, y: 60 }, { x: 84, y: 40 }];
    const { world, ids } = drawn(['level', rect(0, 0, 200, 100)], ['level', diamond]);
    const g = sealed(world, 0, ids, TOP)!;
    const fx: Effects = { deform: { spacing: 20, pattern: 'zigzag', seed: 0, sides: 'both', jitter: 0 } };
    let w = wrote({ ...g.world, effects: new Map([[g.id, fx]]) }, 0, g.id, deform(5));

    w = wrote(w, 1, ids[1], move(0, 60));

    // The wall, away from where it is cut.
    const wall = (f: Frame) => f.flatMap(r => r.points)
      .filter(p => p.y > 90 && Math.abs(p.x - 104) > 20)
      .map(p => `${p.x.toFixed(6)},${p.y.toFixed(6)}`);
    const key = (f: Frame) => new Set(wall(f));

    // Before the tip reaches the wall at two thirds of the span, and after:
    // a straight is laid from its own middle, so cut in two its pattern
    // starts again from each half's. The event is the arrangement's own.
    expect(key(truth(w, 0, 0.66))).not.toEqual(key(truth(w, 0, 0.67)));
    expect(key(truth(w, 0, 0)).size).toBeGreaterThanOrEqual(8);
    expect(drift(w)).toBeLessThan(TOLERANCE);
  });

  test('a group\'s bevel growing from nought, on its union', () => {
    const { world, ids } = drawn(['level', rect(0, 0, 100, 100)], ['level', rect(60, 0, 140, 100)]);
    const g = sealed(world, 0, ids, TOP)!;
    const w = wrote({ ...g.world, effects: new Map([[g.id, ROUND]]) }, 1, g.id, round(20));
    const span = run(bakeSpan(w, 0));

    expect(count(span, 0)).toEqual(count(span, 1));
    expect(drift(w)).toBeLessThan(TOLERANCE);
    expect(length(sample(span, 1))).toBeCloseTo(editorAt(w, 1), 6);
  });

  test('and growing finer on its union, the editor\'s outline at both ends', () => {
    const { world, ids } = drawn(['level', rect(0, 0, 100, 100)], ['level', rect(60, 0, 140, 100)]);
    const g = sealed(world, 0, ids, TOP)!;
    const fx = { ...g.world, effects: new Map([[g.id, { round: inSegments(4, 20) }]]) };
    const w = wrote(wrote(fx, 0, g.id, round(10)), 1, g.id, round(30));
    const span = run(bakeSpan(w, 0));

    expect(span.tracks.every(t => t.jumps.length === 0)).toBe(true);
    expect(count(span, 0)).toEqual(count(span, 1));
    expect(drift(w)).toBeLessThan(TOLERANCE);
    expect(length(sample(span, 0))).toBeCloseTo(editorAt(w, 0), 6);
    expect(length(sample(span, 1))).toBeCloseTo(editorAt(w, 1), 6);
  });
});

// -----------------------------------------------------------------------------
// Keeping the tracks an edit did not reach
//
// The whole of the incremental bake's correctness is one claim: a span baked
// from an earlier one is the span a full bake would have made. So that is what
// is tested, over every shape of edit there is — and by comparing the tracks
// themselves rather than a sample of them, because what a kept track has to be
// is the track the cut would have produced, stretch for stretch and point for
// point.
//
// The edits are chosen for what they reach rather than for what they look
// like. Writing an operation on a polygon reaches the polygon; sealing a group
// reaches every member of it and every track any member falls near, through
// `scopes`, without a word being written about any of them. Adding a polygon
// reaches whoever it lands on, and nobody else. A test that only ever nudged
// something would pass with a signature that held nothing but the polygon's own
// operations.
// -----------------------------------------------------------------------------

describe('a bake that keeps the tracks an edit did not reach', () => {
  /** A few rooms in a row with a pillar in one, which is enough for a
   * neighbourhood to mean something and small enough to bake often. */
  function row(): { world: World, ids: PolygonId[] } {
    const made = drawn(
      ['level', rect(0, 0, 150, 150)],
      ['level', rect(140, 40, 120, 60)],
      ['level', rect(250, 0, 150, 150)],
      ['solid', rect(40, 40, 50, 50)],
      ['level', rect(0, 200, 150, 150)],
    );

    return { world: transformed(made.world, 1, made.ids[0], { erosion: 12 }), ids: made.ids };
  }

  /** Bake from nothing, edit, and bake again from what the first one made. */
  function again(world: World, edit: (w: World) => World): [Span, Span] {
    const before = run(bakeSpan(world, 0));
    const after = edit(world);

    return [run(bakeSpan(after, 0, TOLERANCE, undefined, before)), run(bakeSpan(after, 0))];
  }

  const edits: [string, (w: World, ids: PolygonId[]) => World][] = [
    ['nothing at all', w => w],
    ['an erosion on one of them', (w, ids) => transformed(w, 1, ids[2], { erosion: 10 })],
    ['a move on one of them', (w, ids) => transformed(w, 1, ids[1], { translation: { x: 0, y: 12 } })],
    ['a turn on one of them', (w, ids) => transformed(w, 1, ids[0], { rotation: 0.3 })],
    ['a corner nudged', (w, ids) => nudging(w, 1, ids[2], w.polygons.get(ids[2])!.points[0].id, { x: -20, y: 10 })],
    ['a corner taken out', (w, ids) => removeVertices(w, 1, [w.polygons.get(ids[0])!.points[2].id])],
    ['a polygon born into the far end', w => addPolygon(w, kind('solid'), rect(60, 250, 40, 40), 1, TOP).world],
    ['a polygon taken out at the far end', (w, ids) => removeAt(w, 1, [ids[3]])],
    ['a polygon far from everything', w => addPolygon(w, kind('level'), rect(900, 900, 80, 80), 0, TOP).world],
    ['a group sealed over two of them', (w, ids) => sealed(w, 0, [ids[0], ids[3]], TOP)!.world],
    [
      'a sealed group eroding',
      (w, ids) => {
        const made = sealed(w, 0, [ids[0], ids[3]], TOP)!;

        return wrote(made.world, 1, made.id, erode(9));
      },
    ],
    [
      'a polygon slid into somebody else\'s neighbourhood',
      (w, ids) => transformed(w, 1, ids[4], { translation: { x: 260, y: -140 } }),
    ],
  ];

  for (const [what, edit] of edits) {
    test(what, () => {
      const { world, ids } = row();
      const [kept, whole] = again(world, w => edit(w, ids));

      expect(kept.tracks).toEqual(whole.tracks);
      expect(kept.worst).toBe(whole.worst);
      expect(kept.strained).toEqual(whole.strained);
    });
  }

  test('an edit that reaches nothing cuts nothing', () => {
    const { world, ids } = row();
    const before = run(bakeSpan(world, 0));

    // A polygon the other side of the level: it lands in nobody's
    // neighbourhood, so every track that was cut stands and only its own is
    // new.
    const after = addPolygon(world, kind('level'), rect(900, 900, 80, 80), 0, TOP).world;
    const span = run(bakeSpan(after, 0, TOLERANCE, undefined, before));

    // The same objects, not merely equal ones: a kept track is the track that
    // was already cut, and identity is the only way to say that the cut did not
    // quietly run again and agree.
    expect(span.tracks.filter(t => before.tracks.includes(t)).length).toBe(before.tracks.length);
    expect(span.tracks.length).toBe(before.tracks.length + 1);
    expect(ids.length).toBeGreaterThan(0);
  });

  test('an edit reaches its own polygon and its neighbours, and stops', () => {
    const { world, ids } = row();
    const before = run(bakeSpan(world, 0));
    const after = transformed(world, 1, ids[2], { erosion: 10 });
    const span = run(bakeSpan(after, 0, TOLERANCE, undefined, before));
    const cut = span.tracks.filter(t => !before.tracks.includes(t));

    expect(cut.map(t => t.id)).toContain(ids[2]);
    expect(cut.length).toBeLessThan(before.tracks.length);
  });

  test('a first bake keeps nothing', () => {
    const { world } = row();

    expect(run(bakeSpan(world, 0)).tracks.every(t => t.sig.length === 16)).toBe(true);
  });

  test('every span of a chain, baked again', () => {
    const { world, ids } = row();
    const w = transformed(world, 2, ids[1], { erosion: 8 });
    const first = run(bakeAll(w));
    const after = transformed(w, 1, ids[2], { translation: { x: 4, y: 0 } });

    const again = run(bakeAll(after, TOLERANCE, undefined, { spans: first, progress: null }));
    const whole = run(bakeAll(after));

    for (const [from, span] of whole) expect(again.get(from)!.tracks).toEqual(span.tracks);
  });
});
