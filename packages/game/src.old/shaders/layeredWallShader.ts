import * as THREE from 'three';
import { WallShader } from './wallShader';

const POLYGON_OFFSET_FACTOR = 1;
const POLYGON_OFFSET_UNITS = 1;

const vertexShader = /* glsl */ `
  attribute float aWallYBase;
  attribute float aWallYTop;

  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying float vWallYBase;
  varying float vWallYTop;

  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPos.xyz;
    vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
    vWallYBase = aWallYBase;
    vWallYTop = aWallYTop;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

/**
 * Build the fragment shader source.
 *
 * @param colorFunctionGLSL  A GLSL snippet that defines:
 *   vec3 computeBaseColor(vec3 worldPos, vec3 normal, vec3 viewDir, float cosAngle, float layerIndex, float time)
 *
 * @param numLayers   Number of virtual layers to composite.
 * @param layerWidth  World-space distance between layers.
 * @param layerAlpha  Opacity of each non-base layer (0..1).
 * @param blurRadius  World-space max jitter radius for frosted glass blur.
 * @param blurSamples Number of jitter samples for the blur. 1 = no blur.
 */
function buildFragmentShader(
  colorFunctionGLSL: string,
  numLayers: number,
  layerWidth: number,
  layerAlpha: number,
  blurRadius: number,
  blurSamples: number
): string {
  // Pre-compute a golden-angle spiral set of 2D offsets.
  // The first sample is always at the center (offset 0,0) so that
  // with blurSamples=1 we get the unblurred result.
  const offsets: { x: number; y: number }[] = [];
  offsets.push({ x: 0, y: 0 }); // center sample
  const goldenAngle = 2.399963229728653; // pi * (3 - sqrt(5))
  for (let i = 1; i < blurSamples; i++) {
    const r = Math.sqrt(i / blurSamples); // normalized radius [0,1)
    const theta = i * goldenAngle;
    offsets.push({
      x: r * Math.cos(theta),
      y: r * Math.sin(theta),
    });
  }

  const offsetsGLSL = offsets
    .map((o) => `vec2(${o.x.toFixed(6)}, ${o.y.toFixed(6)})`)
    .join(',\n      ');

  return `
  uniform vec3 uPlayerPosition;
  uniform float uTime;

  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying float vWallYBase;
  varying float vWallYTop;

  const int NUM_LAYERS = ${numLayers};
  const float LAYER_WIDTH = ${layerWidth.toFixed(4)};
  const float LAYER_ALPHA = ${layerAlpha.toFixed(4)};
  const float BLUR_RADIUS = ${blurRadius.toFixed(4)};
  const int BLUR_SAMPLES = ${blurSamples};

  const vec2 BLUR_OFFSETS[${blurSamples}] = vec2[${blurSamples}](
      ${offsetsGLSL}
  );

  // ---- color function provided by the concrete shader ----
  ${colorFunctionGLSL}
  // ---- end color function ----

  // Composite all layers for a single ray starting at surfacePos,
  // going deeper along rayDir. Returns the composited color.
  vec3 compositeLayers(vec3 surfacePos, vec3 rayDir, vec3 normal, float baseDist, float yMin, float yMax) {
    vec3 composited = vec3(0.0);
    float compositedAlpha = 0.0;

    for (int i = 0; i < NUM_LAYERS; i++) {
      float fi = float(i);
      float layerDist = baseDist + fi * LAYER_WIDTH;
      vec3 hitPos = uPlayerPosition + rayDir * layerDist;

      // If this layer is outside vertical bounds, no deeper layer
      // will be inside either (ray keeps going same direction), so stop.
      if (i > 0 && (hitPos.y < yMin || hitPos.y > yMax)) {
        break;
      }

      vec3 viewDir = normalize(uPlayerPosition - hitPos);
      float cosAngle = abs(dot(viewDir, normal));
      vec3 layerColor = computeBaseColor(hitPos, normal, viewDir, cosAngle, fi, uTime);

      float alpha = (i == 0) ? 1.0 : LAYER_ALPHA;
      composited = layerColor * alpha + composited * (1.0 - alpha);
      compositedAlpha = alpha + compositedAlpha * (1.0 - alpha);
    }

    return composited;
  }

  void main() {
    vec3 normal = normalize(vWorldNormal);
    vec3 rayDir = normalize(vWorldPosition - uPlayerPosition);

    // Distance from player to the wall surface hit point
    float baseDist = length(vWorldPosition - uPlayerPosition);

    float yMin = vWallYBase;
    float yMax = vWallYTop;

    // Build a tangent frame on the plane perpendicular to the view ray
    // for applying blur jitter offsets to the surface hit point.
    vec3 tangent;
    if (abs(rayDir.y) < 0.99) {
      tangent = normalize(cross(rayDir, vec3(0.0, 1.0, 0.0)));
    } else {
      tangent = normalize(cross(rayDir, vec3(1.0, 0.0, 0.0)));
    }
    vec3 bitangent = normalize(cross(rayDir, tangent));

    // For each blur sample, jitter the surface hit point and run the
    // full layer compositing. Then average all samples together.
    vec3 totalColor = vec3(0.0);

    for (int s = 0; s < BLUR_SAMPLES; s++) {
      vec2 offset = BLUR_OFFSETS[s] * BLUR_RADIUS;
      vec3 jitteredSurface = vWorldPosition + tangent * offset.x + bitangent * offset.y;

      // Recompute ray direction and distance for the jittered point
      vec3 jitteredRayDir = normalize(jitteredSurface - uPlayerPosition);
      float jitteredDist = length(jitteredSurface - uPlayerPosition);

      totalColor += compositeLayers(jitteredSurface, jitteredRayDir, normal, jitteredDist, yMin, yMax);
    }

    totalColor /= float(BLUR_SAMPLES);

    gl_FragColor = vec4(totalColor, 1.0);
  }
`;
}

export interface LayeredWallShaderOptions {
  /** Human-readable name for this shader. */
  name: string;

  /**
   * GLSL snippet that defines:
   *   vec3 computeBaseColor(vec3 worldPos, vec3 normal, vec3 viewDir, float cosAngle, float layerIndex, float time)
   */
  colorFunctionGLSL: string;

  /** Number of virtual layers to composite. Default 5. */
  numLayers?: number;

  /** World-space distance between layers. Default 1.0. */
  layerWidth?: number;

  /** Opacity of each non-base layer (0..1). Default 0.5. */
  layerAlpha?: number;

  /**
   * World-space max jitter radius for frosted glass blur.
   * 0 disables blur entirely. Default 0.5.
   */
  blurRadius?: number;

  /**
   * Number of jitter samples for the blur effect.
   * Higher = smoother but more expensive. Default 8.
   * Set to 1 to disable blur.
   */
  blurSamples?: number;

  /** Additional uniforms beyond uPlayerPosition and uTime. */
  extraUniforms?: { [key: string]: THREE.IUniform };

  /**
   * Optional per-frame callback to update extra uniforms.
   * Called with (material, dt, playerPosition, elapsed).
   */
  onUpdate?: (
    material: THREE.ShaderMaterial,
    dt: number,
    playerPosition: THREE.Vector3,
    elapsed: number
  ) => void;
}

/**
 * A reusable layered wall shader.
 * Provide a GLSL color function and get multi-layer alpha-composited walls
 * with an optional frosted glass blur effect.
 */
export class LayeredWallShader implements WallShader {
  readonly name: string;
  private material: THREE.ShaderMaterial | null = null;
  private elapsed = 0;
  private fragmentSource: string;
  private extraUniforms: { [key: string]: THREE.IUniform };
  private onUpdateCallback?: LayeredWallShaderOptions['onUpdate'];

  constructor(options: LayeredWallShaderOptions) {
    this.name = options.name;
    this.extraUniforms = options.extraUniforms ?? {};
    this.onUpdateCallback = options.onUpdate;

    const blurRadius = options.blurRadius ?? 0.5;
    const blurSamples = Math.max(1, options.blurSamples ?? 8);

    this.fragmentSource = buildFragmentShader(
      options.colorFunctionGLSL,
      options.numLayers ?? 5,
      options.layerWidth ?? 1.0,
      options.layerAlpha ?? 0.5,
      blurRadius,
      blurSamples
    );
  }

  createMaterial(): THREE.Material {
    if (this.material) return this.material;
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader: this.fragmentSource,
      uniforms: {
        uPlayerPosition: { value: new THREE.Vector3(0, 0, 0) },
        uTime: { value: 0 },
        ...this.extraUniforms,
      },
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: POLYGON_OFFSET_FACTOR,
      polygonOffsetUnits: POLYGON_OFFSET_UNITS,
    });
    return this.material;
  }

  update(dt: number, playerPosition: THREE.Vector3): void {
    if (!this.material) return;
    this.elapsed += dt;
    this.material.uniforms.uPlayerPosition.value.copy(playerPosition);
    this.material.uniforms.uTime.value = this.elapsed;
    if (this.onUpdateCallback) {
      this.onUpdateCallback(this.material, dt, playerPosition, this.elapsed);
    }
  }

  setWallHeight(_height: number): void {
    // Wall bounds are per-vertex attributes, not uniforms.
  }

  dispose(): void {
    if (this.material) {
      this.material.dispose();
      this.material = null;
    }
  }
}
