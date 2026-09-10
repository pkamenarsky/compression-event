// -----------------------------------------------------------------------------
// The screen pass
//
// The scene is drawn into a target, always, and this puts the target on the
// screen. What the target holds is `target.ts`'s to say; what happens to it on
// the way out is the list below, and it happens in that order:
//
//   read      target → Texel          colour, and how much of it is wall
//   warp      uv → Texel via read     where on the target a pixel shows
//   blur      uv → Texel via warp     a run of warped reads in to the middle
//   nudge     Texel → colour          the walls' pattern, in screen pixels
//   quantise  colour → colour         a handful of levels, 8x8 Bayer between
//
// Each stage is a GLSL function and the uniforms it reads, declared together
// in the file the stage belongs to. The list is also the order they are pasted
// in, and a stage only calls the ones before it, so reordering the list is the
// only way to break that — and `main` below reads the same way down.
//
// Deliberately not three's `EffectComposer`: one scene target, one pass, and
// nothing to configure that this does not already say.
// -----------------------------------------------------------------------------

import * as THREE from 'three';
import { DitherOptions, bayerTexture, nudge, quantise } from './dither';
import { read } from './target';
import { blur, warp } from './warp';

/** One stage of the pass: its GLSL, and the uniforms that GLSL declares with
 * where they start. */
export interface Stage {
  glsl: string
  uniforms: () => Record<string, THREE.IUniform>
}

const vertexShader = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`;

const main = /* glsl */ `
  uniform vec2 uResolution;

  varying vec2 vUv;

  void main() {
    // Pixel centres, so the 8x8 texture is read in the middle of a texel;
    // the 4x4 nudge wants whole pixels.
    vec2 pixel = vUv * uResolution;

    Texel t = blurred(vUv);
    vec3 color = nudged(t, floor(pixel));

    gl_FragColor = vec4(quantised(color, pixel), 1.0);
  }
`;

export class ScreenPass {
  private target: THREE.WebGLRenderTarget;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private material: THREE.ShaderMaterial;
  private quad: THREE.Mesh;
  private bayer: THREE.DataTexture;

  /** Every stage's uniforms, by name, for setting. */
  private u: Record<string, THREE.IUniform>;

  constructor(private renderer: THREE.WebGLRenderer, options: DitherOptions = {}) {
    const size = renderer.getSize(new THREE.Vector2());
    const width = size.x || 1, height = size.y || 1;

    this.target = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,

      // The floors are filled by counting into the stencil — see the header of
      // `walls.ts` — and the scene is drawn in here rather than on the screen,
      // so this is the buffer they count into. `clear` takes it back to zero
      // with the colour and the depth every frame.
      stencilBuffer: true,
    });

    this.bayer = bayerTexture();

    const stages = [read, warp, blur, nudge, quantise(options)];

    this.u = Object.assign(
      { uResolution: { value: new THREE.Vector2(width, height) } },
      ...stages.map(s => s.uniforms()),
    );

    this.u.uScene.value = this.target.texture;
    this.u.uBayer.value = this.bayer;
    this.u.uAspect.value = width / height;

    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader: [...stages.map(s => s.glsl), main].join('\n'),
      uniforms: this.u,
      depthTest: false,
      depthWrite: false,
    });

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  /** Whether the colour is quantised on the way out. Off is the editor looking
   * down on a level; everything before it still runs. */
  set quantised(on: boolean) {
    this.u.uQuantise.value = on;
  }

  setSize(width: number, height: number): void {
    this.target.setSize(width, height);
    this.u.uResolution.value.set(width, height);
    this.u.uAspect.value = width / height;
  }

  /** Which warp, how far into it, and how much radial blur over the top —
   * see `warp.ts`. Left alone it stays at none, and the pass reads the scene
   * exactly where it is. */
  warp(index: number, amount: number, time: number, blur = 0): void {
    this.u.uWarp.value = index;
    this.u.uAmount.value = amount;
    this.u.uTime.value = time;
    this.u.uBlur.value = blur;
  }

  apply(scene: THREE.Scene, camera: THREE.Camera): void {
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
