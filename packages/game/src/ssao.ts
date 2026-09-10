// -----------------------------------------------------------------------------
// Ambient occlusion
//
// Corners darkened by how much of the space around them is closed off: where a
// wall meets the ground, where two walls meet, under anything standing close
// to something else. Out of nothing but the depth the scene leaves in the
// target — no normals are drawn, and no material has to know.
//
// The usual cheap way round. A pixel's position is rebuilt from its depth, its
// normal from its neighbours' positions, and a handful of depths around it,
// within a radius in world units, are rebuilt the same way; each one standing
// above the pixel's surface, and near enough, closes off some of the sky over
// it. Near enough is what keeps a wall from shading the ground a long way
// behind it.
//
// A stage of the screen pass, between `read` and `warp`: `occluded(uv)` is
// `read(uv)` darkened, and the warp reads through it. So the darkening is the
// scene's own and bends with it, and it comes before the quantising like
// everything else, which lays its gradient down as pattern rather than as
// shades the palette does not have.
//
// The samples are spun about the pixel by an interleaved gradient noise in
// screen pixels, which the dither then swallows; there is no blur of the
// occlusion itself.
// -----------------------------------------------------------------------------

import * as THREE from 'three';
import { MAX_SAMPLES } from './config';
import type { Stage } from './screen';

/**
 * Needs `read` ahead of it. `uDepth` and the camera's numbers are the pass's to
 * fill — see `ScreenPass.look`.
 */
export const ssao: Stage = {
  glsl: /* glsl */ `
    uniform sampler2D uDepth;
    uniform vec2 uProject;
    uniform float uNear;
    uniform float uFar;
    uniform bool uAo;
    uniform float uAoRadius;
    uniform float uAoStrength;
    uniform float uAoBias;
    uniform int uAoSamples;

    // Distance in front of the camera, from the depth buffer's [0, 1].
    float eyeDepth(float d) {
      float z = d * 2.0 - 1.0;

      return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear));
    }

    // Where in view space the pixel at uv is, its depth read at uv. Right-handed
    // and looking down -z, like three's own.
    vec3 viewAt(vec2 uv) {
      float z = eyeDepth(texture2D(uDepth, uv).r);

      return vec3((uv * 2.0 - 1.0) / uProject * z, -z);
    }

    float occlusion(vec2 uv) {
      float d = texture2D(uDepth, uv).r;

      // Nothing drawn there: the sky, which nothing occludes.
      if (d >= 1.0) return 1.0;

      vec3 p = viewAt(uv);
      vec2 texel = 1.0 / uResolution;

      // The normal off whichever neighbour on each axis is nearer the
      // surface, so a pixel on an edge takes its normal from its own side.
      vec3 l = p - viewAt(uv - vec2(texel.x, 0.0));
      vec3 r = viewAt(uv + vec2(texel.x, 0.0)) - p;
      vec3 b = p - viewAt(uv - vec2(0.0, texel.y));
      vec3 t = viewAt(uv + vec2(0.0, texel.y)) - p;
      vec3 dx = abs(l.z) < abs(r.z) ? l : r;
      vec3 dy = abs(b.z) < abs(t.z) ? b : t;
      vec3 n = normalize(cross(dx, dy));

      // The radius on screen, as a share of it: a world length at this depth.
      vec2 reach = uAoRadius * uProject / p.z * -0.5;

      float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
      float spin = noise * 6.2831853;
      float count = float(uAoSamples);
      float sum = 0.0;

      for (int i = 0; i < ${MAX_SAMPLES}; i++) {
        if (i >= uAoSamples) break;

        // A spiral out from the middle, a golden angle between each.
        float k = (float(i) + 0.5) / count;
        float a = spin + float(i) * 2.3999632;
        vec2 at = uv + vec2(cos(a), sin(a)) * reach * sqrt(k);

        vec3 v = viewAt(clamp(at, 0.0, 1.0)) - p;
        float far = length(v);
        float rise = dot(n, v) / max(far, 1e-4);

        // Nothing beyond the radius, and nothing on the surface itself.
        float near = 1.0 - smoothstep(0.5, 1.0, far / uAoRadius);

        sum += max(rise - uAoBias, 0.0) * near;
      }

      return clamp(1.0 - uAoStrength * sum / count, 0.0, 1.0);
    }

    Texel occluded(vec2 uv) {
      Texel t = read(uv);

      if (uAo) t.rgb *= occlusion(uv);

      return t;
    }
  `,
  uniforms: () => ({
    uDepth: { value: null },
    uProject: { value: new THREE.Vector2(1, 1) },
    uNear: { value: 0.1 },
    uFar: { value: 200 },
    uAo: { value: false },
    uAoRadius: { value: 1 },
    uAoStrength: { value: 1 },
    uAoBias: { value: 0.1 },
    uAoSamples: { value: 12 },
  }),

  apply(u, { ssao: s }): void {
    u.uAo.value = s.on;
    u.uAoRadius.value = Math.max(s.radius, 1e-3);
    u.uAoStrength.value = s.strength;
    u.uAoBias.value = s.bias;
    u.uAoSamples.value = Math.min(Math.max(Math.round(s.samples), 1), MAX_SAMPLES);
  },
};
