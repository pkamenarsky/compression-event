// -----------------------------------------------------------------------------
// The view
//
// One function, `renderer(element)`, and everything about drawing a world is
// behind it. It owns a canvas, a scene, a camera and the screen pass, and it
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
import { RenderConfig, current } from './config';
import { ScreenPass } from './screen';
import { sky } from './sky';
import { Morph, morph } from './morph';
import { still } from './still';
import { flat } from './target';
import { Run, Source, WallOptions } from './walls';
import { Floor, Point, SCALE, TILE_SIZE, World } from './world';

const WALL_HEIGHT = 7;

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
  /** Where it starts. Off leaves the colour unquantised, which is worth
   * having in the editor where the point is to read the geometry rather than to
   * be somewhere; `dither` turns it over afterwards. Either way the scene goes
   * through the same target and the same pass — see `screen.ts`. */
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

  /**
   * The baked spans, built and held ready, and every version's walls as they
   * stand, built once for `stand`. An empty level drops them.
   */
  load(world: World): void

  /**
   * The walls at version `v` as they stand, out of what `load` built. The
   * game's way of standing still at a version, which it does after every
   * shift: nothing is built, and nothing was built on the frame it arrived.
   *
   * Not the walk at rest at the end of a span, though that is the same
   * outline. A span carries every point it needs at any instant, and at its
   * ends some of them sit exactly on a straight wall — a room turning into
   * line with a corridor — which a vertical line then stands on. The walls as
   * they stand have only the corners.
   */
  stand(v: number): void

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
   * Whether the screen pass quantises. The walls' own pattern stays either
   * way: it is part of what a wall looks like, dithered or not.
   *
   * The look belongs to being *in* the level: from above, the pattern is a
   * texture over geometry someone is trying to read, and the editor's panel
   * turns it on at the moment it becomes somewhere to stand.
   */
  dither(on: boolean): void

  /** How the picture is made — which stages run, and their numbers. See
   * `config.ts`. Starts at the one last in force in this browser. */
  configure(config: RenderConfig): void

  /** How far the level is closing (signed, 0 is not at all) and a clock in
   * seconds, which is what moves the warp and the blur. Only the game calls
   * this. */
  drive(amount: number, time: number): void

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
  // Stencil because the floors are filled by counting into it rather than by
  // being cut into triangles. See the header of `walls.ts`. Three does not ask
  // for one by default and there is no getting one afterwards.
  const renderer = new THREE.WebGLRenderer({ antialias: false, stencil: true });

  renderer.setPixelRatio(options.pixelRatio ?? 1);
  renderer.setClearColor(0x000000);
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  element.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(options.fov ?? 70, 1, 0.1, 200);

  camera.position.set(0, 1.6, 0);

  const screen = new ScreenPass(renderer);
  const meter = fps(element);

  screen.configure(current());
  screen.quantised = options.dither ?? true;

  const overhead = sky();

  overhead.configure(current());
  scene.add(overhead.mesh);

  const walls: WallOptions = {
    scale: SCALE,
    wallHeight: WALL_HEIGHT,
    wallColor: WALL_COLOR,
    lineColor: LINE_COLOR,
    fillColor: SHAPE_COLOR,
    fillHeight: SHAPE_Y,
  };

  /** Whatever walls are up while nothing is walking: the last `show`, or one
   * of `stills`. */
  let standing: Source | null = null;

  /** What `show` last built, which is this renderer's to throw away. */
  let shown: Source | null = null;

  /** Every version's walls as they stand, from `load`, by version. */
  let stills: Source[] = [];

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

  /** `next` up as the walls standing, and whatever was up taken down. */
  function put(next: Source | null): void {
    if (next === standing) return;

    if (standing !== null) scene.remove(standing.walls, standing.lines, standing.fill);

    standing = next;

    if (standing !== null) scene.add(standing.walls, standing.lines, standing.fill);

    reconcile(showing);
  }

  function show(runs: readonly Run[], floors: readonly Floor[]): void {
    const was = shown;

    shown = still(runs, floors, walls);
    put(shown);
    was?.dispose();

    grow(bounding([...runs.map(r => r.points), ...floors.map(f => f.points)]));
  }

  function stand(v: number): void {
    walk(null);
    put(stills[v] ?? null);
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

    if (standing !== null && stills.includes(standing)) put(null);

    for (const it of stills) it.dispose();

    stills = next.versions.map(v => still(runs(v), v.floors ?? [], walls));
    morphs = next.baked.spans.map(span => morph(span, walls));

    for (const version of next.versions) {
      grow(bounding(version.polygons.map(p => p.points)));
    }

    warm();
    reconcile(-1);
  }

  /**
   * Every span and every version's walls drawn once, out of sight, as soon
   * as they are held.
   *
   * A span is otherwise drawn for the first time at the start of its own
   * shift — and a run plays each once, in order, so every shift of a first run
   * was a first draw: its buffers and float tables uploaded, and on the first
   * shift its programs compiled, in the frame the level began to move. The
   * walls a shift arrives at, likewise, on the frame it lands. A laptop hid
   * that inside the frame; a phone did not. Nothing in either is ever culled,
   * so one draw with all of them in the scene reaches all of it.
   */
  function warm(): void {
    const all = [...morphs, ...stills.filter(it => it !== standing)];

    if (all.length === 0) return;

    for (const m of all) scene.add(m.walls, m.lines, m.fill);

    screen.prime(scene, camera);

    for (const m of all) scene.remove(m.walls, m.lines, m.fill);
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
    screen.setSize(width * renderer.getPixelRatio(), height * renderer.getPixelRatio());

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
    stand,
    walk,

    dither(on: boolean): void {
      screen.quantised = on;
    },

    configure(config: RenderConfig): void {
      screen.configure(config);
      overhead.configure(config);
    },

    drive(amount: number, time: number): void {
      screen.drive(amount, time);
    },

    between(u: number): [number, number] {
      const { span } = at(u);

      return span < 0 ? [0, 0] : [span, span + 1];
    },

    resize,
    render(): void {
      overhead.follow(camera, performance.now() / 1000);
      screen.apply(scene, camera);
      meter.tick();
    },

    blank(): void {
      renderer.setRenderTarget(null);
      renderer.clear();
      meter.tick();
    },

    dispose(): void {
      watching.disconnect();
      drop();
      put(null);
      shown?.dispose();
      shown = null;

      for (const it of stills) it.dispose();

      stills = [];
      scene.remove(overhead.mesh);
      overhead.dispose();
      screen.dispose();
      meter.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

/**
 * A version's rings as the wall builder wants them: open runs of points.
 *
 * A ring is closed by repeating its first point, because a wall is a
 * consecutive pair and the pair joining the last corner to the first is a wall
 * like any other. Every corner is a real one — these are the union's own rings
 * rather than one polygon's share of an outline — so every one of them gets its
 * vertical line.
 */
function runs(version: World['versions'][number]): Run[] {
  return version.polygons
    .filter(p => p.points.length >= 3)
    .map(p => {
      const points: Point[] = p.points.map(q => ({ x: q.x, y: q.y }));

      points.push(points[0]);

      return { points, corner: points.map(() => true) };
    });
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
    flat(FLOOR_COLOR, {
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
    flat(LINE_COLOR),
  );

  return [surface, lines];
}

// -----------------------------------------------------------------------------
// The frame rate
//
// Frames drawn per second, in the corner opposite the game's own line: counted
// over half a second at a time, which is long enough to be readable and short
// enough that a hitch shows. Beside it, the longest gap between two frames in
// that time — a dropped frame is a gap of two, and says so where an average
// of 58 only hints at it.
//
// Timed off the frame, not off the clock at the moment of drawing. A frame's
// time is when the display began it, the same number `requestAnimationFrame`
// is handed; `performance.now()` after the drawing is that plus however long
// the drawing took, and a frame that took a few milliseconds longer than the
// last read as the frames coming further apart — a morph changes how much
// work a frame is, so it moved the number whether or not a frame was missed.
// -----------------------------------------------------------------------------

/** How often the number is brought up to date, in milliseconds. */
const METERED = 500;

/** When the frame being drawn began. Outside an animation frame there is no
 * such time, and now is the nearest thing to it. */
function framed(): number {
  const at = document.timeline.currentTime;

  return typeof at === 'number' ? at : performance.now();
}

function fps(host: HTMLElement): { tick(): void, dispose(): void } {
  const shown = document.createElement('div');

  shown.style.cssText = `
    position: absolute; right: 8px; top: 8px;
    color: #7f7; font: 11px ui-monospace, monospace;
    z-index: 9; pointer-events: none;
  `;

  // Absolutely placed against the host, which has to be a box to be placed in.
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

  host.append(shown);

  let since = framed();
  let last = since;
  let frames = 0;
  let longest = 0;

  return {
    tick(): void {
      const now = framed();

      // Drawn twice in one frame is one frame.
      if (now === last) return;

      frames++;
      longest = Math.max(longest, now - last);
      last = now;

      if (now - since < METERED) return;

      shown.textContent = `${Math.round(frames * 1000 / (now - since))} fps  ${Math.round(longest)}ms`;
      since = now;
      frames = 0;
      longest = 0;
    },

    dispose(): void {
      shown.remove();
    },
  };
}
