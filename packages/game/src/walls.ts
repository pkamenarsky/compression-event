// -----------------------------------------------------------------------------
// What a wall is, whichever way it is positioned
//
// There are two sources of geometry — the boundary as it stands right now, and
// the boundary in flight between two versions — and they have to be the same
// walls. Not similar: the same. The editor crosses between them every time a
// transition starts or ends, and anything that differs across that crossing
// reads as a flicker in the one place a viewer is paying most attention.
//
// So the topology and the shading live here and both sources call them. What is
// left to differ is the one thing that genuinely does: where a vertex is. The
// still one reads it off an attribute; the morph one rebuilds it from the frame
// and entry tables at an instant. See `still.ts` and `morph.ts`.
//
// Anything neither of them can work out alike is worked out for them, upstream,
// and arrives as data. Whether there is a corner at a point is the one of
// those: it is a question about a polygon *and its neighbours*, `still` holds
// the whole boundary and the morph holds one polygon's cut of it, and the two
// would answer differently every time two rooms abut. So the CSG answers it
// once and it rides in on the run. See `Run`, and `cornering` in the editor's
// `geometry.ts`.
// -----------------------------------------------------------------------------

import * as THREE from 'three';
import { bayerGLSL } from './dither';
import { Point } from './world';

/**
 * One run of the boundary, with the corner question already answered.
 *
 * `corner[i]` says whether the boundary actually turns at `points[i]`, which is
 * whether the vertical the extrusion stands there is telling the truth. The CSG
 * leaves a point wherever two edges met, and where the set runs straight
 * through one — two rooms overlapping, a solid cutting across the pair, two
 * rooms abutting so that one flat wall is made of two polygons' runs — the
 * point it leaves sits in the middle of what is now one flat wall. The wall is
 * right; a line drawn down the middle of it is not.
 *
 * Answered upstream rather than here, and that is the whole point: the question
 * is about a polygon *and its neighbours*, and the only place that ever sees
 * both is where the boundary is computed. See `cornering` in the editor's
 * `geometry.ts`. Asked here it could only be answered from the runs in hand,
 * and the two sources do not hold the same ones — `still` gets the whole
 * boundary and the morph gets one polygon's cut of it — so the two would
 * disagree at every junction between two polygons, and the disagreement would
 * show as a line flickering on at the start of every transition and off at the
 * end. See the header above.
 */
export interface Run {
  points: readonly Point[]
  corner: readonly boolean[]
}

/** A stretch of consecutive points in whatever flat array of them the caller
 * holds. Open — a ring of the union belongs to no one polygon, and a wall was
 * never more than a consecutive pair. */
export interface Span {
  first: number
  count: number
}

/**
 * The wall topology of a set of runs, as indices back into their points.
 *
 * Four vertices and two triangles per consecutive pair for the walls; the top
 * and bottom of each one, and a vertical at every corner, for the lines. Which
 * is the jam build's, and is why the level reads as drawn rather than as
 * shaded.
 *
 * Indices rather than positions, because the two sources disagree about what a
 * position is and agree exactly about this.
 */
export interface Extruded {
  /** Per wall vertex: which point of the outline it stands on. */
  wallPoint: Int32Array
  /** Per wall vertex: 0 on the floor, 1 at the top. */
  wallHeight: Float32Array
  linePoint: Int32Array
  lineHeight: Float32Array
  /**
   * Per line vertex: 1 for the vertical at a corner, 0 for the top and bottom
   * of a wall.
   *
   * Only the vertical is a claim that there is a corner there, so only it can
   * be wrong about one. The horizontals run along a wall and are drawn whatever
   * the points at their ends turn out to be.
   */
  lineVertical: Float32Array
  index: Uint32Array
}

export function extrude(spans: Iterable<Span>): Extruded {
  const wallPoint: number[] = [], wallHeight: number[] = [];
  const linePoint: number[] = [], lineHeight: number[] = [], lineVertical: number[] = [];
  const index: number[] = [];

  const wall = (point: number, height: number): void => {
    wallPoint.push(point);
    wallHeight.push(height);
  };

  const line = (point: number, height: number, vertical: number): void => {
    linePoint.push(point);
    lineHeight.push(height);
    lineVertical.push(vertical);
  };

  for (const span of spans) {
    const last = span.first + span.count - 1;

    for (let i = span.first; i < last; i++) {
      const base = wallPoint.length;

      wall(i, 0);
      wall(i + 1, 0);
      wall(i, 1);
      wall(i + 1, 1);

      index.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);

      line(i, 0, 0);
      line(i + 1, 0, 0);
      line(i, 1, 0);
      line(i + 1, 1, 0);
    }

    for (let i = span.first; i <= last; i++) {
      line(i, 0, 1);
      line(i, 1, 1);
    }
  }

  return {
    wallPoint: new Int32Array(wallPoint),
    wallHeight: new Float32Array(wallHeight),
    linePoint: new Int32Array(linePoint),
    lineHeight: new Float32Array(lineHeight),
    lineVertical: new Float32Array(lineVertical),
    index: new Uint32Array(index),
  };
}

// -----------------------------------------------------------------------------
// Shading
//
// The jam build's `retroWallShader`, with its normal taken from the derivatives
// of the world position rather than from an attribute. A morphing wall has no
// fixed normal to ship, and shipping one per end of a stretch and lerping it
// would be a third thing to keep in step with the other two. For a flat quad
// the derivative is exact and it is free.
// -----------------------------------------------------------------------------

/** What both vertex shaders promise the fragment shader. */
export const VARYINGS = /* glsl */ `
  varying vec3 vWorldPosition;
  varying float vHeightFrac;
  varying float vOpacity;
`;

export const wallFragment = /* glsl */ `
  uniform vec3 uWallColor;

  ${VARYINGS}

  // Under GLSL 3 there is no \`gl_FragColor\` and three does not put one back,
  // so the output is declared here rather than inherited.
  layout(location = 0) out vec4 fragColor;

  ${bayerGLSL}

  void main() {
    vec3 n = normalize(cross(dFdx(vWorldPosition), dFdy(vWorldPosition)));
    if (!gl_FrontFacing) n = -n;

    vec3 key = normalize(vec3(0.5, 0.8, 0.3));
    vec3 fill = normalize(vec3(-0.3, 0.4, -0.6));

    float light = max(dot(n, key), 0.0) * 0.7 + max(dot(n, fill), 0.0) * 0.3;

    light = light * 0.6 + 0.4;
    light *= mix(0.7, 1.0, vHeightFrac);

    vec3 color = uWallColor * light + (bayerDither(gl_FragCoord.xy) - 0.5) * 1.2;

    fragColor = vec4(color, 1.0);
  }
`;

export const lineFragment = /* glsl */ `
  uniform vec3 uLineColor;

  ${VARYINGS}

  layout(location = 0) out vec4 fragColor;

  void main() {
    // A vertical standing at a corner that is not there yet is not drawn at
    // all, and fades in as the corner emerges. Everything else is opaque.
    if (vOpacity < 0.02) discard;

    fragColor = vec4(uLineColor, vOpacity);
  }
`;

export interface WallOptions {
  /** World units per editor unit. */
  scale: number
  wallHeight: number
  wallColor: THREE.ColorRepresentation
  lineColor: THREE.ColorRepresentation
}

/** The pair of materials a source draws with: its own vertex shader, the
 * shared fragment ones, and whatever uniforms it needs on top of the colours. */
export function materials(
  vertexShader: string,
  options: WallOptions,
  uniforms: Record<string, { value: unknown }>,
): { wall: THREE.ShaderMaterial, line: THREE.ShaderMaterial } {
  const wall = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader,
    fragmentShader: wallFragment,
    uniforms: { ...uniforms, uWallColor: { value: new THREE.Color(options.wallColor) } },
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });

  const line = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader,
    fragmentShader: lineFragment,
    uniforms: { ...uniforms, uLineColor: { value: new THREE.Color(options.lineColor) } },

    // A fading vertical is the only thing that is ever part way there, and it
    // is a hairline over a wall it is about to lie flat against, so there is
    // nothing for it to sort against.
    transparent: true,
    depthWrite: false,
  });

  return { wall, line };
}

/** What both sources give the renderer: two meshes and a way to be rid of
 * them. */
export interface Source {
  walls: THREE.Mesh
  lines: THREE.LineSegments
  dispose(): void
}
