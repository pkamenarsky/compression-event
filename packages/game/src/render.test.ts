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
import { WallOptions } from './walls';
import { Point } from './world';

const OPTIONS: WallOptions = {
  scale: 1 / 25,
  wallHeight: 7,
  wallColor: 0xffffff,
  lineColor: 0x000000,
  fillColor: 0x000000,
  fillHeight: -0.005,
};

/**
 * The fill's triangle corners, back in the two axes the ground has.
 *
 * Straight off the vertices, because that is where the triangulation is: the
 * fill is unindexed and a vertex is a corner of one triangle, three to a
 * triangle in order. The shader takes `position` to world units; this is the
 * plane it is authored in.
 */
function laid(points: readonly Point[][]): Point[] {
  const it = still([], points.map(p => ({ points: p })), OPTIONS);
  const p = it.fill.geometry.getAttribute('position');
  const out: Point[] = [];

  for (let i = 0; i < p.count; i++) out.push({ x: p.getX(i), y: p.getZ(i) });

  it.dispose();

  return out;
}

/** The other two corners a vertex carries, which is what lets the fill clip
 * itself against the near plane. See `NEARCLIP`. */
function sides(points: readonly Point[][]): { own: Point, a: Point, b: Point }[] {
  const it = still([], points.map(p => ({ points: p })), OPTIONS);
  const g = it.fill.geometry;
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

    expect(it.fill.position.y).toBeCloseTo(OPTIONS.fillHeight, 9);
    it.dispose();
  });

  test('is triangulated, concave or not', () => {
    // An L, which no fan from one vertex covers.
    const ell = [
      { x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 20 },
      { x: 20, y: 20 }, { x: 20, y: 60 }, { x: 0, y: 60 },
    ];

    const at = laid([ell]);

    // Six corners come to four triangles, which a fan from any one vertex
    // could not do — and every vertex of them is inside the L.
    expect(at.length).toEqual(4 * 3);

    for (const p of at) {
      expect(p.x <= 20 + 1e-3 || p.y <= 20 + 1e-3).toBe(true);
    }
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

  test('and a level with none of them still draws its walls', () => {
    const it = still(
      [{ points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }], corner: [true, true, true] }],
      [],
      OPTIONS,
    );

    expect(it.fill.geometry.getAttribute('position').count).toEqual(0);
    expect(it.walls.geometry.getAttribute('position').count).toBeGreaterThan(0);

    it.dispose();
  });
});
