// -----------------------------------------------------------------------------
// The keyframe view
//
// Along the bottom: keyframes across, things down. A thing's row holds a
// diamond wherever something is written about it, and opens into one row per
// kind of operation and then its members. A cell of one entry is a diamond; of
// several, a stack with a count, opened to pick one. A repeat trails a bar out
// to where it stops, with a gap wherever it waits over a keyframe: clicking a
// step or a gap turns one into the other, and dragging the bar's end says how
// far it goes.
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
import { Refused, Which, deleted, dropped, inserted, pulled, pushed, skipToggled, timed } from './keys';
import { KeyframeId } from './rig';
import { order, rigOf, unchainedAt } from './scene';
import { theme } from './theme';
import { Bar, Cell, Kind, Row, barOf, entryLabel, rootsOf, rowsOf, timesTo } from './track';
import { EditorState, Flags, Id, Selection, Update, World, flagged, marked, saying, within } from './types';

const LABEL = 196;
const COL = 40;
const ROW = 22;
const HEAD = 46;
const FONT = '11px system-ui, sans-serif';

/** What Delete and Escape mean while an entry is picked. */
const KEYS = ['Backspace', 'Delete', 'Escape'];

/** What is picked: one entry by its place, every one of a kind, or the whole
 * keyframe's list, for one thing at one keyframe. */
interface Picked {
  id: Id
  at: KeyframeId
  which: Which
}

/** The stack opened to pick from. */
interface Stack {
  id: Id
  kind: Kind
  at: KeyframeId
}

/** The view's own state: not the world's, not in the history, not saved. */
interface Local {
  all: boolean
  open: ReadonlySet<Id>
  picked: Picked | null
  stack: Stack | null
}

interface Model {
  keyframes: { id: KeyframeId, name: string, visible: boolean, unchains: boolean }[]
  current: number
  rows: Row[]
  picked: Picked | null
  stack: { row: number, col: number, items: { index: number, label: string }[] } | null
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
  const initial: Local = { all: false, open: new Set(), picked: null, stack: null };

  return stateful(initial, (local, setLocal) => {
    const change = (f: (l: Local) => Local) => setLocal(f(local()));
    const letGo = () => {
      if (local().picked !== null || local().stack !== null) change(l => ({ ...l, picked: null, stack: null }));
    };

    // The world changed under a pick, or it was acted on: either way it may
    // name an entry that is not there any more, and a stale index is a
    // different entry.
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

    const ctx: Ctx = { state, update, go, local, change, acted, letGo };

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
          maxWidth: '100%',
          maxHeight: '38vh',
          overflow: 'auto',
          background: theme.panel,
          border: `1px solid ${theme.border}`,
          borderRadius: '8px',
          boxShadow: `0 6px 18px ${theme.panelShadow}`,
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

/** What the handlers need: the store, and the view's own state. */
interface Ctx {
  state: Value<EditorState>
  update: Update
  go: (k: KeyframeId) => void
  local: Value<Local>
  change: (f: (l: Local) => Local) => void
  acted: (out: World | Refused) => void
  letGo: () => void
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

      ctx.acted(e.altKey ? pushed(w, picked.id, picked.at, picked.which) : dropped(w, picked.id, picked.at, picked.which));
    }
  });
}

// -----------------------------------------------------------------------------
// The model
// -----------------------------------------------------------------------------

function modelOf(world: World, selection: Selection, k: KeyframeId, local: Local): Model {
  const rows = rowsOf(world, rootsOf(world, selection, local.all), local.open);
  const picked = valid(world, local.picked);

  // A picked entry out of a stack draws its bar, which a stack does not.
  if (picked !== null && typeof picked.which === 'number') {
    const e = rigOf(world, picked.id).keys.get(picked.at)?.[picked.which];
    const col = order(world, picked.at);
    const row = rows.find(r => r.id === picked.id && r.kind === e?.op.kind);

    if (e !== undefined && row !== undefined && row.cells[col].entries.length > 1) {
      const bar = barOf(world, e, col, picked.which);

      if (bar !== null) row.bars = [...row.bars, bar];
    }
  }

  let stack: Model['stack'] = null;
  const s = local.stack;

  if (s !== null) {
    const row = rows.findIndex(r => r.id === s.id && r.kind === s.kind);
    const list = rigOf(world, s.id).keys.get(s.at) ?? [];
    const items = list.flatMap((e, index) => (e.op.kind === s.kind ? [{ index, label: entryLabel(e) }] : []));

    if (row >= 0 && items.length > 1) stack = { row, col: order(world, s.at), items };
  }

  return {
    keyframes: world.keyframes.map(f => ({
      id: f.id,
      name: f.name,
      visible: f.visible,
      unchains: unchains(world, f.id, selection),
    })),
    current: order(world, k),
    rows,
    picked,
    stack,
    all: local.all,
  };
}

/** A pick that still names something. */
function valid(world: World, picked: Picked | null): Picked | null {
  if (picked === null) return null;

  const list = rigOf(world, picked.id).keys.get(picked.at) ?? [];
  const which = picked.which;
  const there = typeof which === 'number' ? which < list.length : which === 'all' ? list.length > 0 : list.some(e => e.op.kind === which);

  return there ? picked : null;
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
// -----------------------------------------------------------------------------

type Style = Record<string, string | number>;

function box(style: Style, children: VNode[] = [], attrs: Record<string, unknown> = {}): VNode {
  return div({ ...attrs, style: { position: 'absolute', boxSizing: 'border-box', ...style } }, children);
}

function label(s: string, style: Style = {}, attrs: Record<string, unknown> = {}): VNode {
  return box({ whiteSpace: 'nowrap', lineHeight: `${ROW}px`, ...style }, [text(s)], attrs);
}

const centre = (col: number) => LABEL + col * COL + COL / 2;
const rowTop = (row: number) => HEAD + row * ROW;

function body(ctx: Ctx, m: Model): VNode {
  const n = m.keyframes.length;
  const width = LABEL + n * COL + 8;
  const height = HEAD + Math.max(1, m.rows.length) * ROW + 4;

  return div({ style: { position: 'relative', width: `${width}px`, height: `${height}px` } }, [
    // The keyframe on screen, down the whole view.
    box({
      left: `${LABEL + m.current * COL}px`,
      top: '0',
      width: `${COL}px`,
      height: `${height}px`,
      background: 'rgba(91, 140, 255, 0.12)',
    }),

    head(ctx, m),

    ...m.keyframes.map((f, i) => column(ctx, f, i, i === m.current)),

    ...(m.rows.length === 0
      ? [label('Pick something to see what happens to it, or show all.', { left: '10px', top: `${HEAD}px`, color: theme.muted })]
      : m.rows.map((r, i) => row(ctx, m, r, i))),

    ...(m.stack === null ? [] : [stacked(ctx, m)]),
  ]);
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

/** Over the row headers: keyframes in and out, and what the rows are of. */
function head(ctx: Ctx, m: Model): VNode {
  return fragment([
    chip('+ insert', 8, () => ctx.update(insertedAfter), false, 'A keyframe after the one on screen, where nothing happens'),
    chip('− delete', 70, () => ctx.update(deletedHere), false, 'The keyframe on screen, its writing handed to the next'),
    chip(m.all ? 'all' : 'picked', 136, () => ctx.change(l => ({ ...l, all: !l.all })), m.all, 'Everything, or what is picked'),
  ]);
}

/** A keyframe's heading: its name, which stands in it, and its eye. */
function column(ctx: Ctx, f: Model['keyframes'][number], i: number, current: boolean): VNode {
  const x = LABEL + i * COL;

  return fragment([
    label(f.name, {
      left: `${x}px`,
      top: '4px',
      width: `${COL}px`,
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
      width: `${COL}px`,
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

    box({ left: `${x}px`, top: `${HEAD - 1}px`, width: '1px', height: '100%', background: theme.border, opacity: 0.5 }),
  ]);
}

function row(ctx: Ctx, m: Model, r: Row, i: number): VNode {
  const y = rowTop(i);
  const thing = r.kind === null;
  const indent = 8 + r.depth * 12;

  return fragment([
    box({ left: '0', top: `${y}px`, width: '100%', height: '1px', background: theme.border, opacity: thing ? 0.8 : 0.35 }),

    ...(r.opens
      ? [label(r.open ? '▾' : '▸', { left: `${indent}px`, top: `${y}px`, width: '12px', cursor: 'pointer', color: theme.muted }, {
          onclick: () => ctx.change(l => {
            const open = new Set(l.open);

            if (open.has(r.id)) open.delete(r.id);
            else open.add(r.id);

            return { ...l, open };
          }),
        })]
      : []),

    label(r.label, {
      left: `${indent + 14}px`,
      top: `${y}px`,
      width: `${LABEL - indent - 14 - (thing ? 70 : 0)}px`,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      color: thing ? theme.text : theme.muted,
    }),

    ...(thing ? switches(ctx, r, y) : []),

    ...r.cells.map((c, col) => cell(ctx, m, r, col, y, c)),

    ...r.bars.map(b => bar(ctx, r, b, y, m)),

    ...(thing ? [] : handles(ctx, r, y, m)),
  ]);
}

/** Hide, lock and solo, at the end of a thing's header. */
function switches(ctx: Ctx, r: Row, y: number): VNode[] {
  const flag = (f: keyof Flags, glyph: string, x: number, title: string) =>
    label(glyph, {
      left: `${LABEL - 70 + x}px`,
      top: `${y + 3}px`,
      width: '18px',
      height: `${ROW - 6}px`,
      lineHeight: `${ROW - 6}px`,
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

/** Whether a cell is what is picked. */
function isPicked(m: Model, r: Row, col: number, entries: readonly number[]): boolean {
  const p = m.picked;

  if (p === null || p.id !== r.id || p.at !== m.keyframes[col].id) return false;
  if (r.kind === null) return p.which === 'all' || (entries.length === 1 && p.which === entries[0]);

  return p.which === r.kind || (typeof p.which === 'number' && entries.includes(p.which));
}

function cell(ctx: Ctx, m: Model, r: Row, col: number, y: number, c: Cell): VNode {
  const { entries, kinds, alive } = c;
  const x = LABEL + col * COL;
  const shade = alive ? [] : [box({ left: `${x}px`, top: `${y + 1}px`, width: `${COL}px`, height: `${ROW - 1}px`, background: 'rgba(0, 0, 0, 0.28)' })];

  if (entries.length === 0) return fragment(shade);

  const at = m.keyframes[col].id;
  const picked = isPicked(m, r, col, entries);
  const stand = entries.length === 1 && kinds[0] === 'stand';
  const size = entries.length > 1 ? 10 : 8;
  const colour = picked ? theme.accent : stand ? theme.gone : r.kind === null ? theme.muted : theme.text;

  // One entry is itself; several are the kind of them, or the thing's whole
  // keyframe on its own row.
  const which: Which = entries.length === 1 ? entries[0] : r.kind ?? 'all';

  const click = () => {
    ctx.go(at);

    if (r.kind !== null && entries.length > 1) {
      ctx.change(l => ({ ...l, picked: { id: r.id, at, which }, stack: { id: r.id, kind: r.kind!, at } }));
    }
    else {
      ctx.change(l => ({ ...l, picked: { id: r.id, at, which }, stack: null }));
    }
  };

  // Dropped a keyframe along: pushed to the next, or pulled back into the one
  // before, which is a pull from where it is seen from there.
  const moved = (by: number) => {
    const w = ctx.state().world;

    if (by > 0) {
      ctx.acted(pushed(w, r.id, at, which));
    }
    else {
      const before = w.keyframes[col - 1]?.id;

      ctx.acted(before === undefined ? { refused: 'nothing before the first keyframe to pull into' } : pulled(w, r.id, before, which));
    }
  };

  const title = entries.length > 1 ? `${entries.length}: ${[...new Set(kinds)].join(', ')}` : kinds[0];

  return fragment([
    ...shade,

    box({
      left: `${centre(col) - size / 2}px`,
      top: `${y + ROW / 2 - size / 2}px`,
      width: `${size}px`,
      height: `${size}px`,
      transform: 'rotate(45deg)',
      background: colour,
      border: entries.length > 1 ? `2px solid ${theme.panel}` : 'none',
      outline: entries.length > 1 ? `1px solid ${colour}` : 'none',
      cursor: 'grab',
    }, [], { title, onpointerdown: (e: PointerEvent) => dragged(e, click, moved, true) }),

    ...(entries.length > 1
      ? [label(String(entries.length), { left: `${centre(col) + 7}px`, top: `${y - 4}px`, fontSize: '9px', color: colour, pointerEvents: 'none' })]
      : []),
  ]);
}

/**
 * A press that is either a click or a drag along the columns: `click` if it
 * never went anywhere, `done` with how many columns it went otherwise. The
 * element follows the pointer meanwhile, and nothing is written until it is
 * let go.
 */
function dragged(e: PointerEvent, click: () => void, done: (by: number) => void, one: boolean): void {
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

    if (!moving) {
      click();
      return;
    }

    const cols = Math.round((ev.clientX - x0) / COL);
    const by = one ? Math.sign(cols) : cols;

    if (by !== 0) done(by);
  };

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

/** A repeat's bar: a line out to its last step, a dot at each step and a ring
 * at each keyframe it waits over — either clicked turns into the other. */
function bar(ctx: Ctx, r: Row, b: Bar, y: number, m: Model): VNode {
  const at = m.keyframes[b.from].id;
  const mid = y + ROW / 2;
  const out: VNode[] = [];
  let prev = b.from;

  for (const s of b.steps) {
    const x0 = centre(prev) + 6, x1 = centre(s.col) - 5;

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
      left: `${centre(s.col) - size / 2}px`,
      top: `${mid - size / 2}px`,
      width: `${size}px`,
      height: `${size}px`,
      borderRadius: '50%',
      background: s.skip ? 'transparent' : theme.muted,
      border: s.skip ? `1px solid ${theme.faded}` : 'none',
      cursor: 'pointer',
    }, [], {
      title: s.skip ? 'Waits here: click to step' : 'Steps here: click to wait',
      onclick: () => ctx.acted(skipToggled(ctx.state().world, r.id, at, b.index, m.keyframes[s.col].id)),
    }));

    prev = s.col;
  }

  if (b.forever) out.push(label('→', { left: `${centre(b.end) + 12}px`, top: `${y}px`, color: theme.muted, pointerEvents: 'none' }));

  if (b.heading !== null) {
    out.push(label(b.heading, {
      left: `${centre(b.end) + (b.forever ? 24 : 12)}px`,
      top: `${y}px`,
      fontSize: '9px',
      color: theme.faded,
      pointerEvents: 'none',
    }));
  }

  out.push(end(ctx, r.id, at, b.index, b.from, b.end, y));

  return fragment(out);
}

/** The handle on a single entry that is not yet a repeat: drag it out to make
 * one. Not on a stand, which does not repeat, nor in a stack, where the one
 * picked out of it has a bar of its own. */
function handles(ctx: Ctx, r: Row, y: number, m: Model): VNode[] {
  if (r.kind === 'stand') return [];

  const barred = new Set(r.bars.map(b => b.from));

  return r.cells.flatMap((c, col) =>
    (c.entries.length === 1 && !barred.has(col) ? [end(ctx, r.id, m.keyframes[col].id, c.entries[0], col, col, y)] : []));
}

/** Where a repeat stops, dragged along the columns: to its own column is
 * once, and to the last is to the end. */
function end(ctx: Ctx, id: Id, at: KeyframeId, index: number, from: number, last: number, y: number): VNode {
  const done = (by: number) => {
    const w = ctx.state().world;
    const e = rigOf(w, id).keys.get(at)?.[index];

    if (e === undefined) return;

    ctx.acted(timed(w, id, at, index, timesTo(w, e, from, last + by)));
  };

  return box({
    left: `${centre(last) + 7}px`,
    top: `${y + ROW / 2 - 6}px`,
    width: '4px',
    height: '12px',
    borderRadius: '2px',
    background: theme.faded,
    cursor: 'ew-resize',
  }, [], { title: 'Drag to repeat', onpointerdown: (e: PointerEvent) => dragged(e, () => {}, done, false) });
}

/** The entries of a stack, to pick one of. */
function stacked(ctx: Ctx, m: Model): VNode {
  const s = m.stack!;
  const r = m.rows[s.row];
  const at = m.keyframes[s.col].id;

  const item = (says: string, which: Which, first = false) =>
    div({
      style: {
        padding: '3px 8px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        borderBottom: first ? `1px solid ${theme.border}` : 'none',
        color: isPickedWhich(m, r.id, at, which) ? theme.accent : theme.text,
      },
      onclick: () => ctx.change(l => ({ ...l, picked: { id: r.id, at, which }, stack: null })),
    }, [text(says)]);

  return box({
    left: `${centre(s.col) - 10}px`,
    top: `${rowTop(s.row) + ROW}px`,
    zIndex: 2,
    background: theme.panel,
    border: `1px solid ${theme.border}`,
    borderRadius: '6px',
    boxShadow: `0 6px 18px ${theme.panelShadow}`,
    padding: '2px 0',
  }, [
    item(`every ${r.kind} (${s.items.length})`, r.kind!, true),
    ...s.items.map(it => item(it.label, it.index)),
  ]);
}

function isPickedWhich(m: Model, id: Id, at: KeyframeId, which: Which): boolean {
  return m.picked !== null && m.picked.id === id && m.picked.at === at && m.picked.which === which;
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
