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
  selection: PolygonId[]

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
}

/** Everything that writes to the store goes through one of these. */
export type Update = (fn: (s: EditorState) => EditorState) => void;

export function initialState(world: World): EditorState {
  return {
    world,
    currentVersion: 0,
    selection: [],
    settings: defaultSettings,
    view: defaultView,
    tool: 'point',
    bake: { spans: new Map(), progress: null },
  };
}
