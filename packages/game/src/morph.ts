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
// The same walls as the still source
// ----------------------------------
// The topology and the shading are `walls.ts`, called from here and from
// `still.ts` alike, because the editor crosses between the two every time a
// transition starts or ends and anything that differs across that crossing is a
// flicker. What is left here is the one thing that genuinely differs: where a
// vertex is.
// -----------------------------------------------------------------------------

import * as THREE from 'three';
import { BakedSpan, CROSSING } from './baked';
import { Source, Span, WallOptions, extrude, fan, materials } from './walls';

/** Texels across in both tables. Wide enough that a big level is a few rows,
 * narrow enough to be legal everywhere. */
const WIDTH = 512;

/**
 * Built per span rather than once, because how deep the chain of groups goes is
 * a fact about the level and the walk up it is per vertex. A bounded loop is
 * unrolled and its register cost is known; `while (slot >= 0)` would be legal
 * and would leave that to the driver.
 */
const shaderFor = (depth: number): string => /* glsl */ `
  uniform sampler2D uFrames;
  uniform sampler2D uEntries;
  uniform float uTime;
  uniform float uScale;
  uniform float uWallHeight;

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
    int o = slot * 4;
    vec4 f0 = fetch(uFrames, o);
    vec4 f1 = fetch(uFrames, o + 1);
    vec4 f2 = fetch(uFrames, o + 2);
    vec4 f3 = fetch(uFrames, o + 3);

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

    vec2 ba = f0.xy, bc = f0.zw, bt = f1.xy;

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
      slot = int(fetch(uFrames, slot * 4 + 3).z);

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

  void main() {
    float t = uTime;

    // Everything outside its own stretch collapses. One buffer, one draw, and
    // the frame's worth of it that is alive is chosen here.
    //
    // Half-open, and both halves matter. A stretch holds its start and not its
    // end, so the instant two of them share belongs to the later one and to
    // nothing else; the gaps a converged event used to leave are closed in the
    // bake — see \`abutting\` — so there is no instant without an owner either.
    // The ends abut exactly, and without this rule both sides claim the instant
    // they share and a frame landing on one draws the topology from either side
    // of the event at once.
    //
    // A frame lands on one far more often than it looks. The bake cuts by
    // halving, so its boundaries are dyadic, and a clock at a steady rate lands
    // on dyadic instants all the time — an ease-out cubes them and they are
    // dyadic still, pulled in where the cuts are densest. One frame of a
    // doubled wall, which is exactly how a stray vertical reads.
    //
    // The last stretch keeps its end: nothing follows it to take \`t\` on.
    if (t < aRange.x || (t >= aRange.y && aRange.y < 1.0)) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    float u = aRange.y == aRange.x
      ? 0.0
      : clamp((t - aRange.x) / (aRange.y - aRange.x), 0.0, 1.0);

    // The horizontals along a wall are drawn whatever their ends turn out to
    // be; only the vertical claims there is a corner here.
    vOpacity = aFade.z > 0.5 ? mix(aFade.x, aFade.y, u) : 1.0;

    bool solved = false;
    vec2 at = vec2(0.0);

    if (aKind > 0.5) {
      vec2 p = entryAt(int(aCross.x), t, u);
      vec2 q = entryAt(int(aCross.y), t, u);
      vec2 r = entryAt(int(aCross.z), t, u);
      vec2 w = entryAt(int(aCross.w), t, u);

      vec2 du = q - p, dv = w - r;
      float det = du.x * dv.y - du.y * dv.x;

      // Parallel only at the instant an event is arriving. Give up rather than
      // divide by nothing; the corner path below is what a point the bake could
      // not place does too.
      if (det != 0.0) {
        at = p + du * (((r.x - p.x) * dv.y - (r.y - p.y) * dv.x) / det);
        solved = true;
      }
    }

    if (!solved) {
      at = (frameAt(int(aSlot), t) * vec3(mix(aPointA, aPointB, u), 1.0)).xy;
    }

    vWorldPosition = vec3(at.x * uScale, aHeight * uWallHeight, at.y * uScale);
    vHeightFrac = aHeight;

    gl_Position = projectionMatrix * viewMatrix * vec4(vWorldPosition, 1.0);
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
 * Every stretch of every track, one after another, split by what is built on
 * it: a span is one buffer and one draw of each kind, and which of it is alive
 * at an instant is the shader's business.
 */
function spanRuns(span: BakedSpan): { walls: Span[], fills: Span[] } {
  const walls: Span[] = [], fills: Span[] = [];

  for (const track of span.tracks) {
    for (const s of track.stretches) {
      for (const run of s.runs) (track.fill ? fills : walls).push(run);
    }
  }

  return { walls, fills };
}

/** The stretch each point belongs to, so a vertex can be told whether it is
 * alive at the instant being drawn. */
function ranges(span: BakedSpan): Float32Array {
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

  const { wall, line, fill } = materials(shaderFor(span.depth), options, uniforms);

  const runs = spanRuns(span);
  const shape = extrude(runs.walls);
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

  // Off the near end's points, in the polygon's own frame — an affine frame
  // takes triangles to triangles, so which end and which frame the cut is
  // measured in makes no difference to it.
  const face = fan(runs.fills, i => ({ x: span.pointsA[i * 2], y: span.pointsA[i * 2 + 1] }));

  const wallGeometry = geometry(shape.wallPoint, shape.wallHeight, null, shape.index);
  const lineGeometry = geometry(shape.linePoint, shape.lineHeight, shape.lineVertical, null);
  const fillGeometry = geometry(face, new Float32Array(face.length), null, null);

  const walls = new THREE.Mesh(wallGeometry, wall);
  const lines = new THREE.LineSegments(lineGeometry, line);
  const floors = new THREE.Mesh(fillGeometry, fill);

  // The shader puts the fill on the ground plane; this is the hair of clearance
  // that keeps it over the tiles and under the walls standing on them.
  floors.position.y = options.fillHeight;

  // Nothing is where its `position` attribute says it is, so there is no box
  // worth testing against the frustum.
  walls.frustumCulled = false;
  lines.frustumCulled = false;
  floors.frustumCulled = false;

  return {
    walls,
    lines,
    fill: floors,

    seek(t: number): void {
      wall.uniforms.uTime.value = t;
      line.uniforms.uTime.value = t;
      fill.uniforms.uTime.value = t;
    },

    dispose(): void {
      uniforms.uFrames.value.dispose();
      uniforms.uEntries.value.dispose();
      wallGeometry.dispose();
      lineGeometry.dispose();
      fillGeometry.dispose();
      wall.dispose();
      line.dispose();
      fill.dispose();
    },
  };
}
