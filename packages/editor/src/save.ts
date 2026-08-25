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
  EMPTY_HISTORY,
  Edit,
  EditorState,
  Group,
  GroupId,
  Id,
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
 * 5: polygons can be grouped, and a version's edits are keyed by anything a
 * transform can be written for rather than by polygons alone. A format-4 file
 * has no groups and every edit in it names a polygon, so it reads as a world
 * where nothing is grouped — which it is.
 *
 * 4: a corner carries the stretch of the chain it stands over, the way a
 * polygon carries the version it was born into.
 *
 * 3: a polygon is points and nothing else, and what happens to them belongs to
 * the versions. A format-2 file has a transform per polygon with no version to
 * put it in, and nudges applied after an erosion that no longer exists, so
 * there is nothing sensible to read it as.
 *
 * A 3 still opens. Every corner in one stood for the whole of its polygon's
 * life — there was no way to say otherwise — so that is what it is read as, and
 * nothing about the file is guessed at.
 */
export const FORMAT = 5;

/** The oldest that still says something this can read without inventing it. */
const OLDEST = 3;

export interface Saved {
  format: number
  tool: Tool
  currentVersion: VersionId
  /** The picked polygons. Corners are not written: which of them were picked
   * is about the gesture in progress rather than about the world. */
  selection: PolygonId[]
  settings: Settings
  view: View
  world: {
    nextId: number
    /** Entries rather than a map, which is all `JSON` will take. */
    polygons: [PolygonId, Polygon][]
    /** Absent before format 5, where there were none. */
    groups?: [GroupId, Group][]
    versions: SavedVersion[]
  }
}

/** A version with its two maps written out as entries. */
export interface SavedVersion {
  name: string
  base: VersionId | null
  visible: boolean
  edits: [Id, SavedEdit][]
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
    selection: state.selection.polygons,
    settings: state.settings,
    view: state.view,
    world: {
      nextId: state.world.nextId,
      polygons: [...state.world.polygons],
      groups: [...state.world.groups],
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
  if (file.format > FORMAT || file.format < OLDEST) {
    throw new Error(`state file is format ${file.format}, and this reads ${OLDEST} to ${FORMAT}`);
  }

  return {
    world: {
      polygons: new Map(file.world.polygons.map(([id, p]) => [id, standingThroughout(p)])),
      groups: new Map(file.world.groups ?? []),
      nextId: file.world.nextId,
      versions: file.world.versions.map(restoredVersion),
    },
    currentVersion: file.currentVersion,
    inside: null,
    selection: { polygons: file.selection, vertices: [] },
    settings: file.settings,
    view: file.view,
    tool: file.tool,

    // None of these are in the file: a transition that is not running, whether
    // a panel is open, and whether someone is standing inside it. Opening a
    // file while walking around one puts you back at the drawing.
    replay: null,
    preview: false,
    roaming: false,

    // Not in the file, and deliberately: it is derived, it is large, and it is
    // stamped against a world that this one only resembles.
    bake: { spans: new Map(), progress: null },

    // Nor are these, for a different reason: they are about the sitting rather
    // than about the world, and opening a file is a fresh one.
    history: EMPTY_HISTORY,
    clipboard: [],
  };
}

/**
 * A polygon whose corners say when they stand, given one whose corners may not.
 *
 * Before format 4 they always did, so a corner with nothing to say about it is
 * read as having been there since its polygon was drawn and never taken out.
 * Written out again it says so; nothing is lost and nothing is invented.
 */
function standingThroughout(polygon: Polygon): Polygon {
  if (polygon.points.every(c => c.birth !== undefined)) return polygon;

  return {
    ...polygon,
    points: polygon.points.map(c => ({
      ...c,
      birth: c.birth ?? polygon.birth,
      death: c.death ?? null,
    })),
  };
}

function restoredVersion(v: SavedVersion): Version {
  const edits = new Map<Id, Edit>(
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

/**
 * The other direction. There is no filesystem here, so the only way to a file
 * is to ask for one: a hidden input, clicked from whatever gesture asked, and
 * thrown away once it has answered.
 *
 * A bad file is refused loudly rather than half-read. `restored` throws on the
 * format, `JSON.parse` throws on anything that is not JSON at all, and neither
 * has touched the editor's state by then, so the world on screen survives.
 */
export function upload(then: (state: EditorState) => void): void {
  const input = document.createElement('input');

  input.type = 'file';
  input.accept = 'application/json,.json';

  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (file === undefined) return;

    try {
      then(restored(JSON.parse(await file.text()) as Saved));
    }
    catch (e) {
      window.alert(`${file.name} is not a world this reads:\n\n${e}`);
    }
  });

  input.click();
}
