// -----------------------------------------------------------------------------
// A level to measure against
//
// Not a soup of overlapping blobs, which is easy to generate and measures the
// wrong thing. Rooms on a loose grid, joined by corridors to the one to the east
// and the one to the south — but not always, which is what makes a room touch
// one to four others rather than eight — and a pillar standing in some of them.
//
// The version over it is what a version of this kind actually holds: mostly
// erosion and small moves, a nudged corner here and there, the odd rotation.
// -----------------------------------------------------------------------------

import { Point } from '../packages/game/src/world';
import { addPolygon, editAt, resolveAt, withEdit } from '../packages/editor/src/scene';
import { PolygonId, Transform, World, emptyWorld } from '../packages/editor/src/types';

function seeded(from: number): () => number {
  let s = from;

  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

export function level(rooms: number): { world: World, ids: PolygonId[] } {
  let world = emptyWorld();
  const ids: PolygonId[] = [];

  const side = Math.ceil(Math.sqrt(rooms));
  const PITCH = 200, W = 150, H = 150;
  const rnd = seeded(12345);

  const put = (points: Point[], type: 'level' | 'solid') => {
    const added = addPolygon(world, type, points, 0);

    world = added.world;
    ids.push(added.id);
  };

  for (let i = 0; i < rooms; i++) {
    const c = i % side, r = (i / side) | 0;
    const x = c * PITCH + rnd() * 20, y = r * PITCH + rnd() * 20;

    put([
      { x, y }, { x: x + W, y }, { x: x + W, y: y + H }, { x, y: y + H },
    ], 'level');

    if (c + 1 < side && rnd() < 0.75) {
      put([
        { x: x + W - 10, y: y + 55 }, { x: x + PITCH + 10, y: y + 55 },
        { x: x + PITCH + 10, y: y + 95 }, { x: x + W - 10, y: y + 95 },
      ], 'level');
    }

    if (r + 1 < side && rnd() < 0.55) {
      put([
        { x: x + 55, y: y + H - 10 }, { x: x + 95, y: y + H - 10 },
        { x: x + 95, y: y + PITCH + 10 }, { x: x + 55, y: y + PITCH + 10 },
      ], 'level');
    }

    if (rnd() < 0.3) {
      put([
        { x: x + 60, y: y + 60 }, { x: x + 95, y: y + 60 },
        { x: x + 95, y: y + 95 }, { x: x + 60, y: y + 95 },
      ], 'solid');
    }
  }

  return { world, ids };
}

/** One version over the level, touching `share` of it. */
export function version(world: World, ids: PolygonId[], share: number, v = 1): World {
  const rnd = seeded(999);
  const at = resolveAt(world, v);

  let out = world;

  for (const id of ids) {
    if (rnd() > share) continue;

    const it = at.find(r => r.id === id)!;
    const edit = editAt(out, v, id, it.erosion);
    const roll = rnd();

    const transform: Transform = {
      ...edit.transform,
      erosion: roll < 0.7 ? 4 + rnd() * 8 : edit.transform.erosion,
      translation: roll < 0.5
        ? { x: (rnd() - 0.5) * 24, y: (rnd() - 0.5) * 24 }
        : edit.transform.translation,
      rotation: roll > 0.94 ? (rnd() - 0.5) * 0.5 : edit.transform.rotation,
    };

    const vertices = new Map(edit.vertices);

    if (roll > 0.4 && roll < 0.6) {
      const poly = out.polygons.get(id)!;
      const v = poly.points[(rnd() * poly.points.length) | 0];

      vertices.set(v.id, { x: (rnd() - 0.5) * 30, y: (rnd() - 0.5) * 30 });
    }

    out = withEdit(out, v, id, { transform, vertices });
  }

  return out;
}

/** What a baked span weighs, and how finely it was cut. */
export function weight(span: {
  tracks: {
    stretches: {
      a: { points: unknown[] }[]
      b: { points: unknown[] }[]
      table: Map<number, { a: { length: number }[], b: { length: number }[] }>
    }[]
  }[]
}): { points: number, table: number, stretches: number } {
  let points = 0;
  let table = 0;
  let stretches = 0;

  for (const track of span.tracks) {
    stretches += track.stretches.length;

    for (const st of track.stretches) {
      for (const run of st.a) points += run.points.length;
      for (const run of st.b) points += run.points.length;

      // Every neighbour's whole eroded shape at both ends, which is what the
      // crossings are solved from — and which is repeated in every stretch of
      // every track that neighbour touches.
      for (const both of st.table.values()) {
        for (const ring of both.a) table += ring.length;
        for (const ring of both.b) table += ring.length;
      }
    }
  }

  return { points, table, stretches };
}

export const SIZES: [number, number][] = [
  [120, 0.6],
  [250, 0.6],
  [430, 0.6],
  [430, 0.15],
  [430, 0.05],
];
