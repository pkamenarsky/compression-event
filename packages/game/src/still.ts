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
  Contour,
  NEARCLIP,
  Run,
  Source,
  VARYINGS,
  WallOptions,
  extrude,
  fan,
  materials,
} from './walls';
import { Floor, Point } from './world';

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
 * The floors, which need one thing the walls do not: what triangle a vertex is
 * a corner of.
 *
 * The near plane, and nothing else — see `NEARCLIP` in `walls.ts`. A still is
 * as exposed to it as a span is, and for the same reason: the fill is the one
 * surface whose every vertex sits at one height. The two others ride along as
 * attributes, which is what the fill being unindexed here is for.
 */
const fillShader = /* glsl */ `
  uniform float uScale;

  /** The triangle's other two corners, in the same editor units \`position\`
   * holds this one in. */
  attribute vec2 aSideA;
  attribute vec2 aSideB;

  ${VARYINGS}

  ${NEARCLIP}

  /** A corner on the ground plane, in world units. */
  vec3 laid(vec2 at) {
    return vec3(at.x * uScale, 0.0, at.y * uScale);
  }

  void main() {
    // Flat, unlit, and never part way into existence.
    vHeightFrac = 0.0;
    vOpacity = 1.0;

    vec3 own = laid(position.xz);

    // The other two matter only when this corner is behind the eye.
    if (behindNear(own, viewMatrix, projectionMatrix)) {
      own = nearClipped(own, laid(aSideA), laid(aSideB), viewMatrix, projectionMatrix);
    }

    vWorldPosition = own;

    gl_Position = projectionMatrix * viewMatrix * vec4(own, 1.0);
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
  const rings: Contour[] = [];

  for (const run of runs) {
    spans.push({ first: points.length, count: run.points.length });
    points.push(...run.points);
  }

  // A point per corner of every floor, cut into triangles below. The morph's
  // fill has the same layout and cuts the same way — see `cutting` there, which
  // is this over a span's worth of instants rather than one. See `fan`.
  //
  // The rings come already sorted into outlines and holes, which is the one
  // thing the still has and the morph has to work out: what the still is handed
  // is the resolved set, and the morph is handed its boundary in pieces.
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
  const face = fan(rings, i => points[mine[i]]);

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

  const { wall, line, fill } = materials(vertexShader, options, uniforms, fillShader);

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

  // A triangle at a time and no index buffer: a vertex carries the other two
  // corners of its own triangle, and a point shared by two triangles is a
  // corner of two different ones, so there is nothing an index could share.
  // See `fillShader`.
  const fillGeometry = ((): THREE.BufferGeometry => {
    const g = new THREE.BufferGeometry();
    const position = new Float32Array(face.length * 3);
    const side = [new Float32Array(face.length * 2), new Float32Array(face.length * 2)];

    for (let i = 0; i + 2 < face.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = i + k;
        const own = points[mine[face[v]]];

        position[v * 3] = own.x;
        position[v * 3 + 2] = own.y;

        // The other two in the order they come round the triangle. Which of
        // them is which never matters: the clip asks whether one of them is in
        // front, not which.
        for (let j = 0; j < 2; j++) {
          const q = points[mine[face[i + (k + 1 + j) % 3]]];

          side[j][v * 2] = q.x;
          side[j][v * 2 + 1] = q.y;
        }
      }
    }

    g.setAttribute('position', new THREE.BufferAttribute(position, 3));
    g.setAttribute('aSideA', new THREE.BufferAttribute(side[0], 2));
    g.setAttribute('aSideB', new THREE.BufferAttribute(side[1], 2));

    return g;
  })();

  const walls = new THREE.Mesh(wallGeometry, wall);
  const lines = new THREE.LineSegments(lineGeometry, line);
  const filled = new THREE.Mesh(fillGeometry, fill);

  // The shader puts the fill on the ground plane; this is the hair of clearance
  // that keeps it over the tiles and under the walls standing on it.
  filled.position.y = options.fillHeight;

  // The heights are applied in the shader, so the box `position` describes is
  // flat and a frustum test against it would drop walls that are on screen.
  walls.frustumCulled = false;
  lines.frustumCulled = false;
  filled.frustumCulled = false;

  return {
    walls,
    lines,
    fill: filled,

    dispose(): void {
      wallGeometry.dispose();
      lineGeometry.dispose();
      fillGeometry.dispose();
      wall.dispose();
      line.dispose();
      fill.dispose();
    },
  };
}
