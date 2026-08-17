import { Value } from '@incpt/kontinuum';
import { VNode, effect } from '@incpt/kontinuum-dom';
import { canvas } from '@incpt/kontinuum-dom/html';
import { select } from '@incpt/kontinuum-interaction';
import { interactive } from '@incpt/kontinuum-interaction/dom';

import { Input, blurred, keyPressed, keyReleased, pan } from './input';
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
// Drawing
//
// Everything below works in CSS pixels; the transform takes care of the rest.
// -----------------------------------------------------------------------------

/** Below this many CSS pixels between dots the grid stops being a grid. */
const MIN_DOT_SPACING = 8;

function draw(
  el: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  world: World,
  settings: Settings,
  view: View,
): void {
  const width = Math.max(1, Math.round(view.width * view.dpr));
  const height = Math.max(1, Math.round(view.height * view.dpr));

  // Sizing the backing store clears it, so only do it when it really changed
  if (el.width !== width || el.height !== height) {
    el.width = width;
    el.height = height;
  }

  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);

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
