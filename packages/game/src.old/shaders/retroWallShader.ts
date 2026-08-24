import * as THREE from 'three';
import { WallShader } from './wallShader';
import { bayerDitherGLSL } from './dither';

const WALL_COLOR = new THREE.Color(0.99, 0.92, 0.92); // muted concrete

const POLYGON_OFFSET_FACTOR = 1;
const POLYGON_OFFSET_UNITS = 1;

const vertexShader = /* glsl */ `
  attribute float aWallYBase;
  attribute float aWallYTop;

  varying vec3 vWorldPosition;
  varying vec3 vNormal;
  varying float vHeightFrac;
  varying vec2 vScreenPos;

  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPos.xyz;
    vNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);

    // Normalized height within the wall (0 = bottom, 1 = top)
    float wallH = aWallYTop - aWallYBase;
    vHeightFrac = wallH > 0.0 ? (position.y - aWallYBase) / wallH : 0.0;

    gl_Position = projectionMatrix * viewMatrix * worldPos;
    vScreenPos = gl_Position.xy / gl_Position.w;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uPlayerPosition;
  uniform vec3 uWallColor;
  uniform float uTime;

  varying vec3 vWorldPosition;
  varying vec3 vNormal;
  varying float vHeightFrac;
  varying vec2 vScreenPos;

  // Simple pseudo-random for dithering
  float rand(vec2 co) {
    return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
  }

  ${bayerDitherGLSL}

  void main() {
    // --- Directional lighting (quantized) ---
    // Two light directions for a classic look
    vec3 lightDir1 = normalize(vec3(0.5, 0.8, 0.3));
    vec3 lightDir2 = normalize(vec3(-0.3, 0.4, -0.6));

    vec3 n = normalize(vNormal);
    float NdotL1 = max(dot(n, lightDir1), 0.0);
    float NdotL2 = max(dot(n, lightDir2), 0.0);

    // Combine lights: primary + secondary fill
    float lighting = NdotL1 * 0.7 + NdotL2 * 0.3;

    // Ambient minimum
    lighting = lighting * 0.6 + 0.4;

    // --- Height darkening ---
    // Bottom of wall is darker
    float heightDarken = mix(0.7, 1.0, vHeightFrac);
    lighting *= heightDarken;

    // --- Apply base color ---
    vec3 color = uWallColor * lighting;

    // --- Dithering ---
    // Use screen-space coordinates for the dither pattern
    vec2 screenCoord = gl_FragCoord.xy;
    float dither = bayerDither(screenCoord);
    // Subtle dither: shift color slightly based on dither value
    color += (dither - 0.5) * 1.2;

    gl_FragColor = vec4(color, 1.0);
  }
`;

export class RetroWallShader implements WallShader {
  readonly name = 'retro';
  private material: THREE.ShaderMaterial | null = null;
  private elapsed = 0;

  createMaterial(): THREE.Material {
    if (this.material) return this.material;
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uPlayerPosition: { value: new THREE.Vector3(0, 0, 0) },
        uWallColor: { value: WALL_COLOR.clone() },
        uTime: { value: 0 },
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
  }

  setWallHeight(_height: number): void {
    // Height is handled via per-vertex attributes.
  }

  dispose(): void {
    if (this.material) {
      this.material.dispose();
      this.material = null;
    }
  }
}
