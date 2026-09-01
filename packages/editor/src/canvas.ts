import { Value } from '@incpt/kontinuum';
import { VNode, effect } from '@incpt/kontinuum-dom';
import { canvas } from '@incpt/kontinuum-dom/html';
import { Op, select, signal } from '@incpt/kontinuum-interaction';
import { interactive } from '@incpt/kontinuum-interaction/dom';

import { Bake, Frame, artefactsDuring, replayed } from './bake';
import { Ring, Shape, erodedCorners, erodedShape, ngon } from './geometry';
import {
  Input,
  blurred,
  keyPressed,
  keyReleased,
  pan,
  pointerDragged,
  pointerMoved,
  pointerPressed,
  pointerReleased,
} from './input';
import {
  EMPTY_LIVE,
  Live,
  Resolved,
  addPolygon,
  landing,
  addVertex,
  centroid,
  editAt,
  hitEdge,
  hitPolygons,
  hitting,
  hitVertex,
  contributing,
  starting,
  deepen,
  owning,
  under,
  unplace,
  unstep,
  IDENTITY,
  Placed,
  affine,
  place,
  placeAt,
  START_ID,
  addArtefact,
  artefactsAt,
  artefactsIn,
  artefactsWithinBox,
  hitArtefact,
  movedStart,
  depths,
  occupying,
  occupyingSource,
  removeArtefacts,
  retypeArtefacts,
  shownAt,
  startPlaced,
  turnedStart,
  Occupied,
  swallowed,
  reachable,
  reaching,
  live,
  placeVertex,
  polygonsIn,
  without,
  removeVertices,
  resolveAt,
  runs,
  verticesWithinBox,
  withEdit,
  withinBox,
} from './scene';
import {
  OnPath,
  addPath,
  hitPathEdge,
  hitPathPoint,
  seconds,
  setPath,
  timings,
} from './paths';
import { theme } from './theme';
import {
  ARTEFACTS,
  ArtefactId,
  FIGURES,
  NGON_MAX,
  NGON_MIN,
  EMPTY_SELECTION,
  EMPTY_TRANSFORM,
  ArtefactType,
  EditorState,
  Id,
  Path,
  PathId,
  Point,
  Polygon,
  PolygonId,
  PolygonType,
  Replay,
  Selection,
  Settings,
  Figure,
  zoomedAt,
  Tool,
  Transform,
  Update,
  VersionId,
  VertexId,
  View,
  World,
  GroupId,
  alsoPicked,
  enclosing,
  onGrid,
  toStep,
  marked,
  opened,
  panBy,
  parentOf,
  within,
  resized,
  togglePicked,
  toScreen,
  toWorld,
} from './types';

/** Screen pixels within which a vertex is grabbable, or the first point closes. */
const HANDLE = 9;

/**
 * Screen pixels the pointer may wander between going down and coming up while
 * the press still counts as a click rather than a drag. See `pointerDragged`.
 */
const SLOP = 3;

/**
 * How long after a click another one in the same place is the second half of a
 * double-click. The platform's own interval, which is not readable from a page
 * — 500ms is the Mac default and 350 is what most editors settle on, being
 * short enough that two deliberate clicks on the same room are still two.
 *
 * Timed here rather than read off the event, because a pointer event does not
 * carry a click count: `detail` is the click count on `mousedown` and zero on
 * `pointerdown`, and this loop is built on pointer events so that a press,
 * a drag and a release are one story.
 */
const DOUBLE_MS = 350;

/** Takes the picked corners out, or the picked polygons under the other tool. */
const REMOVE = ['Backspace', 'Delete'];

/**
 * The world, drawn, and every way of getting at it.
 *
 * There is one canvas and one loop. An earlier version had a second transparent
 * canvas over the first with its own gestures, which meant two places deciding
 * what a press meant and no way for either to know what the other was doing.
 * Everything a gesture needs to leave on screen while it runs — a marquee, a
 * half-drawn polygon — lives in this component's own state and goes when the
 * gesture does.
 *
 * Drawing is a list of layers rather than one routine: the effect works out
 * what should be on screen, hands over an array of functions, and `draw` runs
 * them in order over a prepared context. Adding something to look at is adding
 * one to the list.
 */
export function worldCanvas(
  world: Value<World>,
  settings: Value<Settings>,
  view: Value<View>,
  tool: Value<Tool>,
  figure: Value<Figure>,
  selection: Value<Selection>,
  inside: Value<GroupId | null>,
  currentVersion: Value<VersionId>,
  replay: Value<Replay | null>,
  bake: Value<Bake>,
  roaming: Value<boolean>,
  input: Input,
  update: Update,
): VNode {
  let el: HTMLCanvasElement | undefined;
  let ctx: CanvasRenderingContext2D | null = null;

  const cursor = (value: string) => {
    if (el) {
      el.style.cursor = value;
    }
  };

  /** The CSG set, kept between draws. Derived from the world and nothing else,
   * so it is a cache rather than state: rebuilding it would be correct and slow,
   * and this makes a redraw cost only what actually moved. */
  let set: Live = EMPTY_LIVE;

  /**
   * The version a replay is walking towards, resolved: where each shut group
   * stands there, which is what the animated floors are clipped against.
   *
   * The same shape the group is drawn as, from the same place it comes from —
   * a replay draws no pillar inside a shut group any more than the still
   * drawing does, so a floor stops at the hole one leaves in both.
   *
   * Kept because a replay redraws every frame and the version it is walking
   * towards does not move while it does — resolving it per frame would resolve
   * one still world sixty times a second to draw the same shape.
   */
  let held: { world: World, to: VersionId, inside: GroupId | null, at: Map<GroupId, Shape> } | null = null;

  const bounds = (w: World, to: VersionId, ins: GroupId | null): Map<GroupId, Shape> => {
    if (held !== null && held.world === w && held.to === to && held.inside === ins) return held.at;

    const at = new Map(
      occupying(w, to, resolveAt(w, to), opened(w, ins)).map(g => [g.id, g.shape]),
    );

    held = { world: w, to, inside: ins, at };

    return at;
  };

  /** Where and when the last click landed, for telling the second of a pair
   * from the first. Cleared by anything that is not a click. */
  let last: { at: Point, when: number } | null = null;

  /**
   * A polygon being laid down is told to stop.
   *
   * The pen owns its draft for as long as it runs, so nothing else may take
   * one away — clearing the state under it would leave it waiting, and the
   * click that came next would be swallowed as another point of a polygon that
   * is no longer on screen. Anything that ends a draft from outside says so
   * here and lets the gesture unwind itself.
   */
  const abandoned = signal<void>();

  return interactive<Local>(EMPTY_LOCAL, (local, setLocal) => {
    /**
     * Where in the world a pointer event is, on the grid unless it says not to.
     *
     * `snap` is whether this reading is a place something will be put, as
     * against a place something is being looked for: a corner goes on the
     * grid, and a click hunting for the corner already there has to be read
     * where the cursor actually is or it would find whatever is nearest the
     * grid dot instead.
     */
    const at = (e: PointerEvent, snap = false): Point => {
      const box = el?.getBoundingClientRect();
      const p = toWorld(view(), {
        x: e.clientX - (box?.left ?? 0),
        y: e.clientY - (box?.top ?? 0),
      });

      return snap && !free(e) ? onGrid(p, settings().gridSize) : p;
    };

    /**
     * Whether the hand is asking for this one not to snap.
     *
     * Read off the event rather than off `input.holding`, so it is the state
     * of the key at the moment of the move being answered: taking Ctrl during
     * a drag frees it from there on and letting go puts it back, without the
     * gesture having to watch for either.
     */
    const free = (e: { ctrlKey: boolean }): boolean => e.ctrlKey;

    // -------------------------------------------------------------------------
    // Gestures
    // -------------------------------------------------------------------------

    function* panning(): Op<void> {
      cursor('grab');

      yield* select({
        panning: pan(update),
        done: keyReleased(input, 'Space'),
        lost: blurred(),
      });

      cursor('');
    }

    /**
     * Panning folded into a gesture that is already running: it moves the view
     * while space is held, and is not there otherwise. Never resumes, so it is
     * raced alongside whatever the gesture is really waiting for.
     *
     * Reaching the far corner of a room bigger than the window is not
     * something to have to do before starting. It comes up in the middle of a
     * marquee that has to reach past the edge, and in the middle of dragging
     * something to a place the window is not currently showing.
     *
     * The gesture needs no telling and recomputes nothing. Panning moves the
     * view by the cursor's own step, so the world point under the cursor does
     * not move at all — and every gesture here works from where the cursor is
     * in the world. During a pan they are each being handed the same answer
     * they were handed before it, which is the sense in which the polygon
     * stays put while the window travels.
     */
    function alongside(): Op<never> {
      let last: Point | null = null;

      return pointerMoved(e => {
        if (!input.holding('Space')) {
          last = null;

          return;
        }

        const to = { x: e.clientX, y: e.clientY };
        const from = last;

        last = to;

        if (from !== null) {
          update(s => ({ ...s, view: panBy(s.view, to.x - from.x, to.y - from.y) }));
        }
      });
    }

    /**
     * The box, in world units so it stays over what it was drawn over, and
     * whatever it has caught when the button comes back up.
     *
     * Which tool is up decides what it is catching — corners under the point
     * tool, whole polygons under the polygon one — so a marquee picks the same
     * kind of thing a click would. Shift adds to what was already picked rather
     * than replacing it, and letting shift go mid-drag does not undo that: what
     * a gesture meant was settled when it started.
     */
    function* marqueeing(from: PointerEvent, adding: boolean): Op<void> {
      const a = at(from);
      setLocal({ ...local(), marquee: { a, b: a } });

      const end = yield* select({
        dragging: pointerMoved(e => setLocal({ ...local(), marquee: { a, b: at(e) } })),
        panning: alongside(),
        done: pointerReleased(),
        cancel: keyPressed(input, 'Escape'),
        lost: blurred(),
      });

      const box = local().marquee;
      setLocal({ ...local(), marquee: null });

      if (end.tag !== 'done' || box === null) return;

      // Artefacts come off both tools that can hold them, so a box drawn round
      // a room takes what is standing in it as well as the room.
      if (tool() === 'artefact' || tool() === 'polygon') {
        const caught = artefactsWithinBox(
          artefactsAt(world(), currentVersion()),
          box.a,
          box.b,
        );

        update(s => ({
          ...s,
          selection: {
            ...s.selection,
            start: false,
            artefacts: alsoPicked(adding ? s.selection.artefacts : [], caught),
          },
        }));

        if (tool() === 'artefact') return;
      }

      const points = tool() === 'point';

      // A box over the corners is a selection of corners, so nothing is picked
      // out of a path any more. One Backspace, one meaning.
      if (points) setLocal({ ...local(), onPath: null });

      // Corners come off what is on screen as itself; polygons come off
      // everything, because a member is how a marquee finds the group over it.
      const items = points ? pickable() : resolveAt(world(), currentVersion());

      // A marquee takes whole groups: half a group picked is a selection that
      // no gesture could act on without taking the group apart. Whole at the
      // level standing open, that is — inside a group it takes that group's
      // members, which is the point of having gone in.
      const path = opened(world(), inside());
      const caught = points
        ? verticesWithinBox(items, box.a, box.b)
        : [...new Set(
          withinBox(items, box.a, box.b)
            .filter(id => reachable(world(), id, inside()))
            .map(id => reaching(world(), id, path)),
        )];

      update(s => ({
        ...s,
        selection: points
          ? { ...s.selection, vertices: alsoPicked(adding ? s.selection.vertices : [], caught) }
          : { ...s.selection, polygons: alsoPicked(adding ? s.selection.polygons : [], caught) },
      }));
    }

    /**
     * The picked corners follow the cursor, and the projection under them
     * updates live. The displacements land in the version on screen, so every
     * later version sees them too — which is what the ghosts held open during
     * the drag are there to let the author judge.
     *
     * The corner actually grabbed is the one that snaps; the rest keep their
     * offsets from it. Snapping each of them on its own would pull a dragged
     * group out of shape one corner at a time, and the shape is what was picked.
     */
    function* draggingVertices(grabbed: VertexId, ids: readonly VertexId[]): Op<void> {
      const v = currentVersion();
      const was = world();
      const items = resolveAt(was, v);

      // Where each of them stood when the drag began. Every move is computed
      // from here rather than from the frame before, so the gesture cannot
      // drift and letting go leaves exactly what is on screen.
      const held = new Map<VertexId, { id: PolygonId, from: Point }>();

      for (const it of items) {
        it.corners.forEach((corner, i) => {
          if (ids.includes(corner.id)) held.set(corner.id, { id: it.id, from: it.source[i] });
        });
      }

      const anchor = held.get(grabbed);

      if (anchor === undefined) return;

      setLocal({ ...local(), previewing: true });

      const locked = axisLock(() => SLOP / view().zoom);

      const end = yield* select({
        dragging: pointerMoved(e => {
          const to = at(e, true);
          const step = locked(e, { x: to.x - anchor.from.x, y: to.y - anchor.from.y });
          const dx = step.x, dy = step.y;

          update(s => {
            let world = s.world;

            for (const [vertex, { id, from }] of held) {
              const it = resolveAt(world, v).find(r => r.id === id);
              if (it === undefined) continue;

              const index = it.corners.findIndex(c => c.id === vertex);
              if (index < 0) continue;

              const edit = placeVertex(
                it,
                editAt(world, v, id, it),
                index,
                { x: from.x + dx, y: from.y + dy },
              );

              world = withEdit(world, v, id, edit);
            }

            return { ...s, world };
          });
        }),
        panning: alongside(),
        done: pointerReleased(),
        cancel: keyPressed(input, 'Escape'),
        lost: blurred(),
      });

      setLocal({ ...local(), previewing: false });
      update(s => settled(s, was, end.tag === 'cancel'));
    }

    /**
     * Hold the key, move the mouse, let go. Every move recomputes from the
     * transforms as they were when the key went down rather than from the last
     * frame, so the gesture cannot drift and letting go leaves exactly what was
     * on screen.
     */
    function* transforming(code: string, mode: Mode): Op<void> {
      const e = input.pointer();
      const v = currentVersion();
      const was = world();

      if (e === null) return;

      // Erosion is a depth, and a point has no thickness to take one out of.
      // So an artefact sits out that one gesture rather than being handed a
      // key that means nothing to it — every other transform means what it
      // means to anything else.
      const standing = code === 'KeyE' ? [] : selection().artefacts;

      // Erosion is the one transform a corner can be under by itself: picked
      // corners eroded go deeper than the polygon they are in rather than
      // instead of it, which is what a depth per corner is for. Their polygons
      // stand in for them here — a depth is written into the layer of the
      // thing that has a ring, and a corner has none — and every other gesture
      // ignores the corners entirely, being about where a whole thing is.
      // Under the point tool alone, which is the only one that picks them:
      // a corner selection left standing while the hand is on the polygon tool
      // is not what an erosion there is asking about.
      const corners = new Set(
        code === 'KeyE' && tool() === 'point' ? selection().vertices : [],
      );
      const owners = corners.size === 0 ? [] : owning(world(), corners);

      const ids = [...(owners.length > 0 ? owners : selection().polygons), ...standing];

      const reached = new Set(polygonsIn(world(), ids));
      const items = resolveAt(world(), v).filter(it => reached.has(it.id));

      const mine = new Set(artefactsIn(world(), ids));
      const places = artefactsAt(world(), v).filter(it => mine.has(it.id)).map(it => it.at);

      // The start takes the two gestures that mean something to a place with a
      // direction, and it takes them alone — it is picked alone. What it is
      // not is a member of the selection above: it is in no version's layer,
      // so a move writes its own point rather than an edit at `v`, and every
      // version reads the one it wrote.
      const beginning = code === 'KeyT' || code === 'KeyR' ? selection().start : false;

      if (items.length === 0 && places.length === 0 && !beginning) return;

      const from = at(e);

      // Where the drag started on screen, for the one gesture that is about
      // how far the hand has gone rather than about where it has got to.
      const down = { x: e.clientX, y: e.clientY };

      // The layer as it stood when the key went down. A transform written into
      // this version replaces whatever it held, so the gesture recomputes from
      // here rather than composing onto its own last frame.
      const anchors = starting(world(), v, ids);

      // One pivot for the whole selection, so several polygons turn together
      // rather than each about itself. Artefacts are in it: a room turning
      // about a centre its own key was left out of would leave the key behind.
      //
      // A lone artefact turns about its own point and stays exactly where it
      // is, which is the gesture the start wants — the place is unchanged and
      // the facing is not. Every other kind has no facing to change, so it is
      // a turn that does nothing, which is what a turn of a point should be.
      const pivot = centroid([
        ...items.flatMap(it => it.source),
        ...places,
        ...(beginning ? [was.start.at] : []),
      ]);

      cursor('crosshair');
      setLocal({ ...local(), previewing: true });

      // The frame each of them reads its own transform in. Not one frame for
      // all: a selection can hold a polygon inside a turned group and another
      // outside it, and each answers in its own.
      //
      // Erosion takes the cursor as it comes. It is a depth rather than a
      // place — not in the frame at all — and a drag that erodes has to mean
      // the same thing whichever way a group has been turned, which is exactly
      // what taking it back through a rotation would stop it doing.
      const frames = new Map(
        [...anchors.keys()].map(id => [id, code === 'KeyE' ? IDENTITY : under(was, v, id)]),
      );

      /**
       * Where the cursor is taken to be, which is the whole of how these
       * gestures snap.
       *
       * One place rather than one rule per transform, because a move, a turn
       * and an erosion are all a reading of two points about a pivot: land the
       * second of them somewhere the grid allows and the transform lands there
       * with it. What "somewhere the grid allows" means is the one thing that
       * differs — a move is a step of whole cells, a turn is five degrees, an
       * erosion is a cell of depth.
       *
       * A scale is not in here at all. It reads the drag rather than the
       * cursor, and where the cursor happens to be says nothing about it.
       */
      const locked = axisLock(() => SLOP / view().zoom);

      const aim = (e: PointerEvent): Point => {
        const to = at(e);
        const g = settings().gridSize;

        // The step, not the place: a selection has no one point that ought to
        // land on the grid, and snapping any particular corner of it would
        // drag the rest out of whatever alignment they had. Alt holds it to
        // one axis, before the grid rather than after, so that a locked move
        // is still a whole number of cells along the line it is held to.
        if (code === 'KeyT') {
          const step = locked(e, { x: to.x - from.x, y: to.y - from.y });

          return free(e)
            ? { x: from.x + step.x, y: from.y + step.y }
            : { x: from.x + toStep(step.x, g), y: from.y + toStep(step.y, g) };
        }

        // A depth, read off the horizontal alone: right gives material back,
        // left eats into the shape, and the vertical is drift. It read both
        // for a while, taking whichever the hand had gone furthest along, and
        // that turned every diagonal into a guess about which of the two was
        // meant — a depth is one number, so one axis says it.
        if (code === 'KeyE') {
          const deep = from.x - to.x;

          return { x: to.x, y: from.y + (free(e) ? deep : toStep(deep, g)) };
        }

        if (free(e)) return to;

        // Five degrees ordinarily and forty-five with Alt: the second is the
        // set of turns a level is actually built out of, and the first is fine
        // enough to aim anything else with.
        if (code === 'KeyR') return turnedAbout(pivot, from, to, e.altKey ? EIGHTH : TURN);

        return onGrid(to, g);
      };

      /**
       * What a scale multiplies by, out of how far the drag has gone on screen.
       *
       * Not out of where the cursor is against the pivot, which is what this
       * was and what made it unusable: that reading is a quotient of two
       * distances, so grabbing anywhere near the pivot divides by nearly
       * nothing and the room is suddenly a mile wide. Nothing about the drag
       * says that is what was asked for — it is the arithmetic failing, at
       * exactly the place a hand is most likely to start from.
       *
       * A drag is a distance, and what a scale wants is a factor, so the one
       * becomes the other through an exponent: no drag is 1:1, `DOUBLING`
       * pixels either way is twice or half, and twice that is four times or a
       * quarter. Symmetric, unbounded in both directions and never singular —
       * the same pixels always mean the same factor, wherever the hand
       * happened to start.
       *
       * Right and up grow, left and down shrink — the same rule the erosion
       * reads its depth by. Up rather than down for the vertical, because a
       * thing being made bigger is a thing being raised, and every slider and
       * every handle in every editor agrees about that.
       */
      const scaling = (e: PointerEvent): Point => {
        const d = { x: e.clientX - down.x, y: down.y - e.clientY };
        const by = (n: number): number => Math.pow(2, n / DOUBLING);

        // One factor for both axes with Alt, off whichever way the hand went
        // furthest. Without it the two axes are independent, which is the
        // reading worth having: a room made wider and shallower is one gesture
        // rather than two.
        const f = e.altKey
          ? by(Math.abs(d.x) >= Math.abs(d.y) ? d.x : d.y)
          : null;

        const out = f === null ? { x: by(d.x), y: by(d.y) } : { x: f, y: f };

        // Eighths, which is where the factors worth having live: a half, three
        // quarters, one and a half, twice. Below an eighth is a shape squashed
        // to nothing, and it stops there rather than passing through zero.
        return free(e)
          ? out
          : { x: Math.max(STEP, toStep(out.x, STEP)), y: Math.max(STEP, toStep(out.y, STEP)) };
      };

      const end = yield* select({
        moving: pointerMoved(e => {
          const to = aim(e);
          const factor = scaling(e);

          update(s => {
            let world = s.world;

            // Its own point and its own facing, off the same reading of the
            // drag the transforms get: a move is where the cursor has gone, and
            // a turn about its own point is a turn of the direction alone.
            if (beginning && code === 'KeyT') {
              world = movedStart(world, {
                x: was.start.at.x + to.x - from.x,
                y: was.start.at.y + to.y - from.y,
              });
            }
            else if (beginning) {
              world = turnedStart(world, was.start.facing + about(pivot, from, to));
            }

            for (const [id, edit] of anchors) {
              const polygon = world.polygons.get(id);

              if (corners.size > 0 && polygon !== undefined) {
                world = withEdit(
                  world,
                  v,
                  id,
                  deepen(edit, polygon, corners, to.y - from.y),
                );
                continue;
              }

              const m = frames.get(id)!;

              world = withEdit(world, v, id, {
                ...edit,
                transform: mode(edit.transform, {
                  pivot: unplace(m, pivot),
                  from: unplace(m, from),
                  to: unplace(m, to),
                  alt: e.altKey,
                  factor,
                }),
              });
            }

            return { ...s, world };
          });
        }),
        panning: alongside(),
        done: keyReleased(input, code),
        cancel: keyPressed(input, 'Escape'),
        lost: blurred(),
      });

      setLocal({ ...local(), previewing: false });
      cursor('');
      update(s => settled(s, was, end.tag === 'cancel'));
    }

    function retype(type: Polygon['type']): void {
      update(s => {
        const polygons = new Map(s.world.polygons);

        for (const id of polygonsIn(s.world, s.selection.polygons)) {
          const p = polygons.get(id);
          if (p !== undefined) polygons.set(id, { ...p, type });
        }

        return marked({ ...s, world: { ...s.world, polygons } }, s.world);
      });
    }

    function retypeArtefact(type: ArtefactType): void {
      update(s => s.selection.artefacts.length === 0
        ? s
        : marked(
          { ...s, world: retypeArtefacts(s.world, s.selection.artefacts, type) },
          s.world,
        ));
    }

    /**
     * A click on empty canvas under the artefact tool puts one there.
     *
     * Born into the version on screen, like a polygon, and of the first kind
     * there is — the number keys retype it, and one that was never going to be
     * an exit is one keystroke from being whatever it is.
     */
    function placing(e: PointerEvent): void {
      update(s => {
        const { world, id } = addArtefact(
          s.world,
          ARTEFACTS[0],
          at(e, true),
          s.currentVersion,
          landing(s.world, s.currentVersion, s.inside),
        );

        return marked(
          { ...s, world, selection: { ...s.selection, artefacts: [id], start: false } },
          s.world,
        );
      });
    }

    /**
     * The start picks alone and drops everything else, Shift or no Shift: it is
     * not in the versions, so the gestures that would hold it together with a
     * room have two different places to write and one thing to mean by it.
     */
    function pickingArtefact(e: PointerEvent, id: ArtefactId): void {
      if (id === START_ID) {
        update(s => ({ ...s, selection: { ...EMPTY_SELECTION, start: true } }));
        return;
      }

      update(s => ({
        ...s,
        selection: e.shiftKey
          ? { ...s.selection, start: false, artefacts: togglePicked(s.selection.artefacts, id) }
          : { ...s.selection, start: false, polygons: [], artefacts: [id] },
      }));
    }

    /** A polygon is born into the version it was drawn in, and nothing before
     * that version may name it. */
    function commit(points: Point[]): void {
      update(s => {
        // Into the group standing open, and read in its frame: drawing inside
        // a group makes a member of it, exactly where the cursor put it.
        const { world, id } = addPolygon(
          s.world,
          'level',
          points,
          s.currentVersion,
          landing(s.world, s.currentVersion, s.inside),
        );

        return marked(
          { ...s, world, selection: { ...s.selection, polygons: [id] } },
          s.world,
        );
      });
    }

    /**
     * A rectangle, dragged from one corner to the other.
     *
     * A drag rather than a sequence of clicks, because a rectangle is two
     * points and a drag is the gesture that says two points at once. The
     * corners snap like anything else, which is most of why the tool is worth
     * having: four right angles on the grid, in one movement.
     */
    function* rectangling(from: PointerEvent): Op<void> {
      const a = at(from, true);

      const end = yield* forming(e => {
        const b = at(e, true);

        if (a.x === b.x || a.y === b.y) return null;

        return {
          ring: [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }],
          label: `${Math.round(Math.abs(b.x - a.x))} × ${Math.round(Math.abs(b.y - a.y))}`,
        };
      });

      if (end !== null) commit(end.ring);
    }

    /**
     * A regular polygon, dragged out from its centre.
     *
     * Two numbers off the one drag, on the two axes: rightward is how big, and
     * upward is how many sides. Not a radius and an angle, which is the other
     * way a drag could say this — the angle would be spent saying something
     * nobody wants said continuously, and the count would then have nowhere to
     * come from but the keyboard.
     *
     * Leftward and downward mean the same as rightward and upward, so a hand
     * that started the drag going the wrong way is not stuck: it is the size
     * of the movement that is being read, not its direction.
     */
    function* ngoning(from: PointerEvent): Op<void> {
      const centre = at(from, true);
      const down = { x: from.clientX, y: from.clientY };

      const end = yield* forming(e => {
        const g = settings().gridSize;
        const wide = Math.abs(at(e).x - centre.x);
        const radius = free(e) ? wide : Math.max(g, toStep(wide, g));
        const sides = Math.min(
          NGON_MAX,
          Math.max(NGON_MIN, NGON_MIN + Math.round(Math.abs(down.y - e.clientY) / PER_SIDE)),
        );

        return radius <= 0
          ? null
          : { ring: ngon(centre, radius, sides), label: `${sides} · r ${Math.round(radius)}` };
      });

      if (end !== null) commit(end.ring);
    }

    /**
     * The body of a drag that shapes a polygon: `shape` says what is under the
     * cursor now, the canvas draws it, and letting go commits whatever was
     * last drawn.
     *
     * One gesture for the two of them because the difference between them is
     * exactly one function, and everything else — the preview, the escape, the
     * panning mid-drag, the nothing-yet case — is not about which shape it is.
     */
    function* forming(shape: (e: PointerEvent) => Forming | null): Op<Forming | null> {
      const end = yield* select({
        moving: pointerMoved(e => setLocal({ ...local(), forming: shape(e) })),
        panning: alongside(),
        done: pointerReleased(),
        cancel: keyPressed(input, 'Escape'),
        lost: blurred(),
      });

      const made = local().forming;

      setLocal({ ...local(), forming: null });

      return end.tag === 'done' ? made : null;
    }

    /**
     * Laying down a polygon, from the first point to the last.
     *
     * A gesture that runs rather than a click handler that returns, and that
     * is the whole of why it is written this way. A half-drawn polygon is a
     * mode: while one is open a click is another of its points rather than a
     * selection, Escape abandons it rather than stepping out of a group, and
     * Cmd+Z takes back a point rather than undoing the document. Spreading
     * those over the handlers that would otherwise own each key means every
     * one of them asking whether a draft happens to be open, and being wrong
     * about it is a whole polygon lost.
     *
     * Held here instead: for as long as this runs, it is the thing the canvas
     * is doing. The draft still lives in the component's state because it has
     * to be drawn, but nothing outside this creates one or takes one away.
     *
     * Drawing is its own tool, and that is the whole answer to what a click on
     * empty canvas means. Under the point tool it means letting go of what was
     * picked; here it means starting a shape. One tool doing both has to guess,
     * and there is nothing in the click to guess from — which is why no editor
     * asks it to. Illustrator has the pen apart from direct selection, Figma
     * has P apart from V, Inkscape has the bezier tool apart from the node
     * editor.
     */
    function* drawing(from: PointerEvent): Op<void> {
      const first = at(from, true);

      setLocal({ ...local(), draft: { points: [first], at: first } });

      // Cmd+Z is the pen's for as long as a polygon is open. Without this the
      // shortcuts in `editor.ts` would undo the document under it, which is
      // both surprising and unreachable: the points laid down so far are not
      // in the document to be undone.
      const release = input.claim('KeyZ');

      try {
        while (true) {
          const next = yield* select({
            key: input.keyDown,
            press: pointerPressed(),

            // Never resumes: it is here to keep the rubber band on the end of
            // the cursor for as long as nothing else is happening.
            tracking: pointerMoved(e => {
              const d = local().draft;

              if (d !== null) setLocal({ ...local(), draft: { ...d, at: at(e, true) } });
            }),

            // The tool changed out from under the pen. Anything that ends a
            // draft from outside says so here rather than clearing it and
            // leaving this loop to eat the next click as a point.
            stopped: abandoned,

            lost: blurred(),
          });

          if (next.tag === 'stopped' || next.tag === 'lost') return abandon();

          if (next.tag === 'key') {
            const e = next.value;
            const command = e.metaKey || e.ctrlKey;

            if (!command && e.code === 'Space') {
              // Resumed inside the listener, so space does not also scroll.
              // Panning mid-polygon is how the far corner is reached at all.
              e.preventDefault();
              yield* panning();
            }
            else if (!command && e.code === 'Escape') {
              return abandon();
            }
            else if (command && e.code === 'KeyZ' && !e.shiftKey) {
              e.preventDefault();

              // Back past the first point is back to no polygon at all, and
              // the next Cmd+Z — this key having been let go of — is the
              // document's again.
              if (!unpointed()) return;
            }

            continue;
          }

          const e = next.value;

          // The chrome floating over the canvas is not somewhere to put a
          // corner. The press that started this one was checked the same way.
          if (e.target !== el) continue;

          // A press says nothing until it is known to be a click. A drag while
          // a polygon is being laid down is a click that wandered too far to
          // be one: there is nothing here to select and nothing to move.

          const decided = yield* select({
            drag: pointerDragged({ x: e.clientX, y: e.clientY }, SLOP),
            click: pointerReleased(),
            lost: blurred(),
          });

          if (decided.tag === 'lost') return abandon();
          if (decided.tag === 'drag') continue;

          if (pointed(at(e, true))) return;
        }
      }
      finally {
        release();
      }
    }

    /**
     * Laying down a measuring path, from the first point until it is committed.
     *
     * The pen's gesture with one thing taken out of it: there is nothing to
     * close. A polygon is a ring and is only a polygon once it is one, so the
     * pen ends by meeting its own first point; a walk is a run of legs and is
     * a walk at every length, so it ends when the author says it does. Enter
     * writes it, Escape drops it, and neither is guessed at from where a click
     * happened to land.
     *
     * Escape drops the draft and nothing else. Carrying on with a path that is
     * already in the document leaves that one exactly as it was — the points
     * being added are the draft's until they are committed, which is what
     * makes trying an extra leg out free.
     */
    function* measuring(open: Walk): Op<void> {
      setLocal({ ...local(), laying: open, onPath: null });

      // The same claim the pen makes on Cmd+Z, for the same reason: while a
      // walk is open it takes back a point rather than undoing the document,
      // and the points laid down so far are not in the document to be undone.
      //
      // Enter as well. Nothing else waits on it — going and standing in the
      // level is `\`, which it became so that committing a walk could be the
      // key that means a thing being laid down is finished — and a gesture
      // holding the keys it answers to is how the rest of this works.
      const release = input.claim('KeyZ', 'Enter', 'NumpadEnter');

      try {
        while (true) {
          const next = yield* select({
            key: input.keyDown,
            press: pointerPressed(),

            tracking: pointerMoved(e => {
              const w = local().laying;

              if (w !== null) setLocal({ ...local(), laying: { ...w, at: at(e, true) } });
            }),

            stopped: abandoned,
            lost: blurred(),
          });

          if (next.tag === 'stopped' || next.tag === 'lost') return dropWalk();

          if (next.tag === 'key') {
            const e = next.value;
            const command = e.metaKey || e.ctrlKey;

            if (!command && e.code === 'Space') {
              e.preventDefault();
              yield* panning();
            }
            else if (!command && e.code === 'Escape') {
              return dropWalk();
            }
            else if (!command && (e.code === 'Enter' || e.code === 'NumpadEnter')) {
              return commitWalk();
            }
            else if (command && e.code === 'KeyZ' && !e.shiftKey) {
              e.preventDefault();

              const w = local().laying!;
              const points = w.points.slice(0, -1);

              // Back past the first point is back to no walk at all, and the
              // next Cmd+Z is the document's again.
              if (points.length === 0) return dropWalk();

              setLocal({ ...local(), laying: { ...w, points } });
            }

            continue;
          }

          const e = next.value;

          if (e.target !== el) continue;

          const decided = yield* select({
            drag: pointerDragged({ x: e.clientX, y: e.clientY }, SLOP),
            click: pointerReleased(),
            lost: blurred(),
          });

          if (decided.tag === 'lost') return dropWalk();
          if (decided.tag === 'drag') continue;

          const w = local().laying!;
          const to = at(e, true);

          setLocal({ ...local(), laying: { ...w, points: [...w.points, to], at: to } });
        }
      }
      finally {
        release();
      }
    }

    /** The open walk dropped, wherever it had got to. Whatever it was carrying
     * on with stays in the document as it was. */
    function dropWalk(): void {
      setLocal({ ...local(), laying: null });
    }

    /** The open walk written into the document, under its own id if it had one. */
    function commitWalk(): void {
      const w = local().laying;

      if (w === null) return;

      update(s => marked(
        {
          ...s,
          world: w.id === null
            ? addPath(s.world, w.points).world
            : setPath(s.world, w.id, w.points),
        },
        s.world,
      ));

      dropWalk();
    }

    /** The path point under the cursor, if a click is close enough to be
     * about one. */
    function pathPointAt(e: PointerEvent): OnPath | null {
      return hitPathPoint(world().paths, at(e), HANDLE / view().zoom);
    }

    /**
     * A click read against the paths, and what it did: picking a point, or
     * adding one to a leg.
     *
     * Both tools that touch a path read a click the same way, and this is the
     * whole of what they share. A point beats a leg, because every point lies
     * on two of them; a leg means adding one, because clicking a line is how a
     * point is added to the middle of anything here. What is left over — a
     * click on nothing, and the last point of a path — is the part the two
     * tools answer differently, so it comes back false and each says what it
     * means for itself.
     */
    function pathPicked(e: PointerEvent, resumable: boolean): boolean {
      const reach = HANDLE / view().zoom;
      const on = hitPathPoint(world().paths, at(e), reach);

      if (on !== null) {
        // The one the paths tool carries the walk on from. Left alone here, so
        // that it can.
        const last = on.index === world().paths.get(on.id)!.points.length - 1;

        if (resumable && last) return false;

        // Picking one lets the corners go, the same way picking a corner lets
        // this go: Backspace means one thing, and what it means is whatever
        // the last click was about.
        setLocal({ ...local(), onPath: on });
        update(s => ({ ...s, selection: { ...s.selection, vertices: [] } }));

        return true;
      }

      const leg = hitPathEdge(world().paths, at(e), reach);

      if (leg === null) return false;

      const points = [...world().paths.get(leg.id)!.points];

      points.splice(leg.index + 1, 0, at(e, true));

      update(s => marked({ ...s, world: setPath(s.world, leg.id, points) }, s.world));
      setLocal({ ...local(), onPath: { id: leg.id, index: leg.index + 1 } });

      return true;
    }

    /**
     * A click with the paths tool up, once it is known to be a click.
     *
     * What the shared reading leaves: a click on nothing starts a walk,
     * because that is what a tool that draws does with one, and a click on the
     * last point of a path carries that path on. The second is the one gesture
     * here that has to be learnt — a walk is drawn to be extended, the answer
     * to "and how much further to there", and there is nowhere else to put it.
     */
    function* pathClick(e: PointerEvent): Op<void> {
      if (pathPicked(e, true)) return;

      const here = at(e);
      const on = hitPathPoint(world().paths, here, HANDLE / view().zoom);

      if (on !== null) {
        const path = world().paths.get(on.id)!;

        return yield* measuring({ id: on.id, points: path.points, at: here });
      }

      const first = at(e, true);

      yield* measuring({ id: null, points: [first], at: first });
    }

    /** The picked path point taken out. The path goes with it once there is
     * not enough left to be a walk — see `setPath`. */
    function unpointing(): boolean {
      const on = local().onPath;

      if (on === null) return false;

      removePathPoint(on);

      return true;
    }

    function removePathPoint(on: OnPath): void {
      setLocal({ ...local(), onPath: null });

      update(s => {
        const path = s.world.paths.get(on.id);

        if (path === undefined) return s;

        const points = path.points.filter((_unused, i) => i !== on.index);

        return marked({ ...s, world: setPath(s.world, on.id, points) }, s.world);
      });
    }

    /**
     * One point of a path following the cursor.
     *
     * Its own gesture rather than a share of `draggingVertices`, because a path
     * has no version, no frame and no history to write a transform into: the
     * point is where it is, and moving it is the map with a different number
     * in it. Cancelling puts the world back the way every other gesture does.
     */
    function* draggingPathPoint(on: OnPath): Op<void> {
      const was = world();

      setLocal({ ...local(), onPath: on });
      cursor('move');

      const end = yield* select({
        moving: pointerMoved(e => {
          const to = at(e, true);

          update(s => {
            const path = s.world.paths.get(on.id);

            if (path === undefined) return s;

            const points = path.points.map((p, i) => (i === on.index ? to : p));

            return { ...s, world: setPath(s.world, on.id, points) };
          });
        }),
        panning: alongside(),
        done: pointerReleased(),
        cancel: keyPressed(input, 'Escape'),
        lost: blurred(),
      });

      cursor('');
      update(s => settled(s, was, end.tag === 'cancel'));
    }

    /** The draft dropped, wherever it had got to. */
    function abandon(): void {
      setLocal({ ...local(), draft: null });
    }

    /**
     * Another point, or the ring closed. True when the polygon is finished and
     * the gesture is over.
     */
    function pointed(to: Point): boolean {
      const d = local().draft;

      if (d === null) return true;

      const start = d.points[0];
      const closing = d.points.length >= 3
        && Math.hypot(start.x - to.x, start.y - to.y) * view().zoom <= HANDLE;

      if (!closing) {
        setLocal({ ...local(), draft: { points: [...d.points, to], at: to } });

        return false;
      }

      commit(d.points);
      abandon();

      return true;
    }

    /**
     * The last point taken back. False once there is nothing left to take, and
     * then the draft is over.
     */
    function unpointed(): boolean {
      const d = local().draft;
      const points = d?.points.slice(0, -1) ?? [];

      if (points.length === 0) {
        abandon();

        return false;
      }

      setLocal({ ...local(), draft: { ...d!, points } });

      return true;
    }

    /**
     * A press with the point tool up, once it is known to be a click.
     *
     * The order is the whole design. A corner beats an edge, because every
     * corner lies on two of them and a click there means the corner; an edge
     * beats empty canvas, because clicking a line is how a corner is added; and
     * empty canvas means letting go of what was picked, which is what a click
     * on nothing means everywhere.
     */
    function clicked(e: PointerEvent): void {
      const items = pickable();
      const reach = HANDLE / view().zoom;
      const corner = hitVertex(items, at(e), reach);

      // A path point before a polygon's corner, because a path is drawn over
      // the level and what is on top is what a click on it means. Its legs
      // come after the corners rather than before — see below.
      if (corner === null && pathPointAt(e) !== null && pathPicked(e, false)) return;

      if (corner !== null) {
        // Whatever path point was picked is not any more. One Backspace, and
        // what it takes is whatever the last click was about.
        setLocal({ ...local(), onPath: null });

        update(s => ({
          ...s,
          selection: {
            ...s.selection,
            // Only ever a selection. A press that meant to move this corner
            // became a drag and was dealt with before the button came up; by
            // the time it reaches here the button is already up, and starting a
            // gesture that waits for a release would wait for the next one.
            vertices: e.shiftKey
              ? togglePicked(s.selection.vertices, corner.vertex)
              : [corner.vertex],
          },
        }));

        return;
      }

      // A leg of a path, once the corners have had their say: a corner is a
      // smaller target than a line and missing one because a path happened to
      // be drawn across it would be the corner that could not be picked.
      if (pathPicked(e, false)) return;

      const edge = hitEdge(items, at(e), reach);

      if (edge !== null) {
        const it = items.find(r => r.id === edge.id);

        if (it !== undefined) {
          const v = currentVersion();

          setLocal({ ...local(), onPath: null });

          update(s => {
            const grown = addVertex(s.world, v, it, edge.index, edge.at);

            return marked(
              {
                ...s,
                world: grown.world,
                selection: { ...s.selection, vertices: [grown.vertex] },
              },
              s.world,
            );
          });
        }

        return;
      }

      // Nothing under it: let go of what was picked. Shift means adding, and
      // adding nothing to a selection leaves it alone.
      if (!e.shiftKey) {
        setLocal({ ...local(), onPath: null });
        update(s => ({ ...s, selection: { ...s.selection, vertices: [] } }));
      }
    }

    /**
     * Picking a polygon, and picking the one underneath it.
     *
     * Clicking overlapping polygons has to reach the ones behind somehow, and
     * the approaches divide: Illustrator and Figma put it on a modifier —
     * command-click, again and again, going deeper — while others cycle on
     * repeated clicks. This cycles, because it needs nothing to be discovered
     * and costs nothing where it is not wanted: with one polygon under the
     * cursor the stack is one deep and clicking again lands on the same thing.
     *
     * Where in the stack to go next is read off the selection rather than
     * remembered. Nothing is kept between clicks at all — not where the last
     * one landed, not what was under it — so moving the cursor cannot lose the
     * thread, and neither can anything else that changes the selection. The
     * question each click asks is only ever "is what is picked one of the
     * things under me?", and if it is, the answer is the next one along.
     */
    function picking(e: PointerEvent): void {
      // Over everything, so picked first — the same order they are drawn in,
      // which is the order a click reads them in.
      const on = grabbing(e);

      if (on !== null) {
        pickingArtefact(e, on);
        return;
      }

      const stack = standingIn(world(), e, at(e));

      if (stack.length === 0) {
        // Shift means adding, and adding nothing leaves the selection alone.
        if (!e.shiftKey) {
          update(s => ({
            ...s,
            selection: { ...s.selection, polygons: [], artefacts: [], start: false },
          }));
        }

        return;
      }

      if (e.shiftKey) {
        update(s => ({
          ...s,
          selection: {
            ...s.selection,
            start: false,
            polygons: togglePicked(s.selection.polygons, stack[0]),
          },
        }));

        return;
      }

      update(s => {
        const picked = s.selection.polygons;

        // Standing on exactly one of them: step to the next. Anything else —
        // nothing picked, several picked, or something picked that is not under
        // the cursor — starts at the top of the stack.
        const on = picked.length === 1 ? stack.indexOf(picked[0]) : -1;
        const next = on < 0 ? 0 : (on + 1) % stack.length;

        return {
          ...s,
          selection: { ...s.selection, polygons: [stack[next]], artefacts: [], start: false },
        };
      });
    }

    /**
     * Whether this click is the second of a pair, and remembering it if it is
     * the first.
     *
     * Timed here because a pointer event does not carry a click count:
     * `detail` is the click count on `mousedown` and zero on `pointerdown`,
     * and this loop is built on pointer events so that a press, a drag and a
     * release are one story.
     */
    function twice(e: PointerEvent): boolean {
      const now = performance.now();
      const pair = last !== null
        && now - last.when < DOUBLE_MS
        && Math.hypot(e.clientX - last.at.x, e.clientY - last.at.y) <= SLOP;

      last = pair ? null : { at: { x: e.clientX, y: e.clientY }, when: now };

      return pair;
    }

    /**
     * Double-clicking: into the group under the cursor, or out of the one
     * standing open where there is nothing under it.
     *
     * How to get back out is the part of this that programs disagree about.
     * Illustrator's isolation mode leaves on Escape, on a double-click over
     * empty canvas, and on the back arrow of a breadcrumb bar; Figma has no
     * mode at all and steps up one level on Escape; Unity's prefab mode has
     * only the breadcrumb. What they agree on is that going in is a
     * double-click, so the only real question is the way back.
     *
     * All three of Illustrator's, because they cost nothing together and each
     * covers where the others are awkward: Escape needs no target and always
     * works, the double-click is the gesture's own inverse and is where the
     * hand already is, and the breadcrumb is the only one that says where you
     * are rather than just taking you somewhere. A mode with no visible sign
     * that it is on is the thing that makes isolation hateable, so the bar
     * carries its weight even though it is the least-used way out.
     */
    function entering(e: PointerEvent): void {
      const w = world();
      const path = opened(w, inside());

      // Not `standingIn`: command means "past the group for one click", and
      // going into one is the opposite of that. A double-click is asking for
      // the group whatever else is held down.
      const under = hitting(w, currentVersion(), resolveAt(w, currentVersion()), path, at(e));

      const into = under.find(id => w.groups.has(id));

      if (into !== undefined) {
        // The selection goes: what was picked was the group, and it is not a
        // thing that can be picked any more from in here.
        update(s => ({ ...s, inside: into, selection: { ...s.selection, polygons: [] } }));

        return;
      }

      // Something is under the cursor and it is not a group — a polygon in the
      // group already open, most of the time. There is nowhere further in, and
      // going *out* would be the opposite of what the gesture means: it is
      // asking to get closer to what it is over. The first click has already
      // picked it, so this does nothing.
      if (under.length > 0) return;

      // Empty canvas, so this is the way back: one level out, exactly as
      // Escape.
      leaving();
    }

    /**
     * One level out, and the group left behind picked.
     *
     * Leaving with it selected rather than with nothing selected, because
     * coming out of a group is nearly always followed by doing something to it
     * — and because it puts back what going in took away.
     */
    function leaving(): void {
      update(s => {
        const at = s.inside;

        if (at === null) return { ...s, selection: { ...s.selection, polygons: [] } };

        return {
          ...s,
          inside: parentOf(s.world).get(at) ?? null,
          selection: { ...s.selection, polygons: [at] },
        };
      });
    }

    /**
     * What is under the cursor, as the things a click would move: the outermost
     * still-shut group each one is in, rather than the polygon itself.
     *
     * Grouping is for moving several things as one, so the default has to be
     * the group. Two ways past it, and they are for different things:
     * double-clicking *opens* the group, which is a place to be and lasts —
     * everything in it becomes separately pickable and everything outside it
     * stops being pickable at all — while command-click reaches straight
     * through to the polygon for one click without going anywhere.
     */
    /**
     * The polygons the tools may touch: what is on screen as itself.
     *
     * Corners belong to polygons, and a polygon inside a shut group has none
     * on screen. Without this the point tool would still find the handles it
     * is not drawing, and a click on nothing would move a corner of something
     * a group is standing for. Everything outside the group standing open goes
     * for the same reason, having been put out of reach.
     */
    function pickable(): Resolved[] {
      const w = world();
      const path = opened(w, inside());

      return resolveAt(w, currentVersion())
        .filter(it => !swallowed(w, it.id, path) && reachable(w, it.id, inside()));
    }

    /**
     * What a click at `p` would pick, topmost first.
     *
     * Command reaches straight through to the polygon for one click, and a
     * polygon is tested against its own ring — it is the thing being asked
     * for. Everything else asks `hitting`, which tests a shut group against
     * the one outline it is drawn as.
     */
    function standingIn(w: World, e: MouseEvent, p: Point): Id[] {
      const v = currentVersion();
      const items = resolveAt(w, v);

      if (e.metaKey || e.ctrlKey) {
        return hitPolygons(items, p).filter(id => reachable(w, id, inside()));
      }

      return hitting(w, v, items, opened(w, inside()), p);
    }

    /**
     * The picked polygons dragged along, which is what a hand reaches for
     * before it reaches for a key.
     *
     * `t` still does this from the keyboard and is still the way to do it
     * without having something under the cursor to grab. This is the same
     * translation written the same way — recomputed every move from the layer
     * as it stood when the drag began, so it cannot drift.
     *
     * The step is snapped rather than the position: a polygon has no one point
     * that ought to land on the grid, and snapping any particular corner of it
     * would drag the rest out of whatever alignment they had.
     */
    /**
     * The picked things follow the cursor: polygons, artefacts, the start, or
     * any of them together.
     *
     * One gesture for the two of them because a selection can hold both, and
     * two gestures would have to agree about the step anyway. They read it
     * differently at the end — a polygon's translation is in its own frame and
     * an artefact's move is in the world's — but the step they are agreeing
     * about is the one on screen.
     */
    function* draggingSelection(from: PointerEvent): Op<void> {
      const v = currentVersion();
      const was = world();
      const ids = [...selection().polygons, ...selection().artefacts];
      const grabbed = at(from);

      // The start comes along the same way it does under `t`: its own point
      // written directly, since it is in no version's layer to write an edit
      // into. Alone, because it is picked alone.
      const beginning = selection().start;

      const anchors = starting(was, v, ids);

      if (anchors.size === 0 && !beginning) return;

      const frames = new Map([...anchors.keys()].map(id => [id, under(was, v, id)]));

      cursor('move');
      setLocal({ ...local(), previewing: true });

      const locked = axisLock(() => SLOP / view().zoom);

      const end = yield* select({
        moving: pointerMoved(e => {
          const to = at(e);
          const step = free(e) ? 0 : settings().gridSize;

          const raw = locked(e, { x: to.x - grabbed.x, y: to.y - grabbed.y });
          const dx = step === 0 ? raw.x : toStep(raw.x, step);
          const dy = step === 0 ? raw.y : toStep(raw.y, step);

          update(st => {
            let world = st.world;

            if (beginning) {
              world = movedStart(world, {
                x: was.start.at.x + dx,
                y: was.start.at.y + dy,
              });
            }

            for (const [id, edit] of anchors) {
              // The step as this one's own frame reads it. Snapped in world
              // units, because the grid is on screen and that is where the
              // hand is aiming — then taken back, so a group turned a quarter
              // turn does not send its contents sideways.
              const step = unstep(frames.get(id)!, dx, dy);

              world = withEdit(world, v, id, {
                ...edit,
                transform: {
                  ...edit.transform,
                  translation: {
                    x: edit.transform.translation.x + step.x,
                    y: edit.transform.translation.y + step.y,
                  },
                },
              });
            }

            return { ...st, world };
          });
        }),
        panning: alongside(),
        done: pointerReleased(),
        cancel: keyPressed(input, 'Escape'),
        lost: blurred(),
      });

      setLocal({ ...local(), previewing: false });
      cursor('');
      update(s => settled(s, was, end.tag === 'cancel'));
    }

    /**
     * A gesture over: what it did kept and written into the history, or put
     * back as if it had never run.
     *
     * Cancelling restores rather than undoing. The world it puts back is the
     * one the gesture started from, which is not necessarily the top of the
     * history — an undo taken during a drag would be a strange thing to do and
     * is still not a reason to lose it — and it leaves nothing behind to undo,
     * because from the author's side nothing happened.
     *
     * Blurring is not cancelling. What is on screen when the window goes is
     * what the hand last asked for, and throwing it away because a
     * notification stole the focus loses work that was never in doubt.
     */
    function settled(s: EditorState, was: World, cancelled: boolean): EditorState {
      return cancelled ? { ...s, world: was } : marked(s, was);
    }

    /** The picked corners taken out, or the picked polygons under the other
     * tool. One key, and what it removes is whatever the tool is about. */
    /**
     * The artefact under the cursor, if the click is close enough to one to be
     * about it. Screen units, like the diamond it is aiming at.
     *
     * Only the ones a click can reach, the same rule polygons follow: one
     * inside a shut group is drawn — it has to be, since the group's outline
     * says nothing about it — but picking it is picking the group, and getting
     * at it means going in. `all` asks the other question, which is whether
     * there is anything here at all: putting a second artefact on top of one
     * you cannot see is not what a click on it means either.
     */
    function grabbing(e: PointerEvent, all = false): ArtefactId | null {
      const path = opened(world(), inside());
      const shown = shownAt(world(), currentVersion())
        .filter(it => it.id === START_ID || all || !swallowed(world(), it.id, path));

      return hitArtefact(shown, at(e), HANDLE / view().zoom);
    }

    function removing(): void {
      // A picked path point is what Backspace means under either tool that can
      // pick one, and it is checked first: the paths tool has nothing else to
      // delete, and under the point tool one is only ever picked instead of a
      // corner, never as well as.
      if (unpointing()) return;

      if (tool() === 'path') return;

      update(s => {
        if (tool() === 'artefact') {
          if (s.selection.artefacts.length === 0) return s;

          return marked(
            {
              ...s,
              world: removeArtefacts(s.world, s.selection.artefacts),
              selection: { ...s.selection, artefacts: [] },
            },
            s.world,
          );
        }

        if (tool() === 'point') {
          return marked(
            {
              ...s,
              world: removeVertices(s.world, s.currentVersion, s.selection.vertices),
              selection: { ...s.selection, vertices: [] },
            },
            s.world,
          );
        }

        const world = s.selection.artefacts.length === 0
          ? s.world
          : removeArtefacts(s.world, s.selection.artefacts);

        if (s.selection.polygons.length === 0) {
          return world === s.world
            ? s
            : marked({ ...s, world, selection: { ...s.selection, artefacts: [] } }, s.world);
        }

        // A group goes with what was in it: picking one is picking the rooms
        // under it, and deleting it while they stayed would be a selection
        // that deleted less than it drew.
        // A group goes with what was in it, artefacts included: they are
        // members like anything else, and leaving one behind would leave a key
        // hanging in the air where its room was.
        const gone = new Set(s.selection.polygons.flatMap(id => within(s.world, id)));
        const polygons = new Map(world.polygons);
        const artefacts = new Map(world.artefacts);

        for (const id of gone) {
          polygons.delete(id);
          artefacts.delete(id);
        }

        return marked(
          {
            ...s,
            world: without({ ...world, polygons, artefacts }, gone),
            selection: { ...s.selection, polygons: [], artefacts: [] },
          },
          s.world,
        );
      });
    }

    // -------------------------------------------------------------------------

    return {
      view: canvas(
        {
          style: {
            display: 'block',
            position: 'absolute',
            inset: '0',
            width: '100%',
            height: '100%',
          },

          // Runs before the children below register, so they can count on the element
          ref: (node: HTMLCanvasElement) => {
            el = node;
            ctx = node.getContext('2d');
          },
        },
        [
          effect(() => el && observeSize(el, update)),
          effect(() => el && wheeling(el, update)),
          effect(() => el && noMenu(el)),

          effect(
            () => [
              world(),
              settings(),
              view(),
              tool(),
              selection(),
              inside(),
              currentVersion(),
              replay(),
              bake(),
              local(),
            ] as const,
            ([w, s, v, t, sel, ins, at, r, b, l]) => {
              if (el && ctx) {
                const items = resolveAt(w, at);

                set = live(set, contributing(w, at, items));

                const played = r === null
                  ? null
                  : replayed(b, w, r.from, r.to, r.at);

                const clip = r === null ? null : bounds(w, r.to, ins);

                draw(
                  el,
                  ctx,
                  v,
                  layers(
                    w, s, v, t, sel, ins, at, l, items, runs(set), played, clip,
                    // An artefact flying on its own, with the walls it belongs
                    // to standing still because their span has not been baked
                    // yet, reads as a glitch rather than as a walk.
                    played === null ? null : r,
                  ),
                );
              }
            },
          ),

          // A half-drawn polygon belongs to the pen. Leaving it on screen after
          // switching away would leave it waiting for clicks that now mean
          // something else entirely — so the pen is told, and drops it itself.
          // The same for the figure: a polyline half laid down when the tool
          // is told to draw rectangles is a draft nothing will ever finish.
          effect(figure, f => {
            if (f !== 'polyline' && local().draft !== null) abandoned.emit();
          }),

          effect(tool, t => {
            if (t !== 'create' && local().draft !== null) abandoned.emit();
            if (t !== 'path' && local().laying !== null) abandoned.emit();

            // Only the two tools that can pick a path point have anything to
            // say about one, and one left picked under any other would be
            // taken by the next Backspace, which meant something else.
            if (t !== 'path' && t !== 'point' && local().onPath !== null) {
              setLocal({ ...local(), onPath: null });
            }
          }),
        ],
      ),

      run: function* () {
        while (true) {
          // Nothing here decides anything: it waits for the next thing to
          // happen and hands it to whoever the current tool says owns it.
          const started = yield* select({
            key: input.keyDown,
            press: pointerPressed(),
            lost: blurred(),
          });

          if (started.tag === 'key') {
            const e = started.value;

            // Two clicks with a transform between them are two clicks. The
            // pair is only a pair if nothing happened in the gap.
            last = null;

            // Someone is standing in the level. W and S are theirs, and a
            // scale started under a full-window 3D view would be invisible.
            if (roaming()) continue;

            // Everything with a command key on it belongs to the shortcuts in
            // `editor.ts`. Without this, Cmd+S would save and start a scale,
            // and Cmd+V would paste and switch tools.
            if (e.metaKey || e.ctrlKey) continue;

            if (e.code === 'Space') {
              // Resumed inside the listener, so space does not also scroll
              e.preventDefault();
              yield* panning();
            }
            else if (e.code === 'Escape') {
              // A draft would have taken this already — it owns the keyboard
              // while it runs. What is left is stepping out of a group, and
              // then letting the selection go: each smaller than the last, so
              // Escape held down unwinds to the top level and stops there.
              leaving();
            }
            else if (REMOVE.includes(e.code)) {
              removing();
            }
            // Erosion is the one transform the point tool has a use for: a
            // depth on picked corners is a corner's gesture, and the corners
            // are only pickable under this tool. Every other transform is
            // about where a whole thing is and stays where it was.
            else if (tool() === 'point' && e.code === 'KeyE'
              && selection().vertices.length > 0) {
              yield* transforming(e.code, TRANSFORMS[e.code]);
            }
            else if (tool() === 'polygon') {
              const mode = TRANSFORMS[e.code];

              if (mode !== undefined) {
                yield* transforming(e.code, mode);
              }
              else if (e.code === 'Digit1') {
                retype('level');
              }
              else if (e.code === 'Digit2') {
                retype('solid');
              }
              else if (e.code === 'Digit3') {
                retype('floor');
              }
            }
            else if (tool() === 'artefact') {
              const n = Number(e.code.match(/^Digit([1-9])$/)?.[1] ?? NaN);

              if (n >= 1 && n <= ARTEFACTS.length) retypeArtefact(ARTEFACTS[n - 1]);
            }
            else if (tool() === 'create') {
              // The same digits the other two tools use for the same kind of
              // question, in the order the buttons are drawn in.
              const n = Number(e.code.match(/^Digit([1-9])$/)?.[1] ?? NaN);

              if (n >= 1 && n <= FIGURES.length) {
                update(s => ({ ...s, figure: FIGURES[n - 1] }));
              }
            }
          }
          else if (started.tag === 'press' && started.value.target === el) {
            const e = started.value;

            // A press says nothing on its own. Moving makes it a drag, which is
            // always a marquee over empty canvas and a move over a handle;
            // letting go without moving makes it a click, which is where every
            // tool's own meaning lives. Deciding here rather than in each tool
            // is what makes `just dragging` mean one thing everywhere.
            const decided = yield* select({
              drag: pointerDragged({ x: e.clientX, y: e.clientY }, SLOP),
              click: pointerReleased(),
              lost: blurred(),
            });

            if (decided.tag === 'lost') continue;

            if (decided.tag === 'drag') {
              last = null;

              // A drag that started on something is that thing being moved: a
              // corner under the point tool, a polygon under the polygon one.
              // Anywhere else it is a marquee.
              // A rectangle and an n-gon are one drag each: the whole of what
              // they are is where it started and where it got to. The polyline
              // is the odd one out and takes clicks, which is why it is the
              // one that owns the click branch below.
              if (tool() === 'create') {
                if (figure() === 'rect') yield* rectangling(e);
                else if (figure() === 'ngon') yield* ngoning(e);

                continue;
              }

              if (tool() === 'point' || tool() === 'path') {
                // A path point before a corner, the same way a click reads
                // them: what is drawn on top is what the hand is aiming at.
                const on = pathPointAt(e);

                if (on !== null) {
                  yield* draggingPathPoint(on);
                  continue;
                }
              }

              if (tool() === 'point') {
                const grab = hitVertex(
                  pickable(),
                  at(e),
                  HANDLE / view().zoom,
                );

                if (grab !== null) {
                  const picked = selection().vertices.includes(grab.vertex)
                    ? selection().vertices
                    : [grab.vertex];

                  setLocal({ ...local(), onPath: null });
                  update(s => ({ ...s, selection: { ...s.selection, vertices: picked } }));
                  yield* draggingVertices(grab.vertex, picked);
                  continue;
                }
              }
              else if (tool() === 'artefact' || tool() === 'polygon') {
                // Artefacts first under both tools, because they are drawn over
                // everything and a handle you can see is a handle you can grab.
                const grab = grabbing(e);

                if (grab !== null) {
                  // Grabbing one already picked drags the whole selection,
                  // polygons included. Grabbing one that is not takes it alone,
                  // the way grabbing an unpicked polygon does.
                  // The start alone, since it is picked alone — see
                  // `pickingArtefact`.
                  if (grab === START_ID) {
                    if (!selection().start) {
                      update(s => ({ ...s, selection: { ...EMPTY_SELECTION, start: true } }));
                    }
                  }
                  else if (!selection().artefacts.includes(grab)) {
                    update(s => ({
                      ...s,
                      selection: { ...s.selection, polygons: [], artefacts: [grab], start: false },
                    }));
                  }

                  yield* draggingSelection(e);
                  continue;
                }
              }

              if (tool() === 'polygon') {
                const under = standingIn(world(), e, at(e));

                if (under.length > 0) {
                  // Anything picked under the cursor means the drag is that
                  // selection moving, and the whole of it comes along. It has
                  // to be any of them rather than the topmost: having just
                  // clicked down through a stack to reach the one underneath,
                  // grabbing it would otherwise hand the drag straight back to
                  // the one on top and undo the reaching.
                  if (!under.some(id => selection().polygons.includes(id))) {
                    update(s => ({
                      ...s,
                      selection: {
                        ...s.selection,
                        polygons: [under[0]],
                        artefacts: [],
                        start: false,
                      },
                    }));
                  }

                  yield* draggingSelection(e);
                  continue;
                }
              }

              yield* marqueeing(e, e.shiftKey);
            }
            else if (tool() === 'point') {
              // Going in and out of a group is about where you are, not about
              // what you are editing. Corners belong to polygons, and reaching
              // the ones inside a group needs the same way in from here as it
              // does from the other tool.
              if (twice(e)) entering(e);
              else clicked(e);
            }
            else if (tool() === 'polygon') {
              // The first of the pair has already picked, and going in drops
              // that selection again — which is what going in means anyway.
              if (twice(e)) entering(e);
              else picking(e);
            }
            else if (tool() === 'create' && figure() === 'polyline') {
              yield* drawing(e);
            }
            else if (tool() === 'path') {
              yield* pathClick(e);
            }
            else if (tool() === 'artefact') {
              const on = grabbing(e);

              // A click on nothing puts one there; a click on one is about
              // that one, and never a second stacked on top of it. There is no
              // draft to abandon and nothing to step into, so those are the
              // whole of what a click here can mean.
              if (on !== null) pickingArtefact(e, on);
              else if (!e.shiftKey && grabbing(e, true) === null) placing(e);
            }
          }
        }
      },
    };
  });
}

// -----------------------------------------------------------------------------
// What a gesture leaves on screen while it runs
// -----------------------------------------------------------------------------

/** In world units, so it stays over what it was drawn over. */
interface Marquee {
  a: Point
  b: Point
}

/** The points laid down so far, and where the rubber band currently ends. */
interface Draft {
  points: Point[]
  at: Point
}

/**
 * A shape being dragged out, and what it currently comes to.
 *
 * The label is not decoration. Both of these gestures read something off an
 * axis that has nothing on it to read against — how many sides, how far across
 * — and a number by the cursor is the whole of what says which of them the
 * hand is moving.
 */
interface Forming {
  ring: Ring
  label: string
}

/**
 * A measuring path being laid down.
 *
 * `id` is the path it will be written back to, which is null for a new one and
 * set when an existing one is being carried on with — resuming is the same
 * gesture, started from the points that are already there.
 */
interface Walk {
  id: PathId | null
  points: Point[]
  at: Point
}

interface Local {
  marquee: Marquee | null
  draft: Draft | null
  /** The open measuring path, if one is being laid down. */
  laying: Walk | null
  /** The rectangle or n-gon under the cursor mid-drag, before it is committed.
   * A ring rather than a shape: what is being drawn is one outline. */
  forming: Forming | null
  /** The picked point of a committed path, which is what Backspace takes. Not
   * in the document's selection: a path is not part of the level, and nothing
   * else in the editor has anything to say about one. */
  onPath: OnPath | null
  /**
   * A gesture is running, so the versions downstream of this one are drawn
   * whatever their eyes say.
   *
   * This is load-bearing rather than a nicety: it is the entire mechanism by
   * which an edit made at v0 can be judged against its effect at v4, and it is
   * what makes dropping backward propagation affordable.
   */
  previewing: boolean
}

const EMPTY_LOCAL: Local = {
  marquee: null,
  draft: null,
  laying: null,
  forming: null,
  onPath: null,
  previewing: false,
};

// -----------------------------------------------------------------------------
// The modal transforms
// -----------------------------------------------------------------------------

/** `was` is the transform as it stood when the key went down, so that every
 * move recomputes from there rather than from the last frame. */
type Mode = (was: Transform, drag: Aimed) => Transform;

/** The gesture as the transforms read it, in the frame of whatever is being
 * transformed. */
interface Aimed {
  pivot: Point
  /** Where the cursor was when the key went down, and where it is taken to be
   * now — already held to an axis, a five-degree step or a cell of depth,
   * whichever this gesture snaps to. */
  from: Point
  to: Point
  /** Whether Alt is held, which is a different reading of the same drag rather
   * than a constraint on it: a scale that was two factors becomes one. */
  alt: boolean
  /** What a scale multiplies by, per axis, out of the length of the drag
   * rather than out of these points. See `scaling`. */
  factor: Point
}

/** Screen pixels of drag that double a scale, or halve it going the other way.
 * About a thumb's width of trackpad. */
const DOUBLING = 150;

/** What a scale's factor lands on. */
const STEP = 1 / 8;

/**
 * The same transform, turned by `angle` about `pivot`.
 *
 * A rotation composes on the outside — turn the polygon, then carry its
 * translation round the pivot — and the family is closed under that, since a
 * rotation of a rotation is a rotation and the leftover is a translation.
 * Because a transform is about the world origin this is just the composition
 * written out, and one pivot serves the whole selection.
 */
function turned(t: Transform, pivot: Point, angle: number): Transform {
  const c = Math.cos(angle), s = Math.sin(angle);
  const dx = t.translation.x - pivot.x, dy = t.translation.y - pivot.y;

  return {
    ...t,
    rotation: t.rotation + angle,
    translation: {
      x: pivot.x + dx * c - dy * s,
      y: pivot.y + dx * s + dy * c,
    },
  };
}

/**
 * The same transform, scaled per axis with `pivot` held still.
 *
 * A squash has to go *inside* the rotation. Composed on the outside it would be
 * a shear the moment the polygon is turned — rotate, squash, rotate again is
 * not a rotation and a scale — and this family cannot say a shear, deliberately:
 * the components stay separate so that the morph can interpolate rotation
 * angularly rather than slewing a matrix through a shear on the way.
 *
 * So the factor multiplies the transform's own per-axis scale, which squashes
 * along the polygon's own axes, and the translation takes up whatever that did
 * to the pivot. Written out, `T' = pivot - R·F·R⁻¹·(pivot - T)`, which stays in
 * the family because a translation is free.
 */
function squashed(t: Transform, pivot: Point, fx: number, fy: number): Transform {
  const c = Math.cos(t.rotation), s = Math.sin(t.rotation);
  const dx = pivot.x - t.translation.x, dy = pivot.y - t.translation.y;

  const ux = (dx * c + dy * s) * fx;
  const uy = (-dx * s + dy * c) * fy;

  return {
    ...t,
    scale: { x: t.scale.x * fx, y: t.scale.y * fy },
    translation: {
      x: pivot.x - (ux * c - uy * s),
      y: pivot.y - (ux * s + uy * c),
    },
  };
}

/** How far the cursor is from the pivot now against where it started, as a
 * factor. Nothing is scaled by a gesture that started on the pivot, and a zero
 * axis is refused: it is not invertible. */
/**
 * `to` turned about the pivot so that the angle it makes with `from` is a
 * whole number of `step`s.
 *
 * Done to the point rather than to the angle inside the rotation, so that the
 * one rule about where the cursor is taken to be covers this too and the
 * transforms themselves stay the plain readings they are.
 */
function turnedAbout(pivot: Point, from: Point, to: Point, step: number): Point {
  const was = Math.atan2(from.y - pivot.y, from.x - pivot.x);
  const now = Math.atan2(to.y - pivot.y, to.x - pivot.x);
  const angle = was + toStep(now - was, step);
  const reach = Math.hypot(to.x - pivot.x, to.y - pivot.y);

  return { x: pivot.x + reach * Math.cos(angle), y: pivot.y + reach * Math.sin(angle) };
}

/** How far a drag has gone round a pivot, in radians. What a rotation turns
 * by, said on its own for the one thing that is a direction rather than a
 * transform. */
function about(pivot: Point, from: Point, to: Point): number {
  return Math.atan2(to.y - pivot.y, to.x - pivot.x)
    - Math.atan2(from.y - pivot.y, from.x - pivot.x);
}

/** What a turn lands on: five degrees, which is 72 of them round the circle
 * and fine enough to aim anything with. */
const TURN = Math.PI / 36;

/** What a turn lands on with Alt held: the eighth of a circle, which is the
 * only angle most of a level is ever turned by. */
const EIGHTH = Math.PI / 4;

const TRANSFORMS: Record<string, Mode> = {
  KeyT: (t, { from, to }) => ({
    ...t,
    translation: {
      x: t.translation.x + to.x - from.x,
      y: t.translation.y + to.y - from.y,
    },
  }),

  KeyR: (t, { pivot, from, to }) => turned(t, pivot, about(pivot, from, to)),

  /** Both axes, each from its own share of the drag — one factor for both
   * where Alt has already made them one. Where the factors come from is
   * `scaling`, which is where the whole of the feel of this lives. */
  KeyS: (t, { pivot, factor }) => squashed(t, pivot, factor.x, factor.y),

  // One axis and nothing else, whatever the drag does on the other. `s` reads
  // both, so these are how one of them is said on its own without having to
  // hold the hand still.
  KeyX: (t, { pivot, factor }) => squashed(t, pivot, factor.x, 1),
  KeyY: (t, { pivot, factor }) => squashed(t, pivot, 1, factor.y),

  KeyE: (t, { from, to }) => ({
    ...t,
    erosion: t.erosion + to.y - from.y,
  }),
};

// -----------------------------------------------------------------------------

/**
 * The wheel zooms, about the cursor.
 *
 * Not passive, because it has to take the page's own zoom and scroll away from
 * it: a trackpad pinch arrives here as a wheel event with the command flag set,
 * and left alone the browser would scale the whole editor instead of the
 * drawing in it.
 *
 * The exponent is what makes it feel even. A zoom is a multiplication, so a
 * notch has to be a factor rather than an amount — the same notch takes you
 * from 1 to 1.1 and from 10 to 11 — and reading the delta through `exp` is
 * that, with the sign and the size of the notch coming out of it for free.
 * Line-mode deltas are counted in lines and pixel-mode ones in pixels, which
 * is a factor of about sixteen between two wheels that meant the same thing.
 */
function wheeling(el: HTMLCanvasElement, update: Update): () => void {
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();

    const box = el.getBoundingClientRect();
    const lines = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
    const by = Math.exp(-e.deltaY * lines * WHEEL);

    update(s => ({
      ...s,
      view: zoomedAt(s.view, by, { x: e.clientX - box.left, y: e.clientY - box.top }),
    }));
  };

  el.addEventListener('wheel', onWheel, { passive: false });

  return () => el.removeEventListener('wheel', onWheel);
}

/**
 * Alt holds a move to one axis: the one the hand had gone furthest along when
 * the key was first seen.
 *
 * Decided from the drag rather than from the cursor's position at the moment
 * of the press, because at the moment of the press it has gone nowhere and
 * there is nothing to read. So the answer is deferred until the hand has said
 * something — under `slop` of movement it is still not asking for either axis
 * — and then it is kept, so that wandering off the line does not swap the
 * gesture out from under itself.
 *
 * Letting Alt go forgets it. Holding it again asks the question again, which
 * is how a move locked to the wrong axis is fixed without starting over.
 */
function axisLock(slop: () => number): (e: { altKey: boolean }, d: Point) => Point {
  let axis: 'x' | 'y' | null = null;

  return (e, d) => {
    if (!e.altKey) {
      axis = null;

      return d;
    }

    if (axis === null) {
      const reach = slop();

      if (Math.abs(d.x) < reach && Math.abs(d.y) < reach) return d;

      axis = Math.abs(d.x) >= Math.abs(d.y) ? 'x' : 'y';
    }

    return axis === 'x' ? { x: d.x, y: 0 } : { x: 0, y: d.y };
  };
}

/** Screen pixels of upward drag that add a side to an n-gon. */
const PER_SIDE = 22;

/** How much of a zoom one pixel of wheel is worth, as an exponent. A notch of
 * a mouse wheel is about 100 of them, which comes to a fifth either way. */
const WHEEL = 0.002;

/**
 * No context menu over the canvas.
 *
 * Ctrl is the key that frees a gesture from the grid, and on a Mac Ctrl and
 * the button together are a right click: without this, the one modifier every
 * transform reads would open a menu over the drawing halfway through the drag.
 * There is nothing on that menu this editor puts there anyway.
 */
function noMenu(el: HTMLCanvasElement): () => void {
  const onMenu = (e: MouseEvent): void => e.preventDefault();

  el.addEventListener('contextmenu', onMenu);

  return () => el.removeEventListener('contextmenu', onMenu);
}

/** How big the canvas got is an update like any other, so the draw wakes for it. */
function observeSize(el: HTMLCanvasElement, update: Update): () => void {
  const observer = new ResizeObserver(() => {
    const width = el.clientWidth;
    const height = el.clientHeight;
    const dpr = window.devicePixelRatio || 1;

    update(s => {
      if (s.view.width === width && s.view.height === height && s.view.dpr === dpr) {
        return s;
      }

      return { ...s, view: resized(s.view, width, height, dpr) };
    });
  });

  observer.observe(el);

  return () => observer.disconnect();
}

// -----------------------------------------------------------------------------
// Drawing
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

function draw(
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
function layers(
  world: World,
  settings: Settings,
  view: View,
  tool: Tool,
  selection: Selection,
  inside: GroupId | null,
  current: VersionId,
  local: Local,
  items: Resolved[],
  outline: Point[][],
  played: Frame | null,
  /** Where each shut group stands at the version the replay is walking
   * towards, from `occupying`. Null when nothing is playing. */
  clip: Map<GroupId, Shape> | null,
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
    const stroke = ghostColour(k - current);

    out.push(ctx => ghosts(ctx, view, world, k, shown, stroke));
  }

  // A shut group is one shape, and its members are not on screen at all: the
  // whole of what grouping does to the eye is take several outlines away and
  // leave one. What is left here is everything a shut group is not drawing for.
  const loose = items.filter(it => !swallowed(world, it.id, path));

  const reach = (id: Id) => reachable(world, id, inside);

  out.push(ctx => polygons(ctx, view, loose, selection, reached, tool === 'point', reach));
  const shut = occupying(world, current, items, path);
  const picking = new Set<Id>(selection.polygons);

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
    out.push(ctx => polygons(ctx, view, singled, selection, reached, false, () => true));
  }

  out.push(ctx => outlines(ctx, view, outline));

  // Over the editor's own answer, so the two can be read against each other:
  // where they agree the thin line sits inside the thick one, and where the
  // bake is part way between two versions it is visibly somewhere else.
  /**
   * What an animated floor is drawn inside, or null for one belonging to no
   * group.
   *
   * The innermost enclosing group that has an answer: `occupying` folds a shut
   * group's members into the outermost shut one, so at most one of the chain is
   * in there and finding it from the inside out finds it.
   */
  const inner = (id: Id): Shape | null => {
    if (clip === null) return null;

    for (const g of enclosing(world, id)) {
      const shape = clip.get(g);

      if (shape !== undefined) return shape;
    }

    return null;
  };

  if (played !== null) out.push(ctx => replay(ctx, view, played, inner));

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
    walk === null
      ? shownAt(world, current)
      : [startPlaced(world), ...artefactsDuring(world, walk.from, walk.to, walk.at)],
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
  out.push(ctx => measures(ctx, view, world.paths, local.laying?.id ?? null, local.onPath));

  if (local.laying !== null) out.push(ctx => laying(ctx, view, local.laying!));

  if (local.forming !== null) out.push(ctx => formed(ctx, view, local.forming!));
  if (local.draft !== null) out.push(ctx => draft(ctx, view, local.draft!));
  if (local.marquee !== null) out.push(ctx => marquee(ctx, view, local.marquee!));

  return out;
}

/**
 * Which other versions draw as ghosts. The eyes are only the resting state:
 * while a gesture runs, everything downstream fades in whatever they say, since
 * that is the whole point of editing an early version and watching a late one.
 */
function ghostVersions(world: World, current: VersionId, previewing: boolean): VersionId[] {
  const out: VersionId[] = [];

  for (let k = 0; k < world.versions.length; k++) {
    if (k !== current && (world.versions[k].visible || (previewing && k > current))) {
      out.push(k);
    }
  }

  return out;
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
  v: VersionId,
  items: Resolved[],
  stroke: string,
): void {
  ctx.beginPath();

  for (const it of items) {
    if (swallowed(world, it.id, [])) continue;

    for (const ring of it.shape) {
      trace(ctx, view, ring);
    }
  }

  for (const g of occupying(world, v, items, [])) {
    for (const ring of g.shape) {
      trace(ctx, view, ring);
    }
  }

  // The outline only, and no label: a ghost says where something was, and
  // seven kinds written twice over is not that. Into the same path as the
  // rings, so one stroke draws the whole of what this version was.
  for (const it of artefactsAt(world, v)) icon(ctx, toScreen(view, it.at), it);

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
  selection: Selection,
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

    if ((it.erosion !== 0 || it.depths !== null) && here && (picked || handles)) {
      ctx.beginPath();
      trace(ctx, view, it.source);

      ctx.strokeStyle = theme.source;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);

      if (picked) leaders(ctx, view, it);
    }

    outlined(ctx, view, it.shape, it.polygon.type, picked, here, theme.pickedFill);
  }

  if (!handles) return;

  // Two passes rather than one, so that each colour is a single fill: which
  // corners are picked is the only thing the point tool is about, and a hollow
  // square against a solid one says it at any zoom.
  const corners = new Set(selection.vertices);

  for (const picked of [false, true]) {
    ctx.beginPath();

    for (const it of items) {
      if (!reach(it.id)) continue;

      it.source.forEach((p, i) => {
        if (corners.has(it.corners[i].id) !== picked) return;

        const s = toScreen(view, p);
        ctx.rect(Math.round(s.x) - 2.5, Math.round(s.y) - 2.5, 5, 5);
      });
    }

    ctx.fillStyle = picked ? theme.picked : theme.vertex;
    ctx.fill();
  }
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
  ctx.save();
  between(ctx, view, [it.source], it.shape);
  spokes(ctx, view, it.source, erodedCorners(it.source, it.depths ?? it.erosion));
  ctx.restore();
}

/**
 * Clipped to the ground between the two boundaries: the leader stops where the
 * projection starts.
 *
 * A corner the erosion consumed has nowhere on the outline to land, and its
 * moved point is somewhere in the middle of what is left — so the line to it
 * runs straight through the eroded shape and out across the interior, which
 * reads as a stray line rather than as a corner that died. Cut at the outline
 * it is a tick against the boundary, and the whole picture is then the same
 * one at every corner: a spoke across the ground the erosion took.
 *
 * The clip rather than a trim per line, because the trim is an intersection
 * per corner against every wall of the projection and this is one path the
 * canvas was going to rasterise anyway. Even-odd over both boundaries, so it
 * is the ground between them whichever way round they are: a corner pushed
 * out sits in the annulus too, with the source ring as the inner edge of it.
 */
function between(ctx: CanvasRenderingContext2D, view: View, a: Shape, b: Shape): void {
  ctx.beginPath();

  for (const ring of a) trace(ctx, view, ring);
  for (const ring of b) trace(ctx, view, ring);

  ctx.clip('evenodd');
}

/** One ring's corners joined to where they went, corner for corner. */
function spokes(
  ctx: CanvasRenderingContext2D,
  view: View,
  ring: Ring,
  moved: readonly Point[],
): void {
  ctx.beginPath();

  ring.forEach((p, i) => {
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

/** A group's boundary before its own erosion, and the depth that moved it. */
interface Moved {
  shape: Shape
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
 * The depth is the one the group's own side was offset by, sign and all. A
 * group's walls go the other way from its rooms — `erode(A - B, d)` is
 * `erode(A, d) - erode(B, -d)`, which is what makes a pillar keep its distance
 * from a shrinking room — so a group drawn as its walls has its corners moving
 * out where a room's move in, and a leader that ignored that would point the
 * wrong way at every corner of it. See `contributed`.
 */
function moved(
  world: World,
  v: VersionId,
  items: readonly Resolved[],
  path: readonly GroupId[],
  shut: readonly Occupied[],
  picking: ReadonlySet<Id>,
): ReadonlyMap<GroupId, Moved> {
  const out = new Map<GroupId, Moved>();
  const depth = depths(world, v);

  const wanted = shut.filter(g => picking.has(g.id) && (depth.get(g.id) ?? 0) !== 0);

  if (wanted.length === 0) return out;

  const was = new Map(occupyingSource(world, v, items, path).map(g => [g.id, g.shape]));

  for (const g of wanted) {
    const d = depth.get(g.id) ?? 0;
    const shape = was.get(g.id);

    if (shape !== undefined) out.set(g.id, { shape, depth: g.kind === 'solid' ? -d : d });
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

    outlined(ctx, view, g.shape, g.kind, picking.has(g.id), here, theme.groupFill);

    const was = sources.get(g.id);

    if (was !== undefined) {
      ctx.save();
      between(ctx, view, was.shape, g.shape);

      const to = erodedShape(was.shape, was.depth);

      was.shape.forEach((ring, i) => spokes(ctx, view, ring, to[i]));
      ctx.restore();
    }

    // Drawn as the floor it is, and never as picked: the group's own outline
    // has already said that, and saying it twice puts a second heavy line
    // inside the first. The edge is here because the stipple needs one — a
    // pattern with nothing to stop it frays wherever the shape ends.
    //
    // Clipped rather than cut: a floor is drawn inside the group and the group
    // has just drawn its own outline along every edge the cut would follow, so
    // the boolean that used to work that boundary out was paying to redraw a
    // line already on screen. It cost the line underneath, too — the floor's
    // own 0.5 stroke ran back over a picked group's heavy one wherever the two
    // agreed, and a clipped edge has no stroke to do it with.
    if (g.floor.length !== 0) {
      ctx.save();
      ctx.beginPath();

      for (const ring of g.shape) trace(ctx, view, ring);

      ctx.clip('evenodd');
      outlined(ctx, view, g.floor, 'floor', false, here, theme.groupFill);
      ctx.restore();
    }
  }
}

/**
 * What each kind is painted with, in screen space and built once.
 *
 * A stroke can only say one thing at a time, and it is already saying whether
 * a shape is picked and whether it can be reached at all. So the kind is said
 * by the fill instead: a solid is hatched because it is material taken away,
 * a floor is dotted because it is not in the set at all, and a room is left
 * plain because it is the ordinary case. Every kind then strokes alike.
 *
 * Texture rather than geometry, so it does not zoom with the level: a pattern
 * the view's transform stretched would go from hatching to stripes on the way
 * in, and the whole point of it is to look the same everywhere.
 */
const patterns = new Map<PolygonType, CanvasPattern | null>();

function patterned(kind: PolygonType): CanvasPattern | null {
  const known = patterns.get(kind);

  if (known !== undefined) return known;

  const step = 6;
  const tile = document.createElement('canvas');

  tile.width = step;
  tile.height = step;

  const on = tile.getContext('2d');

  if (on === null) {
    patterns.set(kind, null);

    return null;
  }

  if (kind === 'solid') {
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
  else {
    // One dot a tile, in the middle of it, so nothing lands on a seam and the
    // grid stays even however the pattern falls on the shape.
    on.fillStyle = theme.floorDots;
    on.beginPath();
    on.arc(step / 2, step / 2, 1, 0, 2 * Math.PI);
    on.fill();
  }

  const made = on.createPattern(tile, 'repeat');

  patterns.set(kind, made);

  return made;
}

/** Fills `shape` with what its kind is painted with, if its kind is painted
 * with anything. The path is the caller's: it is traced once and used for the
 * fill, the picked fill over it and the stroke over that. */
function shaded(ctx: CanvasRenderingContext2D, kind: PolygonType): void {
  if (kind === 'level') return;

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
  kind: PolygonType,
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

  if (here) shaded(ctx, kind);

  if (picked && here) {
    ctx.fillStyle = fill;
    ctx.fill();
  }

  // The same line for every kind: the fill says which kind it is, and the
  // stroke is left free to say the two things only it can — whether this is
  // picked, and whether it can be reached at all.
  ctx.strokeStyle = !here ? theme.outside : picked ? theme.picked : theme.level;
  ctx.lineWidth = picked ? 2 : 0.5;
  ctx.stroke();
}

/** The set the game would see, over the top and in the one colour that says so. */
function outlines(ctx: CanvasRenderingContext2D, view: View, runs: Point[][]): void {
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

  ctx.strokeStyle = theme.csg;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.stroke();
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
 * Two lines, because there are two kinds of run and they mean different things.
 * The set is thinner and brighter than the editor's own answer sitting under
 * it, so the two can be told apart where they differ. A floor is in no set: it
 * gets the line an unselected floor gets standing still, so that a moving one
 * reads as the same shape it was drawn as rather than as a piece of outline in
 * the one colour that means outline.
 *
 * A floor in a group is clipped to where that group's level reaches at the
 * version being walked towards — which is already on screen, still, the whole
 * time the walk plays. A floor sliding or turning inside its group has no
 * reason to stay inside the walls it belongs to, and one that leaves them
 * reads as floor laid down outside the room. Clipping is what the still
 * drawing already does with `Occupied.floor`, so this is the moving version of
 * an answer the canvas gives everywhere else.
 *
 * Against the destination rather than against the instant: the instant's own
 * level is not a shape the replay has — it is runs, in pieces, and putting them
 * back together is the boolean the bake exists to avoid. The cost is that a
 * floor is cut against where its room ends up rather than where the room is,
 * so at the start of a long walk it is clipped by walls that have not arrived.
 * It grows into place, which reads as a floor being laid rather than as one
 * poking out, and the destination is the frame both of them are heading for.
 *
 * The same shape the group is drawn as, pillars and all: a replay draws no
 * pillar inside a shut group either, so a floor stippled across the hole one
 * leaves would say there is floor where a click falls straight through.
 */
function replay(
  ctx: CanvasRenderingContext2D,
  view: View,
  frame: Frame,
  /** What an animated floor is drawn inside, by polygon. */
  inner: (id: Id) => Shape | null,
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
  //
  // Grouped by what they are clipped to rather than drawn one at a time, so
  // that a group's floors are one path under one clip: several floors in a
  // room is the ordinary case, and the clip is the same shape for all of them.
  const loose: Frame = [];
  const inside = new Map<Shape, Frame>();

  for (const run of frame) {
    if (!run.fill) continue;

    const shape = inner(run.id);

    if (shape === null || shape.length === 0) {
      loose.push(run);
      continue;
    }

    const mine = inside.get(shape) ?? [];

    mine.push(run);
    inside.set(shape, mine);
  }

  stroke(loose, theme.level, 0.5);

  for (const [shape, runs] of inside) {
    ctx.save();
    ctx.beginPath();

    for (const ring of shape) {
      ring.forEach((p, i) => {
        const q = toScreen(view, p);

        if (i === 0) ctx.moveTo(q.x, q.y);
        else ctx.lineTo(q.x, q.y);
      });

      ctx.closePath();
    }

    // Even-odd, because a shape's holes are rings like any other and the
    // winding they were built with is not something to lean on here.
    ctx.clip('evenodd');
    stroke(runs, theme.level, 0.5);
    ctx.restore();
  }

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
  paths: ReadonlyMap<PathId, Path>,
  /** The one being carried on with, drawn by the gesture instead. */
  open: PathId | null,
  picked: OnPath | null,
): void {
  for (const [id, it] of paths) {
    if (id === open) continue;

    tape(ctx, view, it.points, null, picked?.id === id ? picked.index : null);
  }
}

/** The path being laid down: what is there, and the leg the cursor is on the
 * end of. */
function laying(ctx: CanvasRenderingContext2D, view: View, w: Walk): void {
  tape(ctx, view, w.points, w.at, null);
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
): void {
  if (points.length === 0) return;

  const screen = points.map(p => toScreen(view, p));
  const times = timings(to === null ? points : [...points, to]);

  ctx.beginPath();
  screen.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));

  ctx.strokeStyle = theme.path;
  ctx.lineWidth = 1.5;
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
  ctx.fillStyle = theme.path;
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
