// -----------------------------------------------------------------------------
// The game
//
// The jam build's loop, carried over onto the new world: stand in a level that
// compresses on a timer, find the key, reach the exit before there is nowhere
// left to stand. What changed underneath it is that a version transition is now
// a morph rather than a cut.
//
// A function over an element, the way `renderer` is, and for the same reason:
// the editor is a caller like any other. It hands over a box and the world it
// is holding and gets back something it can throw away, and the game itself
// neither knows nor cares that there is an editor behind it.
//
// Two clocks, deliberately apart
// -----------------------------------
// The walls *move* over the length of a shift, and the walls that *stop* the
// player change at the start of it, in one step. That is the agreement in
// `world.ts`: collision runs on the set at a version, the morph is a picture of
// getting from one to the next, and a picture is not somewhere to stand.
//
// Which of the two ends the player is standing in is a choice, and it is the
// arriving one. There is exactly one question asked about whether the player is
// alive — whether they are standing somewhere the level has — and putting them
// on the destination the moment the shift begins is what makes that one
// question enough. Caught by the wall that is coming, they are inside it
// immediately and die on the spot rather than watching it arrive. Clear of it,
// they are held by where the level is *going* for the length of the picture,
// so a room that is about to close is not a corridor to walk out of into the
// black behind the level.
//
// An artefact is drawn on the first clock and *is* somewhere on the second: it
// travels from where it stood to where it will stand while the walls do, and
// it becomes pickable at the new place when they arrive. It travels the way
// the walls travel, riding its slot in the span's frame table, so a key on the
// floor of a room that turns comes round on the arc with the room rather than
// cutting across the middle of it.
// -----------------------------------------------------------------------------

import { Standing, artefacts } from './artefacts';
import { BakedSpan, placeAt } from './baked';
import { Hulls } from './coldet';
import { Hud, hud } from './hud';
import { renderer } from './render';
import { EASINGS, REPLAY_EASE, REPLAY_MS } from './replay';
import {
  SoundHandle,
  drone,
  error,
  levelComplete,
  pickup,
  playSound,
  versionShift,
} from './sound';
import { Run } from './walls';
import { Artefact, ArtefactType, Point, SCALE, World } from './world';

/** Eye height, in world units. Exported because standing in the level is
 * standing in the level, wherever the walking is being done from. */
export const EYE = 1.6;

/** How fast the player would go with nothing in the way, in world units per
 * second. */
export const WALK_SPEED = 10;

/** How sharply that speed is reached and lost. */
const GRIP = 30;
const DRAG = 8;

/**
 * One frame of a velocity chasing the speed the keys are asking for: towards
 * it while something is held, and away from any speed at all once it is let
 * go.
 *
 * Both exponential, so neither depends on how often it is called. Shared
 * rather than the two constants alone, because the curve is as much of the
 * feel as the numbers are and two copies of it would drift apart.
 */
export function urged(v: Point, want: Point, dt: number): Point {
  if (want.x === 0 && want.y === 0) {
    const k = Math.exp(-DRAG * dt);

    return { x: v.x * k, y: v.y * k };
  }

  const k = 1 - Math.exp(-GRIP * dt);

  return { x: v.x + (want.x - v.x) * k, y: v.y + (want.y - v.y) * k };
}

/**
 * Seconds from one version arriving to the next, which is the pressure the
 * whole game is made of.
 *
 * The whole beat, the shift included — not the standing-still part of it. A
 * clock that stopped for the length of every shift would make the first beat
 * shorter than all the others and put the escalation leading up to one a shift
 * out of step with it, growing worse the longer the level ran.
 */
const HOLD = 5;

/** How long the arriving takes, and on what curve: the editor's, because it is
 * one motion and it should look the same from either side of it. */
const SHIFT = REPLAY_MS / 1000;
const CURVE = EASINGS[REPLAY_EASE];

/** How near a thing has to be to be named, and to be taken. */
const NAMED = 3.5;
const TAKEN = 1.5;

/** Turn per pixel of mouse. */
const LOOK = 0.002;

export interface Game {
  /**
   * Take it down: the loop, the listeners, the sounds and the scene.
   *
   * After this nothing the game had in flight runs. A message being waited on
   * resolves so that whoever was waiting is not left holding it, and every
   * such waiter checks on the way back that the game it belonged to is still
   * there — a level that had ended was restarting itself behind a window
   * nobody could see any more, ambient drone and all.
   */
  dispose(): void
}

export interface PlayOptions {
  /**
   * Whether to open on the title screen. On by default, which is what a page
   * of its own wants.
   *
   * Off when the editor stands the game up: the level is already there behind
   * it and the gesture that asked for it has already happened, so a screen
   * saying to click to start is a door where there was no wall.
   */
  title?: boolean

  /**
   * A line in the corner saying what the loop thinks is going on: which
   * version is in force, what is in flight, and what last moved it.
   *
   * For when the level does something and it is not clear whether the level or
   * the game said so. Off unless asked for.
   */
  debug?: boolean

  /**
   * Someone leaving: Escape, or letting go of the pointer they had taken.
   *
   * Whoever put the game on screen is the one who can take it off again, so
   * this says that it happened rather than doing anything about it. Standing
   * alone on a page of its own there is nowhere to go, and nobody passes one.
   */
  leave?: () => void
}

/** An artefact within reach, and how far. */
interface Near {
  index: number
  type: ArtefactType
  away: number
}

export function play(host: HTMLElement, world: World, options: PlayOptions = {}): Game {
  const view = renderer(host, { dither: true });
  const crowd = artefacts(view.scene);
  const say = hud(host);

  // Nobody is looking down on it: this is the view from inside.
  crowd.overhead(false);
  view.load(world);

  /** One set of walls per version, built once. A level has a handful of them
   * and the player crosses every one. */
  const walls = world.versions.map(v => new Hulls(v.polygons, SCALE));

  const spans = world.baked.spans.length;

  /**
   * A short fingerprint of one version's set: how many rings, how many points,
   * and where the first one is.
   *
   * For telling two versions apart from inside the game. A version nobody put
   * an edit in is the one before it unchanged, and it is worth being able to
   * see that rather than infer it.
   */
  const signature = (v: number): string => {
    const it = world.versions[v];

    if (it === undefined) return 'missing';

    const points = it.polygons.reduce((n, p) => n + p.points.length, 0);
    const first = it.polygons[0]?.points[0];

    return `${it.polygons.length}r/${points}p`
      + (first === undefined ? '' : `@${first.x.toFixed(0)},${first.y.toFixed(0)}`);
  };

  /** Where the player is and which way they are facing, in world units. */
  const player = { x: 0, z: 0, yaw: 0, vx: 0, vz: 0 };

  /** Which version is drawn and holds the artefacts. During a shift this is
   * still the one being left — see the header. */
  let version = 0;

  /** Which version's walls stop the player. The same as `version` while one is
   * standing, and the one arriving for the length of a shift. */
  let footing = 0;

  /** How far into a shift, in seconds, or null while one is standing. */
  let shifting: number | null = null;

  /** Seconds left of the version standing. */
  let clock = HOLD;

  /** Which two versions the shift in flight runs between. */
  let leg = { from: 0, to: 0 };

  /** What last moved the version, for the corner line. */
  let why = 'start';

  /** What has been picked up, and which artefacts are gone because of it. */
  const carrying = new Set<ArtefactType>();
  const gone = new Set<number>();

  const down = new Set<string>();

  /** Where the artefacts are on screen this frame. What is drawn and what can
   * be reached are the same list, deliberately — see `nearest`. */
  // Their own kinds rather than `Standing`'s wider one: what is drawn here is
  // the artefacts, and the start is not one of them.
  let shown: (Standing & { type: ArtefactType })[] = [];

  /**
   * How far into dying, in seconds, or null while there is somewhere to stand.
   *
   * Set the moment there is nowhere to be and cleared by the restart. The
   * screen still ends up black — from inside a wall the camera can see the
   * level from the outside, and a level seen from the outside is a set of
   * surfaces rather than somewhere anyone was standing — but it gets there
   * over the length of the shift rather than in a cut, and the picture keeps
   * running underneath. Long enough to see which wall did it, and no longer.
   */
  let dying: number | null = null;

  let ambient: SoundHandle | null = null;
  let coming: SoundHandle | null = null;
  let running = false;

  /** Whether this game is still the one on screen. Everything that resumes
   * after an `await` asks, because between the two it may not be. */
  let live = true;

  /** The escalation that says a shift is on its way. Restarted whenever the
   * clock is, and stopped outright when there is nothing to escalate to. */
  const escalate = (on = true): void => {
    coming?.stop();
    coming = on ? playSound(versionShift({ duration: HOLD })) : null;
  };

  /** The version on screen, standing still. */
  const drawn = (v: number): void => {
    view.walk(null);
    view.show(runs(world, v), world.versions[v]?.floors ?? []);
  };

  /** Everything that follows from being at a version: the walls drawn, the
   * artefacts placed. Called after every way of getting to one. */
  const arrived = (): void => {
    drawn(version);
    placed(version, version, 0);
  };

  /**
   * Where every artefact is drawn, part way from one version to another.
   *
   * One that only exists at one end of the shift stands still at the place it
   * has: something arriving has nowhere to arrive from, and something on its
   * way out has nowhere to go.
   */
  const placed = (from: number, to: number, t: number): void => {
    // A shift is one span read forwards or backwards, so the span is the
    // earlier of the two versions whichever way the level is going.
    const span = from === to ? undefined : world.baked.spans[Math.min(from, to)];

    shown = [];

    world.artefacts.forEach((it, i) => {
      if (gone.has(i)) return;

      const at = riding(span, i, it, from, to, t);

      if (at === null) return;

      shown.push({ id: i, type: it.type, x: at.x, y: at.y });
    });

    crowd.show(shown);
  };

  const spawn = (): void => {
    // Where the start stands and which way it points: the mark on the floor
    // carries a direction, and being put down facing a wall is not a level
    // beginning.
    player.x = world.start.at.x * SCALE;
    player.z = world.start.at.y * SCALE;
    player.vx = 0;
    player.vz = 0;
    player.yaw = world.start.facing;
  };

  const restart = (): void => {
    dying = null;
    say.veil(0);
    version = 0;
    footing = 0;
    shifting = null;
    clock = HOLD;

    why = 'restart';
    carrying.clear();
    gone.clear();
    spawn();
    arrived();
    escalate();
  };

  /**
   * The next version arriving.
   *
   * The picture starts here and the walls that stop the player change when it
   * finishes, so this is the point at which the level is committed to
   * compressing and not yet the point at which it has. A span that was never
   * baked has no picture, so it snaps.
   */
  const compress = (to: number, reason = 'clock'): void => {
    if (to < 0 || to >= world.versions.length) return;

    why = `${reason} ${version}->${to}`;

    // A beat that ran over keeps its overshoot, so the beats do not creep by a
    // frame apiece; one cut short by a pickup gets a whole one, which is what
    // being cut short by a pickup is for.
    clock = HOLD + Math.min(0, clock);

    // Backwards or forwards, a shift is a walk from where the level is to
    // where it is going, and the bake reads it the same way either round. What
    // there is no picture of — a jump of more than one version, or a span that
    // was never baked — arrives all at once. Asking whether the level has *any*
    // spans is not the same question: a bake that stopped short leaves the
    // early ones playable and the late ones not, and playing one of those
    // clamps to the end of the last span there is and shows an earlier version
    // for the length of the shift.
    if (Math.abs(to - version) !== 1 || world.baked.spans[Math.min(version, to)] === undefined) {
      shifting = null;
      version = to;
      arrived();
    }
    else {
      leg = { from: version, to };
      shifting = 0;
    }

    // What the player stands in from here is where the level is going, which
    // is what makes the one check in the loop the whole of dying: a player the
    // arriving wall covers is inside a wall this instant, and one it misses is
    // held by the room it leaves rather than free to walk out through where
    // the old room used to be.
    footing = to;

    // Somewhere that stops existing is the level closing over the player, and
    // it is worth hearing before it is worth seeing. Nothing escalates towards
    // a version the player will not survive to see; the dying itself is the
    // loop's, this frame, a few lines further down.
    escalate(walls[to]?.standable({ x: player.x, y: player.z }) ?? true);
  };

  const walked = (): void => {
    if (shifting === null) return;

    const t = CURVE(Math.min(shifting / SHIFT, 1));
    const at = leg.from + (leg.to - leg.from) * t;

    view.walk(Math.min(Math.max(at / spans, 0), 1));
    placed(leg.from, leg.to, t);
  };

  /** One frame of standing in it. */
  const stepped = (dt: number): void => {
    const ahead = (down.has('KeyW') ? 1 : 0) - (down.has('KeyS') ? 1 : 0);
    const across = (down.has('KeyD') ? 1 : 0) - (down.has('KeyA') ? 1 : 0);

    let wx = 0, wz = 0;

    if (ahead !== 0 || across !== 0) {
      const l = Math.hypot(ahead, across);
      const sin = Math.sin(player.yaw), cos = Math.cos(player.yaw);

      wx = (sin * ahead + cos * across) / l * WALK_SPEED;
      wz = (-cos * ahead + sin * across) / l * WALK_SPEED;
    }

    const sped = urged({ x: player.vx, y: player.vz }, { x: wx, y: wz }, dt);

    player.vx = sped.x;
    player.vz = sped.y;

    const was = { x: player.x, y: player.z };
    const now = walls[footing]?.trace(was, { x: player.vx * dt, y: player.vz * dt }) ?? was;

    player.x = now.x;
    player.z = now.y;
  };

  /**
   * The nearest thing worth naming, or nothing near enough.
   *
   * Off where things are *drawn*, not off the version in force. During a shift
   * those differ, and reaching for something that is not where you can see it
   * is not a game — worse, an artefact whose new place lands on the player is
   * taken the instant the shift ends, having never been walked to.
   */
  const nearest = (): Near | null => {
    let out: Near | null = null;

    for (const it of shown) {
      const away = Math.hypot(player.x - it.x * SCALE, player.z - it.y * SCALE);

      if (out === null || away < out.away) out = { index: it.id, type: it.type, away };
    }

    return out === null || out.away > NAMED ? null : out;
  };

  /**
   * The level closing over the player.
   *
   * The picture in flight is left to finish — the wall that did it is the one
   * thing worth seeing, and it is the arriving one — under a black that comes
   * up over the same length of time. On the last version there is no picture
   * to run and only the black happens.
   */
  const lost = (): void => {
    if (dying !== null) return;

    dying = 0;
    say.note(null);
    playSound(error);
  };

  /** The far end of that, once the screen is black. */
  const ended = async (): Promise<void> => {
    await say.say('PULL YOURSELF TOGETHER', 3000);

    if (live) restart();
  };

  const took = async (index: number, type: ArtefactType): Promise<void> => {
    if (say.busy()) return;

    switch (type) {
      // More time before the next one, which is the whole of it.
      case 'delay':
        gone.add(index);
        clock = HOLD;
        placed(version, version, 0);
        escalate();
        playSound(pickup);
        break;

      // Back the way the level came, which is the only way back there is.
      case 'decompress':
        if (version === 0) break;

        gone.add(index);
        playSound(pickup);
        compress(version - 1, 'decompress');
        break;

      case 'key':
        gone.add(index);
        carrying.add('key');
        placed(version, version, 0);
        playSound(pickup);
        break;

      case 'exit':
        if (!carrying.has('key')) break;

        running = false;
        say.note(null);
        escalate(false);
        ambient?.stop();
        ambient = null;
        playSound(levelComplete());

        await say.say('DIRECTIVE FULFILLED', 5000);

        if (!live) break;

        await say.say('forgetful-functor.itch.io', 0, '@pkamenarsky');

        if (!live) break;

        say.black();
        break;

      default:
        break;
    }
  };

  const named = (type: ArtefactType): string => {
    switch (type) {
      case 'delay': return 'DELAY COMPRESSION';
      case 'decompress': return 'DECOMPRESS';
      case 'key': return 'KEY';
      case 'exit': return carrying.has('key') ? 'EXIT' : 'EXIT: FIND KEY';
      default: return type.toUpperCase();
    }
  };

  // ── The loop ──

  let last = performance.now();

  let frame = requestAnimationFrame(function tick(now: number): void {
    // Capped: a tab left in the background would otherwise come back and put
    // the player through a wall in one step.
    const dt = Math.min(0.1, (now - last) / 1000);

    last = now;
    frame = requestAnimationFrame(tick);

    // The next frame is asked for first, so a throw in here does not stop the
    // loop — which means a throw in here would otherwise repeat silently
    // forever, leaving whatever was last drawn on screen and nothing to say
    // why. One is enough to know.
    try {
      body(dt);
    }
    catch (e) {
      running = false;
      say.stat(`stopped: ${String(e)}`);
      console.error(e);
    }
  });

  function body(dt: number): void {

    // The scene is still drawn while a message is up — it is what the message
    // is over.
    if (running && !say.busy()) {
      // A player who is dying is a spectator: the shift below still runs, and
      // nothing else about standing in the level does.
      if (dying === null) {
        stepped(dt);

        // Through the shift as well, so that the beat is `HOLD` and not `HOLD`
        // plus however long the picture happens to take.
        clock -= dt;
      }

      if (shifting !== null) {
        shifting += dt;

        // The end of the picture is the moment the level *is* the next
        // version: the walls that stop the player and the places the
        // artefacts stand both change here, together, in one step.
        if (shifting >= SHIFT) {
          shifting = null;
          version = leg.to;
          arrived();
        }
        else {
          walked();
        }
      }
      // The last version compressing has nowhere to compress to, and a level
      // that has run out is not a level that stops: it is the one beat the
      // player cannot be anywhere for.
      else if (dying === null && clock <= 0) {
        if (version + 1 < world.versions.length) compress(version + 1);
        else lost();
      }

      if (dying === null) {
        const found = nearest();

        say.note(found === null ? null : named(found.type));

        if (found !== null && found.away <= TAKEN) void took(found.index, found.type);

        if (!(walls[footing]?.standable({ x: player.x, y: player.z }) ?? true)) lost();
      }

      // Counted after the shift above, so that the frame the level closes on
      // is the frame the black starts from rather than one behind it.
      if (dying !== null) {
        dying += dt;
        say.veil(dying / SHIFT);

        if (dying >= SHIFT) void ended();
      }
    }

    view.camera.position.set(player.x, EYE, player.z);
    view.camera.lookAt(
      player.x + Math.sin(player.yaw),
      EYE,
      player.z - Math.cos(player.yaw),
    );

    crowd.update(dt, view.camera);

    // Under a black that is already whole there is nothing to draw, and what
    // there is to draw is the level from the outside.
    if (dying !== null && dying >= SHIFT) view.blank();
    else view.render();

    if (options.debug === true) {
      const flight = shifting === null
        ? 'still'
        : `${leg.from}->${leg.to} ${(shifting / SHIFT).toFixed(2)}`;

      say.stat(
        `v${version}/${world.versions.length - 1}  ${signature(version)}  ${flight}`
        + `  clock ${clock.toFixed(1)}  spans ${spans}  ${why}`,
      );
    }
  }

  // ── The keyboard and the pointer ──

  const canvas = host.querySelector('canvas');

  const grab = (): void => {
    if (document.pointerLockElement !== canvas) void (canvas as HTMLCanvasElement | null)?.requestPointerLock?.();
  };

  /** Whether the pointer was ever actually taken. Escape drops it without a
   * key reaching anyone, so losing a lock that was held is someone leaving —
   * never having had one is a refusal, and leaves the game up to be clicked. */
  let caught = false;

  const pressed = (e: KeyboardEvent): void => {
    if (e.code === 'Escape') {
      options.leave?.();
      return;
    }

    down.add(e.code);
  };

  const released = (e: KeyboardEvent): void => {
    down.delete(e.code);
  };

  const moved = (e: MouseEvent): void => {
    if (document.pointerLockElement === canvas) player.yaw += e.movementX * LOOK;
  };

  // A window that loses the focus keeps whatever was held down forever.
  const blurred = (): void => down.clear();

  const locked = (): void => {
    if (document.pointerLockElement === canvas) caught = true;
    else if (caught) options.leave?.();
  };

  host.addEventListener('click', grab);
  document.addEventListener('pointerlockchange', locked);
  window.addEventListener('keydown', pressed);
  window.addEventListener('keyup', released);
  window.addEventListener('blur', blurred);
  document.addEventListener('mousemove', moved);

  // ── Getting going ──

  // Every version's fingerprint, once, so that a level playing the same
  // geometry twice can be told from a game drawing the wrong one.
  if (options.debug === true) {
    console.log(world.versions.map((_unused, v) => `v${v} ${signature(v)}`).join('\n'));
  }

  void (async () => {
    // The click that dismisses this is also what lets the audio start and what
    // takes the pointer: a browser grants all three to a gesture and none of
    // them to a page that merely loaded. Without the title screen there has
    // been a gesture already — whatever asked for the game — and this runs
    // inside it.
    if (options.title ?? true) await say.say('COMPRESSION EVENT', 0, 'CLICK TO START');

    if (!live) return;

    ambient = playSound(drone);

    restart();
    grab();

    running = true;
  })();

  return {
    dispose(): void {
      live = false;
      running = false;

      cancelAnimationFrame(frame);

      if (document.pointerLockElement === canvas) document.exitPointerLock();

      host.removeEventListener('click', grab);
      document.removeEventListener('pointerlockchange', locked);
      window.removeEventListener('keydown', pressed);
      window.removeEventListener('keyup', released);
      window.removeEventListener('blur', blurred);
      document.removeEventListener('mousemove', moved);

      ambient?.stop();
      coming?.stop();
      say.dispose();
      crowd.dispose();
      view.dispose();
    },
  };
}

/**
 * Where one artefact is, part way through a shift.
 *
 * Off the frame table where the span has a slot for it, which is the same
 * arithmetic every corner of every wall goes through and is therefore right
 * about turns for free. Where it has none — an unbaked span, or a jump of more
 * than one version — there are still two places, and a straight line between
 * them is better than a jump.
 *
 * One that exists at only one end stands still at the place it has: something
 * arriving has nowhere to arrive from, and something on its way out has
 * nowhere to go.
 */
function riding(
  span: BakedSpan | undefined,
  index: number,
  it: Artefact,
  from: number,
  to: number,
  t: number,
): Point | null {
  const a = it.places[from] ?? null;
  const b = it.places[to] ?? null;

  if (a === null || b === null) return a ?? b;
  if (from === to) return a;

  const slot = span?.artefacts[index] ?? -1;

  // The span runs from the earlier version to the later one, so a shift the
  // other way is the same span read backwards.
  return slot < 0
    ? { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    : placeAt(span!, slot, it.at, to > from ? t : 1 - t);
}

/**
 * A version's rings as the wall builder wants them: open runs of points.
 *
 * A ring is closed by repeating its first point, because a wall is a
 * consecutive pair and the pair joining the last corner to the first is a wall
 * like any other. Every corner is a real one — these are the union's own rings
 * rather than one polygon's share of an outline — so every one of them gets its
 * vertical line.
 */
function runs(world: World, v: number): Run[] {
  const version = world.versions[v];

  if (version === undefined) return [];

  return version.polygons
    .filter(p => p.points.length >= 3)
    .map(p => {
      const points: Point[] = p.points.map(q => ({ x: q.x, y: q.y }));

      points.push(points[0]);

      return { points, corner: points.map(() => true) };
    });
}
