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
  Effects,
  EMPTY_HISTORY,
  EditorState,
  Flags,
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
  Options,
  REMEMBERED,
  World,
  Start,
  defaultView,
} from './types';
import { packed, unpacked } from '@ce/game';
import { stampAll } from './bake';
import { bakedLevel } from './export';
import { Delta, Frame, Key, KeyRig, NOTHING, Stand } from './rig';

/**
 * The format this reads and writes, and the only one it does.
 *
 * 24: what happens to a thing is keys — one delta per key, corners and all;
 * see *Keys* in `rig.ts`. Everything before it is a converter's business:
 * `convert.ts` takes a 20 through to a 23, whose timelines are lists of
 * operations, and `scripts/convert-19-20.ts` takes a 19 to a 21. What each of
 * those said is written down there rather than here, where a reading of it
 * would have to be carried for ever.
 *
 * A file is one shape, and this is the shape.
 */
export const FORMAT = 24;

/**
 * The oldest this reads, which is the one it writes.
 *
 * Anything older is a converter's business — `pnpm convert`, and `convert.ts`
 * beside this — rather than a shape carried here for ever. What that leaves is
 * one reading of one format, which is the whole of what a file means.
 */
const OLDEST = FORMAT;

/**
 * Where the editor was looking.
 *
 * Not the whole `View`: how wide the canvas is, how tall, and how many device
 * pixels a CSS one is are the window's to measure and change under you, and a
 * file that carried them would size the backing store to a window that is not
 * there — see `restored`.
 */
type Look = Pick<View, 'x' | 'y' | 'zoom'>

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
  view: Look
  world: {
    nextId: number
    /** Entries rather than a map, which is all `JSON` will take. */
    polygons: [PolygonId, Polygon][]
    groups: [GroupId, Group][]
    artefacts: [ArtefactId, Artefact][]
    paths: [PathId, Path][]
    start: Start
    keyframes: Keyframe[]
    rigs: [Id, SavedKeyRig][]
    flags: [Id, Flags][]
    effects: [Id, Effects][]
    cornerEffects: [VertexId, Partial<Effects>][]
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

export interface SavedKey {
  id: number
  ref: Point
  /** Absent where the key is about single corners alone. */
  by?: Partial<Delta>
  corners?: [VertexId, Point][]
  depths?: [VertexId, number][]
  rounds?: [VertexId, number][]
  deforms?: [VertexId, number][]
  times: number | null
  /** Absent is none. */
  skip?: KeyframeId[]
  stand?: SavedStand
  /** Absent is open. See `Key`. */
  closed?: boolean
  /** Absent is none. */
  group?: number
}

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
    view: { x: state.view.x, y: state.view.y, zoom: state.view.zoom },
    world: {
      nextId: state.world.nextId,
      polygons: [...state.world.polygons],
      groups: [...state.world.groups],
      artefacts: [...state.world.artefacts],
      paths: [...state.world.paths],
      start: state.world.start,
      keyframes: state.world.keyframes,
      rigs: [...state.world.rigs].map(([id, rig]) => [id, savedKeyRig(rig)]),
      flags: [...state.world.flags],
      effects: [...state.world.effects],
      cornerEffects: [...state.world.cornerEffects],
    },
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
    rigs: new Map(file.world.rigs.map(([id, rig]) => [id, restoredKeyRig(rig)])),
    flags: new Map(file.world.flags),
    effects: new Map(file.world.effects),
    cornerEffects: new Map(file.world.cornerEffects),
  };

  return {
    world,
    keyframe: file.keyframe,
    inside: null,
    status: null,
    selection: {
      polygons: file.selection,
      vertices: [],
      edges: [],
      artefacts: file.artefacts,
      paths: file.paths,
      start: false,
      eye: false,
    },
    settings: { gridSize: file.settings.gridSize, showGrid: file.settings.showGrid },
    // Taken field by field rather than spread: a 22 and older still carries
    // the measurements, and they are the ones to be rid of. Whoever puts this
    // on screen has the canvas in front of it and says how big it is — the
    // editor's load does — and until something does, the size is the one a
    // view starts with.
    view: { ...defaultView, x: file.view.x, y: file.view.y, zoom: file.view.zoom },
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
    beneath: null,
    remembered: REMEMBERED,
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


// -----------------------------------------------------------------------------
// Keys
//
// The timelines as a 24 keeps them. Nothing writes one yet: what reads a 23
// and older is `keysOfSaved`, which restores the entries and converts them,
// and every file this has ever read comes through that.
// -----------------------------------------------------------------------------

function pairs<T>(m: ReadonlyMap<VertexId, T> | undefined): [VertexId, T][] | undefined {
  return m === undefined || m.size === 0 ? undefined : [...m];
}

function only<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** A stand's maps written out, which is all that stops one from being JSON. */
function savedStand(op: Stand): SavedStand {
  return {
    kind: 'stand',
    frame: op.frame,
    erosion: op.erosion,
    corners: [...op.corners],
    depths: [...op.depths],
    bevel: op.bevel,
    amplitude: op.amplitude,
    bevels: [...op.bevels],
    amplitudes: [...op.amplitudes],
  };
}

/** A stand read back, maps and all. */
function restoredStand(op: SavedStand): Stand {
  return {
    kind: 'stand',
    frame: op.frame,
    erosion: op.erosion,
    corners: new Map(op.corners),
    depths: new Map(op.depths),
    bevel: op.bevel,
    amplitude: op.amplitude,
    bevels: new Map(op.bevels),
    amplitudes: new Map(op.amplitudes),
  };
}

/** A stand with its maps written out as entries. */
export interface SavedStand {
  kind: 'stand'
  frame: Frame
  erosion: number
  corners: [VertexId, Point][]
  depths: [VertexId, number][]
  bevel: number
  amplitude: number
  bevels: [VertexId, number][]
  amplitudes: [VertexId, number][]
}

/** The timelines as a 24 keeps them: a key is nearly JSON as it stands, so
 * only its maps, its set and its stand are written out. */
export interface SavedKeyRig {
  keys: [KeyframeId, SavedKey[]][]
}

export function savedKeyRig(rig: KeyRig): SavedKeyRig {
  return { keys: [...rig.keys].map(([k, list]) => [k, list.map(savedKey)]) };
}

function savedKey(key: Key): SavedKey {
  return only({
    id: key.id,
    ref: key.ref,
    by: key.by,
    corners: pairs(key.corners),
    depths: pairs(key.depths),
    rounds: pairs(key.rounds),
    deforms: pairs(key.deforms),
    times: key.times,
    skip: key.skip === undefined || key.skip.size === 0 ? undefined : [...key.skip],
    stand: key.stand === undefined ? undefined : savedStand(key.stand),
    closed: key.closed === true ? true : undefined,
    group: key.group,
  });
}

export function restoredKeyRig(rig: SavedKeyRig): KeyRig {
  return { keys: new Map(rig.keys.map(([k, list]) => [k, list.map(restoredKey)])) };
}

function restoredKey(key: SavedKey): Key {
  return only({
    id: key.id,
    ref: key.ref,
    // Field by field over the delta that does nothing, so that a delta saved
    // before a field existed reads as not doing it.
    by: key.by === undefined ? undefined : { ...NOTHING, ...key.by },
    corners: key.corners === undefined ? undefined : new Map(key.corners),
    depths: key.depths === undefined ? undefined : new Map(key.depths),
    rounds: key.rounds === undefined ? undefined : new Map(key.rounds),
    deforms: key.deforms === undefined ? undefined : new Map(key.deforms),
    times: key.times,
    skip: key.skip === undefined || key.skip.length === 0 ? undefined : new Set(key.skip),
    stand: key.stand === undefined ? undefined : restoredStand(key.stand),
    closed: key.closed,
    group: key.group,
  });
}
