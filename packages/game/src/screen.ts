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
import type { RenderConfig } from './config';
import { bayer, bayerTexture, nudge, quantise } from './dither';
import { marked, read } from './target';
import { blur, warp } from './warp';

/** One stage of the pass: its GLSL, the uniforms that GLSL declares with where
 * they start, and how its part of the render config sets them. */
export interface Stage {
  glsl: string
  uniforms: () => Record<string, THREE.IUniform>
  apply?: (u: Record<string, THREE.IUniform>, config: RenderConfig) => void
}

/** The pass, in order. See the header. */
const STAGES: Stage[] = [read, warp, blur, bayer, nudge, stipple, quantise];

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

  /** Whether the view wants quantising, whatever the config says — see
   * `quantise`. */
  private looking = true;

  private config: RenderConfig | null = null;

  /** Materials already reported for not writing marks, so each is said once. */
  private reported = new WeakSet<THREE.Material>();

  constructor(private renderer: THREE.WebGLRenderer) {
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

    this.u = Object.assign(
      { uResolution: { value: new THREE.Vector2(width, height) } },
      ...STAGES.map(s => s.uniforms()),
    );

    this.u.uScene.value = this.target.textures[0];
    this.u.uMarks.value = this.target.textures[1];
    this.u.uBayer.value = this.bayer;
    this.u.uAspect.value = width / height;

    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader: [...STAGES.map(s => s.glsl), main].join('\n'),
      uniforms: this.u,
      depthTest: false,
      depthWrite: false,
    });

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  /** Whether the view wants the colour quantised on the way out, on top of
   * the config wanting it. Off is the editor looking down on a level. */
  set quantised(on: boolean) {
    this.looking = on;
    if (this.config !== null) this.configure(this.config);
  }

  /** Every stage set from its part of `config`. */
  configure(config: RenderConfig): void {
    this.config = config;

    for (const s of STAGES) s.apply?.(this.u, config);

    this.u.uQuantise.value = this.u.uQuantise.value && this.looking;
  }

  setSize(width: number, height: number): void {
    this.target.setSize(width, height);
    this.u.uResolution.value.set(width, height);
    this.u.uAspect.value = width / height;
  }

  /** How far the level is closing, signed, and a clock in seconds — the two
   * things that move the warp and the blur from one frame to the next. Left
   * at zero, the pass reads the scene exactly where it is. */
  drive(amount: number, time: number): void {
    this.u.uAmount.value = amount;
    this.u.uTime.value = time;
  }

  /**
   * The scene drawn into the target and not put on screen.
   *
   * For getting things onto the GPU before they are wanted: three uploads a
   * mesh's buffers and textures, and compiles its program, the first time it
   * is drawn, and the first time should not be a frame anyone is watching.
   * Into the target rather than anywhere else, because what a program is
   * compiled for depends on what it is drawn into.
   */
  prime(scene: THREE.Scene, camera: THREE.Camera): void {
    this.renderer.setRenderTarget(this.target);
    this.renderer.clear();
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);
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
