// -----------------------------------------------------------------------------
// The 3D view
//
// A panel holding the game's own renderer. Not a preview of the editor's
// drawing in three dimensions — the game's walls, exactly: the same extrusion,
// the same shading. Whatever this shows is what the game will show.
//
// Live, and the bake is not a precondition
// ----------------------------------------
// What this draws while anyone is editing is the CSG at the version on screen,
// which the editor already keeps — `worldset` maintains it incrementally for
// the 2D canvas, and an edit costs about a millisecond of it even on a large
// level. So an edit shows up here as it is made, on an unbaked world, from the
// first polygon drawn.
//
// The bake is for *movement*. It exists so the game can go between two versions
// without resolving anything, and this reaches for it only while a transition
// is actually playing. Where a span has been baked, the transition is the one
// the player will see, at the speed they will see it, over geometry the bake
// actually produced. Where it has not, the version switch simply snaps — which
// is what the jam build did, and is not a reason to show nothing.
//
// What it costs, and when
// -----------------------
// A WebGL context, so it is asked for rather than assumed: `preview` in the
// store says whether it is up, and nothing here exists while it is down.
//
// Every edit rebuilds the wall buffers whole. `worldset` hands back a diff
// naming the pieces an edit disturbed, so the answer when that starts to hurt
// is a geometry pool keyed by piece rather than a rebuild; a level of a few
// hundred polygons will not notice.
// -----------------------------------------------------------------------------

import { Value } from '@incpt/kontinuum';
import { VNode, effect, show, text } from '@incpt/kontinuum-dom';
import { div } from '@incpt/kontinuum-dom/html';

import { Point, Renderer, SCALE, renderer } from '@ce/game';
import { Bake, spanAt } from './bake';
import { bakedLevel } from './export';
import { EMPTY_LIVE, Live, live, resolveAt, runs } from './scene';
import { theme } from './theme';
import { Replay, VersionId, World } from './types';

interface Orbit {
  angle: number
  pitch: number
  distance: number
  x: number
  z: number
  held: boolean
}

const WIDTH = 380;
const HEIGHT = 260;

/** Vertical, in radians, and the one the framing is worked out against. */
const FOV = 60 * Math.PI / 180;

/**
 * How far back the camera sits, as a multiple of what it has to fit.
 *
 * The level's diagonal over the tangent of the half angle is where it exactly
 * fills the frame; the rest is air, so that a room at the edge does not sit on
 * the edge.
 */
const MARGIN = 1.25;

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

  /** How many spans the renderer currently holds. The walk is measured against
   * this rather than against the chain's length: a half-baked level should show
   * the half it has rather than race through all of it. */
  let spans = 0;

  /**
   * The CSG at the version on screen, kept between edits.
   *
   * Its own rather than the canvas', which keeps one too. Both are caches of
   * the same thing and `live` is incremental, so the second costs a pass over
   * what actually moved; sharing one would mean threading a mutable cache
   * through the reactive tree to save about a millisecond.
   */
  let set: Live = EMPTY_LIVE;

  /** Where the camera is looking and from how far, in world units. `held` once
   * someone has moved it themselves. */
  const orbit: Orbit = { angle: 0.9, pitch: 0.75, distance: 20, x: 0, z: 0, held: false };

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
   * Where the walk has got to, or nothing at all.
   *
   * Nothing at all is the ordinary case: standing at a version, what is drawn
   * is the boundary `shown` last put there, and the bake is not consulted. A
   * transition over a span that was never baked is also nothing at all, and
   * snaps.
   */
  const walked = (r: Replay | null): void => {
    if (view === null) return;

    if (r === null || spans === 0) {
      view.walk(null);
      return;
    }

    const at = r.from + (r.to - r.from) * r.at;

    view.walk(Math.min(Math.max(at / spans, 0), 1));
  };

  /** The boundary at the version on screen, which is what is drawn whenever
   * nothing is in flight. */
  const shown = (w: World, v: VersionId): void => {
    if (view === null) return;

    set = live(set, resolveAt(w, v));

    const outline = runs(set) as Point[][];

    view.show(outline);
    framed(outline, orbit);
    placed();
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

        orbit.held = true;

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

        orbit.held = true;
        orbit.distance = Math.max(2, orbit.distance * Math.exp(e.deltaY * 0.001));
        placed();
      },
    },
    [
      // The renderer owns everything inside this: it appends its own canvas and
      // watches the box for resizes.
      effect(() => {
        if (host === undefined) return;

        view = renderer(host, { dither: false, fov: FOV * 180 / Math.PI });

        let frame = requestAnimationFrame(function tick() {
          view?.render();
          frame = requestAnimationFrame(tick);
        });

        return () => {
          cancelAnimationFrame(frame);
          view?.dispose();
          view = null;
          set = EMPTY_LIVE;
          spans = 0;
        };
      }),

      // The boundary, rebuilt as it is edited. No bake anywhere in this.
      effect(
        () => [world(), current()] as const,
        ([w, v]) => shown(w, v),
      ),

      // The bake, held ready for the next transition. Nothing is played off one
      // that no longer stands: `spanAt` decides, against the world in front of
      // it, and an edit that invalidates a span takes the animation away and
      // leaves the geometry alone.
      effect(
        () => [world(), bake()] as const,
        ([w, b]) => {
          if (view === null) return;

          const baked = spanAt(b, w, 0) === null ? { spans: [] } : bakedLevel(b, w);

          spans = baked.spans.length;

          view.load({ paths: [], versions: [], artefacts: [], baked });
          walked(replay());
        },
      ),

      effect(replay, r => walked(r)),

      label(bake, world),
    ],
  );
}

/**
 * Where the camera looks, and from how far.
 *
 * Only until someone takes hold of it: an edit that moved a wall should not
 * also fly the camera somewhere, so once the view has been turned or zoomed it
 * is theirs and this stops writing to it.
 */
function framed(outline: readonly Point[][], orbit: Orbit): void {
  if (orbit.held) return;

  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;

  for (const run of outline) {
    for (const p of run) {
      minX = Math.min(minX, p.x * SCALE);
      maxX = Math.max(maxX, p.x * SCALE);
      minZ = Math.min(minZ, p.y * SCALE);
      maxZ = Math.max(maxZ, p.y * SCALE);
    }
  }

  if (!isFinite(minX)) return;

  orbit.x = (minX + maxX) / 2;
  orbit.z = (minZ + maxZ) / 2;
  const across = Math.hypot(maxX - minX, maxZ - minZ);

  orbit.distance = Math.max(4, across / (2 * Math.tan(FOV / 2)) * MARGIN);
}

/**
 * What the transitions will do, which is the only thing about this view the
 * bake still decides.
 *
 * The geometry is always there. What a bake buys is the walk between two
 * versions; without one a switch arrives rather than happens, and saying so is
 * better than leaving someone to wonder whether it is broken.
 */
function label(bake: Value<Bake>, world: Value<World>): VNode {
  const says = (): string => {
    const b = bake(), w = world();

    if (b.progress !== null) return `baking ${Math.round(b.progress * 100)}%`;

    return spanAt(b, w, 0) === null ? 'not baked · switches snap' : 'drag to turn · wheel to zoom';
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
