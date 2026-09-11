// -----------------------------------------------------------------------------
// The sky
//
// Something over the level, in one bit: white on black and nothing between.
// Any of several, in `SKIES`, which `;` and `'` walk in the game:
//
// - **night** — stars, a faint nebula along a band, the whole of it wheeling
//   slowly about a tilted pole while the nebula works on itself.
//
// The pole is every sky's: `d` in the shader is the direction turned with it,
// `seen` the direction as it is, and a sky picks whichever it wants to stand
// still or move.
//
// Adding one is a name in `SKIES` and a GLSL function of the same name,
// `float name(vec3 seen, vec3 d, float px, float t)`, returning the density
// there. The dispatch in `main` is written off the list.
//
// Two halves, like the shadows:
//
// - **the dome**, in the scene: a sphere around the camera, drawn first and
//   behind everything, which writes the sky's *density* as its colour — 1 for
//   a star, a fraction for anything fainter, 0 for nothing — and the sky's
//   mark.
// - **the stage**, in the screen pass: where the mark is, the density against
//   the 8x8 threshold, after the warp, in the pixels it is seen in. Anything
//   faint comes out as a scatter of dots, and nothing the quantise does to the
//   rest of the picture reaches it.
//
// The dome follows the camera and never turns with it, so the sky is at
// infinity: walking changes nothing about it, looking round changes what of it
// is seen. Below the horizon it is black — the ground stops somewhere, and
// past it is nothing.
//
// Anything meant to be a line or a dot is sized in pixels rather than in sky,
// so it stays a line or a dot however wide the view: `px` in the shader is a
// pixel's width in the direction's own terms.
// -----------------------------------------------------------------------------

import * as THREE from 'three';
import type { RenderConfig } from './config';
import type { Stage } from './screen';
import { outputsGLSL } from './target';

/** The skies in the order `;` and `'` walk them. Each is also the name of its
 * function in the shader, which numbers them from zero. */
export const SKIES = [
  'night',
] as const;

export type Sky = typeof SKIES[number];

/** Well inside the camera's far plane, and nothing is drawn against it. */
const RADIUS = 50;

/** Cells across a face of the cube the stars are laid out on. */
const CELLS = 72;

const vertexShader = /* glsl */ `
  varying vec3 vDir;

  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform int uKind;
  uniform float uTime;
  uniform float uStars;
  uniform float uWeight;
  uniform float uTwinkle;

  varying vec3 vDir;

  ${outputsGLSL}

  const float TAU = 6.28318;
  const float CELLS = ${CELLS.toFixed(1)};
  const vec3 POLE = normalize(vec3(0.35, 1.0, 0.2));
  const vec3 BAND = normalize(vec3(0.8, 0.25, -0.55));

  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }

  vec3 hash33(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx);
  }

  float noise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);

    f = f * f * (3.0 - 2.0 * f);

    return mix(
      mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x),
          mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x),
          mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y),
      f.z);
  }

  float fbm(vec3 p) {
    float sum = 0.0;
    float amp = 0.5;

    for (int i = 0; i < 4; i++) {
      sum += amp * noise(p);
      p = p * 2.03 + 17.1;
      amp *= 0.5;
    }

    return sum;
  }

  // Rodrigues: v about the unit axis k by a.
  vec3 turn(vec3 v, vec3 k, float a) {
    float c = cos(a), s = sin(a);

    return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
  }

  // Which face of a cube d goes through, and where on it: 0 to 1 across.
  // \`scale\` is how much of the face one unit of direction is at d.
  vec2 cubed(vec3 d, out float face, out float scale) {
    vec3 a = abs(d);
    vec2 uv;
    float major;

    if (a.x >= a.y && a.x >= a.z) {
      face = sign(d.x);
      uv = d.yz;
      major = a.x;
    }
    else if (a.y >= a.z) {
      face = 2.0 + sign(d.y);
      uv = d.xz;
      major = a.y;
    }
    else {
      face = 4.0 + sign(d.z);
      uv = d.xy;
      major = a.z;
    }

    scale = 0.5 / major;

    return uv / major * 0.5 + 0.5;
  }

  // 1 where a star is, 0 elsewhere: a cell of a grid on each face of a cube,
  // a star somewhere inside the cell and well clear of its edges, lit where
  // the pixel is within a pixel or so of it.
  float star(vec3 d, float px, float t) {
    float face, scale;
    vec2 p = cubed(d, face, scale) * CELLS;
    vec2 cell = floor(p);
    vec3 h = hash33(vec3(cell, face * 37.0));

    if (h.x > uStars) return 0.0;

    // Most are a dot; a few are bigger.
    float r = mix(0.7, 1.7, pow(h.y, 8.0));

    // Some of them breathe, each at its own pace.
    float phase = hash13(vec3(cell, face) + 11.0) * TAU;
    float rate = 0.4 + 1.6 * h.z;
    r *= 1.0 - uTwinkle * step(0.6, h.z) * (0.5 + 0.5 * sin(t * rate + phase));

    vec2 at = cell + 0.25 + 0.5 * h.yz;

    return step(length(p - at), r * px * CELLS * scale);
  }

  // ── night ──

  float night(vec3 seen, vec3 d, float px, float t) {
    vec3 drift = vec3(0.0, t * 0.011, t * 0.007);
    vec3 q = vec3(fbm(d * 1.7 + drift), fbm(d * 1.7 + drift + 5.2), fbm(d * 1.7 - drift + 9.7));
    float n = fbm(d * 2.6 + q * 1.8 - drift * 0.5);

    float across = dot(d, BAND);
    float band = exp(-across * across / 0.09);
    float nebula = smoothstep(0.42, 0.78, n) * mix(0.25, 1.0, band);

    return max(uWeight * nebula, star(d, px, t));
  }

  void main() {
    vec3 seen = normalize(vDir);
    vec3 d = turn(seen, POLE, uTime * 0.006);

    float px = length(fwidth(seen)) * 0.7071;
    float above = smoothstep(-0.02, 0.2, seen.y);

    float density = 0.0;

    ${SKIES.map((k, i) => `if (uKind == ${i}) density = ${k}(seen, d, px, uTime);`).join('\n    ')}

    fragColor = vec4(vec3(clamp(density, 0.0, 1.0) * above), 1.0);
    marks = skyMark();
  }
`;

export interface Dome {
  readonly mesh: THREE.Mesh
  configure(config: RenderConfig): void
  /** Brought round to where it should be at `now`, in seconds, and put about
   * `camera`. */
  follow(camera: THREE.Camera, now: number): void
  dispose(): void
}

export function sky(): Dome {
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader,
    fragmentShader,
    uniforms: {
      uKind: { value: 0 },
      uTime: { value: 0 },
      uStars: { value: 0 },
      uWeight: { value: 0 },
      uTwinkle: { value: 0 },
    },
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(RADIUS, 32, 16), material);

  mesh.name = 'sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;

  /** The sky's own clock, which runs at `drift` times the real one — kept
   * rather than worked out from `now`, so turning `drift` does not jump it. */
  let time = 0;
  let last: number | null = null;
  let drift = 1;

  return {
    mesh,

    configure({ sky: s }: RenderConfig): void {
      mesh.visible = s.on;
      drift = s.drift;
      material.uniforms.uKind.value = Math.max(SKIES.indexOf(s.kind), 0);
      material.uniforms.uStars.value = s.stars;
      material.uniforms.uWeight.value = s.weight;
      material.uniforms.uTwinkle.value = s.twinkle;
    },

    follow(camera: THREE.Camera, now: number): void {
      // A tab left in the background comes back where it left off.
      if (last !== null) time += Math.min(now - last, 0.1) * drift;

      last = now;
      material.uniforms.uTime.value = time;
      camera.getWorldPosition(mesh.position);
    },

    dispose(): void {
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}

/**
 * The screen pass's half: where the sky is, its density against the 8x8
 * threshold, and nothing else. Goes after `quantise`, whose threshold it
 * shares; everything before it has already left the sky as it was.
 */
export const skyStage: Stage = {
  glsl: /* glsl */ `
    uniform vec3 uStarsColor;
    uniform vec3 uSpaceColor;

    vec3 skied(Texel t, vec3 color, vec2 pixel) {
      if (t.sky < 0.5) return color;

      float threshold = texture2D(uBayer, pixel / 8.0).r;

      // Half a step up, so that no density is unlit everywhere and full
      // density is lit everywhere.
      return mix(uSpaceColor, uStarsColor, step(threshold + 1.0 / 128.0, t.rgb.r));
    }
  `,
  uniforms: () => ({ uStarsColor: { value: new THREE.Color() }, uSpaceColor: { value: new THREE.Color() } }),

  apply(u, { palette: p }): void {
    u.uStarsColor.value.set(p.stars);
    u.uSpaceColor.value.set(p.space);
  },
};
