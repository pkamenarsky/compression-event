// -----------------------------------------------------------------------------
// Experiment: the erosion first, and one pass for everything after the fold
//
// PLAN-bevel 3.10 measured a real world popping on its third span — a flat
// tooth handed to a deep erosion, whose mitre runs away — and answered it by
// giving the group the polygon's order: round, erode, deform.
//
// This asks a further question. Of a group's three effects, only the depth
// cannot be lifted onto the union: a bevel is per corner and an amplitude is
// per edge, and 2.9's naming carries both onto a union run, while a member's
// depth is per shape and a corner where two members meet would carry two of
// them (2.8b). So the erosion is the one step that has to happen before the
// fold — and if it goes first, everything after the fold is a single round
// and a single deform, with the amounts summed per run, rather than a member
// pipeline and a group pipeline that drift.
//
// The cheapest test of that is the ordering alone, on 3.10's own world and
// with 3.10's own method: rank the steps rather than max them, and refine
// until the number stops moving. Run with EXPERIMENT=1.
// -----------------------------------------------------------------------------

import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Point } from '@ce/game/world';
import { Saved, restored } from '../save';
import { Frame, truth } from '../bake';

const WORLD = new URL('../../../../scratch/world-2026-09-22T21-40-17Z.json', import.meta.url);

/** How far the two boundaries are apart: the furthest either has to go to
 * find a point of the other, sampled along their segments. Runs are open
 * polylines, so nothing wraps. */
function apart(a: Frame, b: Frame): number {
  const segs = (f: Frame): [Point, Point][] => f.flatMap(run =>
    run.points.slice(1).map((p, i) => [run.points[i], p] as [Point, Point]));
  const along = (f: Frame): Point[] => segs(f).flatMap(([p, q]) =>
    [0, 0.25, 0.5, 0.75, 1].map(u => ({ x: p.x + (q.x - p.x) * u, y: p.y + (q.y - p.y) * u })));
  const near = (p: Point, s: [Point, Point][]) => Math.min(...s.map(([q, r]) => {
    const dx = r.x - q.x, dy = r.y - q.y, l2 = dx * dx + dy * dy;
    const u = l2 === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - q.x) * dx + (p.y - q.y) * dy) / l2));

    return Math.hypot(p.x - q.x - dx * u, p.y - q.y - dy * u);
  }));
  const sa = segs(a), sb = segs(b);

  if (sa.length === 0 || sb.length === 0) return Infinity;

  return Math.max(...along(a).map(p => near(p, sb)), ...along(b).map(p => near(p, sa)));
}

function world() {
  const out = restored(JSON.parse(readFileSync(WORLD, 'utf8')) as Saved);

  if ('refused' in out) throw new Error(`refused: ${String(out.refused)}`);

  return out.world;
}

/** The steps of one span, sorted: `steps` instants, the boundary at each, and
 * how far each is from the one before. */
function stepped(from: number, steps: number): { t: number, d: number, n: number }[] {
  const w = world();
  const out: { t: number, d: number, n: number }[] = [];
  let last = truth(w, from, 0);

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const now = truth(w, from, t);

    out.push({ t, d: apart(last, now), n: now.reduce((k, r) => k + r.points.length, 0) });
    last = now;
  }

  return out;
}

function profile(from: number, steps: number): number[] {
  return stepped(from, steps).map(s => s.d).sort((x, y) => x - y);
}

const at = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const points = (from: number, t: number) => truth(world(), from, t).reduce((n, r) => n + r.points.length, 0);

describe.skipIf(!process.env.EXPERIMENT)('experiment: the erosion first', () => {
  const order = 'erd';
  const SPANS = [0, 1, 2, 3, 4];

  it(`the step profile of each span, order ${order}`, () => {
    const steps = Number(process.env.STEPS ?? 1600);
    const lines: string[] = [`\norder ${order}, ${steps} steps`, 'span  median     90th      worst   points 0 → 1'];

    for (const from of SPANS) {
      const p = profile(from, steps);

      lines.push(`${String(from).padEnd(4)}  ${at(p, 0.5).toFixed(4).padStart(8)}  ${at(p, 0.9).toFixed(4).padStart(8)}  `
        + `${at(p, 1).toFixed(4).padStart(8)}   ${points(from, 0)} → ${points(from, 1)}`);
    }

    console.log(lines.join('\n'));
    expect(true).toBe(true);
  }, 600_000);

  it('refined: a discontinuity converges, a fast figure divides by four', () => {
    const span = Number(process.env.SPAN ?? 3);
    const lines: string[] = [`\norder ${order}, span ${span} refined`, 'steps   median     worst'];

    for (const steps of [400, 1600, 6400]) {
      const p = profile(span, steps);

      lines.push(`${String(steps).padEnd(6)}  ${at(p, 0.5).toFixed(4).padStart(8)}  ${at(p, 1).toFixed(4).padStart(8)}`);
    }

    const fine = stepped(span, 6400).sort((a, b) => b.d - a.d).slice(0, 5);

    lines.push('the five worst at 6400, with the ring either side');

    for (const s of fine) lines.push(`  t ${s.t.toFixed(5)}  ${s.d.toFixed(4).padStart(9)}  ${s.n} points`);

    console.log(lines.join('\n'));
    expect(true).toBe(true);
  }, 900_000);
});

/**
 * The boundary at each keyframe, written out, so that the three orders can be
 * compared against each other from separate runs — the order is a process-wide
 * switch, so no one run sees two of them.
 */
describe.skipIf(!process.env.DUMP)('the figure each order draws', () => {
  it('written', () => {
    const order = 'erd';
    const out = [0, 1, 2, 3, 4, 5].map(k => truth(world(), Math.min(k, 4), k === 5 ? 1 : 0)
      .map(r => r.points.map(p => [p.x, p.y])));

    writeFileSync(new URL(`../../../../scratch/order-${order}.json`, import.meta.url), JSON.stringify(out));
    expect(out.length).toBe(6);
  }, 120_000);
});
