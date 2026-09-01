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

import { Value, untracked } from '@incpt/kontinuum';
import { VNode, effect, show, stateful, text } from '@incpt/kontinuum-dom';
import { div } from '@incpt/kontinuum-dom/html';

import { Artefacts, EYE, Point, Renderer, SCALE, WALK_SPEED, artefacts, renderer, urged } from '@ce/game';
import { Bake, artefactsDuring, spanAt } from './bake';
import { bakedLevel, floorsAt } from './export';
import {
  EMPTY_LIVE,
  Live,
  artefactsAt,
  contributing,
  live,
  resolveAt,
  sourced,
  startPlaced,
} from './scene';
import { theme } from './theme';
import { Replay, Update, VersionId, World } from './types';

/**
 * Standing in it: where the walker is and which way they are facing.
 *
 * No pitch. Looking up and down in a level whose walls are the whole subject
 * buys nothing and costs the horizon, so the mouse turns and only turns.
 */
interface Walker {
  x: number
  z: number
  angle: number
  /** Carried between frames, so that setting off and stopping have the weight
   * they have in the game. */
  vx: number
  vz: number
}

interface Orbit {
  angle: number
  pitch: number
  distance: number
  x: number
  z: number
  held: boolean
}

const WIDTH = 640;
const HEIGHT = 480;

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

/**
 * How someone stands in the level and how fast they cross it: the game's own
 * numbers, so that walking the panel and walking the game are the same person
 * moving. There is no collision here — the walls are there to be read, and
 * being stopped by one while trying to see behind it is not what this is for,
 * which is the one thing about it that differs.
 */

/** World units per pixel dragged, walking in the panel. A drag from the top of
 * it to the bottom crosses a couple of rooms. */
const STEP = 0.04;

/** Radians per pixel of mouse movement, turning. */
const LOOK = 0.0022;

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
  roaming: Value<boolean>,
  update: Update,
): VNode {
  return show(showing, panel(world, bake, current, replay, roaming, update));
}

function panel(
  world: Value<World>,
  bake: Value<Bake>,
  current: Value<VersionId>,
  replay: Value<Replay | null>,
  roaming: Value<boolean>,
  update: Update,
): VNode {
  let host: HTMLDivElement | undefined;
  let view: Renderer | null = null;

  /** The artefacts in the scene, which the renderer knows nothing about: it
   * draws the level and lends out the scene, and this puts things in it. */
  let crowd: Artefacts | null = null;

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

  /** Where whoever is inside it is standing, and what they are holding down.
   * Both are read every frame and neither is state anything else looks at. */
  const walker: Walker = { x: 0, z: 0, angle: 0, vx: 0, vz: 0 };
  const held = new Set<string>();

  /**
   * Which of the two the little panel is showing, and everything under it.
   *
   * Not in the store: it is how someone happens to be looking at their level
   * this minute, it survives nothing, and nothing outside this reads it. The
   * full-window walk *is* in the store, because the editor has to know that
   * its keyboard has been taken.
   *
   * It is a state rather than a plain flag only so that the line along the
   * bottom, which says which gesture does what, changes when the gesture does.
   */
  return stateful(false, (inside, setInside) => {
    /**
     * Standing in it either way: the full window with the pointer captured, or
     * the panel in the corner with a drag doing the walking.
     *
     * Both read `untracked`, and it matters. An effect is invalidated by
     * whatever its *body* reads, not only by what its dependency function
     * names, and `shown` — which rebuilds the wall buffers — calls this on the
     * way past. Read plainly, standing up would cost a full rebuild of the
     * level, for a camera move.
     */
    const afoot = (): boolean => untracked(roaming) || untracked(inside);

    const placed = (): void => {
      if (view === null) return;

      // Which way the level is being looked at, which decides what is worth
      // drawing as well as from where. Said here rather than at each of the
      // three places that change it: this runs after every one of them.
      crowd?.overhead(!afoot());

      // The dither is what being in the level looks like. From above it is a
      // pattern over geometry someone is trying to read.
      view.dither(afoot());

      if (afoot()) {
        view.camera.position.set(walker.x, EYE, walker.z);
        view.camera.lookAt(
          walker.x + Math.sin(walker.angle),
          EYE,
          walker.z - Math.cos(walker.angle),
        );

        return;
      }

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
    /**
     * Whether there is anything to play.
     *
     * `spans` counts the spans that have been baked and still stand, from the
     * first — `bakedLevel` stops at the first one that has not — so versions 0
     * to `spans` are the ones with a picture between them. A walk reaching past
     * that has none, and playing it anyway put the clamped end of the last span
     * on screen at both ends of the transition, which reads as the level
     * blinking out and back.
     */
    const playing = (r: Replay | null): r is Replay =>
      r !== null && Math.max(r.from, r.to) <= spans;

    const walked = (r: Replay | null): void => {
      if (view === null) return;

      peopled(untracked(world), untracked(current), r);

      if (!playing(r)) {
        view.walk(null);
        return;
      }

      const at = r.from + (r.to - r.from) * r.at;

      view.walk(Math.min(Math.max(at / spans, 0), 1));
    };

    /**
     * Where the artefacts are, which is the one thing in the view worked out on
     * the CPU.
     *
     * It could ride the bake like everything else — an artefact is a slot in
     * the frame table and a point in it — but there are a handful of them and
     * a level's worth of walls, and the arithmetic that would go into the
     * shader is the arithmetic that is already written here. Where a walk has
     * no bake to play, they stand at the version on screen: a diamond flying
     * alone past walls that have not moved is a glitch rather than a walk, and
     * that is the same rule the canvas keeps.
     */
    const peopled = (w: World, v: VersionId, r: Replay | null): void => {
      if (crowd === null) return;

      // The start with them, standing still: it is in no version's layer, so
      // there is nothing for a walk to carry it along. Drawn from above only —
      // see `overhead` — which is where it is a mark on the floor.
      const shown = [
        startPlaced(w),
        ...(playing(r) ? artefactsDuring(w, r.from, r.to, r.at) : artefactsAt(w, v)),
      ];

      crowd.show(shown.map(it => ({ id: it.id, type: it.type, x: it.at.x, y: it.at.y })));
    };

    /**
     * One frame of walking.
     *
     * Off the two axes of the facing rather than off the keys directly, so that
     * holding two of them goes diagonally at the same speed rather than at root
     * two of it.
     */
    const stepped = (dt: number): void => {
      if (view === null) return;

      const ahead = (held.has('KeyW') ? 1 : 0) - (held.has('KeyS') ? 1 : 0);
      const across = (held.has('KeyD') ? 1 : 0) - (held.has('KeyA') ? 1 : 0);

      let want = { x: 0, y: 0 };

      if (ahead !== 0 || across !== 0) {
        const l = Math.hypot(ahead, across);
        const sin = Math.sin(walker.angle), cos = Math.cos(walker.angle);

        want = {
          x: (sin * ahead + cos * across) / l * WALK_SPEED,
          y: (-cos * ahead + sin * across) / l * WALK_SPEED,
        };
      }

      // The game's own acceleration, so that setting off and stopping feel the
      // same here as they do in it.
      const sped = urged({ x: walker.vx, y: walker.vz }, want, dt);

      walker.vx = sped.x;
      walker.vz = sped.y;
      walker.x += walker.vx * dt;
      walker.z += walker.vz * dt;

      placed();
    };

    /** The boundary at the version on screen, and the floors under it: what is
     * drawn whenever nothing is in flight. The span's own buffers have both for
     * the length of a walk. */
    const shown = (w: World, v: VersionId): void => {
      if (view === null) return;

      set = live(set, contributing(w, v, resolveAt(w, v)));

      const outline = sourced(set);

      // The floors off the resolved polygons rather than out of `versionOf`,
      // which would union the whole level to answer a question the union has
      // nothing to do with. Which is also how the bake takes them — see
      // `subjects` — so the still and the morph draw the same floors.
      view.show(outline, floorsAt(w, v));
      peopled(w, v, untracked(replay));

      if (!afoot()) framed(outline, orbit);

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

        // Standing up and lying back down. Two views of the same level and one
        // gesture between them, so that a wall can be moved on the canvas and
        // looked at from the floor without leaving the drawing.
        ondblclick: (e: MouseEvent) => {
          e.stopPropagation();
          if (roaming()) return;

          const next = !untracked(inside);

          setInside(next);

          if (next) stood(orbit, walker);

          placed();
        },

        // The canvas underneath is listening for drags of its own, and a turn of
        // the camera is not a pan of the world.
        onpointerdown: (e: PointerEvent) => {
          e.stopPropagation();
          if (host === undefined || roaming()) return;

          host.setPointerCapture(e.pointerId);

          let x = e.clientX, y = e.clientY;

          orbit.held = true;

          const moved = (m: PointerEvent) => {
            const dx = m.clientX - x, dy = m.clientY - y;

            x = m.clientX;
            y = m.clientY;

            // Inside, the same drag is walking rather than orbiting: up and
            // down goes forward and back, and across turns — or strafes, with
            // the command key down, for keeping a wall in view while moving
            // past it. No pointer lock, because the whole point of the panel
            // is that the cursor is still the editor's: let go and it is a
            // mouse again.
            //
            // The key is read off each move rather than off the press, so it
            // can be taken and let go in the middle of one drag.
            if (inside()) {
              if (m.metaKey || m.ctrlKey) {
                walker.x += Math.cos(walker.angle) * dx * STEP;
                walker.z += Math.sin(walker.angle) * dx * STEP;
              }
              else {
                walker.angle += dx * TURN;
              }

              walker.x -= Math.sin(walker.angle) * dy * STEP;
              walker.z += Math.cos(walker.angle) * dy * STEP;

              placed();
              return;
            }

            orbit.angle += dx * TURN;
            orbit.pitch = Math.min(PITCH[1], Math.max(PITCH[0], orbit.pitch + dy * TURN));

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

          if (afoot()) return;

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
          crowd = artefacts(view.scene);

          peopled(untracked(world), untracked(current), untracked(replay));

          let last = performance.now();

          let frame = requestAnimationFrame(function tick(now: number) {
            // Capped, so that a tab left in the background does not come back and
            // fly whoever is standing in it through a wall in one step.
            const dt = Math.min(0.1, (now - last) / 1000);

            last = now;

            if (roaming()) stepped(dt);

            // Every frame, walk or no walk: turning and bobbing is what an
            // artefact does while nothing at all is happening.
            if (view !== null) crowd?.update(dt, view.camera);

            view?.render();
            frame = requestAnimationFrame(tick);
          });

          return () => {
            cancelAnimationFrame(frame);
            crowd?.dispose();
            crowd = null;
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

            view.load({ paths: [], versions: [], artefacts: [], start: w.start, baked });
            // Untracked, and that is the whole of why a transition is cheap.
            // The walk writes where it has got to into the store on every tick,
            // so an effect whose body read it there was invalidated on every
            // tick — and this one rebuilds every span's buffers and reloads
            // every morph. It ran the length of the transition it was drawing.
            walked(untracked(replay));
          },
        ),

        effect(replay, r => walked(r)),

        // Standing in it. Everything about that is here: the panel over the whole
        // window, the pointer taken by the page, and the keyboard read directly
        // rather than off the editor's bus — nothing else is listening for a key
        // being *held*, which is the whole of walking.
        effect(roaming, on => {
          if (host === undefined) return;

          held.clear();
          entered(host, on);

          // Standing up in the panel and then filling the window keeps the spot;
          // going straight there from above has to be given one.
          if (on && !untracked(inside)) stood(orbit, walker);

          if (!on) {
            if (document.pointerLockElement === host) document.exitPointerLock();

            placed();
            return;
          }

          // Asked for on the way in, where the `\` press is still counted as
          // something a person did. A browser can refuse it — too soon after the
          // last one is the usual reason — and the promise it hands back rejects
          // rather than throwing, so it is caught here and the view says to click.
          // Walking still works without it; only turning is lost, and a click
          // inside asks again.
          let caught = false;

          const capture = (): void => {
            const asked = host?.requestPointerLock?.() as Promise<void> | undefined;

            void asked?.catch(() => {});
          };

          capture();

          const down = (e: KeyboardEvent) => {
            // Escape leaves, and leaves whether or not the pointer was ever
            // captured. Watching the lock alone for this is how a refused capture
            // turned into a room with no door.
            if (e.code === 'Escape') {
              e.preventDefault();
              update(st => ({ ...st, roaming: false }));
              return;
            }

            // `\` again asks for the pointer again, for when the first ask was
            // refused and clicking is not what a hand on WASD wants to do.
            if (e.code === 'Backslash') {
              e.preventDefault();
              if (document.pointerLockElement !== host) capture();
              return;
            }

            if (MOVES.includes(e.code)) {
              e.preventDefault();
              held.add(e.code);
            }
          };

          const up = (e: KeyboardEvent) => held.delete(e.code);

          const moved = (e: MouseEvent) => {
            if (document.pointerLockElement !== host) return;

            walker.angle += e.movementX * LOOK;
          };

          // Escape drops the lock without a key reaching anyone, so losing a lock
          // that was actually held is someone leaving. Never having had one is
          // not: that is a refusal, and it leaves the view up to be clicked.
          const locked = () => {
            if (document.pointerLockElement === host) {
              caught = true;
              return;
            }

            if (caught) update(st => ({ ...st, roaming: false }));
          };

          // Somewhere to click if the capture was refused, and how the pointer
          // comes back after a tab away.
          const pressed = () => {
            if (document.pointerLockElement !== host) capture();
          };

          // A window that loses the focus keeps whatever was held down forever.
          const blurred = () => held.clear();

          host.addEventListener('pointerdown', pressed);
          window.addEventListener('keydown', down);
          window.addEventListener('keyup', up);
          window.addEventListener('blur', blurred);
          document.addEventListener('mousemove', moved);
          document.addEventListener('pointerlockchange', locked);

          return () => {
            host?.removeEventListener('pointerdown', pressed);
            window.removeEventListener('keydown', down);
            window.removeEventListener('keyup', up);
            window.removeEventListener('blur', blurred);
            document.removeEventListener('mousemove', moved);
            document.removeEventListener('pointerlockchange', locked);
          };
        }),

        label(bake, world, roaming, inside),
      ],
    );
  });
}

/** The keys walking takes for itself, which are taken off everything else for
 * as long as it is on. */
const MOVES = ['KeyW', 'KeyA', 'KeyS', 'KeyD'];

/**
 * The panel becoming the window, and back.
 *
 * Written onto the node rather than declared, because the box the renderer
 * watches has to be the same box either way: a second element swapped in for
 * the first would be a second WebGL context, and going in and out of first
 * person would rebuild every buffer in it.
 *
 * Somewhere to stand is decided on the way in and kept on the way out. Where
 * the orbit camera was looking is the middle of the level, which is as good a
 * spot as any and better than the origin, which may be nowhere.
 */
function entered(host: HTMLElement, on: boolean): void {
  const style = host.style;

  // Every side written out rather than `inset`, and a width alongside them:
  // the shorthand and the longhands are the same four properties, so clearing
  // `right` to get the panel's corner back also unsets what `inset` had just
  // put there, and the box collapses to nothing.
  style.top = on ? '0' : '';
  style.left = on ? '0' : '';
  style.right = on ? '0' : '12px';
  style.bottom = on ? '0' : '12px';
  style.width = on ? '100%' : `${WIDTH}px`;
  style.height = on ? '100%' : `${HEIGHT}px`;
  style.zIndex = on ? '10' : '';
  style.border = on ? 'none' : `1px solid ${theme.border}`;
  style.borderRadius = on ? '0' : '8px';
  style.boxShadow = on ? 'none' : `0 6px 18px ${theme.panelShadow}`;
  style.cursor = on ? 'none' : '';
}

/**
 * Somewhere to stand, taken from wherever the orbit camera was looking.
 *
 * That is the middle of the level, which is as good a spot as any and much
 * better than the origin, which may be nowhere near it.
 */
function stood(orbit: Orbit, walker: Walker): void {
  walker.x = orbit.x;
  walker.z = orbit.z;
  walker.angle = 0;
  walker.vx = 0;
  walker.vz = 0;
}

/**
 * Where the camera looks, and from how far.
 *
 * Only until someone takes hold of it: an edit that moved a wall should not
 * also fly the camera somewhere, so once the view has been turned or zoomed it
 * is theirs and this stops writing to it.
 */
function framed(outline: readonly { points: readonly Point[] }[], orbit: Orbit): void {
  if (orbit.held) return;

  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;

  for (const run of outline) {
    for (const p of run.points) {
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
function label(
  bake: Value<Bake>,
  world: Value<World>,
  roaming: Value<boolean>,
  inside: Value<boolean>,
): VNode {
  /** The panel in the corner: which gesture does what, and whether a version
   * switch will be a walk or a jump. */
  const says = (): string => {
    const b = bake(), w = world();

    if (b.progress !== null) return `baking ${Math.round(b.progress * 100)}%`;

    const how = inside()
      ? 'drag walks · cmd strafes · dbl-click rises · enter fills'
      : 'drag turns · wheel zooms · dbl-click stands up';

    return spanAt(b, w, 0) === null ? `${how} · unbaked` : how;
  };

  /** Filling the window, where the keyboard is the walker's. Nothing here
   * watches the pointer lock: it is not something the store knows about, and a
   * line that had gone stale would be worse than one that says both ways. */
  const walking = (): string => {
    const b = bake(), w = world();

    if (b.progress !== null) return `baking ${Math.round(b.progress * 100)}%`;

    const switches = spanAt(b, w, 0) === null ? '↑↓ switch (unbaked · snaps)' : '↑↓ switch';

    return `wasd · mouse turns (click or enter if it does not) · ${switches} · esc to leave`;
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
    [text(() => (roaming() ? walking() : says()))],
  );
}
