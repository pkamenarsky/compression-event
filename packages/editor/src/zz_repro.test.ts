import { test } from 'vitest';
import { TOP, addPolygon, grouped, resolveAt, contributed } from './scene';
import { rings } from './resolve';
import { emptyWorld, within } from './types';
import { boundaryRuns, ground } from './geometry';
const rect = (x: number, y: number, w: number, h: number) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
test('repro', () => {
  const a = addPolygon(emptyWorld(), { type: 'level' }, rect(0, 0, 100, 100), 0, TOP);
  const b = addPolygon(a.world, { type: 'level' }, rect(100, 0, 100, 100), 0, TOP);
  const g = grouped(b.world, 0, [a.id, b.id], TOP)!;
  const items = contributed(g.world, resolveAt(g.world, 0).filter(it => it.id !== g.id), () => null);
  console.log(JSON.stringify(items.map(it => ({ id: it.id, kind: it.kind, shape: it.shape }))));
  console.log(JSON.stringify(rings(items, 'level')));
});
