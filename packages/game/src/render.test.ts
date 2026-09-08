// -----------------------------------------------------------------------------
// The floors land where they were drawn
//
// A floor is authored in the editor's x and y and drawn flat on the ground,
// where the editor's y is the world's z. Getting that backwards puts the
// level's floors mirrored under it, which is the kind of thing that looks
// deliberate until someone walks on one.
//
// Through `still`, because that is what draws them: a still carries walls and
// floors in one array of points and cuts them with `extrude` and `fan`, the
// same two a span's buffers go through. Which is the whole reason it is one
// call — the two have to draw the same level, and there is less to disagree
// about when there is one of everything.
//
// Nothing here needs a GL context: a geometry is arithmetic.
// -----------------------------------------------------------------------------

import * as THREE from 'three';
import { describe, expect, test } from 'vitest';
import { still } from './still';
import { Source, WallOptions } from './walls';
import { Point } from './world';

const OPTIONS: WallOptions = {
  scale: 1 / 25,
  wallHeight: 7,
  wallColor: 0xffffff,
  lineColor: 0x000000,
  fillColor: 0x000000,
  fillHeight: -0.005,
};

/** The fan's triangle corners, back in the two axes the ground has.
 *
 * Off the counting mesh, which is the first of the three a fill is — see
 * `stencilled`. It is unindexed and a vertex is a corner of one triangle, three
 * to a triangle in order. The shader takes `position` to world units; this is
 * the plane it is authored in.
 */
function fanned(it: Source): Point[] {
  const p = (it.fill.children[0] as THREE.Mesh).geometry.getAttribute('position');
  const out: Point[] = [];

  for (let i = 0; i < p.count; i++) out.push({ x: p.getX(i), y: p.getZ(i) });

  return out;
}

/** The same, for a set of floors built into a still of their own. */
function laid(points: readonly Point[][]): Point[] {
  const it = still([], points.map(p => ({ points: p })), OPTIONS);
  const out = fanned(it);

  it.dispose();

  return out;
}

/** Twice the signed area of a ring, which is what the fan is counted against.
 * Sign carries the winding, and a hole's winding is what makes it a hole. */
function twice(points: readonly Point[]): number {
  let out = 0;

  for (let i = 0; i < points.length; i++) {
    const p = points[i], q = points[(i + 1) % points.length];

    out += p.x * q.y - q.x * p.y;
  }

  return out;
}

/** What the fan counts: every triangle's signed area, added up. For a fan over
 * the edges of a ring this is the ring's own signed area exactly, whatever the
 * ring does — which is the whole reason the fill is drawn this way. */
function counted(at: readonly Point[]): number {
  let out = 0;

  for (let i = 0; i + 2 < at.length; i += 3) out += twice([at[i], at[i + 1], at[i + 2]]);

  return out;
}

/** The other two corners a vertex carries, which is what lets the fill clip
 * itself against the near plane. See `NEARCLIP`. */
function sides(points: readonly Point[][]): { own: Point, a: Point, b: Point }[] {
  const it = still([], points.map(p => ({ points: p })), OPTIONS);
  const g = (it.fill.children[0] as THREE.Mesh).geometry;
  const p = g.getAttribute('position');
  const a = g.getAttribute('aSideA'), b = g.getAttribute('aSideB');
  const out = [];

  for (let i = 0; i < p.count; i++) {
    out.push({
      own: { x: p.getX(i), y: p.getZ(i) },
      a: { x: a.getX(i), y: a.getY(i) },
      b: { x: b.getX(i), y: b.getY(i) },
    });
  }

  it.dispose();

  return out;
}

describe('an authored floor', () => {
  const square = [
    { x: 10, y: 20 },
    { x: 40, y: 20 },
    { x: 40, y: 90 },
    { x: 10, y: 90 },
  ];

  test('is drawn where it was drawn, not mirrored', () => {
    const at = laid([square]);

    // Every corner of the square, and nothing outside it: an axis flipped
    // would put the y range at -90..-20.
    expect(Math.min(...at.map(p => p.x))).toBeCloseTo(10, 4);
    expect(Math.max(...at.map(p => p.x))).toBeCloseTo(40, 4);
    expect(Math.min(...at.map(p => p.y))).toBeCloseTo(20, 4);
    expect(Math.max(...at.map(p => p.y))).toBeCloseTo(90, 4);
  });

  test('and lies between the ground and the walls standing on it', () => {
    const it = still([], [{ points: square }], OPTIONS);

    // Every mesh of it, because a fill is three of them and half of one on the
    // ground plane and half a hair above it is a fill fighting itself.
    for (const mesh of it.fill.children) {
      expect(mesh.position.y).toBeCloseTo(OPTIONS.fillHeight, 9);
    }

    it.dispose();
  });

  test('is counted, concave or not', () => {
    // An L, which no fan from one vertex *covers* — and does not have to. The
    // triangles outside the shape are wound against the ones inside it and the
    // count comes out at zero there. See the header of `walls.ts`.
    const ell = [
      { x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 20 },
      { x: 20, y: 20 }, { x: 20, y: 60 }, { x: 0, y: 60 },
    ];

    const at = laid([ell]);

    // One triangle per edge, not per ear: six corners, six edges.
    expect(at.length).toEqual(6 * 3);

    // And what it counts is the L, to the last unit of it.
    expect(counted(at)).toBeCloseTo(twice(ell), 6);
  });

  test('and a hole in one counts against it', () => {
    // The whole of what a hole is, here: a ring wound the other way. Nothing
    // sorts outlines from holes for the fill any more — see `nesting`, which it
    // no longer calls.
    const outer = [
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
    ];

    const hole = [
      { x: 30, y: 30 }, { x: 30, y: 70 }, { x: 70, y: 70 }, { x: 70, y: 30 },
    ];

    const it = still([], [{ points: outer, holes: [hole] }], OPTIONS);
    const at = fanned(it);

    expect(counted(at)).toBeCloseTo(twice(outer) + twice(hole), 6);

    // Which is the square less the hole, and the two wound against each other.
    expect(Math.abs(counted(at)) / 2).toBeCloseTo(100 * 100 - 40 * 40, 6);

    it.dispose();
  });

  test('and the cover is over everything the count is written to', () => {
    // A fragment counted and never covered is one left in the buffer for
    // whatever draws next. The cover is cut to the points for that reason.
    const it = still([], [{ points: square }], OPTIONS);
    const at = fanned(it);
    const over = (it.fill.children[2] as THREE.Mesh).geometry.getAttribute('position');

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (let i = 0; i < over.count; i++) {
      minX = Math.min(minX, over.getX(i));
      maxX = Math.max(maxX, over.getX(i));
      minY = Math.min(minY, over.getZ(i));
      maxY = Math.max(maxY, over.getZ(i));
    }

    for (const p of at) {
      expect(p.x).toBeGreaterThanOrEqual(minX);
      expect(p.x).toBeLessThanOrEqual(maxX);
      expect(p.y).toBeGreaterThanOrEqual(minY);
      expect(p.y).toBeLessThanOrEqual(maxY);
    }

    it.dispose();
  });

  test('several are one mesh', () => {
    // A single flat colour that never moves independently, so there is nothing
    // a draw call each would buy — and two overlapping floors are just black
    // twice, rather than one being a hole in the other.
    expect(laid([square, square]).length).toEqual(laid([square]).length * 2);
  });

  test('and every vertex carries the other two corners of its triangle', () => {
    // What the near-plane clip is done with: a corner behind the eye walks up
    // its own edge to the plane, and the edge is the one to the corner in
    // front. See `NEARCLIP`.
    const at = sides([square]);

    expect(at.length).toEqual(laid([square]).length);

    for (let i = 0; i < at.length; i += 3) {
      const triangle = [at[i].own, at[i + 1].own, at[i + 2].own];

      // Each of the three names the other two, whichever way round.
      for (let k = 0; k < 3; k++) {
        const named = [at[i + k].a, at[i + k].b];
        const others = triangle.filter((_unused, j) => j !== k);

        for (const q of others) {
          expect(named.some(n => n.x === q.x && n.y === q.y)).toBe(true);
        }
      }
    }
  });

  test('and is counted before it is covered', () => {
    // The order is the whole mechanism: two passes that count into the stencil
    // and one that reads it. Drawn the other way round there is nothing in the
    // buffer to read and the floors are simply missing.
    const it = still([], [{ points: square }], OPTIONS);
    const [up, down, over] = it.fill.children as THREE.Mesh[];

    expect(up.renderOrder).toBeLessThan(over.renderOrder);
    expect(down.renderOrder).toBeLessThan(over.renderOrder);

    // The two counting passes are the same triangles, taken by opposite faces
    // and moving the count opposite ways. Three has no two-sided stencil ops,
    // so this is what nonzero costs.
    expect(up.geometry).toBe(down.geometry);
    expect((up.material as THREE.Material).side).not.toEqual((down.material as THREE.Material).side);

    for (const mesh of [up, down]) {
      const material = mesh.material as THREE.Material;

      expect(material.stencilWrite).toBe(true);
      expect(material.colorWrite).toBe(false);
      expect(material.depthTest).toBe(false);
      expect(material.depthWrite).toBe(false);
    }

    expect((up.material as THREE.Material).stencilZPass).toEqual(THREE.IncrementWrapStencilOp);
    expect((down.material as THREE.Material).stencilZPass).toEqual(THREE.DecrementWrapStencilOp);

    // And the cover draws where the count is not zero, and puts it back as it
    // goes — depth-failed fragments included, or a wall in front of a floor
    // would leave the buffer dirty behind it.
    const cover = over.material as THREE.Material;

    expect(cover.stencilFunc).toEqual(THREE.NotEqualStencilFunc);
    expect(cover.stencilRef).toEqual(0);
    expect(cover.colorWrite).toBe(true);
    expect(cover.depthTest).toBe(true);

    for (const op of [cover.stencilFail, cover.stencilZFail, cover.stencilZPass]) {
      expect(op).toEqual(THREE.ZeroStencilOp);
    }

    it.dispose();
  });

  test('and a level with none of them still draws its walls', () => {
    const it = still(
      [{ points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }], corner: [true, true, true] }],
      [],
      OPTIONS,
    );

    for (const mesh of it.fill.children) {
      expect((mesh as THREE.Mesh).geometry.getAttribute('position').count).toEqual(0);
    }

    expect(it.walls.geometry.getAttribute('position').count).toBeGreaterThan(0);

    it.dispose();
  });
});
