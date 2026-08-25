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
// -----------------------------------------------------------------------------

import * as THREE from 'three';
import { bayerGLSL } from './dither';
import { Point } from './world';

/** How far off straight a corner has to be to count as one, as the sine of
 * the angle it turns through. */
const TURNED = 1e-6;

/**
 * Whether the boundary actually turns at `b`.
 *
 * The CSG leaves a point wherever two edges met, and where a union runs
 * through one — two polygons overlapping, or a solid one cutting across the
 * pair — the point it leaves sits in the middle of what is now one flat wall.
 * The wall is right. The vertical standing on it is a claim that there is a
 * corner there, and there is not.
 */
export function turns(a: Point, b: Point, c: Point): boolean {
  const ux = b.x - a.x, uy = b.y - a.y;
  const vx = c.x - b.x, vy = c.y - b.y;
  const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);

  return len === 0 || Math.abs(ux * vy - uy * vx) > len * TURNED;
}

/**
 * One run of the boundary, and the polygon whose edges it came off.
 *
 * The id is not decoration. `corners` stitches runs back together at a shared
 * end, and it may only do that for runs of the same polygon — see there.
 */
export interface Run {
  id: number
  points: readonly Point[]
}

/**
 * Which points of a boundary carry a vertical, run by run and point by point.
 *
 * The question is per *point*, not per index into a run, and a run is one arc
 * with open ends: the boundary carries on past them into another run. Asked run
 * by run, an end has no neighbour to compare against and its vertical stands by
 * default, which puts a line down the middle of a flat wall wherever two runs
 * meet in a straight stretch. So the runs handed over are stitched back
 * together by their endpoints first. A point with two distinct neighbours is a
 * corner if it turns between them; anything else is a corner and keeps its
 * vertical — a T where three runs meet is a real corner, and so is a hairpin
 * that comes back the way it went.
 *
 * A run that closes on itself falls out of the same rule: `boundaryRuns` gives
 * a whole ring back with its first point repeated at the last, so both
 * neighbours across the join are in hand under one key. A dilated pillar is the
 * case that finds this — its ring comes back whole, cut at whatever point the
 * arrangement started from, which is not usually a corner.
 *
 * One polygon at a time, and that is a hard limit rather than a convenience
 * ----------------------------------------------------------------------
 * Runs stitch only to runs of the same polygon, which is why they arrive
 * carrying the id they came off. Two rooms that abut make one flat wall out of
 * two polygons' runs, and this will still stand a vertical where they meet.
 * That is not an oversight; it is the only rule the two sources of geometry can
 * both follow.
 *
 * `still` holds the whole boundary and could stitch across polygons. The morph
 * cannot: the bake cuts a track per polygon — that is what makes it cheap, see
 * `share` in `bake.ts` — so a stretch has one polygon's runs in hand and never
 * a neighbour's. And even handed them it could not match the ends, because each
 * polygon's points are kept in its own frame and a shared junction comes back
 * as two float computations of the same place rather than one number written
 * twice.
 *
 * A rule the two cannot both follow is worse than a vertical too many. The
 * editor crosses between them at the start and end of every transition, and a
 * line that appears for the length of a walk and goes away again is the flicker
 * this whole module is arranged to prevent. Widening this means giving the
 * answer to `boundaryRuns`, which is the one place that sees a polygon *and its
 * neighbours* in one frame, and which both sources already call.
 *
 * Ends are matched exactly. Within one polygon they are not two points that met
 * and agreed; they are one point written down twice, by an arrangement that
 * welded them.
 */
export function corners(runs: readonly Run[]): boolean[][] {
  const key = (id: number, p: Point) => `${id}|${p.x},${p.y}`;
  const near = new Map<string, Point[]>();

  const beside = (id: number, p: Point, q: Point | undefined) => {
    if (q === undefined) return;

    const k = key(id, p);
    const at = near.get(k);

    if (at === undefined) {
      near.set(k, [q]);
    }
    else if (!at.some(o => o.x === q.x && o.y === q.y)) {
      at.push(q);
    }
  };

  for (const run of runs) {
    for (let i = 0; i < run.points.length; i++) {
      beside(run.id, run.points[i], run.points[i - 1]);
      beside(run.id, run.points[i], run.points[i + 1]);
    }
  }

  return runs.map(run => run.points.map(p => {
    const at = near.get(key(run.id, p)) ?? [];

    return at.length !== 2 || turns(at[0], p, at[1]);
  }));
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
