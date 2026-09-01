import { Value } from '@incpt/kontinuum';
import { VNode, dynamic, effect, fragment, object, show, stateful, text as textNode } from '@incpt/kontinuum-dom';
import { div, span } from '@incpt/kontinuum-dom/html';
import { circle, g, line, path, rect, svg, text } from '@incpt/kontinuum-dom/svg';
import { interaction } from '@incpt/kontinuum-interaction/dom';

import { Bake, bakeAll, spanAt } from './bake';
import { worldCanvas } from './canvas';
import { preview } from './view3d';
import { Input, createInput, inputListener, keyPressed } from './input';
import { copied, grouped, landing, pasted, stamped, ungrouped } from './scene';
import { Game, play } from '@ce/game';
import { shipped } from './export';
import { download, upload } from './save';
import { theme } from './theme';
import {
  EditorState,
  Id,
  EASINGS,
  REPLAY_EASE,
  REPLAY_MS,
  Tool,
  Update,
  VERSIONS,
  Version,
  VersionId,
  World,
  Figure,
  FIGURES,
  GroupId,
  coarser,
  finer,
  initialState,
  opened,
  marked,
  redone,
  undone,
} from './types';

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

  return stateful(initialState(initial), (state, set) => {
    const update: Update = fn => set(fn(state()));

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

          replaying(s.currentVersion, state, update),
          roaming(input, state, update),
          versions(input, update),

          worldCanvas(
            s.world,
            s.settings,
            s.view,
            s.tool,
            s.figure,
            s.selection,
            s.inside,
            s.currentVersion,
            s.replay,
            s.bake,
            s.roaming,
            input,
            update,
          ),

          preview(
            () => s.preview() || s.roaming(),
            s.world,
            s.bake,
            s.currentVersion,
            s.replay,
            s.roaming,
            update,
          ),

          breadcrumb(s.world, s.inside, update),
          toolbar(s.tool, update),
          figureBar(s.tool, s.figure, update),
          versionStrip(s.world, s.currentVersion, update),
          bakeButton(state, s.world, s.bake, update),
          previewButton(s.preview, update),
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
function replaying(current: Value<VersionId>, state: Value<EditorState>, update: Update): VNode {
  return effect(current, v => {
    const walk = state().replay;

    // A version can move without a transition being meant by it — a file
    // opened, a state restored. Only a walk that says it is going here is one.
    if (walk === null || walk.to !== v) return;

    const started = performance.now();
    const ms = REPLAY_MS * Math.abs(v - walk.from);
    const curve = EASINGS[REPLAY_EASE];

    let frame = requestAnimationFrame(function tick() {
      // The clock is linear and the walk is not. Whether it is over is a
      // question about the clock, so it is asked of `u` rather than of the
      // curve — a curve that touched 1 early would end the walk early.
      const u = Math.min(1, (performance.now() - started) / ms);

      update(s => ({ ...s, replay: u < 1 ? { ...walk, at: curve(u) } : null }));

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

      if (e.metaKey || e.ctrlKey || e.repeat) continue;

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
 * the strip from the canvas meant taking the hand off what it was doing.
 *
 * Switched the way the version strip switches it: `switched`, so a transition
 * is declared in the same update that moves the version and the walls morph
 * across rather than jump.
 *
 * The game is the exception, and the only one. It has the page, its own
 * keyboard and its own idea of which version is on — see `afoot`.
 */
function versions(input: Input, update: Update): VNode {
  return interaction(function* () {
    while (true) {
      const e = yield* keyPressed(input, 'ArrowUp', 'ArrowDown');

      if (e.metaKey || e.ctrlKey || afoot !== null) continue;

      e.preventDefault();

      // Down is forward, because the strip runs downward: the arrows walk it
      // the way it is drawn rather than the way time runs, and the strip is
      // what is on screen.
      const by = e.code === 'ArrowDown' ? 1 : -1;

      update(s => switched(s, clamped(s.currentVersion + by)));
    }
  });
}

function clamped(v: number): VersionId {
  return Math.min(VERSIONS - 1, Math.max(0, v));
}

/**
 * A version switch: where the walk is declared, in the one update that also
 * moves the version.
 *
 * Clicking the version already on screen is not a switch and does not start
 * one.
 */
function switched(s: EditorState, to: VersionId): EditorState {
  if (s.currentVersion === to) return s;

  // Nothing to play is not a walk. An edit invalidates every span after it, and
  // a transition declared over one that no longer stands leaves both views
  // trying to draw an instant that has no geometry — which reads as everything
  // between the two versions blinking out and back.
  if (!playable(s, to)) return { ...s, currentVersion: to, replay: null };

  return {
    ...s,
    currentVersion: to,
    replay: { from: s.currentVersion, to, at: 0 },
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
  return interaction(function* () {
    while (true) {
      const e = yield* keyPressed(input, 'KeyS', 'KeyO');

      // Holding a key repeats it, and one press should be one file
      if (!(e.metaKey || e.ctrlKey) || e.repeat) continue;

      e.preventDefault();

      if (e.code === 'KeyS') {
        download(state());
      }
      else {
        // The load lands whenever the picker is answered, which is long after
        // this. Everything the editor keeps is in the file bar the bake, and
        // `restored` supplies an empty one.
        upload(loaded => update(() => loaded));
      }
    }
  });
}

/** Whether every span between here and there has been baked and still stands.
 * `spanAt` decides, against the world in front of it, so an edit takes the
 * transition away without anything having to be told. */
function playable(s: EditorState, to: VersionId): boolean {
  const lo = Math.min(s.currentVersion, to), hi = Math.max(s.currentVersion, to);

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

      if (!(e.metaKey || e.ctrlKey) || e.repeat) continue;

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
  afoot = { game: play(host, shipped(s.world, s.bake), { title: false, leave }), host };
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
 */
function shortcuts(state: Value<EditorState>, input: Input, update: Update): VNode {
  return interaction(function* () {
    while (true) {
      const e = yield* keyPressed(
        input,
        'KeyA', 'KeyV', 'KeyP', 'KeyW', 'KeyI', 'KeyZ', 'KeyY', 'KeyC', 'KeyG',
        'Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract',
      );

      const command = e.metaKey || e.ctrlKey;

      // Whoever is walking has the keyboard. Undo with a command key on it is
      // still theirs to press, but A, V and S are strafing.
      if (state().roaming && !command) continue;

      if (!command) {
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

      // Undo and redo are the two worth holding down. One copy is one copy.
      if (e.repeat && e.code !== 'KeyZ' && e.code !== 'KeyY') continue;

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
      else if (e.code === 'KeyC') {
        update(s => ({
          ...s,
          clipboard: copied(
            s.world,
            s.currentVersion,
            [...s.selection.polygons, ...s.selection.artefacts],
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
          const where = landing(s.world, s.currentVersion, s.inside);

          // Shift is the paste that leaves the history behind: what was copied
          // as it stands here, born here, saying nothing about any other
          // version. Plain paste brings the whole chain across.
          // Into the group standing open, if one is: a paste lands where the
          // author is working, and in here that is inside the group.
          const { world, ids, artefacts } = e.shiftKey
            ? stamped(s.world, s.currentVersion, s.clipboard, at, where)
            : pasted(s.world, s.currentVersion, s.clipboard, at, where);

          return marked(
            {
              ...s,
              world,
              selection: { ...s.selection, polygons: ids, artefacts, start: false },
            },
            s.world,
          );
        });
      }
    }
  });
}

/** The grid at a new size. Not in the history: what the grid is set to is how
 * the author is working rather than something the world says. */
function gridded(s: EditorState, gridSize: number): EditorState {
  return { ...s, settings: { ...s.settings, gridSize } };
}

/** The picked things made one, and picked as one. */
function together(s: EditorState): EditorState {
  // Artefacts are members like anything else: a room and the key in it is the
  // group worth having, and holding them together is what makes the key go
  // where the room goes.
  const made = grouped(
    s.world,
    s.currentVersion,
    [...s.selection.polygons, ...s.selection.artefacts],
    landing(s.world, s.currentVersion, s.inside),
  );

  if (made === null) return s;

  return marked(
    {
      ...s,
      world: made.world,
      selection: { ...s.selection, polygons: [made.id], artefacts: [], start: false },
    },
    s.world,
  );
}

/**
 * The picked groups taken apart, and their members picked instead.
 *
 * Nothing at all where a version cannot hold what taking one apart would have
 * to write — see `composed`. Refusing the whole gesture is the point: half of
 * it would leave the members displaced at the versions it could not do.
 */
function apart(s: EditorState): EditorState {
  let world = s.world;
  const picked: Id[] = [];

  for (const id of s.selection.polygons) {
    const group = s.world.groups.get(id);

    if (group === undefined) {
      picked.push(id);
      continue;
    }

    const taken = ungrouped(world, id);

    if (taken === null) return s;

    world = taken;
    picked.push(...group.members);
  }

  // What came out goes back to the list it belongs in, since a group's members
  // are of both kinds and the selection is not.
  return marked(
    {
      ...s,
      world,
      selection: {
        ...s.selection,
        polygons: picked.filter(id => !world.artefacts.has(id)),
        artefacts: [
          ...s.selection.artefacts,
          ...picked.filter(id => world.artefacts.has(id)),
        ],
      },
    },
    s.world,
  );
}

// -----------------------------------------------------------------------------
// Toolbar
// -----------------------------------------------------------------------------

const BUTTON = 36;
const GAP = 2;
const PADDING = 4;

/** Each icon is drawn in its own 24×24 box, stroked in the button's colour. */
interface ToolSpec {
  id: Tool
  icon: VNode[]
}

const TOOLS: ToolSpec[] = [
  {
    id: 'point',
    icon: [
      path({ d: 'M12 2.5 V8 M12 16 V21.5 M2.5 12 H8 M16 12 H21.5' }),
      circle({ cx: 12, cy: 12, r: 3 }),
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

  {
    id: 'polygon',
    icon: [
      path({ d: 'M12 3 L20.6 9.2 L17.3 19.3 H6.7 L3.4 9.2 Z' }),
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
  return button(
    spec.icon,
    { x: PADDING, y: PADDING + index * (BUTTON + GAP) },
    () => tool() === spec.id,
    () => update(s => ({ ...s, tool: spec.id })),
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
// The version strip
//
// One widget doing two jobs, down the right-hand side. Nodes are the versions
// along the chain, top to bottom, so the shrink sequence reads in the order it
// happens; clicking one is how you go and stand in it, which is the only way to
// edit it. An eye each says whether that version draws as a ghost while another
// is on screen, Illustrator-style, which covers comparing against an arbitrary
// version rather than only against the neighbours.
//
// There are no span handles, and there is nothing here that reaches into
// another version. Edits always land in the version on screen.
// -----------------------------------------------------------------------------

const ROW = 34;
const RAIL = 22;
const STRIP_WIDTH = 132;

function versionStrip(
  world: Value<World>,
  current: Value<VersionId>,
  update: Update,
): VNode {
  const height = VERSIONS * ROW + 2 * PADDING;

  return svg(
    {
      width: STRIP_WIDTH,
      height,
      viewBox: `0 0 ${STRIP_WIDTH} ${height}`,
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
        width: STRIP_WIDTH - 1,
        height: height - 1,
        rx: 8,
        fill: theme.panel,
        stroke: theme.border,
      }),

      // The rail the nodes hang on, drawn once behind them: this is the chain,
      // and a fork would be another rail beside it.
      line({
        x1: RAIL,
        y1: PADDING + ROW / 2,
        x2: RAIL,
        y2: PADDING + (VERSIONS - 0.5) * ROW,
        stroke: theme.border,
        'stroke-width': 2,
      }),

      // The chain is a fixed length, so the rows are made once and each reads
      // its own version out of the world.
      ...Array.from({ length: VERSIONS }, (_unused, i) =>
        versionRow(i, () => world().versions[i], current, update)),
    ],
  );
}

function versionRow(
  index: VersionId,
  version: Value<Version>,
  current: Value<VersionId>,
  update: Update,
): VNode {
  const active = () => current() === index;
  const y = PADDING + index * ROW + ROW / 2;

  return g({ transform: `translate(0, ${y})` }, [
    g(
      {
        style: { cursor: 'pointer' },
        onclick: () => update(s => switched(s, index)),
      },
      [
        // A hit area over the whole row, so the name is as clickable as the node
        rect({
          x: PADDING,
          y: -ROW / 2,
          width: STRIP_WIDTH - 2 * PADDING - 24,
          height: ROW,
          rx: 6,
          fill: () => (active() ? theme.accent : 'transparent'),
        }),

        circle({
          cx: RAIL,
          cy: 0,
          r: 5.5,
          fill: () => (active() ? theme.onAccent : theme.panel),
          stroke: () => (active() ? theme.onAccent : theme.muted),
          'stroke-width': 2,
        }),

        text(
          {
            x: RAIL + 14,
            y: 4,
            fill: () => (active() ? theme.onAccent : theme.text),
            'font-family': 'system-ui, sans-serif',
            'font-size': '12px',
          },
          () => version().name,
        ),
      ],
    ),

    eye(version, update, index),
  ]);
}

/** Open when the version draws as a ghost, struck through when it does not. */
function eye(version: Value<Version>, update: Update, index: VersionId): VNode {
  const on = () => version().visible;
  const x = STRIP_WIDTH - PADDING - 18;

  // Through the history like every other write to the world, because that is
  // what the history is over: left out, an undo of the edit *before* the toggle
  // takes the toggle back with it, which is nothing the author asked for. The
  // bake survives it either way — a stamp compares each version's edits, and
  // this changes none of them.
  const toggle = () => update(s => {
    const versions = [...s.world.versions];
    versions[index] = { ...versions[index], visible: !versions[index].visible };

    return marked({ ...s, world: { ...s.world, versions } }, s.world);
  });

  return g(
    {
      transform: `translate(${x}, -8)`,
      style: { cursor: 'pointer' },
      onclick: toggle,
    },
    [
      rect({ width: 16, height: 16, fill: 'transparent' }),

      g(
        {
          fill: 'none',
          stroke: () => (on() ? theme.text : theme.faded),
          'stroke-width': 1.2,
          'stroke-linecap': 'round',
        },
        [
          path({ d: 'M1.5 8 C 4 4, 12 4, 14.5 8 C 12 12, 4 12, 1.5 8 Z' }),
          circle({ cx: 8, cy: 8, r: 2 }),
          path({ d: () => (on() ? '' : 'M2.5 13.5 L13.5 2.5') }),
        ],
      ),
    ],
  );
}

// -----------------------------------------------------------------------------
// The bake
//
// Under the version strip, because that is what it is about: one span per gap
// between two nodes, and the count says how many of them are standing. An edit
// does not clear anything by hand — a span carries the world it was baked
// against, so `spanAt` stops answering for it and the count falls on its own.
// -----------------------------------------------------------------------------

const BAKE_HEIGHT = 52;

function bakeButton(
  state: Value<EditorState>,
  world: Value<World>,
  bake: Value<Bake>,
  update: Update,
): VNode {
  const spans = VERSIONS - 1;
  const running = () => bake().progress !== null;

  const done = () => {
    const b = bake(), w = world();
    let n = 0;

    for (let k = 0; k < spans; k++) {
      if (spanAt(b, w, k) !== null) n++;
    }

    return n;
  };

  const label = () => (running()
    ? `baking ${Math.round((bake().progress ?? 0) * 100)}%`
    : `bake  ${done()} / ${spans}`);

  return svg(
    {
      width: STRIP_WIDTH,
      height: BAKE_HEIGHT,
      viewBox: `0 0 ${STRIP_WIDTH} ${BAKE_HEIGHT}`,
      style: {
        position: 'absolute',
        right: '12px',
        top: `${12 + VERSIONS * ROW + 2 * PADDING + 8}px`,
        filter: `drop-shadow(0 6px 18px ${theme.panelShadow})`,
      },
    },
    [
      rect({
        x: 0.5,
        y: 0.5,
        width: STRIP_WIDTH - 1,
        height: BAKE_HEIGHT - 1,
        rx: 8,
        fill: theme.panel,
        stroke: theme.border,
      }),

      g(
        {
          style: { cursor: 'pointer' },
          onclick: () => {
            if (!running()) start(state, update);
          },
        },
        [
          rect({
            x: PADDING,
            y: PADDING,
            width: STRIP_WIDTH - 2 * PADDING,
            height: 24,
            rx: 6,
            fill: () => (running() ? theme.border : theme.accent),
          }),

          text(
            {
              x: STRIP_WIDTH / 2,
              y: PADDING + 16,
              'text-anchor': 'middle',
              fill: () => (running() ? theme.muted : theme.onAccent),
              'font-family': 'system-ui, sans-serif',
              'font-size': '12px',
            },
            label,
          ),
        ],
      ),

      // The bar reads as the spans it is filling: one tick per gap in the
      // chain, so a stalled bake says which span it stalled in.
      rect({
        x: PADDING,
        y: BAKE_HEIGHT - PADDING - 10,
        width: STRIP_WIDTH - 2 * PADDING,
        height: 6,
        rx: 3,
        fill: theme.border,
      }),

      rect({
        x: PADDING,
        y: BAKE_HEIGHT - PADDING - 10,
        width: () => (STRIP_WIDTH - 2 * PADDING)
          * (running() ? bake().progress ?? 0 : done() / spans),
        height: 6,
        rx: 3,
        fill: () => (running() ? theme.accent : theme.csg),
      }),

      ...Array.from({ length: spans - 1 }, (_unused, i) => line({
        x1: PADDING + (STRIP_WIDTH - 2 * PADDING) * ((i + 1) / spans),
        y1: BAKE_HEIGHT - PADDING - 10,
        x2: PADDING + (STRIP_WIDTH - 2 * PADDING) * ((i + 1) / spans),
        y2: BAKE_HEIGHT - PADDING - 4,
        stroke: theme.panel,
        'stroke-width': 1,
      })),
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
      width: STRIP_WIDTH,
      height: BUTTON_ROW,
      viewBox: `0 0 ${STRIP_WIDTH} ${BUTTON_ROW}`,
      style: {
        position: 'absolute',
        right: '12px',
        top: `${12 + VERSIONS * ROW + 2 * PADDING + 8 + BAKE_HEIGHT + 8}px`,
        filter: `drop-shadow(0 6px 18px ${theme.panelShadow})`,
      },
    },
    [
      rect({
        x: 0.5,
        y: 0.5,
        width: STRIP_WIDTH - 1,
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
            width: STRIP_WIDTH - 2 * PADDING,
            height: 24,
            rx: 6,
            fill: () => (on() ? theme.accent : theme.border),
          }),

          text(
            {
              x: STRIP_WIDTH / 2,
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

          // Clear of the toolbar rather than over it. Along the top edge is
          // where a path belongs and where every program that has one puts it.
          left: `${12 + BUTTON + 2 * PADDING + 8}px`,
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
 * The turn is a timeout rather than an animation frame. A frame is the better
 * pacing and the worse promise: a hidden tab stops being given them, and a bake
 * left half done because the author looked at something else is not a bake.
 */
function start(state: Value<EditorState>, update: Update): void {
  const job = bakeAll(state().world);

  const pump = () => {
    const until = performance.now() + 12;

    let step = job.next();

    while (!step.done && performance.now() < until) {
      step = job.next();
    }

    if (step.done) {
      update(s => ({ ...s, bake: { spans: step.value, progress: null } }));
      return;
    }

    update(s => ({ ...s, bake: { ...s.bake, progress: step.value } }));
    setTimeout(pump, 0);
  };

  update(s => ({ ...s, bake: { ...s.bake, progress: 0 } }));
  setTimeout(pump, 0);
}
