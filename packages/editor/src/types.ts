import { Point, PolygonType } from '@ce/game/world';
import type { Bake } from './bake';

export type { Point, PolygonType };

// -----------------------------------------------------------------------------
// Settings — what the editor does, rather than what the world is
// -----------------------------------------------------------------------------

export interface Settings {
  /** World units between two grid dots. */
  gridSize: number
  showGrid: boolean
  snapToGrid: boolean
}

export const defaultSettings: Settings = {
  gridSize: 32,
  showGrid: true,
  snapToGrid: true,
};

// -----------------------------------------------------------------------------
// Tools
// -----------------------------------------------------------------------------

export type Tool = 'point' | 'path' | 'artefact' | 'polygon';

// -----------------------------------------------------------------------------
// View — the window onto the world
//
// Which world point sits at the canvas' top-left corner, how many CSS pixels a
// world unit is worth, and how big the canvas currently is. The size lives here
// rather than being read off the element so that a resize is an update like any
// other, and the draw wakes for it the same way it wakes for a pan.
// -----------------------------------------------------------------------------

export interface View {
  x: number
  y: number
  /** CSS pixels per world unit. */
  zoom: number
  width: number
  height: number
  /** Device pixels per CSS pixel. */
  dpr: number
}

export const defaultView: View = {
  x: 0,
  y: 0,
  zoom: 1,
  width: 0,
  height: 0,
  dpr: 1,
};

export function toScreen(view: View, p: Point): Point {
  return {
    x: (p.x - view.x) * view.zoom,
    y: (p.y - view.y) * view.zoom,
  };
}

export function toWorld(view: View, p: Point): Point {
  return {
    x: p.x / view.zoom + view.x,
    y: p.y / view.zoom + view.y,
  };
}

/** Drag the world along with a screen-space delta. */
export function panBy(view: View, dx: number, dy: number): View {
  return {
    ...view,
    x: view.x - dx / view.zoom,
    y: view.y - dy / view.zoom,
  };
}

/**
 * A new size for the canvas. The first measurement is also where the world
 * origin gets put in view, since until then there was no view to speak of.
 */
export function resized(view: View, width: number, height: number, dpr: number): View {
  const first = view.width === 0 || view.height === 0;

  return {
    ...view,
    width,
    height,
    dpr,
    x: first ? -width / (2 * view.zoom) : view.x,
    y: first ? -height / (2 * view.zoom) : view.y,
  };
}

// -----------------------------------------------------------------------------
// The store
// -----------------------------------------------------------------------------

export interface Transform {
  translation: Point
  rotation: number
  /**
   * Per axis. Identity is 1, and a zero axis is refused: it is not invertible
   * and there is no geometry on the far side of it worth having.
   *
   * Nothing accumulates a transform — each version applies its own to what the
   * one before it produced — so nothing has to commute with eroding, which is
   * the whole reason this was uniform before.
   */
  scale: { x: number, y: number }
  /** How far each edge has moved inward in the projection. */
  erosion: number
}

export const EMPTY_TRANSFORM: Transform = {
  translation: { x: 0, y: 0 },
  rotation: 0,
  scale: { x: 1, y: 1 },
  erosion: 0,
};

// -----------------------------------------------------------------------------
// Identities
//
// All three come from one counter on `World`, so an id is unique across the
// document and can never be confused for another kind. Everything a version's
// layer names, it names by id: an edit keyed by array index re-points at the
// wrong thing the moment something upstream is inserted.
// -----------------------------------------------------------------------------

export type PolygonId = number;
export type VertexId = number;
export type VersionId = number;

/** A corner, and where it was put when it was drawn. */
export interface Vertex {
  id: VertexId
  at: Point
}

/**
 * The points as they were laid down, and nothing else. What has happened to
 * them since belongs to the versions, one layer at a time — a polygon carries
 * no transform of its own, because there is no version at which it would be the
 * right one.
 *
 * `points` is ordered, because winding matters. Two vertices resolving to the
 * same position are still distinct ids; coincidence is emergent, never
 * declared.
 */
export interface Polygon {
  type: PolygonType
  /** The version whose layer introduced it. Nothing before it may name it. */
  birth: VersionId
  points: Vertex[]
}

/**
 * What one version does to one polygon.
 *
 * `vertices` holds displacements against the geometry the base resolved to, in
 * the frame before this version's transform, so an edit turns with its polygon
 * when an upstream version moves it. They land on the source ring, always:
 * erosion is a projection taken afterwards and what it projects to has no
 * handles to drag.
 */
export interface Edit {
  transform: Transform
  vertices: Map<VertexId, Point>
}

/**
 * A version is a layer, not a copy. It stores what changed against its base and
 * resolves against it on demand, so an edit to an early version is seen by
 * every later one without being replayed by hand into any of them.
 *
 * `base` is a field rather than an assumption that it is `N - 1`, which is what
 * would make forks free. There are none yet.
 *
 * A new version has no edits at all, so it renders identically to its base
 * until touched. There is nothing to diff and nothing to reconcile.
 */
export interface Version {
  name: string
  base: VersionId | null
  /** Whether it draws as a ghost while another version is the one on screen. */
  visible: boolean
  edits: Map<PolygonId, Edit>
}

export interface World {
  polygons: Map<PolygonId, Polygon>
  /** One counter for every kind of id. */
  nextId: number
  versions: Version[]
}

/** Long enough to author a shrink sequence against, short enough to fit down
 * the side of the window without a scrollbar. */
export const VERSIONS = 5;

export function emptyWorld(): World {
  return {
    polygons: new Map(),
    nextId: 0,

    versions: Array.from({ length: VERSIONS }, (_unused, i) => ({
      name: `v${i}`,
      base: i === 0 ? null : i - 1,
      visible: true,
      edits: new Map(),
    })),
  };
}

/**
 * What the next thing done applies to.
 *
 * Two lists rather than one, because the two tools ask different questions and
 * both answers are worth keeping: going to the points to nudge a corner and
 * coming back should not have thrown away which rooms were picked.
 */
export interface Selection {
  polygons: PolygonId[]
  vertices: VertexId[]
}

export const EMPTY_SELECTION: Selection = { polygons: [], vertices: [] };

/** `more` added to `some`, keeping what was already there and its order. */
export function alsoPicked(some: readonly number[], more: readonly number[]): number[] {
  const has = new Set(some);

  return [...some, ...more.filter(id => !has.has(id))];
}

/** The same, except that anything already picked is let go: a shift-click on
 * something is how it comes out of a selection everywhere. */
export function togglePicked(some: readonly number[], id: number): number[] {
  return some.includes(id) ? some.filter(x => x !== id) : [...some, id];
}

/**
 * A polygon lifted out of the world, ready to be put back.
 *
 * Its ring in world units as it resolved when it was taken, rather than the id
 * it was taken from: a paste has to work after the original has been changed,
 * or deleted, or the file reloaded. What comes back is a new polygon born into
 * whatever version is on screen, which is the only kind this editor has.
 */
export interface Clipping {
  type: PolygonType
  points: Point[]
  erosion: number
}

// -----------------------------------------------------------------------------
// Undo
//
// Whole worlds rather than diffs. Everything here is persistent, so a version
// nothing touched is the same object in every entry and a step back costs a
// pointer; what it costs instead is nothing at all to think about, since there
// is no inverse to write per kind of edit and none to keep in step as more
// arrive.
//
// A drag writes a world per pointer move and not one of those is a step. So the
// history is not written by whoever changes the world — it is written by
// whoever finishes doing so, handing over the world as it was when they
// started. See `marked`.
// -----------------------------------------------------------------------------

export interface History {
  past: World[]
  future: World[]
}

export const EMPTY_HISTORY: History = { past: [], future: [] };

/** Deep enough to cover an afternoon's fiddling, short enough that the worlds
 * held do not add up to anything. */
const DEPTH = 200;

/**
 * `was` becomes the world undo comes back to.
 *
 * Called at the end of everything that may have changed the world, including
 * the gestures that turn out not to have: a press that moved nothing is not a
 * step, and comparing is cheaper here than deciding at every call site.
 */
export function marked(s: EditorState, was: World): EditorState {
  if (s.world === was) return s;

  return {
    ...s,
    history: { past: [...s.history.past, was].slice(-DEPTH), future: [] },
  };
}

export function undone(s: EditorState): EditorState {
  const { past, future } = s.history;

  if (past.length === 0) return s;

  return settled({
    ...s,
    world: past[past.length - 1],
    history: { past: past.slice(0, -1), future: [...future, s.world] },
  });
}

export function redone(s: EditorState): EditorState {
  const { past, future } = s.history;

  if (future.length === 0) return s;

  return settled({
    ...s,
    world: future[future.length - 1],
    history: { past: [...past, s.world], future: future.slice(0, -1) },
  });
}

/** The selection with anything the world no longer has dropped: stepping back
 * past the birth of a polygon leaves it picked and gone. */
function settled(s: EditorState): EditorState {
  const corners = new Set<VertexId>();

  for (const p of s.world.polygons.values()) {
    for (const v of p.points) corners.add(v.id);
  }

  return {
    ...s,
    selection: {
      polygons: s.selection.polygons.filter(id => s.world.polygons.has(id)),
      vertices: s.selection.vertices.filter(id => corners.has(id)),
    },
  };
}

/**
 * Everything the editor is. Immutable throughout: a field that did not change
 * keeps its identity, which is what lets `object` wake only the parts that
 * care — panning touches `view` and nothing redraws but the canvas.
 */
export interface EditorState {
  world: World
  /** The version being edited. Every edit lands in this one and flows forward
   * from it; there is no way to author one that lands earlier. */
  currentVersion: VersionId
  /** What the next transform applies to. */
  selection: Selection

  settings: Settings
  view: View
  tool: Tool

  /**
   * What the game would be shipped, for the spans that have been baked. It is
   * derived from the world, but it is expensive enough to be worth keeping and
   * cheap enough to throw away: a span holds the world it was baked against, so
   * an edit invalidates it rather than having to update it. See `bake.ts`.
   */
  bake: Bake

  /** Where undo goes. Not in the file: it is about this sitting rather than
   * about the world, and reloading one is a fresh start by definition. */
  history: History
  /** What was last copied. Also not in the file, and for the same reason. */
  clipboard: Clipping[]
}

/** Everything that writes to the store goes through one of these. */
export type Update = (fn: (s: EditorState) => EditorState) => void;

export function initialState(world: World): EditorState {
  return {
    world,
    currentVersion: 0,
    selection: EMPTY_SELECTION,
    settings: defaultSettings,
    view: defaultView,
    tool: 'point',
    bake: { spans: new Map(), progress: null },
    history: EMPTY_HISTORY,
    clipboard: [],
  };
}
