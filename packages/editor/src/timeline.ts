// -----------------------------------------------------------------------------
// The keyframe view
//
// Along the whole bottom: keyframes across, things down. A thing's row holds a
// diamond for every entry written about it, side by side in its keyframe's
// column, and opens into one row per kind of operation and then its members.
// A column is wide enough for a handful of entries and widens for more; past
// the width of the page the view scrolls, its headings staying where they are.
//
// A repeat trails a bar out to where it stops, with a gap wherever it waits
// over a keyframe: clicking a step or a gap turns one into the other, and
// dragging the bar's end says how far it goes.
//
// Delete drops what is picked, ⌥Delete pushes it to the next keyframe, and
// dragging a diamond a keyframe along pushes or pulls it. See `keys.ts`.
//
// The row header's switches — hide, lock, solo — are flags on the thing, and
// in the file. See `Flags`.
//
// What is drawn is `rowsOf` and a handful of other plain numbers, rebuilt only
// when they change: an edit that moves a room further leaves the view alone.
// -----------------------------------------------------------------------------

import { Value } from '@incpt/kontinuum';
import { VNode, dynamic, effect, fragment, stateful, text } from '@incpt/kontinuum-dom';
import { div } from '@incpt/kontinuum-dom/html';
import { interaction } from '@incpt/kontinuum-interaction/dom';

import { Input } from './input';
import { Refused, deleted, dropped, inserted, pulled, pushed, skipToggled, timed } from './keys';
import { KeyframeId } from './rig';
import { order, rigOf, unchainedAt } from './scene';
import { theme } from './theme';
import { Bar, Cell, Row, entryLabel, rootsOf, rowsOf, timesTo } from './track';
import { EditorState, Flags, Id, Selection, Update, World, flagged, marked, saying, within } from './types';

const LABEL = 196;
const ROW = 22;
const HEAD = 46;
const FONT = '11px system-ui, sans-serif';

/** One entry's room in a column, and the room at its sides. */
const SLOT = 13;
const PAD = 10;

/** A column holds this many entries side by side before it widens. */
const ROOMY = 5;

/** What Delete and Escape mean while an entry is picked. */
const KEYS = ['Backspace', 'Delete', 'Escape'];

/** One entry, for one thing at one keyframe, by its place in the list. */
interface Picked {
  id: Id
  at: KeyframeId
  index: number
}

/** The view's own state: not the world's, not in the history, not saved. */
interface Local {
  all: boolean
  open: ReadonlySet<Id>
  picked: Picked | null
}

interface Model {
  keyframes: { id: KeyframeId, name: string, visible: boolean, unchains: boolean }[]
  /** Where each column starts, from the left of the view, and how wide it is. */
  xs: number[]
  widths: number[]
  current: number
  rows: Row[]
  picked: Picked | null
  all: boolean
}

export function timeline(
  state: Value<EditorState>,
  world: Value<World>,
  selection: Value<Selection>,
  keyframe: Value<KeyframeId>,
  input: Input,
  update: Update,
  go: (k: KeyframeId) => void,
): VNode {
  const initial: Local = { all: false, open: new Set(), picked: null };

  return stateful(initial, (local, setLocal) => {
    const change = (f: (l: Local) => Local) => setLocal(f(local()));
    const letGo = () => {
      if (local().picked !== null) change(l => ({ ...l, picked: null }));
    };

    // Acted on, a pick may name an entry that is not there any more, and a
    // stale index is a different entry.
    const acted = (out: World | Refused) => {
      letGo();

      update(s => ('refused' in out ? saying(s, out.refused) : marked({ ...s, world: out }, s.world)));
    };

    let last: { key: string, model: Model } | null = null;

    const model = (): Model => {
      const m = modelOf(world(), selection(), keyframe(), local());
      const key = JSON.stringify(m);

      if (last !== null && last.key === key) return last.model;

      last = { key, model: m };

      return m;
    };

    const ctx: Ctx = { state, update, go, local, change, acted, letGo, inner: null, model: null };

    let root: HTMLElement | null = null;

    const away = (e: PointerEvent) => {
      if (root !== null && !root.contains(e.target as Node)) letGo();
    };

    return div(
      {
        // A press anywhere else lets the pick go, so that Delete is the
        // canvas' again the moment the hand is back on it.
        ref: (el: HTMLElement) => {
          root = el;
          window.addEventListener('pointerdown', away, true);
        },
        onUnmount: () => window.removeEventListener('pointerdown', away, true),
        style: {
          pointerEvents: 'auto',
          alignSelf: 'stretch',
          maxHeight: '38vh',
          minHeight: `${HEAD + 2 * ROW}px`,
          overflow: 'auto',
          background: theme.panel,
          borderTop: `1px solid ${theme.border}`,
          boxShadow: `0 -6px 18px ${theme.panelShadow}`,
          font: FONT,
          color: theme.text,
          userSelect: 'none',
        },
      },
      [
        // Delete is the pick's for as long as there is one.
        effect(() => local().picked !== null, on => (on ? input.claim(...KEYS) : undefined)),
        keys(ctx, input),
        dynamic(model, m => body(ctx, m)),
      ],
    );
  });
}

/** What the handlers need: the store, the view's own state, and where the
 * columns are on the page now. */
interface Ctx {
  state: Value<EditorState>
  update: Update
  go: (k: KeyframeId) => void
  local: Value<Local>
  change: (f: (l: Local) => Local) => void
  acted: (out: World | Refused) => void
  letGo: () => void
  inner: HTMLElement | null
  model: Model | null
}

function keys(ctx: Ctx, input: Input): VNode {
  return interaction(function* () {
    while (true) {
      const e = yield* input.keyDown;
      const picked = ctx.local().picked;

      if (picked === null || !KEYS.includes(e.code) || ctx.state().roaming) continue;

      e.preventDefault();

      if (e.code === 'Escape') {
        ctx.letGo();
        continue;
      }

      const w = ctx.state().world;

      ctx.acted(e.altKey ? pushed(w, picked.id, picked.at, picked.index) : dropped(w, picked.id, picked.at, picked.index));
    }
  });
}

// -----------------------------------------------------------------------------
// The model
// -----------------------------------------------------------------------------

function modelOf(world: World, selection: Selection, k: KeyframeId, local: Local): Model {
  const rows = rowsOf(world, rootsOf(world, selection, local.all), local.open);
  const picked = valid(world, local.picked);

  // As wide as the fullest cell in it, and never narrower than a handful.
  const widths = world.keyframes.map((_f, col) =>
    Math.max(ROOMY, ...rows.map(r => r.cells[col].entries.length)) * SLOT + 2 * PAD);
  const xs: number[] = [];
  let x = LABEL;

  for (const w of widths) {
    xs.push(x);
    x += w;
  }

  return {
    keyframes: world.keyframes.map(f => ({
      id: f.id,
      name: f.name,
      visible: f.visible,
      unchains: unchains(world, f.id, selection),
    })),
    xs,
    widths,
    current: order(world, k),
    rows,
    picked,
    all: local.all,
  };
}

/** A pick that still names something. */
function valid(world: World, picked: Picked | null): Picked | null {
  if (picked === null) return null;

  return picked.index < (rigOf(world, picked.id).keys.get(picked.at) ?? []).length ? picked : null;
}

/**
 * Whether this keyframe unchains anything that is picked.
 *
 * About the selection rather than about the world, because a mark that meant
 * *somebody* is unchained here would be on nearly every column of a level that
 * uses this at all. Picked, it answers the question that was asked — where
 * does this stop hearing from upstream.
 */
function unchains(world: World, k: KeyframeId, selection: Selection): boolean {
  return [...selection.polygons, ...selection.artefacts, ...selection.paths].some(
    id => within(world, id).some(m => unchainedAt(world, k, m)),
  );
}

// -----------------------------------------------------------------------------
// Drawing
//
// A heading row stuck to the top and a label column stuck to the left, over
// everything else, which scrolls under them.
// -----------------------------------------------------------------------------

type Style = Record<string, string | number>;

function box(style: Style, children: VNode[] = [], attrs: Record<string, unknown> = {}): VNode {
  return div({ ...attrs, style: { position: 'absolute', boxSizing: 'border-box', ...style } }, children);
}

function label(s: string, style: Style = {}, attrs: Record<string, unknown> = {}): VNode {
  return box({ whiteSpace: 'nowrap', lineHeight: `${ROW}px`, ...style }, [text(s)], attrs);
}

/** The middle of a column. */
function centre(m: Model, col: number): number {
  return m.xs[col] + m.widths[col] / 2;
}

/** Where the `i`-th of `n` entries sits in a column. */
function slot(m: Model, col: number, i: number, n: number): number {
  return centre(m, col) + (i - (n - 1) / 2) * SLOT;
}

/** The column under a point on the page, clamped to the ones there are. */
function colAt(ctx: Ctx, clientX: number): number {
  const m = ctx.model!;
  const x = clientX - (ctx.inner?.getBoundingClientRect().left ?? 0);
  const col = m.xs.findIndex((at, i) => x < at + m.widths[i]);

  return col < 0 ? m.xs.length - 1 : Math.max(0, col);
}

function body(ctx: Ctx, m: Model): VNode {
  ctx.model = m;

  const n = m.keyframes.length;
  const width = m.xs[n - 1] + m.widths[n - 1] + 8;
  const height = HEAD + Math.max(1, m.rows.length) * ROW + 4;

  return div(
    {
      ref: (el: HTMLElement) => {
        ctx.inner = el;
      },
      style: { position: 'relative', width: `${width}px`, minWidth: '100%', height: `${height}px` },
    },
    [
      // The keyframe on screen, down the whole view.
      box({
        left: `${m.xs[m.current]}px`,
        top: '0',
        width: `${m.widths[m.current]}px`,
        height: `${height}px`,
        background: 'rgba(91, 140, 255, 0.12)',
      }),

      ...m.xs.map(x => box({ left: `${x}px`, top: '0', width: '1px', height: `${height}px`, background: theme.border, opacity: 0.5 })),

      head(ctx, m, width),

      ...(m.rows.length === 0
        ? [line([label('Pick something to see what happens to it, or show all.', { left: '10px', color: theme.muted })])]
        : m.rows.map(r => row(ctx, m, r))),
    ],
  );
}

/** One row of the view: in the flow, so that the label column can stick. */
function line(children: VNode[], style: Style = {}): VNode {
  return div({ style: { position: 'relative', height: `${ROW}px`, ...style } }, children);
}

/** Stuck to the left edge as the view scrolls under it. */
function pinned(children: VNode[], style: Style = {}): VNode {
  return div({
    style: {
      position: 'sticky',
      left: '0',
      width: `${LABEL}px`,
      height: '100%',
      background: theme.panel,
      zIndex: 2,
      ...style,
    },
  }, children);
}

function chip(s: string, left: number, onclick: () => void, on = false, title = ''): VNode {
  return label(s, {
    left: `${left}px`,
    top: '12px',
    height: `${ROW}px`,
    padding: '0 7px',
    borderRadius: '5px',
    cursor: 'pointer',
    background: on ? theme.accent : theme.border,
    color: on ? theme.onAccent : theme.text,
  }, { onclick, title });
}

/** The headings, stuck to the top: keyframes in and out and what the rows
 * are of over the labels, and each keyframe over its column. */
function head(ctx: Ctx, m: Model, width: number): VNode {
  return div({
    style: {
      position: 'sticky',
      top: '0',
      width: `${width}px`,
      height: `${HEAD}px`,
      background: theme.panel,
      borderBottom: `1px solid ${theme.border}`,
      zIndex: 3,
      boxSizing: 'border-box',
    },
  }, [
    ...m.keyframes.map((f, i) => column(ctx, m, f, i)),

    pinned([
      chip('+ insert', 8, () => ctx.update(insertedAfter), false, 'A keyframe after the one on screen, where nothing happens'),
      chip('− delete', 70, () => ctx.update(deletedHere), false, 'The keyframe on screen, its writing handed to the next'),
      chip(m.all ? 'all' : 'picked', 136, () => ctx.change(l => ({ ...l, all: !l.all })), m.all, 'Everything, or what is picked'),
    ]),
  ]);
}

/** A keyframe's heading: its name, which stands in it, and its eye. */
function column(ctx: Ctx, m: Model, f: Model['keyframes'][number], i: number): VNode {
  const x = m.xs[i], w = m.widths[i];
  const current = i === m.current;

  return fragment([
    box({ left: `${x}px`, top: '0', width: `${w}px`, height: '100%', background: current ? 'rgba(91, 140, 255, 0.16)' : 'transparent' }),

    label(f.name, {
      left: `${x}px`,
      top: '4px',
      width: `${w}px`,
      textAlign: 'center',
      cursor: 'pointer',
      color: current ? theme.accent : theme.text,
      fontWeight: current ? '600' : '400',
    }, { onclick: () => ctx.go(f.id) }),

    // Whether it draws as a ghost while another is on screen. Through the
    // history like every other write to the world: left out, an undo of the
    // edit before takes the toggle back with it.
    label(f.visible ? '◉' : '○', {
      left: `${x}px`,
      top: '22px',
      width: `${w}px`,
      textAlign: 'center',
      cursor: 'pointer',
      color: f.visible ? theme.muted : theme.faded,
    }, {
      title: 'Drawn as a ghost from other keyframes',
      onclick: () => ctx.update(s => {
        const keyframes = s.world.keyframes.map(g => (g.id === f.id ? { ...g, visible: !g.visible } : g));

        return marked({ ...s, world: { ...s.world, keyframes } }, s.world);
      }),
    }),

    // Where something picked stops hearing from upstream: a break in the
    // column's left edge.
    ...(f.unchains
      ? [box({ left: `${x - 1}px`, top: '6px', width: '3px', height: `${HEAD - 12}px`, background: theme.gone, borderRadius: '2px' }, [], { title: 'Unchained here' })]
      : []),
  ]);
}

function row(ctx: Ctx, m: Model, r: Row): VNode {
  const thing = r.kind === null;
  const indent = 8 + r.depth * 12;
  const toggle = () => ctx.change(l => {
    const open = new Set(l.open);

    if (open.has(r.id)) open.delete(r.id);
    else open.add(r.id);

    return { ...l, open };
  });

  return line([
    ...r.cells.map((c, col) => cell(ctx, m, r, col, c)),

    ...r.bars.map(b => bar(ctx, m, r, b)),

    ...(thing ? [] : handle(ctx, m, r)),

    pinned([
      ...(r.opens
        ? [label(r.open ? '▾' : '▸', { left: `${indent}px`, width: '12px', cursor: 'pointer', color: theme.muted }, { onclick: toggle })]
        : []),

      label(r.label, {
        left: `${indent + 14}px`,
        width: `${LABEL - indent - 14 - (thing ? 70 : 0)}px`,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        color: thing ? theme.text : theme.muted,
      }),

      ...(thing ? switches(ctx, r) : []),
    ]),
  ], { borderTop: `1px solid ${thing ? theme.border : 'rgba(61, 63, 71, 0.4)'}`, boxSizing: 'border-box' });
}

/** Hide, lock and solo, at the end of a thing's header. */
function switches(ctx: Ctx, r: Row): VNode[] {
  const flag = (f: keyof Flags, glyph: string, x: number, title: string) =>
    label(glyph, {
      left: `${LABEL - 70 + x}px`,
      top: '3px',
      width: '18px',
      height: `${ROW - 7}px`,
      lineHeight: `${ROW - 7}px`,
      textAlign: 'center',
      borderRadius: '4px',
      cursor: 'pointer',
      fontSize: '10px',
      background: r.flags[f] ? theme.accent : 'transparent',
      color: r.flags[f] ? theme.onAccent : theme.faded,
    }, {
      title,
      onclick: () => ctx.update(s => marked({ ...s, world: flagged(s.world, r.id, f, !r.flags[f]) }, s.world)),
    });

  return [
    flag('hidden', 'H', 0, 'Hidden: not drawn and not picked; still in the level'),
    flag('locked', 'L', 22, 'Locked: drawn, not picked'),
    flag('solo', 'S', 44, 'Solo: only what is soloed is drawn and picked'),
  ];
}

function isPicked(m: Model, r: Row, col: number, index: number): boolean {
  const p = m.picked;

  return p !== null && p.id === r.id && p.at === m.keyframes[col].id && p.index === index;
}

/** A keyframe's entries in one row, a diamond each, side by side in the
 * order they play. */
function cell(ctx: Ctx, m: Model, r: Row, col: number, c: Cell): VNode {
  const shade = c.alive
    ? []
    : [box({ left: `${m.xs[col]}px`, top: '0', width: `${m.widths[col]}px`, height: '100%', background: 'rgba(0, 0, 0, 0.28)' })];

  const at = m.keyframes[col].id;
  const n = c.entries.length;

  return fragment([
    ...shade,

    ...c.entries.map((index, i) => {
      const picked = isPicked(m, r, col, index);
      const kind = c.kinds[i];
      const colour = picked ? theme.accent : kind === 'stand' ? theme.gone : r.kind === null ? theme.muted : theme.text;

      const click = () => {
        ctx.go(at);
        ctx.change(l => ({ ...l, picked: { id: r.id, at, index } }));
      };

      // Dropped a keyframe along: pushed to the next, or pulled back into the
      // one before, which is a pull from where it is seen from there.
      const moved = (clientX: number) => {
        const w = ctx.state().world;
        const to = colAt(ctx, clientX);

        if (to > col) {
          ctx.acted(pushed(w, r.id, at, index));
        }
        else if (to < col) {
          const before = w.keyframes[col - 1]?.id;

          ctx.acted(before === undefined ? { refused: 'nothing before the first keyframe to pull into' } : pulled(w, r.id, before, index));
        }
      };

      return box({
        left: `${slot(m, col, i, n) - 4}px`,
        top: `${ROW / 2 - 4}px`,
        width: '8px',
        height: '8px',
        transform: 'rotate(45deg)',
        background: colour,
        cursor: 'grab',
        zIndex: 1,
      }, [], {
        onpointerenter: (e: PointerEvent) => {
          (e.currentTarget as HTMLElement).title = entryTitle(ctx, r.id, at, index);
        },
        onpointerdown: (e: PointerEvent) => dragged(e, click, moved),
      });
    }),
  ]);
}

/** What an entry does, read when the pointer is over it rather than kept in
 * the model, where its numbers would rebuild the view on every drag. */
function entryTitle(ctx: Ctx, id: Id, at: KeyframeId, index: number): string {
  const e = rigOf(ctx.state().world, id).keys.get(at)?.[index];

  return e === undefined ? '' : entryLabel(e);
}

/**
 * A press that is either a click or a drag along the columns: `click` if it
 * never went anywhere, and `done` with where it was let go otherwise. The
 * element follows the pointer meanwhile, and nothing is written until then.
 */
function dragged(e: PointerEvent, click: () => void, done: (clientX: number) => void): void {
  if (e.button !== 0) return;

  e.preventDefault();
  e.stopPropagation();

  const el = e.currentTarget as HTMLElement;
  const x0 = e.clientX;
  const was = el.style.transform;
  let moving = false;

  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - x0;

    if (Math.abs(dx) > 3) moving = true;
    if (moving) el.style.transform = `translateX(${dx}px) ${was}`;
  };

  const up = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    el.style.transform = was;

    if (moving) done(ev.clientX);
    else click();
  };

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

/** A repeat's bar: a line from its diamond out to its last step, a dot at each
 * step and a ring at each keyframe it waits over — either clicked turns into
 * the other. */
function bar(ctx: Ctx, m: Model, r: Row, b: Bar): VNode {
  const at = m.keyframes[b.from].id;
  const mid = ROW / 2;
  const cell = r.cells[b.from];
  const out: VNode[] = [];
  let prev = slot(m, b.from, cell.entries.indexOf(b.index), cell.entries.length);

  for (const s of b.steps) {
    const x0 = prev + 6, x1 = centre(m, s.col) - 5;

    out.push(box({
      left: `${x0}px`,
      top: `${mid - 1}px`,
      width: `${Math.max(0, x1 - x0)}px`,
      height: '0',
      borderTop: s.skip ? `1px dashed ${theme.faded}` : `2px solid ${theme.muted}`,
      pointerEvents: 'none',
    }));

    const size = s.skip ? 8 : 6;

    out.push(box({
      left: `${centre(m, s.col) - size / 2}px`,
      top: `${mid - size / 2}px`,
      width: `${size}px`,
      height: `${size}px`,
      borderRadius: '50%',
      background: s.skip ? theme.panel : theme.muted,
      border: s.skip ? `1px solid ${theme.faded}` : 'none',
      cursor: 'pointer',
      zIndex: 1,
    }, [], {
      title: s.skip ? 'Waits here: click to step' : 'Steps here: click to wait',
      onclick: () => ctx.acted(skipToggled(ctx.state().world, r.id, at, b.index, m.keyframes[s.col].id)),
    }));

    prev = centre(m, s.col);
  }

  const tail = b.steps.length === 0 ? prev : centre(m, b.end);

  if (b.forever) out.push(label('→', { left: `${tail + 12}px`, color: theme.muted, pointerEvents: 'none' }));

  if (b.heading !== null) {
    out.push(label(b.heading, {
      left: `${tail + (b.forever ? 24 : 12)}px`,
      fontSize: '9px',
      color: theme.faded,
      pointerEvents: 'none',
    }));
  }

  out.push(end(ctx, r.id, at, b.index, b.from, tail));

  return fragment(out);
}

/** The picked entry's handle, where it does not repeat yet: drag it out to
 * make it one. Not on a stand, which does not repeat. */
function handle(ctx: Ctx, m: Model, r: Row): VNode[] {
  const p = m.picked;

  if (p === null || p.id !== r.id || r.kind === 'stand') return [];

  const col = m.keyframes.findIndex(f => f.id === p.at);
  const c = r.cells[col];
  const i = c?.entries.indexOf(p.index) ?? -1;

  if (i < 0 || r.bars.some(b => b.from === col && b.index === p.index)) return [];

  return [end(ctx, r.id, p.at, p.index, col, slot(m, col, i, c.entries.length))];
}

/** Where a repeat stops, dragged along the columns: to its own column is
 * once, and to the last is to the end. */
function end(ctx: Ctx, id: Id, at: KeyframeId, index: number, from: number, x: number): VNode {
  const done = (clientX: number) => {
    const w = ctx.state().world;
    const e = rigOf(w, id).keys.get(at)?.[index];

    if (e === undefined) return;

    ctx.acted(timed(w, id, at, index, timesTo(w, e, from, colAt(ctx, clientX))));
  };

  return box({
    left: `${x + 7}px`,
    top: `${ROW / 2 - 6}px`,
    width: '4px',
    height: '12px',
    borderRadius: '2px',
    background: theme.faded,
    cursor: 'ew-resize',
    zIndex: 1,
  }, [], { title: 'Drag to repeat', onpointerdown: (e: PointerEvent) => dragged(e, () => {}, done) });
}

// -----------------------------------------------------------------------------
// Keyframes in and out
// -----------------------------------------------------------------------------

/**
 * A keyframe put in after the one on screen, and stood in: one where nothing
 * happens yet. See `inserted` in `keys.ts`.
 */
function insertedAfter(s: EditorState): EditorState {
  const out = inserted(s.world, s.keyframe);

  if (out === null) return s;

  return marked({ ...s, world: out.world, keyframe: out.key, replay: null }, s.world);
}

/** The keyframe on screen taken out, standing in the one after it — or before
 * it, for the last. See `deleted` in `keys.ts`. */
function deletedHere(s: EditorState): EditorState {
  const out = deleted(s.world, s.keyframe);

  if ('refused' in out) return saying(s, out.refused);

  const i = order(s.world, s.keyframe);
  const to = s.world.keyframes[i + 1] ?? s.world.keyframes[i - 1];

  return marked({ ...s, world: out, keyframe: to.id, replay: null }, s.world);
}
