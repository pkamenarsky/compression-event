// -----------------------------------------------------------------------------
// The effects pane
//
// On the left, under the tools, while something is picked: which of the three
// effects the picked things have, and each one's options. A box ticked is an
// effect a thing has, one fact over every keyframe; how much is in its
// timeline, written by `d`, `e` and `b` on the canvas. Unticking takes the
// effect off and drops every amount of it with it — see `withoutEffect`.
//
// Erosion has no options, so there is nothing to tick on: its box says whether
// anything picked is eroded, and unticked drops every erosion written. It is in
// the pane anyway, in its place between the other two, because that is the
// order they happen in.
//
// With corners or edges picked, the pane is about the polygons they are on.
// An option changed is changed on every picked thing that has the effect, and
// is what the next thing given it starts with.
// -----------------------------------------------------------------------------

import { Value } from '@incpt/kontinuum';
import { VNode, dynamic, show, text } from '@incpt/kontinuum-dom';
import { div, input, label, option, select, span } from '@incpt/kontinuum-dom/html';

import { EffectName, eroded, givenEffect, hasEffect, unEroded, withEffect, withoutEffect } from './effects';
import { Pattern, Sides } from './geometry';
import { owning } from './scene';
import { theme } from './theme';
import { Effects, Id, Selection, Tool, Update, World, marked, picks } from './types';

type Some = 'all' | 'some' | 'none';

interface Model {
  deform: { on: Some, options: Required<Effects>['deform'] }
  erode: Some
  round: { on: Some, options: Required<Effects>['round'] }
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
  remembered: Value<Required<Effects>>,
  top: number,
  update: Update,
): VNode {
  const targets = () => (picks(tool()) ? effectTargets(world(), selection(), tool()) : []);

  // Rebuilt only when what it says changes, not on every edit to the world.
  const model = (): string => JSON.stringify(modelOf(world(), targets(), remembered()));

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
      [dynamic(model, m => body(JSON.parse(m) as Model, targets, update))],
    ),
  );
}

function modelOf(world: World, ids: readonly Id[], remembered: Required<Effects>): Model {
  const some = (has: (id: Id) => boolean): Some => {
    const n = ids.filter(has).length;

    return n === 0 ? 'none' : n === ids.length ? 'all' : 'some';
  };

  // The first picked thing's that has one, and otherwise what is remembered.
  const shown = <N extends EffectName>(name: N): Required<Effects>[N] => {
    const id = ids.find(i => hasEffect(world, i, name));

    return id === undefined ? remembered[name] : world.effects.get(id)![name]! as Required<Effects>[N];
  };

  return {
    deform: { on: some(id => hasEffect(world, id, 'deform')), options: shown('deform') },
    erode: some(id => eroded(world, id)),
    round: { on: some(id => hasEffect(world, id, 'round')), options: shown('round') },
  };
}

function body(m: Model, targets: () => Id[], update: Update): VNode {
  /** The effect on every one of them, or off every one where all had it. */
  const toggled = (name: EffectName, on: Some) => update(s => {
    const ids = targets();
    const world = on === 'all'
      ? ids.reduce((w, id) => withoutEffect(w, id, name), s.world)
      : givenEffect(s.world, ids, name, s.remembered[name]);

    return marked({ ...s, world }, s.world);
  });

  /** One option changed on every one that has the effect, and remembered. */
  const changed = <N extends EffectName>(name: N, patch: Partial<Required<Effects>[N]>) => update(s => {
    let world = s.world;

    for (const id of targets()) {
      const was = world.effects.get(id)?.[name];

      if (was !== undefined) world = withEffect(world, id, name, { ...was, ...patch } as Required<Effects>[N]);
    }

    const remembered = { ...s.remembered, [name]: { ...m[name].options, ...patch } };

    return marked({ ...s, world, remembered }, s.world);
  });

  const d = m.deform.options, r = m.round.options;

  return div({ style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, [
    heading('Deform', 'd', m.deform.on, () => toggled('deform', m.deform.on)),
    options(m.deform.on, [
      field('spacing', number(d.spacing, 1, v => changed('deform', { spacing: v }))),
      field('pattern', choice(PATTERNS, d.pattern, v => changed('deform', { pattern: v }))),
      field('sides', choice(SIDES, d.sides, v => changed('deform', { sides: v }))),
      ...(d.pattern === 'noise' ? [field('seed', number(d.seed, 0, v => changed('deform', { seed: Math.round(v) })))] : []),
    ]),

    // Nothing to give: the box goes off, and never on. See the head of the file.
    heading('Erode', 'e', m.erode, () => {
      if (m.erode !== 'none') update(s => marked({ ...s, world: targets().reduce(unEroded, s.world) }, s.world));
    }, m.erode === 'none'),

    heading('Round', 'b', m.round.on, () => toggled('round', m.round.on)),
    options(m.round.on, [
      field('segments', number(r.segments, 1, v => changed('round', { segments: Math.max(1, Math.round(v)) }))),
      field('verticals', tick(r.verticals, v => changed('round', { verticals: v }))),
    ]),
  ]);
}

/** An effect's box, its name and its key. */
function heading(name: string, key: string, on: Some, onchange: () => void, disabled = false): VNode {
  return label({ style: { display: 'flex', alignItems: 'center', gap: '6px', cursor: disabled ? 'default' : 'pointer' } }, [
    input({
      type: 'checkbox',
      checked: on === 'all',
      disabled,
      ref: (el: HTMLInputElement) => {
        el.indeterminate = on === 'some';
      },
      onchange: (e: Event) => {
        (e.target as HTMLInputElement).blur();
        onchange();
      },
    }),
    span({ style: { flex: '1', color: disabled ? theme.muted : theme.text } }, [text(name)]),
    span({ style: { color: theme.faded, fontSize: '11px' } }, [text(key)]),
  ]);
}

/** An effect's options, under its box, faded while nothing picked has it:
 * changed then, they are only what the next one given it starts with. */
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
