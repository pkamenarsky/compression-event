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
import { Amount, Entry, Frame, Move, Op, Rig, Stand } from './rig';
import { Delta, Key, KeyRig, NOTHING, keysOf } from './rig';

/**
 * 23: the view is where the editor was looking and nothing else — see `Look`.
 * A 20, 21 or 22 also says how big the canvas was and on what screen, which is
 * this window's business rather than the file's, and is dropped on the way in.
 *
 * 22: effects — which a thing has and how (`World.effects`, a corner's own in
 * `cornerEffects`), and the rounds and deforms in its timeline, a stand's
 * included. A 21 is the same with none, and is read as that; its bake stands,
 * since a world without effects bakes as it did. A deform's `jitter` and
 * `clear` came later in 22, and are nought and off where a file has none; a round's `verticals` and
 * `ends` came and went, and are dropped; a round was first a number of
 * `segments`, and reads as a chamfer where that was one and at the precision
 * a round starts with otherwise, and one without a `tension` at the tension
 * one starts with; and a stand's bevels were first called its
 * radius and radii, which are read as them.
 *
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
export const FORMAT = 23;

/** The oldest that still says something this can read without inventing it. */
const OLDEST = 20;

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
    rigs: [Id, SavedRig][]
    /** Absent is none, which is every file from before there were any. */
    flags?: [Id, Flags][]
    /** Absent is none: a 21. */
    effects?: [Id, Effects][]
    cornerEffects?: [VertexId, Partial<Effects>][]
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
  /** Absent in a 21, which had none. */
  rounds?: [VertexId, [KeyframeId, SavedEntry][]][]
  deforms?: [VertexId, [KeyframeId, SavedEntry][]][]
}

export interface SavedEntry {
  op: SavedOp
  times: number | null
  /** Absent is none. */
  skip?: KeyframeId[]
  /** Absent is none. */
  gesture?: number
}

/** A stand with its maps written out as entries. */
export interface SavedStand {
  kind: 'stand'
  frame: Frame
  erosion: number
  corners: [VertexId, Point][]
  depths: [VertexId, number][]
  /** Absent in a 21, where they are nought. */
  bevel?: number
  amplitude?: number
  bevels?: [VertexId, number][]
  amplitudes?: [VertexId, number][]
  /** What a 22 first called the bevels, when they were radii. */
  radius?: number
  radii?: [VertexId, number][]
}

/** An operation, with a stand's two maps written out as entries. */
export type SavedOp = Exclude<Op, { kind: 'stand' }> | SavedStand;

/**
 * A timeline of keys: what a 24 keeps, and what everything older is read into.
 *
 * A key is nearly JSON as it stands — its delta is numbers and points — so
 * only its maps and its set are written out. See `Key` in `key.ts`.
 */
export interface SavedKeyRig {
  keys: [KeyframeId, SavedKey[]][]
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
      rigs: [...state.world.rigs].map(([id, rig]) => [id, savedRig(rig)]),
      flags: [...state.world.flags],
      effects: [...state.world.effects],
      cornerEffects: [...state.world.cornerEffects],
    },
  };
}

export function savedRig(rig: Rig): SavedRig {
  const corners = (m: ReadonlyMap<VertexId, ReadonlyMap<KeyframeId, Entry>>): [VertexId, [KeyframeId, SavedEntry][]][] =>
    [...m].map(([c, map]) => [c, [...map].map(([k, e]) => [k, savedEntry(e)])]);

  return {
    keys: [...rig.keys].map(([k, list]) => [k, list.map(savedEntry)]),
    nudges: corners(rig.nudges),
    depths: corners(rig.depths),
    rounds: corners(rig.rounds),
    deforms: corners(rig.deforms),
  };
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

/** A stand read back, filling in what the formats before it did not keep. */
function restoredStand(op: SavedStand): Stand {
  return {
    kind: 'stand',
    // A 20 has no skews: absent is nought.
    frame: { ...op.frame, skew: op.frame.skew ?? 0 },
    erosion: op.erosion,
    corners: new Map(op.corners),
    depths: new Map(op.depths),
    bevel: op.bevel ?? op.radius ?? 0,
    amplitude: op.amplitude ?? 0,
    bevels: new Map(op.bevels ?? op.radii ?? []),
    amplitudes: new Map(op.amplitudes ?? []),
  };
}

function savedEntry(e: Entry): SavedEntry {
  const op: SavedOp = e.op.kind === 'stand' ? savedStand(e.op) : e.op;

  const out: SavedEntry = e.skip === undefined ? { op, times: e.times } : { op, times: e.times, skip: [...e.skip] };

  return e.gesture === undefined ? out : { ...out, gesture: e.gesture };
}

function restoredEntry(e: SavedEntry): Entry {
  const op: Op = e.op.kind === 'stand'
    ? restoredStand(e.op)
    : e.op.kind === 'scale' ? { ...e.op, lean: e.op.lean ?? 0 } : e.op;

  const out: Entry = e.skip === undefined || e.skip.length === 0 ? { op, times: e.times } : { op, times: e.times, skip: new Set(e.skip) };

  return e.gesture === undefined ? out : { ...out, gesture: e.gesture };
}

function restoredRig(rig: SavedRig): Rig {
  const corners = <O extends Op>(m: [VertexId, [KeyframeId, SavedEntry][]][] = []): Map<VertexId, Map<KeyframeId, Entry<O>>> =>
    new Map(m.map(([c, map]) => [c, new Map(map.map(([k, e]) => [k, restoredEntry(e) as Entry<O>]))]));

  return {
    keys: new Map(rig.keys.map(([k, list]) => [k, list.map(restoredEntry)])),
    nudges: corners<Move>(rig.nudges),
    depths: corners<Amount<'erode'>>(rig.depths),
    rounds: corners<Amount<'round'>>(rig.rounds),
    deforms: corners<Amount<'deform'>>(rig.deforms),
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
    flags: new Map(file.world.flags ?? []),
    effects: new Map((file.world.effects ?? []).map(([id, fx]) => [id, optioned(fx)])),
    cornerEffects: new Map((file.world.cornerEffects ?? []).map(([c, fx]) => [c, optioned(fx)])),
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

/** Effects as this reads them, from whenever in 22 they were saved: a
 * deform's `jitter` and `clear` came after the format did, and a file
 * without them has neither; a round's `verticals` and `ends` came and went, and its `segments`
 * became a precision. */
function optioned<E extends Partial<Effects>>(fx: E): E {
  return {
    ...fx,
    ...(fx.round === undefined ? {} : { round: rounding(fx.round) }),
    ...(fx.deform === undefined ? {} : { deform: { ...REMEMBERED.deform, ...fx.deform } }),
  };
}

/** A round as saved, from whenever in 22: see `FORMAT`. */
function rounding(round: Effects['round'] & object): Options['round'] {
  const was = round as Partial<Options['round']> & { segments?: number };

  return {
    precision: was.precision ?? REMEMBERED.round.precision,
    tension: was.tension ?? REMEMBERED.round.tension,
    chamfer: was.chamfer ?? was.segments === 1,
    ...(was.off === undefined ? {} : { off: was.off }),
  };
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
    group: key.group,
  });
}

/** A timeline saved as entries, read as keys: what opening anything older than
 * a 24 goes through. One key per entry, and a corner's own writing gathered
 * into keys of its own — see `keysOf` in `key.ts`. */
export function keysOfSaved(rig: SavedRig): KeyRig {
  return keysOf(restoredRig(rig));
}
