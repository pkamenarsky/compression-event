// A bench for the morph shader: bake a world, ship it, and draw the CPU's
// answer over the GPU's. Where the green outline sits on the foot of the wall,
// `morph.ts` agrees with `outline` in `baked.ts` — which `export.test.ts` ties
// back to the CSG.
//
// Orange is what the player will actually walk into: the union at the nearest
// version boundary, which snaps where the walls morph. Watching the two come
// apart and back together across a transition is the whole of the trade made in
// `docs/game.md`, task 3b.
//
//   ?world=<file in scratch/>   a saved editor world
//   ?world=demo                 rooms, a pillar turning inside a wall
//
//   space  pause     o  the CPU overlay     c  the collision rings     arrows  step

import * as THREE from 'three';
import { restored, Saved } from '../packages/editor/src/save';
import { bakeAll } from '../packages/editor/src/bake';
import { shipped, versionOf } from '../packages/editor/src/export';
import { addPolygon, addVertex, editAt, removeVertices, resolveAt, withEdit } from '../packages/editor/src/scene';
import { PolygonId, Transform, VersionId, World, emptyWorld } from '../packages/editor/src/types';
import { outlineAt } from '../packages/game/src/baked';
import { SCALE, renderer } from '../packages/game/src/render';

const hud = document.getElementById('hud')!;
const view = document.getElementById('view')!;

const wanted = new URLSearchParams(location.search).get('world') ?? 'demo';

function rect(x: number, y: number, w: number, h: number) {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

function transformed(w: World, v: VersionId, id: PolygonId, t: Partial<Transform>): World {
  const it = resolveAt(w, v).find(r => r.id === id)!;
  const edit = editAt(w, v, id, it.erosion);

  return withEdit(w, v, id, { ...edit, transform: { ...edit.transform, ...t } });
}

function eroded(w: World, v: VersionId, id: PolygonId, depth: number): World {
  return withEdit(w, v, id, {
    ...editAt(w, v, id, depth),
    transform: { ...editAt(w, v, id, depth).transform, erosion: depth },
  });
}

function demo(): World {
  let w = emptyWorld();
  const ids: PolygonId[] = [];

  for (const spec of [
    ['level', rect(-400, -300, 500, 400)],
    ['level', rect(50, -150, 500, 220)],
    ['level', rect(300, -400, 260, 700)],
    ['solid', rect(-250, -180, 140, 140)],
    ['solid', rect(180, -110, 90, 90)],
  ] as const) {
    const added = addPolygon(w, spec[0], spec[1] as { x: number, y: number }[], 0);

    w = added.world;
    ids.push(added.id);
  }

  // A corner added mid-wall and taken out at v2: the case `lineOpacity` is
  // for. Without it there is a vertical line standing on a flat wall for the
  // whole of the span it dies in.
  const at0 = resolveAt(w, 0).find(r => r.id === ids[0])!;
  const extra = addVertex(w, 0, at0, 0, { x: -150, y: -300 });

  w = removeVertices(extra.world, 2, [extra.vertex]);

  for (let v = 1; v < 5; v++) {
    w = eroded(w, v, ids[0], v * 14);
    w = eroded(w, v, ids[1], v * 9);
    w = eroded(w, v, ids[2], v * 6);
    w = transformed(w, v, ids[3], { rotation: 0.4, scale: { x: 1.15, y: 1.15 } });
    w = transformed(w, v, ids[4], { rotation: -0.5, translation: { x: 20, y: 10 } });
  }

  return w;
}

hud.textContent = 'baking';

const source = wanted === 'demo'
  ? demo()
  : restored(await (await fetch(`/scratch/${wanted}`)).json() as Saved).world;

const g = bakeAll(source);
let step = g.next();

while (!step.done) step = g.next();

const world = shipped(source, { spans: step.value, progress: null });

const r = renderer(view, { dither: false });

r.load(world);

Object.assign(globalThis, { world, r });

// The CPU's outline, rebuilt every frame at the foot of the wall.
const overlay = new THREE.LineSegments(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: 0x33ff66 }),
);

overlay.frustumCulled = false;
r.scene.add(overlay);

function overlaid(u: number): void {
  const points: number[] = [];

  for (const run of outlineAt(world.baked, u)) {
    for (let i = 1; i < run.length; i++) {
      points.push(
        run[i - 1].x * SCALE, 0.05, run[i - 1].y * SCALE,
        run[i].x * SCALE, 0.05, run[i].y * SCALE,
      );
    }
  }

  overlay.geometry.dispose();
  overlay.geometry = new THREE.BufferGeometry();
  overlay.geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
}

// What collision runs on: the union at whichever version boundary is nearest,
// which is where the hulls would have been rebuilt.
const collision = new THREE.LineSegments(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: 0xff9933 }),
);

collision.frustumCulled = false;
r.scene.add(collision);

let showingVersion = -1;

function collided(u: number): void {
  const v = Math.round(u * (world.versions.length - 1));

  if (v === showingVersion) return;

  showingVersion = v;

  const points: number[] = [];

  for (const polygon of versionOf(source, v).polygons) {
    if (polygon.type !== 'level') continue;

    const ring = polygon.points;

    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];

      points.push(a.x * SCALE, 0.12, a.y * SCALE, b.x * SCALE, 0.12, b.y * SCALE);
    }
  }

  collision.geometry.dispose();
  collision.geometry = new THREE.BufferGeometry();
  collision.geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
}

const xs = world.versions.flatMap(v => v.polygons.flatMap(p => p.points.map(q => q.x)));
const ys = world.versions.flatMap(v => v.polygons.flatMap(p => p.points.map(q => q.y)));
const cx = (Math.min(...xs) + Math.max(...xs)) / 2 * SCALE;
const cz = (Math.min(...ys) + Math.max(...ys)) / 2 * SCALE;
const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * SCALE;

let u = 0;
let playing = true;
let angle = 0.6;

addEventListener('keydown', e => {
  if (e.key === ' ') playing = !playing;
  if (e.key === 'o') overlay.visible = !overlay.visible;
  if (e.key === 'c') collision.visible = !collision.visible;
  if (e.key === 'ArrowRight') u = Math.min(1, u + 0.005);
  if (e.key === 'ArrowLeft') u = Math.max(0, u - 0.005);
});

Object.assign(globalThis, { look: (a: number, h: number) => { angle = a; playing = false; }, to: (x: number) => { u = x; playing = false; } });

let last = performance.now();

function frame(now: number): void {
  const dt = Math.min((now - last) / 1000, 0.1);

  last = now;

  if (playing) u = (u + dt * 0.06) % 1;

  r.walk(u);
  overlaid(u);
  collided(u);

  angle += playing ? dt * 0.08 : 0;

  r.camera.position.set(cx + Math.cos(angle) * size * 0.75, size * 0.85, cz + Math.sin(angle) * size * 0.75);
  r.camera.lookAt(cx, 0, cz);
  r.render();

  const [a, b] = r.between(u);

  hud.textContent = `${wanted}  spans ${world.baked.spans.length}  u ${u.toFixed(3)}  v${a}→v${b}`;

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
