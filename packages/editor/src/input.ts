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
  /** Installs the listeners and gives back the way to remove them. */
  listen: () => () => void
}

export function createInput(): Input {
  const keyDown = signal<KeyboardEvent>();
  const keyUp = signal<KeyboardEvent>();

  function onKeyDown(e: KeyboardEvent) {
    keyDown.emit(e);
  }

  function onKeyUp(e: KeyboardEvent) {
    keyUp.emit(e);
  }

  return {
    keyDown,
    keyUp,

    listen: () => {
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);

      return () => {
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp);
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
 */
export function* keyPressed(input: Input, ...codes: string[]): Op<KeyboardEvent> {
  while (true) {
    const e = yield* input.keyDown;

    if (codes.includes(e.code)) {
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
