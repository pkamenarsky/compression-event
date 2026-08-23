import { test } from 'vitest';
import { Point } from '@ce/game/world';
import { bakeSpan } from './bake';
import { erode, simplify } from './geometry';
import { addPolygon, addVertex, editAt, removeVertices, resolveAt, withEdit } from './scene';
import { PolygonId, Transform, VersionId, World, emptyWorld } from './types';

function rect(x: number, y: number, w: number, h: number): Point[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}
function drawn(...specs: [any, Point[]][]) {
  let world = emptyWorld(); const ids: PolygonId[] = [];
  for (const [type, points] of specs) { const a = addPolygon(world, type, points, 0); world = a.world; ids.push(a.id); }
  return { world, ids };
}
function transformed(w: World, v: VersionId, id: PolygonId, t: Partial<Transform>): World {
  const it = resolveAt(w, v).find(r => r.id === id)!;
  const e = editAt(w, v, id, it.erosion);
  return withEdit(w, v, id, { ...e, transform: { ...e.transform, ...t } });
}
function eroded(w: World, v: VersionId, id: PolygonId, depth: number): World {
  return withEdit(w, v, id, { ...editAt(w, v, id, depth), transform: { ...editAt(w, v, id, depth).transform, erosion: depth } });
}
function run<T>(g: Generator<number, T, void>): T { let s = g.next(); while (!s.done) s = g.next(); return s.value; }

test('what an erosion costs next to a bake', () => {
  // How long one projection takes, on a ring the size the bake sees.
  const ring = simplify([rect(0, 0, 300, 200)]);
  let t = performance.now();
  const N = 20000;
  for (let i = 0; i < N; i++) erode(ring, 10 + (i % 5));
  const each = (performance.now() - t) / N;

  console.log(`one erode of a 4-corner ring: ${(each * 1000).toFixed(1)}us`);

  const big = simplify([Array.from({ length: 40 }, (_u, i) => ({
    x: 200 + 150 * Math.cos(i / 40 * Math.PI * 2) + (i % 3) * 7,
    y: 200 + 150 * Math.sin(i / 40 * Math.PI * 2),
  }))]);

  t = performance.now();
  for (let i = 0; i < 2000; i++) erode(big, 5 + (i % 5));
  console.log(`one erode of a 40-corner ring: ${((performance.now() - t) / 2000 * 1000).toFixed(1)}us`);

  // And a whole span, for scale.
  const cases: [string, () => World][] = [
    ['a corner dying', () => {
      const { world, ids } = drawn(['level', rect(0, 0, 300, 200)]);
      const at0 = resolveAt(world, 0).find(r => r.id === ids[0])!;
      const added = addVertex(world, 0, at0, 0, { x: 150, y: 0 });
      return eroded(removeVertices(added.world, 1, [added.vertex]), 1, ids[0], 18);
    }],
    ['six boxes all moving', () => {
      const specs = Array.from({ length: 6 }, (_u, i) =>
        ['level', rect(i * 60, (i % 2) * 40, 150, 130)] as [any, Point[]]);
      const { world, ids } = drawn(...specs);
      let w = world;
      for (let i = 0; i < 6; i++) {
        w = eroded(w, 1, ids[i], 6 + i * 2);
        w = transformed(w, 1, ids[i], { rotation: 0.2 + i * 0.05 });
      }
      return w;
    }],
  ];

  for (const [name, build] of cases) {
    const world = build();
    t = performance.now();
    const span = run(bakeSpan(world, 0));
    console.log(`${name}: ${(performance.now() - t).toFixed(0)}ms  ${span.evaluations} evaluations`);
  }
});
