// -----------------------------------------------------------------------------
// The view
//
// One function, `renderer(element)`, and everything about drawing a world is
// behind it. It owns a canvas, a scene, a camera and the dither pass, and it
// owns nothing else: no input, no game state, no sound, no notion of a level
// being finished. That is the whole reason it is shaped this way — the game
// puts one on the page and the editor puts one in a panel, and neither has to
// know what the other is doing with it.
//
// Two sources, one scene
// ----------------------
// A wall can come from either of two places, and the renderer's job is that
// nobody outside it can tell which:
//
// - **`show`** — the boundary as it stands, handed over as runs. This is what
//   the editor draws while anyone is editing, and it needs no bake: the CSG at
//   the version on screen is something the editor already keeps.
// - **`load` and `walk`** — the bake, moving. This is what the game draws
//   always, and what the editor draws for the length of a transition.
//
// They are the same walls, out of `walls.ts`, and crossing between them shows
// nothing. `walk(null)` hands the view back to whatever `show` last put there.
//
// What moves is one number. `walk` takes a position in the walk from the first
// version to the last, works out which span that lands in and where inside it,
// and writes a uniform. Nothing is rebuilt, nothing is uploaded, and running
// backwards is the same call with a smaller number — which is what the
// decompression artefact needs.
// -----------------------------------------------------------------------------

import * as THREE from 'three';
import { DitherPass } from './dither';
import { Morph, morph } from './morph';
import { still } from './still';
import { Run, Source, WallOptions } from './walls';
import { Floor, Point, World } from './world';

/** World units per editor unit: the editor's grid of 25 is one metre. */
export const SCALE = 1 / 25;

const WALL_HEIGHT = 7;
const TILE_SIZE = 4;

const WALL_COLOR = 0xfdebeb;
const LINE_COLOR = 0x000000;
const FLOOR_COLOR = 0xbbbbbb;

/** What an authored floor is drawn in. Black on the ground's grey, which is
 * the same two the walls and their lines are. */
const SHAPE_COLOR = 0x000000;

/**
 * The floor sits a hair below zero so that anything standing exactly on the
 * ground plane draws over it whatever order the scene happens to be in.
 */
const FLOOR_Y = -0.01;

/** An authored floor sits between the ground and everything standing on it:
 * over the tiles it covers, under the walls that stand on them. */
const SHAPE_Y = FLOOR_Y / 2;

export interface RendererOptions {
  /** Where it starts. Off leaves the scene undithered, which is worth having
   * in the editor where the point is to read the geometry rather than to be
   * somewhere; `dither` turns it over afterwards. */
  dither?: boolean
  /** Device pixels per CSS pixel. The jam build pinned this to 1 and the look
   * depends on it: the dither pattern is in pixels. */
  pixelRatio?: number
  fov?: number
}

export interface Renderer {
  /** Drive it: position, look and projection are all the caller's. */
  readonly camera: THREE.PerspectiveCamera
  /** For anything that wants to put its own objects in — artefacts, a
   * scrubber's marker, whatever the editor decides it wants. */
  readonly scene: THREE.Scene

  /**
   * The level as it stands, in editor units: the boundary as the open runs the
   * CSG hands over, each with the polygon it came off, and the authored floors
   * as the rings they were drawn as.
   *
   * Both together, because both are replaced together and both are hidden
   * together — a span carries walls and floors in one set of buffers and takes
   * the view for the length of a walk. Shown whenever no walk is in flight, and
   * replaced as often as the caller likes: an edit is a rebuild of these
   * buffers and nothing else.
   */
  show(runs: readonly Run[], floors: readonly Floor[]): void

  /** The baked spans, built and held ready. An empty level drops them. */
  load(world: World): void

  /**
   * Where in the walk from the first version to the last, 0 to 1 — or null to
   * hand the view back to `show`.
   *
   * Whatever shape the transition has — eased, held, snapped — is the caller's:
   * the geometry is exact at every instant and easing only chooses which ones
   * get looked at. See *Easing is a runtime concern* in `docs/versioning.md`.
   */
  walk(u: number | null): void

  /** Which two versions a position sits between, for anything that wants the
   * source polygons. */
  between(u: number): [number, number]

  /**
   * Whether the screen-space dither is on.
   *
   * The look belongs to being *in* the level: from above, the pattern is a
   * texture over geometry someone is trying to read, and the editor's panel
   * turns it on at the moment it becomes somewhere to stand.
   */
  dither(on: boolean): void

  resize(): void
  render(): void

  /**
   * The screen with nothing on it.
   *
   * For when there is a camera but nowhere it could honestly be standing —
   * a player inside a wall would otherwise get a look at the level from the
   * outside, which is a view the level does not have.
   */
  blank(): void
  dispose(): void
}

export function renderer(element: HTMLElement, options: RendererOptions = {}): Renderer {
  const renderer = new THREE.WebGLRenderer({ antialias: false });

  renderer.setPixelRatio(options.pixelRatio ?? 1);
  renderer.setClearColor(0x000000);
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  element.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(options.fov ?? 70, 1, 0.1, 200);

  camera.position.set(0, 1.6, 0);

  const dither = new DitherPass(renderer);

  dither.enabled = options.dither ?? true;

  const walls: WallOptions = {
    scale: SCALE,
    wallHeight: WALL_HEIGHT,
    wallColor: WALL_COLOR,
    lineColor: LINE_COLOR,
    fillColor: SHAPE_COLOR,
    fillHeight: SHAPE_Y,
  };

  let standing: Source | null = null;
  let morphs: Morph[] = [];
  let ground: THREE.Object3D[] = [];
  let box: Bounds | null = null;

  /** Which morph is in the scene, and whether it rather than `standing` is
   * what the viewer is looking at. */
  let showing = -1;
  let walking = false;

  /** The scene brought into line with what should be in it. Called after
   * anything that changes either, rather than by each of them, so there is one
   * place that knows what is added and what is not. */
  function reconcile(want: number): void {
    if (want !== showing) {
      const was = morphs[showing];

      if (was !== undefined) scene.remove(was.walls, was.lines, was.fill);

      const now = morphs[want];

      if (now !== undefined) scene.add(now.walls, now.lines, now.fill);

      showing = want;
    }

    // Walls, lines and floors all swap together: the span draws every one of
    // them for the length of a walk, and standing still draws every one of
    // them again.
    if (standing !== null) {
      const wanted = !walking || morphs[showing] === undefined;

      standing.walls.visible = wanted;
      standing.lines.visible = wanted;
      standing.fill.visible = wanted;
    }
  }

  function show(runs: readonly Run[], floors: readonly Floor[]): void {
    if (standing !== null) {
      scene.remove(standing.walls, standing.lines, standing.fill);
      standing.dispose();
    }

    standing = still(runs, floors, walls);
    scene.add(standing.walls, standing.lines, standing.fill);

    grow(bounding([...runs.map(r => r.points), ...floors.map(f => f.points)]));
    reconcile(showing);
  }

  function drop(): void {
    for (const m of morphs) {
      scene.remove(m.walls, m.lines, m.fill);
      m.dispose();
    }

    morphs = [];
    showing = -1;
  }

  function load(next: World): void {
    drop();

    morphs = next.baked.spans.map(span => morph(span, walls));

    for (const version of next.versions) {
      grow(bounding(version.polygons.map(p => p.points)));
    }

    reconcile(-1);
  }

  /**
   * The span `u` lands in, and where inside it.
   *
   * The last span owns its own far end, so that standing at the final version
   * draws it rather than nothing.
   */
  function at(u: number): { span: number, t: number } {
    const n = morphs.length;
    if (n === 0) return { span: -1, t: 0 };

    const x = Math.min(Math.max(u, 0), 1) * n;
    const i = Math.min(Math.floor(x), n - 1);

    return { span: i, t: x - i };
  }

  function walk(u: number | null): void {
    if (u === null) {
      walking = false;
      reconcile(-1);
      return;
    }

    const { span, t } = at(u);

    walking = true;
    reconcile(span);
    morphs[span]?.seek(t);
  }

  /** The floor covers everything anything has ever asked to be drawn, and
   * grows rather than being recomputed: a floor that resized itself every time
   * a wall moved would shimmer under geometry that was standing still. */
  function grow(next: Bounds | null): void {
    if (next === null) return;

    const merged = box === null ? next : union(box, next);
    const snapped = snap(merged);

    if (box !== null && same(snap(box), snapped)) {
      box = merged;
      return;
    }

    box = merged;

    for (const g of ground) {
      scene.remove(g);

      const it = g as THREE.Mesh;

      it.geometry?.dispose();
      (it.material as THREE.Material | undefined)?.dispose();
    }

    ground = floor(snapped);

    for (const g of ground) scene.add(g);
  }

  function resize(): void {
    const width = element.clientWidth || 1;
    const height = element.clientHeight || 1;

    renderer.setSize(width, height, false);
    dither.setSize(width * renderer.getPixelRatio(), height * renderer.getPixelRatio());

    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  // The editor's panel changes size without the window doing anything, and the
  // game's page does the opposite. One observer answers both.
  const watching = new ResizeObserver(resize);

  watching.observe(element);
  resize();

  // Something has to be underfoot before anything has been shown, or an empty
  // panel is a void rather than a room with nothing in it yet.
  ground = floor(null);

  for (const g of ground) scene.add(g);

  return {
    camera,
    scene,
    show,
    load,
    walk,

    dither(on: boolean): void {
      dither.enabled = on;
    },

    between(u: number): [number, number] {
      const { span } = at(u);

      return span < 0 ? [0, 0] : [span, span + 1];
    },

    resize,
    render(): void {
      dither.apply(scene, camera);
    },

    blank(): void {
      renderer.setRenderTarget(null);
      renderer.clear();
    },

    dispose(): void {
      watching.disconnect();
      drop();

      if (standing !== null) {
        scene.remove(standing.walls, standing.lines, standing.fill);
        standing.dispose();
      }

      standing = null;
      dither.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

// -----------------------------------------------------------------------------
// The ground
//
// A grid of tiles under everything, big enough to cover whatever has been shown
// and snapped outward to a tile boundary. It is not the floor of any room — the
// rooms have no floor, they have walls standing on this — which is why it can
// be built once and left alone while the walls move over it.
// -----------------------------------------------------------------------------

interface Bounds {
  minX: number
  minZ: number
  maxX: number
  maxZ: number
}

/** In world units, from anything in editor ones. */
function bounding(runs: readonly (readonly Point[])[]): Bounds | null {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;

  for (const run of runs) {
    for (const p of run) {
      minX = Math.min(minX, p.x * SCALE);
      maxX = Math.max(maxX, p.x * SCALE);
      minZ = Math.min(minZ, p.y * SCALE);
      maxZ = Math.max(maxZ, p.y * SCALE);
    }
  }

  return isFinite(minX) ? { minX, minZ, maxX, maxZ } : null;
}

function union(a: Bounds, b: Bounds): Bounds {
  return {
    minX: Math.min(a.minX, b.minX),
    minZ: Math.min(a.minZ, b.minZ),
    maxX: Math.max(a.maxX, b.maxX),
    maxZ: Math.max(a.maxZ, b.maxZ),
  };
}

function same(a: Bounds, b: Bounds): boolean {
  return a.minX === b.minX && a.minZ === b.minZ && a.maxX === b.maxX && a.maxZ === b.maxZ;
}

function snap(b: Bounds): Bounds {
  return {
    minX: Math.floor(b.minX / TILE_SIZE) * TILE_SIZE - TILE_SIZE,
    minZ: Math.floor(b.minZ / TILE_SIZE) * TILE_SIZE - TILE_SIZE,
    maxX: Math.ceil(b.maxX / TILE_SIZE) * TILE_SIZE + TILE_SIZE,
    maxZ: Math.ceil(b.maxZ / TILE_SIZE) * TILE_SIZE + TILE_SIZE,
  };
}

const EMPTY_BOUNDS: Bounds = {
  minX: -TILE_SIZE,
  minZ: -TILE_SIZE,
  maxX: TILE_SIZE,
  maxZ: TILE_SIZE,
};

function floor(b: Bounds | null): THREE.Object3D[] {
  const box = b ?? EMPTY_BOUNDS;

  const surface = new THREE.Mesh(
    new THREE.PlaneGeometry(box.maxX - box.minX, box.maxZ - box.minZ),
    new THREE.MeshBasicMaterial({
      color: FLOOR_COLOR,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    }),
  );

  surface.rotation.x = -Math.PI / 2;
  surface.position.set((box.minX + box.maxX) / 2, FLOOR_Y, (box.minZ + box.maxZ) / 2);

  const grid: number[] = [];

  for (let z = box.minZ; z <= box.maxZ + 1e-6; z += TILE_SIZE) {
    grid.push(box.minX, FLOOR_Y, z, box.maxX, FLOOR_Y, z);
  }

  for (let x = box.minX; x <= box.maxX + 1e-6; x += TILE_SIZE) {
    grid.push(x, FLOOR_Y, box.minZ, x, FLOOR_Y, box.maxZ);
  }

  const geometry = new THREE.BufferGeometry();

  geometry.setAttribute('position', new THREE.Float32BufferAttribute(grid, 3));

  const lines = new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({ color: LINE_COLOR }),
  );

  return [surface, lines];
}
