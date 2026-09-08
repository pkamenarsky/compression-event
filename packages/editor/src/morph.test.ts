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
import { Point, TOLERANCE } from '@ce/game/world';
import { looped, morph, still } from '@ce/game';
import { WallOptions } from '@ce/game';
import { bakeSpan } from './bake';
import { bakedSpan, floorsAt } from './export';
import { TOP, addPolygon, editAt, resolveAt, withEdit } from './scene';
import { PolygonId, PolygonKind, VersionId, World, emptyWorld } from './types';

/**
 * A polygon kind by the short name these tests call it: a room, a pillar, a
 * floor, and a hole cut in a floor.
 *
 * The four are two questions — which set, and which way — and writing the pair
 * out at every call would bury what each test is about. See `PolygonKind`.
 */
type Named = 'level' | 'solid' | 'floor' | 'hole';

const kind = (k: Named): PolygonKind => ({
  type: k === 'floor' || k === 'hole' ? 'floor' : 'level',
  op: k === 'solid' || k === 'hole' ? 'subtract' : 'add',
});

function rect(x: number, y: number, w: number, h: number): Point[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

function drawn(...specs: [Named, Point[]][]): { world: World, ids: PolygonId[] } {
  let world = emptyWorld();
  const ids: PolygonId[] = [];

  for (const [type, points] of specs) {
    const added = addPolygon(world, kind(type), points, 0, TOP);

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

/**
 * What a fill counts with, which is the geometry of the first of the three
 * meshes it is. See `stencilled`.
 *
 * Structurally typed rather than reached for through three, which is the game
 * package's dependency and not this one's.
 */
interface Attribute {
  count: number
  getX(i: number): number
  getY(i: number): number
  getZ(i: number): number
  getW(i: number): number
}

interface Counting {
  getAttribute(name: string): Attribute
}

const fanOf = (it: { fill: { children: readonly unknown[] } }): Counting =>
  (it.fill.children[0] as { geometry: Counting }).geometry;

describe('the meshes a span builds', () => {
  test('a floor becomes triangles and no walls', () => {
    const { world, ids } = drawn(
      ['level', rect(-200, -200, 400, 400)],
      ['floor', rect(-50, -50, 100, 100)],
    );

    const span = bakedSpan(run(bakeSpan(moved(world, 1, ids[1], { x: 90, y: 30 }), 0)));
    const it = morph(span, OPTIONS);

    const point = fanOf(it).getAttribute('aOwnPoints');
    const track = span.tracks.find(t => t.fill)!;
    const ring = track.stretches[0].runs[0];

    // Three vertices a triangle and no index buffer — each carries the other
    // two corners of its own triangle, so there is nothing to share. One
    // triangle per edge, and a closed run of n + 1 points has n of them.
    expect(point.count).toEqual((ring.count - 1) * 3);

    // On the ground, under the walls standing on it — every mesh of it.
    for (const mesh of it.fill.children) {
      expect(mesh.position.y).toBeCloseTo(OPTIONS.fillHeight, 9);
    }

    // And every one of them stands on a point of that ring, never on a wall's.
    const from = new Set<string>();

    for (let i = ring.first; i < ring.first + ring.count; i++) {
      from.add(`${span.pointsA[i * 2]},${span.pointsA[i * 2 + 1]}`);
    }

    for (let i = 0; i < point.count; i++) {
      expect(from.has(`${point.getX(i)},${point.getY(i)}`)).toBe(true);
    }

    // And the two it carries alongside are corners of the same ring.
    for (const name of ['aSidePointsA', 'aSidePointsB']) {
      const side = fanOf(it).getAttribute(name);

      for (let i = 0; i < side.count; i++) {
        expect(from.has(`${side.getX(i)},${side.getY(i)}`)).toBe(true);
      }
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

    expect(fanOf(one).getAttribute('aOwnPoints').count).toEqual(0);
    expect(fanOf(two).getAttribute('aOwnPoints').count).toBeGreaterThan(0);

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
    const window = fanOf(it).getAttribute('aWindow');
    const meta = fanOf(it).getAttribute('aOwnMeta');

    for (let i = 0; i < window.count; i++) {
      // What the triangle is drawn for, which is its run's stretch.
      expect(window.getX(i)).toEqual(0);
      expect(window.getY(i)).toEqual(1);

      // And what places the corner, which is the point's own stretch.
      expect(meta.getZ(i)).toEqual(0);
      expect(meta.getW(i)).toEqual(1);
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
 * They cannot be compared vertex for vertex, and not only because one holds a
 * ring in world units and the other a stretch's two ends in the polygon's own
 * frame. They do not hold the same vertices at all: the still is handed the
 * floor set as rings, and the morph is handed its boundary as runs — one per
 * polygon, first point repeated at the end — and stitches them back at the
 * instant it draws. A square floor is four points to one of them and five to
 * the other, and both fill the same square.
 *
 * So this compares what is actually the same question: the ground the fill
 * counts. Signed, and added up over every triangle — a fan over the edges of a
 * ring counts the ring's own signed area and counts nothing else, whatever the
 * ring is shaped like, which is the whole reason a fill is drawn this way. The
 * triangles themselves are nobody's business: half of them lie outside the
 * shape and are wound against the ones inside it.
 */
describe('the standing floors and the bake fill the same ground', () => {
  /**
   * The area the triangles of a fill mesh cover.
   *
   * A still holds its points in `position`, which is x and z with the height
   * between; the morph holds a pair per point and works the height out in the
   * shader, so its near end is `aPointA`. Every one of these worlds stands
   * still across the span, so that pair is the same point twice and the
   * polygon's frame is the identity — which is what lets the two be compared
   * in the first place.
   */
  function covered(geometry: {
    getAttribute(name: string): {
      count: number
      getX(i: number): number
      getY(i: number): number
      getZ(i: number): number
    }
  }, name: string, flat: boolean): number {
    const g = geometry.getAttribute(name);
    const at = (i: number): Point => ({ x: g.getX(i), y: flat ? g.getY(i) : g.getZ(i) });

    let out = 0;

    for (let i = 0; i + 2 < g.count; i += 3) {
      const a = at(i), b = at(i + 1), c = at(i + 2);

      out += (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
    }

    return Math.abs(out) / 2;
  }

  function same(world: World): void {
    const one = still([], floorsAt(world, 0), OPTIONS);
    const two = morph(bakedSpan(run(bakeSpan(world, 0))), OPTIONS);

    const here = covered(fanOf(one), 'position', false);

    expect(here).toBeGreaterThan(0);
    expect(covered(fanOf(two), 'aOwnPoints', true)).toBeCloseTo(here, 6);

    // And on the same plane, or one draws over the other.
    expect(two.fill.children[0].position.y).toBeCloseTo(one.fill.children[0].position.y, 9);

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
 * The fill counts the ring, at every instant.
 *
 * The bug this is here for: the triangles were cut once off the near end of the
 * stretch and kept. A wall is the quad between two consecutive points and stays
 * that quad however they move, so `extrude` can be answered once — but which
 * diagonals cut a ring into triangles is a question about where the points are.
 * A concave floor whose reflex corners move ends the span with triangles lying
 * outside itself and a bite missing from the middle, which is what a vanishing
 * triangle was.
 *
 * Nothing is cut now, so nothing can be cut wrongly: the fan is one triangle
 * per *edge*, and what a fan over the edges of a ring counts is the ring's own
 * signed area, identically, wherever its points have got to. This is that
 * identity asked of the geometry the game actually draws, at instants across
 * the span — a shape it holds at is a shape nothing in the fill can be wrong
 * about.
 */
describe('the fill counts the ring at every instant', () => {
  function signed(points: readonly Point[]): number {
    let out = 0;

    for (let i = 0; i < points.length; i++) {
      const p = points[i], q = points[(i + 1) % points.length];

      out += p.x * q.y - q.x * p.y;
    }

    return out / 2;
  }

  const area = (points: readonly Point[]): number => Math.abs(signed(points));

  /**
   * How many cuts the span came out in, and how many of those a stretch
   * boundary would have called for on its own — for the test that is about the
   * split finding one the stretches did not.
   */
  function counts(world: World): void {
    const flat = bakedSpan(run(bakeSpan(world, 0)));
    const it = morph(flat, OPTIONS);

    const own = fanOf(it).getAttribute('aOwnPoints');
    const meta = fanOf(it).getAttribute('aOwnMeta');
    const window = fanOf(it).getAttribute('aWindow');

    // The rings the fan is counted against, off the span's own buffers: a run
    // of points, and the stretch it is alive for.
    const rings: { first: number, count: number, t0: number, t1: number }[] = [];

    for (const track of flat.tracks.filter(x => x.fill)) {
      for (const s of track.stretches) {
        for (const r of s.runs) {
          rings.push({ first: r.first, count: r.count, t0: s.t0, t1: s.t1 });
        }
      }
    }

    /** How far through a stretch `t` is, which is what places a point. */
    const within = (lo: number, hi: number): number =>
      hi === lo ? 0 : Math.min(Math.max((t - lo) / (hi - lo), 0), 1);

    /** A point of the span at `t`, in the frame the fan is counted in. */
    const stood = (i: number, u: number): Point => ({
      x: flat.pointsA[i * 2] + (flat.pointsB[i * 2] - flat.pointsA[i * 2]) * u,
      y: flat.pointsA[i * 2 + 1] + (flat.pointsB[i * 2 + 1] - flat.pointsA[i * 2 + 1]) * u,
    });

    /** A triangle corner as the shader places it: its own two ends, lerped by
     * how far through its own stretch it is. */
    const where = (v: number): Point => {
      const u = within(meta.getZ(v), meta.getW(v));

      return {
        x: own.getX(v) + (own.getZ(v) - own.getX(v)) * u,
        y: own.getY(v) + (own.getW(v) - own.getY(v)) * u,
      };
    };

    /** The gate the shader draws by: a window holds its start and not its end,
     * and the last one keeps both. */
    const drawn = (lo: number, hi: number): boolean => t >= lo && (t < hi || hi >= 1);

    let t = 0;

    for (let k = 0; k <= 32; k++) {
      t = k / 32;

      it.seek(t);

      // What the fan counts: every triangle it draws, signed. The cones outside
      // the shape are wound against the ones inside it and cancel.
      let count = 0;

      for (let i = 0; i + 2 < window.count; i += 3) {
        if (!drawn(window.getX(i), window.getY(i))) continue;

        count += signed([where(i), where(i + 1), where(i + 2)]);
      }

      // And what it is meant to count: the rings the live runs stitch into.
      const live = rings.filter(r => drawn(r.t0, r.t1));
      const held = new Map<number, Point>();

      for (const r of live) {
        const u = within(r.t0, r.t1);

        for (let i = 0; i < r.count; i++) held.set(r.first + i, stood(r.first + i, u));
      }

      // Whole, repeated endpoint and all: `looped` is what drops it, and
      // dropping it here would leave nothing for it to match runs by.
      const runs = live.map(r => {
        const out: number[] = [];

        for (let i = 0; i < r.count; i++) out.push(r.first + i);

        return out;
      });

      let whole = 0;

      for (const ring of looped(runs, i => held.get(i)!, TOLERANCE)) {
        whole += signed(ring.map(i => held.get(i)!));
      }

      expect(Math.abs(whole)).toBeGreaterThan(0);
      expect(count / whole).toBeCloseTo(1, 6);
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

    counts(withEdit(world, 1, ids[1], { ...edit, vertices }));
  });

  test('a floor turning and sliding under a room', () => {
    const { world, ids } = drawn(
      ['level', rect(-400, -400, 800, 800)],
      ['floor', [
        { x: 0, y: 0 }, { x: 160, y: 0 }, { x: 160, y: 40 },
        { x: 60, y: 40 }, { x: 60, y: 150 }, { x: 0, y: 150 },
      ]],
    );

    counts(moved(world, 1, ids[1], { x: 120, y: -60 }));
  });

  test('two notches trading depth, which nothing cut could follow', () => {
    // What the split in the cut-in-advance version was for, and what a count
    // does not notice. Two notches in the top edge, one deep and one shallow,
    // trading places across the span: half way through neither is deep and any
    // triangulation taken there spans the top, and at either end one notch is
    // down through those diagonals.
    const { world, ids } = drawn(
      ['level', rect(-400, -400, 800, 800)],
      ['floor', [
        { x: -200, y: -100 }, { x: 200, y: -100 }, { x: 200, y: 100 },
        { x: 100, y: 90 }, { x: 0, y: 100 }, { x: -100, y: -80 }, { x: -200, y: 100 },
      ]],
    );

    const it = resolveAt(world, 1).find(r => r.id === ids[1])!;
    const edit = editAt(world, 1, ids[1], it.erosion);
    const vertices = new Map(edit.vertices);

    vertices.set(it.corners[3].id, { x: 100, y: -80 });
    vertices.set(it.corners[5].id, { x: -100, y: 90 });

    counts(withEdit(world, 1, ids[1], { ...edit, vertices }));
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

    counts(withEdit(world, 1, ids[1], {
      ...edit,
      transform: { ...edit.transform, erosion: 30 },
    }));
  });
});
