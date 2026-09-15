import { VNode, effect } from '@incpt/kontinuum-dom';
import { Op, Signal, perform, signal } from '@incpt/kontinuum-interaction';

import { Point, Update, panBy } from './types';

/** A keyboard has two of each modifier, and nobody means one of them. */
export const SHIFT = ['ShiftLeft', 'ShiftRight'];

// -----------------------------------------------------------------------------
// The keyboard, as signals
// -----------------------------------------------------------------------------

/**
 * One set of window listeners for the whole editor rather than one per thing
 * that wants a key: `emit` wakes every waiter, so any number of loops can watch
 * the same key without knowing about each other.
 *
 * Who a key press or a pointer press belongs to is decided here, once, as it
 * is emitted, and goes out with it. Every waiter is woken for every event, in
 * no order anybody should count on, and some of them change what is going on
 * as they act on it — a pick let go of, a claim released, a list closed. A
 * waiter that asked the live state whose event it was would get a different
 * answer depending on who had been woken first, and the same Delete would drop
 * an entry and then take the room with it. Stamped at emission, the answer is
 * the one that held when the event happened, whoever hears it when.
 */
export interface Input {
  keys: Signal<Key>
  keyUp: Signal<KeyboardEvent>
  presses: Signal<Press>
  /**
   * The last pointer event seen anywhere, or nothing before the pointer has
   * moved at all.
   *
   * A gesture started by a key press has to know where the cursor already is,
   * and it cannot have been the one watching — it did not exist yet. Tracking
   * this in whichever branch happens to be waiting does not work: that branch
   * is torn down for as long as a gesture runs, so the position stops being
   * updated exactly while the cursor is doing the most moving, and the next
   * gesture starts from wherever the last one began. Hence one listener here,
   * alive for as long as the editor is.
   */
  pointer: () => PointerEvent | null
  /**
   * Whether a key is down right now.
   *
   * The same reason as `pointer`, and it bites harder: a gesture that wants to
   * know whether a modifier is held cannot have been the one watching for it,
   * because it was started by the press it would have had to be waiting on. The
   * browser keeps this for shift and the rest and hands it out on every event;
   * for an ordinary key there is nobody keeping it but us.
   */
  holding: (code: string) => boolean
  /**
   * Take some keys for `by`, for as long as the returned function has not been
   * called.
   *
   * What a key means depends on what is going on: while a polygon is open,
   * Cmd+Z is the pen's and takes back a point, and the rest of the time it is
   * the document's; while an entry is picked in the keyframes, Delete is its.
   * So whoever that is says so, rather than everybody else having to know.
   *
   * Claims stack: a key goes to the newest claim on it, the way a list opened
   * over the keyframes has Escape before they do. A press is stamped with its
   * owner as it happens — see `Key` — so a claim taken or let go of while one
   * is being dispatched changes the next, not this one.
   */
  claim: (by: object, ...codes: string[]) => () => void
  /**
   * `el` and everything in it is the surface `name`, for as long as the
   * returned function has not been called: what a press there is stamped
   * with. See `Press`.
   */
  surface: (name: Surface, el: Element) => () => void
  listen: () => () => void
}

/** A key going down, and whose it is: the claim it went to, or nobody's. */
export interface Key {
  event: KeyboardEvent
  owner: object | null
}

/** The places a press can land that care whether it did. */
export type Surface = 'canvas' | 'keyframes' | 'beneath';

/** A pointer going down, any button, and the surface it landed on, or none. */
export interface Press {
  event: PointerEvent
  on: Surface | null
}

export function createInput(): Input {
  const keys = signal<Key>();
  const keyUp = signal<KeyboardEvent>();
  const presses = signal<Press>();

  let pointer: PointerEvent | null = null;
  const down = new Set<string>();
  const claims: { by: object, codes: readonly string[] }[] = [];
  const surfaces = new Map<Node, Surface>();

  function onKeyDown(e: KeyboardEvent) {
    // Typed into a field, it is the field's: a digit in the effects pane is
    // a number, not a retype.
    if (typing(e.target)) return;

    down.add(e.code);

    let owner: object | null = null;

    for (let i = claims.length - 1; i >= 0 && owner === null; i--) {
      if (claims[i].codes.includes(e.code)) owner = claims[i].by;
    }

    keys.emit({ event: e, owner });
  }

  function onKeyUp(e: KeyboardEvent) {
    down.delete(e.code);
    keyUp.emit(e);
  }

  // In the capture phase, so that it is heard wherever it lands, whatever
  // stops it on the way.
  function onPointerDown(e: PointerEvent) {
    let on: Surface | null = null;

    for (let n = e.target as Node | null; n !== null && on === null; n = n.parentNode) {
      on = surfaces.get(n) ?? null;
    }

    presses.emit({ event: e, on });
  }

  function onPointerMove(e: PointerEvent) {
    pointer = e;
  }

  // A key let go while another window had the focus never comes back up here,
  // and would read as held for ever after.
  function onBlur() {
    down.clear();
  }

  return {
    keys,
    keyUp,
    presses,
    pointer: () => pointer,
    holding: code => down.has(code),

    claim: (by, ...codes) => {
      const claim = { by, codes };

      claims.push(claim);

      // Written to be safe to call twice, because a gesture releasing in a
      // `finally` may be unwinding for the second time — once for the branch
      // and once for the interaction coming down around it.
      return () => {
        const i = claims.indexOf(claim);

        if (i >= 0) claims.splice(i, 1);
      };
    },

    surface: (name, el) => {
      surfaces.set(el, name);

      return () => {
        if (surfaces.get(el) === name) surfaces.delete(el);
      };
    },

    listen: () => {
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      window.addEventListener('pointerdown', onPointerDown, true);
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('blur', onBlur);

      return () => {
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp);
        window.removeEventListener('pointerdown', onPointerDown, true);
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('blur', onBlur);
      };
    },
  };
}

/** Whether a key is going into something that takes typing. */
function typing(target: EventTarget | null): boolean {
  const el = target as Partial<HTMLInputElement> | null;
  const tag = el?.tagName;

  // A checkbox takes no typing, and one just clicked still has the focus.
  return (tag === 'INPUT' && el?.type !== 'checkbox') || tag === 'SELECT' || tag === 'TEXTAREA';
}

/** Holds the listeners for as long as it is mounted. */
export function inputListener(input: Input): VNode {
  return effect(input.listen);
}

/**
 * Waits for one of `codes` that nobody has claimed, letting the rest through to
 * whoever else is waiting. Key repeats count as presses; a loop that does not
 * want them is already past this point and waiting on something else.
 */
export function* keyPressed(input: Input, ...codes: string[]): Op<KeyboardEvent> {
  while (true) {
    const { event, owner } = yield* input.keys;

    if (owner === null && codes.includes(event.code)) return event;
  }
}

/** The next key that is nobody's, or `by`'s: what a loop that answers to any
 * key hears, a gesture holding a claim included. */
export function* keyHeard(input: Input, by: object | null = null): Op<KeyboardEvent> {
  while (true) {
    const { event, owner } = yield* input.keys;

    if (owner === null || owner === by) return event;
  }
}

/** The next key claimed for `by`, and only those. */
export function* keyOwned(input: Input, by: object): Op<KeyboardEvent> {
  while (true) {
    const { event, owner } = yield* input.keys;

    if (owner === by) return event;
  }
}

export function* keyReleased(input: Input, ...codes: string[]): Op<KeyboardEvent> {
  while (true) {
    const e = yield* input.keyUp;

    if (codes.includes(e.code)) {
      return e;
    }
  }
}

/** A press of `button` on the surface `on`. */
export function* pressedOn(input: Input, on: Surface, button = 0): Op<PointerEvent> {
  while (true) {
    const p = yield* input.presses;

    if (p.on === on && p.event.button === button) return p.event;
  }
}

/** A press of any button anywhere but the surface `on`: what lets go of what
 * was only there while the hand was. */
export function* pressedAway(input: Input, on: Surface): Op<PointerEvent> {
  while (true) {
    const p = yield* input.presses;

    if (p.on !== on) return p.event;
  }
}

// -----------------------------------------------------------------------------
// Gestures
//
// Each one holds its own listener for exactly as long as its branch is alive:
// the runtime runs what a task gives back once it is done with, whether that
// came of resuming or of being cancelled, so undoing it is written the once.
// -----------------------------------------------------------------------------

/** The window lost focus, so whatever was being held is no longer held. */
export function blurred(): Op<void> {
  return perform(resume => {
    const onBlur = () => resume();

    window.addEventListener('blur', onBlur);

    return () => window.removeEventListener('blur', onBlur);
  });
}

/**
 * Every pointer move, for as long as it runs. It never finishes on its own —
 * whoever runs it decides when the gesture is over by racing it against
 * something else.
 *
 * The event goes through whole, the way `keyPressed` passes its own on: it
 * carries which modifiers were down at the time, and the browser already keeps
 * that better than a bus repeating keydowns and keyups could.
 */
export function pointerMoved(onMove: (e: PointerEvent) => void): Op<never> {
  return perform(() => {
    window.addEventListener('pointermove', onMove);

    return () => window.removeEventListener('pointermove', onMove);
  });
}

/**
 * The pointer leaving the neighbourhood of where it went down, which is what
 * separates a press that meant to be a drag from one that meant to be a click.
 *
 * `slop` is in screen pixels. A hand on a mouse moves a pixel or two on its way
 * to letting go, and reading that as a drag would mean the marquee flickered up
 * over every click; every editor forgives it and this is how much.
 */
export function pointerDragged(from: Point, slop: number): Op<PointerEvent> {
  return perform(resume => {
    const onMove = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - from.x, e.clientY - from.y) > slop) resume(e);
    };

    window.addEventListener('pointermove', onMove);

    return () => window.removeEventListener('pointermove', onMove);
  });
}

/** The first pointer move over `el` itself: where a gesture begun from
 * somewhere else starts reading the hand from. */
export function pointerOver(el: Element): Op<PointerEvent> {
  return perform(resume => {
    const onMove = (e: PointerEvent) => {
      if (e.target === el) resume(e);
    };

    window.addEventListener('pointermove', onMove);

    return () => window.removeEventListener('pointermove', onMove);
  });
}

/** The primary button coming up, anywhere: a drag ends wherever it is let
 * go. */
export function pointerReleased(): Op<PointerEvent> {
  return perform(resume => {
    const onUp = (e: PointerEvent) => {
      if (e.button === 0) resume(e);
    };

    window.addEventListener('pointerup', onUp);

    return () => window.removeEventListener('pointerup', onUp);
  });
}

/**
 * Panning: the mouse drags the world along, for as long as this runs. Nothing
 * here knows what started it, so it serves a held space bar, a middle mouse
 * button or a hand tool equally well. The first move only marks where the pan
 * began; the world moves from there.
 */
export function pan(update: Update): Op<never> {
  let last: Point | null = null;

  return pointerMoved(e => {
    const at = { x: e.clientX, y: e.clientY };
    const previous = last;

    last = at;

    if (previous !== null) {
      update(s => ({ ...s, view: panBy(s.view, at.x - previous.x, at.y - previous.y) }));
    }
  });
}
