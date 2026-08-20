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

    const { points, table, stretches } = weight(span);

    // What a frame of replay costs, which is the other number that matters.
    const s0 = performance.now();
    for (let i = 0; i < 60; i++) sample(span, i / 59);
    const per = (performance.now() - s0) / 60;

    console.log(
      `${String(w.polygons.size).padStart(4)} polys, ` +
      `${String(w.versions[1].edits.size).padStart(3)} edited  ` +
      `bake ${ms.toFixed(0).padStart(6)}ms  ` +
      `csg ${String(span.evaluations).padStart(6)}  ` +
      `stretches ${String(stretches).padStart(5)}  ` +
      `worst ${span.worst.toFixed(4)}  ` +
      `runs ${(points * 8 / 1e6).toFixed(1)}MB  ` +
      `table ${(table * 8 / 1e6).toFixed(1)}MB  ` +
      `sample ${per.toFixed(2)}ms/frame`,
    );
  }
}, 1200000);
