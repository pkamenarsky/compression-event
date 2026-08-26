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
// player change at the end of it, in one step. That is the agreement in
// `world.ts`: collision runs on the set at a version, the morph is a picture of
// getting from one to the next, and a picture is not somewhere to stand. So for
// the length of a shift the wall on screen is a little ahead of the wall that
// stops you, which is what the jam build had between its snaps too.
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
import { SCALE, renderer } from './render';
import { EASINGS, REPLAY_EASE, REPLAY_MS } from './replay';
import {
  SoundHandle,
  drone,
  error,
  levelComplete,
  pickup,
  playSound,
  playSoundFor,
  versionShift,
} from './sound';
import { Run } from './walls';
import { Artefact, ArtefactType, Point, World } from './world';

/** Eye height, in world units. */
const EYE = 1.6;

/** How fast the player would go with nothing in the way, and how sharply that
 * speed is reached and lost. */
const SPEED = 10;
const GRIP = 30;
const DRAG = 8;

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
  dispose(): void
}

export interface PlayOptions {
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

  /** Where the player is and which way they are facing, in world units. */
  const player = { x: 0, z: 0, yaw: 0, vx: 0, vz: 0 };

  /** Which version stops the player and holds the artefacts. During a shift
   * this is still the one being left — see the header. */
  let version = 0;

  /** How far into a shift, in seconds, or null while one is standing. */
  let shifting: number | null = null;

  /** Seconds left of the version standing. */
  let clock = HOLD;

  /** Which two versions the shift in flight runs between. */
  let leg = { from: 0, to: 0 };

  /** What has been picked up, and which artefacts are gone because of it. */
  const carrying = new Set<ArtefactType>();
  const gone = new Set<number>();

  const down = new Set<string>();

  let ambient: SoundHandle | null = null;
  let coming: SoundHandle | null = null;
  let running = false;

  /** The escalation that says a shift is on its way. Restarted whenever the
   * clock is, and stopped outright when there is nothing to escalate to. */
  const escalate = (on = true): void => {
    coming?.stop();
    coming = on ? playSoundFor(versionShift(), HOLD) : null;
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
    const all: Standing[] = [];

    // A shift is one span read forwards or backwards, so the span is the
    // earlier of the two versions whichever way the level is going.
    const span = from === to ? undefined : world.baked.spans[Math.min(from, to)];

    world.artefacts.forEach((it, i) => {
      if (gone.has(i)) return;

      const at = riding(span, i, it, from, to, t);

      if (at === null) return;

      all.push({ id: i, type: it.type, x: at.x, y: at.y });
    });

    crowd.show(all);
  };

  const spawn = (): void => {
    const start = world.artefacts.find(it => it.type === 'start')?.places[0];

    player.x = (start?.x ?? 0) * SCALE;
    player.z = (start?.y ?? 0) * SCALE;
    player.vx = 0;
    player.vz = 0;
    player.yaw = 0;
  };

  const restart = (): void => {
    version = 0;
    shifting = null;
    clock = HOLD;

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
  const compress = (to: number): void => {
    if (to < 0 || to >= world.versions.length) return;

    // A beat that ran over keeps its overshoot, so the beats do not creep by a
    // frame apiece; one cut short by a pickup gets a whole one, which is what
    // being cut short by a pickup is for.
    clock = HOLD + Math.min(0, clock);

    // Backwards or forwards, a shift is a walk from where the level is to
    // where it is going, and the bake reads it the same way either round. What
    // there is no picture of — an unbaked span, or a jump of more than one —
    // arrives all at once.
    if (spans === 0 || Math.abs(to - version) !== 1) {
      shifting = null;
      version = to;
      arrived();
    }
    else {
      leg = { from: version, to };
      shifting = 0;
    }

    // Somewhere that stops existing is the level closing over the player, and
    // it is worth hearing before it is worth seeing. Nothing escalates towards
    // a version the player will not survive to see.
    const room = walls[to]?.standable({ x: player.x, y: player.z }) ?? true;

    escalate(room);

    if (!room) playSoundFor(error, 1);
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

      wx = (sin * ahead + cos * across) / l * SPEED;
      wz = (-cos * ahead + sin * across) / l * SPEED;
    }

    // Towards the speed asked for while a key is down, and away from any speed
    // at all once it is let go. Both exponential, so neither depends on how
    // often this is called.
    if (wx !== 0 || wz !== 0) {
      const k = 1 - Math.exp(-GRIP * dt);

      player.vx += (wx - player.vx) * k;
      player.vz += (wz - player.vz) * k;
    }
    else {
      const k = Math.exp(-DRAG * dt);

      player.vx *= k;
      player.vz *= k;
    }

    const was = { x: player.x, y: player.z };
    const now = walls[version]?.trace(was, { x: player.vx * dt, y: player.vz * dt }) ?? was;

    player.x = now.x;
    player.z = now.y;
  };

  /** The nearest thing worth naming, or nothing near enough. */
  const nearest = (): Near | null => {
    let out: Near | null = null;

    for (let i = 0; i < world.artefacts.length; i++) {
      const it = world.artefacts[i];
      const at = it.places[version];

      // The start is a mark on the floor rather than a thing to walk up to.
      if (at === null || at === undefined || gone.has(i) || it.type === 'start') continue;

      const away = Math.hypot(player.x - at.x * SCALE, player.z - at.y * SCALE);

      if (out === null || away < out.away) out = { index: i, type: it.type, away };
    }

    return out === null || out.away > NAMED ? null : out;
  };

  const lost = async (): Promise<void> => {
    if (say.busy()) return;

    say.note(null);
    await say.say('PULL YOURSELF TOGETHER', 3000);
    restart();
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
        playSoundFor(pickup, 1);
        break;

      // Back the way the level came, which is the only way back there is.
      case 'decompress':
        if (version === 0) break;

        gone.add(index);
        playSoundFor(pickup, 1);
        compress(version - 1);
        break;

      case 'key':
        gone.add(index);
        carrying.add('key');
        placed(version, version, 0);
        playSoundFor(pickup, 1);
        break;

      case 'exit':
        if (!carrying.has('key')) break;

        running = false;
        say.note(null);
        escalate(false);
        ambient?.stop();
        ambient = null;
        playSoundFor(levelComplete(), 3);

        await say.say('DIRECTIVE FULFILLED', 5000);
        await say.say('forgetful-functor.itch.io', 0, '@pkamenarsky');
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

    // The scene is still drawn while a message is up — it is what the message
    // is over.
    if (running && !say.busy()) {
      stepped(dt);

      // Through the shift as well, so that the beat is `HOLD` and not `HOLD`
      // plus however long the picture happens to take.
      clock -= dt;

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
      else if (clock <= 0) {
        if (version + 1 < world.versions.length) compress(version + 1);
        else clock = HOLD;
      }

      const found = nearest();

      say.note(found === null ? null : named(found.type));

      if (found !== null && found.away <= TAKEN) void took(found.index, found.type);

      if (!(walls[version]?.standable({ x: player.x, y: player.z }) ?? true)) void lost();
    }

    view.camera.position.set(player.x, EYE, player.z);
    view.camera.lookAt(
      player.x + Math.sin(player.yaw),
      EYE,
      player.z - Math.cos(player.yaw),
    );

    crowd.update(dt, view.camera);
    view.render();
  });

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

  void (async () => {
    // The click that dismisses this is also what lets the audio start and what
    // takes the pointer: a browser grants all three to a gesture and none of
    // them to a page that merely loaded.
    await say.say('COMPRESSION EVENT', 0, 'CLICK TO START');

    ambient = playSound(drone);

    restart();
    grab();

    running = true;
  })();

  return {
    dispose(): void {
      cancelAnimationFrame(frame);

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
