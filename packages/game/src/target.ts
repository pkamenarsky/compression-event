// -----------------------------------------------------------------------------
// The scene target
//
// What the scene is drawn into, and what the screen pass reads back out of it.
// Everything that writes the one and everything that reads the other agrees on
// this file, and on nothing else.
//
// Two attachments, written together by every draw:
//
// - **colour**, in three's working space: linear, because three draws into a
//   target without encoding it, whatever the material. The pass puts it on
//   screen as it is.
// - **marks**, which say where the pass has a pattern to lay down. Nothing drawn
//   into the scene makes a screen-space pattern of its own — one made there is
//   one the warp stretches — so what would have made one leaves a mark instead,
//   and the pass lays the pattern after the warp, in the pixels it is seen in.
//   - r: how much of the pixel is wall, which gets the Bayer nudge that keeps
//     a large flat surface from banding;
//   - g: a shadow's shade, which gets stippled black where it is over the 4x4
//     threshold. Offset from zero — see `shadeMark` — so that no shadow and the
//     faintest one differ;
//   - b: free.
//
// Blending runs on both at once, with the same factors, but each attachment's
// source alpha is its own. Which is what lets ordinary blending do everything:
//
// - an opaque material writes its colour and `UNMARKED`;
// - a wall writes `wallMark`;
// - a fading line writes its opacity to both, so it covers the colour and the
//   marks under it by the same amount — share times what it leaves showing;
// - a shadow writes zero alpha to colour, which keeps the ground under it, and
//   full alpha to marks, which replaces them.
//
// The rule that holds it together: **every material that writes colour writes
// marks.** A shader that leaves an output unwritten leaves it undefined — in
// practice, whatever was there — and an artefact drawn in front of a wall would
// wear the wall's marks. Three's built-in materials write only colour, so none
// of them go in the scene: `flat` stands in for the plain ones, and the screen
// pass says so, once per material, if one gets in anyway.
// -----------------------------------------------------------------------------

import * as THREE from 'three';
import type { Stage } from './screen';

/** How a scene shader knows it writes marks, and how the pass checks. */
const MARKS = 'layout(location = 1) out vec4 marks;';

/**
 * For a scene shader, GLSL 3: both outputs, and what goes in the second.
 *
 * Under GLSL 3 there is no `gl_FragColor` and three does not put one back, so
 * the colour is declared here along with the marks.
 */
export const outputsGLSL = /* glsl */ `
  layout(location = 0) out vec4 fragColor;
  ${MARKS}

  const vec4 UNMARKED = vec4(0.0, 0.0, 0.0, 1.0);

  vec4 wallMark() {
    return vec4(1.0, 0.0, 0.0, 1.0);
  }

  // A shade of 0 is the rim of a shadow, which the old stipple still drew
  // black where the threshold is 0 — so it goes in half a sixteenth up, under
  // the smallest step the threshold takes, and nothing that is shadow reads as
  // none.
  vec4 shadeMark(float shade) {
    return vec4(0.0, min(shade + 1.0 / 32.0, 1.0), 0.0, 1.0);
  }
`;

/** Whether a material writes marks — see the rule in the header. */
export function marked(material: THREE.Material): boolean {
  if (!material.colorWrite) return true;

  return material instanceof THREE.ShaderMaterial && material.fragmentShader.includes(MARKS);
}

/** A flat colour, unlit, unmarked: what the scene has in place of three's basic
 * materials. Anything else a material wants — sides, offsets — goes in `params`. */
export function flat(color: THREE.ColorRepresentation, params: THREE.ShaderMaterialParameters = {}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: /* glsl */ `
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;

      ${outputsGLSL}

      void main() {
        fragColor = vec4(uColor, 1.0);
        marks = UNMARKED;
      }
    `,
    uniforms: { uColor: { value: new THREE.Color(color) } },
    ...params,
  });
}

/**
 * The screen pass's first stage: a pixel of the target, read and decoded.
 *
 * `Texel` is what every stage of the pass hands the next. A blur averages the
 * marks along with the colour, and that is right too: the share of wall is the
 * share of the nudge the pixel should get, and a shade smeared thinner is a
 * sparser stipple.
 */
export const read: Stage = {
  glsl: /* glsl */ `
    uniform sampler2D uScene;
    uniform sampler2D uMarks;

    struct Texel {
      vec3 rgb;
      float wall;
      float shade;
    };

    Texel read(vec2 uv) {
      vec4 m = texture2D(uMarks, uv);

      return Texel(texture2D(uScene, uv).rgb, m.r, m.g);
    }
  `,
  // The pass's to fill, since it owns the target.
  uniforms: () => ({ uScene: { value: null }, uMarks: { value: null } }),
};
