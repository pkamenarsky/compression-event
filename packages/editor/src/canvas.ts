import { Value } from '@incpt/kontinuum';
import { VNode, effect } from '@incpt/kontinuum-dom';
import { canvas } from '@incpt/kontinuum-dom/html';
import { Op, select } from '@incpt/kontinuum-interaction';
import { interactive } from '@incpt/kontinuum-interaction/dom';

import { Ring, Shape } from './geometry';
import {
  Input,
  SHIFT,
  blurred,
  keyPressed,
  keyReleased,
  pan,
  pointerMoved,
  pointerPressed,
  pointerReleased,
} from './input';
import {
  Resolved,
  centroid,
  csg,
  hitPolygon,
  hitVertex,
  resolved,
  toLocal,
  withinBox,
} from './scene';
import { theme } from './theme';
import {
  EMPTY_TRANSFORM,
  Point,
  Polygon,
  PolygonId,
  Settings,
  Tool,
  Transform,
  Update,
  View,
  World,
  resized,
  toScreen,
  toWorld,
} from './types';

/** Screen pixels within which a vertex is grabbable, or the first point closes. */
const HANDLE = 9;

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
  selection: Value<PolygonId[]>,
  input: Input,
  update: Update,
): VNode {
  let el: HTMLCanvasElement | undefined;
  let ctx: CanvasRenderingContext2D | null = null;

  /** Where the pointer last was, in world units. Deliberately not state: the
   * gestures that need it read it when they start, and nothing redraws for it. */
  let pointer: Point | null = null;

  const cursor = (value: string) => {
    if (el) {
      el.style.cursor = value;
    }
  };

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
     * Shift arms it, the primary button starts it, and it lasts until the
     * button comes back up: letting shift go mid-drag does not cancel, the way
     * a marquee behaves everywhere else. The box is kept in world units, so it
     * stays over what it was drawn over.
     */
    function* marqueeing(): Op<void> {
      // A modifier does not repeat, so every press until shift is let go is a
      // selection of its own and coming back out here would wait for ever.
      let armed = true;

      while (armed) {
        const start = yield* select({
          pressed: pointerPressed(),
          disarmed: keyReleased(input, ...SHIFT),
          lost: blurred(),
        });

        if (start.tag !== 'pressed') break;

        const a = at(start.value);
        setLocal({ ...local(), marquee: { a, b: a } });

        const end = yield* select({
          dragging: pointerMoved(e => setLocal({ ...local(), marquee: { a, b: at(e) } })),
          done: pointerReleased(),
          lost: blurred(),
        });

        const box = local().marquee;
        setLocal({ ...local(), marquee: null });

        if (end.tag === 'done' && box !== null) {
          const picked = withinBox(resolved(world()), box.a, box.b);
          update(s => ({ ...s, selection: picked }));
        }

        armed = end.tag === 'done' && end.value.shiftKey;
      }
    }

    /** A vertex follows the cursor, written down in the polygon's own frame. */
    function* draggingVertex(id: PolygonId, index: number): Op<void> {
      yield* select({
        dragging: pointerMoved(e => {
          const to = at(e, true);

          update(s => {
            const p = s.world.sourcePolygons.get(id);
            if (p === undefined) return s;

            const points = [...p.points];
            points[index] = toLocal(p, to);

            const sourcePolygons = new Map(s.world.sourcePolygons);
            sourcePolygons.set(id, { ...p, points });

            return { ...s, world: { ...s.world, sourcePolygons } };
          });
        }),
        done: pointerReleased(),
        lost: blurred(),
      });
    }

    /**
     * Hold the key, move the mouse, let go. Every move recomputes from the
     * transforms as they were when the key went down rather than from the last
     * frame, so the gesture cannot drift and letting go leaves exactly what was
     * on screen.
     */
    function* transforming(code: string, mode: Mode): Op<void> {
      const ids = selection();
      const from = pointer;

      if (ids.length === 0 || from === null) return;

      const anchors = new Map<PolygonId, Anchor>();

      for (const id of ids) {
        const p = world().sourcePolygons.get(id);
        if (p !== undefined) anchors.set(id, { transform: p.transform, own: centroid(p.points) });
      }

      // One pivot for the whole selection, so several polygons turn together
      // rather than each about itself.
      const rings = resolved(world()).filter(it => anchors.has(it.id));
      const pivot = centroid(rings.flatMap(it => it.ring));

      cursor('crosshair');

      yield* select({
        moving: pointerMoved(e => {
          const to = at(e);

          update(s => {
            const sourcePolygons = new Map(s.world.sourcePolygons);

            for (const [id, anchor] of anchors) {
              const p = sourcePolygons.get(id);
              if (p === undefined) continue;

              sourcePolygons.set(id, { ...p, transform: mode(anchor, pivot, from, to) });
            }

            return { ...s, world: { ...s.world, sourcePolygons } };
          });
        }),
        done: keyReleased(input, code),
        lost: blurred(),
      });

      cursor('');
    }

    function retype(type: Polygon['type']): void {
      update(s => {
        const sourcePolygons = new Map(s.world.sourcePolygons);

        for (const id of s.selection) {
          const p = sourcePolygons.get(id);
          if (p !== undefined) sourcePolygons.set(id, { ...p, type });
        }

        return { ...s, world: { ...s.world, sourcePolygons } };
      });
    }

    function commit(points: Point[]): void {
      update(s => {
        const id = s.world.nextId;
        const sourcePolygons = new Map(s.world.sourcePolygons);

        sourcePolygons.set(id, { type: 'level', points, transform: EMPTY_TRANSFORM });

        return {
          ...s,
          world: { ...s.world, sourcePolygons, nextId: id + 1 },
          selection: [id],
        };
      });
    }

    /**
     * Clicking lays down a point; clicking the first one again closes the ring.
     * With nothing being drawn, a click near a vertex takes hold of it instead,
     * which is the only way points move for now.
     */
    function* placing(e: PointerEvent): Op<void> {
      const l = local();
      const to = at(e, true);

      if (l.draft !== null) {
        const first = l.draft.points[0];
        const closing = l.draft.points.length >= 3
          && Math.hypot(first.x - to.x, first.y - to.y) * view().zoom <= HANDLE;

        if (closing) {
          commit(l.draft.points);
          setLocal({ ...l, draft: null });
        }
        else {
          setLocal({ ...l, draft: { points: [...l.draft.points, to], at: to } });
        }

        return;
      }

      const hit = hitVertex(resolved(world()), at(e), HANDLE / view().zoom);

      if (hit !== null) {
        yield* draggingVertex(hit.id, hit.index);
        return;
      }

      setLocal({ ...l, draft: { points: [to], at: to } });
    }

    function picking(e: PointerEvent): void {
      const id = hitPolygon(resolved(world()), at(e));

      update(s => ({ ...s, selection: id === null ? [] : [id] }));
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
            () => [world(), settings(), view(), tool(), selection(), local()] as const,
            ([w, s, v, t, sel, l]) => {
              if (el && ctx) {
                draw(el, ctx, v, layers(w, s, v, t, sel, l));
              }
            },
          ),
        ],
      ),

      run: function* () {
        while (true) {
          // Nothing here decides anything: it waits for the next thing to
          // happen and hands it to whoever the current tool says owns it.
          const started = yield* select({
            key: input.keyDown,
            press: pointerPressed(),

            // Never resumes. It is here to keep the pointer known and the
            // rubber band moving for as long as nothing else is going on.
            tracking: pointerMoved(e => {
              pointer = at(e);

              const l = local();
              if (l.draft !== null) setLocal({ ...l, draft: { ...l.draft, at: at(e, true) } });
            }),

            lost: blurred(),
          });

          if (started.tag === 'key') {
            const e = started.value;

            if (e.code === 'Space') {
              // Resumed inside the listener, so space does not also scroll
              e.preventDefault();
              yield* panning();
            }
            else if (SHIFT.includes(e.code)) {
              yield* marqueeing();
            }
            else if (e.code === 'Escape') {
              setLocal({ ...local(), draft: null });
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
            if (tool() === 'point') {
              yield* placing(started.value);
            }
            else if (tool() === 'polygon') {
              picking(started.value);
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
}

const EMPTY_LOCAL: Local = { marquee: null, draft: null };

// -----------------------------------------------------------------------------
// The modal transforms
// -----------------------------------------------------------------------------

/** A polygon's transform as it was when the key went down, and its own pivot. */
interface Anchor {
  transform: Transform
  own: Point
}

type Mode = (anchor: Anchor, pivot: Point, from: Point, to: Point) => Transform;

/**
 * A polygon turns and scales about its own centroid, so moving the selection
 * about a shared pivot means carrying that centroid around the pivot as well —
 * otherwise several polygons would each spin on the spot.
 */
function orbit(anchor: Anchor, pivot: Point, turn: number, factor: number): Transform {
  const { transform: t, own } = anchor;

  const cx = own.x + t.translation.x - pivot.x;
  const cy = own.y + t.translation.y - pivot.y;

  const c = Math.cos(turn), s = Math.sin(turn);

  return {
    ...t,
    rotation: t.rotation + turn,
    scale: t.scale * factor,
    translation: {
      x: pivot.x + (cx * c - cy * s) * factor - own.x,
      y: pivot.y + (cx * s + cy * c) * factor - own.y,
    },
  };
}

const TRANSFORMS: Record<string, Mode> = {
  KeyT: ({ transform: t }, _pivot, from, to) => ({
    ...t,
    translation: {
      x: t.translation.x + to.x - from.x,
      y: t.translation.y + to.y - from.y,
    },
  }),

  KeyR: (anchor, pivot, from, to) => orbit(
    anchor,
    pivot,
    Math.atan2(to.y - pivot.y, to.x - pivot.x)
      - Math.atan2(from.y - pivot.y, from.x - pivot.x),
    1,
  ),

  KeyS: (anchor, pivot, from, to) => {
    const was = Math.hypot(from.x - pivot.x, from.y - pivot.y);
    const now = Math.hypot(to.x - pivot.x, to.y - pivot.y);

    return was < 1e-6 ? anchor.transform : orbit(anchor, pivot, 0, now / was);
  },

  KeyE: ({ transform: t }, _pivot, from, to) => ({
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

/**
 * Back to front. The CSG goes over the polygons that made it, because it is the
 * answer and they are the working.
 */
function layers(
  world: World,
  settings: Settings,
  view: View,
  tool: Tool,
  selection: PolygonId[],
  local: Local,
): Layer[] {
  const items = resolved(world);
  const out: Layer[] = [];

  if (settings.showGrid) out.push(ctx => grid(ctx, settings, view));

  out.push(ctx => axes(ctx, view));
  out.push(ctx => polygons(ctx, view, items, selection, tool === 'point'));
  out.push(ctx => set(ctx, view, csg(items)));

  if (local.draft !== null) out.push(ctx => draft(ctx, view, local.draft!));
  if (local.marquee !== null) out.push(ctx => marquee(ctx, view, local.marquee!));

  return out;
}

function trace(ctx: CanvasRenderingContext2D, view: View, ring: Ring): void {
  ring.forEach((p, i) => {
    const s = toScreen(view, p);

    if (i === 0) ctx.moveTo(s.x, s.y);
    else ctx.lineTo(s.x, s.y);
  });

  ctx.closePath();
}

/** The polygons as drawn: outlines only, so the CSG over them stays readable. */
function polygons(
  ctx: CanvasRenderingContext2D,
  view: View,
  items: Resolved[],
  selection: PolygonId[],
  handles: boolean,
): void {
  for (const it of items) {
    const picked = selection.includes(it.id);

    ctx.beginPath();
    trace(ctx, view, it.ring);

    ctx.strokeStyle = picked
      ? theme.picked
      : it.polygon.type === 'solid' ? theme.solid : theme.level;

    ctx.lineWidth = picked ? 2 : 1;
    ctx.setLineDash(it.polygon.type === 'solid' ? [5, 3] : []);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (!handles) return;

  ctx.beginPath();

  for (const it of items) {
    for (const p of it.ring) {
      const s = toScreen(view, p);
      ctx.rect(Math.round(s.x) - 2.5, Math.round(s.y) - 2.5, 5, 5);
    }
  }

  ctx.fillStyle = theme.vertex;
  ctx.fill();
}

/** The set the game would see, over the top and in the one colour that says so. */
function set(ctx: CanvasRenderingContext2D, view: View, shape: Shape): void {
  if (shape.length === 0) return;

  ctx.beginPath();

  for (const ring of shape) {
    trace(ctx, view, ring);
  }

  ctx.strokeStyle = theme.csg;
  ctx.lineWidth = 2;
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
