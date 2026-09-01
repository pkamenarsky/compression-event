// -----------------------------------------------------------------------------
// What a bake costs
//
// Kept out of the test suite deliberately: it takes a minute at the top size,
// and it measures rather than asserts. `pnpm bench` runs it.
//
// The threaded path is not here, because there are no `Worker`s in the runner.
// It is measured in the browser, where it will actually run — open
// /bench.html and it does both and prints the two side by side.
// -----------------------------------------------------------------------------

import { test } from 'vitest';
import { Span, bakeSpan, sample } from '../packages/editor/src/bake';
import { TOP, grouped, withEdit } from '../packages/editor/src/scene';
import { EMPTY_TRANSFORM, World } from '../packages/editor/src/types';
import { SIZES, level, version, weight } from './level';

/**
 * What the span costs written out, in the flattest form a file would take:
 * every coordinate a float64 and nothing else. Not a format, a floor — but it
 * is the number that decides whether a level's bake can be shipped.
 */
/** Points are two float64s apiece, which is what makes a megabyte here. */
function mb(points: number): string {
  return (points * 16 / 1e6).toFixed(1);
}

function bytes(span: Span): number {
  let n = 0;

  for (const track of span.tracks) {
    for (const st of track.stretches) {
      // A point is two float64s.
      for (const run of st.a) n += run.points.length * 16;
      for (const run of st.b) n += run.points.length * 16;

      for (const both of st.table.values()) {
        for (const ring of both.a) n += (ring?.length ?? 0) * 16;
        for (const ring of both.b) n += (ring?.length ?? 0) * 16;
      }

      // A crossing names two edges, each a polygon, a ring and an index; the
      // rest is a byte saying it is not a crossing.
      for (const run of st.origins) {
        for (const o of run) n += o !== null && o.kind === 'cross' ? 13 : 1;
      }
    }
  }

  return n;
}

/**
 * What an eroding group costs, which is a different question from what a level
 * costs.
 *
 * A group with a depth on it is one boundary rather than several, so its track
 * is cut against everything any of its members touches, and its projection is
 * an arrangement worked out afresh at every instant that track's neighbours
 * look at. Neither is avoidable — that is what eroding the union means — so the
 * row is here to keep the constant honest rather than to be driven to zero.
 */
test('what an eroding group adds', () => {
  const rooms = 120;

  const held = (w: World, ids: number[], n: number, t: Partial<typeof EMPTY_TRANSFORM>) => {
    const made = grouped(w, 0, ids.slice(0, n), TOP);

    if (made === null) throw new Error('a group needs two');

    return withEdit(made.world, 1, made.id, {
      transform: { ...EMPTY_TRANSFORM, ...t },
      vertices: new Map(),
      depths: new Map(),
    });
  };

  const { world, ids } = level(rooms);
  const plain = version(world, ids, 0.6);

  const cases: [string, World][] = [
    ['no group', plain],
    ['a group of 8, no depth', held(plain, ids, 8, {})],
    ['a group of 8, eroding', held(plain, ids, 8, { erosion: 10 })],
    ['a group of 8, eroding and turning', held(plain, ids, 8, { erosion: 10, rotation: 0.35 })],
  ];

  for (const [name, w] of cases) {
    const t0 = performance.now();
    const job = bakeSpan(w, 0);

    let step = job.next();
    while (!step.done) step = job.next();

    const span: Span = step.value;
    const ms = performance.now() - t0;

    console.log(
      `${name.padEnd(36)} bake ${ms.toFixed(0).padStart(6)}ms  ` +
      `csg ${String(span.evaluations).padStart(6)}  ` +
      `stretches ${String(weight(span).stretches).padStart(5)}  ` +
      `worst ${span.worst.toFixed(4)}`,
    );
  }
}, 1200000);

/**
 * What a depth per corner costs, against the same level offset uniformly.
 *
 * Not the offset itself. `erodeAt` and `erode` are one construction with the
 * depths written out differently, they hand the boolean an arrangement of the
 * same size, and a level with none of these on it bakes in exactly the time it
 * did before they existed.
 *
 * What it costs is stretches, and the `csg` column says so: the two rise
 * together, so the bake is doing the same work per instant at more instants.
 * That is the feature rather than the implementation. A uniform offset moves
 * every edge parallel to itself, so a straight run stays straight and a corner
 * keeps the neighbours it had; a corner offset apart tilts the two edges
 * meeting at it, which turns flat corners the uniform offset would have dropped
 * into real ones and slides the corner's own image along a line neither of its
 * edges lies on. More of the boundary is moving, and moving less predictably,
 * so the event search finds more places where it has to cut.
 */
test('what a depth per corner adds', () => {
  const rooms = 120;
  const { world, ids } = level(rooms);

  const cases: [string, World][] = [
    ['every corner at one depth', version(world, ids, 0.6)],
    ['a corner apart on 1 in 4', version(world, ids, 0.6, 1, 0.25)],
    ['a corner apart on all of them', version(world, ids, 0.6, 1, 1)],
  ];

  for (const [name, w] of cases) {
    const t0 = performance.now();
    const job = bakeSpan(w, 0);

    let step = job.next();
    while (!step.done) step = job.next();

    const span: Span = step.value;
    const ms = performance.now() - t0;

    console.log(
      `${name.padEnd(36)} bake ${ms.toFixed(0).padStart(6)}ms  ` +
      `csg ${String(span.evaluations).padStart(6)}  ` +
      `stretches ${String(weight(span).stretches).padStart(5)}  ` +
      `worst ${span.worst.toFixed(4)}`,
    );
  }
}, 1200000);

test('a bake at level scale', () => {
  for (const [rooms, share] of SIZES) {
    const { world, ids } = level(rooms);
    const w = version(world, ids, share);

    const t0 = performance.now();
    const job = bakeSpan(w, 0);

    let step = job.next();
    while (!step.done) step = job.next();

    const span: Span = step.value;
    const ms = performance.now() - t0;

    const size = weight(span);

    // What a frame of replay costs, which is the other number that matters.
    const s0 = performance.now();
    for (let i = 0; i < 60; i++) sample(span, i / 59);
    const per = (performance.now() - s0) / 60;

    console.log(
      `${String(w.polygons.size).padStart(4)} polys, ` +
      `${String(w.versions[1].edits.size).padStart(3)} edited  ` +
      `bake ${ms.toFixed(0).padStart(6)}ms  ` +
      `csg ${String(span.evaluations).padStart(6)}  ` +
      `stretches ${String(size.stretches).padStart(5)}  ` +
      `worst ${span.worst.toFixed(4)}  ` +
      `held ${mb(size.held)}MB ` +
      `(runs ${mb(size.runs)} + table ${mb(size.held - size.runs)}, ` +
      `read ${mb(size.read)})  ` +
      `sample ${per.toFixed(2)}ms/frame  ` +
      `file ${(bytes(span) / 1e6).toFixed(1)}MB`,
    );
  }
}, 1200000);
