// -----------------------------------------------------------------------------
// The floors land where they were drawn
//
// A floor is authored in the editor's x and y and drawn flat on the ground,
// where the editor's y is the world's z. That is two conventions meeting — the
// plane `THREE.Shape` builds in, and the turn that lays the mesh down — and
// getting either backwards puts the level's floors mirrored under it, which is
// the kind of thing that looks deliberate until someone walks on one.
//
// Nothing here needs a GL context: a geometry is arithmetic.
// -----------------------------------------------------------------------------

import * as THREE from 'three';
import { describe, expect, test } from 'vitest';
import { SCALE, filled } from './render';
import { Point } from './world';

/** The same turn `floors` gives the mesh, applied to a geometry's points. */
function laid(g: THREE.BufferGeometry): Point[] {
  const m = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
  const p = g.getAttribute('position');
  const out: Point[] = [];

  for (let i = 0; i < p.count; i++) {
    const v = new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i)).applyMatrix4(m);

    // Back to editor units, and to the two axes the ground has.
    out.push({ x: v.x / SCALE, y: v.z / SCALE });
  }

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
    const at = laid(filled([{ points: square }]));

    // Every corner of the square, and nothing outside it: an axis flipped
    // would put the y range at -90..-20. To four places, because a geometry
    // holds float32 and these are hundreds of editor units.
    expect(Math.min(...at.map(p => p.x))).toBeCloseTo(10, 4);
    expect(Math.max(...at.map(p => p.x))).toBeCloseTo(40, 4);
    expect(Math.min(...at.map(p => p.y))).toBeCloseTo(20, 4);
    expect(Math.max(...at.map(p => p.y))).toBeCloseTo(90, 4);
  });

  test('is triangulated, concave or not', () => {
    // An L, which no fan from one vertex covers.
    const ell = [
      { x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 20 },
      { x: 20, y: 20 }, { x: 20, y: 60 }, { x: 0, y: 60 },
    ];

    const g = filled([{ points: ell }]);

    // Six points, kept as they were, and four triangles over them — which a
    // fan from any one vertex could not do.
    expect(g.getAttribute('position').count).toEqual(6);
    expect(g.getIndex()!.count / 3).toEqual(4);

    for (const p of laid(g)) {
      expect(p.x <= 20 + 1e-3 || p.y <= 20 + 1e-3).toBe(true);
    }
  });

  test('several are one geometry', () => {
    const two = filled([{ points: square }, { points: square }]);
    const one = filled([{ points: square }]);

    expect(two.getAttribute('position').count)
      .toEqual(one.getAttribute('position').count * 2);
    expect(two.getIndex()!.count).toEqual(one.getIndex()!.count * 2);
  });
});
