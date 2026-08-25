import { VNode, effect } from '@incpt/kontinuum-dom';
import { Op, Signal, perform, signal } from '@incpt/kontinuum-interaction';

import { Point, Update, panBy } from './types';

/** A keyboard has two of each modifier, and nobody means one of them. */
export const SHIFT = ['ShiftLeft', 'ShiftRight'];

// -----------------------------------------------------------------------------
// The keyboard, as signals
// -----------------------------------------------------------------------------

/**
 * One pair of window listeners for the whole editor rather than one per thing
 * that wants a key: `emit` wakes every waiter, so any number of loops can watch
 * the same key without knowing about each other.
 *
 * The events are passed on as they come, undecided — what a key means is the
 * business of whoever waits for it.
 */
export interface Input {
  keyDown: Signal<KeyboardEvent>
  keyUp: Signal<KeyboardEvent>
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
   * Take some keys for as long as the returned function has not been called.
   *
   * The bus is a broadcast and has no notion of an event being used up: every
   * waiter is woken, and what a key means is settled by each of them agreeing
   * to stay out of the others' way. That works for a fixed division — the
   * canvas leaves anything with a command key on it to the shortcuts — and
   * stops working the moment the division depends on what is going on, which
   * is what a half-drawn polygon is: while one is open, Cmd+Z is the pen's and
   * takes back a point, and the rest of the time it is the document's.
   *
   * So a running gesture says so, rather than everybody else having to know
   * about it. `keyPressed` skips what is claimed; whoever claimed it is
   * waiting on `keyDown` directly and gets it. Counted rather than a flag, so
   * two claims on the same key cannot end with the first release freeing it.
   */
  claim: (...codes: string[]) => () => void
  claimed: (code: string) => boolean
  listen: () => () => void
}

export function createInput(): Input {
  const keyDown = signal<KeyboardEvent>();
  const keyUp = signal<KeyboardEvent>();

  let pointer: PointerEvent | null = null;
  const down = new Set<string>();
  const claims = new Map<string, number>();

  function onKeyDown(e: KeyboardEvent) {
    down.add(e.code);
    keyDown.emit(e);
  }

  function onKeyUp(e: KeyboardEvent) {
    down.delete(e.code);
    keyUp.emit(e);
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
    keyDown,
    keyUp,
    pointer: () => pointer,
    holding: code => down.has(code),
    claimed: code => (claims.get(code) ?? 0) > 0,

    claim: (...codes) => {
      for (const code of codes) claims.set(code, (claims.get(code) ?? 0) + 1);

      // Written to be safe to call twice, because a gesture releasing in a
      // `finally` may be unwinding for the second time — once for the branch
      // and once for the interaction coming down around it.
      let held = true;

      return () => {
        if (!held) return;

        held = false;

        for (const code of codes) claims.set(code, (claims.get(code) ?? 1) - 1);
      };
    },

    listen: () => {
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('blur', onBlur);

      return () => {
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp);
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('blur', onBlur);
      };
    },
  };
}

/** Holds the listeners for as long as it is mounted. */
export function inputListener(input: Input): VNode {
  return effect(input.listen);
}

/**
 * Waits for one of `codes`, letting the rest through to whoever else is
 * waiting. Key repeats count as presses; a loop that does not want them is
 * already past this point and waiting on something else.
 *
 * A key a running gesture has claimed is not one of them, however plainly it
 * is listed here. See `Input.claim`.
 */
export function* keyPressed(input: Input, ...codes: string[]): Op<KeyboardEvent> {
  while (true) {
    const e = yield* input.keyDown;

    if (codes.includes(e.code) && !input.claimed(e.code)) {
      return e;
    }
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

/** The primary button going down, and only that one. */
export function pointerPressed(): Op<PointerEvent> {
  return pointerButton('pointerdown');
}

export function pointerReleased(): Op<PointerEvent> {
  return pointerButton('pointerup');
}

function pointerButton(type: 'pointerdown' | 'pointerup'): Op<PointerEvent> {
  return perform(resume => {
    const onPointerButton = (e: PointerEvent) => {
      if (e.button === 0) {
        resume(e);
      }
    };

    window.addEventListener(type, onPointerButton);

    return () => window.removeEventListener(type, onPointerButton);
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
