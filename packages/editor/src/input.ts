import { VNode, effect } from '@incpt/kontinuum-dom';
import { Op, Signal, perform, signal } from '@incpt/kontinuum-interaction';

/**
 * The keyboard, as signals. One pair of window listeners for the whole editor
 * rather than one per thing that wants a key: `emit` wakes every waiter, so any
 * number of loops can watch the same key without knowing about each other.
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
 * Waits for one key, letting the rest through to whoever else is waiting. Key
 * repeats count as presses; a loop that does not want them is already past this
 * point and waiting on something else.
 */
export function* keyPressed(input: Input, code: string): Op<KeyboardEvent> {
  for (;;) {
    const e = yield* input.keyDown;

    if (e.code === code) {
      return e;
    }
  }
}

export function* keyReleased(input: Input, code: string): Op<KeyboardEvent> {
  for (;;) {
    const e = yield* input.keyUp;

    if (e.code === code) {
      return e;
    }
  }
}

/**
 * The window lost focus, so whatever was being held is no longer held. Its own
 * listener, for as long as the branch waiting on it is alive.
 */
export function blurred(): Op<void> {
  return perform(resume => {
    const onBlur = () => resume();

    window.addEventListener('blur', onBlur);

    return () => window.removeEventListener('blur', onBlur);
  });
}
