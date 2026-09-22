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

import { ObjectValue, Value } from '@incpt/kontinuum';
import { VNode, fragment, object, show, text } from '@incpt/kontinuum-dom';
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

/**
 * What the pane says, flat and in plain values, so that `object` wakes each
 * control for its own field alone: the pane is made once, and a change moves
 * what it shows rather than making it again — a field being typed into keeps
 * its focus and a select stays open.
 *
 * With `corners`, the round is about the picked corners' own, and `own` is
 * how many of them have options of their own.
 */
interface Model {
  deform: Some
  spacing: number
  pattern: Pattern
  sides: Sides
  seed: number
  jitter: number
  clear: boolean
  /** Whether a polygon is among them: `clear` is a polygon's alone. */
  polygons: boolean
  erode: Some
  round: Some
  precision: number
  tension: number
  chamfer: boolean
  corners: boolean
  own: Some
}

const PATTERNS: Pattern[] = ['zigzag', 'sine', 'noise'];
const SIDES: Sides[] = ['both', 'out', 'in'];

/** The most jitter, in percent of the spacing. */
const JITTER = 90;

/** The finest precision a round is asked for: past it, `FINEST` segments
 * cap it anyway. */
const PRECISEST = 0.01;

/** Where the sliders stop. The box beside each takes more, up to whatever the
 * field itself allows: these are the ranges worth reaching by hand. */
const SPACING = 100;
const SEEDS = 100;
const COARSEST = 2;

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

  const model = (): Model => modelOf(world(), targets(), corners(), remembered());

  return show(
    () => targets().length > 0,
    div(
      {
        style: {
          position: 'absolute',
          left: '12px',
          top: `${top}px`,
          width: '232px',
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
      [object(model, m => body(m, targets, corners, update))],
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

    return id === undefined ? remembered[name] : world.effects.get(id)![name]! as Options[N];
  };

  const mine = corners.length > 0;
  const d = shown('deform');
  const r = mine ? cornerRound(world, corners[0]) ?? remembered.round : shown('round');

  return {
    deform: some(ids, id => applies(world, id, 'deform')),
    spacing: d.spacing,
    pattern: d.pattern,
    sides: d.sides,
    seed: d.seed,
    jitter: d.jitter,
    clear: d.clear,
    polygons: ids.some(id => world.polygons.has(id)),
    erode: some(ids, id => applies(world, id, 'erode')),
    round: mine ? some(corners, c => cornerRounding(world, c)) : some(ids, id => applies(world, id, 'round')),
    precision: r.precision,
    tension: r.tension,
    chamfer: r.chamfer,
    corners: mine,
    own: mine ? some(corners, c => ownRound(world, c)) : 'none',
  };
}

function body(m: ObjectValue<Model>, targets: () => Id[], corners: () => VertexId[], update: Update): VNode {
  /** Switched on for every one of them, or off where every one had it on. */
  const toggled = (name: Switch, on: Some) => update(s => {
    const ids = targets();
    const world = on === 'all' ? switchedOff(s.world, ids, name) : switchedOn(s.world, ids, name, s.remembered);

    return marked({ ...s, world }, s.world);
  });

  /** One option changed on every one that has the effect, on or off — or on
   * the picked corners' own rounds — and remembered. `further` is a slider
   * still moving: the step before it already went into the history, so this
   * one only carries it on. */
  const changed = <N extends EffectName>(name: N, patch: Partial<Options[N]>, further = false) => update(s => {
    let world = s.world;

    if (name === 'round' && m.corners()) {
      world = cornersOptioned(world, corners(), patch, s.remembered);
    }
    else {
      for (const id of targets()) {
        const was = world.effects.get(id)?.[name];

        if (was !== undefined) world = withEffect(world, id, name, { ...was, ...patch } as Options[N]);
      }
    }

    const shown = name === 'round'
      ? { precision: m.precision(), tension: m.tension(), chamfer: m.chamfer() }
      : { spacing: m.spacing(), pattern: m.pattern(), sides: m.sides(), seed: m.seed(), jitter: m.jitter(), clear: m.clear() };
    const remembered = { ...s.remembered, [name]: { ...shown, ...patch } };

    return further ? { ...s, world, remembered } : marked({ ...s, world, remembered }, s.world);
  });

  const rounded = () => {
    if (!m.corners()) return toggled('round', m.round());

    const on = m.round() !== 'all';

    update(s => marked({ ...s, world: cornersSwitched(s.world, corners(), on, s.remembered) }, s.world));
  };

  const inherited = () => update(s => marked({ ...s, world: cornersInheriting(s.world, corners()) }, s.world));

  return div({ style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, [
    heading(() => 'Deform', 'd', m.deform, () => toggled('deform', m.deform())),
    options(m.deform, [
      field('spacing', slider(m.spacing, 1, SPACING, (v, further) => changed('deform', { spacing: v }, further), Infinity)),
      field('pattern', choice(PATTERNS, m.pattern, v => changed('deform', { pattern: v }))),
      field('sides', choice(SIDES, m.sides, v => changed('deform', { sides: v }))),
      // Out of the spacing, as a percentage, and short of a whole one: teeth
      // strayed by as much as their spacing would pass each other.
      field('jitter %', slider(() => Math.round(m.jitter() * 100), 0, JITTER, (v, further) => changed('deform', { jitter: Math.round(v) / 100 }, further))),
      // A seed is the noise's and the jitter's.
      show(() => m.pattern() === 'noise' || m.jitter() > 0, fragment(field('seed', slider(m.seed, 0, SEEDS, (v, further) => changed('deform', { seed: Math.round(v) }, further), Infinity)))),
      // Teeth stopping short of the corners' rounds rather than running into
      // them. A group's round is of its union, which has no corners to keep.
      show(m.polygons, fragment(field('clear corners', tick(m.clear, v => changed('deform', { clear: v }))))),
    ]),

    heading(() => 'Erode', 'e', m.erode, () => toggled('erode', m.erode())),

    heading(() => (m.corners() ? 'Round corners' : 'Round'), 'b', m.round, rounded),
    options(m.round, [
      // How near its facets keep to its curve, as a length: finer is more of
      // them, as many as each corner's bevel needs, closest where it bends.
      show(() => !m.chamfer(), fragment(field('precision', slider(m.precision, PRECISEST, COARSEST, (v, further) => changed('round', { precision: v }, further), Infinity, 'any')))),
      // From about a circle at nought to tight in the corner at one.
      show(() => !m.chamfer(), fragment(field('tension', slider(m.tension, 0, 1, (v, further) => changed('round', { tension: v }, further), 1, '0.05')))),
      field('chamfer', tick(m.chamfer, v => changed('round', { chamfer: v }))),
      show(() => m.own() !== 'none', fragment(field('', link('as the polygon', inherited)))),
    ]),
  ]);
}

/** An effect's box, its name and its key. */
function heading(name: Value<string>, key: string, on: Value<Some>, onchange: () => void): VNode {
  return label({ style: { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' } }, [
    input({
      type: 'checkbox',
      checked: () => on() === 'all',
      // A property kontinuum sets as one, missing from its attribute types.
      ...({ indeterminate: () => on() === 'some' } as object),
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
function options(on: Value<Some>, fields: (VNode | VNode[])[]): VNode {
  return div({
    style: {
      display: 'grid',
      gridTemplateColumns: 'auto minmax(0, 1fr)',
      alignItems: 'center',
      gap: '4px 8px',
      paddingLeft: '22px',
      opacity: () => (on() === 'none' ? '0.5' : '1'),
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

function number(value: Value<number>, min: number, onchange: (v: number) => void, max = Infinity, step?: string): VNode {
  return input({
    type: 'number',
    value: () => String(value()),
    min: String(min),
    ...(step === undefined ? {} : { step }),
    ...(max === Infinity ? {} : { max: String(max) }),
    style: CONTROL,
    onchange: (e: Event) => {
      const el = e.target as HTMLInputElement;
      const v = el.valueAsNumber;

      el.blur();

      // Nothing it would take: back to what it says.
      if (Number.isFinite(v) && v >= min && v <= max) onchange(v);
      else el.value = String(value());
    },
  });
}

/**
 * A range to drag and the number box beside it, one value between them.
 *
 * The slider writes on every step, so the level answers while it moves, and
 * one drag is still one entry in the history: every step after the first says
 * it is `further`. `reach` is how far the box goes past the slider's `max`.
 */
function slider(
  value: Value<number>,
  min: number,
  max: number,
  onchange: (v: number, further: boolean) => void,
  reach = max,
  step = '1',
): VNode {
  let moving = false;

  return div({ style: { display: 'flex', alignItems: 'center', gap: '6px' } }, [
    input({
      type: 'range',
      min: String(min),
      max: String(max),
      step: step === 'any' ? String((max - min) / 100) : step,
      value: () => String(Math.min(max, value())),
      style: { flex: '1', minWidth: '0', margin: '0' },
      oninput: (e: Event) => {
        onchange((e.target as HTMLInputElement).valueAsNumber, moving);
        moving = true;
      },
      onchange: (e: Event) => {
        moving = false;
        (e.target as HTMLInputElement).blur();
      },
    }),
    div({ style: { width: '44px', flex: 'none' } }, [number(value, min, v => onchange(v, false), reach, step)]),
  ]);
}

function choice<T extends string>(all: readonly T[], value: Value<T>, onchange: (v: T) => void): VNode {
  return select({
    style: CONTROL,
    onchange: (e: Event) => {
      const el = e.target as HTMLSelectElement;

      el.blur();
      onchange(el.value as T);
    },
  }, all.map(v => option({ value: v, selected: () => v === value() }, [text(v)])));
}

function tick(value: Value<boolean>, onchange: (v: boolean) => void): VNode {
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
