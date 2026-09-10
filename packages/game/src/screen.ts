// -----------------------------------------------------------------------------
// The screen pass
//
// The scene is drawn into a target, always, and this puts the target on the
// screen. What the target holds is `target.ts`'s to say; what happens to it on
// the way out is the list below, and it happens in that order:
//
//   read      target → Texel          colour, and the marks: wall and shade
//   warp      uv → Texel via read     where on the target a pixel shows
//   blur      uv → Texel via warp     a run of warped reads in to the middle
//   bayer     pixel → threshold       the 4x4 the next two lay down
//   nudge     Texel → colour          the walls' pattern, in screen pixels
//   stipple   colour → colour         the shadows' pattern, likewise
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
import { stipple } from './artefacts';
import { DitherOptions, bayer, bayerTexture, nudge, quantise } from './dither';
import { marked, read } from './target';
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
    // the 4x4 patterns want whole pixels.
    vec2 pixel = vUv * uResolution;

    Texel t = blurred(vUv);
    vec3 color = nudged(t, floor(pixel));

    color = stippled(color, t.shade, floor(pixel));

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

  /** Materials already reported for not writing marks, so each is said once. */
  private reported = new WeakSet<THREE.Material>();

  constructor(private renderer: THREE.WebGLRenderer, options: DitherOptions = {}) {
    const size = renderer.getSize(new THREE.Vector2());
    const width = size.x || 1, height = size.y || 1;

    // Colour and marks — see `target.ts`.
    this.target = new THREE.WebGLRenderTarget(width, height, {
      count: 2,
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

    const stages = [read, warp, blur, bayer, nudge, stipple, quantise(options)];

    this.u = Object.assign(
      { uResolution: { value: new THREE.Vector2(width, height) } },
      ...stages.map(s => s.uniforms()),
    );

    this.u.uScene.value = this.target.textures[0];
    this.u.uMarks.value = this.target.textures[1];
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
    this.audit(scene);
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

  /**
   * Anything in the scene whose material writes no marks, said once apiece.
   *
   * Nothing stops one getting in — the editor puts its own objects in the
   * scene — and what it does when it does is quiet: it wears the marks of
   * whatever was drawn behind it. So the pass looks, every frame, and says.
   */
  private audit(scene: THREE.Scene): void {
    scene.traverseVisible(it => {
      const drawn = it as THREE.Object3D & { material?: THREE.Material | THREE.Material[] };

      if (drawn.material === undefined) return;

      for (const m of Array.isArray(drawn.material) ? drawn.material : [drawn.material]) {
        if (marked(m) || this.reported.has(m)) continue;

        this.reported.add(m);
        console.warn(`${m.type} on ${it.type} "${it.name}" writes no marks; see target.ts`);
      }
    });
  }

  dispose(): void {
    this.target.dispose();
    this.bayer.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}
