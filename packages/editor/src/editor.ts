import { Value } from '@incpt/kontinuum';
import { VNode, dynamic, effect, fragment, object, show, stateful, text as textNode } from '@incpt/kontinuum-dom';
import { div, span } from '@incpt/kontinuum-dom/html';
import { circle, g, line, path, rect, svg, text } from '@incpt/kontinuum-dom/svg';
import { signal } from '@incpt/kontinuum-interaction';
import { interaction } from '@incpt/kontinuum-interaction/dom';

import { Bake, FAST, FRAMES, Limits, bakeAll, spanAt } from './bake';
import { worldCanvas } from './canvas';
import { preview } from './view3d';
import { Input, createInput, inputListener, keyPressed } from './input';
import {
  copied,
  grouped,
  keyAt,
  landing,
  order,
  pasted,
  reaching,
  rechained,
  sealing,
  stamped,
  unchained,
  ungrouping,
  broken,
  split,
} from './scene';
import { Game, play } from '@ce/game';
import { shipped } from './export';
import { download, upload } from './save';
import { flattenInto } from './resolve';
import { picker } from './picker';
import { inspector } from './inspector';
import { timeline } from './timeline';
import { theme } from './theme';
import {
  EditorState,
  Id,
  EASINGS,
  REPLAY_EASE,
  REPLAY_MS,
  Eye,
  Selection,
  dropped,
  Tool,
  Update,
  KeyframeId,
  World,
  Figure,
  FIGURES,
  GroupId,
  PICKINGS,
  Picking,
  coarser,
  finer,
  initialState,
  opened,
  marked,
  saying,
  Unrolled,
  redone,
  undone,
  within,
  picks,
} from './types';
import { aimed, aiming, lastKeys, newKeys, reborn } from './keys';
import { steppedKey } from './track';

/**
 * The editor: a canvas that draws the world, and the chrome floating above it.
 * One `stateful` at the top and an `object` split beneath it, so that each
 * piece of the UI reads the fields it needs and wakes for those alone.
 *
 * The input bus is made here and passed down, so every shortcut in the editor
 * waits on the same one set of listeners.
 */
export function editor(initial: World): VNode {
  const input = createInput();

  // Every change to the store, and the keys the hand is on kept true over it:
  // see `aimed`.
  return stateful(initialState(initial), (state, set) => {
    const update: Update = fn => set(aimed(fn(state())));

    return object(state, s =>
      div(
        {
          style: {
            position: 'absolute',
            inset: '0',
            overflow: 'hidden',
          },
        },
        [
          inputListener(input),
          saving(state, input, update),
          playing(state, input),
          shortcuts(state, input, update),

          replaying(s.keyframe, state, update),
          roaming(input, state, update),
          versions(input, update),

          // The canvas and the panel, and one cell between them: where whoever
          // is standing in the 3D view is standing. The panel writes it every
          // frame it walks and the canvas draws it as a ghost of the start;
          // the canvas writes it when that ghost is dragged and the panel goes
          // there. Held here rather than in the store because it is nobody's
          // document — see `Eye` — and held by a `stateful` of its own so that
          // a step taken in the level wakes these two and nothing else.
          stateful<Eye | null>(null, (eye, setEye) => fragment([
            worldCanvas(
              s.world,
              s.settings,
              s.view,
              s.tool,
              s.figure,
              s.remembered,
              s.selection,
              s.inside,
              s.keyframe,
              s.target,
              s.replay,
              s.bake,
              s.roaming,
              () => s.preview() || s.roaming(),
              eye,
              setEye,
              input,
              update,
            ),

            preview(
              () => s.preview() || s.roaming(),
              s.world,
              s.bake,
              s.keyframe,
              s.replay,
              s.roaming,
              eye,
              setEye,
              input,
              update,
            ),
          ])),

          breadcrumb(s.world, s.inside, update),
          picker(s.beneath, s.world, input, update),
          toolbar(s.tool, update),
          figureBar(s.tool, s.figure, update),
          pickBar(s.tool, update),
          inspector(s.world, s.selection, s.tool, s.remembered, s.keyframe, s.target, 12 + TOOLBAR + 8, update),
          bakeButton(state, s.world, s.bake, update),
          previewButton(s.preview, update),

          // Along the whole bottom, the status line sitting on the keyframes:
          // it is most often about something done there.
          div(
            {
              style: {
                position: 'absolute',
                left: '0',
                right: '0',
                bottom: '0',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: '8px',
                pointerEvents: 'none',
              },
            },
            [
              statusbar(s.status),
              timeline(
                state,
                s.world,
                s.selection,
                s.keyframe,
                input,
                update,
                k => update(t => switched(t, k)),
              ),
            ],
          ),
        ],
      ),
    );
  });
}

/**
 * The clock behind a version switch, which is watched rather than jumped.
 *
 * The walk leaves how far it has got in the store, where both views find it:
 * the canvas draws the outline it passes through and the 3D view flies the same
 * instant into the shader. It lives here rather than in either view because it
 * belongs to neither — two clocks would be two walks, and they would not stay
 * in step.
 *
 * It does not decide that a walk is happening. `switched` does that, in the
 * same update that moves the version, and this only advances what it finds. The
 * two being one update is load-bearing: writing the version first and the walk
 * a frame later leaves one frame in which a view is told it is at the
 * destination with nothing in flight, and anything drawing the walk rather than
 * drawing over it lurches to the end and back. The canvas never noticed —
 * what it draws underneath is supposed to snap — and the 3D view could not
 * have been more obvious about it.
 */
function replaying(current: Value<KeyframeId>, state: Value<EditorState>, update: Update): VNode {
  return effect(current, v => {
    const walk = state().replay;

    // A version can move without a transition being meant by it — a file
    // opened, a state restored. Only a walk that says it is going here is one.
    if (walk === null || walk.to !== v) return;

    // The run-up first, if the walk asked for one, standing at the start; the
    // walk's own clock begins where it ends.
    const started = performance.now() + walk.before * 1000;
    const ms = REPLAY_MS * Math.abs(order(state().world, v) - order(state().world, walk.from));
    const curve = EASINGS[REPLAY_EASE];

    let frame = requestAnimationFrame(function tick() {
      const now = performance.now();

      if (now < started) {
        update(s => ({ ...s, replay: { ...walk, before: (started - now) / 1000 } }));
        frame = requestAnimationFrame(tick);
        return;
      }

      // The clock is linear and the walk is not. Whether it is over is a
      // question about the clock, so it is asked of `u` rather than of the
      // curve — a curve that touched 1 early would end the walk early.
      const u = Math.min(1, (now - started) / ms);

      update(s => ({ ...s, replay: u < 1 ? { ...walk, at: curve(u), through: u, before: 0 } : null }));

      if (u < 1) frame = requestAnimationFrame(tick);
    });

    return () => cancelAnimationFrame(frame);
  });
}

/**
 * Standing in the level rather than looking down at it.
 *
 * `\` goes in — and turns the 3D view on if it was not already, since being
 * inside something invisible is not a state worth having. Coming back out is
 * the pointer lock going, which the view watches for, so Escape works without
 * anything here waiting for it.
 *
 * A key nothing types and nothing else in the editor wants, which is the whole
 * of why it is this one. Enter was it until the paths tool needed the key that
 * says a thing being laid down is finished, and going into the level for
 * committing a walk is two things happening for one press.
 */
function roaming(input: Input, state: Value<EditorState>, update: Update): VNode {
  return interaction(function* () {
    while (true) {
      const e = yield* keyPressed(input, 'Backslash');

      if (e.metaKey || e.ctrlKey) continue;

      // The game has the page. `\` reaching back here used to turn the
      // editor's own walk on underneath it, so leaving the game landed the
      // player in a second one.
      if (afoot !== null || state().roaming) continue;

      e.preventDefault();
      update(s => ({ ...s, roaming: true }));
    }
  });
}

/**
 * The arrows switch version, wherever the eye happens to be.
 *
 * Looking down at the canvas, standing inside the 3D view, or with the panel
 * up beside the drawing: which version is on screen is one fact about the
 * editor rather than one about whichever view is showing it, so the key that
 * changes it belongs to none of them. It was the walk's alone, and reaching
 * the keyframes from the canvas meant taking the hand off what it was doing.
 *
 * Switched the way a click on a keyframe switches it: `switched`, so a transition
 * is declared in the same update that moves the version and the walls morph
 * across rather than jump.
 *
 * The game is the exception, and the only one. It has the page, its own
 * keyboard and its own idea of which version is on — see `afoot`.
 */
function versions(input: Input, update: Update): VNode {
  return interaction(function* () {
    while (true) {
      const e = yield* keyPressed(input, 'ArrowLeft', 'ArrowRight');

      if (e.metaKey || e.ctrlKey || afoot !== null) continue;

      e.preventDefault();

      // Right is forward, the way the keyframes run along the bottom.
      const by = e.code === 'ArrowRight' ? 1 : -1;

      // With ⌥, a key at a time rather than a keyframe: across into the next
      // one where this one has no more, switched the way a click switches.
      if (e.altKey) {
        update(s => {
          const t = steppedKey(s, by);

          return t === s ? s : { ...switched(s, t.keyframe), target: t.target };
        });

        continue;
      }

      update(s => switched(s, clamped(s.world, order(s.world, s.keyframe) + by)));
    }
  });
}

/** The keyframe at a place in the order, or the nearest end of it. */
function clamped(world: World, i: number): KeyframeId {
  return keyAt(world, Math.min(world.keyframes.length - 1, Math.max(0, i)))!;
}

/**
 * A version switch: where the walk is declared, in the one update that also
 * moves the version.
 *
 * Clicking the version already on screen is not a switch and does not start
 * one.
 */
function switched(s: EditorState, to: KeyframeId): EditorState {
  if (s.keyframe === to) return s;

  // Nothing to play is not a walk. An edit invalidates every span after it, and
  // a transition declared over one that no longer stands leaves both views
  // trying to draw an instant that has no geometry — which reads as everything
  // between the two versions blinking out and back.
  if (!playable(s, to)) return { ...s, keyframe: to, replay: null };

  return {
    ...s,
    keyframe: to,
    replay: { from: s.keyframe, to, at: 0, through: 0, before: s.roaming ? s.lead : 0 },
  };
}

/**
 * Cmd+S puts the whole state in a file and Cmd+O reads one back. They exist so
 * that a world which is doing something odd can be handed over as it is: the
 * numbers that produced it, not a picture of the result.
 *
 * The browser wants both of these for itself, so both are taken off it. That
 * has to happen while the event is still being dispatched, which is why the
 * signal wakes its waiters synchronously.
 */
function saving(state: Value<EditorState>, input: Input, update: Update): VNode {
  // The world as it was last written to a file or read from one, or as the
  // editor opened on. By identity: every edit makes a new world, and undoing
  // back to this one makes it this one again, so the question of whether
  // anything is unsaved is a comparison and nothing has to keep count.
  return stateful<World>(state().world, (saved, setSaved) => fragment([
    effect(() => state().world !== saved(), unsaved => (unsaved ? held() : undefined)),

    interaction(function* () {
      while (true) {
        const e = yield* keyPressed(input, 'KeyS', 'KeyO');

        if (!(e.metaKey || e.ctrlKey)) continue;

        e.preventDefault();

        if (e.code === 'KeyS') {
          const s = state();

          void download(s).then(() => setSaved(s.world));
        }
        else {
          if (state().world !== saved() && !confirm('This level has changes that are not saved. Open another anyway?')) continue;

          // The load lands whenever the picker is answered, which is long after
          // this. Everything the editor keeps is in the file, the bake as the
          // game gets it rather than as the editor works it out — so a level
          // opened that way plays at once, and is baked again for the replay.
          //
          // The file says where it was looking and not how big the canvas was,
          // so the measurements are this window's to keep. Nothing resizes on a
          // load, so no observation comes along to make them again: taking the
          // ones a view starts with would size the backing store to no window at
          // all, and leave every click landing beside what it aimed at.
          upload(loaded => {
            update(s => ({
              ...loaded,
              view: { ...loaded.view, width: s.view.width, height: s.view.height, dpr: s.view.dpr },
            }));
            setSaved(loaded.world);
          });
        }
      }
    }),
  ]));
}

/** The browser's own question on the way out of the page, for as long as this
 * is held: the level lives nowhere but in the page. */
function held(): () => void {
  const asked = (e: BeforeUnloadEvent): void => e.preventDefault();

  window.addEventListener('beforeunload', asked);

  return () => window.removeEventListener('beforeunload', asked);
}

/** Whether every span between here and there has been baked and still stands.
 * `spanAt` decides, against the world in front of it, so an edit takes the
 * transition away without anything having to be told. */
function playable(s: EditorState, to: KeyframeId): boolean {
  const here = order(s.world, s.keyframe), there = order(s.world, to);
  const lo = Math.min(here, there), hi = Math.max(here, there);

  for (let from = lo; from < hi; from++) {
    if (spanAt(s.bake, s.world, from) === null) return false;
  }

  return true;
}

/**
 * Cmd+\ hands the level to the game and stands in it.
 *
 * The game is a function over an element, exactly as the 3D panel's renderer
 * is — the editor is one of its callers rather than something it is launched
 * from. So there is no window, no message and nothing serialised: the world it
 * is handed is the one that is on screen, worked out in place.
 *
 * Over the whole page rather than inside the editor's tree, because the game
 * takes the page: the pointer, the keyboard and the screen. Escape gives it
 * back, and everything in the editor is where it was left.
 */
function playing(state: Value<EditorState>, input: Input): VNode {
  return interaction(function* () {
    while (true) {
      const e = yield* keyPressed(input, 'Backslash');

      if (!(e.metaKey || e.ctrlKey)) continue;

      // Already standing in it, one way or the other. The editor's walk and
      // the game are the same level from the same place, and two of them at
      // once is two loops, two keyboards and two of the drone.
      if (state().roaming) continue;

      e.preventDefault();
      started(state());
    }
  });
}

/** The game, on a sheet over everything, until whoever is in it leaves. */
let afoot: { game: Game, host: HTMLElement } | null = null;

function started(s: EditorState): void {
  // One at a time. A second Cmd+\ used to lay another game over the first
  // and leave it running underneath — its loop, its keyboard, its drone.
  if (afoot !== null) return;

  const host = document.createElement('div');

  host.style.cssText = 'position: fixed; inset: 0; z-index: 100; background: #000;';
  document.body.append(host);

  const leave = (): void => {
    if (afoot === null || afoot.host !== host) return;

    afoot.game.dispose();
    afoot = null;
    host.remove();
  };

  // No title screen: Cmd+\ is the gesture that asked for it, and the
  // level is already there.
  afoot = { game: play(host, shipped(s.world, s.bake), { title: false, credits: false, tools: true, leave }), host };
}

/**
 * The shortcuts that are about the document rather than about the canvas.
 *
 * They live here rather than in the canvas loop because that loop is only
 * listening between gestures: it is busy for as long as a drag runs, and undo
 * has no business being unavailable because a marquee is open. Every waiter on
 * the bus is woken, so both can watch the same keys without knowing about each
 * other — the canvas ignores anything with a command key on it, and everything
 * here has one bar the two tool letters.
 *
 * `a`, `v` and `p` are Illustrator's, and mean what they mean there: `a` to get
 * at the corners, `v` to get at whole polygons, `p` to draw a new one. Drawing
 * being its own tool is what lets a click on empty canvas mean letting go under
 * the other two, rather than having to guess between that and starting a shape.
 *
 * `i` is nobody's. Illustrator has no tool for dropping a thing into a level,
 * and the letters that would read as one are taken. `w` is the walk: the paths
 * tool measures how long one takes, and `p` is spoken for by the pen.
 *
 * Cmd+E resolves a group, which is the odd one out: every other shortcut here
 * writes into the version on screen, and that one rewrites the whole chain. See
 * `flattened`.
 *
 * Cmd+U unchains what is picked and Cmd+Shift+U chains it back up, the way
 * Cmd+G and Cmd+Shift+G are one question asked both ways round. See `loosened`.
 *
 * Cmd+[ and Cmd+] have what is picked born a keyframe earlier or later. See
 * `rebirthed`.
 *
 * Every key acted on has to be in the list waited on below, or the bus never
 * wakes for it and the branch that would have handled it is unreachable.
 */
function shortcuts(state: Value<EditorState>, input: Input, update: Update): VNode {
  return interaction(function* () {
    while (true) {
      const e = yield* keyPressed(
        input,
        'KeyA', 'KeyV', 'KeyP', 'KeyW', 'KeyI', 'KeyZ', 'KeyY', 'KeyC', 'KeyE', 'KeyG',
        'KeyU', 'KeyL', 'KeyK', 'BracketLeft', 'BracketRight',
        'Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract',
      );

      const command = e.metaKey || e.ctrlKey;

      // Whoever is walking has the keyboard. Undo with a command key on it is
      // still theirs to press, but A, V and S are strafing.
      if (state().roaming && !command) continue;

      if (!command) {
        if (e.code === 'BracketLeft' || e.code === 'BracketRight') continue;

        // The grid, finer and coarser. A document key rather than a canvas
        // one: what the grid is set to is a property of the drawing, and every
        // tool snaps to it — so it is reachable whatever is picked and
        // whatever gesture is not running.
        if (e.code === 'Equal' || e.code === 'NumpadAdd') {
          update(s => gridded(s, finer(s.settings.gridSize)));
        }
        else if (e.code === 'Minus' || e.code === 'NumpadSubtract') {
          update(s => gridded(s, coarser(s.settings.gridSize)));
        }
        else if (e.code === 'KeyA') update(s => ({ ...s, tool: 'point' }));
        else if (e.code === 'KeyV') update(s => ({ ...s, tool: 'polygon' }));
        else if (e.code === 'KeyP') update(s => ({ ...s, tool: 'create' }));
        else if (e.code === 'KeyW') update(s => ({ ...s, tool: 'path' }));
        else if (e.code === 'KeyI') update(s => ({ ...s, tool: 'artefact' }));

        continue;
      }

      // Cmd+plus and Cmd+minus are the browser's own zoom, and the wheel is
      // the canvas'. Neither is the grid.
      if (e.code === 'Equal' || e.code === 'Minus') continue;
      if (e.code === 'NumpadAdd' || e.code === 'NumpadSubtract') continue;

      if (e.code === 'KeyP') continue;

      // Cmd+W closes the window, which is emphatically not a tool switch.
      if (e.code === 'KeyW') continue;

      // Cmd+I is the browser's, and there is nothing here it would mean.
      if (e.code === 'KeyI') continue;

      // Cmd+A is select-all, which this does not have; leave it to the browser
      // rather than swallowing it into a tool switch.
      if (e.code === 'KeyA') continue;

      e.preventDefault();

      if (e.code === 'KeyZ') {
        // Cmd+Shift+Z is redo everywhere a Mac is involved, and Cmd+Y is redo
        // everywhere else. Both, since both hands turn up.
        update(e.shiftKey ? redone : undone);
      }
      else if (e.code === 'KeyY') {
        update(redone);
      }
      else if (e.code === 'KeyG') {
        update(e.shiftKey ? apart : together);
      }
      else if (e.code === 'KeyU') {
        update(s => loosened(s, e.shiftKey));
      }
      else if (e.code === 'KeyL') {
        update(s => shut(s, !e.shiftKey));
      }
      else if (e.code === 'KeyK') {
        update(s => (e.shiftKey ? cut(s) : ended(s)));
      }
      else if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
        update(s => rebirthed(s, e.code === 'BracketRight' ? 1 : -1));
      }
      else if (e.code === 'KeyE') {
        // Read out here rather than inside the update, because it asks a
        // question and an update has to be a function of the state alone.
        const done = flattened(state());

        if (done !== null) update(() => done);
      }
      else if (e.code === 'KeyC') {
        update(s => ({
          ...s,
          clipboard: copied(
            s.world,
            s.keyframe,
            [...s.selection.polygons, ...s.selection.artefacts, ...s.selection.paths],
          ),
        }));
      }
      else if (e.code === 'KeyV') {
        update(s => {
          if (s.clipboard.length === 0) return s;

          // One grid step down and right, so that a paste is something you can
          // see happen rather than a polygon hidden exactly under its original.
          const by = s.settings.gridSize;
          const at = { x: by, y: by };
          const where = landing(s.world, s.keyframe, s.inside);

          // Shift is the paste that leaves the history behind: what was copied
          // as it stands here, born here, saying nothing about any other
          // version. Plain paste brings the whole chain across.
          // Into the group standing open, if one is: a paste lands where the
          // author is working, and in here that is inside the group.
          const { world, ids, artefacts, paths, unrolled } = e.shiftKey
            ? stamped(s.world, s.keyframe, s.clipboard, at, where)
            : pasted(s.world, s.keyframe, s.clipboard, at, where);

          return noting(
            marked(
              {
                ...s,
                world,
                selection: { ...dropped(s.selection), polygons: ids, artefacts, paths },
              },
              s.world,
            ),
            'Pasted',
            unrolled,
          );
        });
      }
    }
  });
}

/**
 * The picked things' key at the keyframe on screen closed: what is done next
 * there is a key of its own rather than more of this one. See `broken`.
 *
 * Not an edit of what the world does — a closed key plays exactly as it did —
 * so it is not a gesture and writes no gesture id. It is in the history all
 * the same: undo takes back the break.
 */
function ended(s: EditorState): EditorState {
  const ids = [...s.selection.polygons, ...s.selection.artefacts, ...s.selection.paths];
  const world = broken(s.world, s.keyframe, ids);

  // On the empty keys: the next thing done fills them.
  return world === s.world
    ? s
    : {
      ...s,
      world,
      target: aiming(lastKeys(world, s.keyframe, ids)),
      status: null,
      history: { past: [...s.history.past, s.world], future: [] },
    };
}

/**
 * The last gesture taken out of the key it was folded into, into a key of its
 * own. See `split`.
 *
 * What it is split against is the world before the last step, which the
 * history is holding. Nothing where there is none — the first thing done in a
 * sitting has nothing to be taken out of.
 */
function cut(s: EditorState): EditorState {
  const was = s.history.past[s.history.past.length - 1];

  if (was === undefined) return saying(s, 'nothing has been done here to take out');

  const ids = [...s.selection.polygons, ...s.selection.artefacts, ...s.selection.paths];
  const on = new Map((s.target?.all ?? []).flatMap(p => ('key' in p ? [[p.id, p.key] as const] : [])));
  const world = split(s.world, was, s.keyframe, ids, on);

  // On what was split off, which is what the hand was doing.
  return world === s.world
    ? saying(s, 'the last thing done here is a key of its own already')
    : {
      ...s,
      world,
      target: aiming(newKeys(s.world, world, s.keyframe, ids)),
      status: null,
      history: { past: [...s.history.past, s.world], future: [] },
    };
}

/**
 * The picked things cut loose from everything before the version on screen, or
 * chained back up to it. See *Unchaining* in `scene.ts`.
 *
 * One key with a shift on it rather than two, the way grouping is: they are one
 * question — does this hear from upstream — asked both ways round.
 */
function loosened(s: EditorState, back: boolean): EditorState {
  const ids = [...s.selection.polygons, ...s.selection.artefacts, ...s.selection.paths];
  const how = back ? rechained : unchained;

  return marked({ ...s, world: how(s.world, s.keyframe, ids) }, s.world);
}

/**
 * The picked things born a keyframe later or earlier, each from its own birth
 * and taking its story with it. See `reborn`.
 *
 * A group is reached through its members, the way a delete reaches it. What
 * cannot go that far stays where it is, and says why.
 */
function rebirthed(s: EditorState, by: 1 | -1): EditorState {
  const ids = [...s.selection.polygons, ...s.selection.artefacts, ...s.selection.paths]
    .flatMap(id => within(s.world, id));
  let world = s.world;
  let refused: string | null = null;

  for (const id of new Set(ids)) {
    const it = world.polygons.get(id) ?? world.artefacts.get(id) ?? world.paths.get(id);
    if (it === undefined) continue;

    const to = keyAt(world, order(world, it.birth) + by);

    if (to === null) {
      refused = by < 0 ? 'nothing before the first keyframe to be born at' : 'nothing after the last keyframe to be born at';
      continue;
    }

    const out = reborn(world, id, to);

    if ('refused' in out) refused = out.refused;
    else world = out;
  }

  if (world === s.world) return refused === null ? s : saying(s, refused);

  return marked({ ...s, world }, s.world);
}

/** The grid at a new size. Not in the history: what the grid is set to is how
 * the author is working rather than something the world says. */
function gridded(s: EditorState, gridSize: number): EditorState {
  return { ...s, settings: { ...s.settings, gridSize } };
}

/** The picked things made one, and picked as one. */
function together(s: EditorState): EditorState {
  return joining(s, false) ?? s;
}

/** The picked things made one group, loose or sealed, and picked as one.
 * Nothing where there is nothing to group. */
function joining(s: EditorState, sealed: boolean): EditorState | null {
  // Artefacts and paths are members like anything else: a room, the key in it
  // and the tape across it is the group worth having, and holding them
  // together is what makes the key and the measurement go where the room goes.
  const made = grouped(
    s.world,
    s.keyframe,
    [...s.selection.polygons, ...s.selection.artefacts, ...s.selection.paths],
    landing(s.world, s.keyframe, s.inside),
  );

  if (made === null) return null;

  return marked(
    {
      ...s,
      world: sealed ? sealing(made.world, made.id, true) : made.world,
      selection: {
        ...s.selection,
        polygons: [made.id],
        artefacts: [],
        paths: [],
      },
    },
    s.world,
  );
}

/**
 * The picked groups taken apart, and their members picked instead.
 *
 * Nothing at all where taking one apart would not leave its members where
 * they were — see `ungrouped`. Refusing the whole gesture is the
 * point: half of it would leave the members displaced at the keyframes it could
 * not do.
 */
function apart(s: EditorState): EditorState {
  let world = s.world;
  const picked: Id[] = [];
  const unrolled: Unrolled[] = [];

  for (const id of s.selection.polygons) {
    const group = s.world.groups.get(id);

    if (group === undefined) {
      picked.push(id);
      continue;
    }

    const taken = ungrouping(world, id);

    if (taken === null) return s;

    world = taken.world;
    unrolled.push(...taken.unrolled);
    picked.push(...group.members);
  }

  // What came out goes back to the list it belongs in, since a group's members
  // are of every kind and the selection is not.
  const done = marked(
    {
      ...s,
      world,
      selection: {
        ...s.selection,
        polygons: picked.filter(id => !world.artefacts.has(id) && !world.paths.has(id)),
        artefacts: [
          ...s.selection.artefacts,
          ...picked.filter(id => world.artefacts.has(id)),
        ],
        paths: [...s.selection.paths, ...picked.filter(id => world.paths.has(id))],
      },
    },
    s.world,
  );

  return noting(done, 'Ungrouped', unrolled);
}

/**
 * The selection resolved: replaced by the polygons its union comes to at the
 * version on screen. See `resolve.ts`.
 *
 * The whole selection at once rather than one group at a time, because that is
 * what resolving a selection means — two rooms picked together are one shape,
 * exactly as they would be if they were grouped first. Which is how it is done:
 * see `resolveInto`. Then its effects laid in and its islands taken apart, so
 * each can be edited on its own: see `flattenInto`.
 *
 * The one gesture here that rewrites the whole chain rather than writing into
 * the version on screen, because the thing it replaces spans the whole chain.
 * Which is why it is a shortcut and nothing else — it is not a transform, there
 * is no handle for it, and undo is what takes it back.
 */
function flattened(s: EditorState): EditorState | null {
  // What each pick moves as, at the level being worked at: drilled into a
  // group, resolving two of its members is about those two.
  const path = opened(s.world, s.inside);
  const tops = [...new Set(s.selection.polygons.map(id => reaching(s.world, id, path)))];
  const where = landing(s.world, s.keyframe, s.inside);
  const done = flattenInto(s.world, s.keyframe, tops, where);

  if (done === null) return null;
  if (done.losing.length > 0 && !agreed(s, done.losing)) return null;

  const out = marked(
    {
      ...s,
      world: done.world,
      selection: { ...s.selection, polygons: done.ids },
      // The union may be nothing like what the selection was inside, and
      // standing in a group that no longer exists is a place with no way out.
      inside: done.world.groups.has(s.inside ?? -1) ? s.inside : null,
    },
    s.world,
  );

  return noting(out, 'Resolved', done.unrolled);
}

/**
 * The repeats a gesture had to take apart, said on the status line over what
 * it did — after `marked`, which clears it. Nothing where there were none.
 *
 * A status line rather than a question: nothing moved, and undo is there. What
 * it warns of is only how the result edits, and that it ends at the last
 * keyframe there is.
 */
function noting(s: EditorState, done: string, unrolled: readonly Unrolled[]): EditorState {
  if (unrolled.length === 0) return s;

  const n = unrolled.length;
  const why = [...new Set(unrolled.map(u => WHY[u.why]))].join('; ');

  return saying(
    s,
    `${done}. ${n} ${n === 1 ? 'repeat is' : 'repeats are'} now one entry per keyframe, `
      + `stopping at the last keyframe there is: ${why}.`,
  );
}

const WHY: Record<Unrolled['why'], string> = {
  squash: 'across a squash, a turn is a turn, a skew and a stretch rather than one operation',
  reshaped: 'the group turns, scales or skews while it runs',
  moving: 'a group\'s repeat is aimed at something that moves while it runs',
  order: 'a repeat running before it had to be taken apart',
};

/**
 * The picked things sealed into one, or the picked groups let loose again.
 *
 * Sealing is the ordinary way to make a group, so it does not ask for one
 * first: several things picked are grouped and the group sealed, in one step
 * and one undo. One group picked on its own is sealed where it is — wrapping
 * it in another would be a level of structure that says nothing.
 *
 * On what the pick reaches at the level being worked at, which inside an open
 * group is its members. Where there is nothing to do it says so, rather than
 * appearing to have done something.
 */
function shut(s: EditorState, sealed: boolean): EditorState {
  const path = opened(s.world, s.inside);
  const picked = [...new Set(s.selection.polygons.map(id => reaching(s.world, id, path)))];
  const groups = picked.filter(id => s.world.groups.has(id));
  const alone = picked.length === 1 && s.selection.artefacts.length === 0 && s.selection.paths.length === 0;

  if (sealed && !(alone && groups.length === 1)) {
    return joining(s, true)
      ?? saying(s, 'Nothing to seal. Cmd+L seals several picked things into one group, or a picked group as it is.');
  }

  if (groups.length === 0) {
    return saying(s, 'Nothing picked that is a group. Cmd+Shift+L lets a sealed group loose.');
  }

  const world = groups.reduce((w, id) => sealing(w, id, sealed), s.world);

  return marked({ ...s, world }, s.world);
}

/**
 * Whether the author wants what is about to be dropped dropped.
 *
 * The one thing about a resolve that cannot be seen by looking at the result:
 * the versions it empties are the ones you are not standing in, so the damage
 * is off screen by definition. Hence a question rather than a status line.
 *
 * Only when there is something to lose. A group nobody has animated resolves
 * without a word, which is nearly every one of them.
 */
function agreed(s: EditorState, losing: readonly KeyframeId[]): boolean {
  const name = (k: KeyframeId): string => s.world.keyframes[order(s.world, k)].name;
  const names = losing.map(name).join(', ');
  const here = name(s.keyframe);

  return confirm(
    `Resolving reads the group as it stands at ${here}, and that is the shape it `
    + 'becomes at every keyframe.\n\n'
    + `${names} ${losing.length === 1 ? 'moves' : 'move'} the members separately, and a `
    + 'union cannot carry that: an operation moves a whole polygon, and there is no one '
    + `operation that is what all of them were doing. ${names} will stop saying `
    + 'anything about it.\n\n'
    + 'The group\'s own moves and its erosion are kept.',
  );
}

// -----------------------------------------------------------------------------
// Toolbar
// -----------------------------------------------------------------------------

const BUTTON = 36;
const GAP = 2;
const PADDING = 4;

/** Each icon is drawn in its own 24×24 box, stroked in the button's colour.
 * `select` is the one button the three pickings share. */
interface ToolSpec {
  id: Exclude<Tool, Picking> | 'select'
  icon: VNode[]
}

const TOOLS: ToolSpec[] = [
  // An arrow, which is what selecting is everywhere.
  {
    id: 'select',
    icon: [
      path({ d: 'M6 3 V19 L10.2 15 L13 21 L15.6 19.8 L12.8 13.9 H18.5 Z' }),
    ],
  },

  {
    id: 'create',
    icon: [
      path({ d: 'M4.5 18.5 C 4.5 9, 19.5 15, 19.5 5.5' }),
      rect({ x: 2.5, y: 16.5, width: 4, height: 4 }),
      rect({ x: 17.5, y: 3.5, width: 4, height: 4 }),
    ],
  },

  {
    id: 'artefact',
    icon: [
      path({ d: 'M12 2.5 L20.5 9.5 L12 21.5 L3.5 9.5 Z' }),
      path({ d: 'M3.5 9.5 H20.5 M8.5 9.5 L12 21.5 L15.5 9.5 L12 2.5 Z' }),
    ],
  },

  // A route with a stopwatch on it: the legs of the walk, and the thing they
  // are measured in.
  {
    id: 'path',
    icon: [
      path({ d: 'M3.5 19.5 L9 12.5 L14 16 L20.5 6.5' }),
      circle({ cx: 17, cy: 17, r: 4 }),
      path({ d: 'M17 14.8 V17 H18.8' }),
    ],
  },
];

/**
 * What the create tool draws, in a row beside it while it is up.
 *
 * Beside rather than under: it is a second question about the same tool, and a
 * column of seven buttons where four of them only sometimes mean anything is a
 * column that has to be read every time. Out of the way entirely when another
 * tool is up, since then there is no question to answer.
 */
const FIGURE_ICONS: Record<Figure, VNode[]> = {
  rect: [rect({ x: 3.5, y: 5.5, width: 17, height: 13 })],

  ngon: [path({ d: 'M12 3 L20.6 8 V17 L12 21.5 L3.4 17 V8 Z' })],

  // The pen's own icon, since the polyline is what the tool did before there
  // was anything to choose between.
  polyline: [
    path({ d: 'M3.5 18.5 L9 8 L15 15 L20.5 5.5' }),
    rect({ x: 1.5, y: 16.5, width: 4, height: 4 }),
    rect({ x: 18.5, y: 3.5, width: 4, height: 4 }),
  ],
};

function figureBar(tool: Value<Tool>, figure: Value<Figure>, update: Update): VNode {
  const width = FIGURES.length * BUTTON + (FIGURES.length - 1) * GAP + 2 * PADDING;
  const height = BUTTON + 2 * PADDING;

  // Level with the create button, which is where the question it answers is
  // being asked from.
  const row = TOOLS.findIndex(spec => spec.id === 'create');

  return show(
    () => tool() === 'create',
    svg(
      {
        width,
        height,
        viewBox: `0 0 ${width} ${height}`,
        style: {
          position: 'absolute',
          left: `${12 + BUTTON + 2 * PADDING + 8}px`,
          top: `${12 + row * (BUTTON + GAP)}px`,
          filter: `drop-shadow(0 6px 18px ${theme.panelShadow})`,
        },
      },
      [
        rect({
          x: 0.5,
          y: 0.5,
          width: width - 1,
          height: height - 1,
          rx: 8,
          fill: theme.panel,
          stroke: theme.border,
        }),

        ...FIGURES.map((id, index) => button(
          FIGURE_ICONS[id],
          { x: PADDING + index * (BUTTON + GAP), y: PADDING },
          () => figure() === id,
          () => update(s => ({ ...s, figure: id })),
        )),
      ],
    ),
  );
}

/** The tools, stacked the way Illustrator stacks them. */
function toolbar(tool: Value<Tool>, update: Update): VNode {
  const width = BUTTON + 2 * PADDING;
  const height = TOOLS.length * BUTTON + (TOOLS.length - 1) * GAP + 2 * PADDING;

  return svg(
    {
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      style: {
        position: 'absolute',
        left: '12px',
        top: '12px',
        filter: `drop-shadow(0 6px 18px ${theme.panelShadow})`,
      },
    },
    [
      rect({
        x: 0.5,
        y: 0.5,
        width: width - 1,
        height: height - 1,
        rx: 8,
        fill: theme.panel,
        stroke: theme.border,
      }),

      ...TOOLS.map((spec, index) => toolButton(spec, index, tool, update)),
    ],
  );
}

function toolButton(
  spec: ToolSpec,
  index: number,
  tool: Value<Tool>,
  update: Update,
): VNode {
  const on = () => (spec.id === 'select' ? picks(tool()) : tool() === spec.id);

  // Back to selecting picks whole things, whatever was being picked before:
  // it is where a hand coming from another tool nearly always wants to be.
  const to = (t: Tool): Tool => (spec.id !== 'select' ? spec.id : picks(t) ? t : 'polygon');

  return button(
    spec.icon,
    { x: PADDING, y: PADDING + index * (BUTTON + GAP) },
    on,
    () => update(s => ({ ...s, tool: to(s.tool) })),
  );
}

/** How tall the toolbar is, for what goes under it. */
const TOOLBAR = TOOLS.length * BUTTON + (TOOLS.length - 1) * GAP + 2 * PADDING;

/** What the select tool picks, each its own icon: a whole outline, one edge
 * of it, one corner. */
const PICK_ICONS: Record<Picking, VNode[]> = {
  polygon: [path({ d: 'M12 3 L20.6 9.2 L17.3 19.3 H6.7 L3.4 9.2 Z' })],

  edge: [
    path({ d: 'M12 3 L20.6 9.2 L17.3 19.3 M6.7 19.3 L3.4 9.2 L12 3', 'stroke-dasharray': '1.5 2.5' }),
    path({ d: 'M6.7 19.3 H17.3', 'stroke-width': 3 }),
  ],

  point: [
    path({ d: 'M12 2.5 V8 M12 16 V21.5 M2.5 12 H8 M16 12 H21.5' }),
    circle({ cx: 12, cy: 12, r: 3 }),
  ],
};

/**
 * What the select tool picks, in a row beside it while it is up: whole
 * things, edges or corners. The figure bar's twin, for the same reason.
 */
function pickBar(tool: Value<Tool>, update: Update): VNode {
  const width = PICKINGS.length * BUTTON + (PICKINGS.length - 1) * GAP + 2 * PADDING;
  const height = BUTTON + 2 * PADDING;
  const row = TOOLS.findIndex(spec => spec.id === 'select');

  return show(
    () => picks(tool()),
    svg(
      {
        width,
        height,
        viewBox: `0 0 ${width} ${height}`,
        style: {
          position: 'absolute',
          left: `${12 + BUTTON + 2 * PADDING + 8}px`,
          top: `${12 + row * (BUTTON + GAP)}px`,
          filter: `drop-shadow(0 6px 18px ${theme.panelShadow})`,
        },
      },
      [
        rect({
          x: 0.5,
          y: 0.5,
          width: width - 1,
          height: height - 1,
          rx: 8,
          fill: theme.panel,
          stroke: theme.border,
        }),

        ...PICKINGS.map((id, index) => button(
          PICK_ICONS[id],
          { x: PADDING + index * (BUTTON + GAP), y: PADDING },
          () => tool() === id,
          () => update(s => ({ ...s, tool: id })),
        )),
      ],
    ),
  );
}

/** One square button with a 24×24 icon in it, filled when it is the one that
 * is on. Both bars are made of these, which is what makes the second read as
 * more of the first rather than as another piece of chrome. */
function button(
  icon: VNode[],
  at: { x: number, y: number },
  active: () => boolean,
  onclick: () => void,
): VNode {
  return g(
    {
      transform: `translate(${at.x}, ${at.y})`,
      style: { cursor: 'pointer' },
      onclick,
    },
    [
      rect({
        width: BUTTON,
        height: BUTTON,
        rx: 6,
        fill: () => (active() ? theme.accent : 'transparent'),
      }),

      g(
        {
          transform: `translate(${(BUTTON - 24) / 2}, ${(BUTTON - 24) / 2})`,
          fill: 'none',
          stroke: () => (active() ? theme.onAccent : theme.muted),
          'stroke-width': 1.4,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        },
        icon,
      ),
    ],
  );
}

// -----------------------------------------------------------------------------
// Beside the canvas, top right
// -----------------------------------------------------------------------------

const PANEL_WIDTH = 132;

// -----------------------------------------------------------------------------
// The bake
//
// Top right: one span per gap between two keyframes, and the count says how
// many of them are standing. An edit
// does not clear anything by hand — a span carries the world it was baked
// against, so `spanAt` stops answering for it and the count falls on its own.
// -----------------------------------------------------------------------------

const BAKE_HEIGHT = 52;

/** The gap between the two bake buttons, and how wide each is. */
const GUTTER = 6;
const NARROW = 48;
const WIDE = PANEL_WIDTH - 2 * PADDING - GUTTER - NARROW;

function bakeButton(
  state: Value<EditorState>,
  world: Value<World>,
  bake: Value<Bake>,
  update: Update,
): VNode {
  const spans = () => Math.max(1, world().keyframes.length - 1);
  const running = () => bake().progress !== null;

  const done = () => {
    const b = bake(), w = world();
    let n = 0;

    for (let k = 0; k < spans(); k++) {
      if (spanAt(b, w, k) !== null) n++;
    }

    return n;
  };

  const label = () => (running()
    ? `baking ${Math.round((bake().progress ?? 0) * 100)}%`
    : `bake  ${done()} / ${spans()}`);

  return svg(
    {
      width: PANEL_WIDTH,
      height: BAKE_HEIGHT,
      viewBox: `0 0 ${PANEL_WIDTH} ${BAKE_HEIGHT}`,
      style: {
        position: 'absolute',
        right: '12px',
        top: '12px',
        filter: `drop-shadow(0 6px 18px ${theme.panelShadow})`,
      },
    },
    [
      rect({
        x: 0.5,
        y: 0.5,
        width: PANEL_WIDTH - 1,
        height: BAKE_HEIGHT - 1,
        rx: 8,
        fill: theme.panel,
        stroke: theme.border,
      }),

      // Two buttons: the bake held to the tolerance, and a fast one to look at
      // while editing, which bounds the work at a frame and says what it let go.
      // See `FAST`.
      ...([
        [PADDING, WIDE, label, FRAMES],
        [PADDING + WIDE + GUTTER, NARROW, () => 'fast', FAST],
      ] as [number, number, () => string, Limits][]).map(([x, width, says, limits]) => g(
        {
          style: { cursor: 'pointer' },
          onclick: () => {
            if (!running()) start(state, update, limits);
          },
        },
        [
          rect({
            x,
            y: PADDING,
            width,
            height: 24,
            rx: 6,
            fill: () => (running() ? theme.border : theme.accent),
          }),

          text(
            {
              x: x + width / 2,
              y: PADDING + 16,
              'text-anchor': 'middle',
              fill: () => (running() ? theme.muted : theme.onAccent),
              'font-family': 'system-ui, sans-serif',
              'font-size': '12px',
            },
            says,
          ),
        ],
      )),

      // The bar reads as the spans it is filling: one tick per gap in the
      // chain, so a stalled bake says which span it stalled in.
      rect({
        x: PADDING,
        y: BAKE_HEIGHT - PADDING - 10,
        width: PANEL_WIDTH - 2 * PADDING,
        height: 6,
        rx: 3,
        fill: theme.border,
      }),

      rect({
        x: PADDING,
        y: BAKE_HEIGHT - PADDING - 10,
        width: () => (PANEL_WIDTH - 2 * PADDING)
          * (running() ? bake().progress ?? 0 : done() / spans()),
        height: 6,
        rx: 3,
        fill: () => (running() ? theme.accent : theme.csg),
      }),

      // One tick per gap between spans: their number is the structure, so
      // they alone are made again when it changes.
      dynamic(spans, n => g({}, Array.from({ length: n - 1 }, (_unused, i) => line({
        x1: PADDING + (PANEL_WIDTH - 2 * PADDING) * ((i + 1) / n),
        y1: BAKE_HEIGHT - PADDING - 10,
        x2: PADDING + (PANEL_WIDTH - 2 * PADDING) * ((i + 1) / n),
        y2: BAKE_HEIGHT - PADDING - 4,
        stroke: theme.panel,
        'stroke-width': 1,
      })))),
    ],
  );
}

/**
 * The switch for the 3D view.
 *
 * Under the bake button, because that is what it depends on: a level that has
 * not been baked has nothing to show, and the two read as one thought.
 */
function previewButton(showing: Value<boolean>, update: Update): VNode {
  const on = () => showing();

  return svg(
    {
      width: PANEL_WIDTH,
      height: BUTTON_ROW,
      viewBox: `0 0 ${PANEL_WIDTH} ${BUTTON_ROW}`,
      style: {
        position: 'absolute',
        right: '12px',
        top: `${12 + BAKE_HEIGHT + 8}px`,
        filter: `drop-shadow(0 6px 18px ${theme.panelShadow})`,
      },
    },
    [
      rect({
        x: 0.5,
        y: 0.5,
        width: PANEL_WIDTH - 1,
        height: BUTTON_ROW - 1,
        rx: 8,
        fill: theme.panel,
        stroke: theme.border,
      }),

      g(
        {
          style: { cursor: 'pointer' },
          onclick: () => update(s => ({ ...s, preview: !s.preview })),
        },
        [
          rect({
            x: PADDING,
            y: PADDING,
            width: PANEL_WIDTH - 2 * PADDING,
            height: 24,
            rx: 6,
            fill: () => (on() ? theme.accent : theme.border),
          }),

          text(
            {
              x: PANEL_WIDTH / 2,
              y: PADDING + 16,
              'text-anchor': 'middle',
              fill: () => (on() ? theme.onAccent : theme.text),
              'font-family': 'system-ui, sans-serif',
              'font-size': '12px',
            },
            () => (on() ? '3d view  on' : '3d view  off'),
          ),
        ],
      ),
    ],
  );
}

const BUTTON_ROW = 24 + 2 * PADDING;

/**
 * What the editor last had to say for itself.
 *
 * There is one thing it needs to say and it is always the same shape: *that
 * did not happen, and here is why*. A gesture the editor will not perform has
 * three ways to go — do it, do something else instead, or refuse — and the
 * third is only tolerable out loud. Eroding a loose group is the case that
 * asked for this: it used to seal the group and erode that, which is doing
 * something else instead, and the author's hand was on neither.
 *
 * Along the bottom, over the keyframes, absent when there is nothing to say, for the reason the
 * breadcrumb is absent at the top level: a bar that is always there is a bar
 * nobody reads, and it appearing *is* the signal.
 */
function statusbar(status: Value<string | null>): VNode {
  return show(
    () => status() !== null,
    div(
      {
        style: {
          marginLeft: '12px',
          padding: '6px 10px',
          borderRadius: '8px',
          background: theme.panel,
          border: `1px solid ${theme.border}`,
          boxShadow: `0 6px 18px ${theme.panelShadow}`,
          font: '12px system-ui, sans-serif',
          color: theme.text,

          // Nothing is clickable in it, and a bar along the bottom edge is
          // exactly where a marquee is being dragged from.
          pointerEvents: 'none',
        },
      },
      [textNode(() => status() ?? '')],
    ),
  );
}

/**
 * Where the cursor is standing, when it is standing inside a group.
 *
 * Absent at the top level rather than showing a root crumb, because the top
 * level is the resting state and a bar that is always there is a bar nobody
 * reads. It appearing *is* the signal that picking has been narrowed; the
 * crumbs are only how to get back somewhere other than one step.
 *
 * Every crumb is a way out to that level, and the leading one is a way out
 * altogether — which is the difference between this and Escape, and the reason
 * it earns its space on a four-deep path.
 */
function breadcrumb(world: Value<World>, inside: Value<GroupId | null>, update: Update): VNode {
  const crumbs = () => opened(world(), inside());

  /** Out to `to`, with nothing picked. Jumping two levels is two levels'
   * worth of the same step Escape takes. */
  const out = (to: GroupId | null) =>
    update(s => ({ ...s, inside: to, selection: { ...s.selection, polygons: [] } }));

  const crumb = (label: string, to: GroupId | null, last: boolean) =>
    span(
      {
        style: {
          cursor: last ? 'default' : 'pointer',
          color: last ? theme.text : theme.muted,
        },
        onclick: () => !last && out(to),
      },
      [textNode(label)],
    );

  return show(
    () => crumbs().length > 0,
    div(
      {
        style: {
          position: 'absolute',

          // Clear of the toolbar and the pick bar beside it rather than over
          // them. Along the top edge is where a path belongs and where every
          // program that has one puts it.
          left: `${12 + BUTTON + 2 * PADDING + 8 + PICKINGS.length * (BUTTON + GAP) + 2 * PADDING + 8}px`,
          top: '12px',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '6px 10px',
          borderRadius: '8px',
          background: theme.panel,
          border: `1px solid ${theme.border}`,
          boxShadow: `0 6px 18px ${theme.panelShadow}`,
          font: '12px system-ui, sans-serif',
          color: theme.muted,
        },
      },
      [
        dynamic(crumbs, at =>
          fragment([
            crumb('level', null, false),

            ...at.flatMap((id, i) => [
              span({ style: { color: theme.faded } }, [textNode('\u203a')]),
              crumb(`group ${id}`, id, i === at.length - 1),
            ]),
          ]),
        ),
      ],
    ),
  );
}

/**
 * The bake, run a slice at a time so the editor goes on drawing.
 *
 * A frame's worth of work, then the progress goes into the store and the
 * browser gets its turn. Nothing guards against the world changing underneath
 * it, because nothing has to: what comes out is stamped, and a span stamped
 * against a world that has moved is simply not a span any more.
 *
 * The bake standing when it starts is handed to the new one, which keeps every
 * track of it the edit did not reach. Stale spans and all — that is the point
 * of them. A span nobody may use any more still holds the tracks of the
 * polygons the author did not touch, which is nearly all of them, and each one
 * says for itself whether it still stands. See `signed`.
 *
 * The turn is a timeout rather than an animation frame. A frame is the better
 * pacing and the worse promise: a hidden tab stops being given them, and a bake
 * left half done because the author looked at something else is not a bake.
 */
function start(state: Value<EditorState>, update: Update, limits: Limits): void {
  const job = bakeAll(state().world, undefined, limits, state().bake);

  const pump = () => {
    const until = performance.now() + 12;

    let step = job.next();

    while (!step.done && performance.now() < until) {
      step = job.next();
    }

    if (step.done) {
      update(s => ({ ...s, bake: { ...s.bake, spans: step.value, progress: null } }));
      return;
    }

    update(s => ({ ...s, bake: { ...s.bake, progress: step.value } }));
    setTimeout(pump, 0);
  };

  update(s => ({ ...s, bake: { ...s.bake, progress: 0 } }));
  setTimeout(pump, 0);
}
