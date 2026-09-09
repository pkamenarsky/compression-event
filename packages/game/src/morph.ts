// -----------------------------------------------------------------------------
// The walls, positioned by the GPU
//
// A span holds every stretch of every polygon, and only some of them are alive
// at any instant. That could be a per-frame upload, or a per-track draw call, or
// this: one static buffer holding all of it, and a vertex shader that collapses
// everything outside its own stretch's `t` range to a degenerate triangle. Time
// is then a uniform, the whole span is one draw call, and nothing is written
// after load.
//
// What the shader evaluates is `outline` from `baked.ts`, transcribed. That
// function exists to be the readable statement of it, and `export.test.ts` ties
// it back to the CSG, so the shader has something exact to be wrong against
// rather than a picture someone remembers.
//
// The tables go up as float textures rather than uniforms because a level has
// thousands of entries and uniform space is counted in hundreds. Four texels per
// frame, two per entry, `texelFetch` throughout — no filtering, no mipmaps, and
// no normalised coordinates to get half a texel wrong.
//
// The floors are the same, now
// ----------------------------
// They were the one thing left being written per frame: which diagonals cut a
// ring into triangles is a question about where its points are, and they move.
// `cutting` answers it in advance instead — every triangulation the span ever
// needs, in the same buffer, each gated by the window it is right over, which
// is the gate the stretches already had. Nothing in a span is written after
// load, and `seek` is three numbers.
//
// The same walls as the still source
// ----------------------------------
// The topology and the shading are `walls.ts`, called from here and from
// `still.ts` alike, because the editor crosses between the two every time a
// transition starts or ends and anything that differs across that crossing is a
// flicker. What is left here is the one thing that genuinely differs: where a
// vertex is.
// -----------------------------------------------------------------------------

import * as THREE from 'three';
import { BakedSpan, CROSSING, placedAt } from './baked';
import {
  Extent,
  NEARCLIP,
  Source,
  Span,
  WallOptions,
  covering,
  extrude,
  materials,
  stencilled,
} from './walls';
import { Point } from './world';

/** Texels across in both tables. Wide enough that a big level is a few rows,
 * narrow enough to be legal everywhere. */
const WIDTH = 512;

/**
 * Everything both of a span's vertex shaders are built on: the tables, the walk
 * up the chain of frames, and where one point of the bake stands at an instant.
 *
 * Built per span rather than once, because how deep the chain of groups goes is
 * a fact about the level and the walk up it is per vertex. A bounded loop is
 * unrolled and its register cost is known; `while (slot >= 0)` would be legal
 * and would leave that to the driver.
 */
const tablesFor = (depth: number): string => /* glsl */ `
  uniform sampler2D uFrames;
  uniform sampler2D uEntries;
  uniform float uTime;
  uniform float uScale;
  uniform float uWallHeight;

  varying vec3 vWorldPosition;
  varying float vHeightFrac;
  varying float vOpacity;

  const int WIDTH = ${WIDTH};

  vec4 fetch(sampler2D tex, int texel) {
    return texelFetch(tex, ivec2(texel % WIDTH, texel / WIDTH), 0);
  }

  const int DEPTH = ${depth};

  /**
   * One slot's own frame: the version in flight eased from identity to itself,
   * composed onto the chain it already stood in.
   *
   * Column-major, so that \`m * vec3(p, 1.0)\` is the point placed.
   */
  mat3 linkAt(int slot, float t) {
    int o = slot * 6;
    vec4 f0 = fetch(uFrames, o);
    vec4 f1 = fetch(uFrames, o + 1);
    vec4 f2 = fetch(uFrames, o + 2);
    vec4 f3 = fetch(uFrames, o + 3);
    vec4 f4 = fetch(uFrames, o + 4);
    vec4 f5 = fetch(uFrames, o + 5);

    float rot = f2.x * t;
    float sx = mix(1.0, f2.y, t);
    float sy = mix(1.0, f2.z, t);

    float co = cos(rot), si = sin(rot);
    float a = co * sx, b = si * sx, c = -si * sy, d = co * sy;

    // A turn goes round the layer's own fixed point; a layer that has none
    // takes its translation in a straight line, which for a translation is
    // exactly right anyway. Both ends agree either way.
    bool held = f2.w != 0.0 && t != 0.0 && t != 1.0;
    vec2 p = f3.xy;
    vec2 tr = held
      ? p - vec2(a * p.x + c * p.y, b * p.x + d * p.y)
      : f1.zw * t;

    // The chain it stood in, part way to where it stands at the far end. The
    // two are the same matrix for everything that inherits its base, which is
    // everything but a thing unchained at the far version.
    vec2 ba = mix(f0.xy, f4.xy, t);
    vec2 bc = mix(f0.zw, f4.zw, t);
    vec2 bt = mix(f1.xy, f5.xy, t);

    return mat3(
      vec3(a * ba.x + c * ba.y, b * ba.x + d * ba.y, 0.0),
      vec3(a * bc.x + c * bc.y, b * bc.x + d * bc.y, 0.0),
      vec3(a * bt.x + c * bt.y + tr.x, b * bt.x + d * bt.y + tr.y, 1.0)
    );
  }

  /**
   * The frame a vertex actually rides: its own, and every group holding it,
   * each eased on its own terms and multiplied.
   *
   * Not one composed matrix handed over ready-made. Composing two layers gives
   * a general matrix, and a general matrix lerped entrywise slews through a
   * shear — a group turning round a polygon that is turning would collapse
   * through its own middle on the way. So the chain stays a chain, exactly as
   * \`resolveAt\` walks it one stage at a time.
   */
  mat3 frameAt(int slot, float t) {
    mat3 m = linkAt(slot, t);

    for (int i = 1; i < DEPTH; i++) {
      slot = int(fetch(uFrames, slot * 6 + 3).z);

      if (slot < 0) break;

      m = linkAt(slot, t) * m;
    }

    return m;
  }

  vec2 entryAt(int e, float t, float u) {
    vec4 e0 = fetch(uEntries, e * 2);
    vec4 e1 = fetch(uEntries, e * 2 + 1);

    return (frameAt(int(e1.x), t) * vec3(mix(e0.xy, e0.zw, u), 1.0)).xy;
  }

  /** How far through its own stretch a point is at \`t\`. The stretch belongs
   * to the track rather than to the span, so it rides on the vertex. */
  float withinAt(vec2 range, float t) {
    return range.y == range.x
      ? 0.0
      : clamp((t - range.x) / (range.y - range.x), 0.0, 1.0);
  }

  /**
   * Where one point of the bake stands at \`t\`, in editor units.
   *
   * A crossing is solved from the four entries it is the meeting of, and
   * anything else — a corner of its own polygon, or a crossing that comes out
   * parallel — rides its polygon's frame. \`placedAt\` in \`baked.ts\` is this
   * on the CPU, and is what the cut is taken with.
   */
  vec2 pointAt(vec4 pts, vec4 meets, vec2 meta, float t, float u) {
    if (meta.y > 0.5) {
      vec2 p = entryAt(int(meets.x), t, u);
      vec2 q = entryAt(int(meets.y), t, u);
      vec2 r = entryAt(int(meets.z), t, u);
      vec2 w = entryAt(int(meets.w), t, u);

      vec2 du = q - p, dv = w - r;
      float det = du.x * dv.y - du.y * dv.x;

      // Parallel only at the instant an event is arriving. Give up rather than
      // divide by nothing; the corner path below is what a point the bake could
      // not place does too.
      if (det != 0.0) {
        return p + du * (((r.x - p.x) * dv.y - (r.y - p.y) * dv.x) / det);
      }
    }

    return (frameAt(int(meta.x), t) * vec3(mix(pts.xy, pts.zw, u), 1.0)).xy;
  }

  /**
   * Whether a vertex is alive at \`t\`, given the window it claims.
   *
   * Half-open, and both halves matter. A stretch holds its start and not its
   * end, so the instant two of them share belongs to the later one and to
   * nothing else; the gaps a converged event used to leave are closed in the
   * bake — see \`abutting\` — so there is no instant without an owner either.
   * The ends abut exactly, and without this rule both sides claim the instant
   * they share and a frame landing on one draws the topology from either side
   * of the event at once.
   *
   * A frame lands on one far more often than it looks. The bake cuts by
   * halving, so its boundaries are dyadic, and a clock at a steady rate lands
   * on dyadic instants all the time — an ease-out cubes them and they are
   * dyadic still, pulled in where the cuts are densest. One frame of a doubled
   * wall, which is exactly how a stray vertical reads.
   *
   * The last window keeps its end: nothing follows it to take \`t\` on.
   */
  bool aliveAt(vec2 window, float t) {
    return t >= window.x && (t < window.y || window.y >= 1.0);
  }

  /** Somewhere no triangle of it can land, for a vertex with nothing to draw. */
  const vec4 NOWHERE = vec4(2.0, 2.0, 2.0, 1.0);
`

/**
 * The walls and the lines: one point, its own stretch, and a height that is a
 * flag rather than a coordinate.
 */
const shaderFor = (depth: number): string => /* glsl */ `
  ${tablesFor(depth)}

  attribute vec2 aPointA;
  attribute vec2 aPointB;
  attribute float aSlot;
  attribute float aKind;
  attribute vec4 aCross;
  attribute vec2 aRange;
  attribute float aHeight;
  /** How solid this point is at each end of the stretch, and whether the line
   * standing on it is the vertical that can be wrong about it. */
  attribute vec3 aFade;

  void main() {
    float t = uTime;

    // Everything outside its own stretch collapses. One buffer, one draw, and
    // the frame's worth of it that is alive is chosen here.
    if (!aliveAt(aRange, t)) {
      gl_Position = NOWHERE;
      return;
    }

    float u = withinAt(aRange, t);

    // The horizontals along a wall are drawn whatever their ends turn out to
    // be; only the vertical claims there is a corner here.
    vOpacity = aFade.z > 0.5 ? mix(aFade.x, aFade.y, u) : 1.0;

    vec2 at = pointAt(vec4(aPointA, aPointB), aCross, vec2(aSlot, aKind), t, u);

    vWorldPosition = vec3(at.x * uScale, aHeight * uWallHeight, at.y * uScale);
    vHeightFrac = aHeight;

    gl_Position = projectionMatrix * viewMatrix * vec4(vWorldPosition, 1.0);
  }
`;

/**
 * The floors: a triangle of the fan at a time, each corner carrying the other
 * two.
 *
 * Three corners rather than one because of the near plane — see `NEARCLIP` in
 * `walls.ts`. The other two are solved only when this one turns out to be
 * behind the camera, which is a handful of vertices on the frames it happens at
 * all and none on any other.
 *
 * The window a corner claims is its run's stretch, and so is what places it.
 * There is nothing else for a fill vertex to be gated by now: the fan is the
 * ring's own edges and it is right for as long as the ring is there. See the
 * header of `walls.ts` on filling by counting.
 */
const fillShaderFor = (depth: number): string => /* glsl */ `
  ${tablesFor(depth)}

  ${NEARCLIP}

  /** This corner: the two ends of its stretch, the entries it crosses, and
   * \`(slot, kind, t0, t1)\`. */
  attribute vec4 aOwnPoints;
  attribute vec4 aOwnCross;
  attribute vec4 aOwnMeta;

  /** The triangle's other two corners, the same three ways over. */
  attribute vec4 aSidePointsA;
  attribute vec4 aSideCrossA;
  attribute vec4 aSideMetaA;
  attribute vec4 aSidePointsB;
  attribute vec4 aSideCrossB;
  attribute vec4 aSideMetaB;

  /** What the whole triangle is alive for, which is its run's stretch. */
  attribute vec2 aWindow;

  /**
   * One corner of the triangle, in world units.
   *
   * Through \`modelMatrix\`, which for a fill is the hair of clearance that
   * keeps it over the ground tiles and under the walls standing on them. The
   * walls take \`viewMatrix\` alone because they are at the origin and have
   * nothing for a model matrix to say; the fill is the one thing that is
   * placed, and it is placed here rather than in spite of the shader.
   */
  vec3 cornerAt(vec4 pts, vec4 meets, vec4 meta, float t) {
    vec2 at = pointAt(pts, meets, meta.xy, t, withinAt(meta.zw, t));

    return (modelMatrix * vec4(at.x * uScale, 0.0, at.y * uScale, 1.0)).xyz;
  }

  void main() {
    float t = uTime;

    if (!aliveAt(aWindow, t)) {
      gl_Position = NOWHERE;
      return;
    }

    // The fill is flat and unlit: nothing shades it, and nothing about it is
    // ever part way into existence.
    vHeightFrac = 0.0;
    vOpacity = 1.0;

    vec3 own = cornerAt(aOwnPoints, aOwnCross, aOwnMeta, t);

    // The other two are solved only when this corner is behind the eye, which
    // is the only case in which it can move at all — a handful of vertices on
    // the frames it happens on, and none on any other.
    if (behindNear(own, viewMatrix, projectionMatrix)) {
      own = nearClipped(
        own,
        cornerAt(aSidePointsA, aSideCrossA, aSideMetaA, t),
        cornerAt(aSidePointsB, aSideCrossB, aSideMetaB, t),
        viewMatrix,
        projectionMatrix
      );
    }

    vWorldPosition = own;

    gl_Position = projectionMatrix * viewMatrix * vec4(own, 1.0);
  }
`;

/** What both materials are told about the world, and what changes per frame. */
export interface MorphUniforms extends Record<string, { value: unknown }> {
  uFrames: { value: THREE.DataTexture }
  uEntries: { value: THREE.DataTexture }
  uTime: { value: number }
  uScale: { value: number }
  uWallHeight: { value: number }
}

/** A span, ready to draw: the meshes and the one number that moves. */
export interface Morph extends Source {
  /** Where in the span, 0 at the earlier version and 1 at the later one. */
  seek(t: number): void
}

/**
 * A table as a float texture: four floats per texel, `WIDTH` texels a row, and
 * whatever height that comes to.
 *
 * Nearest everywhere and no mipmaps, because nothing is sampled — every read is
 * a `texelFetch` at an integer the buffer layout put there.
 */
function tabled(data: Float32Array): THREE.DataTexture {
  const texels = Math.max(1, Math.ceil(data.length / 4));
  const height = Math.max(1, Math.ceil(texels / WIDTH));
  const padded = new Float32Array(WIDTH * height * 4);

  padded.set(data);

  const tex = new THREE.DataTexture(padded, WIDTH, height, THREE.RGBAFormat, THREE.FloatType);

  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;

  return tex;
}

/**
 * Every stretch of every wall track, one after another: a span is one buffer
 * and one draw of each kind, and which of it is alive at an instant is the
 * shader's business.
 *
 * The floors are not in here. What is built on them is not answered once — see
 * `fills` — so they are gathered as the vertices that cut needs instead.
 */
function walling(span: BakedSpan): Span[] {
  const out: Span[] = [];

  for (const track of span.tracks) {
    if (track.fill) continue;

    for (const s of track.stretches) out.push(...s.runs);
  }

  return out;
}

/**
 * The floor vertices, and which run each belongs to.
 *
 * A vertex per point of every fill run, in run order, and the runs as lists of
 * indices into those vertices — renumbered from zero, so what the cut hands
 * back indexes the fill's own buffer rather than the span's points. `points`
 * maps back the other way, which is what reads the span.
 *
 * Its own function because what the runs are cut into is answered separately
 * from what they are — see `cutting` — and because a test that stitched its own
 * would be checking something other than what is drawn.
 */
export function fills(span: BakedSpan): {
  points: number[]
  runs: number[][]
  holes: number[][]
} {
  const points: number[] = [];
  const runs: number[][] = [];
  const holes: number[][] = [];

  for (const track of span.tracks) {
    if (!track.fill) continue;

    for (const s of track.stretches) {
      for (const run of s.runs) {
        const ring: number[] = [];

        for (let i = 0; i < run.count; i++) {
          ring.push(points.length);
          points.push(run.first + i);
        }

        (track.hole ? holes : runs).push(ring);
      }
    }
  }

  return { points, runs, holes };
}

// -----------------------------------------------------------------------------
// The floors, fanned
//
// A wall is the quad between two consecutive points and stays that quad however
// they move, so `extrude` is answered once and the shader does the rest. Which
// diagonals cut a ring into triangles is not like that: it is a question about
// where the points *are*, and they move. So the fill used to be recut every
// frame — the one thing in a span that was.
//
// It is not asked any more. The fill is drawn by counting rather than by
// carving — see the header of `walls.ts` — and what the count needs is one
// triangle per *edge* of the ring, fanned to a shared point. An edge is a fact
// about the run, not about where its points happen to be, so the fan is as
// static as `extrude` is and for exactly the same reason.
//
// The shared point is a point of the fill, any one of them. Which one changes
// nothing about the count and only decides how far the cones reach, so it is
// the first, which keeps them inside the ring's own bounds and so inside the
// cover.
// -----------------------------------------------------------------------------

/** The stretch each point belongs to, so a vertex can be told whether it is
 * alive at the instant being drawn. */
export function ranges(span: BakedSpan): Float32Array {
  const out = new Float32Array(span.slots.length * 2);

  for (const track of span.tracks) {
    for (const s of track.stretches) {
      for (const run of s.runs) {
        for (let i = run.first; i < run.first + run.count; i++) {
          out[i * 2] = s.t0;
          out[i * 2 + 1] = s.t1;
        }
      }
    }
  }

  return out;
}

/**
 * The fill's buffer: one triangle per edge of every floor run, fanned to the
 * first point of the first of them.
 *
 * Unindexed, which is the one thing that looks like waste here and is the whole
 * point. A vertex has to carry the *other two corners of its triangle* — see
 * `NEARCLIP` in `walls.ts` — and no two of these triangles share a corner in
 * the same role, so there is nothing for an index buffer to share.
 *
 * Six vec4s of that is the two others, and they are only ever read on a vertex
 * that turns out to be behind the eye.
 */
function fanning(
  span: BakedSpan,
  mine: readonly number[],
  where: readonly number[][],
  range: Float32Array,
): THREE.BufferGeometry {
  const triangles: [number, number, number][] = [];

  // The apex, shared by every cone. Anything the fill already holds will do —
  // the count does not depend on it — and the first point keeps the cones
  // inside the bounds the cover is cut to.
  const apex = 0;

  for (const run of where) {
    for (let i = 0; i + 1 < run.length; i++) triangles.push([apex, run[i], run[i + 1]]);
  }

  const n = triangles.length * 3;

  const window = new Float32Array(n * 2);
  const points = [new Float32Array(n * 4), new Float32Array(n * 4), new Float32Array(n * 4)];
  const crossings = [new Float32Array(n * 4), new Float32Array(n * 4), new Float32Array(n * 4)];
  const meta = [new Float32Array(n * 4), new Float32Array(n * 4), new Float32Array(n * 4)];

  /** One corner written into one of the three slots a vertex has: where it is
   * at each end of its own stretch, what it crosses, and which stretch. */
  const corner = (slot: number, v: number, i: number): void => {
    const p = mine[i];

    points[slot][v * 4] = span.pointsA[p * 2];
    points[slot][v * 4 + 1] = span.pointsA[p * 2 + 1];
    points[slot][v * 4 + 2] = span.pointsB[p * 2];
    points[slot][v * 4 + 3] = span.pointsB[p * 2 + 1];

    for (let j = 0; j < 4; j++) crossings[slot][v * 4 + j] = span.crossings[p * 4 + j];

    meta[slot][v * 4] = span.slots[p];
    meta[slot][v * 4 + 1] = span.kinds[p] === CROSSING ? 1 : 0;
    meta[slot][v * 4 + 2] = range[p * 2];
    meta[slot][v * 4 + 3] = range[p * 2 + 1];
  };

  let v = 0;

  for (const triangle of triangles) {
    // The stretch of the edge, which is the run's. The apex is placed by its
    // own stretch wherever it came from, and where it is does not matter.
    const edge = mine[triangle[1]];

    for (let k = 0; k < 3; k++) {
      window[v * 2] = range[edge * 2];
      window[v * 2 + 1] = range[edge * 2 + 1];

      // Each corner in turn as the vertex's own, the other two after it in the
      // order they came round the triangle.
      corner(0, v, triangle[k]);
      corner(1, v, triangle[(k + 1) % 3]);
      corner(2, v, triangle[(k + 2) % 3]);

      v++;
    }
  }

  const g = new THREE.BufferGeometry();

  // Positions come out of the shader, so there is nothing to put in
  // `position`. Something has to be, or three has no vertex count to draw.
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('aWindow', new THREE.BufferAttribute(window, 2));
  g.setAttribute('aOwnPoints', new THREE.BufferAttribute(points[0], 4));
  g.setAttribute('aOwnCross', new THREE.BufferAttribute(crossings[0], 4));
  g.setAttribute('aOwnMeta', new THREE.BufferAttribute(meta[0], 4));
  g.setAttribute('aSidePointsA', new THREE.BufferAttribute(points[1], 4));
  g.setAttribute('aSideCrossA', new THREE.BufferAttribute(crossings[1], 4));
  g.setAttribute('aSideMetaA', new THREE.BufferAttribute(meta[1], 4));
  g.setAttribute('aSidePointsB', new THREE.BufferAttribute(points[2], 4));
  g.setAttribute('aSideCrossB', new THREE.BufferAttribute(crossings[2], 4));
  g.setAttribute('aSideMetaB', new THREE.BufferAttribute(meta[2], 4));

  return g;
}

/** How many instants the fill's reach is measured over. The cones sweep between
 * the apex and the ring and both of them move; this is a bound on where they
 * ever go, not a place they are. */
const REACH = 33;

/**
 * How far the fan ever reaches, over the whole span, in editor units.
 *
 * The cover has to be over every pixel the count was written to, or a fragment
 * marked and never covered is one left in the buffer for whatever draws next.
 * Sampled rather than reasoned about: a point rides a frame through a rotation
 * and its extreme is not at either end of the stretch.
 */
export function reach(
  span: BakedSpan,
  mine: readonly number[],
  range: Float32Array,
): Extent | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (let k = 0; k < REACH; k++) {
    const t = k / (REACH - 1);

    for (const p of mine) {
      const a = range[p * 2], b = range[p * 2 + 1];
      const u = b === a ? 0 : Math.min(Math.max((t - a) / (b - a), 0), 1);
      const q = placedAt(span, p, t, u);

      minX = Math.min(minX, q.x);
      maxX = Math.max(maxX, q.x);
      minY = Math.min(minY, q.y);
      maxY = Math.max(maxY, q.y);
    }
  }

  return isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/** One span's meshes, sharing one set of uniforms so that seeking is one
 * write. */
export function morph(span: BakedSpan, options: WallOptions): Morph {
  const uniforms: MorphUniforms = {
    uFrames: { value: tabled(span.frames) },
    uEntries: { value: tabled(span.entries) },
    uTime: { value: 0 },
    uScale: { value: options.scale },
    uWallHeight: { value: options.wallHeight },
  };

  const { wall, line, fill } = materials(
    shaderFor(span.depth),
    options,
    uniforms,
    fillShaderFor(span.depth),
  );

  const shape = extrude(walling(span));
  const range = ranges(span);

  const geometry = (
    point: Int32Array,
    height: Float32Array,
    vertical: Float32Array | null,
    index: Uint32Array | null,
  ): THREE.BufferGeometry => {
    const g = new THREE.BufferGeometry();
    const n = point.length;

    const a = new Float32Array(n * 2), b = new Float32Array(n * 2);
    const slot = new Float32Array(n), kind = new Float32Array(n);
    const cross = new Float32Array(n * 4), within = new Float32Array(n * 2);
    const fade = new Float32Array(n * 3);

    for (let i = 0; i < n; i++) {
      const p = point[i];

      a[i * 2] = span.pointsA[p * 2];
      a[i * 2 + 1] = span.pointsA[p * 2 + 1];
      b[i * 2] = span.pointsB[p * 2];
      b[i * 2 + 1] = span.pointsB[p * 2 + 1];
      slot[i] = span.slots[p];
      kind[i] = span.kinds[p] === CROSSING ? 1 : 0;

      for (let j = 0; j < 4; j++) cross[i * 4 + j] = span.crossings[p * 4 + j];

      within[i * 2] = range[p * 2];
      within[i * 2 + 1] = range[p * 2 + 1];

      fade[i * 3] = span.opacityA[p];
      fade[i * 3 + 1] = span.opacityB[p];
      fade[i * 3 + 2] = vertical === null ? 0 : vertical[i];
    }

    // Positions come out of the shader, so there is nothing to put in
    // `position`. Something has to be, or three has no vertex count to draw.
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('aPointA', new THREE.BufferAttribute(a, 2));
    g.setAttribute('aPointB', new THREE.BufferAttribute(b, 2));
    g.setAttribute('aSlot', new THREE.BufferAttribute(slot, 1));
    g.setAttribute('aKind', new THREE.BufferAttribute(kind, 1));
    g.setAttribute('aCross', new THREE.BufferAttribute(cross, 4));
    g.setAttribute('aRange', new THREE.BufferAttribute(within, 2));
    g.setAttribute('aHeight', new THREE.BufferAttribute(height, 1));
    g.setAttribute('aFade', new THREE.BufferAttribute(fade, 3));

    if (index !== null) g.setIndex(new THREE.BufferAttribute(index, 1));

    return g;
  };

  const { points: mine, runs: where, holes: cut } = fills(span);

  const wallGeometry = geometry(shape.wallPoint, shape.wallHeight, null, shape.index);
  const lineGeometry = geometry(shape.linePoint, shape.lineHeight, shape.lineVertical, null);
  const fanGeometry = fanning(span, mine, where, range);

  // Nothing to take out of ground no floor laid: with no floors there is no
  // mark for a hole's count to stand in, and the whole set is empty anyway.
  const holeGeometry = where.length === 0 || cut.length === 0
    ? null
    : fanning(span, mine, cut, range);

  const coverGeometry = covering(where.length === 0 ? null : reach(span, mine, range));

  const walls = new THREE.Mesh(wallGeometry, wall);
  const lines = new THREE.LineSegments(lineGeometry, line);

  // The fan, counted, and the cover over it — laid the hair of clearance above
  // the ground that keeps a fill over the tiles and under the walls standing on
  // them. See `stencilled`.
  const floors = stencilled(fanGeometry, holeGeometry, coverGeometry, fill, options.fillHeight);

  // Nothing is where its `position` attribute says it is, so there is no box
  // worth testing against the frustum.
  walls.frustumCulled = false;
  lines.frustumCulled = false;

  return {
    walls,
    lines,
    fill: floors,

    // Every buffer in the span is written at load and never again: the walls
    // are positioned by the shader and the floors were cut in advance, each cut
    // gated by the window it is right over. Seeking is three numbers.
    seek(to: number): void {
      // One cell, shared by every material of the span.
      uniforms.uTime.value = to;
    },

    dispose(): void {
      uniforms.uFrames.value.dispose();
      uniforms.uEntries.value.dispose();
      wallGeometry.dispose();
      lineGeometry.dispose();
      fanGeometry.dispose();
      holeGeometry?.dispose();
      coverGeometry.dispose();
      wall.dispose();
      line.dispose();
      for (const m of Object.values(fill)) m.dispose();
    },
  };
}
