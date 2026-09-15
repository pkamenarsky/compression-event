// -----------------------------------------------------------------------------
// One saved level, baked, with the progress printed as it goes
//
// For profiling a level that bakes too slowly to bake often:
//
//   NODE_OPTIONS=--cpu-prof node <vite-node> bench/prof.ts <file.json> [ms]
//
// stops after `ms` (twenty seconds by default) whether or not it is done.
// -----------------------------------------------------------------------------

import { readFileSync } from 'fs';
import { restored } from '../packages/editor/src/save';
import { bakeAll } from '../packages/editor/src/bake';

const file = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const state = restored(file);
const limit = Number(process.argv[3] ?? 20000);
const t0 = performance.now();
const job = bakeAll(state.world);
let step = job.next();
let last = 0;
while (!step.done) {
  if (performance.now() - t0 > limit) break;
  if (step.value - last > 0.01) { last = step.value; console.log((performance.now() - t0).toFixed(0), step.value.toFixed(3)); }
  step = job.next();
}
console.log('done', step.done, (performance.now() - t0).toFixed(0), 'ms');
