// -----------------------------------------------------------------------------
// What is under the cursor
//
// A right click on the canvas lists everything there, in its groups, whatever
// it is flagged: the way back to a locked or hidden thing without having to
// find its row among every other. Each line has the switches its timeline row
// has, and a click on its name picks it where it can be picked. The list stays
// up while the switches are flipped, and goes when something is picked, when
// Escape is pressed, or when anything else is.
// -----------------------------------------------------------------------------

import { Value } from '@incpt/kontinuum';
import { VNode, dynamic, effect, fragment, show, text } from '@incpt/kontinuum-dom';
import { div } from '@incpt/kontinuum-dom/html';
import { interaction } from '@incpt/kontinuum-interaction/dom';

import { Input } from './input';
import { reachable } from './scene';
import { theme } from './theme';
import { labelOf } from './track';
import { EMPTY_SELECTION, EditorState, Flags, Id, Update, World, clickable, flagged, flagsOf, marked } from './types';

type Beneath = NonNullable<EditorState['beneath']>;

interface Line {
  id: Id
  depth: number
  label: string
  flags: Flags
  pickable: boolean
}

export function picker(beneath: Value<EditorState['beneath']>, world: Value<World>, input: Input, update: Update): VNode {
  const close = () => update(s => (s.beneath === null ? s : { ...s, beneath: null }));

  let root: HTMLElement | null = null;

  const away = (e: PointerEvent) => {
    if (root !== null && !root.contains(e.target as Node)) close();
  };

  // Rebuilt only when what it says changes, not on every edit to the world.
  let last: { key: string, lines: { at: Beneath, lines: Line[] } } | null = null;

  const model = () => {
    const at = beneath();

    if (at === null) return null;

    const w = world();
    const lines = at.items.map(({ id, depth }) => ({
      id,
      depth,
      label: labelOf(w, id),
      flags: flagsOf(w, id),
      pickable: clickable(w, id),
    }));
    const key = JSON.stringify([at, lines]);

    if (last === null || last.key !== key) last = { key, lines: { at, lines } };

    return last.lines;
  };

  return fragment([
    effect(() => beneath() !== null, on => (on ? input.claim('Escape') : undefined)),

    interaction(function* () {
      while (true) {
        const e = yield* input.keyDown;

        if (e.code === 'Escape' && beneath() !== null) {
          // Said, so that the canvas does not also step out of a group.
          e.preventDefault();
          close();
        }
      }
    }),

    show(
      () => beneath() !== null,
      div(
        {
          ref: (el: HTMLElement) => {
            root = el;
            window.addEventListener('pointerdown', away, true);
          },
          onUnmount: () => window.removeEventListener('pointerdown', away, true),
          oncontextmenu: (e: MouseEvent) => e.preventDefault(),
          style: {
            position: 'fixed',
            left: () => `${beneath()?.x ?? 0}px`,
            top: () => `${beneath()?.y ?? 0}px`,
            zIndex: 20,
            minWidth: '200px',
            maxHeight: '50vh',
            overflow: 'auto',
            padding: '4px 0',
            background: theme.panel,
            border: `1px solid ${theme.border}`,
            borderRadius: '8px',
            boxShadow: `0 6px 18px ${theme.panelShadow}`,
            font: '11px system-ui, sans-serif',
            color: theme.text,
            userSelect: 'none',
          },
        },
        [dynamic(model, m => div({}, (m?.lines ?? []).map(l => line(l, update))))],
      ),
    ),
  ]);
}

function line(l: Line, update: Update): VNode {
  const pick = () => update(s => {
    if (!clickable(s.world, l.id)) return s;

    const selection = s.world.artefacts.has(l.id)
      ? { ...EMPTY_SELECTION, artefacts: [l.id] }
      : s.world.paths.has(l.id) ? { ...EMPTY_SELECTION, paths: [l.id] } : { ...EMPTY_SELECTION, polygons: [l.id] };

    return {
      ...s,
      beneath: null,
      selection,
      // Standing in a group it is not in, it could not be reached: out to the
      // top, where it can.
      inside: reachable(s.world, l.id, s.inside) ? s.inside : null,
    };
  });

  const flag = (f: keyof Flags, glyph: string, title: string) => div({
    title,
    style: {
      width: '18px',
      lineHeight: '16px',
      textAlign: 'center',
      borderRadius: '4px',
      cursor: 'pointer',
      fontSize: '10px',
      background: l.flags[f] ? theme.accent : 'transparent',
      color: l.flags[f] ? theme.onAccent : theme.faded,
    },
    onclick: () => update(s => marked({ ...s, world: flagged(s.world, l.id, f, !flagsOf(s.world, l.id)[f]) }, s.world)),
  }, [text(glyph)]);

  return div({ style: { display: 'flex', alignItems: 'center', gap: '4px', padding: '2px 8px' } }, [
    div({
      title: l.pickable ? 'Pick it' : 'Cannot be picked while it is locked or hidden',
      style: {
        flex: '1',
        paddingLeft: `${l.depth * 12}px`,
        whiteSpace: 'nowrap',
        cursor: l.pickable ? 'pointer' : 'default',
        color: l.pickable ? theme.text : theme.faded,
      },
      onclick: pick,
    }, [text(l.label)]),
    flag('hidden', 'H', 'Hidden: not drawn and not picked; still in the level'),
    flag('locked', 'L', 'Locked: drawn, not picked'),
    flag('solo', 'S', 'Solo: only what is soloed is drawn and picked'),
  ]);
}
