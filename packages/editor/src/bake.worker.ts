// -----------------------------------------------------------------------------
// One thread's share of a bake
//
// The world comes over once, on `open`, because it does not change while a bake
// runs and cloning it per job would be the one part of this that scales with
// how many threads there are. After that a job is a span and a handful of
// indices into it.
//
// The resolved span is kept between jobs. Resolving it is the fixed cost of
// putting a thread on a span at all — the world twice over, and the sweep that
// says who can reach whom — and paying it per handful would swamp the handfuls.
// The pool works through one span before moving to the next, so keeping the
// last one is enough; there is nothing to evict.
//
// What goes back is geometry, and there is a lot of it. It is plain objects and
// `Map`s, all of which the structured clone handles, and none of it is a buffer
// to hand over instead. Measured, the copy is a couple of per cent of the
// cutting it saves.
// -----------------------------------------------------------------------------

import { Ready, Slice, TOLERANCE, cutSome, ready } from './bake';
import { VersionId, World } from './types';

export type ToWorker =
  | { kind: 'open', world: World }
  | { kind: 'cut', from: VersionId, which: number[], tol: number };

export type FromWorker =
  | { kind: 'progress', at: number }
  | { kind: 'cut', slice: Slice };

let world: World | null = null;
let at: Ready | null = null;

/** How often to look up from the work. Often enough that a bar moves, rarely
 * enough that posting is not the job. */
const TICK = 60;

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const message = e.data;

  if (message.kind === 'open') {
    world = message.world;
    at = null;
    return;
  }

  if (world === null) return;

  let setup = 0;

  if (at === null || at.from !== message.from) {
    at = ready(world, message.from);
    setup = at.setup;
  }

  const job = cutSome(at, message.which, message.tol ?? TOLERANCE);

  let step = job.next();
  let until = performance.now() + TICK;

  while (!step.done) {
    if (performance.now() >= until) {
      post({ kind: 'progress', at: step.value });
      until = performance.now() + TICK;
    }

    step = job.next();
  }

  post({ kind: 'cut', slice: { ...step.value, setup } });
};

function post(m: FromWorker): void {
  (self as unknown as { postMessage: (m: FromWorker) => void }).postMessage(m);
}
