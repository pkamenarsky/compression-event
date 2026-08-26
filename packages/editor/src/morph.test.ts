// -----------------------------------------------------------------------------
// What the span's buffers build
//
// `export.test.ts` holds the buffers against the replay they were flattened
// from; this holds against them the meshes the renderer actually draws — how
// many vertices each kind claims, and which points they stand on. A floor is
// the case that needs it: it comes out of the same buffers as the walls and is
// built into something else entirely, so a track's `fill` reaching the wrong
// half is a level with holes in the ground and floors standing up as walls.
//
// Nothing here needs a GL context: a geometry is arithmetic.
// -----------------------------------------------------------------------------

import { describe, expect, test } from 'vitest';
import { Point } from '@ce/game/world';
import { morph, still } from '@ce/game';
import { WallOptions } from '@ce/game';
import { bakeSpan } from './bake';
import { bakedSpan, floorsAt } from './export';
import { TOP, addPolygon, editAt, resolveAt, withEdit } from './scene';
import { PolygonId, PolygonType, VersionId, World, emptyWorld } from './types';

function rect(x: number, y: number, w: number, h: number): Point[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

function drawn(...specs: [PolygonType, Point[]][]): { world: World, ids: PolygonId[] } {
  let world = emptyWorld();
  const ids: PolygonId[] = [];

  for (const [type, points] of specs) {
    const added = addPolygon(world, type, points, 0, TOP);

    world = added.world;
    ids.push(added.id);
  }

  return { world, ids };
}

function moved(world: World, v: VersionId, id: PolygonId, to: Point): World {
  const it = resolveAt(world, v).find(r => r.id === id)!;
  const edit = editAt(world, v, id, it.erosion);

  return withEdit(world, v, id, {
    ...edit,
    transform: { ...edit.transform, translation: to, rotation: 0.6 },
  });
}

function run<T>(g: Generator<number, T, void>): T {
  let step = g.next();

  while (!step.done) step = g.next();

  return step.value;
}

const OPTIONS: WallOptions = {
  scale: 1 / 25,
  wallHeight: 7,
  wallColor: 0xffffff,
  lineColor: 0x000000,
  fillColor: 0x000000,
  fillHeight: -0.005,
};

describe('the meshes a span builds', () => {
  test('a floor becomes triangles and no walls', () => {
    const { world, ids } = drawn(
      ['level', rect(-200, -200, 400, 400)],
      ['floor', rect(-50, -50, 100, 100)],
    );

    const span = bakedSpan(run(bakeSpan(moved(world, 1, ids[1], { x: 90, y: 30 }), 0)));
    const it = morph(span, OPTIONS);

    const point = it.fill.geometry.getAttribute('aPointA');
    const track = span.tracks.find(t => t.fill)!;
    const ring = track.stretches[0].runs[0];

    // A vertex per point of the ring, and the triangles over them in the index
    // buffer — which the morph recuts every frame. A closed ring of n + 1
    // points is n corners and cuts into n - 2 triangles.
    expect(point.count).toEqual(ring.count);
    expect(it.fill.geometry.drawRange.count).toEqual((ring.count - 1 - 2) * 3);

    // On the ground, under the walls standing on it.
    expect(it.fill.position.y).toBeCloseTo(OPTIONS.fillHeight, 9);

    // And every one of them stands on a point of that ring, never on a wall's.
    const from = new Set<string>();

    for (let i = ring.first; i < ring.first + ring.count; i++) {
      from.add(`${span.pointsA[i * 2]},${span.pointsA[i * 2 + 1]}`);
    }

    for (let i = 0; i < point.count; i++) {
      expect(from.has(`${point.getX(i)},${point.getY(i)}`)).toBe(true);
    }

    it.dispose();
  });

  test('and the walls are built from everything that is not one', () => {
    const bare = drawn(['level', rect(-200, -200, 400, 400)]);
    const withFloor = drawn(
      ['level', rect(-200, -200, 400, 400)],
      ['floor', rect(-50, -50, 100, 100)],
    );

    const one = morph(bakedSpan(run(bakeSpan(bare.world, 0))), OPTIONS);
    const two = morph(bakedSpan(run(bakeSpan(withFloor.world, 0))), OPTIONS);

    // The floor adds triangles to the fill and nothing at all to the walls.
    expect(two.walls.geometry.getAttribute('aPointA').count)
      .toEqual(one.walls.geometry.getAttribute('aPointA').count);

    expect(one.fill.geometry.drawRange.count).toEqual(0);
    expect(two.fill.geometry.drawRange.count).toBeGreaterThan(0);

    one.dispose();
    two.dispose();
  });

  test('a floor is alive for exactly its own stretch', () => {
    // The gate the shader draws by, and the reason the fill is built from
    // `stretches` alone: what a vertex claims is the span its stretch owns.
    const { world, ids } = drawn(
      ['level', rect(-200, -200, 400, 400)],
      ['floor', rect(-50, -50, 100, 100)],
    );

    const span = bakedSpan(run(bakeSpan(moved(world, 1, ids[1], { x: 90, y: 30 }), 0)));
    const it = morph(span, OPTIONS);
    const range = it.fill.geometry.getAttribute('aRange');

    for (let i = 0; i < range.count; i++) {
      expect(range.getX(i)).toEqual(0);
      expect(range.getY(i)).toEqual(1);
    }

    it.dispose();
  });
});

/**
 * The two sources of geometry have to fill the same floors.
 *
 * The walls have their own version of this — see the foot of `export.test.ts`
 * — and the reasoning is the same. `still` fills the floors the editor already
 * has; the morph fills the ones the bake cut. The view crosses between them at
 * the start and the end of every transition, so a floor either of them draws
 * alone flashes on or off at that crossing.
 *
 * They cannot be compared vertex for vertex — one holds a ring in world units
 * and the other holds a stretch's two ends in the polygon's own frame — so
 * this compares what is actually the same question: how many triangles, and
 * over what area.
 */
describe('the standing floors and the bake fill the same ground', () => {
  /** The triangles of a fill mesh, in the two axes the ground has. A still
   * holds them in `position`, which is x and z with the height between; the
   * morph holds a pair per point and works the height out in the shader. */
  function ground(mesh: { geometry: { getAttribute(name: string): {
    count: number
    getX(i: number): number
    getY(i: number): number
    getZ(i: number): number
  } } }, name: string, flat: boolean): Point[] {
    const g = mesh.geometry.getAttribute(name);
    const out: Point[] = [];

    for (let i = 0; i < g.count; i++) {
      out.push({ x: g.getX(i), y: flat ? g.getY(i) : g.getZ(i) });
    }

    return out;
  }

  function area(points: readonly Point[]): number {
    let out = 0;

    for (let i = 0; i + 2 < points.length; i += 3) {
      const a = points[i], b = points[i + 1], c = points[i + 2];

      out += Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
    }

    return out;
  }

  function same(world: World): void {
    const one = still([], floorsAt(world, 0), OPTIONS);
    const two = morph(bakedSpan(run(bakeSpan(world, 0))), OPTIONS);

    const here = ground(one.fill, 'position', false);
    const there = ground(two.fill, 'aPointA', true);

    expect(there.length).toEqual(here.length);
    expect(here.length).toBeGreaterThan(0);
    expect(area(there)).toBeCloseTo(area(here), 6);

    // And on the same plane, or one draws over the other.
    expect(two.fill.position.y).toBeCloseTo(one.fill.position.y, 9);

    one.dispose();
    two.dispose();
  }

  test('a plain floor', () => {
    same(drawn(
      ['level', rect(-200, -200, 400, 400)],
      ['floor', rect(-50, -50, 100, 100)],
    ).world);
  });

  test('two of them, one concave', () => {
    same(drawn(
      ['level', rect(-300, -300, 600, 600)],
      ['floor', rect(-200, -200, 100, 100)],
      ['floor', [
        { x: 0, y: 0 }, { x: 160, y: 0 }, { x: 160, y: 40 },
        { x: 60, y: 40 }, { x: 60, y: 150 }, { x: 0, y: 150 },
      ]],
    ).world);
  });

  test('and one eroded, which changes its ring', () => {
    const { world, ids } = drawn(
      ['level', rect(-300, -300, 600, 600)],
      ['floor', rect(-100, -100, 200, 200)],
    );

    const it = resolveAt(world, 0).find(r => r.id === ids[1])!;
    const edit = editAt(world, 0, ids[1], it.erosion);

    same(withEdit(world, 0, ids[1], {
      ...edit,
      transform: { ...edit.transform, erosion: 25 },
    }));
  });
});

/**
 * The fill covers the ring, at every instant and not only where it was cut.
 *
 * The bug this is here for: the triangles were cut once off the near end of the
 * stretch and kept. A wall is the quad between two consecutive points and stays
 * that quad however they move, so `extrude` can be answered once — but which
 * diagonals cut a ring into triangles is a question about where the points are.
 * A concave floor whose reflex corners move ends the span with triangles lying
 * outside itself and a bite missing from the middle, which is what a vanishing
 * triangle was.
 *
 * Measured as area, because that is what "covers it" means and it catches both
 * halves at once: a triangle outside the shape adds area, and one missing takes
 * it away. The ring's own area is the yardstick, off `outline` — the
 * transcription of the shader, so this is the picture the game draws.
 */
describe('the fill covers the ring at every instant', () => {
  function area(points: readonly Point[]): number {
    let out = 0;

    for (let i = 0; i < points.length; i++) {
      const p = points[i], q = points[(i + 1) % points.length];

      out += p.x * q.y - q.x * p.y;
    }

    return Math.abs(out) / 2;
  }

  function covers(world: World): void {
    const flat = bakedSpan(run(bakeSpan(world, 0)));
    const it = morph(flat, OPTIONS);

    const a = it.fill.geometry.getAttribute('aPointA');
    const b = it.fill.geometry.getAttribute('aPointB');
    const range = it.fill.geometry.getAttribute('aRange');
    const index = it.fill.geometry.getIndex()!;

    // The fill's vertices are the floors' points laid out run by run, in the
    // order the tracks come in — so the rings are found by walking the same
    // list the mesh was built from.
    const rings: { first: number, count: number }[] = [];

    let next = 0;

    for (const track of flat.tracks.filter(x => x.fill)) {
      for (const s of track.stretches) {
        for (const r of s.runs) {
          rings.push({ first: next, count: r.count });
          next += r.count;
        }
      }
    }

    /** A vertex where it stands at `t`, in the frame the cut is taken in. */
    const where = (v: number): Point => {
      const lo = range.getX(v), hi = range.getY(v);
      const u = hi === lo ? 0 : Math.min(Math.max((t - lo) / (hi - lo), 0), 1);

      return {
        x: a.getX(v) + (b.getX(v) - a.getX(v)) * u,
        y: a.getY(v) + (b.getY(v) - a.getY(v)) * u,
      };
    };

    const alive = (r: { first: number, count: number }): boolean => {
      const lo = range.getX(r.first), hi = range.getY(r.first);

      return t >= lo && (t < hi || hi >= 1);
    };

    let t = 0;

    for (let k = 0; k <= 32; k++) {
      t = k / 32;

      it.seek(t);

      // The triangles as the fill draws them, against the rings they are meant
      // to fill — both in the frame the points are kept in, which is where the
      // cut is taken.
      const corners: Point[] = [];

      for (let i = 0; i < it.fill.geometry.drawRange.count; i++) {
        corners.push(where(index.getX(i)));
      }

      let cut = 0;

      for (let i = 0; i + 2 < corners.length; i += 3) {
        cut += area([corners[i], corners[i + 1], corners[i + 2]]);
      }

      let whole = 0;

      for (const r of rings.filter(alive)) {
        const points: Point[] = [];

        // Closed, so the repeat is dropped: it is the first point again.
        for (let i = 0; i < r.count - 1; i++) points.push(where(r.first + i));

        whole += area(points);
      }

      expect(whole).toBeGreaterThan(0);
      expect(cut / whole).toBeCloseTo(1, 6);
    }

    it.dispose();
  }

  test('a concave floor whose reflex corner swings across the span', () => {
    // An arrowhead. Push the notch out past the line between its neighbours and
    // the corner stops being reflex, which is exactly the case a kept cut gets
    // wrong.
    const { world, ids } = drawn(
      ['level', rect(-400, -400, 800, 800)],
      ['floor', [
        { x: -150, y: -100 },
        { x: 0, y: -20 },
        { x: 150, y: -100 },
        { x: 0, y: 180 },
      ]],
    );

    const it = resolveAt(world, 1).find(r => r.id === ids[1])!;
    const edit = editAt(world, 1, ids[1], it.erosion);
    const vertices = new Map(edit.vertices);

    vertices.set(it.corners[1].id, { x: 0, y: 160 });

    expect(covers(withEdit(world, 1, ids[1], { ...edit, vertices }))).toBeUndefined();
  });

  test('a floor turning and sliding under a room', () => {
    const { world, ids } = drawn(
      ['level', rect(-400, -400, 800, 800)],
      ['floor', [
        { x: 0, y: 0 }, { x: 160, y: 0 }, { x: 160, y: 40 },
        { x: 60, y: 40 }, { x: 60, y: 150 }, { x: 0, y: 150 },
      ]],
    );

    covers(moved(world, 1, ids[1], { x: 120, y: -60 }));
  });

  test('and one eroding, which moves every corner at once', () => {
    const { world, ids } = drawn(
      ['level', rect(-400, -400, 800, 800)],
      ['floor', [
        { x: -120, y: -120 }, { x: 120, y: -120 }, { x: 120, y: 120 },
        { x: 20, y: 20 }, { x: -120, y: 120 },
      ]],
    );

    const it = resolveAt(world, 1).find(r => r.id === ids[1])!;
    const edit = editAt(world, 1, ids[1], it.erosion);

    covers(withEdit(world, 1, ids[1], {
      ...edit,
      transform: { ...edit.transform, erosion: 30 },
    }));
  });
});
