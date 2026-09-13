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
  Artefact,
  ArtefactId,
  EMPTY_HISTORY,
  EditorState,
  Group,
  GroupId,
  Id,
  Keyframe,
  KeyframeId,
  PathId,
  Path,
  Polygon,
  PolygonId,
  Settings,
  Figure,
  Tool,
  VertexId,
  View,
  Point,
  World,
  Start,
} from './types';
import { packed, unpacked } from '@ce/game';
import { stampAll } from './bake';
import { bakedLevel } from './export';
import { Entry, Erode, Frame, Move, Op, Rig } from './rig';

/**
 * 21: a frame has a skew, and a scale the skew its axes had — see `Frame`. A
 * 20 is the same with every skew nought, and is read as that; its bake, which
 * is in a layout the game no longer reads, is left behind to be baked again.
 *
 * 20: what happens to a thing is a list of operations per keyframe — see
 * `rig.ts` — rather than a layer per version holding one transform for it.
 *
 * Nothing older is read. A layer is a transform about the world origin
 * composed onto everything before it, and an operation is a turn about a point
 * painted onto the thing, or a move that no later turn reaches: there is no
 * list of operations that *is* a stack of layers without inventing where every
 * one of them was aimed. So a file from before is refused rather than opened
 * looking almost like it did.
 *
 * 19: the file may carry the bake, as the game gets it — see `Saved.baked`.
 */
export const FORMAT = 21;

/** The oldest that still says something this can read without inventing it. */
const OLDEST = 20;

export interface Saved {
  format: number
  tool: Tool
  figure: Figure
  keyframe: KeyframeId
  /** The picked polygons. Corners are not written: which of them were picked
   * is about the gesture in progress rather than about the world. */
  selection: PolygonId[]
  artefacts: ArtefactId[]
  paths: PathId[]
  settings: Settings
  view: View
  world: {
    nextId: number
    /** Entries rather than a map, which is all `JSON` will take. */
    polygons: [PolygonId, Polygon][]
    groups: [GroupId, Group][]
    artefacts: [ArtefactId, Artefact][]
    paths: [PathId, Path][]
    start: Start
    keyframes: Keyframe[]
    rigs: [Id, SavedRig][]
  }
  /**
   * The bake, where there was one: every span of it that still stood when the
   * file was written, as the game is handed them, packed into one string — see
   * `packed` in the game. Absent wherever nothing had been baked.
   *
   * The flat buffers rather than the editor's spans, for two reasons. They are
   * what the game needs, so a file with one can be played without the bake
   * ever being run again; and they are a fraction of the size, the spans being
   * a graph of maps keyed by id with every neighbourhood the cut looked at.
   *
   * Last in the file, so that it is the one long line at the bottom rather than
   * one in the middle of everything anyone would read.
   */
  baked?: string
}

/** A timeline with its maps written out as entries. */
export interface SavedRig {
  keys: [KeyframeId, SavedEntry[]][]
  nudges: [VertexId, [KeyframeId, SavedEntry][]][]
  depths: [VertexId, [KeyframeId, SavedEntry][]][]
}

export interface SavedEntry {
  op: SavedOp
  times: number | null
  /** Absent wherever it is empty, which is nearly everywhere. */
  skip?: KeyframeId[]
}

/** An operation, with a stand's two maps written out as entries. */
export type SavedOp =
  | Exclude<Op, { kind: 'stand' }>
  | {
      kind: 'stand'
      frame: Frame
      erosion: number
      corners: [VertexId, Point][]
      depths: [VertexId, number][]
    };

export function saved(state: EditorState): Saved {
  return {
    format: FORMAT,
    tool: state.tool,
    figure: state.figure,
    keyframe: state.keyframe,
    selection: state.selection.polygons,
    artefacts: state.selection.artefacts,
    paths: state.selection.paths,
    settings: state.settings,
    view: state.view,
    world: {
      nextId: state.world.nextId,
      polygons: [...state.world.polygons],
      groups: [...state.world.groups],
      artefacts: [...state.world.artefacts],
      paths: [...state.world.paths],
      start: state.world.start,
      keyframes: state.world.keyframes,
      rigs: [...state.world.rigs].map(([id, rig]) => [id, savedRig(rig)]),
    },
  };
}

function savedRig(rig: Rig): SavedRig {
  return {
    keys: [...rig.keys].map(([k, list]) => [k, list.map(savedEntry)]),
    nudges: [...rig.nudges].map(([c, map]) => [c, [...map].map(([k, e]) => [k, savedEntry(e)])]),
    depths: [...rig.depths].map(([c, map]) => [c, [...map].map(([k, e]) => [k, savedEntry(e)])]),
  };
}

function savedEntry(e: Entry): SavedEntry {
  const op: SavedOp = e.op.kind === 'stand'
    ? { ...e.op, corners: [...e.op.corners], depths: [...e.op.depths] }
    : e.op;

  return { op, times: e.times, skip: e.skip.size === 0 ? undefined : [...e.skip] };
}

function restoredEntry(e: SavedEntry): Entry {
  // A 20 has no skews: absent is nought.
  const op: Op = e.op.kind === 'stand'
    ? {
        ...e.op,
        frame: { ...e.op.frame, skew: e.op.frame.skew ?? 0 },
        corners: new Map(e.op.corners),
        depths: new Map(e.op.depths),
      }
    : e.op.kind === 'scale' ? { ...e.op, lean: e.op.lean ?? 0 } : e.op;

  return { op, times: e.times, skip: new Set(e.skip ?? []) };
}

function restoredRig(rig: SavedRig): Rig {
  return {
    keys: new Map(rig.keys.map(([k, list]) => [k, list.map(restoredEntry)])),
    nudges: new Map(rig.nudges.map(([c, map]) => [
      c,
      new Map(map.map(([k, e]) => [k, restoredEntry(e) as Entry<Move>])),
    ])),
    depths: new Map(rig.depths.map(([c, map]) => [
      c,
      new Map(map.map(([k, e]) => [k, restoredEntry(e) as Entry<Erode>])),
    ])),
  };
}

export function restored(file: Saved): EditorState {
  if (file.format > FORMAT || file.format < OLDEST) {
    throw new Error(`state file is format ${file.format}, and this reads ${OLDEST} to ${FORMAT}`);
  }

  const world: World = {
    polygons: new Map(file.world.polygons),
    groups: new Map(file.world.groups),
    artefacts: new Map(file.world.artefacts),
    start: file.world.start,
    paths: new Map(file.world.paths),
    nextId: file.world.nextId,
    keyframes: file.world.keyframes,
    rigs: new Map(file.world.rigs.map(([id, rig]) => [id, restoredRig(rig)])),
  };

  return {
    world,
    keyframe: file.keyframe,
    inside: null,
    status: null,
    selection: {
      polygons: file.selection,
      vertices: [],
      artefacts: file.artefacts,
      paths: file.paths,
      start: false,
    },
    settings: { gridSize: file.settings.gridSize, showGrid: file.settings.showGrid },
    view: file.view,
    tool: file.tool,
    figure: file.figure,

    // None of these are in the file: a transition that is not running, whether
    // a panel is open, whether someone is standing inside it, and how long a
    // walk waits there. Opening a file while walking around one puts you back
    // at the drawing.
    replay: null,
    preview: false,
    roaming: false,
    lead: 0,

    // The spans are not in the file, and deliberately: they are derived, they
    // are large, and they are stamped against a world that this one only
    // resembles. What the game gets is, and `reopened` puts it back.
    bake: { spans: new Map(), progress: null },

    // Nor are these, for a different reason: they are about the sitting rather
    // than about the world, and opening a file is a fresh one.
    history: EMPTY_HISTORY,
    clipboard: [],
  };
}

/** Sortable, and legal on every filesystem worth worrying about. */
function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-').replace(/-\d+Z$/, 'Z');
}

/**
 * The state as a file, bake and all.
 *
 * Apart from `saved` because packing the bake is asynchronous — the deflate is
 * the browser's own, and it only comes as a stream.
 */
export async function written(state: EditorState): Promise<Saved> {
  const out = saved(state);
  const level = bakedLevel(state.bake, state.world);

  return level.spans.length === 0 ? out : { ...out, baked: await packed(level) };
}

/**
 * A file as the editor's state, with whatever bake came in it standing beside
 * the world it was baked against.
 *
 * Stamped against the world `restored` built, which is the one on screen until
 * the first edit — and that edit is what should throw it away.
 */
export async function reopened(file: Saved): Promise<EditorState> {
  const state = restored(file);
  if (file.baked === undefined || file.format < 21) return state;

  const level = await unpacked(file.baked);

  return { ...state, bake: { ...state.bake, loaded: { level, stamp: stampAll(state.world) } } };
}

export async function download(state: EditorState, now = new Date()): Promise<void> {
  // Indented for everything a person might read, and the bake on one line at
  // the bottom rather than broken across however many thousand.
  const { baked, ...rest } = await written(state);
  const text = JSON.stringify(rest, null, 2);

  const blob = new Blob([baked === undefined ? text : `${text.slice(0, -2)},\n  "baked": ${JSON.stringify(baked)}\n}`], {
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
 * format, `unpacked` on a bake it cannot read and `JSON.parse` on anything that
 * is not JSON at all, and none of them has touched the editor's state by then,
 * so the world on screen survives.
 */
export function upload(then: (state: EditorState) => void): void {
  const input = document.createElement('input');

  input.type = 'file';
  input.accept = 'application/json,.json';

  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (file === undefined) return;

    try {
      then(await reopened(JSON.parse(await file.text()) as Saved));
    }
    catch (e) {
      window.alert(`${file.name} is not a world this reads:\n\n${e}`);
    }
  });

  input.click();
}
