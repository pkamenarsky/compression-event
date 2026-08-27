import { ArtefactType, Point, PolygonType } from '@ce/game/world';
import type { Bake } from './bake';

export type { ArtefactType, Point, PolygonType };

/** The kinds, in the order the number keys pick them. */
export const ARTEFACTS: ArtefactType[] = [
  'start',
  'exit',
  'key',
  'delay',
  'decompress',
  'anchor',
  'compass',
];

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

export type Tool = 'point' | 'create' | 'artefact' | 'polygon' | 'path';

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
// All of them come from one counter on `World`, so an id is unique across the
// document and can never be confused for another kind. Everything a version's
// layer names, it names by id: an edit keyed by array index re-points at the
// wrong thing the moment something upstream is inserted.
// -----------------------------------------------------------------------------

export type PolygonId = number;
export type PathId = number;
export type GroupId = number;
export type VertexId = number;
export type ArtefactId = number;

/** Whatever a version's layer can carry a transform for. One counter, so no
 * two ever collide and a map over all of them is well defined. */
export type Id = PolygonId | GroupId | ArtefactId;
export type VersionId = number;

/**
 * A corner, where it was put when it was drawn, and the stretch of the chain
 * over which it is one of the polygon's.
 *
 * Corners come and go the way polygons do, and for the same reason: a version
 * is a layer over the versions before it, and nothing a layer does may reach
 * back past itself. Adding a corner at v3 and having it appear at v0 is exactly
 * the backward propagation the whole design is built to refuse.
 *
 * `death` is where it stops, not the last version that has it, so the two read
 * the same way round: alive from `birth`, gone from `death`.
 */
export interface Vertex {
  id: VertexId
  at: Point
  /** The version whose layer put it there. */
  birth: VersionId
  /** The version whose layer took it out, or nothing while it still stands. */
  death: VersionId | null
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
 *
 * It holds every corner the polygon has ever had, in ring order, including the
 * ones no longer standing and the ones not yet. Which of them a version
 * actually has is `standing`; the order is the one thing they all agree on, and
 * keeping the dead in place is what lets a corner be inserted between two
 * others without the versions that lack it losing track of where it went.
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
  /**
   * Keyed by anything a transform can be written for: a polygon, or a group.
   * A group's edit uses the transform and leaves `vertices` empty — there is
   * no ring under it to displace, only members with rings of their own.
   */
  edits: Map<Id, Edit>
}

/**
 * Whether a corner is one of the polygon's, at a version that inherits from
 * `from`: born into one of those versions, and not yet taken out by one.
 *
 * Membership rather than `<=`, because the chain is a chain rather than a
 * count. Versions happen to be numbered in order today and forks would end
 * that; nothing here would need changing when they do.
 */
export function standing(corner: Vertex, from: ReadonlySet<VersionId>): boolean {
  return from.has(corner.birth) && (corner.death === null || !from.has(corner.death));
}

/**
 * Polygons and groups held together, so that one transform moves all of them.
 *
 * **Structure is global; the transform is versioned.** Membership is one fact
 * about the world — a polygon is in this group or it is not, at every version
 * that has both. The transform has to be per-version or a group could not be
 * eroded at v3, which is what group transforms are for.
 *
 * `members` is ordered and may name groups as well as polygons, so groups nest.
 * Nothing here bounds the depth: the chain a vertex carries is the shader's
 * problem and the shipped level states how deep it goes.
 *
 * A group holds no geometry of its own. What it resolves to is a read taken
 * over what its members resolved to — the union, offset by the depth on its own
 * transform — and nothing is written back into them. See *Groups* in
 * `docs/versioning.md`.
 */
export interface Group {
  /** The version whose layer introduced it. Nothing before it may name it. */
  birth: VersionId
  members: Id[]
}

/**
 * A place in the world with a kind: where it was put, and nothing else.
 *
 * What has happened to it since belongs to the versions, exactly as it does for
 * a polygon — an artefact carries no transform of its own, because there is no
 * version at which it would be the right one. So `at` is the point as it was
 * dropped, in the artefact's own frame, and where it *is* at a version is that
 * point taken through every transform down the chain.
 *
 * The same layer a polygon gets, which is the whole of the design: a version's
 * transform is what that version does, so a move written at v1 is carried by
 * every version after it rather than overruled by them, an artefact inside a
 * group goes where the group goes, and a turn about a pivot is a turn about a
 * pivot however many of them one version writes in a row.
 *
 * Erosion is the one part of a transform that means nothing here. A point has
 * no thickness to take a depth out of, and the gestures leave it alone.
 */
export interface Artefact {
  type: ArtefactType
  /** The version whose layer introduced it. Nothing before it may name it. */
  birth: VersionId
  /** In its own frame, before any version's transform. */
  at: Point
}

/**
 * A walk somebody might take through the level, and nothing more.
 *
 * A measuring tape rather than a part of the world: it is not shipped, nothing
 * collides with it, and no version transforms it. What it is for is the one
 * question the geometry cannot answer by being looked at — how long the walk
 * from here to there takes — and the answer is the run of the points times the
 * speed the player walks at. See `seconds`.
 *
 * Version-independent deliberately. A path is drawn over whichever version is
 * being looked at and reads the same over all of them, because the thing being
 * measured is the route, and comparing the same route against two versions is
 * most of what one is drawn for.
 */
export interface Path {
  points: Point[]
}

export interface World {
  polygons: Map<PolygonId, Polygon>
  groups: Map<GroupId, Group>
  artefacts: Map<ArtefactId, Artefact>
  /** The measuring paths. Not part of the level — see `Path`. */
  paths: Map<PathId, Path>
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
    groups: new Map(),
    artefacts: new Map(),
    paths: new Map(),
    nextId: 0,

    versions: Array.from({ length: VERSIONS }, (_unused, i) => ({
      name: `v${i}`,
      base: i === 0 ? null : i - 1,
      visible: true,
      edits: new Map(),
    })),
  };
}

// -----------------------------------------------------------------------------
// Reading the structure
//
// A group holds its members, because that is the direction that cannot go
// inconsistent: two groups claiming the same member is unrepresentable, and
// there is nothing to keep in step. Everything that reads the structure asks
// the other way round — what encloses me — so the index for that is derived,
// and cached against the map it was derived from.
// -----------------------------------------------------------------------------

const parents = new WeakMap<World['groups'], ReadonlyMap<Id, GroupId>>();

/** Who each member belongs to. Nothing for anything at the top level. */
export function parentOf(world: World): ReadonlyMap<Id, GroupId> {
  const held = parents.get(world.groups);

  if (held !== undefined) return held;

  const out = new Map<Id, GroupId>();

  for (const [id, group] of world.groups) {
    for (const member of group.members) out.set(member, id);
  }

  parents.set(world.groups, out);

  return out;
}

/** Every group `id` is inside, innermost first. Empty at the top level. */
export function enclosing(world: World, id: Id): GroupId[] {
  const up = parentOf(world);
  const out: GroupId[] = [];

  // A group that contained one of its own ancestors would spin here. Making
  // that unrepresentable is the joining command's, so this only has to not be
  // the place it is discovered.
  const seen = new Set<Id>([id]);

  let at = up.get(id);

  while (at !== undefined && !seen.has(at)) {
    out.push(at);
    seen.add(at);
    at = up.get(at);
  }

  return out;
}

/** The outermost thing `id` moves with, which is `id` itself at the top level.
 * What a click selects. */
export function outermost(world: World, id: Id): Id {
  const up = enclosing(world, id);

  return up[up.length - 1] ?? id;
}

/** `id` and everything under it, groups included. What a removal has to reach
 * and what a join has to refuse to swallow. */
export function within(world: World, id: Id): Id[] {
  const group = world.groups.get(id);

  if (group === undefined) return [id];

  return [id, ...group.members.flatMap(m => within(world, m))];
}

/**
 * The groups a click is currently inside, outermost first: the path opened by
 * double-clicking down into them.
 *
 * Derived from one id rather than stored as a list, because the structure is
 * the only thing that says what a group is inside, and a stored path could
 * disagree with it — ungrouping something two levels up would leave a route to
 * a place that is no longer anywhere.
 *
 * Empty where `inside` is nothing, and empty where it names a group that has
 * since been ungrouped or deleted. Being let out by an edit is the right
 * failure: there is no longer a group to be in.
 */
export function opened(world: World, inside: GroupId | null): GroupId[] {
  if (inside === null || !world.groups.has(inside)) return [];

  return [...enclosing(world, inside).reverse(), inside];
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
  artefacts: ArtefactId[]
}

export const EMPTY_SELECTION: Selection = { polygons: [], vertices: [], artefacts: [] };

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
 * Something lifted out of the world, ready to be put back — from the version it
 * was taken at onward, and nothing before that.
 *
 * The copy version becomes the geometry: rings in world units as they stood
 * there, which is why a clipping has no ids worth keeping and no transform for
 * where it came from. Everything after it is a layer keyed by **how far past
 * the copy** it was, so pasting somewhere else replays the same sequence from
 * there: v1 into v3, v2 into v4, and on. The offsets always start at 0, and the
 * layer at 0 carries the depth, which is the one thing a ring cannot hold.
 *
 * A vertex is named by id in the ring and again in every layer that displaces
 * it, and those two have to keep agreeing. Paste remints them together.
 *
 * `birth` and `death` on a corner are offsets too, so a corner the original
 * grows at v3 the copy grows three versions after it lands.
 */
export type Clipping =
  | {
      kind: 'polygon'
      type: PolygonType
      points: Vertex[]
      edits: [number, Edit][]
    }
  | { kind: 'group', members: Clipping[], edits: [number, Edit][] }
  /** An artefact, the same way round as a polygon: where it stood at the copy
   * version in world units, and every layer after it keyed by how far past the
   * copy it was. */
  | { kind: 'artefact', type: ArtefactType, at: Point, edits: [number, Edit][] }

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
      polygons: s.selection.polygons.filter(
        id => s.world.polygons.has(id) || s.world.groups.has(id),
      ),
      vertices: s.selection.vertices.filter(id => corners.has(id)),
      artefacts: s.selection.artefacts.filter(id => s.world.artefacts.has(id)),
    },
  };
}

/**
 * The walk from one version to another, as far along as it has got.
 *
 * Not a fact about the document — nothing it does survives it, and it does not
 * change what is on screen underneath, which is already at `to`. It sits in the
 * store all the same, because two views now watch the same walk go by: the
 * canvas draws the outline it passes through, and the 3D view flies the same
 * `t` into the shader. One clock, so they cannot drift apart.
 */
export interface Replay {
  from: VersionId
  to: VersionId
  /** 0 to 1 over the whole walk, however many versions it crosses. */
  at: number
}

// How a version switch is played — the length, the curves and which one — is
// the game's, and the editor plays on the same clock. Re-exported here because
// this is where the editor reads what it is, and one import site is one place
// to look.
export { EASINGS, REPLAY_EASE, REPLAY_MS } from '@ce/game';
export type { Ease, Easing } from '@ce/game';

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
  /**
   * The group being edited inside, or nothing at the top level.
   *
   * A group draws as one outline and picks as one thing; going inside one is
   * how its members become separately pickable, transformable and erodeable.
   * The innermost open group is enough to say the whole path, because a group
   * is inside exactly one other — see `opened`.
   *
   * Not in the file. Where the cursor happens to be standing is about this
   * sitting, in the same way the selection is.
   */
  inside: GroupId | null

  settings: Settings
  view: View
  tool: Tool

  /** A version switch being watched go by, rather than jumped. Null between
   * them, which is nearly always. */
  replay: Replay | null
  /** Whether the 3D view is up. It costs a WebGL context and a walk of the
   * bake, so it is asked for rather than assumed. */
  preview: boolean
  /**
   * Standing in it rather than looking at it: the 3D view over the whole
   * window, the camera at eye height, and the keyboard belonging to whoever is
   * walking rather than to the editor. `\` goes in and Escape comes back.
   *
   * It implies `preview` — the view is up for as long as someone is inside it,
   * whether or not the panel was — and it takes the shortcuts away from the
   * canvas while it is on, or W and S would strafe and scale at once.
   */
  roaming: boolean

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
    inside: null,
    settings: defaultSettings,
    view: defaultView,
    tool: 'point',
    replay: null,
    preview: false,
    roaming: false,
    bake: { spans: new Map(), progress: null },
    history: EMPTY_HISTORY,
    clipboard: [],
  };
}
