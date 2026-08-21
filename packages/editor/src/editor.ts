import { Value } from '@incpt/kontinuum';
import { VNode, object, stateful } from '@incpt/kontinuum-dom';
import { div } from '@incpt/kontinuum-dom/html';
import { circle, g, line, path, rect, svg, text } from '@incpt/kontinuum-dom/svg';
import { interaction } from '@incpt/kontinuum-interaction/dom';

import { Bake, bakeAll, spanAt } from './bake';
import { worldCanvas } from './canvas';
import { Input, createInput, inputListener, keyPressed } from './input';
import { copied, pasted, resolveAt } from './scene';
import { download, upload } from './save';
import { theme } from './theme';
import {
  EditorState,
  Tool,
  Update,
  VERSIONS,
  Version,
  VersionId,
  World,
  initialState,
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
          shortcuts(input, update),

          worldCanvas(
            s.world,
            s.settings,
            s.view,
            s.tool,
            s.selection,
            s.currentVersion,
            s.bake,
            input,
            update,
          ),

          toolbar(s.tool, update),
          versionStrip(s.world, s.currentVersion, update),
          bakeButton(state, s.world, s.bake, update),
        ],
      ),
    );
  });
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
 * `a` and `v` are Illustrator's, and mean what they mean there: `a` to get at
 * the corners, `v` to get at whole polygons.
 */
function shortcuts(input: Input, update: Update): VNode {
  return interaction(function* () {
    while (true) {
      const e = yield* keyPressed(
        input,
        'KeyA', 'KeyV', 'KeyZ', 'KeyY', 'KeyC',
      );

      const command = e.metaKey || e.ctrlKey;

      if (!command) {
        if (e.code === 'KeyA') update(s => ({ ...s, tool: 'point' }));
        else if (e.code === 'KeyV') update(s => ({ ...s, tool: 'polygon' }));

        continue;
      }

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
      else if (e.code === 'KeyC') {
        update(s => ({
          ...s,
          clipboard: copied(resolveAt(s.world, s.currentVersion), s.selection.polygons),
        }));
      }
      else if (e.code === 'KeyV') {
        update(s => {
          if (s.clipboard.length === 0) return s;

          // One grid step down and right, so that a paste is something you can
          // see happen rather than a polygon hidden exactly under its original.
          const by = s.settings.gridSize;
          const { world, ids } = pasted(
            s.world,
            s.currentVersion,
            s.clipboard,
            { x: by, y: by },
          );

          return marked(
            { ...s, world, selection: { ...s.selection, polygons: ids } },
            s.world,
          );
        });
      }
    }
  });
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
    id: 'path',
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
];

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
  const active = () => tool() === spec.id;
  const y = PADDING + index * (BUTTON + GAP);

  return g(
    {
      transform: `translate(${PADDING}, ${y})`,
      style: { cursor: 'pointer' },
      onclick: () => update(s => ({ ...s, tool: spec.id })),
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
        spec.icon,
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
        onclick: () => update(s => ({ ...s, currentVersion: index })),
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

  const toggle = () => update(s => {
    const versions = [...s.world.versions];
    versions[index] = { ...versions[index], visible: !versions[index].visible };

    return { ...s, world: { ...s.world, versions } };
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
