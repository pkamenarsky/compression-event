// -----------------------------------------------------------------------------
// The same measurement, in the browser, where the threads are
//
// One world, cut on one thread and then on two, four and eight, so the question
// being asked is how well it divides rather than whether two different runs
// happened to hit the same weather. Both paths run the same `bakeSlice` over the
// same slicing, and the answers are compared track by track: a threaded bake has
// to *be* the serial one, not merely be as good.
// -----------------------------------------------------------------------------

import { Span, bakeAll } from '../packages/editor/src/bake';
import { cores, pool } from '../packages/editor/src/threads';
import { World } from '../packages/editor/src/types';
import { level, version, weight } from './level';

const out = document.getElementById('out')!;

function say(line: string): void {
  out.textContent += line + '\n';
}

/** The event loop, briefly. A hidden tab throttles its timers to about a second
 * apiece, so this is only ever asked for between measurements. */
function breathe(): Promise<void> {
  return new Promise(r => setTimeout(r, 0));
}

function serial(world: World): Map<number, Span> {
  const job = bakeAll(world);

  let step = job.next();
  while (!step.done) step = job.next();

  return step.value;
}

function summary(spans: Map<number, Span>): string {
  let written = 0, held = 0, stretches = 0, evaluations = 0, worst = 0;

  for (const span of spans.values()) {
    const w = weight(span);

    written += w.written;
    held += w.held;
    stretches += w.stretches;
    evaluations += span.evaluations;
    worst = Math.max(worst, span.worst);
  }

  return `csg ${String(evaluations).padStart(6)}  stretches ${String(stretches).padStart(6)}` +
    `  worst ${worst.toFixed(4)}  held ${(held * 16 / 1e6).toFixed(1)}MB`;
}

/** The same spans from both paths, compared track by track. */
function agree(a: Map<number, Span>, b: Map<number, Span>): string {
  if (a.size !== b.size) return `DIFFERENT: ${a.size} spans against ${b.size}`;

  for (const [from, one] of a) {
    const two = b.get(from);

    if (two === undefined) return `DIFFERENT: no span ${from}`;
    if (one.tracks.length !== two.tracks.length) return `DIFFERENT: span ${from} track count`;

    for (let i = 0; i < one.tracks.length; i++) {
      const p = one.tracks[i], q = two.tracks[i];

      if (p.id !== q.id) return `DIFFERENT: span ${from} track ${i} is ${p.id} against ${q.id}`;

      if (p.stretches.length !== q.stretches.length) {
        return `DIFFERENT: polygon ${p.id} cut ${p.stretches.length} ways against ${q.stretches.length}`;
      }

      for (let k = 0; k < p.stretches.length; k++) {
        if (p.stretches[k].t0 !== q.stretches[k].t0 || p.stretches[k].t1 !== q.stretches[k].t1) {
          return `DIFFERENT: polygon ${p.id} stretch ${k}`;
        }
      }
    }
  }

  return 'identical';
}

/**
 * One configuration per page load, chosen by the query string, because a bake
 * allocates hard enough that two of them in one heap do not measure the same
 * thing: a second run on a grown heap has measured three times slower than the
 * first. Cold code is the other way about. So each load runs its configuration
 * twice and reports both, and only ever compares a cold run against a cold one.
 *
 *   /bench.html?rooms=120&share=0.6&threads=4     (threads=0 is this thread)
 */
async function main(): Promise<void> {
  const q = new URLSearchParams(location.search);
  const rooms = Number(q.get('rooms') ?? 120);
  const share = Number(q.get('share') ?? 0.6);
  const count = q.has('threads') ? Number(q.get('threads')) : cores();
  const handful = Number(q.get('handful') ?? 6);

  const built = level(rooms);
  const world = version(built.world, built.ids, share);
  const spans = world.versions.length - 1;
  const where = count === 0 ? 'on this thread' : `${count} threads`;

  say(`${navigator.hardwareConcurrency} cores reported`);
  say(`${world.polygons.size} polygons, ${world.versions[1].edits.size} edited, ${spans} spans`);
  say(`${where}, ${handful} polygons at a time\n`);
  await breathe();

  const threads = count === 0 ? null : pool(count, handful);

  // A worker in the dev server fetches its whole module graph over HTTP, which
  // has nothing to do with what is being measured.
  if (threads !== null) {
    const tiny = level(3);

    await threads.bake(version(tiny.world, tiny.ids, 1), () => {});
  }

  const runs: Map<number, Span>[] = [];

  for (const pass of [0, 1]) {
    const t = performance.now();
    const spansOut = threads === null ? serial(world) : await threads.bake(world, () => {});
    const ms = performance.now() - t;

    let cpu = 0, setup = 0;

    for (const span of spansOut.values()) {
      cpu += span.setup + span.cut;
      setup += span.setup;
    }

    const busy = count === 0 ? '' : `  busy ${(cpu / (ms * count) * 100).toFixed(0).padStart(3)}%`;

    say(`  pass ${pass}  ${ms.toFixed(0).padStart(7)}ms${busy}` +
      `  setup ${setup.toFixed(0).padStart(5)}ms  ${summary(spansOut)}`);

    runs.push(spansOut);
    await breathe();
  }

  threads?.close();

  say(`\n  the two passes ${agree(runs[0], runs[1])}`);
  say('\ndone');

  (window as unknown as { BENCH: unknown }).BENCH = { done: true };
}

void main();
