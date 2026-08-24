import { LayeredWallShader } from './layeredWallShader';

const IRIDESCENT_COLOR_GLSL = `
  vec3 iridescentHue(float cosAngle, float offset) {
    float hue = fract(cosAngle * 0.5 + 0.5 + offset);
    vec3 col;
    col.r = abs(hue * 6.0 - 3.0) - 1.0;
    col.g = 2.0 - abs(hue * 6.0 - 2.0);
    col.b = 2.0 - abs(hue * 6.0 - 4.0);
    col = clamp(col, 0.0, 1.0);
    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(lum), col, 0.7);
    return col;
  }

  vec3 computeBaseColor(vec3 worldPos, vec3 normal, vec3 viewDir, float cosAngle, float layerIndex, float time) {
    // Distance-based offset so colour shifts as player moves
    float distToPlayer = length(uPlayerPosition - worldPos);
    float distOffset = distToPlayer * 0.15;

    // Slow time drift
    float timeOffset = time * 0.05;

    // Layer-based offset to differentiate each virtual layer
    float layerOffset = layerIndex * 0.18 + layerIndex * layerIndex * 0.05;

    // Spatial variation using world position to break vertical uniformity
    float spatial = sin(worldPos.x * 0.7 + worldPos.y * 0.3 + time * 0.1)
                  * cos(worldPos.z * 0.6 - worldPos.y * 0.4 + time * 0.08)
                  * 0.4;

    // Additional horizontal ripple
    float ripple = sin(worldPos.x * 1.3 + worldPos.z * 1.1 + time * 0.15) * 0.2
                 + sin(worldPos.x * 0.4 - worldPos.z * 0.9 + worldPos.y * 0.5 + time * 0.12) * 0.15;

    // Per-layer spatial frequency variation
    float layerSpatialShift = sin(worldPos.x * (1.0 + layerIndex * 0.5) + worldPos.z * (0.8 + layerIndex * 0.3) + time * 0.07) * 0.2;

    vec3 col = iridescentHue(cosAngle, distOffset + timeOffset + spatial + ripple + layerOffset + layerSpatialShift);

    // Second iridescence layer at a different frequency
    vec3 col2 = iridescentHue(cosAngle * 0.7 + 0.3, spatial * 1.5 - ripple + timeOffset * 1.3 + layerOffset * 0.7);
    col = mix(col, col2, 0.3);

    // Fresnel rim brightening
    float fresnel = pow(1.0 - cosAngle, 3.0);
    col += fresnel * 0.35;

    // Height-based darkening for depth
    float heightFade = smoothstep(0.0, 6.0, worldPos.y);
    col *= mix(0.75, 1.0, heightFade);

    // Base brightness boost
    col = col * 0.8 + 0.15;

    return col;
  }
`;

const BASE_COLOR_GLSL = `
  vec3 computeBaseColor(vec3 worldPos, vec3 normal, vec3 viewDir, float cosAngle, float layerIndex, float time) {
    return vec3(0.2 * (layerIndex + 1.0), 0.2 * (layerIndex + 1.0), 0.2 * (layerIndex + 1.0));
  }
`;

export class IridescentWallShader extends LayeredWallShader {
  constructor() {
    super({
      name: 'iridescent',
      colorFunctionGLSL: IRIDESCENT_COLOR_GLSL,
      numLayers: 5,
      layerWidth: 5.0,
      layerAlpha: 0.5,
      blurRadius: 0.05,
      blurSamples: 10.0
    });
  }
}
