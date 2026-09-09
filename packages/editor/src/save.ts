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
  EMPTY_TRANSFORM,
  Edit,
  EditorState,
  Footing,
  Group,
  GroupId,
  Id,
  PathId,
  Polygon,
  PolygonId,
  Settings,
  Figure,
  FLOOR,
  Tool,
  Transform,
  Version,
  VERSIONS,
  VersionId,
  VertexId,
  View,
  Point,
  PolygonKind,
  World,
  IconType,
  Start,
} from './types';
import { Affine, facingAt, placeAt } from './scene';

/**
 * 15: a version's layer may unchain something — hold what it stands on outright
 * rather than inheriting it from its base. A format-14 file has no footings,
 * which is a world where everything is chained all the way back, and it is:
 * there was no way to say otherwise, so nothing in one meant to.
 *
 * 13: a polygon, a group and an artefact each carry the version that took it
 * out, the way a corner already did. A format-12 file has none, which is a
 * world where nothing was ever removed at a version — and it is: removal was
 * global until now, so anything a format-12 file no longer holds is not in it
 * at all. It reads as everything living to the last version, which is what it
 * did.
 *
 * 18: a group carries what it is to whatever holds it, and a polygon is one of
 * four kinds.
 *
 * A group is a scope: its solids and its voids cut inside it and reach no
 * further, and what comes out is one shape per set. `Group.kind` is which slot
 * that shape lands in one level up — which is what lets a group be a block, or
 * a hole in one, and lets the nesting go as deep as anybody nests. A file
 * written before the question could be asked has every group publishing what
 * it held, which is a `level`, and reads as one.
 *
 * As for the polygon: it is one of four kinds — `level`, `solid`, `floor` or `void`,
 * the last saying which of the other two it cuts — rather than a set crossed
 * with a direction. The product was never real: a subtraction from the level
 * and an addition to the solids were two spellings of one thing, and the one
 * thing neither could say is a hole cut in a solid, which is what a `void`
 * exists for. A format-17 file's `level`/`add` is a `level`, its
 * `level`/`subtract` is a `solid`, its `floor`/`add` is a `floor` and its
 * `floor`/`subtract` is a `void` over the floors. Nothing is guessed at: those
 * four are all a format-17 file could hold, and each says exactly one of these.
 *
 * 17: a polygon is a set and a direction — `level` or `floor`, added or
 * subtracted — rather than one of three kinds. A format-16 file's `level` and
 * `floor` are both added, and its `solid` is a `level` subtracted, which is
 * exactly what the word meant: a pillar was never a third kind of thing, it
 * was a room taken back out. Nothing is guessed at, and the one thing the
 * older format could not say — a hole cut in a floor — is a thing no file
 * written before this has.
 *
 * 16: a measuring path is born into a version and taken out at one, and a
 * version's layer may carry a transform for it — so a path can be a member of
 * a group and go where the group goes. A format-15 file's paths are in no
 * version's layer and stood over the whole chain, which is exactly what a
 * birth at the root and no death reads as, so nothing about one is guessed at.
 *
 * 12: a version's layer may hold a depth for single corners as well as one for
 * the whole polygon. A format-11 file holds none, which is a world where every
 * corner of a polygon is offset by the same amount — so it reads as one, which
 * is what an absent map means anywhere.
 *
 * 14: a polygon is any number of rings — an outline and the holes in it — laid
 * end to end in one list of corners, each corner saying which ring it belongs
 * to. A format-13 file has one ring, so every corner in it is a corner of ring
 * nought, which is what it is read as. Nothing is guessed at: one ring is what
 * every polygon in it had, and the field only ever says something once a hole
 * exists to say it about.
 *
 * 11: the start is a field of the world rather than an artefact of kind
 * `start`. A format-10 file has one among the artefacts — or several, or none,
 * which is exactly what this stops being sayable — so the first of them is
 * lifted out at where it stood at v0 and the rest go with it. A file with none
 * reads as a start at the origin, which is where a new world's is.
 *
 * 10: the create tool draws a rectangle, an n-gon or a polyline, and which of
 * them goes in the file beside the tool. A format-9 file has no shape in it,
 * which is the polyline: it was the only thing that tool could draw.
 *
 * 9: there is no setting for whether to snap. Everything the editor does lands
 * on the grid and Ctrl held is what says otherwise, so a file that carried a
 * `snapToGrid` of either value reads the same way: with the grid on and the
 * key free to turn it off, which is what every gesture in it was drawn with.
 *
 * 8: the world holds measuring paths, and the tool that draws polygons is
 * called `create` rather than `path` — the name now belongs to the tool that
 * draws those. A format-7 file has no paths, which is a world nobody has
 * measured anything in, and a `path` in its tool field meant the pen.
 *
 * 7: an artefact is a point and a kind, and what has happened to it since is a
 * transform in the versions like everything else's. A format-6 file holds a
 * move per version instead, which is the same sequence of places said the long
 * way round, so it converts exactly: the first move is where it was put, and
 * every later one is a translation in that version's layer.
 *
 * 6: the world has artefacts. A format-5 file has none, which is a world with
 * nothing placed in it — so it reads as one, and writes itself back out saying
 * so.
 *
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
export const FORMAT = 18;

/** The oldest that still says something this can read without inventing it. */
const OLDEST = 3;

export interface Saved {
  format: number
  tool: Tool
  /** Absent before format 10, where the create tool drew polylines only. */
  figure?: Figure
  currentVersion: VersionId
  /** The picked polygons. Corners are not written: which of them were picked
   * is about the gesture in progress rather than about the world. */
  selection: PolygonId[]
  /** The picked artefacts. Absent before format 6. */
  artefacts?: ArtefactId[]
  /** The picked paths. Absent before format 16, where a path could not be
   * picked whole. */
  paths?: PathId[]
  settings: Settings
  view: View
  world: {
    nextId: number
    /** Entries rather than a map, which is all `JSON` will take. */
    polygons: [PolygonId, Polygon][]
    /** Absent before format 5, where there were none. */
    groups?: [GroupId, Group & { kind?: PolygonKind }][]
    /** Absent before format 6, where there were none. Each one's places go out
     * as entries for the same reason a version's edits do. */
    artefacts?: [ArtefactId, SavedArtefact][]
    /** Absent before format 8, where there were none. A format-15 file's
     * entries carry points alone — see `FORMAT`. */
    paths?: [PathId, SavedPath][]
    /** Absent before format 11, where it was an artefact — see `FORMAT`. */
    start?: Start
    versions: SavedVersion[]
  }
}

export interface SavedPath {
  /** Absent before format 16, where a path was in no version — see `FORMAT`. */
  birth?: VersionId
  /** Absent before format 16, and absent since wherever it is nothing. */
  death?: VersionId | null
  /** The walk in the path's own frame, before any version's transform. */
  points: Point[]
}

export interface SavedArtefact {
  /** Wider than an artefact's own kind, because a format-10 file's start is
   * one of these — see `FORMAT` and `lifted`. */
  type: IconType
  birth: VersionId
  /** Absent before format 13, and absent since wherever it is nothing. */
  death?: VersionId | null
  /** Its own point, before any version's transform. A format-6 file has a list
   * of per-version moves here instead — see `FORMAT`. */
  at: Point | [VersionId, Point][]
}

/** A version with its two maps written out as entries. */
export interface SavedVersion {
  name: string
  base: VersionId | null
  visible: boolean
  edits: [Id, SavedEdit][]
  /** Absent before format 15, and absent since wherever it is empty — which is
   * every version nobody has unchained anything at. */
  footings?: [Id, SavedFooting][]
}

/** A footing with its two maps written out as entries, the way an edit's are. */
export interface SavedFooting {
  frame: Affine
  local: [VertexId, Point][]
  erosion: number
  depths: [VertexId, number][]
}

export interface SavedEdit {
  transform: Transform
  vertices: [VertexId, Point][]
  /** Absent before format 12, and absent since wherever it is empty — which is
   * every layer nobody has offset a single corner of. */
  depths?: [VertexId, number][]
}

export function saved(state: EditorState): Saved {
  return {
    format: FORMAT,
    tool: state.tool,
    figure: state.figure,
    currentVersion: state.currentVersion,
    selection: state.selection.polygons,
    artefacts: state.selection.artefacts,
    paths: state.selection.paths,
    settings: state.settings,
    view: state.view,
    world: {
      nextId: state.world.nextId,
      polygons: [...state.world.polygons],
      groups: [...state.world.groups],
      artefacts: [...state.world.artefacts].map(
        ([id, a]) => [id, {
          type: a.type,
          birth: a.birth,
          death: a.death ?? undefined,
          at: a.at,
        }],
      ),
      paths: [...state.world.paths].map(
        ([id, p]) => [id, { birth: p.birth, death: p.death ?? undefined, points: p.points }],
      ),
      start: state.world.start,
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
      {
        transform: e.transform,
        vertices: [...e.vertices],
        depths: e.depths.size === 0 ? undefined : [...e.depths],
      },
    ]),
    footings: v.footings.size === 0
      ? undefined
      : [...v.footings].map(([id, f]) => [
          id,
          {
            frame: f.frame,
            local: [...f.local],
            erosion: f.erosion,
            depths: [...f.depths],
          },
        ]),
  };
}

export function restored(file: Saved): EditorState {
  if (file.format > FORMAT || file.format < OLDEST) {
    throw new Error(`state file is format ${file.format}, and this reads ${OLDEST} to ${FORMAT}`);
  }

  const versions = chained(file.world.versions.map(restoredVersion));

  // The starts among them come in with the rest and are taken back out below:
  // where one stood is a question about the world it was in, so the world has
  // to be built before it can be asked.
  const artefacts = new Map<ArtefactId, Artefact>();
  const wasStart: ArtefactId[] = [];

  for (const [id, a] of file.world.artefacts ?? []) {
    const at = settling(a, id, versions);

    if (a.type === 'start') wasStart.push(id);

    artefacts.set(id, {
      type: a.type === 'start' ? 'exit' : a.type,
      birth: a.birth,
      death: a.death ?? null,
      at,
    });
  }

  const world: World = {
    polygons: new Map(file.world.polygons.map(([id, p]) => [id, standingThroughout(p)])),
    groups: new Map(
      (file.world.groups ?? []).map(([id, g]) => [id, {
        ...g,
        death: g.death ?? null,

        // A group that says nothing about what it is to its parent is a
        // `level`, which is what every group written before a group could be
        // anything else was: it published what it held and the question had
        // not been asked. See `Group.kind`.
        kind: g.kind ?? { type: 'level' as const },
      }]),
    ),
    artefacts,
    start: file.world.start ?? { at: { x: 0, y: 0 }, facing: 0 },
    paths: new Map((file.world.paths ?? []).map(([id, p]) => [id, {
      // A format-15 path was in no version at all, which is the same thing as
      // one standing over the whole chain: born at the root and never taken
      // out. See `FORMAT`.
      birth: p.birth ?? 0,
      death: p.death ?? null,
      points: p.points,
    }])),
    nextId: file.world.nextId,
    versions,
  };

  // Lifted before they go, since lifting one is a read of where it stands.
  const out = file.world.start !== undefined ? world : lifted(world, wasStart[0]);

  for (const id of wasStart) artefacts.delete(id);

  return {
    world: out,
    currentVersion: file.currentVersion,
    inside: null,
    selection: {
      polygons: file.selection,
      vertices: [],
      // A format-10 file could have the start picked, and its id names nothing
      // now. Dropped rather than turned into `start: true`: which of them was
      // picked is about the sitting the file was written in, not the world.
      artefacts: (file.artefacts ?? []).filter(id => artefacts.has(id)),
      paths: (file.paths ?? []).filter(id => world.paths.has(id)),
      start: false,
    },
    // Only the fields there are. A format-8 file has a `snapToGrid` beside
    // them, which nothing reads any more — see `FORMAT`.
    settings: { gridSize: file.settings.gridSize, showGrid: file.settings.showGrid },
    view: file.view,
    // A format-7 file's `path` was the pen, which is now `create`. Nothing
    // else about the tools has ever been renamed.
    tool: (file.tool as string) === 'path' && file.format < 8 ? 'create' : file.tool,
    figure: file.figure ?? 'polyline',

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
 * The world with its start read off the artefact a format-10 file kept it as.
 *
 * Where that artefact stood at v0, which is the only version a start has ever
 * meant anything at: the player was put at `places[0]` and nowhere else, so
 * every later layer of it was a move nothing read. A file with no start
 * artefact keeps the origin it came in with.
 *
 * The layers themselves are left where they are. They key an id that is no
 * longer in the world, so nothing resolves them, and taking them out would be
 * a second thing this could get wrong.
 */
function lifted(world: World, id: ArtefactId | undefined): World {
  if (id === undefined) return world;

  return {
    ...world,
    start: { at: placeAt(world, id, 0) ?? { x: 0, y: 0 }, facing: facingAt(world, id, 0) ?? 0 },
  };
}

/**
 * An artefact's own point, given a file that may say it the format-6 way.
 *
 * There it was a move per version against where the versions before left it, so
 * the first is the place and each of the rest is a translation that version was
 * making. Which is what a transform's translation is, so they go into the
 * layers `versions` already holds and nothing about the file is guessed at.
 *
 * The versions are written into rather than rebuilt: an artefact had no layer
 * of its own in a format-6 file, so there is nothing there to conflict with.
 */
function settling(a: SavedArtefact, id: ArtefactId, versions: Version[]): Point {
  if (!Array.isArray(a.at)) return a.at;

  let out: Point = { x: 0, y: 0 };

  for (const [v, move] of a.at) {
    if (v === a.birth) {
      out = move;
      continue;
    }

    const edits = new Map(versions[v].edits);

    edits.set(id, {
      transform: { ...EMPTY_TRANSFORM, translation: move },
      vertices: new Map(),
      depths: new Map(),
    });

    versions[v] = { ...versions[v], edits };
  }

  return out;
}

/**
 * A polygon whose corners say when they stand, given one whose corners may not.
 *
 * Before format 4 they always did, so a corner with nothing to say about it is
 * read as having been there since its polygon was drawn and never taken out.
 * Written out again it says so; nothing is lost and nothing is invented.
 *
 * And the polygon itself, before format 13, where nothing could be taken out at
 * a version at all.
 *
 * The ring a corner is in comes from here too. Before format 14 there was one,
 * so every corner is a corner of it — see `Vertex.ring`.
 */
/**
 * A polygon's kind, however the file it came out of said it.
 *
 * Three spellings, and each is exact rather than guessed at. A format-18 file
 * says one of the four names outright. A format-17 file says a set and a
 * direction, and all four of those pairs are one of the names. A format-16
 * file says one of three kinds, whose `solid` meant a room taken back out —
 * which is the `solid` of today, under the name it had before it briefly
 * stopped being a name at all.
 *
 * A `void` over both sets can only come from a file that already had one, so
 * there is nothing older to read it out of.
 */
function kindRead(polygon: Polygon & { op?: string }): PolygonKind {
  if (polygon.op === undefined) {
    return polygon.type === 'void'
      ? { type: 'void', from: polygon.from }
      : { type: polygon.type };
  }

  if (polygon.op === 'add') return { type: polygon.type === 'floor' ? 'floor' : 'level' };

  return polygon.type === 'floor'
    ? { type: 'void', from: FLOOR }
    : { type: 'solid' };
}

function standingThroughout(polygon: Polygon): Polygon {
  // The kind's own fields are dropped before the read one goes on, rather than
  // being spread over: a format-17 file's `op` and a stale `from` are both
  // fields of a kind this no longer is, and leaving either in place would put
  // an older format's spelling back into a world that has moved past it.
  const { op: _op, from: _from, ...rest } = polygon as Polygon & { op?: string, from?: number };

  return {
    ...rest,
    ...kindRead(polygon),
    death: polygon.death ?? null,
    points: polygon.points.map(c => ({
      ...c,
      ring: c.ring ?? 0,
      birth: c.birth ?? polygon.birth,
      death: c.death ?? null,
    })),
  };
}

/**
 * The chain at the length everything reads it at.
 *
 * `VERSIONS` is fixed: the strip draws that many rows and each reads its own
 * version out of the world, `bakeAll` cuts that many spans less one, and
 * `emptyWorld` builds exactly that many. A file holds however many there were
 * when it was written, and that number has gone up — so an older file came back
 * short and the first row past its end read `undefined.name` before anything
 * else got a chance to go wrong.
 *
 * Padded rather than refused, and padded with versions that do nothing: chained
 * to the one before, holding no edits, which is what a version nobody has
 * authored anything at looks like. The world it describes is unchanged, and the
 * spans they add are spans in which nothing moves.
 *
 * Longer than `VERSIONS` cannot be written by this and would have nowhere to be
 * drawn, so it is cut back — with the same reasoning in reverse, and it has
 * never happened.
 */
function chained(versions: Version[]): Version[] {
  if (versions.length === VERSIONS) return versions;

  const out = versions.slice(0, VERSIONS);

  for (let i = out.length; i < VERSIONS; i++) {
    out.push({
      name: `v${i}`,
      base: i === 0 ? null : i - 1,
      visible: true,
      edits: new Map(),
      footings: new Map(),
    });
  }

  return out;
}

function restoredVersion(v: SavedVersion): Version {
  const edits = new Map<Id, Edit>(
    v.edits.map(([id, e]) => [id, {
      transform: e.transform,
      vertices: new Map(e.vertices),
      depths: new Map(e.depths ?? []),
    }]),
  );

  const footings = new Map<Id, Footing>(
    (v.footings ?? []).map(([id, f]) => [id, {
      frame: f.frame,
      local: new Map(f.local),
      erosion: f.erosion,
      depths: new Map(f.depths),
    }]),
  );

  return { name: v.name, base: v.base, visible: v.visible, edits, footings };
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
