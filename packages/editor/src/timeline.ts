// -----------------------------------------------------------------------------
// The keyframe view
//
// Along the whole bottom: keyframes across, things down, a group's members
// under it, and in the point tool a polygon's corners a key names under it
// too. A thing's row holds an icon for every key written about it, side by
// side in its keyframe's column in the order they play. A column is wide
// enough for a handful and widens for more; past the width of the page the
// view scrolls, its headings staying where they are.
//
// A key is what a hand did at a keyframe without saying it was finished, and
// it draws as one diamond however much that is. Hollow is a key that does
// nothing yet — what breaking leaves, waiting to be filled. What a key does in
// words is on hovering it. See `drawn`, and `Key` in `rig.ts`.
//
// A key about single corners alone is not in the thing's row at all: it is in
// the rows of the corners it names, which are a projection of the keys rather
// than timelines of their own.
//
// Each repeat hangs under its row, a tree on its side: a line down from its
// icon to a lane of its own, and along the lane to where it stops, with a dot
// at each step and a ring wherever it waits over a keyframe. Clicking a dot or
// a ring turns one into the other, and dragging the lane's end says how far it
// goes. The rightmost icon's lane is the nearest, so no line down crosses
// another's lane.
//
// A click picks a key and everything else in its column the same gesture
// wrote, shown here: a turn of several things at once. ⌥-click picks the one
// key alone. What is picked is what the hand is on: the next gesture on the
// canvas goes into it, and a key that is not its keyframe's last is drawn as
// it leaves its thing. A gesture on the canvas puts the hand on what it wrote,
// which is picked here in turn. See `EditorState.target`. The arrow beside
// the clicked key repeats all of them, each told to run to the same keyframe, and dragging the end of a key's lane or
// clicking a dot on it picks the same and does the same to all of them. With
// ⌥ held, each is about its own key only.
//
// A needle runs down the view: on the key the hand leads with, or at the start
// of the keyframe on screen. ⌥Delete drops what it is on — the keys, or the
// keyframe and all that is written at it — and Delete alone is the canvas'.
// Dragging an icon a keyframe along pushes or pulls it, and what is picked
// with it; let go on another key of its row, it merges into that one. A
// keyframe's name dragged onto the one beside merges the two. The grip at the start of a thing's life drags its birth along, and
// its story with it; the one at the end drags its death. See `keys.ts`.
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
import { path, svg } from '@incpt/kontinuum-dom/svg';
import { Signal } from '@incpt/kontinuum-interaction';
import { interaction } from '@incpt/kontinuum-interaction/dom';

import { Input, keyOwned, pressedAway } from './input';
import {
  Place,
  Refused,
  deleted,
  droppedAt,
  entryAt,
  inserted,
  insertedBefore,
  keyInserted,
  merged,
  mergedKeyframes,
  pulledAt,
  pushedAt,
  reborn,
  redied,
  samePlace,
  skipToggledAt,
  timedAt,
} from './keys';
import { KeyframeId, keysAt } from './rig';
import { keyRigOf, layerNamer, order, unchainedAt } from './scene';
import { theme } from './theme';
import { Bar, Cell, Kind, Row, barOf, entryLabel, gestureOf, rootsOf, rowsOf, timesTo } from './track';
import { EditorState, Flags, Selection, Target, Update, World, flagged, marked, saying, within } from './types';

const LABEL = 196;
const ROW = 24;
/** A repeat's lane under its row. */
const LANE = 14;
const ICON = 14;
/** The bar over the rows, for the chips. */
const HEAD = 36;
const FONT = '11px system-ui, sans-serif';

/** One entry's room in a column, and the room at its sides. */
const SLOT = 19;
const PAD = 10;
/** The room at a column's left for its keyframe's name: a stop of its own
 * before the keys, where the needle is when it is on the keyframe. */
const VER = 26;

/** A column holds this many entries side by side before it widens. */
const ROOMY = 5;

/** What Escape means while an entry is picked. */
const KEYS = ['Escape'];

/** The view's own state: not the world's, not in the history, not saved. */
interface Local {
  /** Whether the keys are the view's: picked here, and nothing pressed
   * anywhere else since. Delete is the picked keys' for as long as it is. */
  held: boolean
}

interface Model {
  keyframes: { id: KeyframeId, name: string, unchains: boolean }[]
  /** Where each column starts, from the left of the view, and how wide it is. */
  xs: number[]
  widths: number[]
  rows: Row[]
  /** The keys the hand is on. See `EditorState.target`. */
  picked: Target | null
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
  const initial: Local = { held: false };

  return stateful(initial, (local, setLocal) => {
    const change = (f: (l: Local) => Local) => setLocal(f(local()));
    const aim = (target: Target | null) => {
      update(s => ({ ...s, target }));

      if (local().held !== (target !== null)) change(l => ({ ...l, held: target !== null }));
    };
    const letGo = () => aim(null);

    // Acted on, a pick may name an entry that is not there any more.
    const acted = (out: World | Refused) => {
      letGo();

      update(s => ('refused' in out ? saying(s, out.refused) : marked({ ...s, world: out }, s.world)));
    };

    let last: { key: string, model: Model } | null = null;

    const model = (): Model => {
      const m = modelOf(world(), selection(), state().target, state().tool === 'point' || state().tool === 'edge');
      const key = JSON.stringify(m);

      if (last !== null && last.key === key) return last.model;

      last = { key, model: m };

      return m;
    };

    // Which keyframe is on screen is a highlight rather than a change to what
    // the view is made of, so it is read where it is drawn and not in the
    // model: stepping through the keyframes rebuilds nothing.
    const current = () => order(world(), keyframe());

    const ctx: Ctx = {
      state,
      update,
      go,
      aim,
      local,
      change,
      acted,
      letGo,
      current,
      inner: null,
      model: null,
    };

    let root: (() => void) | null = null;

    return div(
      {
        ref: (el: HTMLElement) => {
          root = input.surface('keyframes', el);
        },
        onUnmount: () => root?.(),
        style: {
          pointerEvents: 'auto',
          alignSelf: 'stretch',
          maxHeight: '38vh',
          minHeight: `${HEAD + ROW}px`,
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
        // Escape is the picked keys' for as long as they are the view's.
        effect(
          () => local().held && state().target !== null,
          on => (on ? input.claim(ctx, ...KEYS) : undefined),
        ),
        keys(ctx, input),

        // A press anywhere else hands Delete back to the canvas the moment the
        // hand is back on it. The keys stay picked: a gesture on the canvas
        // is what they are picked for.
        interaction(function* () {
          while (true) {
            yield* pressedAway(input, 'keyframes');
            if (local().held) change(l => ({ ...l, held: false }));
          }
        }),
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
  /** Put the hand on keys, or on none. See `EditorState.target`. */
  aim: (target: Target | null) => void
  local: Value<Local>
  change: (f: (l: Local) => Local) => void
  acted: (out: World | Refused) => void
  letGo: () => void
  /** Where the keyframe on screen is in the order. */
  current: Value<number>
  inner: HTMLElement | null
  model: Model | null
}

function keys(ctx: Ctx, input: Input): VNode {
  return interaction(function* () {
    while (true) {
      // Claimed while an entry is picked here: Escape lets it go. Delete is
      // the canvas' alone, and ⌥Delete the needle's — see `droppedHere`.
      yield* keyOwned(input, ctx);

      if (ctx.state().target === null || ctx.state().roaming) continue;

      ctx.letGo();
    }
  });
}

// -----------------------------------------------------------------------------
// The model
// -----------------------------------------------------------------------------

/** With `corners`, the rows of the corners written about come under their
 * polygons': what the corner and edge tools are about. */
function modelOf(world: World, selection: Selection, picked: Target | null, corners: boolean): Model {
  const rows = rowsOf(world, rootsOf(world, selection), corners);

  // As wide as the fullest cell in it, the picked entry's arrow counted, and
  // never narrower than a handful.
  const arrowIn = (r: Row, col: number) => picked !== null && r.cells[col].places.some(p => samePlace(p, picked.lead));
  const widths = world.keyframes.map((_f, col) =>
    Math.max(ROOMY, ...rows.map(r => r.cells[col].places.length + (arrowIn(r, col) ? 1 : 0))) * SLOT + 2 * PAD + VER);
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
      unchains: unchains(world, f.id, selection),
    })),
    xs,
    widths,
    rows,
    picked,
  };
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
// A bar of chips stuck to the top and a label column stuck to the left, over
// everything else, which scrolls under them.
// -----------------------------------------------------------------------------

type Style = Record<string, string | number | (() => string | number)>;

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

/**
 * The middle of a column's `i`-th slot, counted from its left edge.
 *
 * From the left rather than about the middle, so that an icon stays where it
 * is when the picked one's arrow comes out beside it: only what comes after
 * the arrow moves, and a second click lands where the first did.
 */
function slot(m: Model, col: number, i: number): number {
  return m.xs[col] + VER + PAD + i * SLOT + SLOT / 2;
}

/** Where the picked entry is among a cell's icons, or -1. */
function pickedIn(m: Model, r: Row, col: number): number {
  const p = m.picked;

  return p === null ? -1 : r.cells[col].places.findIndex(q => samePlace(q, p.lead));
}

/** Where a cell's `i`-th icon sits: the picked one's arrow takes the slot after
 * it, and everything after that moves along one. */
function placed(m: Model, r: Row, col: number, i: number): number {
  const p = pickedIn(m, r, col);

  return slot(m, col, p >= 0 && i > p ? i + 1 : i);
}

/** The column under a point along the timeline, clamped to the ones there
 * are. */
function colIn(m: Model, x: number): number {
  const col = m.xs.findIndex((at, i) => x < at + m.widths[i]);

  return col < 0 ? m.xs.length - 1 : Math.max(0, col);
}

/**
 * The columns a handle in column `from` can be let go in: out from its own
 * either way, as far as `ok` takes each one, and no further than the first it
 * refuses — a drag is held to where a drop does something.
 */
function reachable(m: Model, from: number, ok: (col: number) => boolean): { a: number, b: number } {
  let a = from, b = from;

  while (a > 0 && ok(a - 1)) a--;
  while (b < m.xs.length - 1 && ok(b + 1)) b++;

  return { a, b };
}

/** How far a handle at `x` can go and stay over columns `a` to `b`. */
function over(m: Model, { a, b }: { a: number, b: number }, x: number): { lo: number, hi: number } {
  return { lo: m.xs[a] + 1 - x, hi: m.xs[b] + m.widths[b] - 1 - x };
}

/** Whether a write would be taken. */
const takes = (out: World | Refused): boolean => !('refused' in out);

function body(ctx: Ctx, m: Model): VNode {
  ctx.model = m;

  const n = m.keyframes.length;
  const width = m.xs[n - 1] + m.widths[n - 1] + 8;
  const height = HEAD + (m.rows.length === 0 ? ROW : m.rows.reduce((h, r) => h + heightOf(r), 0)) + 4;

  return div(
    {
      ref: (el: HTMLElement) => {
        ctx.inner = el;
      },
      style: { position: 'relative', width: `${width}px`, minWidth: '100%', height: `${height}px` },
    },
    [
      // The needle, down the whole view: on the key the hand leads with, or
      // on the name of the keyframe on screen, before its keys.
      box({
        left: () => `${needle(m, ctx.current()) - 1}px`,
        top: '0',
        width: '2px',
        height: `${height}px`,
        background: theme.accent,
        zIndex: 2,
        pointerEvents: 'none',
      }),

      // Where something picked stops hearing from upstream: a break in the
      // column's left edge.
      ...m.keyframes.flatMap((f, i) => (f.unchains
        ? [box({ left: `${m.xs[i] - 1}px`, top: `${HEAD}px`, width: '3px', height: `${height - HEAD}px`, background: theme.gone, borderRadius: '2px' }, [], { title: 'Unchained here' })]
        : [])),

      head(ctx, m, width),

      ...m.rows.map(r => row(ctx, m, r)),

      // With nothing picked, the keyframes are still there to be named.
      ...(m.rows.length === 0 ? [line(m.keyframes.map((f, i) => column(ctx, m, f, i)))] : []),
    ],
  );
}

/** Where the needle is along the view: the lead key's slot where the hand is
 * on one in column `col`, and on the keyframe's name otherwise. */
function needle(m: Model, col: number): number {
  const p = m.picked;

  if (p !== null) {
    for (const r of m.rows) {
      const i = r.cells[col]?.places.findIndex(q => samePlace(q, p.lead)) ?? -1;

      if (i >= 0) return placed(m, r, col, i);
    }
  }

  return named(m, col);
}

/** The middle of a column's name, before its keys. */
function named(m: Model, col: number): number {
  return (m.xs[col] ?? 0) + (VER + PAD) / 2;
}

/** A row and the lanes of its repeats. */
function heightOf(r: Row): number {
  return ROW + r.bars.length * LANE + (r.bars.length > 0 ? 4 : 0);
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
    top: '6px',
    height: `${ROW}px`,
    padding: '0 7px',
    borderRadius: '5px',
    cursor: 'pointer',
    background: on ? theme.accent : theme.border,
    color: on ? theme.onAccent : theme.text,
  }, { onclick, title });
}

/** The bar stuck to the top, with the chips that put keyframes in and take
 * them out. The keyframes are named in the rows themselves. */
function head(ctx: Ctx, m: Model, width: number): VNode {
  return div({
    style: {
      position: 'sticky',
      top: '0',
      width: `${width}px`,
      height: `${HEAD}px`,
      background: theme.panel,
      zIndex: 3,
      boxSizing: 'border-box',
    },
  }, [
    pinned([
      chip('+ insert', 8, () => ctx.update(keyframeInsertedHere), false, 'A keyframe before the one on screen, where nothing happens'),
      chip('− delete', 70, () => ctx.update(droppedHere), false, 'What the needle is on, dropped (⌥⌫)'),
    ]),
  ]);
}

/** A keyframe's name in a row, before its keys: where the needle is when it
 * is on the keyframe itself. */
function column(ctx: Ctx, m: Model, f: Model['keyframes'][number], i: number): VNode {
  const current = () => i === ctx.current();
  // The needle on the keyframe itself rather than on a key of it.
  const on = () => current() && ctx.state().target === null;
  const mid = named(m, i);

  return fragment([
    label(f.name, {
      left: `${mid}px`,
      top: '0',
      transform: 'translateX(-50%)',
      padding: '0 4px',
      zIndex: 3,
      borderRadius: '5px',
      cursor: 'grab',
      background: () => (on() ? theme.accent : 'transparent'),
      color: () => (on() ? theme.onAccent : current() ? theme.accent : theme.text),
      fontWeight: () => (current() ? '600' : '400'),
    }, {
      title: 'Drag onto the keyframe beside to merge them',
      // Clicked, the keyframe itself, as it ends: whatever key was picked is
      // let go, the one on screen included. Dragged onto the one beside, the
      // two merge. See `mergedKeyframes`.
      onpointerdown: (e: PointerEvent) => {
        const click = () => {
          ctx.letGo();
          ctx.go(f.id);
        };
        const done = (_up: PointerEvent, dx: number) => {
          const to = colIn(m, mid + dx);

          if (Math.abs(to - i) === 1) ctx.update(s => keyframesMerged(s, f.id, m.keyframes[to].id));
        };
        const a = Math.max(0, i - 1), b = Math.min(m.xs.length - 1, i + 1);

        dragged(e, click, done, over(m, { a, b }, mid));
      },
    }),

  ]);
}

function row(ctx: Ctx, m: Model, r: Row): VNode {
  const indent = 8 + r.depth * 12;

  return line([
    ...r.cells.map((c, col) => cell(ctx, m, r, col, c)),

    // Each keyframe's name in the row, before its keys.
    ...m.keyframes.map((f, i) => column(ctx, m, f, i)),

    ...r.bars.map((b, lane) => bar(ctx, m, r, b, lane)),

    ...arrow(ctx, m, r),

    ...birth(ctx, m, r),

    ...death(ctx, m, r),

    pinned([
      label(r.label, {
        left: `${indent}px`,
        width: `${LABEL - indent - 70}px`,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        color: r.corner === null ? theme.text : theme.muted,
      }),

      ...(r.corner === null ? switches(ctx, r) : []),
    ]),
  ], { height: `${heightOf(r)}px` });
}

/**
 * Where a thing is taken out, at the right edge of the last column it is there
 * in: dragged along the columns, that is the last one it is there in instead,
 * and dragged to the last of all it lives to the end. See `redied`.
 */
function death(ctx: Ctx, m: Model, r: Row): VNode[] {
  const from = r.cells.findLastIndex(c => c.alive);

  if (r.corner !== null || from < 0 || ctx.state().world.groups.has(r.id)) return [];

  const x = m.xs[from] + m.widths[from] - 3;
  const dying = (w: World, to: number) => redied(w, r.id, m.keyframes[to + 1]?.id ?? null);

  const done = (_up: PointerEvent, dx: number) => {
    const to = colIn(m, x + dx);

    if (to !== from) ctx.acted(dying(ctx.state().world, to));
  };

  return [box({
    left: `${m.xs[from] + m.widths[from] - 5}px`,
    top: '3px',
    width: '4px',
    height: `${ROW - 7}px`,
    borderRadius: '2px',
    background: theme.faded,
    cursor: 'ew-resize',
    zIndex: 1,
  }, [], {
    title: 'Drag to the last keyframe it is there in',
    onpointerdown: (e: PointerEvent) => {
      const w = ctx.state().world;

      dragged(e, () => {}, done, over(m, reachable(m, from, c => takes(dying(w, c))), x));
    },
  })];
}

/**
 * Where a thing is born, at the left edge of the first column it is there in:
 * dragged along the columns, it is born there instead, and its story goes with
 * it. See `reborn`. A group has no life of its own to move, and a corner's is
 * its polygon's to carry.
 */
function birth(ctx: Ctx, m: Model, r: Row): VNode[] {
  const from = r.cells.findIndex(c => c.alive);

  if (r.corner !== null || from < 0 || ctx.state().world.groups.has(r.id)) return [];

  const x = m.xs[from] + 3;

  const done = (_up: PointerEvent, dx: number) => {
    const to = colIn(m, x + dx);

    if (to !== from) ctx.acted(reborn(ctx.state().world, r.id, m.keyframes[to].id));
  };

  return [box({
    left: `${m.xs[from] + 1}px`,
    top: '3px',
    width: '4px',
    height: `${ROW - 7}px`,
    borderRadius: '2px',
    background: theme.faded,
    cursor: 'ew-resize',
    zIndex: 1,
  }, [], {
    title: 'Drag to where it is born',
    onpointerdown: (e: PointerEvent) => {
      const w = ctx.state().world;

      dragged(e, () => {}, done, over(m, reachable(m, from, c => takes(reborn(w, r.id, m.keyframes[c].id))), x));
    },
  })];
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

function isPicked(m: Model, place: Place): boolean {
  return m.picked !== null && m.picked.all.some(p => samePlace(p, place));
}

/** Each kind's icon, stroked in a 14 × 14 box. */
const ICONS: Record<Kind, string> = {
  // Four ways out.
  move: 'M7 1.5 V12.5 M1.5 7 H12.5 M5.2 3.3 L7 1.5 L8.8 3.3 M5.2 10.7 L7 12.5 L8.8 10.7 M3.3 5.2 L1.5 7 L3.3 8.8 M10.7 5.2 L12.5 7 L10.7 8.8',
  // Round, with the arrowhead where it is going.
  turn: 'M11.8 7 A4.8 4.8 0 1 1 9.6 3 M9.8 0.6 L9.6 3 L12 3.3',
  // Out along the diagonal, both ways.
  scale: 'M2 12 L12 2 M2 12 V8.2 M2 12 H5.8 M12 2 V5.8 M12 2 H8.2',
  skew: 'M4.5 3 H12.5 L9.5 11 H1.5 Z',
  // Corners alone: the three dots a key about them is drawn as.
  corners: 'M3.5 3.5 h1 v1 h-1 Z M10 3.5 h1 v1 h-1 Z M3.5 10 h1 v1 h-1 Z',
  // A corner cut round.
  round: 'M2 12.5 V7 A5.5 5.5 0 0 1 7.5 1.5 H12.5',
  // An edge thrown into teeth.
  deform: 'M1 9 L3.4 5 L5.8 9 L8.2 5 L10.6 9 L13 5',
  // An outline and the one taken in from it.
  erode: 'M1.5 1.5 H12.5 V12.5 H1.5 Z M4.5 4.5 H9.5 V9.5 H4.5 Z',
  stand: 'M3 2 V12 M11 2 V12',
  // An amount on a layer the owner no longer lists.
  amount: 'M3 7 H11',
};

/**
 * What a key is drawn as: a diamond, filled where it does anything.
 *
 * One shape for one key, whatever it holds — a hand that turned a thing and
 * then moved it wrote one key, and the row says so by drawing one thing.
 * What it does in words is on hovering it, and the canvas shows it outright; a
 * row of little pictures inside the diamond would be a list where the point is
 * that there is no list.
 *
 * Hollow is a key that does nothing yet: what breaking leaves, so that saying
 * "this one is finished" is a thing you can see happen, and the gesture that
 * fills it fills it in. See `broken` in `scene/core.ts`.
 *
 * An unchaining is neither: it is where the thing stops hearing from upstream
 * rather than something done to it, and it keeps the two bars it has always
 * been drawn as.
 */
function drawn(kinds: readonly Kind[], colour: string): VNode[] {
  if (kinds.length === 1 && kinds[0] === 'stand') {
    return [path({
      d: ICONS.stand,
      fill: 'none',
      stroke: colour,
      'stroke-width': 1.4,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    })];
  }

  const half = ICON / 2;

  return [path({
    d: `M${half} 1.5 L${ICON - 1.5} ${half} L${half} ${ICON - 1.5} L1.5 ${half} Z`,
    fill: kinds.length > 0 ? colour : 'none',
    stroke: colour,
    'stroke-width': 1.4,
    'stroke-linejoin': 'round',
  })];
}

/** A keyframe's keys in one row, an icon each, side by side in the order
 * they play. */
function cell(ctx: Ctx, m: Model, r: Row, col: number, c: Cell): VNode {
  const shade = c.alive
    ? []
    : [box({ left: `${m.xs[col]}px`, top: '0', width: `${m.widths[col]}px`, height: '100%', background: 'rgba(0, 0, 0, 0.28)' })];

  const at = m.keyframes[col].id;

  return fragment([
    ...shade,

    ...c.places.map((place, i) => {
      const picked = isPicked(m, place);
      const colour = picked ? theme.accent : theme.text;

      const click = (e: PointerEvent) => {
        const w = ctx.state().world;

        // The hand on it, and on what its gesture wrote beside it: a gesture
        // on the canvas adjusts them, and where one is not its keyframe's
        // last the canvas draws the thing as that key leaves it. See
        // `EditorState.target`.
        ctx.go(at);
        ctx.aim({ lead: place, all: e.altKey ? [place] : gestureOf(w, m.rows, col, place) });
      };

      // Dropped a keyframe along: pushed to the next, or pulled back into the
      // one before — and what is picked with it, where it is picked.
      // Where the icon was let go rather than the pointer, which holds it off
      // centre and can be past where the icon was held back to.
      const x = placed(m, r, col, i);
      //
      // Let go on another key of its row, it merges into that one instead.
      const moved = (_up: PointerEvent, dx: number) => {
        const w = ctx.state().world;
        const onto = keyUnder(m, r, x + dx, place);

        if (onto !== null) {
          if ('key' in place && 'key' in onto) ctx.acted(merged(w, place, onto));
          return;
        }

        const to = colIn(m, x + dx);
        const going = picked && m.picked !== null ? m.picked.all : [place];

        if (to === col + 1) {
          ctx.acted(pushedAt(w, going));
        }
        else if (to === col - 1) {
          ctx.acted(pulledAt(w, going));
        }
      };

      return box({
        left: `${placed(m, r, col, i) - ICON / 2 - 2}px`,
        top: `${ROW / 2 - ICON / 2 - 2}px`,
        width: `${ICON + 4}px`,
        height: `${ICON + 4}px`,
        borderRadius: '4px',
        background: picked ? 'rgba(91, 140, 255, 0.22)' : 'transparent',
        cursor: 'grab',
        zIndex: 1,
      }, [
        svg({ width: ICON + 4, height: ICON + 4, viewBox: `-2 -2 ${ICON + 4} ${ICON + 4}`, style: { display: 'block' } },
          drawn(c.kinds[i], colour)),
      ], {
        onpointerenter: (e: PointerEvent) => {
          (e.currentTarget as HTMLElement).title = entryTitle(ctx, place);
        },
        onpointerdown: (e: PointerEvent) => dragged(e, click, moved, alongRow(m, x)),
      });
    }),
  ]);
}

/** What an entry does, read when the pointer is over it rather than kept in
 * the model, where its numbers would rebuild the view on every drag. */
function entryTitle(ctx: Ctx, place: Place): string {
  const world = ctx.state().world;
  const e = entryAt(world, place);

  return e === undefined ? '' : entryLabel(e, layerNamer(world, place.id));
}

/** How far a key at `x` can be dragged: anywhere along the columns, since
 * any key of its row can be merged into. */
function alongRow(m: Model, x: number): { lo: number, hi: number } {
  const n = m.xs.length - 1;

  return { lo: m.xs[0] + 1 - x, hi: m.xs[n] + m.widths[n] - 1 - x };
}

/** The key of row `r` under a point along the timeline, other than `self`,
 * or nothing. */
function keyUnder(m: Model, r: Row, x: number, self: Place): Place | null {
  for (const [col, c] of r.cells.entries()) {
    for (const [i, p] of c.places.entries()) {
      if (!samePlace(p, self) && Math.abs(placed(m, r, col, i) - x) <= SLOT / 2) return p;
    }
  }

  return null;
}

/**
 * A press that is either a click or a drag along the columns: `click` if it
 * never went anywhere, and `done` with how far along it was let go otherwise —
 * held to `within`, as far as it may go either way, where that is given. The element
 * follows the pointer meanwhile, and nothing is written until then.
 */
function dragged(
  e: PointerEvent,
  click: (up: PointerEvent) => void,
  done: (up: PointerEvent, dx: number) => void,
  within?: { lo: number, hi: number },
): void {
  if (e.button !== 0) return;

  e.preventDefault();
  e.stopPropagation();

  const el = e.currentTarget as HTMLElement;
  const x0 = e.clientX;
  const was = el.style.transform;
  let moving = false;

  const along = (ev: PointerEvent) => {
    const dx = ev.clientX - x0;

    return within === undefined ? dx : Math.max(within.lo, Math.min(within.hi, dx));
  };

  const move = (ev: PointerEvent) => {
    if (Math.abs(ev.clientX - x0) > 3) moving = true;
    if (moving) el.style.transform = `translateX(${along(ev)}px) ${was}`;
  };

  const up = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    el.style.transform = was;

    if (moving) done(ev, along(ev));
    else click(ev);
  };

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

/**
 * A repeat, in its lane: a line down from its icon, and along the lane to
 * where it stops, a dot at each step and a ring at each keyframe it waits over
 * — either clicked turns into the other.
 */
function bar(ctx: Ctx, m: Model, r: Row, b: Bar, lane: number): VNode {
  const y = ROW + lane * LANE + LANE / 2;
  const x = placed(m, r, b.from, b.slot);
  const colour = isPicked(m, b.place) ? theme.accent : theme.muted;
  const out: VNode[] = [];

  // Down from the icon to the lane.
  out.push(box({
    left: `${x - 1}px`,
    top: `${ROW / 2 + ICON / 2}px`,
    width: '0',
    height: `${y - ROW / 2 - ICON / 2}px`,
    borderLeft: `2px solid ${colour}`,
    pointerEvents: 'none',
  }));

  let prev = x;

  for (const s of b.steps) {
    const x1 = centre(m, s.col) - 5;

    out.push(box({
      left: `${prev}px`,
      top: `${y - 1}px`,
      width: `${Math.max(0, x1 - prev)}px`,
      height: '0',
      borderTop: s.skip ? `1px dashed ${theme.faded}` : `2px solid ${colour}`,
      pointerEvents: 'none',
    }));

    const size = s.skip ? 8 : 6;

    out.push(box({
      left: `${centre(m, s.col) - size / 2}px`,
      top: `${y - size / 2}px`,
      width: `${size}px`,
      height: `${size}px`,
      borderRadius: '50%',
      background: s.skip ? theme.panel : colour,
      border: s.skip ? `1px solid ${theme.faded}` : 'none',
      cursor: 'pointer',
      zIndex: 1,
    }, [], {
      title: s.skip ? 'Waits here: click to step' : 'Steps here: click to wait',
      onclick: (e: MouseEvent) => acting(ctx, m, b.place, e.altKey, (w, all) => skipsToggled(w, all, b.place, m.keyframes[s.col].id)),
    }));

    prev = centre(m, s.col) + 5;
  }

  const tail = b.steps.length === 0 ? x : centre(m, b.end);

  if (b.forever) out.push(label('→', { left: `${tail + 12}px`, top: `${y - ROW / 2}px`, color: colour, pointerEvents: 'none' }));

  if (b.heading !== null) {
    out.push(label(b.heading, {
      left: `${tail + (b.forever ? 24 : 12)}px`,
      top: `${y - ROW / 2}px`,
      fontSize: '9px',
      color: theme.faded,
      pointerEvents: 'none',
    }));
  }

  out.push(end(ctx, m, b.place, b.from, tail, y));

  return fragment(out);
}

/**
 * The picked entry's arrow, in the slot after its icon and drawn unlike any
 * entry: dragged to a keyframe, what is picked repeats to there — to its own
 * is once, and to the last is to the end. Each is told outright, whatever it
 * did before.
 */
function arrow(ctx: Ctx, m: Model, r: Row): VNode[] {
  const p = m.picked;

  if (p === null) return [];

  const col = m.keyframes.findIndex(f => f.id === p.lead.at);
  const i = pickedIn(m, r, col);

  if (i < 0) return [];

  const x = slot(m, col, i + 1);

  const done = (up: PointerEvent, dx: number) => {
    acting(ctx, m, p.lead, up.altKey, (w, all) => repeatedTo(w, all, col, colIn(m, x + dx)));
  };

  return [box({
    left: `${x - ICON / 2 - 2}px`,
    top: `${ROW / 2 - ICON / 2 - 2}px`,
    width: `${ICON + 4}px`,
    height: `${ICON + 4}px`,
    borderRadius: '4px',
    border: `1px dashed ${theme.accent}`,
    cursor: 'ew-resize',
    zIndex: 1,
  }, [
    svg({ width: ICON + 2, height: ICON + 2, viewBox: `-1 -1 ${ICON + 2} ${ICON + 2}`, style: { display: 'block' } }, [
      path({
        d: 'M2 7 H12 M8.5 3.5 L12 7 L8.5 10.5',
        fill: 'none',
        stroke: theme.accent,
        'stroke-width': 1.6,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      }),
    ]),
  ], {
    title: 'Drag to the keyframe it repeats to',
    onpointerdown: (e: PointerEvent) => dragged(e, () => {}, done, repeatable(ctx, m, p.lead, e.altKey, col, x)),
  })];
}

/** Where a repeat stops, dragged along the columns: to its own column is
 * once, and to the last is to the end. */
function end(ctx: Ctx, m: Model, place: Place, from: number, x: number, y: number): VNode {
  const done = (up: PointerEvent, dx: number) => {
    acting(ctx, m, place, up.altKey, (w, all) => repeatedTo(w, all, from, colIn(m, x + 7 + dx)));
  };

  return box({
    left: `${x + 5}px`,
    top: `${y - 6}px`,
    width: '4px',
    height: '12px',
    borderRadius: '2px',
    background: theme.faded,
    cursor: 'ew-resize',
    zIndex: 1,
  }, [], {
    title: 'Drag to where it stops',
    onpointerdown: (e: PointerEvent) => dragged(e, () => {}, done, repeatable(ctx, m, place, e.altKey, from, x + 7)),
  });
}

/**
 * `f` done to what a hand on the entry at `place` is about, which is then
 * what is picked: everything picked with it where it is picked, and otherwise
 * what its gesture wrote in its column — or with ⌥ held, it alone.
 */
function acting(
  ctx: Ctx,
  m: Model,
  place: Place,
  alone: boolean,
  f: (world: World, places: readonly Place[]) => World | Refused,
): void {
  const w = ctx.state().world;
  const all = aboutWhich(w, m, place, alone);

  ctx.acted(f(w, all));

  // Told how often to repeat or where to wait, every entry is where it was.
  ctx.aim({ lead: place, all });
}

/** What a hand on the entry at `place` is about. See `acting`. */
function aboutWhich(w: World, m: Model, place: Place, alone: boolean): Place[] {
  return alone ? [place] : isPicked(m, place) ? m.picked!.all : gestureOf(w, m.rows, order(w, place.at), place);
}

/** How far a repeat's handle at `x` can be dragged: over the columns it can
 * be told to repeat to. */
function repeatable(ctx: Ctx, m: Model, place: Place, alone: boolean, from: number, x: number): { lo: number, hi: number } {
  const w = ctx.state().world;
  const all = aboutWhich(w, m, place, alone);

  return over(m, reachable(m, from, c => takes(repeatedTo(w, all, from, c))), x);
}

/** Every entry at `places`, written at column `from`, told to repeat to
 * column `to`. */
function repeatedTo(world: World, places: readonly Place[], from: number, to: number): World | Refused {
  let w: World | Refused = world;

  for (const q of places) {
    const e = entryAt(w, q);

    if (e !== undefined) w = timedAt(w, q, timesTo(w, e, from, to));
    if ('refused' in w) break;
  }

  return w;
}

/** Every entry at `places` waiting over keyframe `k`, or stepping there,
 * whichever the one at `lead` is turning to: the ones already there stay, and
 * so do the ones whose repeat does not reach it. */
function skipsToggled(world: World, places: readonly Place[], lead: Place, k: KeyframeId): World | Refused {
  const waits = entryAt(world, lead)?.skip?.has(k) ?? false;
  const col = order(world, k);
  let w: World | Refused = world;

  for (const q of places) {
    const e = entryAt(w, q);
    const reaches = e !== undefined && (barOf(w, e, order(w, q.at), q)?.steps.some(s => s.col === col) ?? false);

    if (reaches && (e.skip?.has(k) ?? false) === waits) w = skipToggledAt(w, q, k);
    if ('refused' in w) break;
  }

  return w;
}

// -----------------------------------------------------------------------------
// Keyframes in and out
// -----------------------------------------------------------------------------

/**
 * A keyframe put in before the one on screen, and stood in: one where nothing
 * happens yet. See `insertedBefore` in `keys.ts`.
 */
export function keyframeInsertedHere(s: EditorState): EditorState {
  const out = insertedBefore(s.world, s.keyframe);

  if (out === null) return s;

  return marked({ ...s, world: out.world, keyframe: out.key, target: null, replay: null }, s.world);
}

/**
 * An empty key put in beside what the needle is on, and the hand on it.
 *
 * On keys, one before or after each of them. On a keyframe, which is before
 * its keys: after is at the front of its own list for each thing picked, and
 * before is at the end of the keyframe before — where there is none, a
 * keyframe is put in front of it first. See `keyInserted` in `keys.ts`.
 */
export function keyInsertedHere(s: EditorState, after: boolean): EditorState {
  const t = s.target;

  if (t !== null) {
    let world = s.world;
    const made: Place[] = [];

    for (const p of t.all) {
      if (!('key' in p)) continue;

      const index = keysAt(keyRigOf(world, p.id), p.at).findIndex(key => key.id === p.key);
      const out = keyInserted(world, p.id, p.at, after ? index + 1 : index);

      if ('refused' in out) return saying(s, out.refused);

      world = out.world;
      made.push(out.place);
    }

    if (made.length === 0) return s;

    const lead = made.find(p => p.id === t.lead.id) ?? made[0];

    return marked({ ...s, world, target: { lead, all: [lead, ...made.filter(p => p !== lead)] } }, s.world);
  }

  const ids = [...s.selection.polygons, ...s.selection.artefacts, ...s.selection.paths];

  if (ids.length === 0) return saying(s, 'nothing picked to take a key');

  let world = s.world;
  let at: KeyframeId | undefined = after ? s.keyframe : s.world.keyframes[order(s.world, s.keyframe) - 1]?.id;

  if (at === undefined) {
    const out = insertedBefore(world, s.keyframe);

    if (out === null) return s;

    world = out.world;
    at = out.key;
  }

  const made: Place[] = [];

  for (const id of ids) {
    const out = keyInserted(world, id, at, after ? 0 : Infinity);

    if ('refused' in out) continue;

    world = out.world;
    made.push(out.place);
  }

  if (made.length === 0) return saying(s, 'nothing picked is there to take a key');

  return marked({ ...s, world, keyframe: at, target: { lead: made[0], all: made }, replay: null }, s.world);
}

/**
 * A keyframe put in after the one on screen, and stood in: one where nothing
 * happens yet. See `inserted` in `keys.ts`.
 */
export function keyframeInsertedAfter(s: EditorState): EditorState {
  const out = inserted(s.world, s.keyframe);

  if (out === null) return s;

  return marked({ ...s, world: out.world, keyframe: out.key, target: null, replay: null }, s.world);
}

/**
 * What the needle is on dropped: the keys the hand is on, or where it is on
 * none, the keyframe on screen and everything written at it, standing in the
 * one after it — or before it, for the last. See `deleted` in `keys.ts`.
 */
export function droppedHere(s: EditorState): EditorState {
  if (s.target !== null) return marked({ ...s, world: droppedAt(s.world, s.target.all), target: null }, s.world);

  const out = deleted(s.world, s.keyframe, 'dropped');

  if ('refused' in out) return saying(s, out.refused);

  const i = order(s.world, s.keyframe);
  const to = s.world.keyframes[i + 1] ?? s.world.keyframes[i - 1];

  return marked({ ...s, world: out, keyframe: to.id, replay: null }, s.world);
}

/** Keyframe `from` merged into `into`, and stood in what is left of them. See
 * `mergedKeyframes` in `keys.ts`. */
function keyframesMerged(s: EditorState, from: KeyframeId, into: KeyframeId): EditorState {
  const out = mergedKeyframes(s.world, from, into);

  if ('refused' in out) return saying(s, out.refused);

  const left = out.keyframes.some(f => f.id === into) ? into : from;

  return marked({ ...s, world: out, keyframe: left, target: null, replay: null }, s.world);
}
