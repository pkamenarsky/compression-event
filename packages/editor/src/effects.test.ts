import { describe, expect, test } from 'vitest';
import { Point } from '@ce/game/world';
import { shapeArea } from './geometry';
import { TOP, addPolygon, copied, csg, grouped, pasted, resolveAt, rigOf, sealing } from './scene';
import { Span, spanAt, stamp } from './bake';
import { stateAt } from './rig';
import { resolveGroup } from './resolve';
import {
  applies,
  cornersAmounted,
  edgeDeform,
  edgeRun,
  edgesInheriting,
  edgesOptioned,
  ownDeform,
  edgesBetween,
  edgesWithinBox,
  endsOf,
  switchedOff,
  switchedOn,
} from './effects';
import { Writing, erode, inSegments, move, scaled, turned, wrote } from './testing';
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

/** A `w` by `h` rectangle's area with its four corners rounded `r` deep:
 * each a quarter circle, as the opening draws it, in `segments` chords. */
function roundedRect(w: number, h: number, r: number, segments: number): number {
  const chord = Math.sin(Math.PI / (4 * segments)) * Math.cos(Math.PI / (4 * segments));

  return w * h - 4 * r * r + 4 * r * r * segments * chord;
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

  test('a pasted room comes with its effects and its edges\' own', () => {
    const { world, id } = room();
    const edge = world.polygons.get(id)!.points[0].id;
    let w = wrote(withEffects(world, id, ROUND), 0, id, round(5));

    w = { ...w, cornerEffects: new Map([[edge, { deform: { spacing: 12, pattern: 'noise' as const, seed: 7, sides: 'in' as const, jitter: 0 } }]]) };

    const after = pasted(w, 0, copied(w, 0, [id]), { x: 300, y: 0 }, TOP);
    const copy = after.ids[0];

    expect(after.world.effects.get(copy)).toEqual(ROUND);
    expect(shapeArea(shapeOf(after.world, copy))).toBeCloseTo(shapeArea(shapeOf(w, id)), 9);
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

  test('a wall made of two members\' edges is one run, its teeth centred on the whole of it', () => {
    // Two rooms along one wall, sealed and deformed as one. The wall is one
    // straight of the fold and takes one pattern, centred — step 7's one
    // default — on the wall and not on either room's edge. So the far end
    // moving moves the middle, and the teeth with it.
    const zigzag = { spacing: 20, pattern: 'zigzag' as const, seed: 0, sides: 'both' as const, jitter: 0 };
    const build = (by: number) => {
      const a = room(emptyWorld(), rect(0, 0, 200, 140));
      const b = room(a.world, rect(160, 0, 200 + by, 140));
      const g = grouped(b.world, 0, [a.id, b.id], TOP)!;

      return wrote(withEffects(sealing(g.world, g.id, true), g.id, { deform: zigzag }), 0, g.id, deform(6));
    };

    // The wall's points off its line, mirrored about its middle.
    const off = (w: World, end: number) => csg(w, 0).flat()
      .filter(p => p.y > 140 + 1e-9)
      .map(p => [p.x, end - p.x].map(x => x.toFixed(6)).sort().join());

    for (const by of [0, 40, 130]) {
      const tips = off(build(by), 360 + by);

      expect(tips.length).toBeGreaterThanOrEqual(8);
      expect(new Set(tips).size * 2).toBe(tips.length + (tips.length % 2));
    }
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

  test('a member\'s deform is laid by its own options, whether or not the scope deforms', () => {
    // An amplitude is an amount, and a scope that rounds and does not deform
    // has no pattern to lay its members' amounts by. It used to lose them
    // altogether — the member resolves eroded only, so the teeth it drew for
    // itself are not there either. Each run is laid by the options of
    // whichever member named it. See PLAN-bevel's step 3.
    const zigzag = { spacing: 20, pattern: 'zigzag' as const, seed: 0, sides: 'both' as const, jitter: 0 };
    const build = (fx: Effects) => {
      const a = room(emptyWorld(), rect(0, 0, 200, 140));
      const away = room(a.world, rect(600, 0, 60, 60));
      const w = withEffects(away.world, a.id, { deform: zigzag });
      const g = grouped(w, 0, [a.id, away.id], TOP)!;
      const sealed = withEffects(sealing(g.world, g.id, true), g.id, fx);
      const one = wrote(sealed, 0, a.id, deform(8));

      return fx.round === undefined ? one : wrote(one, 0, g.id, round(2));
    };

    // How high the teeth stand off the member's top wall.
    const off = (world: World) => Math.max(0, ...csg(world, 0).flat()
      .filter(p => p.x > 10 && p.x < 190)
      .map(p => p.y - 140));

    // Loose in a scope with no effects, the member deforms itself; under one
    // that deforms, the fold lays the same teeth. Under one that rounds they
    // are still there, their tips opened by the scope's round, which comes
    // after them: a little short of their height and no more.
    expect(off(build({}))).toBeCloseTo(8, 9);
    expect(off(build({ deform: zigzag }))).toBeCloseTo(8, 9);
    expect(off(build({ round: inSegments(8, 2) }))).toBeGreaterThan(7);
    expect(off(build({ round: inSegments(8, 2) }))).toBeLessThan(8);
  });

  test('two members deformed differently keep their own patterns under one rounding scope', () => {
    // One pattern for the whole fold would give both walls whichever member
    // came first. Each run is laid by the member whose line names it.
    const wide = { spacing: 60, pattern: 'zigzag' as const, seed: 0, sides: 'both' as const, jitter: 0 };
    const tight = { spacing: 15, pattern: 'zigzag' as const, seed: 0, sides: 'both' as const, jitter: 0 };
    const a = room(emptyWorld(), rect(0, 0, 200, 140));
    // Not on the same lines as the first: two collinear walls are one
    // straight to the naming, whichever rooms they belong to.
    const b = room(a.world, rect(400, 300, 200, 140));
    const w = withEffects(withEffects(b.world, a.id, { deform: wide }), b.id, { deform: tight });
    const g = grouped(w, 0, [a.id, b.id], TOP)!;
    // A round small enough to leave the tight teeth standing: it opens their
    // tips, coming after them, and one of ten opens them clean away.
    const sealed = withEffects(sealing(g.world, g.id, true), g.id, { round: inSegments(8, 2) });
    const world = wrote(wrote(wrote(sealed, 0, a.id, deform(8)), 0, b.id, deform(8)), 0, g.id, round(2));

    // The teeth along each room's top wall: the tips, which stand off it.
    const tips = (from: number, to: number, wall: number) => csg(world, 0).flat()
      .filter(p => p.x > from && p.x < to && p.y > wall + 4).length;

    expect(tips(10, 190, 140)).toBeGreaterThan(0);
    expect(tips(410, 590, 440)).toBeGreaterThan(tips(10, 190, 140) * 2);
  });

  test('its round is after its solids cut its level, so the corners they cut are rounded too', () => {
    const a = room(emptyWorld(), rect(0, 0, 100, 100));
    const s = addPolygon(a.world, { level: 'solid' }, rect(80, 40, 40, 20), 0, TOP);
    const g = grouped(s.world, 0, [a.id, s.id], TOP)!;
    const w = wrote(withEffects(sealing(g.world, g.id, true), g.id, { round: inSegments(8, 5) }), 0, g.id, round(5));
    const vertices = new Set(csg(w, 0).flat().map(p => `${p.x.toFixed(6)},${p.y.toFixed(6)}`));
    const has = (x: number, y: number) => vertices.has(`${x.toFixed(6)},${y.toFixed(6)}`);

    // Where the solid crosses the wall, and the room's own corners: none of
    // them a point any more, each an arc.
    expect(has(100, 40)).toBe(false);
    expect(has(100, 60)).toBe(false);
    expect(has(0, 0)).toBe(false);

    // The solid's own corners in the room turn into it, and an opening
    // leaves a corner that turns in as it is.
    expect(has(80, 40)).toBe(true);
    expect(has(80, 60)).toBe(true);

    // Six arcs of eight, the two inner corners, and the ring closed.
    expect(csg(w, 0).flat().length).toBe(6 * 9 + 2 + 1);
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

/**
 * Property 1 of PLAN-bevel, stated against the gesture that settles it: a
 * scope draws what it resolves to. Resolving a group replaces it with the
 * polygons its union comes to, carrying its timeline onto them, so the two
 * are the same world said two ways — and the outline must be the same
 * outline, ring for ring and point for point, however deep the nesting and
 * whatever each level is doing.
 *
 * It holds where a member's only effect is its erosion, which is the one of
 * the three that the fold takes first and so the one a ring can carry as an
 * erosion of its own. It does not hold where a member rounds or deforms, nor
 * where a scope does, and the reason is the same on every row: `readingAt`
 * reads its members *drawn*, so their arcs and their teeth reach the new
 * polygon as geometry — and the polygon then rounds and deforms that, arcs,
 * tooth tips and all. The scope lays each once on amounts, which is what
 * steps 1 to 5 are for; the resolve has had no such step, and wants the
 * fold's `named` written onto the ring it makes.
 *
 * What each row comes to today is recorded beside it: the point counts are
 * the size of the gap, not a tolerance to hold.
 */
describe('a scope draws what it resolves to', () => {
  const zigzag = { spacing: 25, pattern: 'zigzag' as const, seed: 1, sides: 'both' as const, jitter: 0 };

  /** A round, a deform and an erosion, any of which a thing may be without. */
  interface Kit {
    round?: number
    deform?: number
    erode?: number
  }

  const optionsOf = (k: Kit): Effects => ({
    ...(k.round === undefined ? {} : { round: inSegments(8, k.round) }),
    ...(k.deform === undefined ? {} : { deform: zigzag }),
  });
  const amountsOf = (k: Kit): Writing[] => [
    ...(k.erode === undefined ? [] : [erode(k.erode)]),
    ...(k.round === undefined ? [] : [round(k.round)]),
    ...(k.deform === undefined ? [] : [deform(k.deform)]),
  ];
  const doing = (world: World, ids: readonly Id[], k: Kit): World => {
    const amounts = amountsOf(k);

    return ids.reduce((w, id) => {
      const fx = withEffects(w, id, optionsOf(k));

      return amounts.length === 0 ? fx : wrote(fx, 0, id, ...amounts);
    }, world);
  };

  /** Two overlapping rooms sealed into a scope, and that scope sealed into
   * another with a third room. `mid` is nothing for the two-deep case. */
  function scopes(member: Kit, outer: Kit, mid?: Kit): { world: World, id: Id } {
    const a = room(emptyWorld(), rect(0, 0, 200, 140));
    const b = room(a.world, rect(160, 40, 260, 180));
    const c = room(b.world, rect(60, 150, 120, 200));
    const rooms = mid === undefined ? [a.id, b.id] : [a.id, b.id, c.id];
    const one = doing(mid === undefined ? b.world : c.world, rooms, member);

    if (mid === undefined) {
      const g = grouped(one, 0, [a.id, b.id], TOP)!;

      return { world: doing(sealing(g.world, g.id, true), [g.id], outer), id: g.id };
    }

    const g = grouped(one, 0, [a.id, b.id], TOP)!;
    const inner = doing(sealing(g.world, g.id, true), [g.id], mid);
    const h = grouped(inner, 0, [g.id, c.id], TOP)!;

    return { world: doing(sealing(h.world, h.id, true), [h.id], outer), id: h.id };
  }

  /** Each ring from its own lowest point and the rings in one order, so that
   * where an arrangement started a ring is not the difference. */
  const rings = (shape: readonly (readonly Point[])[]) => shape.map(ring => {
    const all = ring.map(p => `${p.x.toFixed(6)},${p.y.toFixed(6)}`);

    // A ring closes on its first point: the same point, not another one.
    const pts = all.filter((p, i) => p !== all[(i + 1) % all.length]);
    const first = pts.indexOf([...pts].sort()[0]);

    return [...pts.slice(first), ...pts.slice(0, first)];
  }).sort();

  const same = (world: World, id: Id) => {
    const drawn = rings(csg(world, 0));
    const out = resolveGroup(world, 0, id)!;

    // Something to compare: arcs at the corners, teeth off the walls.
    expect(drawn.flat().length).toBeGreaterThan(6);
    expect(rings(csg(out.world, 0))).toEqual(drawn);
  };

  test('members eroded, under a scope that rounds', () => {
    const { world, id } = scopes({ erode: 8 }, { round: 12 });

    same(world, id);
  });

  test('members eroded, under a scope that erodes', () => {
    const { world, id } = scopes({ erode: 8 }, { erode: 6 });

    same(world, id);
  });

  test('members eroded, three scopes deep, each eroding', () => {
    const { world, id } = scopes({ erode: 8 }, { erode: 4 }, { erode: 6 });

    same(world, id);
  });

  test('members rounded, under a scope that rounds', () => {
    const { world, id } = scopes({ round: 10 }, { round: 12 });

    same(world, id);
  });

  test('members deformed, under a scope that rounds', () => {
    const { world, id } = scopes({ deform: 6 }, { round: 12 });

    same(world, id);
  });

  test('members deformed, under a scope with no effects at all', () => {
    const { world, id } = scopes({ deform: 6 }, {});

    same(world, id);
  });

  test('members rounded, under a scope with no effects at all', () => {
    const { world, id } = scopes({ round: 10 }, {});

    same(world, id);
  });

  test('members rounded past their walls, arcs into arcs, under a plain scope', () => {
    const { world, id } = scopes({ round: 70 }, {});

    same(world, id);
  });

  test('members rounded past their walls, arcs into arcs, under a scope that rounds', () => {
    const { world, id } = scopes({ round: 70 }, { round: 12 });

    same(world, id);
  });

  test('nothing on the members, a scope rounding past its walls', () => {
    const { world, id } = scopes({}, { round: 70 });

    same(world, id);
  });

  test('members deformed, under a scope that deforms', () => {
    const { world, id } = scopes({ deform: 6 }, { deform: 6 });

    same(world, id);
  });

  test('nothing on the members, everything on the scope', () => {
    const { world, id } = scopes({}, { round: 12, deform: 6, erode: 6 });

    same(world, id);
  });

  test('members eroded, two scopes rounding', () => {
    const { world, id } = scopes({ erode: 8 }, { round: 12 }, { round: 10 });

    same(world, id);
  });

  // The reported one: a round switched on at a bevel of nought lays nothing,
  // so no fold happens and the members reach the level drawn as themselves.
  // The resolve used to ask whether the option was there rather than whether
  // anything was laid, and published amounts for a fold that never ran. See
  // `shapes`.
  test('members deformed, under a scope whose round rounds by nothing', () => {
    const { world, id } = scopes({ deform: 6 }, { round: 0 });

    same(world, id);
  });

  test('members deformed, under a scope that rounds a little', () => {
    const { world, id } = scopes({ deform: 6 }, { round: 2 });

    same(world, id);
  });

  test('two members deformed at different spacings, under a scope that rounds', () => {
    const a = room(emptyWorld(), rect(0, 0, 200, 140));
    const b = room(a.world, rect(400, 300, 200, 140));
    let w = withEffects(b.world, a.id, optionsOf({ deform: 6 }));

    w = wrote(w, 0, a.id, deform(6));
    w = withEffects(w, b.id, { deform: { ...zigzag, spacing: 40 } });
    w = wrote(w, 0, b.id, deform(10));

    const g = grouped(w, 0, [a.id, b.id], TOP)!;
    const sealed = withEffects(sealing(g.world, g.id, true), g.id, optionsOf({ round: 12 }));

    same(wrote(sealed, 0, g.id, round(12)), g.id);
  });

  test('members deformed, under a scope rounding half a wall', () => {
    const { world, id } = scopes({ deform: 6 }, { round: 60 });

    same(world, id);
  });

  test('nothing on the members, under a scope rounding past a whole wall', () => {
    const { world, id } = scopes({}, { round: 120 });

    same(world, id);
  });

  test('members deformed, under a scope rounding past a whole wall', () => {
    const { world, id } = scopes({ deform: 6 }, { round: 120 });

    same(world, id);
  });

  test('everything, everywhere', () => {
    const { world, id } = scopes(
      { round: 10, deform: 6, erode: 8 },
      { round: 12, deform: 6, erode: 4 },
      { round: 10, deform: 6, erode: 6 },
    );

    same(world, id);
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

  test('an edge\'s deform options are its own, over its polygon\'s', () => {
    // An amount adds and options do not: one set lays a run, and the nearest
    // wins. An edge is named by the corner it leaves, as its amplitude is.
    const { world, id } = room();
    const points = world.polygons.get(id)!.points;
    const w = wrote(withEffects(world, id, DEFORM), 0, id, deform(4));
    const tight = edgesOptioned(w, [points[0].id], { spacing: 5 }, REMEMBERED);

    expect(edgeDeform(tight, points[0].id)!.spacing).toBe(5);
    expect(edgeDeform(tight, points[1].id)!.spacing).toBe(DEFORM.deform!.spacing);
    expect(ownDeform(tight, points[0].id)).toBe(true);
    expect(ownDeform(tight, points[1].id)).toBe(false);

    // The bottom wall, at its own spacing of five, against the left wall at
    // the polygon's twenty.
    const teeth = (at: World, wall: (p: Point) => boolean) =>
      shapeOf(at, id)[0].filter(p => wall(p) && offRoom(p) > 1e-9).length;
    const bottom = (p: Point) => p.y < 0 && p.x > 1 && p.x < 99;
    const left = (p: Point) => p.x < 0 && p.y > 1 && p.y < 99;

    expect(teeth(w, bottom)).toBe(teeth(w, left));
    expect(teeth(tight, left)).toBe(teeth(w, left));
    expect(teeth(tight, bottom)).toBeGreaterThanOrEqual(teeth(w, bottom) * 3);

    // And dropped again, it is its polygon's edge like any other.
    expect(teeth(edgesInheriting(tight, [points[0].id]), bottom)).toBe(teeth(w, bottom));
  });

  test('an edge\'s own options reach the fold it is a member of', () => {
    // A member publishes the options each of its edges stands in, so a scope
    // that rounds and does not deform lays each run by whichever member edge
    // named it — at that edge's own spacing where it has one.
    const a = room(emptyWorld(), rect(0, 0, 200, 140));
    const away = room(a.world, rect(600, 0, 60, 60));
    const points = a.world.polygons.get(a.id)!.points;
    const w = wrote(withEffects(away.world, a.id, DEFORM), 0, a.id, deform(6));
    const g = grouped(w, 0, [a.id, away.id], TOP)!;
    const sealed = wrote(withEffects(sealing(g.world, g.id, true), g.id, { round: inSegments(8, 10) }), 0, g.id, round(10));

    // The first room's bottom wall, which is the edge leaving its first
    // corner: its teeth, and then four times as many at a fifth the spacing.
    const bottom = (at: World) => csg(at, 0).flat().filter(p => p.y < -1e-9 && p.x > 20 && p.x < 180).length;
    const tight = edgesOptioned(sealed, [points[0].id], { spacing: 5 }, REMEMBERED);

    expect(bottom(sealed)).toBeGreaterThan(0);
    expect(bottom(tight)).toBeGreaterThan(bottom(sealed) * 3);
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

/**
 * Property 1's other half: an effect laid on a scope draws what the same
 * effect laid on what that scope resolves to draws. One is a round on the
 * group; the other is the group flattened first and the round put on the ring
 * it came to. If a resolve is the same world said another way, the two cannot
 * part.
 *
 * It holds where the scope already lays something, because there the ring it
 * resolves to carries the members' teeth and arcs as *amounts*, and a round
 * put on afterwards adds its bevel to the ring's corners exactly as a scope
 * would.
 *
 * It fails where the scope lays nothing. There is no fold to take amounts
 * from — `shapes` says so, and the members reach the level drawn as
 * themselves, a tooth of one running past another's wall clipped by the union
 * rather than faded at its end — so the ring resolves with its teeth as
 * *geometry*, every tooth tip a corner of the polygon. Round that and every
 * tooth is rounded: a ring of 116 points comes to 370 where the scope's own
 * round gives 116.
 *
 * Folding whatever the amounts is the shape of the answer and is not free:
 * measured, it stops the teeth being rounded (370 points become 51) and it
 * loses the teeth at the crossings, two rows of `a scope draws what it
 * resolves to` going with them. What has to be settled first is the crossing
 * itself — whether a tooth standing where two members cross is clipped by the
 * union, as it is today, or faded at the end of its run, as a fold does it.
 * That is a question about the look, not about the code.
 */
describe('an effect on a scope, and on what it resolves to', () => {
  const zigzag = { spacing: 25, pattern: 'zigzag' as const, seed: 1, sides: 'both' as const, jitter: 0 };

  /** Two overlapping rooms, deformed, sealed into a scope that lays `bevel`. */
  const scope = (bevel: number): { world: World, id: Id } => {
    const a = room(emptyWorld(), rect(0, 0, 200, 140));
    const b = room(a.world, rect(160, 40, 260, 180));
    const one = [a.id, b.id].reduce(
      (w, id) => wrote(withEffects(w, id, { deform: zigzag }), 0, id, deform(6)),
      b.world,
    );
    const g = grouped(one, 0, [a.id, b.id], TOP)!;
    const sealed = withEffects(sealing(g.world, g.id, true), g.id, { round: inSegments(8, 40) });

    return { world: bevel === 0 ? sealed : wrote(sealed, 0, g.id, round(bevel)), id: g.id };
  };

  const rings = (shape: readonly (readonly Point[])[]) => shape.map(ring => {
    const all = ring.map(p => `${p.x.toFixed(6)},${p.y.toFixed(6)}`);
    const pts = all.filter((p, i) => p !== all[(i + 1) % all.length]);
    const first = pts.indexOf([...pts].sort()[0]);

    return [...pts.slice(first), ...pts.slice(0, first)];
  }).sort();

  /** The same round added, once to the scope and once to what the scope
   * resolves to: a bevel is an amount and amounts add, so a scope already
   * rounding `was` and rounded `by` more is a scope rounding the sum. */
  const both = (was: number, by: number) => {
    const onScope = rings(csg(scope(was + by).world, 0));
    const flat = resolveGroup(scope(was).world, 0, scope(was).id)!.world;
    const after = [...flat.polygons.keys()].reduce(
      (w, p) => wrote(withEffects(w, p, { ...w.effects.get(p), round: inSegments(8, 40) }), 0, p, round(by)),
      flat,
    );

    expect(rings(csg(after, 0))).toEqual(onScope);
  };

  test('a scope rounding a little, rounded twice as much again', () => {
    both(5, 10);
  });

  test('the same, further out', () => {
    both(10, 20);
  });

  test('and further, past what the walls have room for', () => {
    both(20, 40);
  });

  test('a scope that lays nothing, then rounded', () => {
    both(0, 40);
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

  test('two rounds two deep are one round of the larger', () => {
    // A round is an opening, and an arc already at curvature `1 / 10` is
    // untouched by an opening at twenty but for being opened again to twenty:
    // rounds compose as `round(max(a, b))`, not as their sum. Law 3 says what
    // the nesting draws, and this is that; the old summing was one particular
    // construction's. See `rounding` and PLAN-effect's laws.
    const one = nested([{ depth: 0, bevel: 20 }]);
    const two = nested([{ depth: 0, bevel: 10 }, { depth: 0, bevel: 20 }]);

    expect(apart(one, two)).toBeLessThan(1e-9);
    expect(two.flat().length).toBe(one.flat().length);
  });

  test('a depth and a round at each scope come to the depths\' sum and the larger round', () => {
    // Eroded past the inner round's own radius, a convex corner is a mitre
    // again, and the outer round lays its own arc on it.
    const one = nested([{ depth: 30, bevel: 20 }]);
    const two = nested([{ depth: 10, bevel: 10 }, { depth: 20, bevel: 20 }]);

    expect(apart(one, two)).toBeLessThan(1e-9);
    expect(two.flat().length).toBe(one.flat().length);
  });
});
