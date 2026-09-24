import { draw, layers } from './draw';
import { EMPTY_LOCAL, Forming, Local, Walk } from './local';
import { DOUBLE_MS, HANDLE, REMOVE, SLOP } from './metrics';
import { Value } from '@incpt/kontinuum';
import { VNode, effect } from '@incpt/kontinuum-dom';
import { canvas } from '@incpt/kontinuum-dom/html';
import { Op, Signal, select, signal } from '@incpt/kontinuum-interaction';
import { interactive } from '@incpt/kontinuum-interaction/dom';

import { Bake, replayed } from '../bake';
import { ngon } from '../geometry';
import {
  Input,
  blurred,
  keyPressed,
  keyReleased,
  pan,
  pointerDragged,
  pointerMoved,
  keyHeard,
  keyOwned,
  pointerOver,
  pressedAway,
  pressedOn,
  pointerReleased,
} from '../input';
import {
  withinBox,
  EMPTY_LIVE,
  Live,
  Resolved,
  addPolygon,
  floorRuns,
  landing,
  addVertex,
  middle,
  order,
  hitEdge,
  hitPolygons,
  hitting,
  hitVertex,
  contributing,
  painted,
  moveOf,
  turnOf,
  scaleOf,
  Painted,
  owning,
  under,
  place,
  START_ID,
  GHOST_ID,
  eyePlaced,
  addArtefact,
  artefactsAt,
  artefactsIn,
  artefactsWithinBox,
  Laid,
  pathsAt,
  pathsIn,
  hitArtefact,
  movedStart,
  Handle,
  handles,
  outlining,
  removeAt,
  retypeArtefacts,
  retypable,
  retypedPolygons,
  shownAt,
  turnedStart,
  swallowed,
  reachable,
  reaching,
  live,
  placeVertex,
  polygonsIn,
  removeVertices,
  resolveAt,
  scaleAt,
  runs,
  verticesWithinBox,
  editedAt,
  keysOfAt,
  standingOn,
  writtenInto,
} from '../scene';
import {
  OnPath,
  addPath,
  hitPath,
  hitPathEdge,
  hitPathPoint,
  inFrame,
  pathsWithinBox,
  setPath,
} from '../paths';
import { beneath } from '../track';
import { Listed, aiming } from '../keys';
import { Amount, Op as Operation } from '../rig';
import {
  AmountKind,
  edgeOf,
  edgesWithinBox,
  endsOf,
  sizedFor,
  switchedOn,
  withEffect,
} from '../effects';
import {
  EMPTY_SELECTION,
  ARTEFACTS,
  ArtefactId,
  FIGURES,
  KINDS,
  NGON_MAX,
  NGON_MIN,
  ArtefactType,
  EditorState,
  Id,
  Options as EffectOptions,
  PathId,
  Point,
  PolygonKind,
  Replay,
  Eye,
  Selection,
  dropped,
  Settings,
  Figure,
  zoomedAt,
  Tool,
  Update,
  KeyframeId,
  VertexId,
  View,
  World,
  clickable,
  visible,
  GroupId,
  alsoPicked,
  onGrid,
  toStep,
  marked,
  saying,
  opened,
  panBy,
  parentOf,
  resized,
  togglePicked,
  toWorld,
} from '../types';

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
  /** The effect options `b` and `d` give a thing that has none. */
  remembered: Value<EffectOptions>,
  selection: Value<Selection>,
  inside: Value<GroupId | null>,
  keyframe: Value<KeyframeId>,
  /** The keys the hand is on, which every gesture writes into. See
   * `EditorState.target`. */
  target: Value<EditorState['target']>,
  replay: Value<Replay | null>,
  bake: Value<Bake>,
  roaming: Value<boolean>,
  /** Whether the 3D view is up at all, which is what says the eye means
   * anything. */
  viewing: Value<boolean>,
  /**
   * Where whoever is standing in the 3D view is standing, and how to put them
   * somewhere else: the ghost is dragged here and the panel follows.
   *
   * Read through `afoot` rather than plainly. The cell keeps its last
   * answer when the 3D view is switched off — the panel does not clear it on
   * its way out, so a spot survives being looked away from — and there is
   * nobody standing in a level nobody is looking into.
   */
  eye: Value<Eye | null>,
  setEye: (eye: Eye | null) => void,
  input: Input,
  update: Update,
): VNode {
  /** The eye, or nothing at all while the 3D view is down. Everything on this
   * side asks this rather than the cell. */
  const afoot = (): Eye | null => (viewing() ? eye() : null);

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

      // Held by a key and never by a press, like a transform, and so with the
      // input to itself for as long as the key is down: a click into the 3D
      // view meanwhile is not a hand taking the controls there. See `grab`.
      const ungrabbed = input.grab({});

      try {
        yield* select({
          panning: pan(update),
          done: keyReleased(input, 'Space'),
          lost: blurred(),
        });
      }
      finally {
        ungrabbed();
        cursor('');
      }
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
          artefactsAt(world(), keyframe()).filter(it => clickable(world(), it.id)),
          box.a,
          box.b,
        );

        update(s => ({
          ...s,
          selection: {
            ...dropped(s.selection),
            artefacts: alsoPicked(adding ? s.selection.artefacts : [], caught),
          },
        }));

        if (tool() === 'artefact') return;
      }

      // Edges wholly inside it, and nothing else: a box drawn under the edge
      // tool is a question about lines.
      if (tool() === 'edge') {
        const caught = edgesWithinBox(edgeable(), box.a, box.b);

        update(s => ({ ...s, selection: { ...s.selection, edges: alsoPicked(adding ? s.selection.edges : [], caught) } }));

        return;
      }

      const points = tool() === 'point';

      // A box over the corners is a selection of corners, so nothing is picked
      // out of a path any more. One Backspace, one meaning.
      if (points) setLocal({ ...local(), onPath: null });

      // Corners come off what is on screen as itself; polygons come off
      // everything, because a member is how a marquee finds the group over it.
      const items = resolveAt(world(), keyframe());

      // A marquee takes whole groups: half a group picked is a selection that
      // no gesture could act on without taking the group apart. Whole at the
      // level standing open, that is — inside a group it takes that group's
      // members, which is the point of having gone in.
      const path = opened(world(), inside());

      // Paths are in here rather than off on their own, because they reach the
      // same way everything else does: a tape inside a shut group is caught as
      // that group, and what lands in the box is then a group id like any
      // other. Only the ones that reach themselves are paths as far as the
      // selection is concerned, and they are the ones with their own list.
      //
      // Not under the point tool, which is picking corners. A box drawn there
      // is a question about a ring.
      const reach = (id: Id) => reachable(world(), id, inside());
      const walks = points
        ? []
        : pathsWithinBox(laid(), box.a, box.b).filter(reach).map(id => reaching(world(), id, path));

      const caught = points
        ? verticesWithinBox(grabs(), box.a, box.b)
        : [...new Set([
          ...withinBox(items, box.a, box.b).filter(reach).map(id => reaching(world(), id, path)),
          ...walks.filter(id => !world().paths.has(id)),
        ])];

      update(s => ({
        ...s,
        selection: points
          ? { ...s.selection, vertices: alsoPicked(adding ? s.selection.vertices : [], caught) }
          : {
              ...s.selection,
              polygons: alsoPicked(adding ? s.selection.polygons : [], caught),
              paths: alsoPicked(
                adding ? s.selection.paths : [],
                walks.filter(id => world().paths.has(id)),
              ),
            },
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
    function* draggingVertices(grabbed: VertexId, ids: readonly VertexId[], from?: PointerEvent): Op<void> {
      const v = keyframe();

      // Where an edge was taken hold of, somewhere along it: then the step is
      // what snaps, as a whole thing's does, since neither end is under the
      // cursor to be put on the grid.
      const grip = from === undefined ? null : at(from);
      const was = world();
      const items = resolveAt(was, v);

      // Where each of them stood when the drag began. Every move is computed
      // from here rather than from the frame before, so the gesture cannot
      // drift and letting go leaves exactly what is on screen.
      const held = new Map<VertexId, { it: Resolved, index: number, from: Point }>();

      for (const it of items) {
        it.corners.forEach((corner, i) => {
          if (ids.includes(corner.id)) held.set(corner.id, { it, index: i, from: it.source[i] });
        });
      }

      const anchor = held.get(grabbed);

      if (anchor === undefined) return;

      setLocal({ ...local(), previewing: true });

      const locked = axisLock(() => SLOP / view().zoom);

      const end = yield* select({
        dragging: pointerMoved(e => {
          const to = at(e, grip === null);
          const g = settings().gridSize;
          const step = grip === null
            ? locked(e, { x: to.x - anchor.from.x, y: to.y - anchor.from.y })
            : locked(e, { x: to.x - grip.x, y: to.y - grip.y });
          const snapped = grip !== null && !free(e);
          const dx = snapped ? toStep(step.x, g) : step.x;
          const dy = snapped ? toStep(step.y, g) : step.y;

          update(s => {
            let world = was;

            for (const { it, index, from } of held.values()) {
              world = placeVertex(world, v, it, index, { x: from.x + dx, y: from.y + dy });
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
     * How a transform gesture reads the hand: where the cursor is taken to be
     * and what a scale multiplies by, from where the drag started — `from` in
     * the world and `down` on screen. One place for every gesture that writes
     * a transform, so that one writing an entry anew and one editing an entry
     * already written move and snap alike.
     */
    function readers(code: string, pivot: Point, from: Point, down: Point) {
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

        // A bevel and an amplitude the same way, with right as more:
        // a corner rounded further and an edge thrown further out both add to
        // the shape rather than eat into it. The vertical is the spacing's.
        if (code === 'KeyB' || code === 'KeyD') {
          const more = to.x - from.x;

          return { x: to.x, y: from.y + (free(e) ? more : toStep(more, g)) };
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

      return { aim, scaling };
    }

    /**
     * Hold the key, move the mouse, let go. Every move recomputes from the
     * transforms as they were when the key went down rather than from the last
     * frame, so the gesture cannot drift and letting go leaves exactly what was
     * on screen.
     */
    function* transforming(code: string, mode: Mode): Op<void> {
      const e = input.pointer();
      const v = keyframe();
      const was = world();

      if (e === null) return;

      // An erosion, a round or a deform: how much of something rather than
      // where it is.
      const kind = AMOUNTS[code];

      // A depth, a bevel and an amplitude are all about an outline, and a
      // point has none. So an artefact sits them out rather than being handed
      // a key that means nothing to it — every other transform means what it
      // means to anything else.
      const standing = kind !== undefined ? [] : selection().artefacts;

      // An amount is one number over a whole ring, so under the tools that
      // pick corners and edges it goes on the polygons they are on: an amount
      // is written into the timeline of the thing that has a ring, and a
      // corner has none. Every other gesture ignores them, being about where a
      // whole thing is. Only under those tools: corners left picked while the
      // hand is on whole things are not what the gesture there is asking about.
      const corners = new Set(kind === undefined ? [] : pickedCorners());

      if (kind !== undefined && tool() !== 'polygon' && corners.size === 0) return;

      const owners = corners.size === 0 ? [] : owning(world(), corners);

      // Paths sit them out for the reason artefacts do: a walk has no outline.
      const walks = kind !== undefined ? [] : selection().paths;

      const ids = [...(owners.length > 0 ? owners : selection().polygons), ...standing, ...walks];

      // A depth is an offset of a *union*, and a loose group has none: its
      // members are in the set one by one, and there is no single boundary for
      // a depth to move. Refused, rather than granted by sealing the group
      // underneath the hand — sealing changes what the level looks like, and it
      // is a thing an author asks for. See `Group.sealed`. A round is of the
      // same union. A deform is not: a group's is its members'.
      if ((kind === 'erode' || kind === 'round') && ids.some(id => world().groups.get(id)?.sealed === false)) {
        update(s => saying(s, `A loose group has no outline to ${kind} — Cmd+L seals it.`));

        return;
      }

      // What the effect is on: the things picked, or the polygons of the
      // corners picked. The gesture switches it on where it is off — an
      // amount of something that does not apply is invisible — and gives one
      // that has never had it the options last used. From there it works
      // over that.
      const targets = kind === undefined ? [] : ids.filter(id => was.polygons.has(id) || was.groups.has(id));
      const first = kind === 'deform' ? sizedFor(was, v, targets, remembered()) : remembered();
      const base = kind === undefined ? was : switchedOn(was, targets, kind, first);

      const reached = new Set(polygonsIn(world(), ids));
      const items = resolveAt(world(), v).filter(it => reached.has(it.id));

      const mine = new Set(artefactsIn(world(), ids));
      const places = artefactsAt(world(), v).filter(it => mine.has(it.id)).map(it => it.at);

      // Every point of every tape the selection reaches, which is what a tape
      // is where a pivot is concerned: a walk has no outline and no middle of
      // its own, so where it reaches is where its points are.
      const tapes = new Set(pathsIn(world(), ids));
      const walked = pathsAt(world(), v)
        .filter(it => tapes.has(it.id))
        .flatMap(it => it.points);

      // The start takes the two gestures that mean something to a place with a
      // direction, and it takes them alone — it is picked alone. What it is
      // not is a member of the selection above: it is in no version's layer,
      // so a move writes its own point rather than an edit at `v`, and every
      // version reads the one it wrote.
      const beginning = code === 'KeyT' || code === 'KeyR' ? selection().start : false;

      // The eye takes the same two, and takes them alone. Where it stood when
      // the key went down: the gesture is worked out from there, like
      // everything else this one moves.
      const looking = code === 'KeyT' || code === 'KeyR' ? (selection().eye ? afoot() : null) : null;

      if (
        items.length === 0
        && places.length === 0
        && walked.length === 0
        && !beginning
        && looking === null
      ) return;

      const from = at(e);

      // Where the drag started on screen, for the one gesture that is about
      // how far the hand has gone rather than about where it has got to.
      const down = { x: e.clientX, y: e.clientY };

      // Where each of them is painted: its middle as it stands when the key
      // went down, which every operation this gesture writes is about. The
      // gesture recomputes from the lists as they were then rather than
      // composing onto its own last frame.
      const resolved = resolveAt(was, v);
      const paints = new Map(
        [...new Set(ids)]
          .filter(id => was.polygons.has(id) || was.groups.has(id) || was.artefacts.has(id) || was.paths.has(id))
          .map(id => [id, painted(was, v, id, resolved)]),
      );

      // Into the keys the hand is on, read as each leaves its thing. See
      // `onKeys`.
      const hand = onKeys(was, v, paints);
      const held = target();

      // One pivot for the whole selection, so several polygons turn together
      // rather than each about itself. Artefacts are in it: a room turning
      // about a centre its own key was left out of would leave the key behind.
      //
      // A lone artefact turns about its own point and stays exactly where it
      // is, which is the gesture the start wants — the place is unchanged and
      // the facing is not. Every other kind has no facing to change, so it is
      // a turn that does nothing, which is what a turn of a point should be.
      //
      // The middle of the box round it all rather than the average of the
      // points: see `middle`, and see what it does to a shape somebody has just
      // resolved.
      //
      // Round what is drawn rather than round what it was drawn from, which is
      // `outlining`'s business: a group's pillar is a hole in its room and not
      // a place the group reaches to.
      const pivot = hand.stood !== null ? middle(hand.stood) : middle([
        ...outlining(world(), v, items, opened(world(), inside())),
        ...places,
        ...walked,
        ...(beginning ? [was.start.at] : []),
        ...(looking === null ? [] : [looking.at]),
      ]);

      cursor('crosshair');

      // The input is this gesture's for as long as the key is held, though it
      // never pressed anything: a press landing elsewhere meanwhile is a stray
      // click during this, not something else starting. Escape is let past,
      // being how it is put back; space needs no letting, since panning reads
      // it off `holding`. See `grab`.
      const ungrabbed = input.grab({}, 'Escape');

      try {
        setLocal({ ...local(), previewing: true });

        const { aim, scaling } = readers(code, pivot, from, down);

        // The first target's deform as the vertical has left its spacing, which
        // is what the label says and what is remembered at the end. A round's
        // vertical is drift: its bevel is the amount, and its segments are the
        // pane's.
        let options: Spacing | null = null;

        const end = yield* select({
          moving: pointerMoved(e => {
            const to = aim(e);
            const factor = scaling(e);
            const by = to.y - from.y;

            // Each thing's own spacing, moved by the same reading of the
            // vertical, at every keyframe: an option is not in the timeline.
            const each = kind !== 'deform'
              ? []
              : targets.map(id => [id, spaced(base.effects.get(id)!.deform!, down.y - e.clientY, free(e))] as const);

            options = each[0]?.[1] ?? null;

            const label = kind !== undefined ? amountLabel(kind, by, options) : transformLabel(code, from, to, pivot, factor);

            if (label !== null) setLocal({ ...local(), reading: { at: at(e), label } });

            // Its own point and its own facing, off the same reading of the
            // drag: a turn about itself is a turn of the direction alone, which
            // is what a place with a direction has to turn.
            if (looking !== null) {
              setEye(code === 'KeyT'
                ? {
                  at: { x: looking.at.x + to.x - from.x, y: looking.at.y + to.y - from.y },
                  facing: looking.facing,
                }
                : { at: looking.at, facing: looking.facing + about(pivot, from, to) });
            }

            update(s => {
              let world = base;

              for (const [id, now] of each) world = withEffect(world, id, 'deform', now);

              // Its own point and its own facing, off the same reading of the
              // drag the operations get: a move is where the cursor has gone, and
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

              const wrote: Listed[] = [];

              for (const [id, p] of paints) {
                // An amount is taken through the thing's scale into the world
                // (`scaleAt`), so the drag is taken back out of it: a depth, a
                // bevel or an amplitude comes out as far as the hand went, on
                // whatever it is.
                const scale = kind === undefined ? 1 : scaleAt(was, id, v);
                const amount = scale > 0 ? by / scale : 0;

                const op = kind !== undefined
                  ? { kind, by: amount } satisfies Amount
                  : mode(p, { pivot, from, to, alt: e.altKey, factor });

                const out = writtenInto(world, v, id, hand.keys.get(id) ?? null, op);

                world = out.world;
                if (out.key !== null) wrote.push({ id, at: v, key: out.key });
              }

              return { ...s, world, target: aiming(wrote) ?? held };
            });
          }),
          panning: alongside(),
          done: keyReleased(input, code),
          cancel: keyPressed(input, 'Escape'),
          lost: blurred(),
        });

        setLocal({ ...local(), previewing: false, reading: null });
        cursor('');

        if (looking !== null && end.tag === 'cancel') setEye(looking);

        // What was used is what the next thing deformed starts with.
        const used = end.tag === 'cancel' ? null : options;

        update(s => {
          const out = settled(s, was, end.tag === 'cancel', held);

          return used === null ? out : { ...out, remembered: { ...out.remembered, deform: used } };
        });
      }
      finally {
        ungrabbed();
      }
    }

    /**
     * The corners picked under the tools that pick them, whose polygons an
     * amount goes on: edges picked stand for their ends.
     */
    function pickedCorners(): VertexId[] {
      const sel = selection();

      if (tool() === 'point') return sel.vertices;
      if (tool() === 'edge') return endsOf(edgeable(), sel.edges);

      return [];
    }

    function retype(kind: PolygonKind): void {
      update(s => marked(
        {
          ...s,
          world: retypedPolygons(s.world, retypable(s.world, s.selection.polygons), kind),
        },
        s.world,
      ));
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
          s.keyframe,
          landing(s.world, s.keyframe, s.inside),
        );

        return marked(
          { ...s, world, selection: { ...dropped(s.selection), artefacts: [id] } },
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
      if (id === GHOST_ID) {
        update(s => ({ ...s, selection: { ...EMPTY_SELECTION, eye: true } }));
        return;
      }

      if (id === START_ID) {
        update(s => ({ ...s, selection: { ...EMPTY_SELECTION, start: true } }));
        return;
      }

      update(s => ({
        ...s,
        selection: e.shiftKey
          ? { ...dropped(s.selection), artefacts: togglePicked(s.selection.artefacts, id) }
          : { ...dropped(s.selection), polygons: [], artefacts: [id] },
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
          KINDS[0],
          points,
          s.keyframe,
          landing(s.world, s.keyframe, s.inside),
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
      const pen = {};
      const release = input.claim(pen, 'KeyZ');

      try {
        while (true) {
          const next = yield* select({
            key: keyHeard(input, pen),
            press: pressedOn(input, 'canvas'),

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

          // Only presses on the canvas itself: the chrome floating over it
          // is not somewhere to put a corner.
          const e = next.value;

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
      const walk = {};
      const release = input.claim(walk, 'KeyZ', 'Enter', 'NumpadEnter');

      try {
        while (true) {
          const next = yield* select({
            key: keyHeard(input, walk),
            press: pressedOn(input, 'canvas'),

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

      update(s => {
        // World units on the way in, the path's own frame on the way down: the
        // walk was drawn against what is on screen, and what is written is
        // where it will be read from. A new one is placed by the landing, the
        // way a dropped artefact is; one being carried on with is placed by
        // the frame it already stands in.
        const world = w.id === null
          ? addPath(
            s.world,
            w.points,
            s.keyframe,
            landing(s.world, s.keyframe, s.inside),
          ).world
          : setPath(s.world, w.id, own(s, w.id, w.points));

        return marked({ ...s, world }, s.world);
      });

      dropWalk();
    }

    /** The paths as the version on screen leaves them: where they run, which
     * is what every click and every label is about. */
    function laid(): Laid[] {
      return pathsAt(world(), keyframe()).filter(it => clickable(world(), it.id));
    }

    /** World points as one path's own frame reads them — see `inFrame`, which
     * is where the two frames a path has are told apart. */
    function own(s: EditorState, id: PathId, points: readonly Point[]): Point[] {
      return inFrame(s.world, s.keyframe, id, points);
    }

    /** The path point under the cursor, if a click is close enough to be
     * about one. */
    function pathPointAt(e: PointerEvent): OnPath | null {
      return hitPathPoint(laid(), at(e), HANDLE / view().zoom);
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
      const shown = laid();
      const on = hitPathPoint(shown, at(e), reach);

      if (on !== null) {
        // The one the paths tool carries the walk on from. Left alone here, so
        // that it can.
        const path = shown.find(it => it.id === on.id)!;
        const last = on.index === path.points.length - 1;

        if (resumable && last) return false;

        // Picking one lets the corners go, the same way picking a corner lets
        // this go: Backspace means one thing, and what it means is whatever
        // the last click was about.
        setLocal({ ...local(), onPath: on });
        update(s => ({ ...s, selection: { ...s.selection, vertices: [] } }));

        return true;
      }

      const leg = hitPathEdge(shown, at(e), reach);

      if (leg === null) return false;

      const points = [...shown.find(it => it.id === leg.id)!.points];

      points.splice(leg.index + 1, 0, at(e, true));

      update(s => marked(
        { ...s, world: setPath(s.world, leg.id, own(s, leg.id, points)) },
        s.world,
      ));
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
      const shown = laid();
      const on = hitPathPoint(shown, here, HANDLE / view().zoom);

      if (on !== null) {
        // Where it runs rather than where it is written: a walk is carried on
        // with on screen, and `commitWalk` takes the whole of it back to the
        // path's own frame at the end.
        const path = shown.find(it => it.id === on.id)!;

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

        // Its own frame either way, so this one needs no inverse: a point is
        // being taken out rather than put anywhere.
        const points = path.points.filter((_unused, i) => i !== on.index);

        return marked({ ...s, world: setPath(s.world, on.id, points) }, s.world);
      });
    }

    /**
     * One point of a path following the cursor.
     *
     * Its own gesture rather than a share of `draggingVertices`, because a path
     * has no layer to write a displacement into: the route is one list every
     * version reads, so moving a point is the map with a different number in
     * it. What it does share is the frame — the cursor goes back through the
     * path's own before it is written, so a tape inside a turned group takes
     * the shape the hand drew. Cancelling puts the world back the way every
     * other gesture does.
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

            const here = own(s, on.id, [to])[0];
            const points = path.points.map((p, i) => (i === on.index ? here : p));

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
      const corner = hitVertex(grabs(), at(e), reach);

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
          const v = keyframe();

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

      // A tape before a room, because it is drawn over one and what is on top
      // is what a click on it means — the same order the two tools that edit a
      // path read their clicks in. Reached like anything else: over a tape
      // inside a shut group this picks the group.
      if (pickingPath(e) !== null) return;

      const stack = standingIn(world(), e, at(e));

      if (stack.length === 0) {
        // Shift means adding, and adding nothing leaves the selection alone.
        if (!e.shiftKey) {
          update(s => ({
            ...s,
            selection: { ...dropped(s.selection), polygons: [], artefacts: [], paths: [] },
          }));
        }

        return;
      }

      if (e.shiftKey) {
        update(s => ({
          ...s,
          selection: {
            ...dropped(s.selection),
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
          selection: {
            ...dropped(s.selection),
            polygons: [stack[next]],
            artefacts: [],
            paths: [],
          },
        };
      });
    }

    /**
     * A click on a measuring path, picked whole.
     *
     * What it picks is what it reaches: the tape itself out here, and the
     * outermost shut group holding it from inside one — which lands in the
     * list groups go in, exactly as a click on one of its rooms would. So a
     * group is one thing to pick however the cursor found it.
     *
     * Nothing where the click is not on a tape, which is the answer that lets
     * the polygons have their say.
     */
    function pickingPath(e: PointerEvent): PathId | null {
      const w = world();
      const on = hitPath(laid(), at(e), HANDLE / view().zoom);

      if (on === null || !reachable(w, on, inside())) return null;

      const id = reaching(w, on, opened(w, inside()));
      const mine = w.paths.has(id);

      update(s => ({
        ...s,
        selection: e.shiftKey
          ? {
              ...dropped(s.selection),
              polygons: mine ? s.selection.polygons : togglePicked(s.selection.polygons, id),
              paths: mine ? togglePicked(s.selection.paths, id) : s.selection.paths,
            }
          : {
              ...dropped(s.selection),
              artefacts: [],
              polygons: mine ? [] : [id],
              paths: mine ? [id] : [],
            },
      }));

      return on;
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
      const under = hitting(w, keyframe(), resolveAt(w, keyframe()), path, at(e));

      const into = under.find(id => w.groups.has(id));

      if (into !== undefined) {
        // The selection goes: what was picked was the group, and it is not a
        // thing that can be picked any more from in here.
        update(s => ({
          ...s,
          inside: into,
          selection: { ...s.selection, polygons: [], paths: [] },
        }));

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

        if (at === null) {
          return { ...s, selection: { ...s.selection, polygons: [], paths: [] } };
        }

        return {
          ...s,
          inside: parentOf(s.world).get(at) ?? null,
          selection: { ...s.selection, polygons: [at], paths: [] },
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
     * Edges, now that corners have `grabs`. An edge is clicked to grow a
     * corner out of it, and the edges of a shut group's members are not on
     * screen — the group draws one outline over the lot. Picking the group
     * does not put them back the way it puts the corners back: a corner is a
     * handle on a shape the outline is made of, and a seam is a line the group
     * exists to hide.
     */
    function pickable(): Resolved[] {
      const w = world();
      const path = opened(w, inside());

      return resolveAt(w, keyframe())
        .filter(it => !swallowed(w, it.id, path) && reachable(w, it.id, inside()));
    }

    /** The corners on screen, which are the ones a click may take. The same
     * call the drawing makes — see `handles`. */
    function grabs(): Handle[] {
      const w = world();
      const v = keyframe();

      return handles(
        w,
        v,
        resolveAt(w, v),
        opened(w, inside()),
        inside(),
        new Set(polygonsIn(w, selection().polygons)),
      );
    }

    /**
     * The polygons whose edges may be picked: those whose corners are on
     * screen to be picked, so the two tools reach the same rings.
     */
    function edgeable(): Resolved[] {
      const ids = new Set(grabs().map(h => h.id));

      return resolveAt(world(), keyframe()).filter(it => ids.has(it.id));
    }

    /** The edge under the cursor, by the drawn corner it starts at, and the
     * ring it is on. */
    function edgeAt(e: PointerEvent): { edge: VertexId, it: Resolved } | null {
      const items = edgeable();
      const hit = hitEdge(items, at(e), HANDLE / view().zoom);
      const it = hit === null ? undefined : items.find(r => r.id === hit.id);

      return hit === null || it === undefined ? null : { edge: edgeOf(it, hit.index), it };
    }

    /** A click with the edge tool up: the edge under it picked, or, over
     * nothing, the edges let go. Shift adds and takes away. */
    function edgeClicked(e: PointerEvent): void {
      const on = edgeAt(e);

      if (on === null) {
        if (!e.shiftKey) update(s => ({ ...s, selection: { ...s.selection, edges: [] } }));

        return;
      }

      update(s => ({
        ...s,
        selection: { ...s.selection, edges: e.shiftKey ? togglePicked(s.selection.edges, on.edge) : [on.edge] },
      }));
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
      const v = keyframe();
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
      const v = keyframe();
      const was = world();
      const ids = [...selection().polygons, ...selection().artefacts, ...selection().paths];
      const grabbed = at(from);

      // The start comes along the same way it does under `t`: its own point
      // written directly, since it is in no version's layer to write an edit
      // into. Alone, because it is picked alone.
      const beginning = selection().start;

      // The eye where it stood when the drag began, for the same reason the
      // world is kept: every move is worked out from there rather than composed
      // onto the last one, so it cannot drift, and letting go of it puts it
      // back. It is not in the world, so nothing about it is undoable — and
      // nothing about it should be: it is where somebody is looking from.
      const looking = selection().eye ? afoot() : null;

      const resolved = resolveAt(was, v);
      const paints = new Map(
        [...new Set(ids)]
          .filter(id => was.polygons.has(id) || was.groups.has(id) || was.artefacts.has(id) || was.paths.has(id))
          .map(id => [id, painted(was, v, id, resolved)]),
      );

      // Into the keys the hand is on, as the transform gesture does.
      const hand = onKeys(was, v, paints);
      const held = target();

      if (paints.size === 0 && !beginning && looking === null) return;

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

          if (looking !== null) {
            setEye({ at: { x: looking.at.x + dx, y: looking.at.y + dy }, facing: looking.facing });
          }

          update(st => {
            let world = was;

            if (beginning) {
              world = movedStart(world, {
                x: was.start.at.x + dx,
                y: was.start.at.y + dy,
              });
            }

            // The step as each one's holder reads it. Snapped in world units,
            // because the grid is on screen and that is where the hand is
            // aiming — then taken back, so a group turned a quarter turn does
            // not send its contents sideways.
            const wrote: Listed[] = [];

            for (const [id, p] of paints) {
              const out = writtenInto(world, v, id, hand.keys.get(id) ?? null, moveOf(p, { x: dx, y: dy }));

              world = out.world;
              if (out.key !== null) wrote.push({ id, at: v, key: out.key });
            }

            return { ...st, world, target: aiming(wrote) ?? held };
          });
        }),
        panning: alongside(),
        done: pointerReleased(),
        cancel: keyPressed(input, 'Escape'),
        lost: blurred(),
      });

      setLocal({ ...local(), previewing: false });
      cursor('');

      if (looking !== null && end.tag === 'cancel') setEye(looking);

      update(s => settled(s, was, end.tag === 'cancel', held));
    }

    /**
     * The keys the hand is on at `v` among the things in `paints`, by thing,
     * and each of those things read as its key leaves it rather than as the
     * keyframe does — `editedAt` — so that what the gesture writes folds into
     * that key. See `EditorState.target`.
     *
     * Where any of them is not the last of its keyframe, the hand is standing
     * on it: the gesture is about the things it stands on alone, and `stood`
     * is where each of them is as its key leaves it, for the pivot. Otherwise
     * `stood` is nothing, and the pivot is the one every gesture has.
     */
    function onKeys(was: World, v: KeyframeId, paints: Map<Id, Painted>): { keys: Map<Id, number>, stood: Point[] | null } {
      const keys = new Map<Id, number>();
      const centres: Point[] = [];
      let earlier = false;

      for (const p of target()?.all ?? []) {
        if (!('key' in p) || p.at !== v || !paints.has(p.id) || keys.has(p.id)) continue;

        const list = keysOfAt(was, v, p.id);
        const i = list.findIndex(k => k.id === p.key);
        const read = i < 0 ? null : editedAt(was, v, p.id, list[i]);

        if (read === null) continue;

        keys.set(p.id, p.key);
        paints.set(p.id, read.paint);
        centres.push(read.pivot);

        if (i < list.length - 1) earlier = true;
      }

      if (earlier) {
        for (const id of [...paints.keys()]) if (!keys.has(id)) paints.delete(id);
      }

      return { keys, stood: earlier ? centres : null };
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
     *
     * Put back, the hand is back on the keys it was on, `aimed`.
     */
    function settled(s: EditorState, was: World, cancelled: boolean, aimed = s.target): EditorState {
      return cancelled ? { ...s, world: was, target: aimed } : marked(s, was);
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
      const here = afoot();
      const shown = [
        ...shownAt(world(), keyframe())
          .filter(it => it.id === START_ID || (clickable(world(), it.id) && (all || !swallowed(world(), it.id, path)))),
        // Last, so that a click where the two stand on top of each other — the
        // moment someone rises into the level — takes the one that moves.
        ...(here === null ? [] : [eyePlaced(here)]),
      ];

      return hitArtefact(shown, at(e), HANDLE / view().zoom);
    }

    function removing(): void {
      // A picked path point is what Backspace means under either tool that can
      // pick one, and it is checked first: the paths tool has nothing else to
      // delete, and under the point tool one is only ever picked instead of a
      // corner, never as well as.
      if (unpointing()) return;

      if (tool() === 'path') return;

      // An edge goes as both its corners do: the corner tool's delete, on the
      // ends of every edge picked.
      const ends = tool() === 'edge' ? endsOf(edgeable(), selection().edges) : [];

      update(s => {
        if (tool() === 'artefact') {
          if (s.selection.artefacts.length === 0) return s;

          return marked(
            {
              ...s,
              world: removeAt(s.world, s.keyframe, s.selection.artefacts),
              selection: { ...s.selection, artefacts: [] },
            },
            s.world,
          );
        }

        if (tool() === 'edge') {
          if (ends.length === 0) return s;

          return marked(
            {
              ...s,
              world: removeVertices(s.world, s.keyframe, ends),
              selection: { ...s.selection, edges: [], vertices: [] },
            },
            s.world,
          );
        }

        if (tool() === 'point') {
          return marked(
            {
              ...s,
              world: removeVertices(s.world, s.keyframe, s.selection.vertices),
              selection: { ...s.selection, vertices: [] },
            },
            s.world,
          );
        }

        // Polygons, artefacts and paths in one call, because they are one
        // gesture and a group holds all three. `removeAt` takes what is under a
        // group itself, so what goes in is what was picked rather than what it
        // reaches.
        const picked = [...s.selection.polygons, ...s.selection.artefacts, ...s.selection.paths];

        if (picked.length === 0) return s;

        const world = removeAt(s.world, s.keyframe, picked);

        return world === s.world ? s : marked(
          {
            ...s,
            world,
            selection: { ...s.selection, polygons: [], artefacts: [], paths: [] },
          },
          s.world,
        );
      });
    }

    /** Everything a paint reads. */
    const painting = () => [
      world(),
      settings(),
      view(),
      tool(),
      selection(),
      inside(),
      keyframe(),
      replay(),
      bake(),
      local(),
      afoot(),
      target(),
    ] as const;

    /** What the canvas last changed to and has not yet painted, and the frame
     * it will be painted in. See the effect that draws. */
    let pending: ReturnType<typeof painting> | null = null;
    let frame = 0;

    function paint(): void {
      const next = pending;

      pending = null;

      if (next === null) return;

      const [w, s, v, t, sel, ins, at, r, b, l, g, aim] = next;

      if (el && ctx) {
        // Standing on a key, the world drawn is the one that keyframe
        // leaves after that key — see `upto`. Where the keyframe ends
        // up is drawn over it as a ghost, so that what is being
        // adjusted and what it comes to are both on screen.
        const { here, stood } = standingOn(w, at, aim);
        const items = resolveAt(here, at);
        const ends = here === w ? null : resolveAt(w, at).filter(it => stood.has(it.id));

        set = live(set, contributing(here, at, items));

        const played = r === null
          ? null
          : replayed(b, w, r.from, r.to, r.at);

        draw(
          el,
          ctx,
          v,
          layers(
            here, s, v, t, sel, ins, at, l, items, runs(set), floorRuns(set),
            played,
            // An artefact flying on its own, with the walls it belongs
            // to standing still because their span has not been baked
            // yet, reads as a glitch rather than as a walk.
            played === null ? null : r,
            g,
            ends,
            w,
          ),
        );
      }
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
          effect(() => el && input.surface('canvas', el)),

          effect(
            painting,
            // Once a frame, whatever changed in it and however often. A drag
            // writes the label and then the world for every move, and a move
            // can arrive more often than the screen does: every one of those
            // drew the whole level again, and all but the last were never seen.
            // So the change is only noted, and what is on screen is painted from
            // the latest of them when the browser next draws.
            inputs => {
              const first = pending === null;

              pending = inputs;

              if (first) frame = requestAnimationFrame(paint);
            },
          ),

          effect(() => () => {
            cancelAnimationFrame(frame);
            pending = null;
          }),

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
            // Nobody else's: a key claimed by the keyframes, or the list of
            // what is under the cursor, is theirs.
            key: keyHeard(input),
            press: pressedOn(input, 'canvas'),
            // The right button lists everything under it, what cannot be
            // picked included — which is how a locked thing is got back.
            menu: pressedOn(input, 'canvas', 2),
            lost: blurred(),
          });

          if (started.tag === 'menu') {
            const e = started.value;
            const items = beneath(world(), keyframe(), at(e), HANDLE / view().zoom);

            // Stamped with the press that opened it, so that the list closing
            // on a press elsewhere cannot close this one, whoever hears it
            // first.
            update(s => ({
              ...s,
              beneath: items.length === 0 ? null : { x: e.clientX, y: e.clientY, since: e.timeStamp, items },
            }));

            continue;
          }

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
            // The amounts are the transforms the corner and edge tools have a
            // use for: a depth, a bevel or an amplitude on what is picked is
            // a corner's gesture or an edge's. Every other transform is about
            // where a whole thing is and stays where it was.
            else if (tool() === 'point' && AMOUNTS[e.code] !== undefined
              && selection().vertices.length > 0) {
              yield* transforming(e.code, TRANSFORMS[e.code]);
            }
            else if (tool() === 'edge' && AMOUNTS[e.code] !== undefined
              && selection().edges.length > 0) {
              yield* transforming(e.code, TRANSFORMS[e.code]);
            }
            else if (tool() === 'polygon') {
              const mode = TRANSFORMS[e.code];

              if (mode !== undefined) {
                yield* transforming(e.code, mode);
              }
              else {
                // In the order `KINDS` names them: room, pillar, floor, the
                // voids over the solids, over the floors and over both, and
                // then the rest of what is in both sets.
                const n = Number(e.code.match(/^Digit([1-9])$/)?.[1] ?? NaN);

                if (n >= 1 && n <= KINDS.length) retype(KINDS[n - 1]);
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
          else if (started.tag === 'press') {
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

              if (tool() === 'edge') {
                const on = edgeAt(e);

                if (on !== null) {
                  // Grabbing one already picked drags them all; one that is
                  // not, alone. An edge moves as its two ends.
                  const picked = selection().edges.includes(on.edge) ? selection().edges : [on.edge];

                  update(s => ({ ...s, selection: { ...s.selection, edges: picked } }));
                  yield* draggingVertices(on.edge, endsOf(edgeable(), picked), e);
                  continue;
                }
              }
              else if (tool() === 'point') {
                const grab = hitVertex(grabs(), at(e), HANDLE / view().zoom);

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
                  if (grab === GHOST_ID) {
                    if (!selection().eye) {
                      update(s => ({ ...s, selection: { ...EMPTY_SELECTION, eye: true } }));
                    }
                  }
                  else if (grab === START_ID) {
                    if (!selection().start) {
                      update(s => ({ ...s, selection: { ...EMPTY_SELECTION, start: true } }));
                    }
                  }
                  else if (!selection().artefacts.includes(grab)) {
                    update(s => ({
                      ...s,
                      selection: {
                        ...dropped(s.selection),
                        polygons: [],
                        artefacts: [grab],
                        paths: [],
                      },
                    }));
                  }

                  yield* draggingSelection(e);
                  continue;
                }
              }

              if (tool() === 'polygon') {
                // A tape before a room, the same order a click reads them in.
                // Grabbing one already picked drags the whole selection;
                // grabbing one that is not takes it alone, which is what
                // `pickingPath` writes.
                const on = hitPath(laid(), at(e), HANDLE / view().zoom);

                if (on !== null && reachable(world(), on, inside())) {
                  const id = reaching(world(), on, opened(world(), inside()));

                  if (!selection().paths.includes(id) && !selection().polygons.includes(id)) {
                    pickingPath(e);
                  }

                  yield* draggingSelection(e);
                  continue;
                }

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
                        ...dropped(s.selection),
                        polygons: [under[0]],
                        artefacts: [],
                        paths: [],
                      },
                    }));
                  }

                  yield* draggingSelection(e);
                  continue;
                }
              }

              yield* marqueeing(e, e.shiftKey);
            }
            else if (tool() === 'edge') {
              if (twice(e)) entering(e);
              else edgeClicked(e);
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
// The modal transforms
// -----------------------------------------------------------------------------

/** What a gesture writes for one thing, painted where it was when the key went
 * down: every move recomputes from there rather than from the last frame. */
type Mode = (p: Painted, drag: Aimed) => Operation;

/** The gesture as the operations read it, in world units. Each thing takes it
 * into the frame it is held in itself — see `moveOf`. */
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

/** A deform's options, whose spacing the vertical moves. */
type Spacing = EffectOptions['deform'];

/** Screen pixels of vertical drift an effect gesture ignores, so that a hand
 * dragging sideways for the amount leaves the option alone. */
const DRIFT = 12;

/**
 * A deform's spacing moved by how far the hand has gone up, past the drift:
 * doubled every `DOUBLING`, as a scale is — a spacing is a length, and wants
 * a factor rather than a step.
 */
function spaced(o: Spacing, up: number, free: boolean): Spacing {
  const past = Math.sign(up) * Math.max(0, Math.abs(up) - DRIFT);
  const spacing = o.spacing * Math.pow(2, past / DOUBLING);

  return { ...o, spacing: free ? spacing : Math.max(1, Math.round(spacing)) };
}

/** What an amount gesture has come to, for the label by the cursor. */
function amountLabel(kind: AmountKind, by: number, o: Spacing | null): string {
  const n = `${by > 0 ? '+' : ''}${Math.round(by * 10) / 10}`;

  if (o !== null) return `amplitude ${n} · every ${Math.round(o.spacing * 10) / 10}`;

  return kind === 'erode' ? `depth ${n}` : kind === 'round' ? `bevel ${n}` : `${kind} ${n}`;
}

/** What a transform has come to, for the same label: how far, how many
 * degrees, how many times. Null for a code that is not a transform. */
function transformLabel(code: string, from: Point, to: Point, pivot: Point, factor: Point): string | null {
  const tenths = (n: number) => `${Math.round(n * 10) / 10}`;
  const times = (n: number) => `×${Math.round(n * 100) / 100}`;

  if (code === 'KeyT') return `${tenths(to.x - from.x)}, ${tenths(to.y - from.y)}`;

  if (code === 'KeyR') {
    // Round to the nearest turn either way rather than past a half, so that a
    // turn of 350° reads as the -10° it looks like.
    const a = Math.atan2(Math.sin(about(pivot, from, to)), Math.cos(about(pivot, from, to)));

    return `${tenths(a * 180 / Math.PI)}°`;
  }

  if (code === 'KeyS') return factor.x === factor.y ? times(factor.x) : `${times(factor.x)} ${times(factor.y)}`;
  if (code === 'KeyX') return times(factor.x);
  if (code === 'KeyY') return times(factor.y);

  return null;
}

/** The gestures that write an amount rather than move anything, and the kind
 * each writes. `b` is for bevel, since `r` turns. */
const AMOUNTS: Partial<Record<string, AmountKind>> = {
  KeyE: 'erode',
  KeyB: 'round',
  KeyD: 'deform',
};

const TRANSFORMS: Record<string, Mode> = {
  KeyT: (p, { from, to }) => moveOf(p, { x: to.x - from.x, y: to.y - from.y }),

  KeyR: (p, { pivot, from, to }) => turnOf(p, pivot, about(pivot, from, to)),

  /** Both axes, each from its own share of the drag — one factor for both
   * where Alt has already made them one. Where the factors come from is
   * `scaling`, which is where the whole of the feel of this lives. Along the
   * thing's own axes, whichever way it is turned: see `scaleOf`. */
  KeyS: (p, { pivot, factor }) => scaleOf(p, pivot, factor),

  // One axis and nothing else, whatever the drag does on the other. `s` reads
  // both, so these are how one of them is said on its own without having to
  // hold the hand still.
  KeyX: (p, { pivot, factor }) => scaleOf(p, pivot, { x: factor.x, y: 1 }),
  KeyY: (p, { pivot, factor }) => scaleOf(p, pivot, { x: 1, y: factor.y }),

  // A depth is not in any frame, and a drag that erodes has to mean the same
  // thing whichever way a group has been turned.
  KeyE: (_p, { from, to }) => ({ kind: 'erode', by: to.y - from.y }),

  // The same for a bevel and an amplitude, which are lengths in no frame
  // either.
  KeyB: (_p, { from, to }) => ({ kind: 'round', by: to.y - from.y }),
  KeyD: (_p, { from, to }) => ({ kind: 'deform', by: to.y - from.y }),
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


