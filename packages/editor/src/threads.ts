// -----------------------------------------------------------------------------
// The bake, across as many threads as there are
//
// A prototype, and — measured — not yet worth turning on. It is kept because it
// is correct and because what it measured is worth knowing.
//
// The bake ought to be embarrassingly parallel: a track is cut against its own
// neighbourhood, reads only the world it was handed, and writes nowhere, so any
// number of them can be cut at once with nothing to coordinate. And it is.
// `bench.html` compares the two paths stretch by stretch and they are identical
// every time, at every thread count.
//
// It is also slower. On a level of 283 polygons over four spans, in a build,
// each figure a page of its own so that no run warms or crowds another:
//
//     on this thread          4.4s
//      1 worker              19.5s
//      2 workers             11.1s
//      8 workers              6.6s
//
// A single uncontended worker is three and a half times slower than this thread
// at the same work, repeatably, so the threads spend their parallelism buying
// back what the move cost and never quite finish paying.
//
// Why, and what would fix it
// --------------------------
// Not the message protocol: handing the work out one polygon at a time and a
// whole span at a time bracket the same number, and the span-at-a-time end is
// the *worse* one. Not the copy back, which measures at two per cent. Not the
// worker itself — arithmetic in one runs at exactly main-thread speed, and so
// does allocation, so long as little is being held.
//
// It is the garbage collector, and the thing it responds to is how much the
// thread is holding while it allocates. Allocating hard while retaining a large
// live set costs this thread 0.5s the first time and 3.6s every time after,
// once its heap has grown — and costs a worker 4.4s from the outset. A worker
// starts where a main thread ends up, and the bake is exactly that shape of
// work: millions of short-lived points, against a live set that grows all the
// way through a span.
//
// Most of that live set is `Stretch.table` — every neighbour's whole eroded
// shape at both ends of every stretch, which is what the crossings are solved
// from. Measured at seven times the runs it exists to serve: 28MB against 4MB
// on a thousand-polygon span, and a neighbour's shape repeated in every stretch
// of every track that touches it. Sharing those instead of copying them would
// shrink the file, the retained set and the collector's work together, and is
// the thing to do before reaching for threads again.
// -----------------------------------------------------------------------------

import { Slice, Span, TOLERANCE, joined, ridersOf } from './bake';
import { VersionId, World } from './types';
import type { FromWorker, ToWorker } from './bake.worker';

/** How many to open. One per core, less the one this is running on. */
export function cores(): number {
  const n = typeof navigator === 'undefined' ? 0 : (navigator.hardwareConcurrency ?? 0);

  return Math.max(1, Math.min(12, n - 1 || 3));
}

export function available(): boolean {
  return typeof Worker !== 'undefined';
}

/**
 * How many polygons go out at once. Small enough that the tail is short — the
 * last handful is all anyone can be left waiting on — and large enough that a
 * thread is not spending its time on the postbox.
 */
const HANDFUL = 6;

export interface Pool {
  /** Every span in the chain, with `tick` called as they come along. */
  bake: (world: World, tick: (at: number) => void) => Promise<Map<VersionId, Span>>
  close: () => void
}

export function pool(count = cores(), handful = HANDFUL): Pool {
  const threads = Array.from({ length: count }, () =>
    new Worker(new URL('./bake.worker.ts', import.meta.url), { type: 'module' }));

  return {
    close: () => threads.forEach(w => w.terminate()),

    bake: async (world, tick) => {
      const out = new Map<VersionId, Span>();
      const spans = world.versions.length - 1;

      for (const w of threads) send(w, { kind: 'open', world });

      for (let from = 0; from < spans; from++) {
        const riders = ridersOf(world, from);
        const queue: number[][] = [];

        for (let i = 0; i < riders.size; i += handful) {
          queue.push(Array.from(
            { length: Math.min(handful, riders.size - i) },
            (_unused, k) => i + k,
          ));
        }

        const total = queue.length;
        const slices: Slice[] = [];

        // Each thread takes the next handful the moment it hands one back, so
        // nobody is idle until the queue is empty and nobody is left holding
        // more than one handful's worth of work at the end.
        await Promise.all(threads.map(async w => {
          while (true) {
            const which = queue.shift();
            if (which === undefined) return;

            slices.push(await cut(w, { kind: 'cut', from, which, tol: TOLERANCE }));

            tick((from + (total - queue.length) / total) / spans);
          }
        }));

        out.set(from, joined(world, from, riders, slices));
      }

      return out;
    },
  };
}

function send(w: Worker, m: ToWorker): void {
  w.postMessage(m);
}

/** One handful, resolved when its tracks come back. One outstanding job per
 * thread, so there is nothing to correlate. */
function cut(w: Worker, job: ToWorker): Promise<Slice> {
  return new Promise((resolve, reject) => {
    w.onmessage = (e: MessageEvent<FromWorker>) => {
      if (e.data.kind === 'progress') return;

      w.onmessage = null;
      resolve(e.data.slice);
    };

    w.onerror = e => reject(new Error(e.message));

    send(w, job);
  });
}
