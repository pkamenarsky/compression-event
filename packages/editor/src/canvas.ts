import { Value } from '@incpt/kontinuum';
import { VNode, effect } from '@incpt/kontinuum-dom';
import { canvas } from '@incpt/kontinuum-dom/html';
import { select } from '@incpt/kontinuum-interaction';
import { interactive } from '@incpt/kontinuum-interaction/dom';

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
import { theme } from './theme';
import { Settings, Update, View, World, resized } from './types';

/**
 * The world, drawn, and the ways of getting about in it.
 *
 * The element is kept by `ref` and never re-created; everything that happens to
 * it happens either in the effects nested inside it or in the loop beside it.
 * Because the data is read in the effect's value function, the canvas wakes for
 * a change to the world, the settings or the view, and for nothing else.
 *
 * Holding space pans: the loop waits for the key, then races the pan against
 * letting go of it, so the mode is where the loop stands rather than a flag
 * somebody has to remember to clear. Losing focus ends it down the same path,
 * which is why the cursor cannot get stuck.
 */
export function worldCanvas(
  world: Value<World>,
  settings: Value<Settings>,
  view: Value<View>,
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

  return interactive(() => ({
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
          () => [world(), settings(), view()] as const,
          ([w, s, v]) => {
            if (el && ctx) {
              draw(el, ctx, w, s, v);
            }
          },
        ),
      ],
    ),

    run: function* () {
      while (true) {
        // Signals resume their waiters where they were emitted, so this is
        // still inside the listener and space does not also reach the page
        (yield* keyPressed(input, 'Space')).preventDefault();

        cursor('grab');

        yield* select({
          panning: pan(update),
          done: keyReleased(input, 'Space'),
          lost: blurred(),
        });

        cursor('');
      }
    },
  }));
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
// The selection overlay
// -----------------------------------------------------------------------------

/** In CSS pixels from the canvas' top-left corner, and not yet normalised. */
interface Marquee {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * A second, transparent canvas over the first, holding nothing but the
 * selection rectangle being dragged. It is the whole of this canvas' state and
 * nobody else's business, so it lives in the `interactive` rather than in the
 * store, and leaves when the drag does.
 *
 * Shift arms it, the primary button starts it, and it lasts until the button
 * comes back up: letting shift go mid-drag does not cancel, the way a marquee
 * behaves everywhere else. Sizing is the world canvas' job — both fill the same
 * box, so this one takes the measurement it already made.
 */
export function selectionCanvas(view: Value<View>, input: Input): VNode {
  let el: HTMLCanvasElement | undefined;
  let ctx: CanvasRenderingContext2D | null = null;

  return interactive<Marquee | null>(null, (marquee, setMarquee) => ({
    view: canvas(
      {
        style: {
          display: 'block',
          position: 'absolute',
          inset: '0',
          width: '100%',
          height: '100%',

          // So the world canvas underneath keeps saying what the cursor is
          pointerEvents: 'none',
        },

        ref: (node: HTMLCanvasElement) => {
          el = node;
          ctx = node.getContext('2d');
        },
      },
      effect(
        () => [view(), marquee()] as const,
        ([v, m]) => {
          if (el && ctx) {
            drawMarquee(el, ctx, v, m);
          }
        },
      ),
    ),

    run: function* () {
      while (true) {
        yield* keyPressed(input, ...SHIFT);

        // Shift stays down until it is let go, and every press until then is a
        // selection of its own — a modifier does not repeat, so coming back up
        // here between drags would wait for a keypress that never arrives.
        let armed = true;

        while (armed) {
          const start = yield* select({
            pressed: pointerPressed(),
            disarmed: keyReleased(input, ...SHIFT),
            lost: blurred(),
          });

          if (start.tag !== 'pressed') {
            break;
          }

          // The canvas cannot move mid-drag, so one measurement covers it
          const bounds = el?.getBoundingClientRect();
          const left = bounds?.left ?? 0;
          const top = bounds?.top ?? 0;

          const x0 = start.value.clientX - left;
          const y0 = start.value.clientY - top;

          setMarquee({ x0, y0, x1: x0, y1: y0 });

          const end = yield* select({
            dragging: pointerMoved(e => setMarquee({
              x0,
              y0,
              x1: e.clientX - left,
              y1: e.clientY - top,
            })),
            done: pointerReleased(),
            lost: blurred(),
          });

          setMarquee(null);

          // Letting shift go mid-drag does not cancel the drag, but it does end
          // the arming — and the event knows, so nothing here has to remember
          armed = end.tag === 'done' && end.value.shiftKey;
        }
      }
    },
  }));
}

// -----------------------------------------------------------------------------
// Drawing
//
// Everything below works in CSS pixels; the transform takes care of the rest.
// -----------------------------------------------------------------------------

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
  world: World,
  settings: Settings,
  view: View,
): void {
  prepare(el, ctx, view);

  ctx.fillStyle = theme.canvas;
  ctx.fillRect(0, 0, view.width, view.height);

  if (settings.showGrid) {
    drawGrid(ctx, settings, view);
  }

  drawAxes(ctx, view);
}

/**
 * A dot per grid intersection, as one path so that the fill is a single call.
 * The loop counts grid lines rather than accumulating a step, which keeps the
 * dots where they belong however far the view has been panned.
 */
function drawGrid(ctx: CanvasRenderingContext2D, settings: Settings, view: View): void {
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

/** The rubber band, over an otherwise empty canvas. */
function drawMarquee(
  el: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  view: View,
  marquee: Marquee | null,
): void {
  prepare(el, ctx, view);
  ctx.clearRect(0, 0, view.width, view.height);

  if (marquee === null) {
    return;
  }

  const x = Math.round(Math.min(marquee.x0, marquee.x1));
  const y = Math.round(Math.min(marquee.y0, marquee.y1));
  const width = Math.round(Math.abs(marquee.x1 - marquee.x0));
  const height = Math.round(Math.abs(marquee.y1 - marquee.y0));

  ctx.fillStyle = theme.selectionFill;
  ctx.fillRect(x, y, width, height);

  ctx.strokeStyle = theme.selection;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, width, height);
}

/** The world's two axes, so that a pan has something to be relative to. */
function drawAxes(ctx: CanvasRenderingContext2D, view: View): void {
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
