// -----------------------------------------------------------------------------
// The boundary as it stands
//
// The other half of `walls.ts`, and much the smaller one: the outline is
// already known, so a vertex is a position and the shader has nothing to work
// out. What matters is that it is the *same* wall as the morph draws — same
// topology out of `extrude`, same fragment shader — so that crossing between
// the two shows nothing.
//
// This is what the editor draws while anyone is editing. The boundary at the
// version on screen is something the editor already has, maintained
// incrementally by `worldset` for the 2D canvas, so it costs a rebuild of these
// buffers and nothing else. No bake, and no waiting for one: baking is for
// moving between versions, and standing still at one is not that.
// -----------------------------------------------------------------------------

import * as THREE from 'three';
import {
  Extent,
  Run,
  Source,
  WallOptions,
  covering,
  extrude,
  laidShader,
  materials,
  stencilled,
} from './walls';
import { Floor, Point } from './world';

/** A floor's rings as this holds them: indices into `mine`, outline first. */
interface Rings {
  outer: number[]
  holes: number[][]
}

const vertexShader = /* glsl */ `
  uniform float uScale;
  uniform float uWallHeight;

  attribute float aHeight;
  attribute float aOpacity;

  varying vec3 vWorldPosition;
  varying float vHeightFrac;
  varying float vOpacity;

  void main() {
    // Every point of the boundary is one the CSG actually produced, so nothing
    // here is part way into existence. What a point can be is not a corner: see
    // \`turns\`, which is what decided this.
    vOpacity = aOpacity;

    // The position attribute holds the outline point in editor units, in x
    // and z; the height is a flag rather than a coordinate, so that one point
    // of the outline serves both ends of its wall.
    vWorldPosition = vec3(position.x * uScale, aHeight * uWallHeight, position.z * uScale);
    vHeightFrac = aHeight;

    gl_Position = projectionMatrix * viewMatrix * vec4(vWorldPosition, 1.0);
  }
`;

/**
 * The level as it stands, in editor units: walls on a set of open boundary
 * runs, and the authored floors filled flat underneath them.
 *
 * Both, and out of one array of points, because that is what makes this the
 * same drawing as the morph rather than a second one that resembles it. A span
 * carries walls and floors in one buffer and gates them by stretch; this
 * carries them in one array and cuts them with the same `extrude` and the same
 * `fan`. The two must agree exactly at a version boundary — see the header of
 * `walls.ts` — and agreeing is easier when there is nothing to agree about.
 *
 * The runs arrive with the corner question already answered, for the same
 * reason: the morph is handed that answer through the bake. See `Run`.
 *
 * The floors arrive as the set already resolved — outlines with the holes cut
 * in them — because a still is handed a version rather than a span. The morph
 * has the same set in pieces and stitches them back; here there is nothing to
 * stitch, and the two agree because they are the same set either way.
 */
export function still(
  runs: readonly Run[],
  floors: readonly Floor[],
  options: WallOptions,
): Source {
  const points: Point[] = [];
  const spans = [];
  const rings: Rings[] = [];

  for (const run of runs) {
    spans.push({ first: points.length, count: run.points.length });
    points.push(...run.points);
  }

  // A point per corner of every floor, fanned below. The morph's fill has the
  // same layout and is fanned the same way — see `fanning` there, which is this
  // over a span.
  //
  // The rings arrive sorted into outlines and holes, and nothing here needs
  // them to be: a hole is wound against its outline and counts against it, and
  // that is all a hole has ever been. See the header of `walls.ts`.
  const mine: number[] = [];

  const laid = (ring: readonly Point[]): number[] => {
    const out: number[] = [];

    for (const p of ring) {
      out.push(mine.length);
      mine.push(points.length);
      points.push(p);
    }

    return out;
  };

  for (const floor of floors) {
    if (floor.points.length < 3) continue;

    rings.push({ outer: laid(floor.points), holes: (floor.holes ?? []).map(laid) });
  }

  const shape = extrude(spans);

  // Per point of the flattened outline, whether a vertical standing on it is
  // telling the truth. Decided where the boundary was computed and carried on
  // the run — see `Run` — so that the morph, which is handed the same answer
  // through the bake, draws the same verticals.
  const cornered = new Float32Array(points.length).fill(1);

  spans.forEach((span, r) => {
    for (let i = 0; i < span.count; i++) {
      if (!runs[r].corner[i]) cornered[span.first + i] = 0;
    }
  });

  const uniforms = {
    uScale: { value: options.scale },
    uWallHeight: { value: options.wallHeight },
  };

  const { wall, line, fill } = materials(vertexShader, options, uniforms, laidShader);

  const geometry = (
    point: Int32Array,
    height: Float32Array,
    vertical: Float32Array | null,
    index: Uint32Array | null,
  ): THREE.BufferGeometry => {
    const g = new THREE.BufferGeometry();
    const position = new Float32Array(point.length * 3);
    const opacity = new Float32Array(point.length);

    for (let i = 0; i < point.length; i++) {
      const p = points[point[i]];

      position[i * 3] = p.x;
      position[i * 3 + 2] = p.y;

      // Only the vertical claims a corner; the horizontals run along a wall
      // and are drawn whatever the points at their ends turn out to be.
      opacity[i] = vertical === null || vertical[i] < 0.5 ? 1 : cornered[point[i]];
    }

    g.setAttribute('position', new THREE.BufferAttribute(position, 3));
    g.setAttribute('aHeight', new THREE.BufferAttribute(height, 1));
    g.setAttribute('aOpacity', new THREE.BufferAttribute(opacity, 1));

    if (index !== null) g.setIndex(new THREE.BufferAttribute(index, 1));

    return g;
  };

  const wallGeometry = geometry(shape.wallPoint, shape.wallHeight, null, shape.index);
  const lineGeometry = geometry(shape.linePoint, shape.lineHeight, shape.lineVertical, null);

  // One triangle per edge of every ring, fanned to a shared point, and a quad
  // over the lot: a fill is counted rather than carved. See the header of
  // `walls.ts`, and `fanning` in `morph.ts`, which is this over a span.
  //
  // No index buffer, because a vertex carries the other two corners of its own
  // triangle and no two of these share a corner in the same role. See
  // `NEARCLIP`.
  const fanGeometry = ((): THREE.BufferGeometry => {
    const g = new THREE.BufferGeometry();
    const triangles: [Point, Point, Point][] = [];

    // Anything the fill already holds will do for the apex — the count does not
    // depend on it — and the first point keeps the cones inside the bounds the
    // cover is cut to.
    const apex = points[mine[0]] ?? { x: 0, y: 0 };

    for (const ring of rings) {
      for (const loop of [ring.outer, ...ring.holes]) {
        // Closed, and wound as the set means it: a hole runs the other way and
        // counts the other way, which is the whole of what makes it a hole.
        for (let i = 0; i < loop.length; i++) {
          const a = points[mine[loop[i]]], b = points[mine[loop[(i + 1) % loop.length]]];

          triangles.push([apex, a, b]);
        }
      }
    }

    const position = new Float32Array(triangles.length * 9);
    const side = [
      new Float32Array(triangles.length * 6),
      new Float32Array(triangles.length * 6),
    ];

    triangles.forEach((triangle, i) => {
      for (let k = 0; k < 3; k++) {
        const v = i * 3 + k;

        position[v * 3] = triangle[k].x;
        position[v * 3 + 2] = triangle[k].y;

        // The other two in the order they come round the triangle. Which of
        // them is which never matters: the clip asks whether one of them is in
        // front, not which.
        for (let j = 0; j < 2; j++) {
          const q = triangle[(k + 1 + j) % 3];

          side[j][v * 2] = q.x;
          side[j][v * 2 + 1] = q.y;
        }
      }
    });

    g.setAttribute('position', new THREE.BufferAttribute(position, 3));
    g.setAttribute('aSideA', new THREE.BufferAttribute(side[0], 2));
    g.setAttribute('aSideB', new THREE.BufferAttribute(side[1], 2));

    return g;
  })();

  /** How far the fill reaches, which is what the cover has to be over. Exact
   * here: a still does not move. */
  const extent = ((): Extent | null => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (const i of mine) {
      minX = Math.min(minX, points[i].x);
      maxX = Math.max(maxX, points[i].x);
      minY = Math.min(minY, points[i].y);
      maxY = Math.max(maxY, points[i].y);
    }

    return isFinite(minX) ? { minX, minY, maxX, maxY } : null;
  })();

  const coverGeometry = covering(extent);

  const walls = new THREE.Mesh(wallGeometry, wall);
  const lines = new THREE.LineSegments(lineGeometry, line);

  // The fan, counted, and the cover over it — laid the hair of clearance above
  // the ground that keeps a fill over the tiles and under the walls standing on
  // it. See `stencilled`.
  const filled = stencilled(fanGeometry, coverGeometry, fill, options.fillHeight);

  // The heights are applied in the shader, so the box `position` describes is
  // flat and a frustum test against it would drop walls that are on screen.
  walls.frustumCulled = false;
  lines.frustumCulled = false;

  return {
    walls,
    lines,
    fill: filled,

    dispose(): void {
      wallGeometry.dispose();
      lineGeometry.dispose();
      fanGeometry.dispose();
      coverGeometry.dispose();
      wall.dispose();
      line.dispose();
      fill.up.dispose();
      fill.down.dispose();
      fill.cover.dispose();
    },
  };
}
