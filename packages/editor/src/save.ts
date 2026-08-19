// -----------------------------------------------------------------------------
// The editor state, as a file
//
// Mostly so that a world that is behaving oddly can be handed over as it is,
// rather than described. A screenshot says something is wrong; this says what
// with.
//
// `Map` does not survive `JSON.stringify`, so the polygons go out as pairs and
// come back through `new Map`. The format carries a number: a file that does
// not match is refused rather than half-read into a world that then makes no
// sense.
// -----------------------------------------------------------------------------

import {
  Edit,
  EditorState,
  Polygon,
  PolygonId,
  Settings,
  Tool,
  Transform,
  Version,
  VersionId,
  VertexId,
  View,
  Point,
} from './types';

/**
 * 3: a polygon is points and nothing else, and what happens to them belongs to
 * the versions. A format-2 file has a transform per polygon with no version to
 * put it in, and nudges applied after an erosion that no longer exists, so
 * there is nothing sensible to read it as.
 */
export const FORMAT = 3;

export interface Saved {
  format: number
  tool: Tool
  currentVersion: VersionId
  selection: PolygonId[]
  settings: Settings
  view: View
  world: {
    nextId: number
    /** Entries rather than a map, which is all `JSON` will take. */
    polygons: [PolygonId, Polygon][]
    versions: SavedVersion[]
  }
}

/** A version with its two maps written out as entries. */
export interface SavedVersion {
  name: string
  base: VersionId | null
  visible: boolean
  edits: [PolygonId, SavedEdit][]
}

export interface SavedEdit {
  transform: Transform
  vertices: [VertexId, Point][]
}

export function saved(state: EditorState): Saved {
  return {
    format: FORMAT,
    tool: state.tool,
    currentVersion: state.currentVersion,
    selection: state.selection,
    settings: state.settings,
    view: state.view,
    world: {
      nextId: state.world.nextId,
      polygons: [...state.world.polygons],
      versions: state.world.versions.map(savedVersion),
    },
  };
}

function savedVersion(v: Version): SavedVersion {
  return {
    name: v.name,
    base: v.base,
    visible: v.visible,
    edits: [...v.edits].map(([id, e]) => [
      id,
      { transform: e.transform, vertices: [...e.vertices] },
    ]),
  };
}

export function restored(file: Saved): EditorState {
  if (file.format !== FORMAT) {
    throw new Error(`state file is format ${file.format}, and this reads ${FORMAT}`);
  }

  return {
    world: {
      polygons: new Map(file.world.polygons),
      nextId: file.world.nextId,
      versions: file.world.versions.map(restoredVersion),
    },
    currentVersion: file.currentVersion,
    selection: file.selection,
    settings: file.settings,
    view: file.view,
    tool: file.tool,

    // Not in the file, and deliberately: it is derived, it is large, and it is
    // stamped against a world that this one only resembles.
    bake: { spans: new Map(), progress: null },
  };
}

function restoredVersion(v: SavedVersion): Version {
  const edits = new Map<PolygonId, Edit>(
    v.edits.map(([id, e]) => [id, { transform: e.transform, vertices: new Map(e.vertices) }]),
  );

  return { name: v.name, base: v.base, visible: v.visible, edits };
}

/** Sortable, and legal on every filesystem worth worrying about. */
function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-').replace(/-\d+Z$/, 'Z');
}

export function download(state: EditorState, now = new Date()): void {
  const blob = new Blob([JSON.stringify(saved(state), null, 2)], {
    type: 'application/json',
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');

  a.href = url;
  a.download = `world-${stamp(now)}.json`;
  a.click();

  // The click has to have been dealt with before the url goes away
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
