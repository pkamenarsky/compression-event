import * as THREE from 'three';

/**
 * 8×8 Bayer matrix for ordered dithering, normalised to [0, 1).
 */
const BAYER_8X8: number[] = [
   0, 48, 12, 60,  3, 51, 15, 63,
  32, 16, 44, 28, 35, 19, 47, 31,
   8, 56,  4, 52, 11, 59,  7, 55,
  40, 24, 36, 20, 43, 27, 39, 23,
   2, 50, 14, 62,  1, 49, 13, 61,
  34, 18, 46, 30, 33, 17, 45, 29,
  10, 58,  6, 54,  9, 57,  5, 53,
  42, 26, 38, 22, 41, 25, 37, 21,
];

function createBayerTexture(): THREE.DataTexture {
  const size = 8;
  const data = new Uint8Array(size * size);
  for (let i = 0; i < size * size; i++) {
    data[i] = Math.round((BAYER_8X8[i] / 64) * 255);
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

const ditherVertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 1.0);
}
`;

const ditherFragmentShader = /* glsl */ `
uniform sampler2D uSceneTexture;
uniform sampler2D uBayerTexture;
uniform vec2 uResolution;
uniform float uColorLevels;
uniform float uDitherStrength;
uniform float uPixelSize;

varying vec2 vUv;

void main() {
  // Optional pixelation: snap UVs to a coarser grid
  vec2 uv = vUv;
  if (uPixelSize > 1.0) {
    vec2 pixelGrid = floor(uv * uResolution / uPixelSize) * uPixelSize / uResolution;
    uv = pixelGrid;
  }

  vec3 color = texture2D(uSceneTexture, uv).rgb;

  // Look up Bayer threshold from the 8×8 tiled texture using screen-pixel coords
  vec2 screenPos = vUv * uResolution;
  if (uPixelSize > 1.0) {
    screenPos = floor(screenPos / uPixelSize);
  }
  vec2 bayerUV = screenPos / 8.0; // 8×8 matrix tiles
  float threshold = texture2D(uBayerTexture, bayerUV).r; // [0, 1]

  // Shift threshold to be centred around 0
  float bias = (threshold - 0.5) * uDitherStrength;

  // Quantise each channel to uColorLevels discrete steps
  float steps = max(uColorLevels - 1.0, 1.0);
  vec3 shifted = color + bias / steps;
  vec3 quantised = floor(shifted * steps + 0.5) / steps;
  quantised = clamp(quantised, 0.0, 1.0);

  gl_FragColor = vec4(quantised, 1.0);
}
`;

export interface DitherPassOptions {
  /** Number of discrete colour levels per channel. Default 4 (gives a 4-tone palette per channel). */
  colorLevels?: number;
  /** Strength of the dither offset. 0 = no dither (just quantise), 1 = full Bayer spread. Default 1. */
  ditherStrength?: number;
  /** Virtual pixel size for optional pixelation. 1 = no pixelation. Default 1. */
  pixelSize?: number;
}

export class DitherPass {
  private renderTarget: THREE.WebGLRenderTarget;
  private ditherScene: THREE.Scene;
  private ditherCamera: THREE.OrthographicCamera;
  private material: THREE.ShaderMaterial;
  private quad: THREE.Mesh;
  private bayerTexture: THREE.DataTexture;

  /** Set to false to bypass the dither pass entirely. */
  enabled = true;

  constructor(
    private renderer: THREE.WebGLRenderer,
    options?: DitherPassOptions
  ) {
    const colorLevels = options?.colorLevels ?? 4;
    const ditherStrength = options?.ditherStrength ?? 1.0;
    const pixelSize = options?.pixelSize ?? 1;

    const size = renderer.getSize(new THREE.Vector2());
    const w = size.x || 1;
    const h = size.y || 1;

    this.renderTarget = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      depthBuffer: true,
      stencilBuffer: false,
    });

    this.bayerTexture = createBayerTexture();

    this.material = new THREE.ShaderMaterial({
      vertexShader: ditherVertexShader,
      fragmentShader: ditherFragmentShader,
      uniforms: {
        uSceneTexture: { value: this.renderTarget.texture },
        uBayerTexture: { value: this.bayerTexture },
        uResolution: { value: new THREE.Vector2(w, h) },
        uColorLevels: { value: colorLevels },
        uDitherStrength: { value: ditherStrength },
        uPixelSize: { value: pixelSize },
      },
      depthTest: false,
      depthWrite: false,
    });

    // Fullscreen quad
    const geo = new THREE.PlaneGeometry(2, 2);
    this.quad = new THREE.Mesh(geo, this.material);
    this.quad.frustumCulled = false;

    this.ditherScene = new THREE.Scene();
    this.ditherScene.add(this.quad);

    this.ditherCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  /** Update resolution (call on window resize). */
  setSize(width: number, height: number): void {
    this.renderTarget.setSize(width, height);
    this.material.uniforms.uResolution.value.set(width, height);
  }

  /** Number of discrete colour levels per channel. */
  get colorLevels(): number {
    return this.material.uniforms.uColorLevels.value;
  }
  set colorLevels(v: number) {
    this.material.uniforms.uColorLevels.value = v;
  }

  /** Dither strength (0 = quantise only, 1 = full Bayer spread). */
  get ditherStrength(): number {
    return this.material.uniforms.uDitherStrength.value;
  }
  set ditherStrength(v: number) {
    this.material.uniforms.uDitherStrength.value = v;
  }

  /** Virtual pixel size for pixelation effect. */
  get pixelSize(): number {
    return this.material.uniforms.uPixelSize.value;
  }
  set pixelSize(v: number) {
    this.material.uniforms.uPixelSize.value = v;
  }

  /**
   * Capture the current scene into the internal render target.
   * Call this instead of `renderer.render(scene, camera)` when you want
   * the dither pass to process the result.
   *
   * @param mainScene  The 3D scene to render.
   * @param mainCamera The camera to render with.
   */
  capture(mainScene: THREE.Scene, mainCamera: THREE.Camera): void {
    this.renderer.setRenderTarget(this.renderTarget);
    this.renderer.clear();
    this.renderer.render(mainScene, mainCamera);
    this.renderer.setRenderTarget(null);
  }

  /**
   * Draw the dithered result to the screen (default framebuffer).
   * Call after `capture()`.
   */
  render(): void {
    const prevAutoClear = this.renderer.autoClear;
    this.renderer.autoClear = false;
    this.renderer.clear();
    this.renderer.render(this.ditherScene, this.ditherCamera);
    this.renderer.autoClear = prevAutoClear;
  }

  /**
   * Convenience: capture + render in one call.
   */
  apply(mainScene: THREE.Scene, mainCamera: THREE.Camera): void {
    if (!this.enabled) {
      this.renderer.render(mainScene, mainCamera);
      return;
    }
    this.capture(mainScene, mainCamera);
    this.render();
  }

  dispose(): void {
    this.renderTarget.dispose();
    this.bayerTexture.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}
