// -----------------------------------------------------------------------------
// The baseline: what the editor and the bake made of worlds without effects,
// before effects existed
//
// A handful of worlds built only from what master had — rooms, pillars,
// floors and holes; moves, turns, squashes and erosions; corners nudged,
// deepened, added and taken out; births and deaths; sealed groups; repeats and
// unchaining — and a digest of everything the editor draws and the game gets
// for each. `baseline.golden.json` holds the digests master made of them; the
// test holds this branch to the same, bit for bit, so that nothing built for
// effects moves anything that does not have one.
//
// Written against master's API and nothing newer, so the same file runs on
// both. The golden file is only ever made on master: in a worktree of it, with
// this file and `baseline.test.ts` copied in,
//
//   GOLDEN=1 pnpm vitest run baseline
//
// and `baseline.golden.json` copied back.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { Point } from '@ce/game/world';
import { bakeAll } from './bake';
import { shipped } from './export';
import { deepened, nudged } from './rig';
import {
  TOP,
  addPolygon,
  addVertex,
  csg,
  csgFloor,
  grouped,
  removeAt,
  removeVertices,
  resolveAt,
  rigOf,
  sealing,
  unchained,
  withRig,
} from './scene';
import { erode, move, repeated, scaled, spun, turned, wrote } from './testing';
import { FLOOR, Id, PolygonKind, World, emptyWorld } from './types';

type Named = 'level' | 'solid' | 'floor' | 'hole';

const kind = (k: Named): PolygonKind =>
  k === 'hole' ? { type: 'void', from: FLOOR } : { type: k };

function rect(x: number, y: number, w: number, h: number): Point[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

/** Four keyframes rather than the editor's nine: three spans is every case
 * here, and the bake is the slow part. */
function blank(): World {
  const world = emptyWorld();

  return { ...world, keyframes: world.keyframes.slice(0, 4) };
}

function drawn(...specs: [Named, Point[]][]): { world: World, ids: Id[] } {
  let world = blank();
  const ids: Id[] = [];

  for (const [type, points] of specs) {
    const added = addPolygon(world, kind(type), points, 0, TOP);

    world = added.world;
    ids.push(added.id);
  }

  return { world, ids };
}

function seeded(from: number): () => number {
  let s = from;

  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

/** A small level of rooms, corridors and pillars, and a keyframe or two of
 * erosion, moves, spins, nudges and deepened corners over it. */
function level(): World {
  const rnd = seeded(12345);
  const specs: [Named, Point[]][] = [];

  for (let i = 0; i < 9; i++) {
    const c = i % 3, r = (i / 3) | 0;
    const x = c * 200 + rnd() * 20, y = r * 200 + rnd() * 20;

    specs.push(['level', rect(x, y, 150, 150)]);

    if (c < 2 && rnd() < 0.75) specs.push(['level', rect(x + 140, y + 55, 70, 40)]);
    if (r < 2 && rnd() < 0.75) specs.push(['level', rect(x + 55, y + 140, 40, 70)]);
    if (rnd() < 0.4) specs.push(['solid', rect(x + 60, y + 60, 30, 30)]);
  }

  let { world, ids } = drawn(...specs);

  for (const v of [1, 2]) {
    for (const id of ids) {
      const roll = rnd();

      if (roll < 0.5) world = wrote(world, v, id, erode(3 + rnd() * 8));
      if (roll < 0.3) world = wrote(world, v, id, move((rnd() - 0.5) * 30, (rnd() - 0.5) * 30));
      if (roll > 0.9) world = wrote(world, v, id, spun((rnd() - 0.5) * 0.6));

      const corners = world.polygons.get(id)!.points;
      const c = corners[(rnd() * corners.length) | 0];

      if (roll > 0.4 && roll < 0.55) world = withRig(world, id, nudged(rigOf(world, id), c.id, v, { x: (rnd() - 0.5) * 30, y: (rnd() - 0.5) * 30 }));
      if (roll > 0.6 && roll < 0.7) world = withRig(world, id, deepened(rigOf(world, id), c.id, v, 4 + rnd() * 8));
    }
  }

  return world;
}

/** Two rooms and a pillar, sealed, the group eroding and then turning. */
function group(): World {
  const { world, ids } = drawn(['level', rect(0, 0, 200, 150)], ['level', rect(180, 40, 160, 80)], ['solid', rect(60, 50, 40, 40)]);
  const g = grouped(world, 0, ids, TOP)!;
  let w = sealing(g.world, g.id, true);

  w = wrote(w, 1, g.id, erode(8));
  w = wrote(w, 2, g.id, turned(0.4, { x: 150, y: 80 }));
  w = wrote(w, 2, ids[2], spun(0.8));

  return w;
}

/** A corner added and pulled out, another taken away. */
function corners(): World {
  const { world, ids } = drawn(['level', rect(-100, -100, 200, 200)]);
  const id = ids[0];
  const it = resolveAt(world, 1).find(r => r.id === id)!;
  const added = addVertex(world, 1, it, 0, { x: 0, y: -100 });
  let w = withRig(added.world, id, nudged(rigOf(added.world, id), added.vertex, 1, { x: 0, y: -60 }));

  w = wrote(w, 1, id, erode(10));
  w = removeVertices(w, 2, [w.polygons.get(id)!.points[2].id]);

  return w;
}

/** One room born at v1 and another taken out at v2, beside a third. */
function births(): World {
  const { world, ids } = drawn(['level', rect(0, 0, 100, 100)], ['level', rect(90, 20, 100, 60)]);
  const born = addPolygon(world, kind('level'), rect(-80, 10, 90, 80), 1, TOP);

  return wrote(removeAt(born.world, 2, [ids[1]]), 1, ids[0], erode(6));
}

/** A floor with a hole in it, in a room, all three moving about. */
function floors(): World {
  const { world, ids } = drawn(['level', rect(0, 0, 300, 200)], ['floor', rect(20, 20, 260, 160)], ['hole', rect(120, 60, 60, 60)]);
  let w = wrote(world, 1, ids[2], move(40, 10));

  w = wrote(w, 2, ids[1], erode(12));
  w = wrote(w, 2, ids[0], scaled(1.2, 1.2, { x: 150, y: 100 }));

  return w;
}

/** A room squashed and turned, and a pillar crossing it. */
function squash(): World {
  const { world, ids } = drawn(['level', rect(0, 0, 200, 200)], ['solid', rect(-60, 80, 40, 40)]);
  let w = wrote(world, 1, ids[0], scaled(1.8, 0.7, { x: 100, y: 100 }), turned(0.3, { x: 100, y: 100 }));

  w = wrote(w, 1, ids[1], move(160, 0));
  w = wrote(w, 2, ids[1], move(160, 0));

  return w;
}

/** A turn repeating to the end, an erosion repeating twice, then a stand. */
function repeats(): World {
  const { world, ids } = drawn(['level', rect(0, 0, 150, 100)], ['level', rect(140, 30, 120, 40)]);
  let w = repeated(world, 1, ids[0], spun(0.35), null);

  w = repeated(w, 1, ids[1], erode(4), 2);
  w = wrote(w, 1, ids[1], move(10, 20));

  return unchained(w, 2, [ids[1]]);
}

export const SCENES: [string, () => World][] = [
  ['level', level],
  ['group', group],
  ['corners', corners],
  ['births', births],
  ['floors', floors],
  ['squash', squash],
  ['repeats', repeats],
];

/** Everything the editor draws and the game gets for a world, as digests: the
 * sets at each keyframe, each span as baked, and the shipped level. */
export function digest(world: World): Record<string, string> {
  const out: Record<string, string> = {};
  const g = bakeAll(world);
  let step = g.next();

  while (!step.done) step = g.next();

  const spans = step.value;

  world.keyframes.forEach(k => {
    out[`csg ${k.id}`] = hashed(csg(world, k.id));
    out[`floor ${k.id}`] = hashed(csgFloor(world, k.id));
  });

  for (const [from, span] of spans) out[`span ${from}`] = hashed(span);

  out.shipped = hashed(shipped(world, { spans, progress: null }));

  return out;
}

function hashed(value: unknown): string {
  const text = JSON.stringify(value, (key, v: unknown) => {
    // How long the bake took over it, which is the clock's, and what it was
    // baked from, which is the world's bookkeeping for when to bake again:
    // neither is what it made.
    if (key === 'setup' || key === 'cut' || key === 'stamp') return undefined;

    // A stand's amounts, which a world without effects has at nought and
    // master did not write at all.
    if ((key === 'radius' || key === 'amplitude') && v === 0) return undefined;
    if ((key === 'radii' || key === 'amplitudes') && v instanceof Map && v.size === 0) return undefined;

    if (v instanceof Map) return { map: [...v] };
    if (v instanceof Set) return { set: [...v] };
    if (ArrayBuffer.isView(v)) return { typed: Array.from(v as unknown as ArrayLike<number>) };

    return v;
  });

  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}
