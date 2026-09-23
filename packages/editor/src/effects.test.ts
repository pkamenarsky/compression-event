import { describe, expect, test } from 'vitest';
import { Point } from '@ce/game/world';
import { rounded, shapeArea } from './geometry';
import { Resolved, TOP, addPolygon, contributing, copied, csg, grouped, imagesOf, movedIn, namesOf, pasted, resolveAt, rigOf, sealing, withRig } from './scene';
import { Span, spanAt, stamp } from './bake';
import { cornerRounded, stateAt } from './rig';
import { resolveGroup } from './resolve';
import {
  applies,
  cornerRounding,
  cornersAmounted,
  cornersInheriting,
  cornersOptioned,
  cornersSwitched,
  edgeRun,
  edgesBetween,
  edgesWithinBox,
  endsOf,
  switchedOff,
  switchedOn,
} from './effects';
import { erode, inSegments, move, scaled, turned, wrote } from './testing';
import { Effects, Id, PolygonId, REMEMBERED, World, emptyWorld } from './types';

function rect(x: number, y: number, w: number, h: number): Point[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

function room(world: World = emptyWorld(), at: Point[] = rect(0, 0, 100, 100)): { world: World, id: PolygonId } {
  return addPolygon(world, { level: 'hollow' }, at, 0, TOP);
}

function withEffects(world: World, id: Id, fx: Effects): World {
  return { ...world, effects: new Map(world.effects).set(id, fx) };
}

const round = (by: number) => ({ kind: 'round' as const, by });
const deform = (by: number) => ({ kind: 'deform' as const, by });

/** A `w` by `h` rectangle's area with its four corners rounded `r` deep in
 * `segments`, as the geometry rounds a ring on its own. */
function roundedRect(w: number, h: number, r: number, segments: number): number {
  return shapeArea([rounded(rect(0, 0, w, h), () => r, segments)]);
}

/** How far a point is from a room of 0,0 to 100,100: nought on it, positive
 * outside, and the amplitude at a tooth's tip. */
function offRoom(p: Point): number {
  return Math.max(-p.x, p.x - 100, -p.y, p.y - 100);
}

/** How far a point is from the nearest edge of `shape`. */
function toShape(p: Point, shape: readonly (readonly Point[])[]): number {
  return Math.min(...shape.flatMap(ring => ring.map((q, i) => {
    const r = ring[(i + 1) % ring.length];
    const dx = r.x - q.x, dy = r.y - q.y, l2 = dx * dx + dy * dy;
    const u = l2 === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - q.x) * dx + (p.y - q.y) * dy) / l2));

    return Math.hypot(p.x - q.x - dx * u, p.y - q.y - dy * u);
  })));
}

/** Which of `corners`' edges a point stands nearest, by index. */
function nearestEdge(p: Point, corners: readonly { at: Point }[]): number {
  const far = corners.map((c, i) => toShape(p, [[c.at, corners[(i + 1) % corners.length].at]]));

  return far.indexOf(Math.min(...far));
}

function shapeOf(world: World, id: Id) {
  return resolveAt(world, 0).find(it => it.id === id)!.shape;
}

const ROUND: Effects = { round: inSegments(8, 5) };

describe('a polygon\'s effects', () => {
  test('a rounded room is its arcs, drawn on what the erosion leaves', () => {
    const { world, id } = room();
    const deep = wrote(withEffects(world, id, ROUND), 0, id, erode(10), round(5));

    // The round is drawn after the erosion — PLAN-bevel's step 6 — so it is
    // the eroded room's own arcs and nothing else: exactly `R(80, 5)`, where
    // rounding first and eroding after was some square units off it, an
    // offset curve not being the curve again at a smaller size.
    expect(shapeOf(deep, id)).toHaveLength(1);
    expect(shapeArea(shapeOf(deep, id))).toBeCloseTo(roundedRect(80, 80, 5, 8), 6);

    // With no erosion, its arcs as they are asked for.
    const plain = wrote(withEffects(world, id, ROUND), 0, id, round(5));

    expect(shapeOf(plain, id)[0]).toHaveLength(4 * 9);
    expect(shapeArea(shapeOf(plain, id))).toBeCloseTo(roundedRect(100, 100, 5, 8), 6);
  });

  test('a round is faceted as it is seen, however deep the erosion', () => {
    const { world, id } = room(emptyWorld(), rect(0, 0, 1000, 1000));
    const fx: Effects = { round: { precision: 2, tension: 0.5, chamfer: false } };
    const facets = (depth: number) => resolveAt(wrote(withEffects(world, id, fx), 0, id, erode(depth), round(300)), 0)
      .find(it => it.id === id)!.effected!.facets.map(f => f.n);

    // Drawn at 300 and at 400, the same round of 300 once eroded, and so the
    // same facets: a facet more would be a line fading in for nothing.
    expect(facets(100)).toEqual(facets(0));
  });

  test('with nothing to them, the projection is the erosion alone', () => {
    const { world, id } = room();
    const plain = wrote(world, 0, id, erode(10));

    expect(shapeOf(withEffects(plain, id, ROUND), id)).toEqual(shapeOf(plain, id));
    expect(shapeOf(wrote(plain, 0, id, round(5)), id)).toEqual(shapeOf(plain, id));
  });

  test('a bevel is a length at the room\'s own scale, as a depth is, however the room is carried', () => {
    const { world, id } = room();
    const w = wrote(withEffects(world, id, ROUND), 0, id, round(5), scaled(2, 2), turned(0.3), move(40, -7));

    expect(shapeArea(shapeOf(w, id))).toBeCloseTo(roundedRect(200, 200, 10, 8), 6);

    // And squashed, where the projection is taken in the world instead, by
    // the square root of what the squash does to area.
    const squashed = wrote(withEffects(world, id, ROUND), 0, id, round(5), scaled(2, 1));

    expect(shapeArea(shapeOf(squashed, id))).toBeCloseTo(roundedRect(200, 100, 5 * Math.SQRT2, 8), 6);
  });

  test('a corner rounds on its own, over its room\'s', () => {
    const { world, id } = room();
    const corner = world.polygons.get(id)!.points[2].id;
    const w = withRig(withEffects(world, id, { round: inSegments(4, 10) }), id, cornerRounded(rigOf(world, id), corner, 0, 10));
    const shape = shapeOf(w, id);

    expect(shape[0]).toHaveLength(3 + 5);
    expect(shape[0]).toContainEqual({ x: 90, y: 100 });
    expect(shape[0]).toContainEqual({ x: 100, y: 90 });
  });

  test('a corner\'s own options are over its room\'s', () => {
    const { world, id } = room();
    const corner = world.polygons.get(id)!.points[0].id;
    let w = wrote(withEffects(world, id, ROUND), 0, id, round(5));

    w = { ...w, cornerEffects: new Map([[corner, { round: inSegments(2, 5) }]]) };

    expect(shapeOf(w, id)[0]).toHaveLength(3 * 9 + 3);
  });

  test('a deform puts its points into every edge, off the line by its amplitude', () => {
    const { world, id } = room();
    // Out, a zigzag is teeth: out, on the line, out — every twenty along each
    // wall from wherever the seed starts it, those near a corner shorter.
    const fx: Effects = { deform: { spacing: 20, pattern: 'zigzag', seed: 0, sides: 'out', jitter: 0 } };
    const w = wrote(withEffects(world, id, fx), 0, id, deform(2));
    const ring = shapeOf(w, id)[0];
    const out = ring.map(p => Math.max(-p.x, p.x - 100, -p.y, p.y - 100)).filter(d => d > 1e-9);

    // Two out on every wall at least, none further than the amplitude, and
    // some the whole of it.
    expect(out.length).toBeGreaterThanOrEqual(4 * 2);
    out.forEach(d => expect(d).toBeLessThanOrEqual(2 + 1e-9));
    expect(out.filter(d => Math.abs(d - 2) < 1e-9).length).toBeGreaterThanOrEqual(4);
  });

  test('a pasted room comes with its effects and its corners\' own', () => {
    const { world, id } = room();
    const corner = world.polygons.get(id)!.points[0].id;
    let w = wrote(withEffects(world, id, ROUND), 0, id, round(5));

    w = { ...w, cornerEffects: new Map([[corner, { round: inSegments(2, 5) }]]) };

    const after = pasted(w, 0, copied(w, 0, [id]), { x: 300, y: 0 }, TOP);
    const copy = after.ids[0];

    expect(after.world.effects.get(copy)).toEqual(ROUND);
    expect(shapeArea(shapeOf(after.world, copy))).toBeCloseTo(shapeArea(shapeOf(w, id)), 9);
  });
});

describe('what a member publishes about its outline', () => {
  /** The room's own corners, in ring order: a tooth is its edge's, not one
   * of these. */
  const idsOf = (w: World, id: Id) => resolveAt(w, 0).find(r => r.id === id)!.corners.filter(c => c.root === undefined).map(c => c.id);
  const on = (line: { a: Point, b: Point }, p: Point) => {
    const dx = line.b.x - line.a.x, dy = line.b.y - line.a.y;

    return Math.abs((p.x - line.a.x) * dy - (p.y - line.a.y) * dx) / Math.hypot(dx, dy);
  };

  test('a plain room publishes its four edges, on the lines they are eroded to', () => {
    const { world, id } = room();
    const w = wrote(world, 0, id, erode(10));
    const it = resolveAt(w, 0).find(r => r.id === id)!;
    const names = namesOf(it);

    expect(names.corners.map(c => c.id)).toEqual(idsOf(w, id));
    expect(names.corners.map(c => c.bevel)).toEqual([0, 0, 0, 0]);
    expect(names.lines.map(l => l.id)).toEqual(idsOf(w, id));
    expect(names.lines.map(l => l.amplitude)).toEqual([0, 0, 0, 0]);

    // The eroded room is the square pulled in ten: each line is that wall.
    expect(names.lines.map(l => Math.round(on(l, { x: 50, y: 50 })))).toEqual([40, 40, 40, 40]);
  });

  test('a rounded, deformed room publishes the round it asks for, not the arc it would draw', () => {
    const { world, id } = room();
    const fx: Effects = { round: inSegments(8, 10), deform: { spacing: 20, pattern: 'zigzag', seed: 0, sides: 'both', jitter: 0 } };
    const w = wrote(withEffects(world, id, fx), 0, id, round(10), deform(4), erode(5));
    const it = resolveAt(w, 0).find(r => r.id === id)!;
    const names = namesOf(it);
    const corners = idsOf(w, id);

    // One corner per corner and one line per wall — the teeth between are
    // the wall's, and name nothing of their own. No arc points anywhere: the
    // round is an amount beside the corner, for whoever holds it to lay.
    expect(names.corners.map(c => c.id)).toEqual(corners);
    expect(names.corners.every(c => c.bevel > 0)).toBe(true);
    expect(new Set(names.corners.map(c => c.facets.n))).toEqual(new Set([8]));
    expect(names.lines.map(l => l.id)).toEqual(corners);

    // And the deform's height along each wall, which is the amplitude asked
    // for: the teeth themselves are not published either.
    expect(names.lines.map(l => l.amplitude)).toEqual([4, 4, 4, 4]);

    // Each wall pulled in by the erosion: the square's walls are at 0 and
    // 100, and five in from either.
    expect(names.lines.map(l => Math.round(on(l, { x: 50, y: 50 })))).toEqual([45, 45, 45, 45]);
  });

  test('moved in by a depth, they are where that depth puts the outline', () => {
    // What a scope does to what its members published: the same erosion the
    // fold itself goes through, so the names still lie on it. Against the
    // room resolved at that depth, which is the answer.
    const { world, id } = room();
    const fx: Effects = { round: inSegments(8, 10) };
    const w = withEffects(world, id, fx);
    const shallow = wrote(w, 0, id, round(10));
    const deep = wrote(w, 0, id, round(10), erode(7));
    const at = (x: World) => resolveAt(x, 0).find(r => r.id === id)!;
    const moved = movedIn(namesOf(at(shallow)), 7);
    const theirs = namesOf(at(deep));
    const near = (p: Point, all: readonly Point[]) => Math.min(...all.map(q => Math.hypot(p.x - q.x, p.y - q.y)));


    // Every corner of the one where the other has it: the mitre of the two
    // walls at it is where eroding the outline puts it.
    moved.corners.forEach((c, i) => {
      expect(near(c.at, [theirs.corners[i].at])).toBeLessThan(1e-9);
    });

    moved.lines.forEach((l, i) => {
      expect(near(l.a, [theirs.lines[i].a])).toBeLessThan(1e-9);
      expect(near(l.b, [theirs.lines[i].b])).toBeLessThan(1e-9);
    });
  });
});

describe('a group\'s effects', () => {
  /** Two rooms side by side, sealed into one, rounded as one. */
  function corridor() {
    const a = room(emptyWorld(), rect(0, 0, 100, 100));
    const b = room(a.world, rect(60, 0, 140, 100));
    const g = grouped(b.world, 0, [a.id, b.id], TOP)!;
    const world = wrote(withEffects(sealing(g.world, g.id, true), g.id, { round: inSegments(8, 10) }), 0, g.id, round(10));

    return { world, id: g.id };
  }

  test('they apply to the union, so the join between rooms is not rounded', () => {
    const { world } = corridor();
    const set = csg(world, 0);

    // A run closes on its first point.
    expect(set).toHaveLength(1);
    expect(set[0]).toHaveLength(4 * 9 + 1);
    expect(shapeArea(set)).toBeCloseTo(roundedRect(200, 100, 10, 8), 6);
  });

  // PHASE 3: parked. A member has no teeth among its corners any more, so it
  // publishes none as square geometry, and the square machinery — `squareIn`,
  // `effectedSquare`, `imaged` — is what 3.4 takes out. Restore as a test that
  // a group's outline is a polygon's, per 3.5.
  test.skip('its round leaves its members\' deformed geometry square, and its own deform is on its union', () => {
    const zigzag = { spacing: 20, pattern: 'zigzag' as const, seed: 0, sides: 'out' as const, jitter: 0 };
    const a = room(emptyWorld(), rect(0, 0, 100, 100));
    const b = room(a.world, rect(60, 0, 140, 100));
    const g = grouped(b.world, 0, [a.id, b.id], TOP)!;
    const sealed = wrote(withEffects(sealing(g.world, g.id, true), g.id, { round: inSegments(8, 10) }), 0, g.id, round(10));
    const vertices = (w: World) => new Set(csg(w, 0).flat().map(p => `${p.x.toFixed(6)},${p.y.toFixed(6)}`));
    const teethOf = (w: World, id: Id) => {
      const it = resolveAt(w, 0).find(r => r.id === id)!;

      // Those standing off the wall: the rest are on its line, and the union,
      // an arrangement, drops them.
      return it.source.filter((p, i) => it.corners[i].root !== undefined && p.y > 100 + 1e-9);
    };

    // One edge of a room deformed: its teeth and its ends are where they are
    // in the union, square, and the rest of the union rounded as before.
    const top = (world: World) => cornersAmounted(withEffects(world, a.id, { deform: zigzag }), 0, a.id, 'deform', new Set([a.world.polygons.get(a.id)!.points[2].id]), 4);
    const one = top(sealed);
    const teeth = teethOf(one, a.id);

    expect(teeth.length).toBeGreaterThan(0);
    teeth.forEach(p => expect(vertices(one).has(`${p.x.toFixed(6)},${p.y.toFixed(6)}`)).toBe(true));
    expect(vertices(one).has('0.000000,100.000000')).toBe(true);
    expect(vertices(one).has('0.000000,0.000000')).toBe(false);

    // Deformed by the group itself, the same.
    const whole = wrote(withEffects(sealed, g.id, { round: inSegments(8, 10), deform: zigzag }), 0, g.id, deform(4));

    // Its teeth are laid on the union, not its rooms: they stand off the
    // wall, and none of them is a point of a room's.
    const drawn = new Set(resolveAt(whole, 0).flatMap(it => it.source).map(p => `${p.x.toFixed(6)},${p.y.toFixed(6)}`));
    const off = [...vertices(whole)].filter(p => Number(p.split(',')[1]) > 100 + 1e-6);

    expect(off.length).toBeGreaterThan(0);
    off.forEach(p => expect(drawn.has(p)).toBe(false));
  });

  test('a held round eroded past its bevel keeps a hair of itself', () => {
    // A corner that turns into the material is drawn at less than its bevel
    // as the erosion deepens, and would reach nought. It must not: a rounded
    // corner eroded fans out at the depth, and a square one mitres to a
    // point, so the outline would jump by the whole of that fan. A sliver of
    // the round keeps it on the fan side throughout.
    const l = [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 200 }, { x: 200, y: 200 }, { x: 200, y: 400 }, { x: 0, y: 400 }];
    const { world, id } = room(emptyWorld(), l);
    const w = withEffects(world, id, { round: inSegments(8, 40) });
    const area = (depth: number) => shapeArea(shapeOf(wrote(w, 0, id, round(40), erode(depth)), id));

    // The area falls with the depth, and how fast it falls changes slowly.
    // The reflex corner's bevel runs out at a depth of forty: without the
    // sliver the outline loses its fan there, and the step from 39 to 41 is
    // some three thousand out of line with the steps either side of it.
    const steps = [36, 38, 40, 42, 44].map(d => area(d - 1) - area(d + 1));
    const worst = Math.max(...steps.slice(1).map((s, i) => Math.abs(s - steps[i])));

    // Some forty of kink as the fan takes over, against some three thousand
    // of jump without the sliver.
    expect(worst).toBeLessThan(100);

    // And the erosion is still an erosion: deeper is smaller.
    expect(area(60)).toBeLessThan(area(40));
  });

  test('a run\'s teeth are its naming edge\'s, so the far end moving leaves them where they are', () => {
    // Two rooms along one wall, sealed and deformed as one. The wall is one
    // straight of the fold and takes one pattern — the first room's edge
    // names it, and the teeth are counted out from that edge's own middle.
    // So the second room growing at the far end moves nothing over the first.
    const zigzag = { spacing: 20, pattern: 'zigzag' as const, seed: 0, sides: 'both' as const, jitter: 0 };
    const build = (by: number) => {
      const a = room(emptyWorld(), rect(0, 0, 200, 140));
      const b = room(a.world, rect(160, 0, 200 + by, 140));
      const g = grouped(b.world, 0, [a.id, b.id], TOP)!;

      return wrote(withEffects(sealing(g.world, g.id, true), g.id, { deform: zigzag }), 0, g.id, deform(6));
    };

    // The teeth on the near half of the wall, where only the first room is.
    const near = (w: World) => csg(w, 0).flat()
      .filter(p => p.y > 140 - 1e-9 && p.x > 10 && p.x < 150)
      .map(p => `${p.x.toFixed(6)},${p.y.toFixed(6)}`);

    expect(near(build(0)).length).toBeGreaterThanOrEqual(4);
    expect(near(build(40))).toEqual(near(build(0)));
    expect(near(build(130))).toEqual(near(build(0)));
  });

  test('a run cut in two keeps the teeth on the piece its naming edge is on', () => {
    // A pillar rising through the wall cuts the run. The piece the naming
    // edge is still on keeps every tooth it had; the other piece re-anchors
    // to whichever edge names it, which is an event either way.
    const zigzag = { spacing: 20, pattern: 'zigzag' as const, seed: 0, sides: 'both' as const, jitter: 0 };
    const build = (cut: boolean) => {
      const a = room(emptyWorld(), rect(0, 0, 300, 140));

      // A room off on its own, so the group has two members either way, and
      // the one that cuts the wall where it is asked for.
      const away = room(a.world, rect(600, 0, 60, 60));
      const w = cut ? addPolygon(away.world, { level: 'hollow' }, rect(240, 120, 40, 60), 0, TOP) : null;
      const ids = w === null ? [a.id, away.id] : [a.id, away.id, w.id];
      const g = grouped(w?.world ?? away.world, 0, ids, TOP)!;

      return wrote(withEffects(sealing(g.world, g.id, true), g.id, { deform: zigzag }), 0, g.id, deform(6));
    };
    const near = (world: World) => csg(world, 0).flat()
      .filter(p => p.y > 140 - 1e-9 && p.x > 10 && p.x < 200)
      .map(p => `${p.x.toFixed(6)},${p.y.toFixed(6)}`);

    expect(near(build(false)).length).toBeGreaterThanOrEqual(4);
    expect(near(build(true))).toEqual(near(build(false)));
  });

  test('its deform runs along a member\'s arc, as it would along its own', () => {
    // A member's round reaches the fold as facets, and the group's deform
    // runs along it as one curve — teeth at its own spacing, standing their
    // full amplitude off it — rather than a tooth to a facet, which would be
    // a dozen tiny ones that never reach their height.
    const zigzag = { spacing: 20, pattern: 'zigzag' as const, seed: 0, sides: 'both' as const, jitter: 0 };
    const build = (amplitude: number) => {
      const a = room(emptyWorld(), rect(0, 0, 200, 140));
      const away = room(a.world, rect(600, 0, 60, 60));
      const w = withEffects(away.world, a.id, { round: inSegments(8, 30) });
      const g = grouped(w, 0, [a.id, away.id], TOP)!;
      const sealed = withEffects(sealing(g.world, g.id, true), g.id, { deform: zigzag });

      return wrote(wrote(sealed, 0, a.id, round(30)), 0, g.id, deform(amplitude));
    };

    // The corner's own arc, as the group leaves it with no deform at all.
    const plain = csg(build(0), 0).flat().filter(p => p.x < 40 && p.y < 40);
    const off = (p: Point) => Math.min(...plain.map((q, i) => {
      const r = plain[(i + 1) % plain.length];
      const dx = r.x - q.x, dy = r.y - q.y, l2 = dx * dx + dy * dy;
      const u = l2 === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - q.x) * dx + (p.y - q.y) * dy) / l2));

      return Math.hypot(p.x - q.x - dx * u, p.y - q.y - dy * u);
    }));

    expect(plain.length).toBeGreaterThanOrEqual(9);

    const toothed = csg(build(8), 0).flat().filter(p => p.x < 40 && p.y < 40);
    const heights = toothed.map(off);

    // Teeth of the group's own size: a tip its whole amplitude off the curve,
    // and two or three of them on an arc some forty long at a spacing of
    // twenty — not one to each of the eight facets.
    expect(Math.max(...heights)).toBeGreaterThan(7.5);
    expect(heights.filter(h => h > 4).length).toBeGreaterThanOrEqual(1);
    expect(heights.filter(h => h > 4).length).toBeLessThanOrEqual(3);
  });

  test('its round is after its solids cut its level, so the corners they cut are rounded too', () => {
    const a = room(emptyWorld(), rect(0, 0, 100, 100));
    const s = addPolygon(a.world, { level: 'solid' }, rect(80, 40, 40, 20), 0, TOP);
    const g = grouped(s.world, 0, [a.id, s.id], TOP)!;
    const w = wrote(withEffects(sealing(g.world, g.id, true), g.id, { round: inSegments(8, 5) }), 0, g.id, round(5));
    const vertices = new Set(csg(w, 0).flat().map(p => `${p.x.toFixed(6)},${p.y.toFixed(6)}`));

    // Where the solid crosses the wall, and its own corners in the room: none
    // of them a point any more, each an arc.
    ['100,40', '100,60', '80,40', '80,60', '0,0'].forEach(p => {
      const [x, y] = p.split(',').map(Number);

      expect(vertices.has(`${x.toFixed(6)},${y.toFixed(6)}`)).toBe(false);
    });

    expect(csg(w, 0).flat().length).toBe(8 * 9 + 1);
  });

  test('a loose group has none to give', () => {
    const { world, id } = corridor();

    expect(shapeArea(csg(sealing(world, id, false), 0))).toBeCloseTo(200 * 100, 9);
  });

  test('its union\'s noise belongs to its members\' edges, whatever else joins it', () => {
    const noise: Effects = { deform: { spacing: 15, pattern: 'noise', seed: 3, sides: 'both', jitter: 0 } };
    const top = (w: World) => csg(w, 0).flat().filter(p => p.y > 95 && p.x > 5 && p.x < 150);
    const build = (extra: boolean) => {
      const a = room(emptyWorld(), rect(0, 0, 100, 100));
      const b = room(a.world, rect(60, 0, 140, 100));
      const ids = [a.id, b.id];
      let w = b.world;

      if (extra) {
        const c = room(w, rect(190, 30, 40, 40));

        w = c.world;
        ids.push(c.id);
      }

      const g = grouped(w, 0, ids, TOP)!;

      return wrote(withEffects(sealing(g.world, g.id, true), g.id, noise), 0, g.id, deform(4));
    };

    // A room joined on the right comes before the top in the union's ring,
    // and the teeth along the top do not notice.
    expect(top(build(true))).toEqual(top(build(false)));
    expect(top(build(false)).length).toBeGreaterThan(8);
  });

  test('resolved, its rings take the effects and the amounts with them', () => {
    const { world, id } = corridor();
    const out = resolveGroup(world, 0, id)!;
    const made = out.ids[0];

    expect(out.world.effects.get(made)).toEqual({ round: inSegments(8, 10) });
    expect(stateAt(out.world, made, 0).bevel).toBe(10);
    expect(shapeArea(csg(out.world, 0))).toBeCloseTo(shapeArea(csg(world, 0)), 6);
  });
});

describe('editing effects', () => {
  const DEFORM: Effects = { deform: { spacing: 20, pattern: 'zigzag', seed: 0, sides: 'out', jitter: 0 } };

  test('switched on, an effect keeps the options a thing already had', () => {
    const { world, id } = room();
    const other = room(world, rect(200, 0, 50, 50));
    const w = switchedOn(withEffects(other.world, id, { round: inSegments(2, 5) }), [id, other.id], 'round', REMEMBERED);

    expect(w.effects.get(id)).toEqual({ round: inSegments(2, 5) });
    expect(w.effects.get(other.id)).toEqual({ round: REMEMBERED.round });
  });

  test('switched off, an effect does nothing and keeps everything, and switched on is as it was', () => {
    const { world, id } = room();
    const corner = world.polygons.get(id)!.points[0].id;
    let w = wrote(withEffects(world, id, { ...ROUND, ...DEFORM }), 0, id, erode(3), round(5), deform(2));

    w = cornersAmounted(w, 0, id, 'round', new Set([corner]), 4);

    const off = switchedOff(w, [id], 'round');

    expect(applies(off, id, 'round')).toBe(false);
    expect(rigOf(off, id)).toBe(rigOf(w, id));
    expect(shapeOf(off, id)).toEqual(shapeOf(wrote(withEffects(world, id, DEFORM), 0, id, erode(3), deform(2)), id));
    expect(shapeOf(switchedOn(off, [id], 'round', REMEMBERED), id)).toEqual(shapeOf(w, id));
  });

  test('erosion switched off stands the thing at its outline, its timeline kept', () => {
    const { world, id } = room();
    const corner = world.polygons.get(id)!.points[0].id;
    const w = cornersAmounted(wrote(world, 0, id, erode(5)), 0, id, 'erode', new Set([corner]), 2);

    expect(applies(w, id, 'erode')).toBe(true);

    const off = switchedOff(w, [id], 'erode');

    expect(shapeOf(off, id)).toEqual(shapeOf(world, id));
    expect(stateAt(off, id, 0).erosion).toBe(5);
    expect(shapeOf(switchedOn(off, [id], 'erode', REMEMBERED), id)).toEqual(shapeOf(w, id));
    expect(switchedOn(off, [id], 'erode', REMEMBERED).effects.has(id)).toBe(false);
  });

  test('a corner left square on a rounded room, and rounded its own way', () => {
    const { world, id } = room();
    const [a, b] = world.polygons.get(id)!.points;
    const w = wrote(withEffects(world, id, { round: inSegments(8, 10) }), 0, id, round(10));
    const ring = () => shapeOf(w, id)[0].length;

    const square = cornersSwitched(w, [a.id], false, REMEMBERED);

    expect(cornerRounding(square, a.id)).toBe(false);
    expect(cornerRounding(square, b.id)).toBe(true);
    expect(shapeOf(square, id)[0]).toHaveLength(ring() - 8);

    const back = cornersSwitched(square, [a.id], true, REMEMBERED);

    expect(shapeOf(back, id)).toEqual(shapeOf(w, id));

    const finer = cornersOptioned(w, [a.id], { precision: inSegments(12, 10).precision }, REMEMBERED);

    expect(finer.cornerEffects.get(a.id)!.round).toEqual(inSegments(12, 10));
    expect(shapeOf(finer, id)[0]).toHaveLength(ring() + 4);
    expect(shapeOf(cornersInheriting(finer, [a.id]), id)).toEqual(shapeOf(w, id));

    // The room's round switched off leaves every corner square, its own too.
    expect(shapeOf(switchedOff(finer, [id], 'round'), id)[0]).toHaveLength(4);
  });

  test('an edge\'s amplitude is its own, over its polygon\'s', () => {
    const { world, id } = room();
    const [a] = world.polygons.get(id)!.points;
    const w = cornersAmounted(wrote(withEffects(world, id, DEFORM), 0, id, deform(1)), 0, id, 'deform', new Set([a.id]), 3);

    expect(rigOf(w, id).deforms.get(a.id)!.get(0)!.op.by).toBe(3);
    expect(stateAt(w, id, 0).amplitudes.get(a.id)).toBe(3);
  });

  test('an edge runs from its drawn corner to the next, and its teeth are in the shape', () => {
    const { world, id } = room();
    const points = world.polygons.get(id)!.points;
    const w = wrote(withEffects(world, id, DEFORM), 0, id, deform(2));
    const it = resolveAt(w, 0).find(r => r.id === id)!;
    const run = edgeRun(it, points[0].id);

    // A polygon's corners are the ones it was drawn with: the deform is laid
    // on the eroded outline, so an edge is its two ends and nothing between.
    // See PLAN-bevel 3.1.
    expect(run).toHaveLength(2);
    expect(it.corners[run[0]].id).toBe(points[0].id);
    expect(it.corners[run[1]].id).toBe(points[1].id);
    expect(it.corners.every(c => c.root === undefined)).toBe(true);

    // The teeth are in the shape, which has more points than the ring has
    // corners, and they stand off the walls.
    expect(it.shape[0].length).toBeGreaterThan(it.corners.length);
    expect(it.shape[0].filter(p => offRoom(p) > 1e-9).length).toBeGreaterThanOrEqual(4);

    expect(endsOf([it], [points[3].id]).sort()).toEqual([points[3].id, points[0].id].sort());
    expect(edgesBetween([it], [points[0].id, points[1].id, points[3].id]).sort()).toEqual([points[0].id, points[3].id].sort());

    // The top edge alone lies wholly inside a box round it, teeth and all.
    expect(edgesWithinBox([it], { x: -10, y: -10 }, { x: 110, y: 10 })).toEqual([points[0].id]);
  });

  test('one edge deformed leaves the others straight, and their corners\' bevels whole', () => {
    const { world, id } = room();
    const [a, b, c, d] = world.polygons.get(id)!.points;
    const rounded = wrote(withEffects(world, id, { round: inSegments(8, 30), ...DEFORM }), 0, id, round(30));
    const w = cornersAmounted(rounded, 0, id, 'deform', new Set([a.id]), 3);
    const it = resolveAt(w, 0).find(r => r.id === id)!;

    // Every edge is its two ends now; what tells them apart is the shape.
    [a, b, c, d].forEach(p => expect(edgeRun(it, p.id)).toHaveLength(2));

    // Only the deformed edge's *run* has anything standing off it — and its
    // run is the wall and the two arcs at its ends. Laid on the eroded
    // outline, a straight and an arc are one kind of run, so a tooth carries
    // on round the corner rather than stopping short of it, going over from
    // this edge's amplitude to its neighbour's as it goes: PLAN-bevel 3.5 and
    // the parked test below. So a point the deform moved is nearer that edge
    // than any other, or else on one of its two corners' arcs.
    const plain = resolveAt(rounded, 0).find(r => r.id === id)!;
    const moved = it.shape[0].filter(p => toShape(p, plain.shape) > 1e-6);
    const from = (p: Point, q: Point) => Math.hypot(p.x - q.x, p.y - q.y);

    expect(moved.length).toBeGreaterThan(0);
    moved.forEach(p => expect(
      nearestEdge(p, [a, b, c, d]) === 0 || from(p, a.at) <= 30 || from(p, b.at) <= 30,
    ).toBe(true));

    // And nothing stands off the two walls that edge does not touch.
    moved.forEach(p => expect(from(p, c.at)).toBeGreaterThan(30));

    // The corner the deformed edge does not touch is rounded as it was.
    const arc = (at: typeof it) => imagesOf(at)!.corners[at.corners.findIndex(q => q.id === c.id)];

    expect(arc(it)).toEqual(arc(resolveAt(rounded, 0).find(r => r.id === id)!));
  });

  // PHASE 3: parked, and this one is false by design now. Laid on the eroded
  // outline, a straight and an arc are one kind of run, so teeth no longer
  // stop short of an arc — they run along it. Replace with 3.5's "teeth of one
  // size along straights and arcs alike".
  test.skip('a polygon\'s teeth stop short of its corners\' arcs, and are never rounded', () => {
    const { world, id } = room();
    const [a, b] = world.polygons.get(id)!.points;
    const fx = { round: inSegments(8, 30), deform: DEFORM.deform! };
    const it = resolveAt(wrote(withEffects(world, id, fx), 0, id, round(30), deform(3)), 0).find(r => r.id === id)!;
    const teeth = edgeRun(it, a.id).slice(1, -1).map(i => it.source[i]);
    const from = (p: Point, q: Point) => Math.hypot(p.x - q.x, p.y - q.y);

    expect(teeth.length).toBeGreaterThan(0);
    expect(teeth.every(p => from(p, a.at) > 30 && from(p, b.at) > 30)).toBe(true);

    // A square corner's arc is the one point; a drawn corner's is its nine.
    const arcs = imagesOf(it)!.corners.map(r => r?.length);
    const at = (vertex: number) => arcs[it.corners.findIndex(q => q.id === vertex)];

    edgeRun(it, a.id).slice(1, -1).forEach(i => expect(arcs[i] ?? 1).toBe(1));
    expect(at(a.id)).toBe(9);
    expect(at(b.id)).toBe(9);
  });

  // PHASE 3: parked. An arc's teeth no longer come through `imagesOf().teeth`
  // — nothing puts them among the corners — but out of `foldShaped` with every
  // other run's. Same intent, read off the shape: see 3.5.
  test.skip('a polygon\'s arcs take teeth of their own, along the curve, laid as its edges\' are', () => {
    const { world, id } = room();
    const fx = { round: inSegments(8, 30), deform: { ...DEFORM.deform!, spacing: 10 } };
    const plain = resolveAt(wrote(withEffects(world, id, { round: fx.round }), 0, id, round(30)), 0).find(r => r.id === id)!;
    const toothed = resolveAt(wrote(withEffects(world, id, fx), 0, id, round(30), deform(3)), 0).find(r => r.id === id)!;
    const im = imagesOf(toothed)!;

    // An arc thirty deep is some forty long: a tooth every ten of it, less
    // those within a spacing of its ends, which are flat there and not laid.
    expect(im.teeth!.length).toBeGreaterThanOrEqual(4 * 2);

    // Each arc is still its nine points, from where it leaves one edge to
    // where it joins the next: the teeth push its points off the curve
    // between them, as an edge's teeth push its straight between them, and
    // leave its ends where they were.
    const arcsOf = (it: Resolved) => imagesOf(it)!.corners.filter((r): r is Point[] => r !== null && r.length > 1);

    expect(arcsOf(toothed)).toHaveLength(4);
    arcsOf(toothed).forEach((run, k) => {
      expect(run).toHaveLength(9);
      expect(run[0]).toEqual(arcsOf(plain)[k][0]);
      expect(run[8]).toEqual(arcsOf(plain)[k][8]);
    });

    // And every point of them, teeth and all, off the curve by no more than
    // the amplitude, near enough: the plain arc's facets are a little off it.
    const offCurve = (p: Point) => Math.min(...arcsOf(plain).flat().map(q => Math.hypot(p.x - q.x, p.y - q.y)));

    [...im.teeth!, ...arcsOf(toothed).flat()].forEach(p => expect(offCurve(p)).toBeLessThan(3 + 10));

    // A tooth on an arc stands as tall as one on an edge: out, the tallest
    // are the amplitude off the curve, as near as the curve read at its
    // points, not between them, lets that be read.
    const out = { ...fx, deform: { ...fx.deform, sides: 'out' as const } };
    const outward = imagesOf(resolveAt(wrote(withEffects(world, id, out), 0, id, round(30), deform(3)), 0).find(r => r.id === id)!)!;
    const fine = resolveAt(wrote(withEffects(world, id, { round: inSegments(64, 30) }), 0, id, round(30)), 0).find(r => r.id === id)!;
    const curve = imagesOf(fine)!.corners.filter((r): r is Point[] => r !== null && r.length > 1).flat();
    const tallest = Math.max(...outward.teeth!.map(p => Math.min(...curve.map(q => Math.hypot(p.x - q.x, p.y - q.y)))));

    expect(tallest).toBeGreaterThan(3 * 0.95);
    expect(tallest).toBeLessThan(3 * 1.15);
  });
});

describe('the bake hears of effects', () => {
  test('an effect changed, or switched off, is a span gone stale', () => {
    const { world, id } = room();
    const w = wrote(withEffects(world, id, ROUND), 0, id, round(5));
    const bake = { spans: new Map([[0, { stamp: stamp(w, 0) } as Span]]), progress: null };

    expect(spanAt(bake, w, 0)).not.toBeNull();
    expect(spanAt(bake, withEffects(w, id, { round: inSegments(9, 5) }), 0)).toBeNull();
    expect(spanAt(bake, switchedOff(w, [id], 'round'), 0)).toBeNull();
  });
});

describe('a scope inside a scope', () => {
  /**
   * A room under `scopes`, innermost first: each seals what came before it
   * along with a room of its own out of the way, since a group wants two
   * members, and takes its own depth and round. What it all comes to around
   * the room itself, which is the only part the far ones can be held against.
   */
  const nested = (scopes: { depth: number, bevel: number }[]): Point[][] => {
    const a = room(emptyWorld(), rect(0, 0, 200, 140));
    let w = a.world, held: Id[] = [a.id];

    scopes.forEach(({ depth, bevel }, i) => {
      const away = room(w, rect(600 + i * 300, 0, 60, 60));
      const g = grouped(away.world, 0, [...held, away.id], TOP)!;

      w = sealing(g.world, g.id, true);
      if (bevel > 0) w = withEffects(w, g.id, { round: inSegments(8, bevel) });
      w = wrote(w, 0, g.id, erode(depth), round(bevel));
      held = [g.id];
    });

    return csg(w, 0).map(ring => ring.filter(p => p.x < 300)).filter(ring => ring.length > 0);
  };

  /** How far the two stray from one another, each way. */
  const apart = (a: Point[][], b: Point[][]): number => Math.max(
    ...a.flat().map(p => toShape(p, b)),
    ...b.flat().map(p => toShape(p, a)),
  );

  test('two scopes erode as one of their sum does', () => {
    const one = nested([{ depth: 30, bevel: 0 }]);
    const two = nested([{ depth: 10, bevel: 0 }, { depth: 20, bevel: 0 }]);

    expect(apart(one, two)).toBeLessThan(1e-9);
    expect(two.flat().length).toBe(one.flat().length);
  });

  test('two rounds two deep are one round of their sum', () => {
    // The whole of the nesting: an inner scope publishes what its fold came
    // to, so the outer adds its own amount to a sum and rounds the corner
    // once. See PLAN-bevel's step 5.
    const one = nested([{ depth: 0, bevel: 30 }]);
    const two = nested([{ depth: 0, bevel: 10 }, { depth: 0, bevel: 20 }]);

    expect(apart(one, two)).toBeLessThan(1e-9);
    expect(two.flat().length).toBe(one.flat().length);
  });

  test('a depth and a round at each scope come to the same as both at one', () => {
    const one = nested([{ depth: 30, bevel: 30 }]);
    const two = nested([{ depth: 10, bevel: 10 }, { depth: 20, bevel: 20 }]);

    expect(apart(one, two)).toBeLessThan(1e-9);
    expect(two.flat().length).toBe(one.flat().length);
  });
});
