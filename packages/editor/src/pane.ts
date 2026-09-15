// -----------------------------------------------------------------------------
// The effects pane
//
// On the left, under the tools, while something is picked: which of the three
// effects apply to the picked things, and each one's options. A box ticked is
// an effect switched on, one fact over every keyframe; how much is in its
// timeline, written by `d`, `e` and `b` on the canvas. Unticking switches it
// off and takes nothing away: its options and amounts apply again when it is
// ticked. Erosion has no options, so its box is only the switch.
//
// With corners or edges picked, the pane is about the polygons they are on —
// except the round under the corner tool, which is about the corners' own:
// ticked, unticked and optioned apart from their polygon's, and put back to
// it by the link under it. An option changed is changed on every picked thing
// that has the effect, and is what the next thing given it starts with.
// -----------------------------------------------------------------------------

import { Value } from '@incpt/kontinuum';
import { VNode, dynamic, show, text } from '@incpt/kontinuum-dom';
import { div, input, label, option, select, span } from '@incpt/kontinuum-dom/html';

import {
  EffectName,
  Switch,
  applies,
  cornerRound,
  cornerRounding,
  cornersInheriting,
  cornersOptioned,
  cornersSwitched,
  ownRound,
  switchedOff,
  switchedOn,
  withEffect,
} from './effects';
import { Pattern, Sides } from './geometry';
import { owning } from './scene';
import { theme } from './theme';
import { Id, Options, Selection, Tool, Update, VertexId, World, marked, picks } from './types';

type Some = 'all' | 'some' | 'none';

interface Model {
  deform: { on: Some, options: Options['deform'] }
  erode: Some
  /** With `corners`, about the picked corners' own rounds, and `own` is how
   * many of them have options of their own. */
  round: { on: Some, options: Options['round'], corners: boolean, own: Some }
}

const PATTERNS: Pattern[] = ['zigzag', 'sine', 'noise'];
const SIDES: Sides[] = ['both', 'out', 'in'];

/** What the pane is about: the things picked, or the polygons of the corners
 * or edges picked. */
export function effectTargets(world: World, selection: Selection, tool: Tool): Id[] {
  if (tool === 'point') return owning(world, new Set(selection.vertices));
  if (tool === 'edge') return owning(world, new Set(selection.edges));

  return selection.polygons.filter(id => world.polygons.has(id) || world.groups.has(id));
}

export function effectsPane(
  world: Value<World>,
  selection: Value<Selection>,
  tool: Value<Tool>,
  remembered: Value<Options>,
  top: number,
  update: Update,
): VNode {
  const targets = () => (picks(tool()) ? effectTargets(world(), selection(), tool()) : []);

  // A round under the corner tool is about the corners picked.
  const corners = () => (tool() === 'point' ? selection().vertices : []);

  // Rebuilt only when what it says changes, not on every edit to the world.
  const model = (): string => JSON.stringify(modelOf(world(), targets(), corners(), remembered()));

  return show(
    () => targets().length > 0,
    div(
      {
        style: {
          position: 'absolute',
          left: '12px',
          top: `${top}px`,
          width: '196px',
          padding: '8px 10px',
          boxSizing: 'border-box',
          borderRadius: '8px',
          background: theme.panel,
          border: `1px solid ${theme.border}`,
          boxShadow: `0 6px 18px ${theme.panelShadow}`,
          font: '12px system-ui, sans-serif',
          color: theme.text,
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
        },
      },
      [dynamic(model, m => body(JSON.parse(m) as Model, targets, corners, update))],
    ),
  );
}

/** How many of `all` something holds for. */
function some<T>(all: readonly T[], has: (t: T) => boolean): Some {
  const n = all.filter(has).length;

  return n === 0 ? 'none' : n === all.length ? 'all' : 'some';
}

/** Options as shown and remembered: without whether they are switched off. */
function bare<O extends { off?: boolean }>(o: O): O {
  const { off: _off, ...rest } = o;

  return rest as O;
}

function modelOf(world: World, ids: readonly Id[], corners: readonly VertexId[], remembered: Options): Model {
  // The first picked thing's that has one, switched on or not, and otherwise
  // what is remembered.
  const shown = <N extends EffectName>(name: N): Options[N] => {
    const id = ids.find(i => world.effects.get(i)?.[name] !== undefined);

    return bare(id === undefined ? remembered[name] : world.effects.get(id)![name]! as Options[N]);
  };

  const mine = corners.length > 0;
  const first = mine ? cornerRound(world, corners[0]) : undefined;

  return {
    deform: { on: some(ids, id => applies(world, id, 'deform')), options: shown('deform') },
    erode: some(ids, id => applies(world, id, 'erode')),
    round: mine
      ? {
          on: some(corners, c => cornerRounding(world, c)),
          options: first === undefined ? remembered.round : bare(first),
          corners: true,
          own: some(corners, c => ownRound(world, c)),
        }
      : { on: some(ids, id => applies(world, id, 'round')), options: shown('round'), corners: false, own: 'none' },
  };
}

function body(m: Model, targets: () => Id[], corners: () => VertexId[], update: Update): VNode {
  /** Switched on for every one of them, or off where every one had it on. */
  const toggled = (name: Switch, on: Some) => update(s => {
    const ids = targets();
    const world = on === 'all' ? switchedOff(s.world, ids, name) : switchedOn(s.world, ids, name, s.remembered);

    return marked({ ...s, world }, s.world);
  });

  /** One option changed on every one that has the effect, on or off, and
   * remembered. */
  const changed = <N extends EffectName>(name: N, patch: Partial<Options[N]>) => update(s => {
    let world = s.world;

    if (name === 'round' && m.round.corners) {
      world = cornersOptioned(world, corners(), patch, s.remembered);
    }
    else {
      for (const id of targets()) {
        const was = world.effects.get(id)?.[name];

        if (was !== undefined) world = withEffect(world, id, name, { ...was, ...patch } as Options[N]);
      }
    }

    const remembered = { ...s.remembered, [name]: { ...m[name].options, ...patch } };

    return marked({ ...s, world, remembered }, s.world);
  });

  const cornered = (on: boolean) => update(s => marked({ ...s, world: cornersSwitched(s.world, corners(), on, s.remembered) }, s.world));
  const inherited = () => update(s => marked({ ...s, world: cornersInheriting(s.world, corners()) }, s.world));

  const d = m.deform.options, r = m.round.options;

  return div({ style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, [
    heading('Deform', 'd', m.deform.on, () => toggled('deform', m.deform.on)),
    options(m.deform.on, [
      field('spacing', number(d.spacing, 1, v => changed('deform', { spacing: v }))),
      field('pattern', choice(PATTERNS, d.pattern, v => changed('deform', { pattern: v }))),
      field('sides', choice(SIDES, d.sides, v => changed('deform', { sides: v }))),
      ...(d.pattern === 'noise' ? [field('seed', number(d.seed, 0, v => changed('deform', { seed: Math.round(v) })))] : []),
    ]),

    heading('Erode', 'e', m.erode, () => toggled('erode', m.erode)),

    heading(m.round.corners ? 'Round corners' : 'Round', 'b', m.round.on, () => {
      if (m.round.corners) cornered(m.round.on !== 'all');
      else toggled('round', m.round.on);
    }),
    options(m.round.on, [
      field('segments', number(r.segments, 1, v => changed('round', { segments: Math.max(1, Math.round(v)) }))),
      field('verticals', tick(r.verticals, v => changed('round', { verticals: v }))),
      ...(m.round.own === 'none' ? [] : [field('', link('as the polygon', inherited))]),
    ]),
  ]);
}

/** An effect's box, its name and its key. */
function heading(name: string, key: string, on: Some, onchange: () => void): VNode {
  return label({ style: { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' } }, [
    input({
      type: 'checkbox',
      checked: on === 'all',
      ref: (el: HTMLInputElement) => {
        el.indeterminate = on === 'some';
      },
      onchange: (e: Event) => {
        (e.target as HTMLInputElement).blur();
        onchange();
      },
    }),
    span({ style: { flex: '1' } }, [text(name)]),
    span({ style: { color: theme.faded, fontSize: '11px' } }, [text(key)]),
  ]);
}

/** An effect's options, under its box, faded while it applies to nothing
 * picked: changed then, they are what it will be when it does. */
function options(on: Some, fields: VNode[][]): VNode {
  return div({
    style: {
      display: 'grid',
      gridTemplateColumns: 'auto 1fr',
      alignItems: 'center',
      gap: '4px 8px',
      paddingLeft: '22px',
      opacity: on === 'none' ? '0.5' : '1',
    },
  }, fields.flat());
}

function field(name: string, control: VNode): VNode[] {
  return [span({ style: { color: theme.muted } }, [text(name)]), control];
}

const CONTROL = {
  width: '100%',
  boxSizing: 'border-box',
  background: 'transparent',
  color: theme.text,
  border: `1px solid ${theme.border}`,
  borderRadius: '4px',
  font: '12px system-ui, sans-serif',
  padding: '1px 4px',
} as const;

function number(value: number, min: number, onchange: (v: number) => void): VNode {
  return input({
    type: 'number',
    value: String(value),
    min: String(min),
    style: CONTROL,
    onchange: (e: Event) => {
      const el = e.target as HTMLInputElement;
      const v = el.valueAsNumber;

      el.blur();

      if (Number.isFinite(v) && v >= min) onchange(v);
    },
  });
}

function choice<T extends string>(all: readonly T[], value: T, onchange: (v: T) => void): VNode {
  return select({
    style: CONTROL,
    onchange: (e: Event) => {
      const el = e.target as HTMLSelectElement;

      el.blur();
      onchange(el.value as T);
    },
  }, all.map(v => option({ value: v, selected: v === value }, [text(v)])));
}

function tick(value: boolean, onchange: (v: boolean) => void): VNode {
  return input({
    type: 'checkbox',
    checked: value,
    style: { justifySelf: 'start' },
    onchange: (e: Event) => {
      const el = e.target as HTMLInputElement;

      el.blur();
      onchange(el.checked);
    },
  });
}

/** A button that reads as text: taking something back rather than setting it. */
function link(name: string, onclick: () => void): VNode {
  return span({ style: { color: theme.accent, cursor: 'pointer', fontSize: '11px' }, onclick }, [text(name)]);
}
