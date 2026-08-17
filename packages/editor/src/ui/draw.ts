import { World } from '../world';
import { Settings } from '../settings';
import { View } from '../view';
import { theme } from '../theme';

/** Below this many CSS pixels between dots the grid stops being a grid. */
const MIN_DOT_SPACING = 8;

/** The whole canvas, from scratch. Everything below works in CSS pixels. */
export function draw(
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
