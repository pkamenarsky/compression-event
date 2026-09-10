// -----------------------------------------------------------------------------
// The sky
//
// Something over the level, in one bit: white on black and nothing between.
// Several somethings, in `SKIES`, which `;` and `'` walk in the game:
//
// - **rift** — a hole in the sky with a disk of matter going round it, and
//   the stars behind bent out of its way.
// - **lattice** — the sky is a box, and its edges show: a grid on the faces
//   of a cube round the level, a scan going up it, cells that drop out.
// - **rain** — columns of glyphs falling out of the zenith.
// - **glitch** — the stars on a display that is failing: bands tearing
//   sideways and turning over, a bar rolling up it.
// - **eye** — one, over the horizon, looking about and now and then blinking.
// - **signal** — rings going out from a point low in the sky, broken where
//   the transmission is.
//
// Behind all of them the sky wheels slowly about a tilted pole: `d` in the
// shader is the direction turned with it, `seen` the direction as it is, and
// a sky picks whichever it wants to stand still or move.
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
  'rift',
  'lattice',
  'rain',
  'glitch',
  'eye',
  'signal',
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

  // Rodrigues: v about the unit axis k by a.
  vec3 turn(vec3 v, vec3 k, float a) {
    float c = cos(a), s = sin(a);

    return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
  }

  // Where d lands on the plane touching the sphere at a, in a's own frame:
  // x across, y up. Only means anything on a's side of the sky.
  vec2 facing(vec3 d, vec3 a) {
    vec3 u = normalize(cross(vec3(0.0, 1.0, 0.0), a));
    vec3 v = cross(a, u);

    return vec2(dot(d, u), dot(d, v)) / max(dot(d, a), 1e-3);
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

  // Round the horizon, and up from it: how far round, 0 to 1, and how high,
  // in the same units.
  vec2 wrapped(vec3 d) {
    return vec2(atan(d.z, d.x) / TAU, asin(clamp(d.y, -1.0, 1.0)) / TAU);
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

  // ── rift ──

  float rift(vec3 seen, vec3 d, float px, float t) {
    const vec3 AT = normalize(vec3(-0.6, 0.55, -0.6));
    float r0 = 0.1 * (1.0 + 0.06 * sin(t * 0.21));

    float along = dot(d, AT);
    vec2 q = facing(d, AT);
    float r = length(q);

    // The stars behind, pushed out from the hole the nearer they are to it.
    vec3 bent = d;

    if (along > 0.0) {
      vec3 k = normalize(cross(AT, d) + 1e-5);
      bent = turn(d, k, r0 * r0 * 2.5 / max(r, r0));
    }

    float sky = star(bent, px, t);

    if (along <= 0.0) return sky;

    // The disk, tipped towards us and squashed by it, streaming round
    // faster the closer in.
    const float TIP = 0.28;
    float c = cos(0.35), s = sin(0.35);
    vec2 k = mat2(c, s, -s, c) * q;
    vec2 e = vec2(k.x, k.y / TIP);
    float er = length(e);
    float angle = atan(e.y, e.x);
    float swirl = noise(vec3(cos(angle - t * 0.4 / er) * 3.0, sin(angle - t * 0.4 / er) * 3.0, er * 40.0));
    float disk = smoothstep(r0 * 1.2, r0 * 1.6, er) * (1.0 - smoothstep(r0 * 1.8, r0 * 4.0, er));

    disk *= (0.35 + 0.65 * swirl) * uWeight * 1.4;

    // The back half of the disk, bent up over the hole into a ring.
    float halo = (1.0 - smoothstep(r0 * 1.3, r0 * 1.9, r)) * smoothstep(r0 * 1.05, r0 * 1.2, r);
    halo *= 0.5 + 0.5 * noise(vec3(atan(q.y, q.x) * 4.0 - t * 0.6, r * 30.0, 0.0));

    float edge = step(abs(r - r0), px * 1.2);
    float front = k.y < 0.0 ? disk : 0.0;
    float behind = k.y >= 0.0 ? disk : 0.0;

    if (r < r0) return max(front, edge);

    return max(max(max(sky * smoothstep(r0, r0 * 1.6, r), behind), max(front, uWeight * halo)), edge);
  }

  // ── lattice ──

  float lattice(vec3 seen, vec3 d, float px, float t) {
    const float N = 10.0;

    float face, scale;
    vec2 p = cubed(seen, face, scale) * N;
    vec2 cell = floor(p);
    vec2 f = abs(fract(p) - 0.5);
    float width = px * N * scale;

    float line = step(0.5 - width * 0.8, max(f.x, f.y));
    float node = step(length(0.5 - f), width * 2.2);

    // A scan going up the sky and wrapping.
    float h = wrapped(seen).y * 4.0;
    float scan = fract(t * 0.035);
    float near = exp(-pow((h - scan) * 18.0, 2.0));

    // Cells that drop out for a while and come back, showing a faint static.
    float epoch = floor(t * 0.4 + hash13(vec3(cell, face)) * 7.0);
    float gone = step(0.985, hash13(vec3(cell, face * 13.0 + epoch)));
    float dropped = gone * step(0.8, hash13(floor(seen * 300.0) + floor(t * 6.0))) * 0.6;

    float grid = max(line * mix(uWeight * 0.5, 1.0, near), node);

    return max(max(grid * (1.0 - gone), dropped), star(d, px, t) * 0.5);
  }

  // ── rain ──

  float rain(vec3 seen, vec3 d, float px, float t) {
    const float C = 220.0;
    const float ROWS = C / 4.0;

    vec2 w = wrapped(seen) * C;
    vec2 cell = floor(w);
    vec2 f = fract(w);

    vec3 h = hash33(vec3(cell.x, 7.0, 3.0));

    if (h.x > 0.35 + uWeight * 0.6) return 0.0;

    float speed = 0.04 + 0.08 * h.y;
    float len = 6.0 + 20.0 * h.z;
    float head = ROWS * 1.1 - fract(t * speed + h.x * 13.0) * ROWS * 1.5;
    float behind = cell.y - head;

    if (behind < 0.0) return 0.0;

    float glow = behind < 1.0 ? 1.0 : exp(-behind / len) * 0.85;

    // A glyph: three by five, a gap round it, and every so often another.
    vec2 sub = floor(f * vec2(4.0, 6.0));

    if (sub.x > 2.0 || sub.y > 4.0) return 0.0;

    float epoch = floor(t * (0.3 + 2.0 * hash13(vec3(cell, 5.0))));
    float bit = step(0.45, hash13(vec3(cell * 7.0 + sub, epoch)));

    // Out of the zenith, where the columns meet, rather than all at once.
    return bit * glow * (1.0 - smoothstep(0.85, 1.0, seen.y));
  }

  // ── glitch ──

  float glitch(vec3 seen, vec3 d, float px, float t) {
    const float BANDS = 48.0;

    vec2 w = wrapped(seen);
    float band = floor(w.y * BANDS * 4.0);
    float tick = floor(t * 1.5);
    vec3 h = hash33(vec3(band, tick, 1.0));

    float torn = step(h.x, 0.06 + 0.1 * uWeight);
    float shift = torn * (h.y - 0.5) * 0.5;
    vec3 moved = turn(d, vec3(0.0, 1.0, 0.0), shift);

    float sky = star(moved, px, t);

    // Snow where it tore, and some bands turned over.
    float snow = torn * step(0.75, hash13(floor(seen * 260.0) + tick)) * 0.8;

    sky = max(sky, snow);

    if (torn > 0.0 && h.z < 0.3) sky = 0.85 - sky;

    // A bar rolling up it, slowly.
    float roll = fract(t * 0.025) * 0.35 - 0.05;
    float bar = exp(-pow((w.y - roll) * 60.0, 2.0)) * 0.35 * uWeight * 2.0;

    return max(sky, bar);
  }

  // ── eye ──

  float eye(vec3 seen, vec3 d, float px, float t) {
    const vec3 AT = normalize(vec3(0.0, 0.42, 1.0));
    const float SIZE = 0.55;

    if (dot(seen, AT) <= 0.0) return 0.0;

    vec2 q = facing(seen, AT) / SIZE;
    float line = px / SIZE * 1.4;

    // A blink every nine seconds or so, a third of a second long.
    float b = fract(t / 9.3);
    float open = clamp(abs(b - 0.97) * 30.0, 0.0, 1.0);

    float lid = (1.0 - q.x * q.x) * 0.5;
    float top = lid * open;
    float outline = step(abs(q.x), 1.0) * step(abs(abs(q.y) - top), line);

    // Lashes, off the top lid, when it is open.
    if (abs(q.x) < 0.8 && q.y > top && q.y < top + 0.12 * open) {
      float slot = fract(q.x * 10.0 + 0.5);
      outline = max(outline, step(abs(slot - 0.5), line * 5.0));
    }

    if (abs(q.x) >= 1.0 || abs(q.y) >= top) return outline;

    // Looking about.
    vec2 look = vec2(sin(t * 0.13) * 0.35, sin(t * 0.071 + 1.0) * 0.08);
    vec2 i = q - look;
    float r = length(i);

    float sclera = 0.12 * uWeight;
    float iris = 0.3 + 0.5 * uWeight * noise(vec3(atan(i.y, i.x) * 6.0, r * 8.0, t * 0.05));
    float glint = step(length(i - vec2(-0.07, 0.07)), 0.045);

    float inside = r < 0.42 ? (r < 0.15 ? 0.0 : iris) : sclera;

    inside = max(inside, step(abs(r - 0.42), line));

    return max(max(inside, glint), outline);
  }

  // ── signal ──

  float signal(vec3 seen, vec3 d, float px, float t) {
    const vec3 AT = normalize(vec3(0.9, 0.12, 0.2));

    float theta = acos(clamp(dot(seen, AT), -1.0, 1.0));
    float rings = theta * 7.0 - t * 0.25;
    float ring = step(abs(fract(rings) - 0.5), px * 7.0 * 1.2);

    // Broken where the transmission is, and the breaks go out with the rings.
    vec3 k = normalize(cross(AT, seen) + 1e-5);
    float around = atan(dot(k, vec3(0.0, 1.0, 0.0)), dot(k, normalize(cross(AT, vec3(0.0, 1.0, 0.0)))));
    float broken = step(0.45, noise(vec3(cos(around) * 3.0, sin(around) * 3.0, floor(rings) * 0.7)));

    float fade = 1.0 / (1.0 + theta * 1.5);
    float source = step(theta, 0.02 + 0.01 * sin(t * 3.0));
    float carrier = (1.0 - smoothstep(0.0, 0.25, theta)) * 0.3 * uWeight;

    return max(max(ring * broken * fade * (0.4 + 0.6 * uWeight), max(source, carrier)), star(d, px, t));
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
    vec3 skied(Texel t, vec3 color, vec2 pixel) {
      if (t.sky < 0.5) return color;

      float threshold = texture2D(uBayer, pixel / 8.0).r;

      // Half a step up, so that no density is black everywhere and full
      // density is white everywhere.
      return vec3(step(threshold + 1.0 / 128.0, t.rgb.r));
    }
  `,
  uniforms: () => ({}),
};
