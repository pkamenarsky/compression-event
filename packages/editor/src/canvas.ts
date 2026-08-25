import { Value } from '@incpt/kontinuum';
import { VNode, effect } from '@incpt/kontinuum-dom';
import { canvas } from '@incpt/kontinuum-dom/html';
import { Op, select, signal } from '@incpt/kontinuum-interaction';
import { interactive } from '@incpt/kontinuum-interaction/dom';

import { Bake, Frame, replayed } from './bake';
import { Ring, Shape } from './geometry';
import {
  Input,
  SHIFT,
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
  addVertex,
  centroid,
  editAt,
  hitEdge,
  hitPolygons,
  hitVertex,
  contributing,
  starting,
  under,
  unplace,
  unstep,
  IDENTITY,
  occupying,
  Occupied,
  swallowed,
  reachable,
  reaching,
  Contributed,
  sidedWith,
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
import { theme } from './theme';
import {
  Edit,
  EditorState,
  Id,
  Point,
  Polygon,
  PolygonId,
  PolygonType,
  Replay,
  Selection,
  Settings,
  Tool,
  Transform,
  Update,
  VersionId,
  VertexId,
  View,
  World,
  GroupId,
  alsoPicked,
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

/**
 * Held, it turns a click on a corner into taking that corner out, the way
 * Illustrator's delete-anchor tool does.
 *
 * Deliberately not also a key that removes the picked corners on its own. It
 * was, briefly, and the two meanings ate each other: pressing it deleted the
 * selection, and then the very click that was meant to delete one corner landed
 * on the bare edge left behind and inserted a new one.
 */
const MINUS = ['Minus', 'NumpadSubtract'];

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
    const at = (e: PointerEvent, snap = false): Point => {
      const box = el?.getBoundingClientRect();
      const p = toWorld(view(), {
        x: e.clientX - (box?.left ?? 0),
        y: e.clientY - (box?.top ?? 0),
      });

      const s = settings();

      return snap && s.snapToGrid
        ? {
          x: Math.round(p.x / s.gridSize) * s.gridSize,
          y: Math.round(p.y / s.gridSize) * s.gridSize,
        }
        : p;
    };

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

      const points = tool() === 'point';

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

      const end = yield* select({
        dragging: pointerMoved(e => {
          const to = at(e, true);
          const dx = to.x - anchor.from.x, dy = to.y - anchor.from.y;

          update(s => {
            let world = s.world;

            for (const [vertex, { id, from }] of held) {
              const it = resolveAt(world, v).find(r => r.id === id);
              if (it === undefined) continue;

              const index = it.corners.findIndex(c => c.id === vertex);
              if (index < 0) continue;

              const edit = placeVertex(
                it,
                editAt(world, v, id, it.erosion),
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
      const ids = selection().polygons;
      const e = input.pointer();
      const v = currentVersion();
      const was = world();

      if (ids.length === 0 || e === null) return;

      const reached = new Set(polygonsIn(world(), ids));
      const items = resolveAt(world(), v).filter(it => reached.has(it.id));

      if (items.length === 0) return;

      const from = at(e);

      // The layer as it stood when the key went down. A transform written into
      // this version replaces whatever it held, so the gesture recomputes from
      // here rather than composing onto its own last frame.
      const anchors = starting(world(), v, ids);

      // One pivot for the whole selection, so several polygons turn together
      // rather than each about itself.
      const pivot = centroid(items.flatMap(it => it.source));

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

      const end = yield* select({
        moving: pointerMoved(e => {
          const to = at(e);

          update(s => {
            let world = s.world;

            for (const [id, edit] of anchors) {
              const m = frames.get(id)!;

              world = withEdit(world, v, id, {
                ...edit,
                transform: mode(
                  edit.transform,
                  unplace(m, pivot),
                  unplace(m, from),
                  unplace(m, to),
                ),
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

    /** A polygon is born into the version it was drawn in, and nothing before
     * that version may name it. */
    function commit(points: Point[]): void {
      update(s => {
        const { world, id } = addPolygon(s.world, 'level', points, s.currentVersion);

        return marked(
          { ...s, world, selection: { ...s.selection, polygons: [id] } },
          s.world,
        );
      });
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
      const taking = input.holding(MINUS[0]) || input.holding(MINUS[1]);

      // Held, minus only ever takes corners away. Letting it fall through to
      // the edge would mean a click that missed the corner by a pixel added one
      // instead of removing one, which is the opposite of what was asked for.
      if (taking) {
        if (corner === null) return;

        update(s => marked(
          {
            ...s,
            world: removeVertices(s.world, s.currentVersion, [corner.vertex]),
            selection: {
              ...s.selection,
              vertices: s.selection.vertices.filter(id => id !== corner.vertex),
            },
          },
          s.world,
        ));

        return;
      }

      if (corner !== null) {
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

      const edge = hitEdge(items, at(e), reach);

      if (edge !== null) {
        const it = items.find(r => r.id === edge.id);

        if (it !== undefined) {
          const v = currentVersion();

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
      const stack = standingIn(world(), hitPolygons(resolveAt(world(), currentVersion()), at(e)), e);

      if (stack.length === 0) {
        // Shift means adding, and adding nothing leaves the selection alone.
        if (!e.shiftKey) {
          update(s => ({ ...s, selection: { ...s.selection, polygons: [] } }));
        }

        return;
      }

      if (e.shiftKey) {
        update(s => ({
          ...s,
          selection: { ...s.selection, polygons: togglePicked(s.selection.polygons, stack[0]) },
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

        return { ...s, selection: { ...s.selection, polygons: [stack[next]] } };
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
      const under = hitPolygons(resolveAt(w, currentVersion()), at(e))
        .filter(id => reachable(w, id, inside()));

      const into = under.map(id => reaching(w, id, path)).find(id => w.groups.has(id));

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

    function standingIn(w: World, under: PolygonId[], e: MouseEvent): Id[] {
      const here = under.filter(id => reachable(w, id, inside()));

      if (e.metaKey || e.ctrlKey) return here;

      return [...new Set(here.map(id => reaching(w, id, opened(w, inside()))))];
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
    function* draggingPolygons(from: PointerEvent): Op<void> {
      const v = currentVersion();
      const was = world();
      const ids = selection().polygons;
      const start = at(from);

      const anchors = starting(was, v, ids);

      if (anchors.size === 0) return;

      const frames = new Map([...anchors.keys()].map(id => [id, under(was, v, id)]));

      cursor('move');
      setLocal({ ...local(), previewing: true });

      const end = yield* select({
        moving: pointerMoved(e => {
          const to = at(e);
          const g = settings();
          const step = g.snapToGrid ? g.gridSize : 0;

          const dx = step === 0 ? to.x - start.x : Math.round((to.x - start.x) / step) * step;
          const dy = step === 0 ? to.y - start.y : Math.round((to.y - start.y) / step) * step;

          update(st => {
            let world = st.world;

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
    function removing(): void {
      update(s => {
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

        if (s.selection.polygons.length === 0) return s;

        // A group goes with what was in it: picking one is picking the rooms
        // under it, and deleting it while they stayed would be a selection
        // that deleted less than it drew.
        const gone = new Set(s.selection.polygons.flatMap(id => within(s.world, id)));
        const polygons = new Map(s.world.polygons);

        for (const id of gone) polygons.delete(id);

        return marked(
          {
            ...s,
            world: without({ ...s.world, polygons }, gone),
            selection: { ...s.selection, polygons: [] },
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

                draw(
                  el,
                  ctx,
                  v,
                  layers(w, s, v, t, sel, ins, at, l, items, runs(set), played),
                );
              }
            },
          ),

          // A half-drawn polygon belongs to the pen. Leaving it on screen after
          // switching away would leave it waiting for clicks that now mean
          // something else entirely — so the pen is told, and drops it itself.
          effect(tool, t => {
            if (t !== 'path' && local().draft !== null) abandoned.emit();
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

                  update(s => ({ ...s, selection: { ...s.selection, vertices: picked } }));
                  yield* draggingVertices(grab.vertex, picked);
                  continue;
                }
              }
              else if (tool() === 'polygon') {
                const under = standingIn(
                  world(),
                  hitPolygons(resolveAt(world(), currentVersion()), at(e)),
                  e,
                );

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
                      selection: { ...s.selection, polygons: [under[0]] },
                    }));
                  }

                  yield* draggingPolygons(e);
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
            else if (tool() === 'path') {
              yield* drawing(e);
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

interface Local {
  marquee: Marquee | null
  draft: Draft | null
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
  previewing: false,
};

// -----------------------------------------------------------------------------
// The modal transforms
// -----------------------------------------------------------------------------

/** `was` is the transform as it stood when the key went down, so that every
 * move recomputes from there rather than from the last frame. */
type Mode = (was: Transform, pivot: Point, from: Point, to: Point) => Transform;

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
function ratio(was: number, now: number): number {
  return Math.abs(was) < 1e-6 || Math.abs(now) < 1e-6 ? 1 : now / was;
}

const TRANSFORMS: Record<string, Mode> = {
  KeyT: (t, _pivot, from, to) => ({
    ...t,
    translation: {
      x: t.translation.x + to.x - from.x,
      y: t.translation.y + to.y - from.y,
    },
  }),

  KeyR: (t, pivot, from, to) => turned(
    t,
    pivot,
    Math.atan2(to.y - pivot.y, to.x - pivot.x)
      - Math.atan2(from.y - pivot.y, from.x - pivot.x),
  ),

  KeyS: (t, pivot, from, to) => {
    const f = ratio(
      Math.hypot(from.x - pivot.x, from.y - pivot.y),
      Math.hypot(to.x - pivot.x, to.y - pivot.y),
    );

    return squashed(t, pivot, f, f);
  },

  // One axis at a time, which is the only way to say a squash: there is no
  // reading of a single drag that gives two independent factors and is not a
  // surprise on one of them.
  KeyX: (t, pivot, from, to) => squashed(t, pivot, ratio(from.x - pivot.x, to.x - pivot.x), 1),
  KeyY: (t, pivot, from, to) => squashed(t, pivot, 1, ratio(from.y - pivot.y, to.y - pivot.y)),

  KeyE: (t, _pivot, from, to) => ({
    ...t,
    erosion: t.erosion + to.y - from.y,
  }),
};

// -----------------------------------------------------------------------------

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
  out.push(ctx =>
    groups(ctx, view, occupying(world, current, items, path), new Set(selection.polygons), reach),
  );
  out.push(ctx => outlines(ctx, view, outline));

  // Over the editor's own answer, so the two can be read against each other:
  // where they agree the thin line sits inside the thick one, and where the
  // bake is part way between two versions it is visibly somewhere else.
  if (played !== null) out.push(ctx => replay(ctx, view, played));

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

    if (it.erosion !== 0 && here && (picked || handles)) {
      ctx.beginPath();
      trace(ctx, view, it.source);

      ctx.strokeStyle = theme.source;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
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
): void {
  for (const g of shown) {
    outlined(ctx, view, g.shape, g.kind, picking.has(g.id), reach(g.id), theme.groupFill);
  }
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

  if (picked && here) {
    ctx.fillStyle = fill;
    ctx.fill();
  }

  ctx.strokeStyle = !here
    ? theme.outside
    : picked ? theme.picked
    : kind === 'solid' ? theme.solid : theme.level;

  ctx.lineWidth = picked ? 2 : 0.5;
  ctx.setLineDash(kind === 'solid' ? [5, 3] : []);
  ctx.stroke();
  ctx.setLineDash([]);
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
 * The bake, played back: the same open runs, thinner and brighter, drawn from
 * the buffers rather than from the world.
 *
 * Nothing about this consults the version on screen. That is the entire point —
 * if it disagrees with the outline underneath it at the moment it arrives, the
 * bake and the editor disagree, and it is the bake the game will get.
 */
function replay(ctx: CanvasRenderingContext2D, view: View, frame: Frame): void {
  if (frame.length === 0) return;

  ctx.beginPath();

  for (const run of frame) {
    run.points.forEach((p, i) => {
      const q = toScreen(view, p);

      if (i === 0) ctx.moveTo(q.x, q.y);
      else ctx.lineTo(q.x, q.y);
    });
  }

  ctx.strokeStyle = theme.replay;
  ctx.lineWidth = 1.25;
  ctx.lineJoin = 'round';
  ctx.stroke();
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
