// -----------------------------------------------------------------------------
// What an incremental bake would be worth
//
// The bake is already cut per polygon, into tracks that are independent by
// construction, and `cutSome` already takes an arbitrary handful of them by
// index because the thread pool needed that. So a bake that reused the tracks
// an edit did not reach would be a matter of working out which handful is
// dirty — and what that is worth is two numbers, both measured here.
//
// The first is what cannot be reused whatever else is: `ready` resolves the
// world twice and sweeps for who can reach whom, and no diff avoids it. That is
// the floor an incremental bake could approach and not go under.
//
// The second is what one edit actually dirties. A polygon is in its own track
// and in the tracks of whoever has it in their neighbourhood, so the dirty set
// is small — but it is not cheap in proportion to its size, because a polygon
// somebody edited is by definition one where events happen, and those are the
// tracks that cost. Both columns are here for that reason.
// -----------------------------------------------------------------------------

import { test } from 'vitest';
import { Span, TOLERANCE, bakeSpan, cutSome, ready } from '../packages/editor/src/bake';
import { keyed } from '../packages/editor/src/scene';
import { PolygonId, World } from '../packages/editor/src/types';
import { SIZES, level, version } from './level';

function run<T>(job: Generator<number, T, void>): T {
  let step = job.next();

  while (!step.done) step = job.next();

  return step.value;
}

function share(a: number, b: number): string {
  return `${(100 * a / b).toFixed(1).padStart(5)}%`;
}

/**
 * Setup against cutting, which is the question of whether reuse has a ceiling
 * worth worrying about.
 *
 * It does not. Setup barely scales — it is a resolve, a reach box per polygon
 * and one sweep, all linear in the level — while cutting grows with how many
 * events the span holds, so the share falls as the level grows. What keeps the
 * column honest is the last two rows, where a level of the same size is edited
 * less: cutting falls away and setup does not, and the share rises. Even there
 * it is a twenty-fifth.
 */
test('setup against cutting', () => {
  for (const [rooms, edited] of SIZES) {
    const { world, ids } = level(rooms);
    const w = version(world, ids, edited);
    const span = run(bakeSpan(w, 0));

    console.log(
      `${String(w.polygons.size).padStart(4)} polys, ${edited} edited  ` +
      `setup ${span.setup.toFixed(0).padStart(5)}ms  ` +
      `cut ${span.cut.toFixed(0).padStart(7)}ms  ` +
      `setup ${share(span.setup, span.setup + span.cut)}`,
    );
  }
}, 1200000);

/** Every `n`th polygon, which is an edit spread over the level rather than one
 * corner of it — the worse case for a neighbourhood, and the likelier one for a
 * person working on a level rather than on a room. */
function spread(ids: readonly PolygonId[], n: number): PolygonId[] {
  const step = Math.ceil(ids.length / n);

  return ids.filter((_unused, i) => i % step === 0).slice(0, n);
}

function eroded(world: World, ids: readonly PolygonId[]): World {
  let out = world;

  for (const id of ids) out = keyed(out, 1, id, [{ kind: 'erode', by: 7 }]);

  return out;
}

/**
 * What a further edit over a baked span would cost to take up again.
 *
 * The dirty set is worked out here the way an incremental bake would have to:
 * every track whose neighbourhood holds a polygon the edit touched, which is
 * what `ready` already knows by the time it has swept. What is *not* here is
 * the signature that would decide it without being told — this measures the
 * ceiling that machinery would be reaching for.
 */
test('what one edit dirties', () => {
  for (const rooms of [120, 430]) {
    const { world, ids } = level(rooms);
    const w = version(world, ids, 0.6);
    const full: Span = run(bakeSpan(w, 0));
    const whole = full.setup + full.cut;

    console.log(`${String(w.polygons.size).padStart(4)} polys  full ${whole.toFixed(0)}ms`);

    for (const n of [1, 3, 10]) {
      const touched = spread(ids, n);
      const at = ready(eroded(w, touched), 0);
      const dirty: number[] = [];

      at.near.forEach((near, i) => {
        if (near.some(m => touched.includes(m.at.id))) dirty.push(i);
      });

      const began = performance.now();
      run(cutSome(at, dirty, TOLERANCE));
      const cut = performance.now() - began;

      console.log(
        `  ${String(n).padStart(2)} edited  ` +
        `dirty ${String(dirty.length).padStart(4)}/${String(at.items.length).padEnd(4)} ` +
        `${share(dirty.length, at.items.length)}  ` +
        `setup ${at.setup.toFixed(0).padStart(3)}ms + cut ${cut.toFixed(0).padStart(4)}ms  ` +
        `${share(at.setup + cut, whole)} of the bake`,
      );
    }
  }
}, 1200000);
