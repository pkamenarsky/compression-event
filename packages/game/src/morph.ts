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
import { BakedSpan, CROSSING, ENTRY_STRIDE, FRAME_STRIDE } from './baked';
import { Run, Source, WallOptions, extrude, materials } from './walls';

/** Texels across in both tables. Wide enough that a big level is a few rows,
 * narrow enough to be legal everywhere. */
const WIDTH = 512;

/**
 * How far outside its own stretch a vertex still draws.
 *
 * Adjacent stretches leave a hair of a gap where a topology event was converged
 * on, and something has to happen in it. The CPU reader takes the nearer side;
 * this lets both sides draw across it, which for a gap the bake has already
 * narrowed below 1e-4 is a doubled wall for well under a frame, and the
 * alternative is a hole.
 */
const SLACK = 1e-3;

const vertexShader = /* glsl */ `
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

  varying vec3 vWorldPosition;
  varying float vHeightFrac;

  const int WIDTH = ${WIDTH};

  vec4 fetch(sampler2D tex, int texel) {
    return texelFetch(tex, ivec2(texel % WIDTH, texel / WIDTH), 0);
  }

  /**
   * The polygon's frame: the version in flight eased from identity to itself,
   * composed onto the chain it already stood in.
   *
   * Column-major, so that \`m * vec3(p, 1.0)\` is the point placed.
   */
  mat3 frameAt(int slot, float t) {
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

  vec2 entryAt(int e, float t, float u) {
    vec4 e0 = fetch(uEntries, e * 2);
    vec4 e1 = fetch(uEntries, e * 2 + 1);

    return (frameAt(int(e1.x), t) * vec3(mix(e0.xy, e0.zw, u), 1.0)).xy;
  }

  void main() {
    float t = uTime;

    // Everything outside its own stretch collapses. One buffer, one draw, and
    // the frame's worth of it that is alive is chosen here.
    if (t < aRange.x - ${SLACK.toExponential()} || t > aRange.y + ${SLACK.toExponential()}) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    float u = aRange.y == aRange.x
      ? 0.0
      : clamp((t - aRange.x) / (aRange.y - aRange.x), 0.0, 1.0);

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

/** A span, ready to draw: the two meshes and the one number that moves. */
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

/** Every stretch of every track, one after another: a span is one buffer and
 * one draw, and which of it is alive at an instant is the shader's business. */
function spanRuns(span: BakedSpan): Run[] {
  const out: { run: Run, t0: number, t1: number }[] = [];

  for (const track of span.tracks) {
    for (const s of track.stretches) {
      for (const run of s.runs) out.push({ run, t0: s.t0, t1: s.t1 });
    }
  }

  return out.map(x => x.run);
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

  const { wall, line } = materials(vertexShader, options, uniforms);

  const shape = extrude(spanRuns(span));
  const range = ranges(span);

  const geometry = (
    point: Int32Array,
    height: Float32Array,
    index: Uint32Array | null,
  ): THREE.BufferGeometry => {
    const g = new THREE.BufferGeometry();
    const n = point.length;

    const a = new Float32Array(n * 2), b = new Float32Array(n * 2);
    const slot = new Float32Array(n), kind = new Float32Array(n);
    const cross = new Float32Array(n * 4), within = new Float32Array(n * 2);

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

    if (index !== null) g.setIndex(new THREE.BufferAttribute(index, 1));

    return g;
  };

  const wallGeometry = geometry(shape.wallPoint, shape.wallHeight, shape.index);
  const lineGeometry = geometry(shape.linePoint, shape.lineHeight, null);

  const walls = new THREE.Mesh(wallGeometry, wall);
  const lines = new THREE.LineSegments(lineGeometry, line);

  // Nothing is where its `position` attribute says it is, so there is no box
  // worth testing against the frustum.
  walls.frustumCulled = false;
  lines.frustumCulled = false;

  return {
    walls,
    lines,

    seek(t: number): void {
      wall.uniforms.uTime.value = t;
      line.uniforms.uTime.value = t;
    },

    dispose(): void {
      uniforms.uFrames.value.dispose();
      uniforms.uEntries.value.dispose();
      wallGeometry.dispose();
      lineGeometry.dispose();
      wall.dispose();
      line.dispose();
    },
  };
}
