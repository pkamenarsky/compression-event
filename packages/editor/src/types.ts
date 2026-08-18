import { Point, PolygonType } from '@ce/game/world';
import { AABB } from './aabb';

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
  translation: { x: number, y: number }
  scale: { x: number, y: number }
  erosion: number
  rotation: number
}

export const EMPTY_TRANSFORM: Transform = {
  translation: { x: 0, y: 0 },
  scale: { x: 0, y: 0 },
  erosion: 0,
  rotation: 0
};

export interface Polygon {
  type: PolygonType
  points: Point
  origin: Point
  transform: Transform
  aabb: AABB
}

export interface Group {
  type: 'group'
  children: (PolygonId | Group)[]
  transform: Transform
  aabb: AABB
}

export interface Version {
  children: (PolygonId | Group)[]
}

type PolygonId = number;

export interface World {
  sourcePolygons: Map<PolygonId, Polygon>
  nextId: PolygonId

  versions: Version[]
}

export const EMPTY_WORLD: World = {
  sourcePolygons: new Map(),
  nextId: 0,

  versions: []
};

/**
 * Everything the editor is. Immutable throughout: a field that did not change
 * keeps its identity, which is what lets `object` wake only the parts that
 * care — panning touches `view` and nothing redraws but the canvas.
 */
export interface EditorState {
  world: World
  currentVersion: number

  settings: Settings
  view: View
  tool: Tool
}

/** Everything that writes to the store goes through one of these. */
export type Update = (fn: (s: EditorState) => EditorState) => void;

export function initialState(world: World): EditorState {
  return {
    world,
    currentVersion: 0,
    settings: defaultSettings,
    view: defaultView,
    tool: 'point',
  };
}
