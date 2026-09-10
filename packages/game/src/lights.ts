// -----------------------------------------------------------------------------
// The lights
//
// An experiment: the level's ambient taken down, and small lights standing
// about in it at a third of the walls' height, where the open ceiling leaves
// nothing to hang them from.
//
// There is no list of lights. The ground is cut into cells a couple of tiles
// across, and each cell has one light or none, somewhere in it — both decided
// by a hash of the cell, so any fragment can work out every light near it by
// looking at the cells around its own. Nothing is placed, nothing is uploaded,
// and a level of any size has as many as it covers.
//
// Nothing casts a shadow: a light reaches through a wall to whatever is on the
// other side of it. The walls are hollow shells without a notion of inside, and
// this is only a look at what light does to the place.
// -----------------------------------------------------------------------------

import * as THREE from 'three';
import type { RenderConfig } from './config';
import { outputsGLSL } from './target';
import { TILE_SIZE } from './world';

/** The most cells either way a fragment looks for lights in. A radius longer
 * than this many cells is cut off at it. */
const REACH = 3;

export type LightUniforms = {
  uLightsOn: { value: number }
  uAmbient: { value: number }
  uLightCell: { value: number }
  uLightChance: { value: number }
  uLightJitter: { value: number }
  uLightHeight: { value: number }
  uLightRadius: { value: number }
  uLightStrength: { value: number }
  uLightSeed: { value: number }
};

/** Unlit: what a material gets when nobody has asked for lights, which is
 * every test and anything built without a renderer. */
export function unlit(): LightUniforms {
  return {
    uLightsOn: { value: 0 },
    uAmbient: { value: 1 },
    uLightCell: { value: 2 * TILE_SIZE },
    uLightChance: { value: 0 },
    uLightJitter: { value: 0 },
    uLightHeight: { value: 0 },
    uLightRadius: { value: 1 },
    uLightStrength: { value: 0 },
    uLightSeed: { value: 0 },
  };
}

/** The config's numbers into the uniforms every lit material shares. */
export function configureLights(u: LightUniforms, { lights: l }: RenderConfig, wallHeight: number): void {
  u.uLightsOn.value = l.on ? 1 : 0;
  u.uAmbient.value = l.ambient;
  u.uLightCell.value = Math.max(l.cell, 0.25) * TILE_SIZE;
  u.uLightChance.value = l.chance;
  u.uLightJitter.value = l.jitter;
  u.uLightHeight.value = l.height * wallHeight;
  u.uLightRadius.value = Math.max(l.radius, 0.01);
  u.uLightStrength.value = l.strength;
  u.uLightSeed.value = l.seed;
}

/**
 * `lit(base, p, n)`: a surface's own shading `base` at world point `p` facing
 * `n`, with the ambient taken down and every light in reach added.
 */
export const LIGHTS_GLSL = /* glsl */ `
  uniform float uLightsOn;
  uniform float uAmbient;
  uniform float uLightCell;
  uniform float uLightChance;
  uniform float uLightJitter;
  uniform float uLightHeight;
  uniform float uLightRadius;
  uniform float uLightStrength;
  uniform float uLightSeed;

  // Dave Hoskins' hash without sine: three numbers in [0, 1) from a cell.
  vec3 lightHash(vec2 cell) {
    vec3 p = fract(vec3(cell.xyx + uLightSeed * 17.31) * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yzz) * p.zyx);
  }

  float lit(float base, vec3 p, vec3 n) {
    if (uLightsOn < 0.5) return base;

    vec2 own = floor(p.xz / uLightCell);
    int reach = min(int(ceil(uLightRadius / uLightCell)), ${REACH});
    float r2 = uLightRadius * uLightRadius;
    float sum = 0.0;

    for (int i = -${REACH}; i <= ${REACH}; i++) {
      for (int j = -${REACH}; j <= ${REACH}; j++) {
        if (abs(i) > reach || abs(j) > reach) continue;

        vec2 cell = own + vec2(float(i), float(j));
        vec3 h = lightHash(cell);

        if (h.z >= uLightChance) continue;

        vec2 at = (cell + 0.5 + (h.xy - 0.5) * uLightJitter) * uLightCell;
        vec3 to = vec3(at.x, uLightHeight, at.y) - p;
        float d2 = dot(to, to);

        if (d2 >= r2) continue;

        float falloff = 1.0 - d2 / r2;

        sum += falloff * falloff * max(dot(n, normalize(to)), 0.0);
      }
    }

    return base * uAmbient + sum * uLightStrength;
  }
`;

/** The ground's material: its colour, lit from above like everything else. */
export function litFloor(
  color: THREE.ColorRepresentation,
  lights: LightUniforms,
  params: THREE.ShaderMaterialParameters = {},
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: /* glsl */ `
      varying vec3 vWorldPosition;

      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);

        vWorldPosition = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;

      varying vec3 vWorldPosition;

      ${LIGHTS_GLSL}
      ${outputsGLSL}

      void main() {
        fragColor = vec4(uColor * lit(1.0, vWorldPosition, vec3(0.0, 1.0, 0.0)), 1.0);
        marks = UNMARKED;
      }
    `,
    uniforms: { ...lights, uColor: { value: new THREE.Color(color) } },
    ...params,
  });
}
