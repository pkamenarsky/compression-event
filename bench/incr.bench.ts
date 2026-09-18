// -----------------------------------------------------------------------------
// What the incremental bake is worth
//
// A bake handed the span it made last time keeps the tracks whose signature
// still stands, so what an edit costs is what it reached rather than what the
// level holds. Two numbers say whether that is working.
//
// The first is the floor: `ready` resolves the span and sweeps for who can
// reach whom, and the signatures are taken off what it resolved. Neither is
// avoidable, and together they are what a bake costs when an edit reaches
// nothing at all.
//
// The second is what an edit does reach. A polygon is in its own track and in
// the tracks of whoever has it in their neighbourhood, so the dirty set is
// small — but it is not cheap in proportion to its size, because a polygon
// somebody edited is by definition one where events happen, and those are the
// tracks that cost. Both columns are here for that reason.
// -----------------------------------------------------------------------------

import { test } from 'vitest';
import { Span, bakeSpan } from '../packages/editor/src/bake';
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
 * A span baked, edited, and baked again from what the first bake made.
 *
 * The whole clock, not the cutting: resolving the span, signing every track of
 * it, diffing, cutting what is left and putting the span back together. That is
 * what an author waits for.
 *
 * The first row is the floor — an edit somewhere else in the chain, which
 * reaches nothing here and keeps every track. The rest are edits spread across
 * the level rather than gathered in one corner of it, which is the worse case
 * for a neighbourhood and the likelier one for a person working on a level.
 */
test('what one edit costs to take up again', () => {
  for (const rooms of [120, 430]) {
    const { world, ids } = level(rooms);
    const w = version(world, ids, 0.6);
    const was: Span = run(bakeSpan(w, 0));
    const whole = was.setup + was.cut;

    console.log(`${String(w.polygons.size).padStart(4)} polys  full ${whole.toFixed(0)}ms`);

    for (const n of [0, 1, 3, 10]) {
      const edited = eroded(w, spread(ids, n));

      const began = performance.now();
      const span = run(bakeSpan(edited, 0, undefined, undefined, was));
      const ms = performance.now() - began;

      const cut = span.tracks.filter(t => !was.tracks.includes(t));

      console.log(
        `  ${String(n).padStart(2)} edited  ` +
        `cut ${String(cut.length).padStart(4)}/${String(span.tracks.length).padEnd(4)} ` +
        `${share(cut.length, span.tracks.length)}  ` +
        `again ${ms.toFixed(0).padStart(4)}ms  ` +
        `${share(ms, whole)} of the bake`,
      );
    }
  }
}, 1200000);
