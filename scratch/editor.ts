// The editor, opened on a world instead of on nothing. Same mount as
// `packages/editor/src/main.ts`; the only difference is where the world comes
// from, which the editor itself has no way to be told from a URL.
//
//   ?world=demo                 rooms, pillars turning inside walls
//   ?world=<file in scratch/>   a world saved out of the editor

// Bare specifiers resolve against the root, and kontinuum is linked into the
// editor package rather than into it. The editor's own copy, then.
import { root } from '../packages/editor/node_modules/@incpt/kontinuum-dom';

import { editor } from '../packages/editor/src/editor';
import { restored, Saved } from '../packages/editor/src/save';
import { addPolygon, editAt, resolveAt, withEdit } from '../packages/editor/src/scene';
import { PolygonId, Transform, VersionId, World, emptyWorld } from '../packages/editor/src/types';

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

  for (let v = 1; v < 5; v++) {
    w = eroded(w, v, ids[0], v * 14);
    w = eroded(w, v, ids[1], v * 9);
    w = eroded(w, v, ids[2], v * 6);
    w = transformed(w, v, ids[3], { rotation: 0.4, scale: { x: 1.15, y: 1.15 } });
    w = transformed(w, v, ids[4], { rotation: -0.5, translation: { x: 20, y: 10 } });
  }

  return w;
}

const wanted = new URLSearchParams(location.search).get('world') ?? 'demo';

const world = wanted === 'demo'
  ? demo()
  : restored(await (await fetch(`/scratch/${wanted}`)).json() as Saved).world;

root(document.getElementById('app')!, editor(world));
