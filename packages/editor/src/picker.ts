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
import { VNode, effect, fragment, ordered, show, text } from '@incpt/kontinuum-dom';
import { div } from '@incpt/kontinuum-dom/html';
import { interaction } from '@incpt/kontinuum-interaction/dom';

import { Input, keyOwned, pressedAway } from './input';
import { reachable } from './scene';
import { theme } from './theme';
import { labelOf } from './track';
import { EMPTY_SELECTION, EditorState, Flags, Update, World, clickable, flagged, flagsOf, marked } from './types';

type Beneath = NonNullable<EditorState['beneath']>;

/** One thing under the cursor, and how deep in its groups. */
type Item = Beneath['items'][number];

export function picker(beneath: Value<EditorState['beneath']>, world: Value<World>, input: Input, update: Update): VNode {
  const close = () => update(s => (s.beneath === null ? s : { ...s, beneath: null }));

  // Whose Escape it is while the list is up.
  const me = {};
  let root: (() => void) | null = null;

  return fragment([
    effect(() => beneath() !== null, on => (on ? input.claim(me, 'Escape') : undefined)),

    interaction(function* () {
      while (true) {
        const e = yield* keyOwned(input, me);

        e.preventDefault();
        close();
      }
    }),

    // A press anywhere else closes it — but only a list opened before that
    // press: the right click that opens the next one is a press elsewhere too,
    // and which of the two is heard first is nobody's to decide.
    interaction(function* () {
      while (true) {
        const e = yield* pressedAway(input, 'beneath');

        update(s => (s.beneath !== null && s.beneath.since < e.timeStamp ? { ...s, beneath: null } : s));
      }
    }),

    show(
      () => beneath() !== null,
      div(
        {
          ref: (el: HTMLElement) => {
            root = input.surface('beneath', el);
          },
          onUnmount: () => root?.(),
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
        // One line per thing under the cursor, kept by id: a switch flipped
        // changes its own line and nothing else.
        [ordered(() => beneath()?.items ?? [], it => it.id, (_index, it) => line(it, world, update))],
      ),
    ),
  ]);
}

function line(it: Value<Item>, world: Value<World>, update: Update): VNode {
  // Kept by id, so the id is the line's for as long as it is shown.
  const id = it().id;
  const flags = () => flagsOf(world(), id);
  const pickable = () => clickable(world(), id);

  const pick = () => update(s => {
    if (!clickable(s.world, id)) return s;

    const selection = s.world.artefacts.has(id)
      ? { ...EMPTY_SELECTION, artefacts: [id] }
      : s.world.paths.has(id) ? { ...EMPTY_SELECTION, paths: [id] } : { ...EMPTY_SELECTION, polygons: [id] };

    return {
      ...s,
      beneath: null,
      selection,
      // Standing in a group it is not in, it could not be reached: out to the
      // top, where it can.
      inside: reachable(s.world, id, s.inside) ? s.inside : null,
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
      background: () => (flags()[f] ? theme.accent : 'transparent'),
      color: () => (flags()[f] ? theme.onAccent : theme.faded),
    },
    onclick: () => update(s => marked({ ...s, world: flagged(s.world, id, f, !flagsOf(s.world, id)[f]) }, s.world)),
  }, [text(glyph)]);

  return div({ style: { display: 'flex', alignItems: 'center', gap: '4px', padding: '2px 8px' } }, [
    div({
      title: () => (pickable() ? 'Pick it' : 'Cannot be picked while it is locked or hidden'),
      style: {
        flex: '1',
        paddingLeft: () => `${it().depth * 12}px`,
        whiteSpace: 'nowrap',
        cursor: () => (pickable() ? 'pointer' : 'default'),
        color: () => (pickable() ? theme.text : theme.faded),
      },
      onclick: pick,
    }, [text(() => labelOf(world(), id))]),
    flag('hidden', 'H', 'Hidden: not drawn and not picked; still in the level'),
    flag('locked', 'L', 'Locked: drawn, not picked'),
    flag('solo', 'S', 'Solo: only what is soloed is drawn and picked'),
  ]);
}
