// -----------------------------------------------------------------------------
// How far the replay is ever allowed to be from the truth
//
// The bake's whole contract in one file: at no instant may what the game would
// draw sit further than `TOLERANCE` from `csg(t)` — the world resolved at that
// instant and put through the CSG outright.
//
// The bake checks itself while it runs, at the midpoint of every stretch it
// keeps, and reports the worst it saw as `Span.worst`. This checks it again at
// 998 instants that are deliberately *not* those midpoints, so that a bake
// which only satisfies itself where it looked has nowhere to hide.
//
// The table it prints is the headline number for the whole subsystem, and the
// cases in it are the ones that broke earlier designs: a pillar turning inside
// a wall, which an event search that counts crossings cannot see; a nudge and
// an erosion sharing a stretch, where the true path bends and no keyframe helps;
// and six overlapping boxes, where the CSG's own run decomposition shifts with
// no geometric coincidence anywhere near it.
// -----------------------------------------------------------------------------

import { expect, test } from 'vitest';
import { Point } from '@ce/game/world';
import { Frame, Span, TOLERANCE, bakeSpan, sample, truth } from './bake';
import { addPolygon, resolveAt, editAt, withEdit } from './scene';
import { PolygonId, PolygonType, Transform, VersionId, World, emptyWorld } from './types';

function rect(x: number, y: number, w: number, h: number): Point[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}
function drawn(...specs: [PolygonType, Point[]][]): { world: World, ids: PolygonId[] } {
  let world = emptyWorld();
  const ids: PolygonId[] = [];
  for (const [type, points] of specs) {
    const added = addPolygon(world, type, points, 0);
    world = added.world; ids.push(added.id);
  }
  return { world, ids };
}
function transformed(world: World, v: VersionId, id: PolygonId, t: Partial<Transform>): World {
  const it = resolveAt(world, v).find(r => r.id === id)!;
  const edit = editAt(world, v, id, it.erosion);
  return withEdit(world, v, id, { ...edit, transform: { ...edit.transform, ...t } });
}
function run<T>(g: Generator<number, T, void>): T { let s = g.next(); while (!s.done) s = g.next(); return s.value; }

/** The worst any point of the replay sits from the point csg(t) puts there. */
function apart(a: Frame, b: Frame): number {
  if (a.length !== b.length) return Infinity;
  let w = 0;
  for (let r = 0; r < a.length; r++) {
    if (a[r].id !== b[r].id || a[r].points.length !== b[r].points.length) return Infinity;
    for (let i = 0; i < a[r].points.length; i++)
      w = Math.max(w, Math.hypot(a[r].points[i].x - b[r].points[i].x, a[r].points[i].y - b[r].points[i].y));
  }
  return w;
}

/**
 * The biggest step the outline takes between two frames of the replay, and the
 * biggest the world itself takes over the same step.
 *
 * A topology event is a real discontinuity — a run appears, and no interpolation
 * makes that gradual — so the replay is not allowed to be *smooth*, it is
 * allowed to be no jumpier than the thing it is reproducing. Frames are one
 * sixtieth of a two-second transition apart, which is what the eye actually
 * gets.
 */
function jumps(span: ReturnType<typeof run<Span>>, w: World): { replay: number, world: number } {
  const frames = 120;
  let replay = 0, world = 0;

  const step = (a: Frame, b: Frame): number => {
    // Different geometry either side: the size of that is not a distance, and
    // it is the world's own doing, not the replay's.
    if (a.length !== b.length) return 0;

    let m = 0;

    for (let r = 0; r < a.length; r++) {
      if (a[r].id !== b[r].id || a[r].points.length !== b[r].points.length) return 0;

      for (let i = 0; i < a[r].points.length; i++) {
        m = Math.max(m, Math.hypot(
          a[r].points[i].x - b[r].points[i].x,
          a[r].points[i].y - b[r].points[i].y,
        ));
      }
    }

    return m;
  };

  let was = sample(span, 0), wasTruth = truth(w, 0, 0);

  for (let i = 1; i <= frames; i++) {
    const t = i / frames;
    const now = sample(span, t), nowTruth = truth(w, 0, t);

    replay = Math.max(replay, step(was, now));
    world = Math.max(world, step(wasTruth, nowTruth));

    was = now;
    wasTruth = nowTruth;
  }

  return { replay, world };
}

const rows: string[] = [];

function report(name: string, w: World) {
  const t0 = Date.now();
  const span = run(bakeSpan(w, 0));
  const ms = Date.now() - t0;

  // Deliberately not on the stretch midpoints the bake checked itself at.
  let worst = 0, at = 0, broken = 0;
  const N = 997;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const d = apart(sample(span, t), truth(w, 0, t));
    if (!isFinite(d)) { broken++; continue; }
    if (d > worst) { worst = d; at = t; }
  }
  const j = jumps(span, w);

  rows.push(
    `${name.padEnd(38)} worst ${worst.toFixed(4).padStart(8)}` +
    `  miss ${String(broken).padStart(3)}/${N + 1}` +
    `  jump ${j.replay.toFixed(2).padStart(7)} vs ${j.world.toFixed(2).padStart(7)}` +
    `  stretches ${String(span.tracks.reduce((n, t) => n + t.stretches.length, 0)).padStart(4)}` +
    `  csg ${String(span.evaluations).padStart(4)}  ${String(ms).padStart(4)}ms`);

  return { worst, broken, jump: j };
}

test('the replay never strays far from csg(t)', () => {
  const bad: string[] = [];
  const check = (name: string, w: World) => {
    const r = report(name, w);
    // A handful of mismatched instants is the discontinuities themselves: at a
    // keyframe the two sides genuinely have different geometry, and landing on
    // one is landing on a moment of zero duration.
    if (r.worst > TOLERANCE) bad.push(`${name}: ${r.worst} from the truth`);
    if (r.broken > 12) bad.push(`${name}: ${r.broken} mismatched instants`);

    // No jumpier than the world it is reproducing, give or take the tolerance.
    if (r.jump.replay > r.jump.world + TOLERANCE) {
      bad.push(`${name}: jumps ${r.jump.replay} where the world jumps ${r.jump.world}`);
    }
  };

  { const { world, ids } = drawn(['level', rect(0,0,200,200)]);
    check('erosion only', transformed(world, 1, ids[0], { erosion: 60 })); }
  { const { world, ids } = drawn(['level', rect(-100,-100,200,200)]);
    check('rotation only', transformed(world, 1, ids[0], { rotation: Math.PI/2 })); }
  { const { world, ids } = drawn(['level', rect(-100,-100,200,200)]);
    check('squash', transformed(world, 1, ids[0], { scale: { x: 0.3, y: 2 } })); }
  { const { world, ids } = drawn(['level', rect(-300,-40,200,80)], ['level', rect(-100,-200,80,400)]);
    check('sliding through', transformed(world, 1, ids[0], { translation: { x: 240, y: 0 } })); }
  { const { world, ids } = drawn(['level', rect(-200,-60,400,120)], ['level', rect(-40,-200,80,400)]);
    check('pillar turning in a wall', transformed(world, 1, ids[1], { rotation: Math.PI/3 })); }
  {
    // A bar that turns half way round, so it ends up where it started and
    // sweeps a room on the way that it touches at neither end of the span. The
    // track is cut against a fixed neighbourhood, so this is the case that
    // says whether the sweep that chooses it reaches far enough.
    const { world, ids } = drawn(['level', rect(-200,-20,400,40)], ['level', rect(-30,60,60,100)]);
    check('a bar sweeping a room it never touches at either end',
      transformed(world, 1, ids[0], { rotation: Math.PI })); }
  { const { world, ids } = drawn(['level', rect(0,0,200,60)], ['level', rect(80,60,40,40)], ['level', rect(0,100,200,60)]);
    let w = world; for (const id of ids) w = transformed(w, 1, id, { erosion: 25 });
    check('dumbbell pinching', w); }
  { const { world, ids } = drawn(['level', rect(-300,-40,200,80)], ['level', rect(-100,-200,80,400)]);
    check('sliding and turning', transformed(world, 1, ids[0], { translation: { x: 240, y: 0 }, rotation: 0.6 })); }
  {
    const { world, ids } = drawn(['level', rect(0,0,120,120)]);
    const it = resolveAt(world, 1).find(r => r.id === ids[0])!;
    const edit = editAt(world, 1, ids[0], 0);
    const vertices = new Map(edit.vertices);
    vertices.set(it.polygon.points[2].id, { x: 90, y: 40 });
    const nudged = withEdit(world, 1, ids[0], { ...edit, vertices });
    check('nudge and erode', transformed(nudged, 1, ids[0], { erosion: 22 }));
    check('nudge, erode and turn', transformed(nudged, 1, ids[0], { erosion: 22, rotation: 0.4 }));
  }
  {
    const build = (dx: number, dy: number, w: number, h: number) => {
      let world = emptyWorld();
      const ids: PolygonId[] = [];
      for (let i = 0; i < 6; i++) {
        const a = addPolygon(world, i % 3 === 2 ? 'solid' : 'level',
          rect(-140 + dx * i, -90 + dy * (i % 3), w, h), 0);
        world = a.world; ids.push(a.id);
      }
      return { world, ids };
    };
    {
      const { world, ids } = build(60, 40, 150, 130);
      let e = world; ids.forEach((id, i) => { e = transformed(e, 1, id, { erosion: 4 * i }); });
      check('six boxes, eroding only', e);
      let r = world; ids.forEach((id, i) => { r = transformed(r, 1, id, { rotation: (i%2?1:-1)*(0.2+0.15*i) }); });
      check('six boxes, turning only', r);
      let m = world; ids.forEach((id, i) => {
        m = transformed(m, 1, id, { rotation: (i%2?1:-1)*(0.2+0.15*i), erosion: 4*i, translation: { x: 10*i-20, y: 6*i } });
      });
      check('six boxes, all moving', m);
    }
  }

  console.log('\n' + rows.join('\n') + '\n');
  expect(bad).toEqual([]);
}, 60_000);
