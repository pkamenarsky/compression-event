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
// What moves is one number. `seek` takes a position in the walk from the first
// version to the last, works out which span that lands in and where inside it,
// and writes a uniform. Nothing is rebuilt, nothing is uploaded, and running
// backwards is the same call with a smaller number — which is what the
// decompression artefact needs.
// -----------------------------------------------------------------------------

import * as THREE from 'three';
import { DitherPass } from './dither';
import { Morph, morph } from './morph';
import { Point, World, emptyWorld } from './world';

/** World units per editor unit: the editor's grid of 25 is one metre. */
export const SCALE = 1 / 25;

const WALL_HEIGHT = 7;
const TILE_SIZE = 4;

const WALL_COLOR = 0xfdebeb;
const LINE_COLOR = 0x000000;
const FLOOR_COLOR = 0xbbbbbb;

/**
 * The floor sits a hair below zero so that anything standing exactly on the
 * ground plane draws over it whatever order the scene happens to be in.
 */
const FLOOR_Y = -0.01;

export interface RendererOptions {
  /** Off leaves the scene undithered, which is worth having in the editor
   * where the point is to read the geometry rather than to be somewhere. */
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

  load(world: World): void
  /**
   * Where in the walk from the first version to the last, 0 to 1.
   *
   * Whatever shape the transition has — eased, held, snapped — is the caller's:
   * the geometry is exact at every instant and easing only chooses which ones
   * get looked at. See *Easing is a runtime concern* in `docs/versioning.md`.
   */
  seek(u: number): void
  /** Which version the caller is standing in, for anything that wants the
   * source polygons: the two either side of `seek`. */
  between(u: number): [number, number]

  resize(): void
  render(): void
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

  let world = emptyWorld();
  let morphs: Morph[] = [];
  let ground: THREE.Object3D[] = [];
  let showing = -1;

  function clear(): void {
    for (const m of morphs) {
      scene.remove(m.walls, m.lines);
      m.dispose();
    }

    for (const g of ground) {
      scene.remove(g);

      const it = g as THREE.Mesh;

      it.geometry?.dispose();
      (it.material as THREE.Material | undefined)?.dispose();
    }

    morphs = [];
    ground = [];
    showing = -1;
  }

  function load(next: World): void {
    clear();

    world = next;
    ground = floor(bounds(next));

    for (const g of ground) scene.add(g);

    morphs = next.baked.spans.map(span => morph(span, {
      scale: SCALE,
      wallHeight: WALL_HEIGHT,
      wallColor: WALL_COLOR,
      lineColor: LINE_COLOR,
    }));

    // Nothing is added to the scene until it is the span being shown: a level's
    // worth of spans is a level's worth of geometry, and all but one of them is
    // somewhere else in time.
    seek(0);
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

  function seek(u: number): void {
    const { span, t } = at(u);

    if (span !== showing) {
      const was = morphs[showing];
      const now = morphs[span];

      if (was !== undefined) scene.remove(was.walls, was.lines);
      if (now !== undefined) scene.add(now.walls, now.lines);

      showing = span;
    }

    morphs[span]?.seek(t);
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

  return {
    camera,
    scene,
    load,
    seek,

    between(u: number): [number, number] {
      const { span } = at(u);

      return span < 0 ? [0, 0] : [span, span + 1];
    },

    resize,
    render(): void {
      dither.apply(scene, camera);
    },

    dispose(): void {
      watching.disconnect();
      clear();
      dither.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

// -----------------------------------------------------------------------------
// The ground
//
// A grid of tiles under everything, big enough to cover every version of the
// level and snapped outward to a tile boundary. It is not the floor of any
// room — the rooms have no floor, they have walls standing on this — which is
// why it can be built once and left alone while the walls move over it.
// -----------------------------------------------------------------------------

interface Bounds {
  minX: number
  minZ: number
  maxX: number
  maxZ: number
}

function bounds(world: World): Bounds {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;

  for (const version of world.versions) {
    for (const polygon of version.polygons) {
      for (const p of polygon.points) {
        minX = Math.min(minX, p.x * SCALE);
        maxX = Math.max(maxX, p.x * SCALE);
        minZ = Math.min(minZ, p.y * SCALE);
        maxZ = Math.max(maxZ, p.y * SCALE);
      }
    }
  }

  if (!isFinite(minX)) {
    return { minX: -TILE_SIZE, minZ: -TILE_SIZE, maxX: TILE_SIZE, maxZ: TILE_SIZE };
  }

  return {
    minX: Math.floor(minX / TILE_SIZE) * TILE_SIZE - TILE_SIZE,
    minZ: Math.floor(minZ / TILE_SIZE) * TILE_SIZE - TILE_SIZE,
    maxX: Math.ceil(maxX / TILE_SIZE) * TILE_SIZE + TILE_SIZE,
    maxZ: Math.ceil(maxZ / TILE_SIZE) * TILE_SIZE + TILE_SIZE,
  };
}

function floor(b: Bounds): THREE.Object3D[] {
  const surface = new THREE.Mesh(
    new THREE.PlaneGeometry(b.maxX - b.minX, b.maxZ - b.minZ),
    new THREE.MeshBasicMaterial({
      color: FLOOR_COLOR,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    }),
  );

  surface.rotation.x = -Math.PI / 2;
  surface.position.set((b.minX + b.maxX) / 2, FLOOR_Y, (b.minZ + b.maxZ) / 2);

  const grid: number[] = [];

  for (let z = b.minZ; z <= b.maxZ + 1e-6; z += TILE_SIZE) {
    grid.push(b.minX, FLOOR_Y, z, b.maxX, FLOOR_Y, z);
  }

  for (let x = b.minX; x <= b.maxX + 1e-6; x += TILE_SIZE) {
    grid.push(x, FLOOR_Y, b.minZ, x, FLOOR_Y, b.maxZ);
  }

  const geometry = new THREE.BufferGeometry();

  geometry.setAttribute('position', new THREE.Float32BufferAttribute(grid, 3));

  const lines = new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({ color: LINE_COLOR }),
  );

  return [surface, lines];
}
