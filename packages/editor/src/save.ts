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
  EditorState,
  Polygon,
  PolygonId,
  Settings,
  Tool,
  Version,
  View,
} from './types';

export const FORMAT = 1;

export interface Saved {
  format: number
  tool: Tool
  currentVersion: number
  selection: PolygonId[]
  settings: Settings
  view: View
  world: {
    nextId: PolygonId
    /** Entries rather than a map, which is all `JSON` will take. */
    polygons: [PolygonId, Polygon][]
    versions: Version[]
  }
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
      polygons: [...state.world.sourcePolygons],
      versions: state.world.versions,
    },
  };
}

export function restored(file: Saved): EditorState {
  if (file.format !== FORMAT) {
    throw new Error(`state file is format ${file.format}, and this reads ${FORMAT}`);
  }

  return {
    world: {
      sourcePolygons: new Map(file.world.polygons),
      nextId: file.world.nextId,
      versions: file.world.versions,
    },
    currentVersion: file.currentVersion,
    selection: file.selection,
    settings: file.settings,
    view: file.view,
    tool: file.tool,
  };
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
