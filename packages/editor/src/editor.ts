import { Value } from '@incpt/kontinuum';
import { VNode, object, stateful } from '@incpt/kontinuum-dom';
import { div } from '@incpt/kontinuum-dom/html';
import { circle, g, line, path, rect, svg, text } from '@incpt/kontinuum-dom/svg';
import { interaction } from '@incpt/kontinuum-interaction/dom';

import { worldCanvas } from './canvas';
import { Input, createInput, inputListener, keyPressed } from './input';
import { download } from './save';
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
          saving(state, input),

          worldCanvas(
            s.world,
            s.settings,
            s.view,
            s.tool,
            s.selection,
            s.currentVersion,
            input,
            update,
          ),

          toolbar(s.tool, update),
          versionStrip(s.world, s.currentVersion, update),
        ],
      ),
    );
  });
}

/**
 * `o` puts the whole state in a file. It exists so that a world which is doing
 * something odd can be handed over as it is: the numbers that produced it, not
 * a picture of the result.
 */
function saving(state: Value<EditorState>, input: Input): VNode {
  return interaction(function* () {
    while (true) {
      const e = yield* keyPressed(input, 'KeyO');

      // Holding a key repeats it, and one press should be one file
      if (!e.repeat) download(state());
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
