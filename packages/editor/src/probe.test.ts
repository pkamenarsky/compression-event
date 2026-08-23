import { test } from 'vitest';
import { readFileSync } from 'node:fs';
import { Point } from '@ce/game/world';
import { restored, Saved } from './save';
import { EMPTY_LIVE, live, resolveAt, runs } from './scene';

const FILE = 'scratch/world-2026-08-23T20-11-29Z.json';

function bend(a: Point, b: Point, c: Point): number {
  const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - b.x, vy = c.y - b.y;
  const l = Math.max(Math.hypot(ux, uy), Math.hypot(vx, vy));
  return l === 0 ? 0 : Math.abs(ux * vy - uy * vx) / l;
}

test('the still path, per version', () => {
  const w = restored(JSON.parse(readFileSync(FILE, 'utf8')) as Saved).world;

  for (let v = 0; v < w.versions.length; v++) {
    const items = resolveAt(w, v);
    const rs = runs(live(EMPTY_LIVE, items));

    let interior = 0, collinear = 0;
    const flats: string[] = [];

    for (const r of rs) {
      for (let i = 1; i < r.length - 1; i++) {
        interior++;
        const d = bend(r[i - 1], r[i], r[i + 1]);
        if (d < 1e-4) { collinear++; flats.push(`(${r[i].x.toFixed(1)},${r[i].y.toFixed(1)})`); }
      }
    }

    // And the source projections the boundary is cut from.
    let shapePts = 0, shapeFlat = 0;

    for (const it of items) {
      for (const ring of it.shape) {
        shapePts += ring.length;
        for (let i = 0; i < ring.length; i++) {
          const a = ring[(i - 1 + ring.length) % ring.length];
          const c = ring[(i + 1) % ring.length];
          if (bend(a, ring[i], c) < 1e-4) shapeFlat++;
        }
      }
    }

    console.log(
      `v${v}: outline ${rs.length} runs ${rs.reduce((s, r) => s + r.length, 0)} pts`
      + ` | interior ${interior} collinear ${collinear} ${flats.slice(0, 6).join(' ')}`
      + ` | projections ${shapePts} pts, ${shapeFlat} of them flat`,
    );
  }
});
