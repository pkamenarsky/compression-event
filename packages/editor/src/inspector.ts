// -----------------------------------------------------------------------------
// The inspector
//
// On the left, under the tools, while something is picked: what the picked
// polygons are, which of the three effects apply to the picked things, and
// each one's options.
//
// What a polygon is comes first, under the transform tool and nowhere else,
// as the part it plays in each set: see `PolygonKind`. The digits already
// retype — this is the answer to the question they leave unasked, what is it
// now. A level with a hundred shapes in it says which kind each one is by
// texture alone, and a texture read through a selection fill is not something
// to be sure about. The effects follow. A box ticked is
// an effect switched on, one fact over every keyframe; how much is in its
// timeline, written by `d`, `e` and `b` on the canvas. Unticking switches it
// off and takes nothing away: its options and amounts apply again when it is
// ticked. Erosion has no options, so its box is only the switch.
//
// With corners or edges picked, the pane is about the polygons they are on:
// an effect is one amount over its whole ring, and one set of options. An
// option changed is changed on every picked thing that has the effect, and is
// what the next thing given it starts with.
// -----------------------------------------------------------------------------

import { ObjectValue, Value } from '@incpt/kontinuum';
import { VNode, fragment, object, show, text } from '@incpt/kontinuum-dom';
import { div, input, label, option, select, span } from '@incpt/kontinuum-dom/html';

import {
  EffectName,
  Switch,
  applies,
  switchedOff,
  sizeOf,
  sizedFor,
  switchedOn,
  withEffect,
} from './effects';
import { FALLOFF, Pattern, Sides } from './geometry';
import { Place, entryAt, lastKeys, retypedAt, timedAt } from './keys';
import { Delta, NOTHING, Typed } from './rig';
import { kindsOf, owning, repartedPolygons, retypable } from './scene';
import { theme } from './theme';
import {
  FloorPart,
  Id,
  KeyframeId,
  LevelPart,
  Options,
  PolygonId,
  PolygonKind,
  Selection,
  SetName,
  Target,
  Tool,
  Update,
  World,
  marked,
  picks,
  saying,
} from './types';

type Some = 'all' | 'some' | 'none';

/**
 * What the pane says, flat and in plain values, so that `object` wakes each
 * control for its own field alone: the pane is made once, and a change moves
 * what it shows rather than making it again — a field being typed into keeps
 * its focus and a select stays open.
 */
interface Model {
  /** Whether there is a key to show: see `currentKey`. */
  key: boolean
  /** What it does to the thing as a whole, in the units it is typed in:
   * degrees for the turn and the skew. Identity where it holds only corners. */
  moveX: number
  moveY: number
  angle: number
  skew: number
  scaleX: number
  scaleY: number
  erodes: number
  rounds: number
  deforms: number
  /** How many keyframes it plays at, `∞` to the end. */
  times: string
  /** Whether it moves single corners as well, or instead. */
  cornered: boolean
  /** Whether it is an unchaining, a state rather than a change, which is not
   * typed into. */
  stand: boolean
  /** Whether there are polygons to say the kind of. */
  kinds: boolean
  /** How many of them play each part, one field per box. */
  hollow: Some
  solid: Some
  voidLevel: Some
  floor: Some
  voidFloor: Some
  /** Whether every one of them is in the other set, so that taking this one's
   * part away leaves each still something. */
  bareLevel: boolean
  bareFloor: boolean
  deform: Some
  spacing: number
  /** How big the first of them is at its own scale, which the spacing is
   * shown as a share of: see `sizeOf`. */
  size: number
  pattern: Pattern
  sides: Sides
  seed: number
  jitter: number
  falloff: number
  erode: Some
  round: Some
  precision: number
  tension: number
  chamfer: boolean
}

const PATTERNS: Pattern[] = ['zigzag', 'sine', 'noise'];
const SIDES: Sides[] = ['both', 'out', 'in'];

/** The most jitter, in percent: see `Effecting.jitter`. */
const JITTER = 200;

/** The finest precision a round is asked for: past it, `FINEST` segments
 * cap it anyway. */
const PRECISEST = 0.01;

/** Where the sliders stop. The box beside each takes more, up to whatever the
 * field itself allows: these are the ranges worth reaching by hand. */
const SPACING = 100;
const SEEDS = 100;
const COARSEST = 2;

/** What the pane is about: the things picked, and only under the polygon
 * tool — a corner or an edge has no effects of its own. */
export function effectTargets(world: World, selection: Selection, tool: Tool): Id[] {
  if (tool !== 'polygon') return [];

  return selection.polygons.filter(id => world.polygons.has(id) || world.groups.has(id));
}

/**
 * Where the key the inspector shows is: the one the hand is on, wherever it
 * is, or else the last the first picked thing has at this keyframe — the one
 * the next gesture folds into. Nothing where neither has one, which is also
 * what a key taken out comes to.
 */
function currentPlace(world: World, target: Target | null, k: KeyframeId, ids: readonly Id[]): Place | undefined {
  const p = target?.lead ?? lastKeys(world, k, ids)[0];

  return p === undefined || entryAt(world, p) === undefined ? undefined : p;
}

export function inspector(
  world: Value<World>,
  selection: Value<Selection>,
  tool: Value<Tool>,
  remembered: Value<Options>,
  keyframe: Value<KeyframeId>,
  target: Value<Target | null>,
  top: number,
  update: Update,
): VNode {
  const targets = () => (picks(tool()) ? effectTargets(world(), selection(), tool()) : []);

  // What a retype would land on, which is also what the kind reports: a
  // sealed group is a scope stating its own rule and the descent stops at it.
  // See `retypable`.
  const reached = () => (tool() === 'polygon' ? retypable(world(), selection().polygons) : []);

  const model = (): Model => modelOf(
    world(),
    keyframe(),
    targets(),
    reached(),
    remembered(),
    currentPlace(world(), target(), keyframe(), targets()),
  );

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
      [object(model, m => body(m, targets, reached, () => currentPlace(world(), target(), keyframe(), targets()), update))],
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

function modelOf(
  world: World,
  v: KeyframeId,
  ids: readonly Id[],
  reached: readonly PolygonId[],
  remembered: Options,
  place: Place | undefined,
): Model {
  const kinds = kindsOf(world, reached);
  const key = place === undefined ? undefined : entryAt(world, place);
  const by = key?.by;
  const degrees = (r: number) => Math.round(r * 180 / Math.PI * 100) / 100;
  const fine = (n: number) => Math.round(n * 1000) / 1000;

  // The first picked thing's that has one, switched on or not, and otherwise
  // what is remembered.
  const shown = <N extends EffectName>(name: N): Options[N] => {
    const id = ids.find(i => world.effects.get(i)?.[name] !== undefined);

    return id === undefined ? remembered[name] : world.effects.get(id)![name]! as Options[N];
  };

  const d = shown('deform');
  const r = shown('round');

  return {
    key: key !== undefined,
    moveX: fine(by?.move.x ?? 0),
    moveY: fine(by?.move.y ?? 0),
    angle: degrees(by?.angle ?? 0),
    skew: degrees(by?.skew ?? 0),
    scaleX: fine(by?.scale.x ?? 1),
    scaleY: fine(by?.scale.y ?? 1),
    erodes: fine(by?.erode ?? 0),
    rounds: fine(by?.round ?? 0),
    deforms: fine(by?.deform ?? 0),
    times: key === undefined || key.times === null ? '' : String(key.times),
    stand: key?.stand !== undefined,
    cornered: key?.corners !== undefined && key.corners.size > 0,
    kinds: kinds.length > 0,
    hollow: some(kinds, k => k.level === 'hollow'),
    solid: some(kinds, k => k.level === 'solid'),
    voidLevel: some(kinds, k => k.level === 'void'),
    floor: some(kinds, k => k.floor === 'floor'),
    voidFloor: some(kinds, k => k.floor === 'void'),
    bareLevel: kinds.every(k => k.floor !== undefined),
    bareFloor: kinds.every(k => k.level !== undefined),
    deform: some(ids, id => applies(world, id, 'deform')),
    spacing: d.spacing,
    size: ids.length === 0 ? 0 : sizeOf(world, v, ids[0]),
    pattern: d.pattern,
    sides: d.sides,
    seed: d.seed,
    jitter: d.jitter,
    falloff: d.falloff ?? FALLOFF,
    erode: some(ids, id => applies(world, id, 'erode')),
    round: some(ids, id => applies(world, id, 'round')),
    precision: r.precision,
    tension: r.tension,
    chamfer: r.chamfer,
  };
}

function body(
  m: ObjectValue<Model>,
  targets: () => Id[],
  reached: () => PolygonId[],
  place: () => Place | undefined,
  update: Update,
): VNode {
  /** Numbers typed into the key the inspector shows. Given what the key holds
   * now, so that one half of a point typed in keeps the other half exactly
   * rather than as the box rounds it. */
  const typedIn = (typed: (by: Delta) => Typed) => update(s => {
    const p = place();

    if (p === undefined) return s;

    const world = retypedAt(s.world, p, typed(entryAt(s.world, p)?.by ?? NOTHING));

    return 'refused' in world ? saying(s, world.refused) : marked({ ...s, world }, s.world);
  });

  /** How many keyframes it plays at, blank or `∞` for to the end. */
  const timesIn = (typed: string) => update(s => {
    const p = place();

    if (p === undefined) return s;

    const t = typed.trim();
    const world = timedAt(s.world, p, t === '' || t === '∞' ? null : Number(t));

    return 'refused' in world ? saying(s, world.refused) : marked({ ...s, world }, s.world);
  });

  const radians = (deg: number) => deg * Math.PI / 180;
  const fixed = () => m.stand();

  /** One set's part given to every polygon the kind is about, or taken off
   * where every one of them already plays it. */
  const reparted = (set: SetName, part: LevelPart | FloorPart, on: Value<Some>) => update(s => marked(
    { ...s, world: repartedPolygons(s.world, reached(), set, on() === 'all' ? null : part) },
    s.world,
  ));

  /** Switched on for every one of them, or off where every one had it on. */
  const toggled = (name: Switch, on: Some) => update(s => {
    const ids = targets();
    const first = name === 'deform' ? sizedFor(s.world, s.keyframe, ids, s.remembered) : s.remembered;
    const world = on === 'all' ? switchedOff(s.world, ids, name) : switchedOn(s.world, ids, name, first);

    return marked({ ...s, world }, s.world);
  });

  /** One option changed on every one that has the effect, on or off, and
   * remembered. `further` is a slider
   * still moving: the step before it already went into the history, so this
   * one only carries it on. */
  const changed = <N extends EffectName>(name: N, patch: Partial<Options[N]>, further = false) => update(s => {
    let world = s.world;

    for (const id of targets()) {
      const was = world.effects.get(id)?.[name];

      if (was !== undefined) world = withEffect(world, id, name, { ...was, ...patch } as Options[N]);
    }

    const shown = name === 'round'
      ? { precision: m.precision(), tension: m.tension(), chamfer: m.chamfer() }
      : { spacing: m.spacing(), pattern: m.pattern(), sides: m.sides(), seed: m.seed(), jitter: m.jitter(), falloff: m.falloff() };
    const remembered = { ...s.remembered, [name]: { ...shown, ...patch } };

    return further ? { ...s, world, remembered } : marked({ ...s, world, remembered }, s.world);
  });


  return div({ style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, [
    show(() => m.kinds(), fragment([
      div({ style: { color: theme.muted } }, [text('Kind')]),
      div({
        style: {
          display: 'grid',
          gridTemplateColumns: 'auto minmax(0, 1fr)',
          alignItems: 'center',
          gap: '4px 8px',
          paddingLeft: '22px',
          paddingBottom: '4px',
          borderBottom: `1px solid ${theme.border}`,
        },
      }, [
        ...field('level', row([
          part('hollow', m.hollow, m.bareLevel, () => reparted('level', 'hollow', m.hollow)),
          part('solid', m.solid, m.bareLevel, () => reparted('level', 'solid', m.solid)),
          part('void', m.voidLevel, m.bareLevel, () => reparted('level', 'void', m.voidLevel)),
        ])),
        ...field('floor', row([
          part('floor', m.floor, m.bareFloor, () => reparted('floor', 'floor', m.floor)),
          part('void', m.voidFloor, m.bareFloor, () => reparted('floor', 'void', m.voidFloor)),
        ])),
      ]),
    ])),

    show(() => m.key(), fragment([
      div({ style: { color: theme.muted } }, [text('Key')]),
      div({
        style: {
          display: 'grid',
          gridTemplateColumns: 'auto minmax(0, 1fr)',
          alignItems: 'center',
          gap: '2px 8px',
          paddingLeft: '22px',
          paddingBottom: '4px',
          borderBottom: `1px solid ${theme.border}`,
          fontVariantNumeric: 'tabular-nums',
        },
      }, [
        ...field('move', pair(
          number(m.moveX, -Infinity, v => typedIn(by => ({ move: { x: v, y: by.move.y } })), Infinity, 'any', fixed),
          number(m.moveY, -Infinity, v => typedIn(by => ({ move: { x: by.move.x, y: v } })), Infinity, 'any', fixed),
        )),
        ...field('turn °', number(m.angle, -Infinity, v => typedIn(() => ({ angle: radians(v) })), Infinity, 'any', fixed)),
        ...field('skew °', number(m.skew, -89, v => typedIn(() => ({ skew: radians(v) })), 89, 'any', fixed)),
        // Nought would fold the thing flat, and a flat thing has no way back.
        ...field('scale', pair(
          number(m.scaleX, SMALLEST, v => typedIn(by => ({ scale: { x: v, y: by.scale.y } })), Infinity, 'any', fixed),
          number(m.scaleY, SMALLEST, v => typedIn(by => ({ scale: { x: by.scale.x, y: v } })), Infinity, 'any', fixed),
        )),
        ...field('erode', number(m.erodes, -Infinity, v => typedIn(() => ({ erode: v })), Infinity, 'any', fixed)),
        ...field('round', number(m.rounds, -Infinity, v => typedIn(() => ({ round: v })), Infinity, 'any', fixed)),
        ...field('deform', number(m.deforms, -Infinity, v => typedIn(() => ({ deform: v })), Infinity, 'any', fixed)),
        ...field('plays', times(m.times, timesIn, fixed)),
        ...field('', span({ style: { color: theme.faded } }, [text(() => (m.cornered() ? 'and single corners' : ''))])),
      ]),
    ])),

    heading(() => 'Deform', 'd', m.deform, () => toggled('deform', m.deform())),
    options(m.deform, [
      // A length, shown as a percentage of the thing's size so that the
      // slider has somewhere to stop: see `sizeOf`. Along the slider by its
      // logarithm, since going from 1% to 2% halves the teeth and going from
      // 90% to 100% hardly shows.
      field('spacing %', slider(
        () => (m.size() > 0 ? Math.round(m.spacing() / m.size() * 1000) / 10 : m.spacing()),
        1,
        SPACING,
        (v, further) => changed('deform', { spacing: m.size() > 0 ? v / 100 * m.size() : v }, further),
        Infinity,
        'any',
        true,
      )),
      field('pattern', choice(PATTERNS, m.pattern, v => changed('deform', { pattern: v }))),
      field('sides', choice(SIDES, m.sides, v => changed('deform', { sides: v }))),
      // How far the gaps stray from the spacing, as a percentage.
      field('jitter %', slider(() => Math.round(m.jitter() * 100), 0, JITTER, (v, further) => changed('deform', { jitter: Math.round(v) / 100 }, further))),
      // How far a tooth on an arc runs its flanks along the curve, as a
      // percentage of the spacing: a spike on the curve when small, a zigzag
      // along it at a hundred.
      field('falloff %', slider(() => Math.round(m.falloff() * 100), 0, 100, (v, further) => changed('deform', { falloff: Math.round(v) / 100 }, further))),
      // A seed is the noise's, the jitter's, and where each edge's teeth
      // start.
      field('seed', slider(m.seed, 0, SEEDS, (v, further) => changed('deform', { seed: Math.round(v) }, further), Infinity)),
    ]),

    heading(() => 'Erode', 'e', m.erode, () => toggled('erode', m.erode())),

    heading(() => 'Round', 'b', m.round, () => toggled('round', m.round())),
    options(m.round, [
      // How near its facets keep to its curve, as a length: finer is more of
      // them, as many as each corner's bevel needs, closest where it bends.
      show(() => !m.chamfer(), fragment(field('precision', slider(m.precision, PRECISEST, COARSEST, (v, further) => changed('round', { precision: v }, further), Infinity, 'any')))),
      // From about a circle at nought to tight in the corner at one.
      show(() => !m.chamfer(), fragment(field('tension', slider(m.tension, 0, 1, (v, further) => changed('round', { tension: v }, further), 1, '0.05')))),
      field('chamfer', tick(m.chamfer, v => changed('round', { chamfer: v }))),
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

/** The smallest stretch that can be typed into a key. */
const SMALLEST = 0.001;

/** Two boxes side by side, for the two halves of a point or a stretch. */
function pair(x: VNode, y: VNode): VNode {
  return div({ style: { display: 'flex', gap: '4px' } }, [x, y]);
}

/** How many keyframes a key plays at: a count, or blank for to the end. */
function times(value: Value<string>, onchange: (v: string) => void, disabled: Value<boolean>): VNode {
  return input({
    type: 'text',
    value,
    placeholder: '∞',
    disabled,
    style: CONTROL,
    onchange: (e: Event) => {
      const el = e.target as HTMLInputElement;

      el.blur();
      onchange(el.value);
      // Back to what the key says, whatever was taken.
      el.value = value();
    },
  });
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

function number(
  value: Value<number>,
  min: number,
  onchange: (v: number) => void,
  max = Infinity,
  step?: string,
  disabled: Value<boolean> = () => false,
): VNode {
  return input({
    type: 'number',
    value: () => String(value()),
    disabled,
    ...(min === -Infinity ? {} : { min: String(min) }),
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
 *
 * With `log`, the slider runs along the value's logarithm, so an equal drag is
 * an equal ratio. The box still says the value itself.
 */
/** How many steps a logarithmic slider has from end to end. */
const LOG_STEPS = 1000;

function slider(
  value: Value<number>,
  min: number,
  max: number,
  onchange: (v: number, further: boolean) => void,
  reach = max,
  step = '1',
  log = false,
): VNode {
  let moving = false;

  // Where along the slider a value is, and back, in `LOG_STEPS` steps.
  const at = (v: number) => (log ? Math.log(v / min) / Math.log(max / min) * LOG_STEPS : v);
  const of = (x: number) => (log ? min * (max / min) ** (x / LOG_STEPS) : x);

  return div({ style: { display: 'flex', alignItems: 'center', gap: '6px' } }, [
    input({
      type: 'range',
      min: String(log ? 0 : min),
      max: String(log ? LOG_STEPS : max),
      step: log ? '1' : step === 'any' ? String((max - min) / 100) : step,
      value: () => String(at(Math.max(min, Math.min(max, value())))),
      style: { flex: '1', minWidth: '0', margin: '0' },
      oninput: (e: Event) => {
        onchange(of((e.target as HTMLInputElement).valueAsNumber), moving);
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

/** One set's boxes, side by side. */
function row(parts: VNode[]): VNode {
  return div({ style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, parts);
}

/**
 * One part's box. The boxes of a set are exclusive: ticking one is that part
 * and none of the others, and unticking the one ticked is no part in the set.
 *
 * Half-ticked where only some of the polygons play it. Unticking is there only
 * where every one of them plays a part in the other set, because a polygon in
 * neither is not a kind.
 */
function part(name: string, on: Value<Some>, bare: Value<boolean>, onchange: () => void): VNode {
  return label({ style: { display: 'flex', alignItems: 'center', gap: '3px', cursor: 'pointer' } }, [
    input({
      type: 'checkbox',
      checked: () => on() === 'all',
      disabled: () => on() === 'all' && !bare(),
      // A property kontinuum sets as one, missing from its attribute types.
      ...({ indeterminate: () => on() === 'some' } as object),
      style: { margin: '0' },
      onchange: (e: Event) => {
        const el = e.target as HTMLInputElement;

        el.blur();
        // Put back to what the model says: the update decides, not the click.
        el.checked = on() === 'all';
        onchange();
      },
    }),
    span({}, [text(name)]),
  ]);
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

