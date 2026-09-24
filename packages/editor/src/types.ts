import {
  ArtefactType,
  FloorPart,
  IconType,
  KINDS,
  LevelPart,
  PARTS,
  Point,
  SETS,
  PolygonKind,
  SetName,
  SCALE,
  TILE_SIZE,
  SLOTS,
  SLOT_KINDS,
  SLOT_PARTS,
  inside,
  inverted,
  kindKey,
  kindName,
  sameKind,
  slotOf,
  voidOnly,
} from '@ce/game/world';
import type { Bake } from './bake';
import type { Place } from './keys';
import type { Facets, Pattern, Sides } from './geometry';
import type { Amount, Entry, Frame, Key, KeyRig, Keyframe, KeyframeId, Move } from './rig';
// From the leaf, not from `./rig`: `rig.ts` reads this file for `enclosing`,
// so importing a value back out of it would be a runtime cycle. See
// `cornermaps.ts`.
import { CORNER_MAPS, eachCornerMap } from './cornermaps';

export type { ArtefactType, FloorPart, IconType, LevelPart, Point, PolygonKind, SetName };
export type { Keyframe, KeyframeId };
export { KINDS, PARTS, SETS, SLOTS, SLOT_KINDS, SLOT_PARTS, inside, inverted, kindKey, kindName, sameKind, slotOf, voidOnly };

/** The kinds, in the order the number keys pick them. */
export const ARTEFACTS: ArtefactType[] = [
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
  /** World units between two grid dots. Halved and doubled by `+` and `-`. */
  gridSize: number
  showGrid: boolean
}

/**
 * The grid starts at one tile of the game's floor, taken back into editor
 * units — the one grid the level is seen against from inside, so it is the one
 * it is drawn on from above. `+` and `-` halve and double from there, which
 * keeps every size the author can reach a division of the tile.
 */
export const defaultSettings: Settings = {
  gridSize: TILE_SIZE / SCALE,
  showGrid: true,
};

/**
 * A point on the grid.
 *
 * There is no setting for whether to snap, and there was one. Everything the
 * editor does lands on the grid, and Ctrl held is how a hand says otherwise —
 * per gesture, at the moment it is wanted, which is when the question actually
 * comes up. A switch somewhere else answers it once for a whole session, which
 * is both too often and not often enough.
 */
export function onGrid(p: Point, size: number): Point {
  return {
    x: Math.round(p.x / size) * size,
    y: Math.round(p.y / size) * size,
  };
}

/** The same, for one number: a step, a depth, an angle in its own units. */
export function toStep(n: number, step: number): number {
  return Math.round(n / step) * step;
}

// -----------------------------------------------------------------------------
// Tools
// -----------------------------------------------------------------------------

export type Tool = Picking | 'create' | 'artefact' | 'path';

/**
 * The selection tool, by what it picks: whole things, edges, or corners.
 *
 * One tool with three answers rather than three tools, because they share
 * everything but the question — a click picks, a drag moves what is picked,
 * and the effect keys act on it — and a toolbar with a row for each would be
 * a toolbar about selecting. They are chosen beside it once it is up, the way
 * the create tool picks its figure.
 */
export type Picking = 'polygon' | 'edge' | 'point';

export const PICKINGS: Picking[] = ['polygon', 'edge', 'point'];

export function picks(tool: Tool): tool is Picking {
  return tool === 'polygon' || tool === 'edge' || tool === 'point';
}

/**
 * What the create tool draws.
 *
 * A tool rather than four, because they all answer the same question — what
 * new shape goes here — and a toolbar that spends a row on each would be a
 * toolbar about shapes rather than about what one is doing. The kind is picked
 * beside the tool once it is up, the way a brush picks its size.
 */
export type Figure = 'polyline' | 'rect' | 'ngon';

export const FIGURES: Figure[] = ['rect', 'ngon', 'polyline'];

/** Sides an n-gon can have. Three is the fewest that closes; past a couple of
 * dozen the corners are inside a pixel of each other and it is a circle drawn
 * the expensive way. */
export const NGON_MIN = 3;
export const NGON_MAX = 24;

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
  zoom: 0.25,
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

/**
 * As far in as a level is worth looking, and as far out.
 *
 * Both ends are about what is legible rather than about arithmetic. Past the
 * near end a grid cell is wider than the window and there is nothing to see
 * beside itself; past the far end a room is a few pixels across and the
 * handles it is edited by are on top of one another.
 */
export const ZOOM_MIN = 0.02;
export const ZOOM_MAX = 32;

/**
 * Zoomed about a point on screen, which stays over the same world point.
 *
 * The whole of what makes a wheel zoom feel like one: the thing under the
 * cursor is what the gesture is about, so it is the thing that must not move.
 */
export function zoomedAt(view: View, by: number, screen: Point): View {
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, view.zoom * by));
  const at = toWorld(view, screen);

  return {
    ...view,
    zoom,
    x: at.x - screen.x / zoom,
    y: at.y - screen.y / zoom,
  };
}

/**
 * The grid one step finer or coarser.
 *
 * Halving and doubling, so that every size in the sequence is a whole number
 * of the ones below it and a point laid on a fine grid is still on the coarse
 * one. Any other ratio makes a coarser grid that the drawing already on screen
 * does not sit on, which is the opposite of what a grid is for.
 */
export function finer(size: number): number {
  return Math.max(GRID_MIN, size / 2);
}

export function coarser(size: number): number {
  return Math.min(GRID_MAX, size * 2);
}

const GRID_MIN = 1;
const GRID_MAX = 1024;

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

// -----------------------------------------------------------------------------
// Identities
//
// All of them come from one counter on `World`, so an id is unique across the
// document and can never be confused for another kind. Everything a timeline
// names, it names by id: an entry keyed by array index re-points at the wrong
// thing the moment something upstream is inserted.
//
// Keyframes are the exception, and count on their own: they are not things in
// the world, and nothing holds or transforms one.
// -----------------------------------------------------------------------------

export type PolygonId = number;
export type PathId = number;
export type GroupId = number;
export type VertexId = number;
export type ArtefactId = number;

/** Whatever can have a timeline. One counter, so no two ever collide and a
 * map over all of them is well defined. */
export type Id = PolygonId | GroupId | ArtefactId | PathId;

/**
 * A corner, where it was put when it was drawn, and the stretch of the chain
 * over which it is one of the polygon's.
 *
 * Corners come and go the way polygons do, and for the same reason: what is
 * written at a keyframe plays from there on, and nothing written there may
 * reach back past it. Adding a corner at v3 and having it appear at v0 is
 * exactly the backward propagation the whole design is built to refuse.
 *
 * `death` is where it stops, not the last keyframe that has it, so the two read
 * the same way round: alive from `birth`, gone from `death`.
 */
export interface Vertex {
  id: VertexId
  at: Point
  /**
   * Which of the polygon's rings it is a corner of. Nought is the outline; the
   * rest are holes.
   *
   * On the corner rather than on the polygon, because it is the one place that
   * survives what happens to corners. A polygon keeps every corner it has ever
   * had, dead ones in place, so that one can be inserted between two others —
   * and a ring boundary stored as an index into that list would be a number
   * that means a different thing at every version. A corner knows which ring it
   * is in for as long as it exists, which is exactly as long as the question
   * can be asked about it.
   *
   * Corners are kept grouped by it and in ring order. Nothing here enforces
   * that; `addVertex` puts a new corner beside the one it was added after, and
   * that is the only way one arrives.
   */
  ring: number
  /** The keyframe that put it there. */
  birth: KeyframeId
  /** The keyframe that took it out, or nothing while it still stands. */
  death: KeyframeId | null
  /**
   * For a tooth a deform made, the corner of the polygon's own whose edge it
   * is on: what puts it in its place among the corners. Absent for a corner
   * of the polygon's own. See `deformedAt` in `scene.ts`.
   */
  root?: VertexId
  /**
   * For a corner a resolve wrote down that was not a corner: which of the
   * polygon's own corners starts the run it is a sample of, and how far along
   * that run it sits.
   *
   * Absent is a drawn corner, which is what a corner somebody drew is and what
   * a crossing an arrangement made is. Present says the opposite: this point
   * is one of however many a curve was described with.
   *
   * Why it has to be written down. A scope hands its members the bare ring it
   * folded and its own effects, so the same fold lays them again — which is
   * law 1 by construction, *if* what the ring's points are survives being
   * written down. Without this it does not: the ring becomes a polygon of
   * corners, and a deform after it reads every facet of every arc as a place
   * its rhythm may restart. An arc a scope was carrying came back as a row of
   * corners with a tooth on each.
   *
   * It is not the member's original name — that named a member this polygon
   * has no memory of. It is the same *structure*: `identify` reads it and lays
   * `on(corner, t)` where it says so, and a corner where it does not. That is
   * all anything downstream asks of it. See `identify` in `ids.ts`.
   */
  sample?: { of: VertexId, t: number }
  /**
   * What a crossing a scope had was a crossing of: the corners whose edges
   * made it, in this polygon's own corners, as far back as it goes: see
   * `Parent`. Two crossings on one edge say so, whether or not the corner it
   * leaves is still there, and so does a crossing on an edge that was itself
   * a crossing's.
   *
   * Why it has to be written down. The deform reads a wall cut in two by
   * something rising through it off the crossings' names — each piece is
   * `born` of the wall, and the wall lays one pattern along all of them from
   * its own middle. Resolved into plain corners, every piece was laid from its
   * own middle instead, and the polygon drew different teeth from the scope it
   * came of. `identify` reads it and names the point `born` of the two again.
   * See `linesOf` in `effect.ts`.
   */
  crossing?: { a: Parent, b: Parent }
  /**
   * The corner this one has the same name as, where an arrangement left two
   * points of one ring called the same thing. A scope reads them as one edge
   * leaving from two places, and so, with this, does the polygon it resolves
   * to. See `crossing`.
   */
  twin?: VertexId
}

/**
 * One of the two edges a crossing is of: see `Vertex.crossing`. The corner it
 * leaves; or, that corner cut away, the crossing it was, of two edges again;
 * or, a corner cut away that was nobody's crossing, which of the polygon's
 * cut-away corners it is.
 */
export type Parent = { at: VertexId } | { born: [Parent, Parent] } | { cut: number }

/**
 * Where each ring starts, in a list of corners kept in ring order.
 *
 * Derived rather than stored, everywhere and every time. The corners standing
 * at a version are a different list from the corners standing at the next one,
 * and a stored boundary would have to be maintained against both — which is the
 * bookkeeping `Vertex.ring` exists to avoid. Given the corners, the answer is
 * one pass.
 *
 * A ring that has lost all its corners leaves no gap: the starts are the starts
 * of the rings that are actually here, in the order they are here in, and
 * nothing downstream ever asks which number a ring used to go by.
 */
export function ringsOf(corners: readonly Vertex[]): number[] {
  const out: number[] = [];

  corners.forEach((c, i) => {
    if (i === 0 || c.ring !== corners[i - 1].ring) out.push(i);
  });

  return out;
}

/**
 * The points as they were laid down, and nothing else. What has happened to
 * them since is its timeline — see `rig.ts` — and where it is at a keyframe is
 * its rest geometry through the frame that timeline plays to there.
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
 *
 * More than one ring, and they are laid end to end in this same list: the
 * outline first and its holes after it, each corner saying which it belongs to.
 * A hole is the courtyard a ring of rooms encloses, which is a shape the CSG
 * has always been able to make and the source had no way to hold — see
 * `Vertex.ring` for why the boundary is on the corner rather than here, and
 * `ringsOf` for how it is read back.
 */
export type Polygon = PolygonKind & {
  /** The keyframe that introduced it. Nothing before it may name it. */
  birth: KeyframeId
  /** The version whose layer took it out, or nothing while it stands. Exactly
   * a corner's `death`, one level up: see `standing`. */
  death: KeyframeId | null
  points: Vertex[]
}

/** A polygon's kind on its own, for the places that hold one without the
 * geometry it belongs to. A polygon *is* a kind — this only narrows it. */
export function kindOf(p: PolygonKind): PolygonKind {
  return {
    ...(p.level === undefined ? {} : { level: p.level }),
    ...(p.floor === undefined ? {} : { floor: p.floor }),
  };
}

/** A polygon with its kind taken off, so that another can be put on without
 * a part of the old one surviving underneath where the new one is silent. */
export function unkinded<P extends PolygonKind>(p: P): Omit<P, 'level' | 'floor'> {
  const { level: _level, floor: _floor, ...rest } = p;

  return rest;
}

/**
 * Whether something is there at a version that inherits from `from`: born into
 * one of those versions, and not yet taken out by one.
 *
 * Membership rather than `<=`, because the chain is a chain rather than a
 * count. Versions happen to be numbered in order today and forks would end
 * that; nothing here would need changing when they do.
 *
 * A corner, a polygon, a group and an artefact all answer it the same way and
 * all four ask it, so this takes the pair rather than the thing. Existence is
 * one question in this world, asked at four sizes.
 */
export function standing(
  it: { birth: KeyframeId, death: KeyframeId | null },
  from: ReadonlySet<KeyframeId>,
): boolean {
  return from.has(it.birth) && (it.death === null || !from.has(it.death));
}

/**
 * Polygons and groups held together, so that one timeline moves all of them.
 *
 * **Structure is global; the timeline is per keyframe.** Membership is one
 * fact about the world — a polygon is in this group or it is not, at every
 * keyframe — and so is the group itself: it has no birth and no death, and is
 * there wherever anything it holds is. What differs from keyframe to keyframe
 * is what its timeline does, or a group could not be eroded at v3, which is
 * what a group's timeline is for.
 *
 * Deleting a group at a keyframe takes out what it holds from there on, and
 * leaves the group holding them: the structure is the same at every keyframe,
 * and a group with nothing standing in it is simply not drawn there.
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
  members: Id[]
  /**
   * Whether the group is a set of its own, or only a handle.
   *
   * These are two different things to want and there is no reading of one that
   * gives the other, so a group says which it is.
   *
   * A loose group — `false`, and what grouping produces — is strictly about
   * moving geometry together. Its members go into the set one by one exactly as
   * they would if it were not there: a pillar in one still cuts the rooms
   * around it and a floor in one is still drawn wherever it reaches. It has no
   * boundary of its own, and nothing about the picture changes when one is
   * made or unmade.
   *
   * A sealed group is a scope. Its slots are resolved within it — `level -
   * (solid - void)`, and `floor - void` cut to that level — and what leaves it
   * is one shape per set with nothing left in it that cuts. That is the whole
   * of the difference, and it is a thing an author asks for rather than a thing
   * that happens to them.
   *
   * What that shape is follows from what the group holds: its outermost kind.
   * A room with pillars in it is a level; pillars with holes in them and no
   * room are a solid, and cut whatever room they are put in. See
   * `outermostSlot` in `scene.ts`.
   *
   * Eroding a loose group is refused. A depth is an offset of a union and
   * there is no union until the members are resolved into one, so there is
   * nothing for the depth to move.
   */
  sealed: boolean
  /**
   * The keyframe it was made at, where its first key is its shape rather than
   * a motion and is not shown. Nothing is the first keyframe, which is what a
   * group from before this was kept reads as. Only the keyframe view and a
   * break ask: a group is there wherever its members are.
   */
  birth?: KeyframeId
}

/**
 * A place in the world with a kind: where it was put, and nothing else.
 *
 * What has happened to it since is its timeline, exactly as it is for a polygon.
 * So `at` is the point as it was dropped, in the artefact's own frame, and where
 * it *is* at a keyframe is that point taken through the frame its timeline and
 * every group holding it play to there.
 *
 * The same timeline a polygon gets, which is the whole of the design: a move
 * written at v1 is carried by every keyframe after it rather than overruled by
 * them, an artefact inside a group goes where the group goes, and a turn about
 * a pivot is a turn about a pivot however many of them one keyframe holds.
 *
 * Erosion is the one operation that means nothing here. A point has no
 * thickness to take a depth out of, and the gestures leave it alone.
 */
export interface Artefact {
  type: ArtefactType
  /** The keyframe that introduced it. Nothing before it may name it. */
  birth: KeyframeId
  /** The keyframe that took it out, or nothing while it stands. */
  death: KeyframeId | null
  /** In its own frame, before anything its timeline does. */
  at: Point
}

/**
 * Where the player comes in, and which way they are looking.
 *
 * Not an artefact, and none of what is written above it applies. Every level
 * has exactly one start and no level can do without one, so it is a field
 * here rather than something an author has to remember to place and can place
 * twice — the editor opens with it standing at the origin and there is no
 * gesture that takes it away.
 *
 * Nor is it in the versions. A start is where the level begins, and the level
 * begins once: a place per version would be a question about which of them the
 * player comes in at, and the answer would always be the first. So a move
 * writes the point itself and every version reads the same one.
 *
 * The facing is a yaw the way the game measures it — see `Start` in
 * `world.ts`, which is what this is shipped as.
 */
export interface Start {
  at: Point
  facing: number
}

/**
 * A walk somebody might take through the level, and nothing more.
 *
 * A measuring tape rather than a part of the world: it is not shipped and
 * nothing collides with it. What it is for is the one question the geometry
 * cannot answer by being looked at — how long the walk from here to there
 * takes — and the answer is the run of the points times the speed the player
 * walks at. See `seconds`.
 *
 * The route is the same at every keyframe and the frame it is read in is not,
 * which is the one split that lets a tape be both. `points` is the walk as it
 * was laid down, in the path's own frame, and every keyframe reads the same
 * list — so a leg added at v3 is a leg at v0 too, and comparing the same route
 * against two keyframes goes on being what a path is drawn for. What a
 * keyframe may say about it is where it *is*: it has a timeline exactly as a
 * polygon does, and so does every group holding it. A room moved at v2 takes
 * the tape measuring it along.
 *
 * That is also why it has a life. It has to be a thing a group can hold — the
 * whole point of holding one is that the walk goes where the level goes — and
 * a member is something born into a keyframe and taken out at one, the same
 * way everything else in the world is.
 *
 * There is no ring under it and no depth on it. Its timeline nudges no corner
 * and deepens none, the way a group's does not, and the erosion gesture leaves
 * it alone the way it leaves an artefact alone: a walk has no thickness to
 * take a depth out of.
 */
export interface Path {
  /** The keyframe that introduced it. Nothing before it may name it. */
  birth: KeyframeId
  /** The keyframe that took it out, or nothing while it stands. */
  death: KeyframeId | null
  /** In its own frame, before anything its timeline does. */
  points: Point[]
}

export interface World {
  polygons: Map<PolygonId, Polygon>
  groups: Map<GroupId, Group>
  artefacts: Map<ArtefactId, Artefact>
  /** Where the player comes in. Always there, at every keyframe. See
   * `Start`. */
  start: Start
  /** The measuring paths. Not shipped and not collided with, but in the
   * timelines and in the groups like everything else — see `Path`. */
  paths: Map<PathId, Path>
  /** One counter for every kind of id. */
  nextId: number
  /** In order: the order is the array. */
  keyframes: Keyframe[]
  /**
   * What happens to each thing, keyframe by keyframe. Absent is nothing: a
   * thing nobody has written anything about stands at rest, wherever it was
   * put. See `rig.ts`.
   */
  rigs: Map<Id, KeyRig>
  /** What the timeline's row headers say about each thing: hidden, locked,
   * soloed. Absent is none of them. See `Flags`. */
  flags: ReadonlyMap<Id, Flags>
  /** Which effects each polygon or group has, and how: one fact over every
   * keyframe. How much is in its timeline. Absent is none. See `Effects`. */
  effects: ReadonlyMap<Id, Effects>
  /**
   * An edge's own deform options, over its polygon's, keyed by the corner the
   * edge leaves. Absent is its polygon's.
   *
   * The deform alone. A corner used to be able to carry a round of its own
   * under the same key — the id read as the corner rather than as the edge —
   * and it cannot any more: a round is an opening, an opening is a statement
   * about the whole ring, and a bevel at one corner with nought at its
   * neighbours leaves a chord rather than a wall offset by the bevel. A ring
   * takes the largest bevel anybody on it asked for. See `rounding` in
   * `effect.ts`.
   *
   * The name is kept so that a file written before this still loads; the
   * round a file carries is dropped on the way in.
   */
  cornerEffects: ReadonlyMap<VertexId, Pick<Effects, 'deform'>>
}

/**
 * The effects on a thing, around its erosion and always in this order: its
 * edges deformed, then eroded, then its corners rounded.
 *
 * An effect switched `off` is kept, options and amounts and all, and does
 * nothing: unticking one in the pane is a question of whether it applies, and
 * its timeline is still there when it is ticked again. A corner's own round
 * switched off leaves that corner square; its thing's switched off leaves
 * every corner square, its own options or not.
 *
 * Not passes but facts. Nothing is ever rounded twice or deformed twice: which
 * effects a thing has, and how, is one fact about it over every keyframe, as
 * its shape is, and how much — the bevel, the amplitude — is an operation,
 * like erosion. A count, a pattern or a seed does not change over time.
 *
 * - `round`: each corner an arc starting as deep along each edge as its
 *   bevel, along a curve that leaves the edges with no curvature, in as many
 *   segments as keep it within `precision` of that curve — closer where it
 *   bends more (see `segmentsFor`, `spread`) — or one for a `chamfer`.
 *   `tension` is how hard it turns in its middle and how straight it runs
 *   off its edges, from about a circle at nought to tight in the corner at
 *   one (see `curveOf`).
 * - `deform`: points put into each edge every `spacing` of its length, the
 *   gaps between them stretched and squeezed by `jitter`, and pushed off it by
 *   the pattern. `seed` is the noise's and the jitter's. The teeth stop short
 *   of a polygon's rounds, whose arcs take teeth of their own: see
 *   `outlineOf`.
 */
export interface Effects {
  /**
   * `facets` is a count written down rather than asked for, and it wins over
   * the precision where it is there. Nothing an author sets: the precision is
   * the knob, and it is the better one, being bevel-independent. A count is
   * here because a *fade* — two counts and how far between them — is what a
   * precision cannot say, and a resolve has to hand on the fade a fold had in
   * flight. See `Round.facets` and `publishing` in `resolve.ts`.
   *
   * `facetsAt` is the bevel that count was taken at, and the count only holds
   * there. A bevel is an amount and an author may add to it; a count taken at
   * the smaller one would then be drawn at the bigger, and the corner would
   * come out coarser than the precision asks — which is the round a scope
   * would have laid on the same ring. Past it the precision takes over again.
   */
  round?: { precision: number, tension: number, chamfer: boolean, off?: boolean, facets?: Facets, facetsAt?: number }
  /**
   * `falloff` is how far a tooth reaches along an arc: see
   * `Effecting.falloff`.
   *
   * `offset` is whether each run's teeth start off its middle by a share of
   * the spacing its seed gives it — see `Effecting.offset`. Absent, they do
   * not: they are centred on the run. One default, because there is one
   * pipeline — a deform is a ring to a ring, and it cannot read off which kind
   * of thing carried it there. A polygon's used to be offset and a scope's
   * fold's centred, and a resolve had to write the difference down onto the
   * ring it made to keep the two agreeing; that is law 3, and the fix is the
   * default rather than the writing down.
   */
  deform?: {
    spacing: number
    pattern: Pattern
    seed: number
    sides: Sides
    jitter: number
    falloff?: number
    offset?: boolean
    /**
     * How far along the wall the pattern's middle sits from this edge's own
     * middle, and how far either way from there it runs. Lengths, at the
     * thing's own scale, and about one edge — they mean nothing written about
     * a whole polygon, so they live in `cornerEffects`.
     *
     * A resolve writes them: a scope centres a run on the member edge that
     * named it and reaches that edge's half length, and the ring it hands
     * back has no member edge to centre on. Absent, an edge is centred on
     * itself and reaches its own ends, which is what a polygon has always
     * done. See PLAN-bevel's 2.1 and `publishing` in `resolve.ts`.
     */
    anchor?: number
    reach?: number
    /**
     * What names this edge's run to the pattern — the noise, the jitter and
     * the share of the spacing a seeded start offsets by are all read off it.
     * Its own corner, where it does not say otherwise.
     *
     * A resolve writes it, for the same reason it writes the anchor: the run
     * was a member edge's and the pattern along it is that edge's, down to
     * which way each tooth was nudged. See `ArcDeform.ids`.
     */
    key?: number
    off?: boolean
  }
  /** Erosion has no options, so it is here only to be switched off. */
  erode?: { off: boolean }
}

/** The options of the effects that have them. */
export type Options = Required<Pick<Effects, 'round' | 'deform'>>;

/** The options an effect starts with before any has been chosen. */
export const REMEMBERED: Options = {
  round: { precision: 0.5, tension: 0.5, chamfer: false },
  deform: { spacing: 20, pattern: 'zigzag', seed: 0, sides: 'both', jitter: 0 },
};

/**
 * How the editor treats a thing, rather than what it is: the switches on a
 * timeline row.
 *
 * None of them reach the level. A hidden room is still in the CSG, and so is
 * everything a solo leaves out — they are about what the canvas draws and what
 * a click can land on, and nothing about what is shipped.
 *
 * - `hidden`: not drawn as itself, and not picked.
 * - `locked`: drawn, and not picked.
 * - `solo`: while anything is soloed, only what is soloed is drawn and picked
 *   — with what holds it and what it holds.
 *
 * A group's flag is its members' too.
 */
export interface Flags {
  hidden: boolean
  locked: boolean
  solo: boolean
}

const NO_FLAGS: Flags = { hidden: false, locked: false, solo: false };

export function flagsOf(world: World, id: Id): Flags {
  return world.flags.get(id) ?? NO_FLAGS;
}

/** One flag on a thing set. A thing with none left is taken out of the map. */
export function flagged(world: World, id: Id, flag: keyof Flags, on: boolean): World {
  const was = flagsOf(world, id);

  if (was[flag] === on) return world;

  const now = { ...was, [flag]: on };
  const flags = new Map(world.flags);

  if (now.hidden || now.locked || now.solo) flags.set(id, now);
  else flags.delete(id);

  return { ...world, flags };
}

const soloed = new WeakMap<ReadonlyMap<Id, Flags>, { groups: World['groups'], ids: ReadonlySet<Id> | null }>();

/**
 * Everything a solo keeps: each soloed thing, what it holds and what holds it.
 * Nothing where nothing is soloed — or only things that are gone, which would
 * otherwise leave the canvas empty with no row left to turn it off on.
 */
function soloing(world: World): ReadonlySet<Id> | null {
  const held = soloed.get(world.flags);

  if (held !== undefined && held.groups === world.groups) return held.ids;

  let ids: Set<Id> | null = null;

  for (const [id, f] of world.flags) {
    if (!f.solo || !exists(world, id)) continue;

    ids ??= new Set();

    for (const m of within(world, id)) ids.add(m);
    for (const g of enclosing(world, id)) ids.add(g);
  }

  soloed.set(world.flags, { groups: world.groups, ids });

  return ids;
}

function exists(world: World, id: Id): boolean {
  return world.polygons.has(id) || world.groups.has(id) || world.artefacts.has(id) || world.paths.has(id);
}

/** Whether a flag is on the thing or on anything holding it. */
function inherits(world: World, id: Id, flag: 'hidden' | 'locked'): boolean {
  return flagsOf(world, id)[flag] || enclosing(world, id).some(g => flagsOf(world, g)[flag]);
}

/** Whether the canvas draws a thing as itself. See `Flags`. */
export function visible(world: World, id: Id): boolean {
  if (world.flags.size === 0) return true;

  const solo = soloing(world);

  return (solo === null || solo.has(id)) && !inherits(world, id, 'hidden');
}

/** Whether a click may land on a thing: drawn, and not locked. */
export function clickable(world: World, id: Id): boolean {
  return world.flags.size === 0 || (visible(world, id) && !inherits(world, id, 'locked'));
}

/** How many keyframes a new world starts with: long enough to author a shrink
 * sequence against. More are inserted and deleted from there — see `keys.ts`. */
const STARTING = 9;

export function emptyWorld(): World {
  return {
    polygons: new Map(),
    groups: new Map(),
    artefacts: new Map(),
    start: { at: { x: 0, y: 0 }, facing: 0 },
    paths: new Map(),
    nextId: 0,
    keyframes: Array.from({ length: STARTING }, (_unused, i) => ({
      id: i,
      name: `v${i}`,
      visible: true,
    })),
    rigs: new Map(),
    flags: new Map(),
    effects: new Map(),
    cornerEffects: new Map(),
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

/** The structure alone: what the readers below need of a world, and all of
 * it. The timelines in `rig.ts` walk it without a world to hand. */
export interface Structure {
  groups: ReadonlyMap<GroupId, { members: readonly Id[] }>
}

const parents = new WeakMap<Structure['groups'], ReadonlyMap<Id, GroupId>>();

/** Who each member belongs to. Nothing for anything at the top level. */
export function parentOf(world: Structure): ReadonlyMap<Id, GroupId> {
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
export function enclosing(world: Structure, id: Id): GroupId[] {
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
  /** Picked edges, each by the drawn corner it starts at — the corner its
   * amplitude is kept by. */
  edges: VertexId[]
  artefacts: ArtefactId[]
  /**
   * The picked paths, whole.
   *
   * Its own list rather than a share of `polygons`, for the reason the
   * artefacts have one: a group's members are of every kind and the selection
   * is not, so what comes out of an ungroup has to have somewhere to go. A
   * single point of a path is a different question and is not in here at all —
   * see `Local.onPath` in `canvas.ts`, which is about a gesture rather than
   * about the document.
   */
  paths: PathId[]
  /**
   * Whether the start is picked, which is a flag rather than an id because
   * there is one of it and it has none.
   *
   * On its own, always: the start is not in the versions, so a gesture that
   * held it and a room together would be writing into two different places and
   * meaning one thing by it. Picking it drops everything else, and everything
   * else drops it.
   */
  start: boolean
  /**
   * Whether the eye — where whoever is standing in the 3D view is standing —
   * is picked. A flag for the reason the start's is one, and picked alone for
   * the same reason: it is in no version either, and nothing else moves when
   * it moves.
   */
  eye: boolean
}

export const EMPTY_SELECTION: Selection = {
  polygons: [],
  vertices: [],
  edges: [],
  artefacts: [],
  paths: [],
  start: false,
  eye: false,
};

/**
 * Where whoever is looking through the 3D view is standing, in the canvas'
 * own units — the same point and the same yaw the start is written in, so the
 * two are drawn by one routine and dragged by one gesture.
 *
 * Not in the world and not in the editor's store: it is where somebody's eye
 * happens to be this minute, it survives nothing, and the only two things that
 * care are the panel that moves it and the canvas that draws it. It is shared
 * between them by a `stateful` holding both — which is the whole of the
 * two-way binding: the panel writes it every frame it walks, the canvas writes
 * it when the ghost is dragged, and each reads what the other wrote.
 */
export interface Eye {
  at: Point
  facing: number
}

/**
 * The two that are picked alone, let go.
 *
 * Both the start and the eye are picked on their own and dropped by anything
 * else being picked — they are in no version, so a gesture holding one of them
 * together with a room would be writing into two places and meaning one thing
 * by it. That is one rule, and this is the one place it is written: a pick
 * that is about something in the level says `dropped(s.selection)` and cannot
 * forget half of it.
 */
export function dropped(selection: Selection): Selection {
  if (!selection.start && !selection.eye) return selection;

  return { ...selection, start: false, eye: false };
}

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
 * Something lifted out of the world, ready to be put back — from the keyframe
 * it was taken at onward, and nothing before that.
 *
 * The keyframe before the copy becomes where it starts: its state there, as a
 * frame and a depth, over the geometry it had at the copy. Everything from the
 * copy on is keyed by **how far past the copy** it was, so pasting somewhere
 * else replays the same sequence from there: v1 into v3, v2 into v4, and on.
 *
 * The geometry is its own rest geometry, with every nudge up to the copy put
 * into it, and the frame is what places it. So an operation written after the
 * copy still acts about the painted point it was written about, and a scale
 * along the thing's own axes is along the same axes.
 *
 * `start` is its own frame at the copy keyframe, in the frame of whatever held
 * it — except for the outermost things copied, whose holders do not come with
 * them, where it is in world units. Paste reads it back in the frame it lands
 * in.
 *
 * `birth` and `death` on a corner are offsets too, so a corner the original
 * grows at v3 the copy grows three keyframes after it lands. `death` on the
 * clipping itself is one as well, and is nothing for a thing the original never
 * removes: what is copied is a life, and one that ends two keyframes on ends
 * two keyframes after the paste.
 */
export interface Timed {
  death?: number
  /** Where it starts: where the keyframe before the copy left it. */
  start: Frame
  erosion: number
  /** Its bevel and amplitude there, as `erosion`. Absent is nought. */
  bevel?: number
  amplitude?: number
  /** Where it stood at the copy keyframe, everything there in: what a stamp
   * starts at. */
  stood: { frame: Frame, erosion: number, bevel?: number, amplitude?: number }
  /** Each keyframe's keys from the copy on, by offset. */
  keys: [number, Key[]][]
  /** Its effects. Absent is none. */
  effects?: Effects
  /** The repeats that came across as single entries. */
  unrolled: Unrolled[]
}

/**
 * A repeat that could not stay one across a fold, and was written as a single
 * key per step instead — which looks the same, but edits as many things, and
 * stops at the last keyframe there is today. See `carried` in `scene.ts`.
 *
 * `id` wrote it, at `at`, as the `nth` key there. `why`:
 *
 * - `squash`: across a squash it is a turn, a skew and a stretch, never one
 *   operation;
 * - `reshaped`: the group turns, scales or skews while it runs;
 * - `moving`: a group's repeat, and what it is aimed at moves while it runs;
 * - `order`: a repeat running beside it that began before it had to be.
 */
export interface Unrolled {
  id: Id
  at: KeyframeId
  nth: number
  why: 'squash' | 'reshaped' | 'moving' | 'order'
}


export type Clipping =
  | ({
      kind: 'polygon'
      points: Vertex[]
      /** The extra depth on single corners at the copy keyframe. */
      depths: [VertexId, number][]
      /** The extra bevel on single corners there, and amplitude on single
       * edges. Absent is none. */
      bevels?: [VertexId, number][]
      amplitudes?: [VertexId, number][]
      /** Its corners' own options. Absent is none. */
      cornerEffects?: [VertexId, Partial<Effects>][]
    } & PolygonKind & Timed)
  | ({
      kind: 'group'
      members: Clipping[]
      /** Whether it is a set of its own. See `Group.sealed`. */
      sealed: boolean
    } & Timed)
  /** An artefact: its own point, and its frame. */
  | ({ kind: 'artefact', type: ArtefactType, at: Point } & Timed)
  /** A path: its own walk, and its frame. There are no corner ids in it,
   * because a path's points have none. */
  | ({ kind: 'path', points: Point[] } & Timed)

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

  const world = gestured(s.world, was);

  return {
    ...s,
    world,
    status: null,
    history: { past: [...s.history.past, was].slice(-DEPTH), future: [] },
  };
}

/**
 * `world` with what the step from `was` wrote stamped with one gesture id,
 * fresh from `nextId`.
 *
 * Written is a key that was not in that thing's timeline before, or one the
 * step changed what it does. A key told how often to repeat, where to wait, or
 * pushed along still does the same thing, and keeps the gesture it had. Only
 * the timelines the step replaced are looked at.
 */
function doing(key: Key | undefined): string {
  if (key === undefined) return '';

  const held = (m: ReadonlyMap<VertexId, unknown> | undefined) => (m === undefined ? '' : JSON.stringify([...m]));

  return JSON.stringify([key.by ?? null, key.stand ?? null])
    + [key.corners, key.depths, key.rounds, key.deforms].map(held).join('|');
}

export function gestured(world: World, was: World): World {
  const gesture = world.nextId;
  const rigs = new Map(world.rigs);
  let any = false;

  for (const [id, rig] of world.rigs) {
    const old = was.rigs.get(id);

    if (old === rig) continue;

    let stamped = false;

    /** What the keyframe's keys did before this step, and how many of each:
     * a key doing one of those things is one of those keys, wherever it sits
     * in the list now. */
    const before = (at: KeyframeId): Map<string, number> => {
      const out = new Map<string, number>();

      for (const key of old?.keys.get(at) ?? []) {
        const what = doing(key);

        out.set(what, (out.get(what) ?? 0) + 1);
      }

      return out;
    };

    const now: KeyRig = {
      keys: new Map([...rig.keys].map(([at, list]) => {
        const had = before(at);

        return [at, list.map(key => {
          const what = doing(key);
          const left = had.get(what) ?? 0;

          if (key.group === gesture || left > 0) {
            had.set(what, left - 1);

            return key;
          }

          stamped = true;

          return { ...key, group: gesture };
        })];
      })),
    };

    if (stamped) {
      rigs.set(id, now);
      any = true;
    }
  }

  return any ? { ...world, rigs, nextId: gesture + 1 } : world;
}

/** The editor saying why it did not do the thing. See `EditorState.status`. */
export function saying(s: EditorState, status: string): EditorState {
  return { ...s, status };
}

export function undone(s: EditorState): EditorState {
  const { past, future } = s.history;

  if (past.length === 0) return s;

  return settled({
    ...s,
    world: past[past.length - 1],
    history: { past: past.slice(0, -1), future: [...future, s.world] },
  }, s.world);
}

export function redone(s: EditorState): EditorState {
  const { past, future } = s.history;

  if (future.length === 0) return s;

  return settled({
    ...s,
    world: future[future.length - 1],
    history: { past: [...past, s.world], future: future.slice(0, -1) },
  }, s.world);
}

/** The selection with anything the world no longer has dropped: stepping back
 * past the birth of a polygon leaves it picked and gone. And the keyframe on
 * screen, where stepping back took it out: the one in its place instead. */
function settled(s: EditorState, was: World): EditorState {
  const corners = new Set<VertexId>();

  for (const p of s.world.polygons.values()) {
    for (const v of p.points) corners.add(v.id);
  }

  const here = s.world.keyframes.some(f => f.id === s.keyframe);
  const place = Math.max(0, was.keyframes.findIndex(f => f.id === s.keyframe));
  const keyframe = here ? s.keyframe : s.world.keyframes[Math.min(place, s.world.keyframes.length - 1)].id;

  return {
    ...s,
    keyframe,
    replay: here ? s.replay : null,
    selection: {
      polygons: s.selection.polygons.filter(
        id => s.world.polygons.has(id) || s.world.groups.has(id),
      ),
      vertices: s.selection.vertices.filter(id => corners.has(id)),
      edges: s.selection.edges.filter(id => corners.has(id)),
      // Always there, so nothing can have taken it away.
      start: s.selection.start,
      eye: s.selection.eye,
      artefacts: s.selection.artefacts.filter(id => s.world.artefacts.has(id)),
      paths: s.selection.paths.filter(id => s.world.paths.has(id)),
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
  from: KeyframeId
  to: KeyframeId
  /** 0 to 1 over the whole walk, however many versions it crosses, on the
   * curve the walls move by. */
  at: number
  /** The same, on the clock: linear, for what wants to know how far through
   * the time it is rather than how far the walls have got. */
  through: number
  /** Seconds of run-up still to go before the walk sets off, standing at
   * `from`. Zero for a walk that goes at once — see `lead`. */
  before: number
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
  keyframe: KeyframeId
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

  /**
   * The keys the hand is on, or nothing: what the next gesture writes into.
   *
   * Every gesture writes into the key its thing has here, and where it has
   * none it makes one and the hand is on that one after. So a hand that moves
   * a thing and then turns it leaves one key, because it never left it; a
   * break puts the hand on a new empty key; and picking a key in the keyframe
   * view puts it there, whichever key it is. There is no other rule for where
   * a gesture goes.
   *
   * A key that is not the last of its keyframe is being stood on: the canvas
   * draws the world `upto` it, with where the keyframe ends up a ghost over
   * it, and a gesture adjusts it where it is.
   *
   * By the keys' ids, and all at the keyframe on screen. Kept true in one
   * place, whatever changed — see `aimed` in `keys.ts`.
   *
   * Not in the file. Where the hand is is about this moment rather than about
   * the world.
   */
  target: Target | null

  /**
   * What the editor last had to say for itself, or nothing.
   *
   * A gesture that will not happen has to say why, or it reads as the editor
   * being broken. There are three ways such a gesture can go — do it, do
   * something else instead, or refuse — and the third is only tolerable out
   * loud. Eroding a loose group is the case that asked for this: it briefly
   * sealed the group and eroded that, which is doing something else instead,
   * and the author's hand was on neither.
   *
   * Cleared by the next thing that actually changes the world, which is what
   * `marked` is. So it stays up while the author is looking at the state that
   * caused it and goes the moment they move on: no timer, and nothing to
   * arrive late over the top of something else.
   */
  status: string | null

  settings: Settings
  view: View
  tool: Tool
  /** What the create tool draws, which is only about that tool. */
  figure: Figure
  /**
   * The effect options last used: what `b` and `d` give a thing that has
   * none, and what the inspector shows for an effect nothing picked has.
   * About this sitting, so not in the file.
   */
  remembered: Options

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
   * Seconds a walk waits at its start before it sets off, while `roaming`.
   *
   * The screen starts bending before a shift in the game — the run-up in
   * `beaten` — and a walk that set off the moment an arrow was pressed would
   * never show it. The first-person view's panel turns this on, as long as the
   * run-up is. Not in the file.
   */
  lead: number

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
  /**
   * Everything a right click found under the cursor, locked and hidden
   * included, listed where it was pressed — or nothing, nearly always. How a
   * thing that cannot be picked is found to be let go of. See `beneath` in
   * `track.ts`. Not in the file.
   */
  beneath: {
    x: number
    y: number
    /** When the press that opened it happened. A press elsewhere closes only
     * a list from before it. */
    since: number
    items: { id: Id, depth: number }[]
  } | null
}

/** The keys the hand is on. See `EditorState.target`. */
export interface Target {
  /** The one clicked, or first written: the one the keyframe view's arrow is
   * beside. */
  lead: Place
  /** Every one, the lead among them. */
  all: Place[]
}

/** Everything that writes to the store goes through one of these. */
export type Update = (fn: (s: EditorState) => EditorState) => void;

export function initialState(world: World): EditorState {
  return {
    world,
    keyframe: 0,
    selection: EMPTY_SELECTION,
    inside: null,
    target: null,
    status: null,
    settings: defaultSettings,
    view: defaultView,
    tool: 'point',
    figure: 'rect',
    remembered: REMEMBERED,
    replay: null,
    preview: false,
    roaming: false,
    lead: 0,
    bake: { spans: new Map(), progress: null },
    history: EMPTY_HISTORY,
    clipboard: [],
    beneath: null,
  };
}
