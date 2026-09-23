import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { csg } from './scene';
import { resolveGroup } from './resolve';
import { restored } from './save';
import { wrote } from './testing';
import { Id, World } from './types';

const round = (by: number) => ({ kind: 'round' as const, by });

describe('the reported world', () => {
  const base = restored(JSON.parse(readFileSync('scratch/world-2026-09-23T19-11-16Z.json', 'utf8'))).world;
  const rings = (s: readonly (readonly { x: number, y: number }[])[]) => s.map(r => {
    const all = r.map(p => `${p.x.toFixed(6)},${p.y.toFixed(6)}`);
    const pts = all.filter((p, i) => p !== all[(i + 1) % all.length]);
    const first = pts.indexOf([...pts].sort()[0]);

    return [...pts.slice(first), ...pts.slice(0, first)];
  }).sort();

  const bevelled = (world: World, id: Id, by: number): World => {
    const rig = world.rigs.get(id)!;
    const keys = new Map(rig.keys);

    keys.set(0, (keys.get(0) ?? []).map(k => ({ ...k, by: { ...k.by, round: by } })));

    return { ...world, rigs: new Map(world.rigs).set(id, { ...rig, keys }) } as World;
  };

  test('law 1: resolving draws the same, at every keyframe', () => {
    for (const k of base.keyframes.map(f => f.id)) {
      const out = resolveGroup(base, k, 10);

      if (out === null) continue;
      expect([k, rings(csg(out.world, k))]).toEqual([k, rings(csg(base, k))]);
    }
  });

  for (const was of [0, 50, 100]) {
    test(`law 2: round ${was}, resolve, then 100 more`, () => {
      const onScope = rings(csg(bevelled(base, 10, was + 100), 0));
      const flat = resolveGroup(bevelled(base, 10, was), 0, 10)!.world;
      const after = [...flat.polygons.keys()].reduce((w, p) => wrote(w, 0, p, round(100)), flat);

      console.log('was', was, 'scope', onScope.flat().length, 'resolved+rounded', rings(csg(after, 0)).flat().length);
      expect(rings(csg(after, 0))).toEqual(onScope);
    });
  }
});
