// -----------------------------------------------------------------------------
// The scene target
//
// What the scene is drawn into, and what the screen pass reads back out of it.
// Everything that writes the one and everything that reads the other agrees on
// this file, and on nothing else.
//
// - **rgb** is colour, in three's working space: linear, because three draws
//   into a target without encoding it, whatever the material. The pass puts it
//   on screen as it is.
// - **a** is not opacity. It says how much of the pixel is wall: `1 - share *
//   (1 - WALL)`, so 1 is none of it and `WALL` all of it. The walls leave the
//   pattern that keeps them from banding to the pass, which lays it down after
//   the picture has been warped — in the pixels it is seen in, rather than
//   stretched out of them — and this is how the pass knows where.
//
// So, for anything drawn into the scene:
//
// - an opaque material writes alpha 1, which is every built-in material and
//   what the clear writes;
// - a wall writes `markWall`;
// - a transparent material keeps three's normal blending, which leaves
//   `src + dst * (1 - src)` in alpha — the share under it scaled by what it
//   leaves showing, which is exactly how much wall is still to be seen.
//
// One exception, known: the artefacts' shadows fade by discarding in a Bayer
// stipple of their own, which is drawn into the scene and so does move with
// a warp. A stipple cannot be deferred — the pass does not know what was under
// it.
// -----------------------------------------------------------------------------

import type { Stage } from './screen';

/** What a wall writes to alpha. Anything under 1 would do; half leaves room
 * either side for blending to be read back. */
const WALL = 0.5;

/** For a wall's fragment shader: its colour, marked as wall. */
export const markWallGLSL = /* glsl */ `
  vec4 markWall(vec3 color) {
    return vec4(color, ${WALL.toFixed(1)});
  }
`;

/**
 * The screen pass's first stage: a pixel of the target, read and decoded.
 *
 * `Texel` is what every stage of the pass hands the next. A blur averages
 * `wall` along with the colour, and that is right too: the share of wall is
 * the share of the pattern the pixel should get.
 */
export const read: Stage = {
  glsl: /* glsl */ `
    uniform sampler2D uScene;

    struct Texel {
      vec3 rgb;
      float wall;
    };

    Texel read(vec2 uv) {
      vec4 t = texture2D(uScene, uv);

      return Texel(t.rgb, clamp((1.0 - t.a) / ${(1 - WALL).toFixed(1)}, 0.0, 1.0));
    }
  `,
  // The pass's to fill, since it owns the target.
  uniforms: () => ({ uScene: { value: null } }),
};
