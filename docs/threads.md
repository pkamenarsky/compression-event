# Threading the bake

`packages/editor/src/threads.ts` splits a bake across Web Workers, one thread
per core. It is correct and it is off.

## Why it should work

The bake is embarrassingly parallel by construction: a track is cut against a
fixed neighbourhood, reads only the world it was handed, and writes nowhere
shared. Any number of tracks can be cut at once with nothing to coordinate.
`bench.html` confirms this — it compares the threaded and serial paths
stretch by stretch, and they come back identical at every thread count.

## Why it is off

It is slower. On a level of 283 polygons over four spans, in a production
build, each figure measured on its own page load so no run warms or crowds
another:

```
on this thread          4.4s
 1 worker              19.5s
 2 workers             11.1s
 8 workers              6.6s
```

A single uncontended worker is three and a half times slower than the main
thread doing the same work, repeatably. The threads spend their parallelism
buying back what the move to a worker cost, and never quite finish paying —
even at 8 threads it's still behind doing nothing in parallel at all.

## What it isn't

Each of these was measured, not assumed:

- **The message protocol.** Handing work out one polygon at a time and a
  whole span at a time bracket the same number; span-at-a-time is the worse
  end.
- **The copy back.** Structured-cloning the result to the main thread costs
  about 2%.
- **The world crossing the wire.** A worker that builds its own world from
  scratch and runs plain `bakeAll` inside itself still takes ~24s, where the
  main thread takes 4.4s for the same work.
- **Cold code.** Two passes in the same worker agree to within 1%.
- **Retained memory.** Pruning `Stretch.table` down to exactly the rings any
  `Origin` names (see `bake.ts`) roughly halved what a span retains. It moved
  the serial bake's numbers and did not move the worker's at all.
- **The obvious worker overheads**, each put to its own micro-benchmark and
  come back level or better than the main thread: raw arithmetic, allocation,
  allocation while holding a large live set, and short-lived strings used as
  `Map` keys.

So the slowdown is real, repeatable, and isolated to a worker running this
particular code, and the mechanism is unknown. Anyone picking this up should
profile a worker directly — flame graph, not another micro-benchmark —
rather than trust the list of dead ends above.

## Status

`threads.ts` and `bake.worker.ts` are kept because they are correct and
because what they measured is worth having on record. The editor itself
still bakes on the main thread; nothing calls `pool()` from the app.
