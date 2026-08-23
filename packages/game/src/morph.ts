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
// Normals are not shipped
// -----------------------
// A wall that morphs has no fixed normal, and shipping one per end of a stretch
// and lerping it would be a third thing to keep in step. The fragment shader
// takes it from the derivatives of the world position instead, which for a flat
// quad is exact and for free.
// -----------------------------------------------------------------------------

import * as THREE from 'three';
import { BakedSpan, CROSSING, ENTRY_STRIDE, FRAME_STRIDE } from './baked';
import { bayerGLSL } from './dither';

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

/**
 * The jam build's wall shading, with its normal taken from the derivatives of
 * the world position rather than from an attribute. Two quantised lights, a
 * darkening toward the floor, and a Bayer shift on top of what the dither pass
 * will do again in screen space.
 */
const fragmentShader = /* glsl */ `
  uniform vec3 uWallColor;

  // Under GLSL 3 there is no \`gl_FragColor\` and three does not put one back,
  // so the output is declared here rather than inherited.
  layout(location = 0) out vec4 fragColor;

  varying vec3 vWorldPosition;
  varying float vHeightFrac;

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

const lineFragmentShader = /* glsl */ `
  uniform vec3 uLineColor;

  layout(location = 0) out vec4 fragColor;

  varying vec3 vWorldPosition;
  varying float vHeightFrac;

  void main() {
    fragColor = vec4(uLineColor, 1.0);
  }
`;

/** What both materials are told about the world, and what changes per frame. */
export interface MorphUniforms {
  uFrames: { value: THREE.DataTexture }
  uEntries: { value: THREE.DataTexture }
  uTime: { value: number }
  uScale: { value: number }
  uWallHeight: { value: number }
}

/** A span, ready to draw: the two meshes and the one number that moves. */
export interface Morph {
  walls: THREE.Mesh
  lines: THREE.LineSegments
  /** Where in the span, 0 at the earlier version and 1 at the later one. */
  seek(t: number): void
  dispose(): void
}

/**
 * A table as a float texture: four floats per texel, `WIDTH` texels a row, and
 * whatever height that comes to.
 *
 * Nearest everywhere and no mipmaps, because nothing is sampled — every read is
 * a `texelFetch` at an integer the buffer layout put there.
 */
function tabled(data: Float32Array, stride: number): THREE.DataTexture {
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
 * Every wall of every stretch, as attributes.
 *
 * A wall is a consecutive pair of points inside one run, extruded. Runs are
 * open — a ring of the union belongs to no single polygon and so is not kept —
 * which costs nothing here, since a wall was never more than a pair.
 *
 * The lines are the jam build's: the top and bottom of each wall, and a
 * vertical at every corner.
 */
function built(span: BakedSpan): { walls: THREE.BufferGeometry, lines: THREE.BufferGeometry } {
  const wall = fields(), line = fields();
  const index: number[] = [];

  for (const track of span.tracks) {
    for (const s of track.stretches) {
      for (const run of s.runs) {
        const last = run.first + run.count - 1;

        for (let i = run.first; i < last; i++) {
          const base = wall.count;

          emit(wall, span, i, 0, s.t0, s.t1);
          emit(wall, span, i + 1, 0, s.t0, s.t1);
          emit(wall, span, i, 1, s.t0, s.t1);
          emit(wall, span, i + 1, 1, s.t0, s.t1);

          index.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);

          emit(line, span, i, 0, s.t0, s.t1);
          emit(line, span, i + 1, 0, s.t0, s.t1);
          emit(line, span, i, 1, s.t0, s.t1);
          emit(line, span, i + 1, 1, s.t0, s.t1);
        }

        for (let i = run.first; i <= last; i++) {
          emit(line, span, i, 0, s.t0, s.t1);
          emit(line, span, i, 1, s.t0, s.t1);
        }
      }
    }
  }

  const walls = geometry(wall);

  walls.setIndex(index);

  return { walls, lines: geometry(line) };
}

interface Fields {
  count: number
  a: number[]
  b: number[]
  slot: number[]
  kind: number[]
  cross: number[]
  range: number[]
  height: number[]
}

function fields(): Fields {
  return { count: 0, a: [], b: [], slot: [], kind: [], cross: [], range: [], height: [] };
}

function emit(f: Fields, span: BakedSpan, i: number, h: number, t0: number, t1: number): void {
  f.a.push(span.pointsA[i * 2], span.pointsA[i * 2 + 1]);
  f.b.push(span.pointsB[i * 2], span.pointsB[i * 2 + 1]);
  f.slot.push(span.slots[i]);
  f.kind.push(span.kinds[i] === CROSSING ? 1 : 0);
  f.cross.push(
    span.crossings[i * 4],
    span.crossings[i * 4 + 1],
    span.crossings[i * 4 + 2],
    span.crossings[i * 4 + 3],
  );
  f.range.push(t0, t1);
  f.height.push(h);
  f.count++;
}

function geometry(f: Fields): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();

  const attr = (xs: number[], size: number): THREE.BufferAttribute =>
    new THREE.BufferAttribute(new Float32Array(xs), size);

  // Positions come out of the shader, so there is nothing here to put in
  // `position`. Something has to be, or three has no vertex count to draw.
  g.setAttribute('position', attr(new Array(f.count * 3).fill(0), 3));
  g.setAttribute('aPointA', attr(f.a, 2));
  g.setAttribute('aPointB', attr(f.b, 2));
  g.setAttribute('aSlot', attr(f.slot, 1));
  g.setAttribute('aKind', attr(f.kind, 1));
  g.setAttribute('aCross', attr(f.cross, 4));
  g.setAttribute('aRange', attr(f.range, 2));
  g.setAttribute('aHeight', attr(f.height, 1));

  return g;
}

export interface MorphOptions {
  /** World units per editor unit. */
  scale: number
  wallHeight: number
  wallColor: THREE.ColorRepresentation
  lineColor: THREE.ColorRepresentation
}

/** One span's meshes, sharing one set of uniforms so that seeking is one
 * write. */
export function morph(span: BakedSpan, options: MorphOptions): Morph {
  const uniforms: MorphUniforms = {
    uFrames: { value: tabled(span.frames, FRAME_STRIDE) },
    uEntries: { value: tabled(span.entries, ENTRY_STRIDE) },
    uTime: { value: 0 },
    uScale: { value: options.scale },
    uWallHeight: { value: options.wallHeight },
  };

  const wallMaterial = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader,
    fragmentShader,
    uniforms: { ...uniforms, uWallColor: { value: new THREE.Color(options.wallColor) } },
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });

  const lineMaterial = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader,
    fragmentShader: lineFragmentShader,
    uniforms: { ...uniforms, uLineColor: { value: new THREE.Color(options.lineColor) } },
  });

  const { walls: wallGeometry, lines: lineGeometry } = built(span);

  const walls = new THREE.Mesh(wallGeometry, wallMaterial);
  const lines = new THREE.LineSegments(lineGeometry, lineMaterial);

  // Nothing is where its `position` attribute says it is, so there is no box
  // worth testing against the frustum.
  walls.frustumCulled = false;
  lines.frustumCulled = false;

  return {
    walls,
    lines,

    seek(t: number): void {
      wallMaterial.uniforms.uTime.value = t;
      lineMaterial.uniforms.uTime.value = t;
    },

    dispose(): void {
      uniforms.uFrames.value.dispose();
      uniforms.uEntries.value.dispose();
      wallGeometry.dispose();
      lineGeometry.dispose();
      wallMaterial.dispose();
      lineMaterial.dispose();
    },
  };
}
