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
