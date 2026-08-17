import { Value } from '@incpt/kontinuum';
import { VNode, object, stateful } from '@incpt/kontinuum-dom';
import { div } from '@incpt/kontinuum-dom/html';
import { circle, g, path, rect, svg } from '@incpt/kontinuum-dom/svg';

import { worldCanvas } from './canvas';
import { createInput, inputListener } from './input';
import { theme } from './theme';
import { Tool, Update, World, initialState } from './types';

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

          worldCanvas(s.world, s.settings, s.view, input, update),
          toolbar(s.tool),
        ],
      ),
    );
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

/**
 * The tools, stacked the way Illustrator stacks them. Nothing is wired up yet:
 * the buttons show which tool is current and take no clicks.
 */
function toolbar(tool: Value<Tool>): VNode {
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

      ...TOOLS.map((spec, index) => toolButton(spec, index, tool)),
    ],
  );
}

function toolButton(spec: ToolSpec, index: number, tool: Value<Tool>): VNode {
  const active = () => tool() === spec.id;
  const y = PADDING + index * (BUTTON + GAP);

  return g({ transform: `translate(${PADDING}, ${y})`, style: { cursor: 'pointer' } }, [
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
  ]);
}
