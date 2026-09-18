// -----------------------------------------------------------------------------
// Drawing
//
// Everything that reaches a canvas context. Nothing here writes to the world
// or to the loop's state: it is handed what to draw and draws it, which is
// why it can be the far side of the cut. It reads `./local` and `./metrics`
// and nothing else of `canvas/`.
// -----------------------------------------------------------------------------

import { canvas } from '@incpt/kontinuum-dom/html';

import { artefactsDuring, Frame } from '../bake';
import { Ring, Shape, erodedRingCorners, erodedShape, sliced, survived } from '../geometry';
import { pan } from '../input';
import {
  Resolved,
  middle,
  order,
  hitting,
  painted,
  under,
  Placed,
  place,
  START_ID,
  artefactsAt,
  Laid,
  pathsAt,
  pathsIn,
  depths,
  Handle,
  handles,
  occupiedShape,
  floorsIn,
  occupying,
  occupyingSource,
  shownAt,
  startPlaced,
  Occupied,
  swallowed,
  reachable,
  polygonsIn,
  resolveAt,
  runs,
} from '../scene';
import { OnPath, seconds, timings } from '../paths';
import { theme } from '../theme';
import { edgeRun } from '../effects';
import {
  ArtefactId,
  FLOOR,
  SOLID,
  KINDS,
  inverted,
  Id,
  PathId,
  Point,
  PolygonId,
  PolygonKind,
  Replay,
  Selection,
  Settings,
  Tool,
  KeyframeId,
  kindKey,
  VertexId,
  View,
  World,
  visible,
  GroupId,
  saying,
  opened,
  toScreen,
} from '../types';

import { Draft, Forming, Local, Marquee, Walk } from './local';
import { HANDLE } from './metrics';

//
// Everything below works in CSS pixels; the transform takes care of the rest.
// -----------------------------------------------------------------------------

type Layer = (ctx: CanvasRenderingContext2D) => void;

/** Below this many CSS pixels between dots the grid stops being a grid. */
const MIN_DOT_SPACING = 8;

/** Sizes the backing store to the view and puts the context into CSS pixels. */
function prepare(el: HTMLCanvasElement, ctx: CanvasRenderingContext2D, view: View): void {
  const width = Math.max(1, Math.round(view.width * view.dpr));
  const height = Math.max(1, Math.round(view.height * view.dpr));

  // Sizing the backing store clears it, so only do it when it really changed
  if (el.width !== width || el.height !== height) {
    el.width = width;
    el.height = height;
  }

  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
}

export function draw(
  el: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  view: View,
  over: Layer[],
): void {
  prepare(el, ctx, view);

  ctx.fillStyle = theme.canvas;
  ctx.fillRect(0, 0, view.width, view.height);

  for (const layer of over) {
    layer(ctx);
  }
}

function trace(ctx: CanvasRenderingContext2D, view: View, ring: Ring): void {
  ring.forEach((p, i) => {
    const s = toScreen(view, p);

    if (i === 0) ctx.moveTo(s.x, s.y);
    else ctx.lineTo(s.x, s.y);
  });

  ctx.closePath();
}

/**
 * Back to front. Ghosts of the other versions go under the version on screen,
 * and the CSG goes over the polygons that made it, because it is the answer and
 * they are the working.
 */
export function layers(
  world: World,
  settings: Settings,
  view: View,
  tool: Tool,
  selection: Selection,
  inside: GroupId | null,
  current: KeyframeId,
  local: Local,
  items: Resolved[],
  outline: Point[][],
  /** The floor set's own outline, which is the same answer about the other
   * set and is drawn in its own colour over the top. */
  floor: Point[][],
  played: Frame | null,
  /** The walk in progress, for the things drawn from the world rather than
   * from the bake. Null when nothing is playing, and null too when the walk
   * has no bake to play, so that nothing animates alone. */
  walk: Replay | null,
): Layer[] {
  const out: Layer[] = [];

  if (settings.showGrid) out.push(ctx => grid(ctx, settings, view));

  out.push(ctx => axes(ctx, view));

  const reached = new Set(polygonsIn(world, selection.polygons));
  const path = opened(world, inside);

  for (const k of ghostVersions(world, current, local.previewing)) {
    const shown = resolveAt(world, k);
    const stroke = ghostColour(order(world, k) - order(world, current));

    out.push(ctx => ghosts(ctx, view, world, k, shown, stroke));
  }

  // A shut group is one shape, and its members are not on screen at all: the
  // whole of what grouping does to the eye is take several outlines away and
  // leave one. What is left here is everything a shut group is not drawing for.
  const loose = items.filter(it => !swallowed(world, it.id, path) && visible(world, it.id));

  const reach = (id: Id) => reachable(world, id, inside);

  // Hidden from the keyframes, which takes it off the canvas and leaves it in
  // the level. See `Flags`.
  const shut = occupying(world, current, items, path).filter(g => visible(world, g.id));
  const picking = new Set<Id>(selection.polygons);

  // What a picked loose group looks like is the orange over everything it
  // holds, and that is the whole of what says it is picked. Its members are on
  // screen in their own right, so they would otherwise each carry the selection
  // themselves — every one of them heavy-stroked and filled, which says *these
  // several things are picked* where a group is one thing. A sealed group never
  // had this to answer: its members are not drawn at all, and the green is all
  // there is. This is the same statement made where they are.
  //
  // A member picked in its own right keeps it: it is named by the selection
  // rather than reached through the handle, and the two are different states.
  const inherited = new Set(
    shut
      .filter(g => g.gone === 'loose' && picking.has(g.id))
      .flatMap(g => polygonsIn(world, [g.id]))
      .filter(id => !picking.has(id)),
  );

  const carrying = new Set([...reached].filter(id => !inherited.has(id)));

  out.push(ctx => polygons(ctx, view, loose, carrying, tool === 'point' || tool === 'edge', reach));
  out.push(ctx =>
    groups(ctx, view, shut, picking, reach, moved(world, current, items, path, shut, picking)),
  );

  // Command-click reaches past a group to one polygon inside it, and what it
  // picks has to be visible or the click reads as having done nothing. Over the
  // group's outline rather than under it: it is what the next gesture will act
  // on, and the group is not.
  //
  // What the selection *names*, not what it reaches: picking a group names the
  // group, and drawing the members it reaches would put every outline inside it
  // back on screen the moment it was clicked — which is the internal geometry
  // that shutting a group exists to hide.
  const named = new Set(selection.polygons);
  const singled = items.filter(it => named.has(it.id) && swallowed(world, it.id, path));

  if (singled.length > 0) {
    out.push(ctx => polygons(ctx, view, singled, reached, false, () => true));
  }

  // Last of the level, over every outline and every fill: a handle is what the
  // hand is aiming at, and nothing drawn after it would be. The same list the
  // click asks — see `handles`.
  if (tool === 'point') {
    const on = handles(world, current, items, path, inside, reached);

    out.push(ctx => corners(ctx, view, on, selection));
  }

  // The edges the edge tool may pick, the picked ones heavy, and the corners
  // only as where they meet.
  if (tool === 'edge') {
    const on = handles(world, current, items, path, inside, reached);
    const ids = new Set(on.map(h => h.id));

    out.push(ctx => edges(ctx, view, items.filter(it => ids.has(it.id)), selection.edges));
    out.push(ctx => corners(ctx, view, on, { ...selection, vertices: [] }));
  }

  // The floor first and the level over it, which is the order the two stand
  // in: a wall is built on the floor, and where a floor's edge runs along a
  // wall it is the wall that is there to be seen.
  out.push(ctx => outlines(ctx, view, floor, theme.csgFloor, true));
  out.push(ctx => outlines(ctx, view, outline, theme.csg));

  // Over the editor's own answer, so the two can be read against each other:
  // where they agree the thin line sits inside the thick one, and where the
  // bake is part way between two versions it is visibly somewhere else.
  if (played !== null) out.push(ctx => replay(ctx, view, played));

  // Over everything the level is made of, because an artefact is a thing in a
  // room rather than part of one, and under the two gestures that are still
  // running, because those are about what is being done rather than about what
  // is there.
  //
  // While a walk plays these are the only ones drawn. Everywhere else the
  // replay goes over the editor's own answer so the two can be read against
  // each other, but there is no second answer here to read against: an
  // artefact has no bake, and drawing the version on screen underneath would
  // put a still diamond at the destination of every flying one.
  // The start goes in with them, and stands still through a walk: it is in no
  // version's layer, so there is nothing for a walk to carry it along.
  out.push(ctx => artefacts(
    ctx,
    view,
    (walk === null
      ? shownAt(world, current)
      : [startPlaced(world), ...artefactsDuring(world, walk.from, walk.to, walk.at)])
      .filter(it => it.id === START_ID || visible(world, it.id)),
    new Set(selection.start ? [START_ID, ...selection.artefacts] : selection.artefacts),
    id => id === START_ID || reachable(world, id, inside),
  ));

  // The measuring paths, over everything and under every tool: a tape is laid
  // on top of what it is measuring, and what it says about the layout is worth
  // as much while the layout is being moved as while it is being measured.
  // Dashed, which is what keeps that from being clutter — nothing else on the
  // canvas is, so a path reads as an annotation over the drawing rather than
  // as another line in it.
  //
  // The one being laid down is drawn from the gesture instead, so the
  // committed copy of a path being carried on with sits this one out and there
  // are not two of it on screen.
  out.push(ctx => measures(
    ctx,
    view,
    pathsAt(world, current).filter(it => visible(world, it.id)),
    local.laying?.id ?? null,
    local.onPath,
    new Set(selection.paths),
    // What a picked group has hold of. Drawn differently from a tape picked in
    // itself, because the two are moved by different things: this one goes
    // where the group goes, and letting go of the group lets go of it.
    new Set(pathsIn(world, selection.polygons)),
  ));

  if (local.laying !== null) out.push(ctx => laying(ctx, view, local.laying!));

  if (local.forming !== null) out.push(ctx => formed(ctx, view, local.forming!));
  if (local.draft !== null) out.push(ctx => draft(ctx, view, local.draft!));
  if (local.marquee !== null) out.push(ctx => marquee(ctx, view, local.marquee!));
  if (local.reading !== null) out.push(ctx => said(ctx, view, local.reading!));

  return out;
}

/**
 * Which other versions draw as ghosts. The eyes are only the resting state:
 * while a gesture runs, everything downstream fades in whatever they say, since
 * that is the whole point of editing an early version and watching a late one.
 */
function ghostVersions(world: World, current: KeyframeId, previewing: boolean): KeyframeId[] {
  const at = order(world, current);

  return world.keyframes
    .filter((k, i) => i !== at && (k.visible || (previewing && i > at)))
    .map(k => k.id);
}

/** Outline only, no fill, and hue ramps along with alpha: past about three
 * stacked versions opacity alone goes muddy. Behind is cool, ahead is warm. */
function ghostColour(distance: number): string {
  const d = Math.min(Math.abs(distance), theme.ghost.length) - 1;

  return distance < 0 ? theme.ghostBehind[d] : theme.ghost[d];
}

/**
 * One other version, drawn as groups.
 *
 * A ghost is the same boundary seen from another version, so it has to be the
 * same *kind* of picture: a group is one outline there too. Drawing the
 * resolved polygons raw puts every member's outline back, and the parts of
 * those not hidden under the boundary are exactly the seams between them —
 * which is the internal geometry grouping exists to stop showing.
 *
 * Every group, though, and not only the ones shut at this moment: a ghost does
 * not take the open path. Going inside a group is about what is being edited,
 * and a ghost is not being edited — it is the reference the edit is judged
 * against, and what makes it worth having while standing inside a group is
 * seeing where the whole group sits at the other versions, which is what
 * drilling in would otherwise take away.
 */
function ghosts(
  ctx: CanvasRenderingContext2D,
  view: View,
  world: World,
  v: KeyframeId,
  items: Resolved[],
  stroke: string,
): void {
  ctx.beginPath();

  // What is hidden from the keyframes is hidden from every one of them.
  for (const it of items) {
    if (swallowed(world, it.id, []) || !visible(world, it.id)) continue;

    for (const ring of it.shape) {
      trace(ctx, view, ring);
    }
  }

  for (const g of occupying(world, v, items, [])) {
    if (!visible(world, g.id)) continue;

    for (const ring of occupiedShape(g)) {
      trace(ctx, view, ring);
    }
  }

  // The outline only, and no label: a ghost says where something was, and
  // seven kinds written twice over is not that. Into the same path as the
  // rings, so one stroke draws the whole of what this version was.
  for (const it of artefactsAt(world, v)) {
    if (visible(world, it.id)) icon(ctx, toScreen(view, it.at), it);
  }

  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1;
  ctx.stroke();
}

/**
 * The polygons as this version resolves them: outlines only, so the CSG over
 * them stays readable.
 *
 * What is drawn solid is the projection — the eroded outline — and it carries no
 * handles at all. Where the two differ the source ring is drawn behind it as a
 * ghost, and the handles are on that, because the source is the only thing
 * there is to edit. It is also the honest presentation: the eroded outline is
 * derived geometry, in the same sense the CSG result is.
 */
function polygons(
  ctx: CanvasRenderingContext2D,
  view: View,
  items: Resolved[],
  /** The polygons the selection reaches: itself, or everything under an open
   * group. A shut group draws its own outline instead — see `groups`. */
  reached: ReadonlySet<PolygonId>,
  handles: boolean,
  /** Whether a click could pick this one, which is false for everything
   * outside the group standing open. */
  reach: (id: Id) => boolean,
): void {
  for (const it of items) {
    const picked = reached.has(it.id);
    const here = reach(it.id);

    // A shape eroded away has no projection to draw and nothing to click, so
    // its source ring stands in for it always rather than only under the
    // selection: it is the one state where the dashed line is not an aside
    // about a shape on screen but the whole of what is on screen. `hitting`
    // falls back to the same ring, so what is drawn is what can be picked.
    const gone = it.shape.length === 0;

    if (gone || ((it.erosion !== 0 || it.depths !== null) && here && (picked || handles))) {
      source(ctx, view, sliced(it.source, it.rings), gone && !picked ? theme.gone : theme.source);

      if (picked) leaders(ctx, view, it);
    }

    outlined(ctx, view, it.shape, it.polygon, picked, here, theme.pickedFill);
  }
}

/**
 * The boundary an erosion started from, dashed under the projection it made.
 *
 * One ring for a polygon and any number for a group, which is the whole of the
 * difference between the two: a group's is the union its members make, and a
 * union is as many rings as it needs. Dashed either way and in the same
 * colour, because it is the same thing being said — this is where the shape
 * would be with the depth taken off — and a group that said it differently
 * would read as a different kind of statement rather than the same one about
 * a bigger shape.
 */
function source(
  ctx: CanvasRenderingContext2D,
  view: View,
  shape: Shape,
  /** `theme.gone` where the ring is standing in for a shape that eroded away
   * and is not picked — see there. */
  stroke = theme.source,
): void {
  ctx.beginPath();

  for (const ring of shape) trace(ctx, view, ring);

  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.stroke();
  ctx.setLineDash([]);
}

/**
 * The corners the point tool can grab, as squares on the source rings.
 *
 * Its own pass over its own list rather than part of `polygons`, because what
 * has a corner on screen and what has an outline on screen are no longer the
 * same question: a picked group draws one outline and the corners of its
 * members that lie on it. `handles` settles the list, and settles it for the
 * click as well, so a square is drawn exactly where one can be grabbed.
 *
 * Over the groups rather than under them. A group's fill is painted after the
 * polygons and would take the squares inside it with it, which are the very
 * ones this is here to put back.
 */
function corners(
  ctx: CanvasRenderingContext2D,
  view: View,
  on: readonly Handle[],
  selection: Selection,
): void {
  // Two passes rather than one, so that each colour is a single fill: which
  // corners are picked is the only thing the point tool is about, and a hollow
  // square against a solid one says it at any zoom.
  const chosen = new Set(selection.vertices);

  for (const picked of [false, true]) {
    ctx.beginPath();

    for (const h of on) {
      if (chosen.has(h.vertex) !== picked) continue;

      const s = toScreen(view, h.at);

      ctx.rect(Math.round(s.x) - 2.5, Math.round(s.y) - 2.5, 5, 5);
    }

    ctx.fillStyle = picked ? theme.picked : theme.vertex;
    ctx.fill();
  }
}

/** The picked edges, along their teeth where they have them. */
function edges(ctx: CanvasRenderingContext2D, view: View, items: readonly Resolved[], picked: readonly VertexId[]): void {
  const chosen = new Set(picked);

  ctx.beginPath();

  for (const it of items) {
    for (const c of it.corners) {
      if (!chosen.has(c.id)) continue;

      edgeRun(it, c.id).forEach((i, j) => {
        const p = toScreen(view, it.source[i]);

        if (j === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
    }
  }

  ctx.strokeStyle = theme.picked;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
}

/**
 * A hairline from each corner of the source ring to where the offset put it.
 *
 * Which vertex became which is the one thing the projection cannot be read
 * off. The source is dashed under the eroded outline already, so both rings
 * are on screen — but a corner rounded off, a wall that swallowed its
 * neighbour, or two corners that met and crossed all look alike from outside,
 * and the answer is not recoverable by eye at any zoom.
 *
 * Only under a picked polygon, and never merely because the point tool is out.
 * The dashed source is cheap to have standing everywhere; a spoke per corner
 * over a level of them is a hedgehog. Selection is what narrows it to the one
 * shape the question is being asked about, and picking a second polygon asks
 * it there too rather than instead.
 *
 * Faint, thin and undashed: a leader line is scaffolding, and it has to lose
 * to both rings it joins wherever it crosses one. Drawn before the corner
 * squares, so a handle sits on top of its own spoke rather than under it.
 */
function leaders(ctx: CanvasRenderingContext2D, view: View, it: Resolved): void {
  // Ring by ring, since a corner's mitre is bisected between the two walls of
  // its own ring and a hole's last corner does not meet the outline's first.
  const moved = erodedRingCorners(sliced(it.source, it.rings), it.depths ?? it.erosion);

  spokes(ctx, view, it.source, moved, survived(it.shape));
}

/**
 * One ring's corners joined to where they went, corner for corner.
 *
 * Apart from `leaders` because a group's is a ring of a union rather than a
 * source ring, and there is more than one of them — but it is the same line
 * saying the same thing, and it has to look identical wherever it is drawn.
 */
function spokes(
  ctx: CanvasRenderingContext2D,
  view: View,
  ring: Ring,
  moved: readonly Point[],
  /** Whether the projection still turns at a point, from `survived`. */
  standing: (p: Point) => boolean,
): void {
  ctx.beginPath();

  ring.forEach((p, i) => {
    // A corner the erosion consumed has nothing at the far end of its line:
    // its moved point is where it pushed to, and what it pushed into closed
    // over it. Nothing is drawn for it at all — a line into the middle of the
    // projection reads as a stray mark, and a line stopped at the outline
    // reads as a corner that is there, which is the one thing it is not. The
    // outline losing a corner is what says the corner went.
    if (!standing(moved[i])) return;

    const a = toScreen(view, p);
    const b = toScreen(view, moved[i]);

    // A corner that did not move has no line to draw, and at a depth of zero
    // every corner is one of those. Screen space rather than world, because
    // what is being avoided is a line too short to read.
    if (Math.hypot(b.x - a.x, b.y - a.y) < 2) return;

    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  });

  ctx.strokeStyle = theme.leader;
  ctx.lineWidth = 0.5;
  ctx.stroke();
}

/** A group's boundary either side of its own erosion, and the depth between
 * them. `now` is empty for a group eroded away to nothing. */
interface Moved {
  was: Shape
  now: Shape
  depth: number
}

/**
 * The same question `leaders` answers for a polygon, asked of the shut groups
 * that are picked: what the group's erosion moved, and by how much.
 *
 * A group has no corners, so there is nothing to run a leader from until the
 * union is taken again without the depth on it — see `occupyingSource`. That
 * is a second union over every member of every shut group, which is why it is
 * asked for only when a picked group is actually eroding: nothing picked, or
 * nothing picked at a depth, and this is a walk over the groups on screen and
 * no geometry at all.
 *
 * The walk is over the *source* groups and not the ones being drawn, which is
 * what a group eroded away to nothing turns on. Such a group leaves `occupying`
 * altogether — there is no outline to draw and nothing to click — and picking
 * it would then show nothing at all, though the marquee finds it perfectly
 * well by its members' corners. A polygon in the same state still draws its
 * dashed source ring, because that ring is on the polygon rather than on the
 * projection; the source union is a group's answer to the same thing, and
 * taking it here is what gives the two the same behaviour.
 *
 * The depth is the one the group's own side was offset by, sign and all. A
 * group's walls go the other way from its rooms — `erode(A - B, d)` is
 * `erode(A, d) - erode(B, -d)`, which is what makes a pillar keep its distance
 * from a shrinking room — so a group drawn as its walls has its corners moving
 * out where a room's move in, and a leader that ignored that would point the
 * wrong way at every corner of it. See `contributed`.
 */
function moved(
  world: World,
  v: KeyframeId,
  items: readonly Resolved[],
  path: readonly GroupId[],
  shut: readonly Occupied[],
  picking: ReadonlySet<Id>,
): ReadonlyMap<GroupId, Moved> {
  const out = new Map<GroupId, Moved>();
  const depth = depths(world, v);
  const now = new Map(shut.map(g => [g.id, g.shape]));

  // Picked, or gone: a group eroded away draws its source ring whether or not
  // anything is picked, because that ring is the only thing saying it is there
  // at all — and it is what a click on it finds. Being gone is not the same as
  // being absent from `shut`, which is also true of every group a shut group
  // is standing for, and those draw nothing of their own.
  const wanted = (id: GroupId): boolean =>
    (depth.get(id) ?? 0) !== 0
    && (picking.has(id)
      || (!path.includes(id) && !swallowed(world, id, path) && (now.get(id)?.length ?? 0) === 0));

  if (![...depth.keys()].some(wanted)) return out;

  for (const g of occupyingSource(world, v, items, path)) {
    if (!wanted(g.id)) continue;

    const d = depth.get(g.id) ?? 0;

    out.set(g.id, {
      was: g.shape,
      now: now.get(g.id) ?? [],
      depth: inverted(g.kind) ? -d : d,
    });
  }

  return out;
}

/**
 * The shut groups, each as the one outline it occupies.
 *
 * This is the whole of what a group looks like. Its members are not drawn at
 * all and neither are their handles, because inside a shut group there is
 * nothing to grab: the transform belongs to the group, and the corners belong
 * to polygons that are not on screen. Double-clicking opens it, and then the
 * outline goes and they come back.
 *
 * Drawn in the stroke of its kind, exactly as a polygon of that kind is. A
 * group is not a kind of thing the level has — the game is shipped a set, and
 * the set does not know what was grouped — so a line of its own would be a
 * line about the editor rather than about the level. What says a group is
 * picked is the fill under it, which is all it needs to say.
 */
function groups(
  ctx: CanvasRenderingContext2D,
  view: View,
  shown: Occupied[],
  /** What is picked, as picked: a group's id is in the selection itself, not
   * by way of the members `reached` stands for. */
  picking: ReadonlySet<Id>,
  reach: (id: Id) => boolean,
  /** Where each picked group's erosion started from, from `moved`. Empty for
   * every group not drawing leaders, which is nearly all of them. */
  sources: ReadonlyMap<GroupId, Moved>,
): void {
  for (const g of shown) {
    const here = reach(g.id);

    // A group with no boundary of its own is drawn where it *is* rather than as
    // an edge of the level, and the two reasons it can have none are drawn
    // differently because they are different statements. See `Occupied.gone`.
    // A scope that came to nothing has nothing else on screen, so its extent is
    // all there is to say it is there. Dashed, and exactly the ring an
    // eroded-away polygon gets, because it is the same statement about a
    // bigger shape. See `Occupied.gone`.
    if (g.gone === 'empty') {
      source(ctx, view, g.shape, picking.has(g.id) ? theme.source : theme.gone);
      continue;
    }

    // A loose group is drawn like any other, and picks out orange rather than
    // green. The colour is the whole of what tells the two apart on screen, and
    // they are worth telling apart: one is a shape in the set and the other is
    // a handle round shapes that are in it on their own account.
    if (g.gone === 'loose') {
      outlined(ctx, view, g.shape, g.kind, picking.has(g.id), here, theme.looseFill);
      continue;
    }

    outlined(ctx, view, g.shape, g.kind, picking.has(g.id), here, theme.groupFill);

    // Drawn as the floor it is, and never as picked: the group's own outline
    // has already said that, and saying it twice puts a second heavy line
    // inside the first. Filled and edged, both, because an outline alone
    // inside another outline says nothing about which side of it is floor —
    // and because the stipple of a hole in it needs an edge to stop at.
    //
    // Clipped rather than cut: a floor is drawn inside the group and the group
    // has just drawn its own outline along every edge the cut would follow, so
    // the boolean that used to work that boundary out was paying to redraw a
    // line already on screen. It cost the line underneath, too — the floor's
    // own 0.5 stroke ran back over a picked group's heavy one wherever the two
    // agreed, and a clipped edge has no stroke to do it with.
    //
    // Nothing to clip to for a group of nothing but floors: `shape` is empty
    // there and the floor is the whole of what is on screen. Clipping to an
    // outline that is not there would clip it away, which is the group going
    // invisible — and a group must be visible, being the thing being picked
    // and dragged.
    //
    // Nor for a group whose outline is a solid: a floor is cut to a room and to
    // nothing else, so a solid's floor runs wherever it was laid.
    if (g.floor.length === 0) continue;

    const shut = floorsIn(g);

    if (shut) {
      ctx.save();
      ctx.beginPath();

      for (const ring of g.shape) trace(ctx, view, ring);

      ctx.clip('evenodd');
    }

    // Picked only where the floor is the whole of the group: then this pass is
    // the group's own outline and has to carry the selection, there being no
    // other line on screen to carry it.
    outlined(ctx, view, g.floor, KINDS[2], !shut && picking.has(g.id), here, theme.groupFill);

    if (shut) ctx.restore();
  }

  // Its own pass, because what it draws is not keyed to what `shown` holds: a
  // group eroded away has no outline to hang this off and is the one that
  // needs it most, being otherwise a selection with nothing on screen at all.
  for (const [id, was] of sources) {
    // A group is only in here unpicked when it has eroded away, which is the
    // one case the ring has to carry the selection itself.
    source(ctx, view, was.was, picking.has(id) ? theme.source : theme.gone);

    const to = erodedShape(was.was, was.depth);
    const standing = survived(was.now);

    was.was.forEach((ring, i) => spokes(ctx, view, ring, to[i], standing));
  }
}

/**
 * What each way of going is painted with, in screen space and built once.
 *
 * A stroke can only say one thing at a time, and it is already saying whether
 * a shape is picked and whether it can be reached at all — and, since there are
 * two sets, which of them the line belongs to. So which *way* a polygon goes is
 * said by the fill instead: what is taken away is textured, because a texture
 * says which side of the line the material is on and a ring alone never did.
 *
 * A room is left plain, being the ordinary case on its side. A floor is not,
 * and that is the one asymmetry: a floor is drawn inside a room and a hole in a
 * floor is drawn inside the floor, so an unfilled floor and the hole in it are
 * the same picture. Three textures, then, and each is faint enough to leave
 * what it is drawn over legible: dots for the floor, a diagonal hatch for the
 * solid, and horizontal rules for the void that cuts either of them.
 *
 * Texture rather than geometry, so it does not zoom with the level: a pattern
 * the view's transform stretched would go from hatching to stripes on the way
 * in, and the whole point of it is to look the same everywhere.
 */
const patterns = new Map<string, CanvasPattern | null>();

function patterned(kind: PolygonKind): CanvasPattern | null {
  const key = kindKey(kind);
  const known = patterns.get(key);

  if (known !== undefined) return known;

  const step = 6;
  const tile = document.createElement('canvas');

  tile.width = step;
  tile.height = step;

  const on = tile.getContext('2d');

  if (on === null) {
    patterns.set(key, null);

    return null;
  }

  // The texture of every set the polygon acts in, laid one over the other, and
  // a void's own rules over those. So a void is drawn as what it takes away —
  // hatched where it cuts the solids, stippled where it cuts the floors, both
  // where it cuts both — and the rules through it are what say it is the
  // taking-away rather than the thing. Three masks, three pictures, and none
  // of them the picture of a plain solid or a plain floor.
  //
  // Direction before colour, which is what survives one being drawn inside
  // another: a void is nearly always sitting inside the very shape it cuts.
  if (kind.type === 'solid' || (kind.type === 'void' && (kind.from & SOLID) !== 0)) {
    on.strokeStyle = theme.solidHatch;
    on.lineWidth = 1;

    // Three strokes for one diagonal: the two either side of it are what the
    // corners of the tile cut off the middle one, so the line carries on
    // across the seam instead of stopping at it.
    on.beginPath();

    for (const at of [-step, 0, step]) {
      on.moveTo(at, step);
      on.lineTo(at + step, 0);
    }

    on.stroke();
  }

  if (kind.type === 'floor' || (kind.type === 'void' && (kind.from & FLOOR) !== 0)) {
    // One dot a tile, in the middle of it, so nothing lands on a seam and the
    // grid stays even however the pattern falls on the shape.
    on.fillStyle = theme.floorDots;
    on.beginPath();
    on.arc(step / 2, step / 2, 1, 0, 2 * Math.PI);
    on.fill();
  }

  if (kind.type === 'void') {
    on.strokeStyle = theme.voidLines;
    on.lineWidth = 1;

    // Half a pixel off the middle, so the rule lands on a pixel row rather
    // than between two of them and comes out one line instead of two grey.
    on.beginPath();
    on.moveTo(0, step / 2 + 0.5);
    on.lineTo(step, step / 2 + 0.5);
    on.stroke();
  }

  const made = on.createPattern(tile, 'repeat');

  patterns.set(key, made);

  return made;
}

/** Fills `shape` with what its kind is painted with, if its kind is painted
 * with anything. The path is the caller's: it is traced once and used for the
 * fill, the picked fill over it and the stroke over that. */
function shaded(ctx: CanvasRenderingContext2D, kind: PolygonKind): void {
  // A room is the plain case and is left unfilled. Everything else carries a
  // texture, and which texture it is says which way it goes.
  if (kind.type === 'level') return;

  const pattern = patterned(kind);

  if (pattern === null) return;

  ctx.fillStyle = pattern;
  ctx.fill();
}

/**
 * One shape stroked the way its kind is drawn, whether it is one polygon or
 * the union a group stands for.
 *
 * Filled when picked, so that what is picked reads at a glance rather than
 * having to be traced. Nonzero, which is the rule the shape was arranged
 * under, so a polygon eroded into two rooms fills both and one with a hole
 * keeps it — and `fill` is the only thing that differs between a polygon and a
 * group.
 */
function outlined(
  ctx: CanvasRenderingContext2D,
  view: View,
  shape: Shape,
  kind: PolygonKind,
  picked: boolean,
  /** Whether a click could reach it, which is false for everything outside the
   * group standing open. */
  here: boolean,
  fill: string,
): void {
  ctx.beginPath();

  for (const ring of shape) {
    trace(ctx, view, ring);
  }

  // Whatever it is, wherever it is. The texture says what kind of thing this
  // is and the selection fill says whether it is held, and neither is a claim
  // about whether it can be clicked — that is the stroke's to make, and it
  // makes it below. A floor outside the group standing open that stopped being
  // stippled would be a floor that had stopped being a floor.
  shaded(ctx, kind);

  if (picked) {
    ctx.fillStyle = fill;
    ctx.fill();
  }

  // The same line either way round: the fill says which way a polygon goes,
  // and the stroke says the three things only it can — whether this is picked,
  // whether it can be reached at all, and which of the two drawings it belongs
  // to. The last of those is not a meaning stacked on the other two; it is
  // which picture they are being said about, and the floor answers them in its
  // own colour. See `theme.floor`.
  ctx.strokeStyle = !here
    ? theme.outside
    : picked
      ? theme.picked
      : kind.type === 'floor' ? theme.floor : theme.level;
  ctx.lineWidth = picked ? 2 : 0.5;
  ctx.stroke();
}

/** One set the game would see, over the top and in the colour that says which. */
function outlines(
  ctx: CanvasRenderingContext2D,
  view: View,
  runs: Point[][],
  colour: string,
  /** Stitched rather than solid. The floor's answer is drawn this way and the
   * level's is not: the two run along each other wherever a floor reaches a
   * wall, and two solid lines of the same weight there are one line whose
   * colour is whichever was drawn last. A stitch leaves the line under it
   * showing through the gaps, so both are still readable where they agree. */
  stitched = false,
): void {
  if (runs.length === 0) return;

  ctx.beginPath();

  // Open, deliberately: a run is one polygon's share of the outline, and the
  // loop it belongs to is generally made of several. Closing each would draw a
  // chord across every junction.
  for (const run of runs) {
    run.forEach((p, i) => {
      const q = toScreen(view, p);

      if (i === 0) ctx.moveTo(q.x, q.y);
      else ctx.lineTo(q.x, q.y);
    });
  }

  ctx.strokeStyle = colour;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';

  // Butt caps under the dash, so a stitch is a bar of the width it is set to
  // rather than a lozenge half again as long.
  if (stitched) {
    ctx.lineCap = 'butt';
    ctx.setLineDash([7, 4]);
  }

  ctx.stroke();
  ctx.setLineDash([]);
}

/**
 * The artefacts, as diamonds with their kind written under them.
 *
 * In screen units, like the corner handles and for the same reason: an artefact
 * is a place rather than an extent, and one drawn in world units would be a
 * speck at one zoom and fill the room at another. The diamond is the tool's own
 * icon at drawing size, so what the button shows is what lands.
 *
 * The label is how a level with seven kinds in it is read at all. There is no
 * room for seven distinguishable glyphs at this size, and a colour per kind
 * would spend the one thing the diamond has left to say — whether it is picked.
 */
function artefacts(
  ctx: CanvasRenderingContext2D,
  view: View,
  shown: readonly Placed[],
  picked: ReadonlySet<ArtefactId>,
  /** Whether a click could reach it, which is false for everything outside the
   * group standing open. The same fading the outlines get. */
  reach: (id: ArtefactId) => boolean,
): void {
  ctx.lineJoin = 'round';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif';

  for (const it of shown) {
    const q = toScreen(view, it.at);
    const here = picked.has(it.id);
    const near = reach(it.id);
    const colour = !near ? theme.outside : here ? theme.picked : theme.artefact;

    ctx.beginPath();
    icon(ctx, q, it);

    ctx.fillStyle = here && near ? theme.pickedFill : theme.canvas;
    ctx.fill();

    // The facets, which are what make it read as the icon rather than as a
    // lozenge. Added to the same path after the fill, so one stroke draws the
    // outline and the facets together and they cannot disagree about weight.
    if (it.type === 'start') {
      const [tip, back] = [ahead(q, it.facing, NOSE, 0), ahead(q, it.facing, -TAIL, 0)];

      ctx.moveTo(back.x, back.y);
      ctx.lineTo(tip.x, tip.y);
    }
    else {
      ctx.moveTo(q.x - WAIST, q.y - SHOULDER);
      ctx.lineTo(q.x + WAIST, q.y - SHOULDER);
      ctx.moveTo(q.x - FACET, q.y - SHOULDER);
      ctx.lineTo(q.x, q.y + BOTTOM);
      ctx.lineTo(q.x + FACET, q.y - SHOULDER);
      ctx.lineTo(q.x, q.y - TOP);
    }

    ctx.strokeStyle = colour;
    ctx.lineWidth = here && near ? 1.5 : 1;
    ctx.stroke();

    ctx.fillStyle = !near ? theme.outside : here ? theme.picked : theme.muted;
    ctx.fillText(it.type, q.x, q.y + (it.type === 'start' ? NOSE : BOTTOM) + 3);
  }
}

/**
 * The outline of one artefact, as a subpath. Its own function because a ghost
 * draws it and nothing else, in among the rings of the version it belongs to.
 *
 * The start is the one kind with a direction — it is where the player is put
 * *and* which way they are looking — so it is drawn as a dart along that
 * direction rather than as a diamond, which has nothing to say about it.
 */
function icon(ctx: CanvasRenderingContext2D, q: Point, it: Placed): void {
  if (it.type === 'start') dart(ctx, q, it.facing);
  else diamond(ctx, q);
}

/** A point `f` pixels along the facing and `s` across it, from `q`. */
function ahead(q: Point, facing: number, f: number, s: number): Point {
  const fx = Math.sin(facing), fy = -Math.cos(facing);

  return { x: q.x + fx * f - fy * s, y: q.y + fy * f + fx * s };
}

/** The start's outline: long enough down the facing to be read as pointing
 * that way at a glance, and no wider than the diamond it stands in for. */
function dart(ctx: CanvasRenderingContext2D, q: Point, facing: number): void {
  const tip = ahead(q, facing, NOSE, 0);
  const left = ahead(q, facing, -TAIL, -WAIST);
  const right = ahead(q, facing, -TAIL, WAIST);

  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(right.x, right.y);
  ctx.lineTo(left.x, left.y);
  ctx.closePath();
}

function diamond(ctx: CanvasRenderingContext2D, q: Point): void {
  ctx.moveTo(q.x, q.y - TOP);
  ctx.lineTo(q.x + WAIST, q.y - SHOULDER);
  ctx.lineTo(q.x, q.y + BOTTOM);
  ctx.lineTo(q.x - WAIST, q.y - SHOULDER);
  ctx.closePath();
}

/** The diamond, in screen pixels from its own point. `SHOULDER` is where the
 * facets meet the outline, which is above the middle: the crown is short and
 * the pavilion is long, as a cut stone is. */
const TOP = 9;
const SHOULDER = 2.5;
const BOTTOM = 9;
const WAIST = 8;
const FACET = 3.5;

/** The start's dart, from its own point: ahead to the tip, back to the base. */
const NOSE = 14;
const TAIL = 7;

/**
 * The bake, played back: the same runs, drawn from the buffers rather than from
 * the world.
 *
 * Nothing about this consults the version on screen. That is the entire point —
 * if it disagrees with the outline underneath it at the moment it arrives, the
 * bake and the editor disagree, and it is the bake the game will get.
 *
 * Two lines, because there are two sets and they are two answers. Each is
 * thinner and brighter than the editor's own outline sitting under it, so the
 * two can be told apart where they differ, and each is in the colour its set
 * is drawn in everywhere else — yellow for the level, orange for the floor.
 *
 * A floor arrives clipped. A scope's floor is cut to the level that scope
 * makes before anything reads it — see `underfoot` — so a group's floor is
 * already inside its walls by the time the bake carries it, and there is
 * nothing left here to cut it against. This draws what it is handed.
 */
function replay(
  ctx: CanvasRenderingContext2D,
  view: View,
  frame: Frame,
): void {
  if (frame.length === 0) return;

  const stroke = (runs: Frame, colour: string, width: number): void => {
    if (runs.length === 0) return;

    ctx.beginPath();

    for (const run of runs) {
      run.points.forEach((p, i) => {
        const q = toScreen(view, p);

        if (i === 0) ctx.moveTo(q.x, q.y);
        else ctx.lineTo(q.x, q.y);
      });
    }

    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.stroke();
  };

  // The floors first, so the set draws over them where they meet — which is
  // the order they stand in, and the order the 3D view draws them in too.
  stroke(frame.filter(r => r.fill), theme.replayFloor, 1.25);
  stroke(frame.filter(r => !r.fill), theme.replay, 1.25);
}

/** What has been laid down so far, and the band out to the cursor. */
function draft(ctx: CanvasRenderingContext2D, view: View, d: Draft): void {
  const points = d.points.map(p => toScreen(view, p));
  const to = toScreen(view, d.at);

  ctx.beginPath();
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.lineTo(to.x, to.y);

  ctx.strokeStyle = theme.draft;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.beginPath();
  for (const p of points) {
    ctx.rect(Math.round(p.x) - 2.5, Math.round(p.y) - 2.5, 5, 5);
  }
  ctx.fillStyle = theme.draft;
  ctx.fill();

  // The first point, once there is a ring to close, says so when reached
  if (d.points.length >= 3) {
    const first = points[0];
    const closing = Math.hypot(first.x - to.x, first.y - to.y) <= HANDLE;

    ctx.beginPath();
    ctx.arc(first.x, first.y, HANDLE / 2, 0, Math.PI * 2);
    ctx.strokeStyle = closing ? theme.csg : theme.draft;
    ctx.lineWidth = closing ? 2 : 1;
    ctx.stroke();
  }
}

/**
 * The committed measuring paths: the legs, the points, and the clock at each.
 *
 * The number is the whole point of the drawing. It goes above and to the right
 * of its point, one side for all of them, so that a path doubling back on
 * itself has its labels in a readable column rather than scattered around the
 * corners.
 */
function measures(
  ctx: CanvasRenderingContext2D,
  view: View,
  laid: readonly Laid[],
  /** The one being carried on with, drawn by the gesture instead. */
  open: PathId | null,
  picked: OnPath | null,
  /** The paths the selection names in themselves. */
  mine: ReadonlySet<PathId>,
  /** The paths it reaches through a group it names instead. */
  held: ReadonlySet<PathId>,
): void {
  for (const it of laid) {
    if (it.id === open) continue;

    // Named beats held where something has managed to be both: what the
    // selection says outright is what it says.
    const whole = mine.has(it.id) ? 'own' : held.has(it.id) ? 'group' : null;

    tape(ctx, view, it.points, null, picked?.id === it.id ? picked.index : null, whole);
  }
}

/** The path being laid down: what is there, and the leg the cursor is on the
 * end of. */
function laying(ctx: CanvasRenderingContext2D, view: View, w: Walk): void {
  tape(ctx, view, w.points, w.at, null, null);
}

/**
 * One path drawn: `points` as legs with a time at each, and `to` as the leg
 * still being aimed, which carries the time it would come to.
 */
function tape(
  ctx: CanvasRenderingContext2D,
  view: View,
  points: readonly Point[],
  to: Point | null,
  picked: number | null,
  /**
   * How the whole walk is picked, which is the state a transform acts on, or
   * nothing where it is not: `own` for a tape the selection names, `group` for
   * one a picked group has hold of.
   *
   * Drawn as a colour rather than as an outline round it: a tape is a line,
   * and a line round a line is two lines. The two colours are the ones the
   * rest of the canvas already uses for the difference — blue for a thing
   * picked in itself, the group's green for one picked through a group.
   */
  whole: 'own' | 'group' | null,
): void {
  if (points.length === 0) return;

  const screen = points.map(p => toScreen(view, p));
  const times = timings(to === null ? points : [...points, to]);

  const ink = whole === 'own' ? theme.picked : whole === 'group' ? theme.grouped : theme.path;

  ctx.beginPath();
  screen.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));

  ctx.strokeStyle = ink;
  ctx.lineWidth = whole === null ? 1.5 : 2;
  ctx.lineJoin = 'round';
  ctx.setLineDash(DASH);
  ctx.stroke();

  // The leg on the end of the cursor, dashed finer: it is where the walk would
  // go rather than where it goes, and the difference is worth seeing without
  // reading the numbers.
  if (to !== null) {
    const end = toScreen(view, to);
    const last = screen[screen.length - 1];

    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(end.x, end.y);
    ctx.setLineDash([2, 3]);
    ctx.stroke();
  }

  ctx.setLineDash([]);

  ctx.beginPath();
  for (const p of screen) {
    ctx.rect(Math.round(p.x) - 2.5, Math.round(p.y) - 2.5, 5, 5);
  }
  ctx.fillStyle = ink;
  ctx.fill();

  if (picked !== null && screen[picked] !== undefined) {
    const p = screen[picked];

    ctx.beginPath();
    ctx.arc(p.x, p.y, HANDLE / 2, 0, Math.PI * 2);
    ctx.strokeStyle = theme.picked;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = theme.pathText;

  // Nothing at the first point: zero seconds is where every walk starts and
  // saying so is one number per path that never changes.
  screen.forEach((p, i) => {
    if (i > 0) ctx.fillText(seconds(times[i]), p.x + 6, p.y - 5);
  });

  if (to !== null) {
    const end = toScreen(view, to);

    ctx.fillText(seconds(times[times.length - 1]), end.x + 6, end.y - 5);
  }
}

/** The dash a measuring path is drawn with. Long enough to read as a dashed
 * line at a glance rather than as a dotted one, which is what the fill under a
 * floor already is. */
const DASH = [6, 4];

/**
 * The rectangle or n-gon under the cursor, before it is anything.
 *
 * Closed, unlike the pen's draft, because it is a whole shape at every moment
 * of the drag rather than a shape being accumulated: there is nothing here
 * that is not decided yet except how far the hand goes next. Drawn in the
 * pen's own colour, since it is the same tool saying the same thing.
 */
function formed(ctx: CanvasRenderingContext2D, view: View, it: Forming): void {
  const points = it.ring.map(p => toScreen(view, p));

  ctx.beginPath();
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();

  ctx.strokeStyle = theme.draft;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.stroke();

  ctx.beginPath();
  for (const p of points) {
    ctx.rect(Math.round(p.x) - 2.5, Math.round(p.y) - 2.5, 5, 5);
  }
  ctx.fillStyle = theme.draft;
  ctx.fill();

  // Over the first corner, which is where the drag started and so the one
  // place on the shape the cursor is certainly not covering.
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(it.label, points[0].x + 8, points[0].y - 6);
}

/** A label beside the cursor, below and to the right of it, where the hand
 * is not covering it. */
function said(ctx: CanvasRenderingContext2D, view: View, it: { at: Point, label: string }): void {
  const p = toScreen(view, it.at);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = theme.draft;
  ctx.fillText(it.label, p.x + 14, p.y + 14);
}

function marquee(ctx: CanvasRenderingContext2D, view: View, m: Marquee): void {
  const a = toScreen(view, m.a), b = toScreen(view, m.b);

  const x = Math.round(Math.min(a.x, b.x));
  const y = Math.round(Math.min(a.y, b.y));
  const width = Math.round(Math.abs(b.x - a.x));
  const height = Math.round(Math.abs(b.y - a.y));

  ctx.fillStyle = theme.selectionFill;
  ctx.fillRect(x, y, width, height);

  ctx.strokeStyle = theme.selection;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, width, height);
}

/**
 * A dot per grid intersection, as one path so that the fill is a single call.
 * The loop counts grid lines rather than accumulating a step, which keeps the
 * dots where they belong however far the view has been panned.
 */
function grid(ctx: CanvasRenderingContext2D, settings: Settings, view: View): void {
  const step = settings.gridSize * view.zoom;

  if (step < MIN_DOT_SPACING) {
    return;
  }

  const gx0 = Math.floor(view.x / settings.gridSize);
  const gy0 = Math.floor(view.y / settings.gridSize);
  const gx1 = Math.ceil((view.x + view.width / view.zoom) / settings.gridSize);
  const gy1 = Math.ceil((view.y + view.height / view.zoom) / settings.gridSize);

  const size = step >= 24 ? 2 : 1;
  const offset = (size - 1) / 2;

  ctx.beginPath();

  for (let gy = gy0; gy <= gy1; gy++) {
    const sy = Math.round((gy * settings.gridSize - view.y) * view.zoom) - offset;

    for (let gx = gx0; gx <= gx1; gx++) {
      const sx = Math.round((gx * settings.gridSize - view.x) * view.zoom) - offset;

      ctx.rect(sx, sy, size, size);
    }
  }

  ctx.fillStyle = theme.grid;
  ctx.fill();
}

/** The world's two axes, so that a pan has something to be relative to. */
function axes(ctx: CanvasRenderingContext2D, view: View): void {
  const x = Math.round(-view.x * view.zoom) + 0.5;
  const y = Math.round(-view.y * view.zoom) + 0.5;

  ctx.beginPath();

  if (x > 0 && x < view.width) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, view.height);
  }

  if (y > 0 && y < view.height) {
    ctx.moveTo(0, y);
    ctx.lineTo(view.width, y);
  }

  ctx.strokeStyle = theme.axis;
  ctx.lineWidth = 1;
  ctx.stroke();
}

