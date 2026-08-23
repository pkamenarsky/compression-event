// -----------------------------------------------------------------------------
// Ordered dithering
//
// The jam build's look, carried over unchanged: the scene is rendered into a
// target, each channel is quantised to a handful of levels, and an 8x8 Bayer
// threshold decides which way a value that falls between two of them goes. What
// the eye reads as shading is the pattern rather than the value.
//
// Two pieces, because two things want it. `bayerGLSL` is a 4x4 threshold any
// shader can mix into its own colour before the quantisation ever happens — the
// walls do, which is what keeps a large flat surface from banding. `DitherPass`
// is the screen-space pass that does the quantising.
// -----------------------------------------------------------------------------

import * as THREE from 'three';

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

function bayerTexture(): THREE.DataTexture {
  const data = new Uint8Array(BAYER_8X8.map(v => Math.round(v / 64 * 255)));
  const tex = new THREE.DataTexture(data, 8, 8, THREE.RedFormat, THREE.UnsignedByteType);

  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;

  return tex;
}

const vertexShader = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uScene;
  uniform sampler2D uBayer;
  uniform vec2 uResolution;
  uniform float uLevels;
  uniform float uStrength;
  uniform float uPixelSize;

  varying vec2 vUv;

  void main() {
    vec2 uv = vUv;

    if (uPixelSize > 1.0) {
      uv = floor(uv * uResolution / uPixelSize) * uPixelSize / uResolution;
    }

    vec3 color = texture2D(uScene, uv).rgb;

    vec2 at = vUv * uResolution;

    if (uPixelSize > 1.0) at = floor(at / uPixelSize);

    float threshold = texture2D(uBayer, at / 8.0).r;
    float bias = (threshold - 0.5) * uStrength;

    float steps = max(uLevels - 1.0, 1.0);
    vec3 quantised = floor((color + bias / steps) * steps + 0.5) / steps;

    gl_FragColor = vec4(clamp(quantised, 0.0, 1.0), 1.0);
  }
`;

export interface DitherOptions {
  /** Discrete levels per channel. */
  levels?: number
  /** 0 quantises without dithering; 1 is the full Bayer spread. */
  strength?: number
  /** Virtual pixel size. 1 leaves the resolution alone. */
  pixelSize?: number
}

/**
 * Render into a target, then quantise it onto the screen.
 *
 * Deliberately not three's `EffectComposer`: one pass, one target, and nothing
 * to configure that this does not already say.
 */
export class DitherPass {
  private target: THREE.WebGLRenderTarget;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private material: THREE.ShaderMaterial;
  private quad: THREE.Mesh;
  private bayer: THREE.DataTexture;

  /** False renders the scene straight to the screen. */
  enabled = true;

  constructor(private renderer: THREE.WebGLRenderer, options: DitherOptions = {}) {
    const size = renderer.getSize(new THREE.Vector2());
    const width = size.x || 1, height = size.y || 1;

    this.target = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
    });

    this.bayer = bayerTexture();

    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uScene: { value: this.target.texture },
        uBayer: { value: this.bayer },
        uResolution: { value: new THREE.Vector2(width, height) },
        uLevels: { value: options.levels ?? 5 },
        uStrength: { value: options.strength ?? 1.1 },
        uPixelSize: { value: options.pixelSize ?? 1 },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  setSize(width: number, height: number): void {
    this.target.setSize(width, height);
    this.material.uniforms.uResolution.value.set(width, height);
  }

  apply(scene: THREE.Scene, camera: THREE.Camera): void {
    if (!this.enabled) {
      this.renderer.render(scene, camera);
      return;
    }

    this.renderer.setRenderTarget(this.target);
    this.renderer.clear();
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);

    const was = this.renderer.autoClear;

    this.renderer.autoClear = false;
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.autoClear = was;
  }

  dispose(): void {
    this.target.dispose();
    this.bayer.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}
