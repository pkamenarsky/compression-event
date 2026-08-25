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
import { Run, Source, WallOptions, extrude, materials } from './walls';
import { Point } from './world';

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
 * Walls standing on a set of open boundary runs, in editor units.
 *
 * The runs are flattened into one point array first, because `extrude` deals in
 * indices into exactly that and both sources have to hand it the same shape.
 * Each one arrives with the corner question already answered, for the same
 * reason: the morph is handed the same answer through the bake, and the two
 * have to draw the same walls. See `Run`.
 */
export function still(runs: readonly Run[], options: WallOptions): Source {
  const points: Point[] = [];
  const spans = [];

  for (const run of runs) {
    spans.push({ first: points.length, count: run.points.length });
    points.push(...run.points);
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

  const { wall, line } = materials(vertexShader, options, uniforms);

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

  const walls = new THREE.Mesh(wallGeometry, wall);
  const lines = new THREE.LineSegments(lineGeometry, line);

  // The heights are applied in the shader, so the box `position` describes is
  // flat and a frustum test against it would drop walls that are on screen.
  walls.frustumCulled = false;
  lines.frustumCulled = false;

  return {
    walls,
    lines,

    dispose(): void {
      wallGeometry.dispose();
      lineGeometry.dispose();
      wall.dispose();
      line.dispose();
    },
  };
}
