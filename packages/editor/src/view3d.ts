// -----------------------------------------------------------------------------
// The 3D view
//
// A panel holding the game's own renderer, fed from the live bake. Not a
// preview of the editor's drawing in three dimensions — the game's, exactly:
// the same buffers, the same vertex shader, the same walls. Whatever this shows
// is what the game will show, and if the two ever disagree it is this that is
// right.
//
// It follows the version on screen, and it follows the walk between two of them
// on the same clock the canvas does. So switching version here is the
// transition the player will see, at the speed they will see it, over geometry
// the bake actually produced.
//
// What it costs, and when
// -----------------------
// A WebGL context and a walk of the whole bake, so it is asked for rather than
// assumed: `preview` in the store says whether it is up, and nothing here
// exists while it is down.
//
// The shipped world is rebuilt when the bake changes and at no other time. An
// edit invalidates the spans it touched, which changes the bake, which empties
// what is shown — so what is on screen is either the bake or nothing, and never
// a stale bake dressed up as a current one. That is the same promise `replayed`
// makes on the canvas, and for the same reason: quietly resolving the version
// instead would show something the game will never get.
// -----------------------------------------------------------------------------

import { Value } from '@incpt/kontinuum';
import { VNode, effect, show, text } from '@incpt/kontinuum-dom';
import { div } from '@incpt/kontinuum-dom/html';

import { Renderer, SCALE, World as GameWorld, renderer } from '@ce/game';
import { Bake, spanAt } from './bake';
import { shipped } from './export';
import { theme } from './theme';
import { Replay, VersionId, World } from './types';

const WIDTH = 380;
const HEIGHT = 260;

/** How far back the camera sits, as a multiple of the level's own size. */
const BACK = 0.75;
const UP = 0.85;

/** Radians per pixel dragged. */
const TURN = 0.008;
/** How far the elevation may be pushed before it is looking through the floor
 * or straight down the y axis, both of which are useless. */
const PITCH = [0.08, 1.45];

export function preview(
  showing: Value<boolean>,
  world: Value<World>,
  bake: Value<Bake>,
  current: Value<VersionId>,
  replay: Value<Replay | null>,
): VNode {
  return show(showing, panel(world, bake, current, replay));
}

function panel(
  world: Value<World>,
  bake: Value<Bake>,
  current: Value<VersionId>,
  replay: Value<Replay | null>,
): VNode {
  let host: HTMLDivElement | undefined;
  let view: Renderer | null = null;
  let level: GameWorld | null = null;

  /** Where the camera is looking and from how far, in world units. */
  const orbit = { angle: 0.9, pitch: 0.75, distance: 20, x: 0, z: 0 };

  const placed = (): void => {
    if (view === null) return;

    const flat = Math.cos(orbit.pitch) * orbit.distance;

    view.camera.position.set(
      orbit.x + Math.cos(orbit.angle) * flat,
      Math.sin(orbit.pitch) * orbit.distance,
      orbit.z + Math.sin(orbit.angle) * flat,
    );

    view.camera.lookAt(orbit.x, 0, orbit.z);
  };

  /**
   * Where in the walk the renderer should be, as a fraction of everything it
   * was given.
   *
   * The version being watched is a position along the chain; the renderer's own
   * scale is however many spans it holds, which is fewer whenever the bake is
   * unfinished. Dividing by the second rather than by the chain's length is
   * what keeps a half-baked level showing the half it has instead of racing
   * through it.
   */
  const seek = (v: VersionId, r: Replay | null): void => {
    if (view === null || level === null) return;

    const spans = level.baked.spans.length;
    if (spans === 0) return;

    const at = r === null ? v : r.from + (r.to - r.from) * r.at;

    view.seek(Math.min(Math.max(at / spans, 0), 1));
  };

  return div(
    {
      style: {
        position: 'absolute',
        right: '12px',
        bottom: '12px',
        width: `${WIDTH}px`,
        height: `${HEIGHT}px`,
        background: theme.canvas,
        border: `1px solid ${theme.border}`,
        borderRadius: '8px',
        overflow: 'hidden',
        boxShadow: `0 6px 18px ${theme.panelShadow}`,
      },

      // Runs before the children below register, so they can count on it.
      ref: (node: HTMLDivElement) => {
        host = node;
      },

      // The canvas underneath is listening for drags of its own, and a turn of
      // the camera is not a pan of the world.
      onpointerdown: (e: PointerEvent) => {
        e.stopPropagation();
        if (host === undefined) return;

        host.setPointerCapture(e.pointerId);

        let x = e.clientX, y = e.clientY;

        const moved = (m: PointerEvent) => {
          orbit.angle += (m.clientX - x) * TURN;
          orbit.pitch = Math.min(
            PITCH[1],
            Math.max(PITCH[0], orbit.pitch + (m.clientY - y) * TURN),
          );

          x = m.clientX;
          y = m.clientY;

          placed();
        };

        const done = () => {
          host?.removeEventListener('pointermove', moved);
          host?.removeEventListener('pointerup', done);
          host?.removeEventListener('pointercancel', done);
        };

        host.addEventListener('pointermove', moved);
        host.addEventListener('pointerup', done);
        host.addEventListener('pointercancel', done);
      },

      onwheel: (e: WheelEvent) => {
        e.preventDefault();
        e.stopPropagation();

        orbit.distance = Math.max(2, orbit.distance * Math.exp(e.deltaY * 0.001));
        placed();
      },
    },
    [
      // The renderer owns everything inside this: it appends its own canvas and
      // watches the box for resizes.
      effect(() => {
        if (host === undefined) return;

        view = renderer(host, { dither: false, fov: 60 });

        let frame = requestAnimationFrame(function tick() {
          view?.render();
          frame = requestAnimationFrame(tick);
        });

        return () => {
          cancelAnimationFrame(frame);
          view?.dispose();
          view = null;
          level = null;
        };
      }),

      effect(
        () => [world(), bake()] as const,
        ([w, b]) => {
          if (view === null) return;

          // Nothing is shown off a bake that no longer stands. `spanAt` is what
          // decides, and it decides against the world in front of it.
          level = spanAt(b, w, 0) === null ? null : shipped(w, b);

          view.load(level ?? { paths: [], versions: [], artefacts: [], baked: { spans: [] } });

          if (level !== null) framed(level, orbit);

          placed();
          seek(current(), replay());
        },
      ),

      effect(
        () => [current(), replay()] as const,
        ([v, r]) => seek(v, r),
      ),

      label(bake, world),
    ],
  );
}

/** The level's middle and how big it is, so the camera starts looking at it
 * rather than at wherever the origin happens to be. */
function framed(level: GameWorld, orbit: { distance: number, x: number, z: number }): void {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;

  for (const version of level.versions) {
    for (const polygon of version.polygons) {
      for (const p of polygon.points) {
        minX = Math.min(minX, p.x * SCALE);
        maxX = Math.max(maxX, p.x * SCALE);
        minZ = Math.min(minZ, p.y * SCALE);
        maxZ = Math.max(maxZ, p.y * SCALE);
      }
    }
  }

  if (!isFinite(minX)) return;

  orbit.x = (minX + maxX) / 2;
  orbit.z = (minZ + maxZ) / 2;
  orbit.distance = Math.max(4, Math.hypot(maxX - minX, maxZ - minZ) * BACK / UP);
}

/** What is on screen, or why nothing is. */
function label(bake: Value<Bake>, world: Value<World>): VNode {
  const says = (): string => {
    const b = bake(), w = world();

    if (b.progress !== null) return `baking ${Math.round(b.progress * 100)}%`;

    return spanAt(b, w, 0) === null ? 'not baked' : 'drag to turn · wheel to zoom';
  };

  return div(
    {
      style: {
        position: 'absolute',
        left: '8px',
        bottom: '6px',
        color: theme.muted,
        font: '11px ui-monospace, SFMono-Regular, Menlo, monospace',
        pointerEvents: 'none',
        textShadow: '0 1px 2px rgba(0, 0, 0, 0.8)',
      },
    },
    [text(says)],
  );
}
