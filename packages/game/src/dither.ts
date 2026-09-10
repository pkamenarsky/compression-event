// -----------------------------------------------------------------------------
// Ordered dithering
//
// The jam build's look, carried over unchanged: the scene is rendered into a
// target, each channel is quantised to a handful of levels, and an 8x8 Bayer
// threshold decides which way a value that falls between two of them goes. What
// the eye reads as shading is the pattern rather than the value.
//
// `bayerGLSL` is a 4x4 threshold any shader can mix into its own colour before
// the quantisation ever happens, and the rest is two stages of the screen pass
// in `screen.ts`: the walls' nudge, which is that threshold laid over whatever
// share of a pixel is wall and is what keeps a large flat surface from banding,
// and the quantising itself.
// -----------------------------------------------------------------------------

import * as THREE from 'three';
import type { Stage } from './screen';

/** The 4x4 threshold, for a shader that wants to nudge its own colour. */
export const bayerGLSL = /* glsl */ `
  float bayerDither(vec2 screenCoord) {
    int x = int(mod(screenCoord.x, 4.0));
    int y = int(mod(screenCoord.y, 4.0));
    int index = x + y * 4;

    float bayer[16];
    bayer[0]  =  0.0 / 16.0;
    bayer[1]  =  8.0 / 16.0;
    bayer[2]  =  2.0 / 16.0;
    bayer[3]  = 10.0 / 16.0;
    bayer[4]  = 12.0 / 16.0;
    bayer[5]  =  4.0 / 16.0;
    bayer[6]  = 14.0 / 16.0;
    bayer[7]  =  6.0 / 16.0;
    bayer[8]  =  3.0 / 16.0;
    bayer[9]  = 11.0 / 16.0;
    bayer[10] =  1.0 / 16.0;
    bayer[11] =  9.0 / 16.0;
    bayer[12] = 15.0 / 16.0;
    bayer[13] =  7.0 / 16.0;
    bayer[14] = 13.0 / 16.0;
    bayer[15] =  5.0 / 16.0;

    return bayer[index];
  }
`;

/** The 8x8 matrix the pass itself uses, normalised to [0, 1). */
const BAYER_8X8 = [
  0, 48, 12, 60, 3, 51, 15, 63,
  32, 16, 44, 28, 35, 19, 47, 31,
  8, 56, 4, 52, 11, 59, 7, 55,
  40, 24, 36, 20, 43, 27, 39, 23,
  2, 50, 14, 62, 1, 49, 13, 61,
  34, 18, 46, 30, 33, 17, 45, 29,
  10, 58, 6, 54, 9, 57, 5, 53,
  42, 26, 38, 22, 41, 25, 37, 21,
];

export function bayerTexture(): THREE.DataTexture {
  const data = new Uint8Array(BAYER_8X8.map(v => Math.round(v / 64 * 255)));
  const tex = new THREE.DataTexture(data, 8, 8, THREE.RedFormat, THREE.UnsignedByteType);

  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;

  return tex;
}

/**
 * The walls' nudge: the 4x4 threshold over as much of the pixel as is wall,
 * clamped where the target would once have clamped it. Needs `Texel` from
 * `target.ts`; `pixel` is whole pixels.
 */
export const nudge: Stage = {
  glsl: /* glsl */ `
    ${bayerGLSL}

    vec3 nudged(Texel t, vec2 pixel) {
      return clamp(t.rgb + t.wall * (bayerDither(pixel) - 0.5) * 1.2, 0.0, 1.0);
    }
  `,
  uniforms: () => ({}),
};

export interface DitherOptions {
  /** Discrete levels per channel. */
  levels?: number
  /** 0 quantises without dithering; 1 is the full Bayer spread. */
  strength?: number
}

/**
 * Each channel to a handful of levels, the 8x8 threshold choosing which way.
 * Off leaves the colour as it is — the editor looking down on a level rather
 * than standing in it. `uBayer` is the pass's to fill, since it owns the
 * texture.
 */
export const quantise = (options: DitherOptions = {}): Stage => ({
  glsl: /* glsl */ `
    uniform sampler2D uBayer;
    uniform float uLevels;
    uniform float uStrength;
    uniform bool uQuantise;

    vec3 quantised(vec3 color, vec2 pixel) {
      if (!uQuantise) return color;

      float threshold = texture2D(uBayer, pixel / 8.0).r;
      float bias = (threshold - 0.5) * uStrength;
      float steps = max(uLevels - 1.0, 1.0);

      return clamp(floor((color + bias / steps) * steps + 0.5) / steps, 0.0, 1.0);
    }
  `,
  uniforms: () => ({
    uBayer: { value: null },
    uLevels: { value: options.levels ?? 5 },
    uStrength: { value: options.strength ?? 1.1 },
    uQuantise: { value: true },
  }),
});
