import { VNode, object, stateful } from '@incpt/kontinuum-dom';
import { div } from '@incpt/kontinuum-dom/html';

import { World } from './world';
import { createInput, inputListener } from './input';
import { Update, initialState } from './state';
import { worldCanvas } from './ui/canvas';
import { toolbar } from './ui/toolbar';

/**
 * The editor: a canvas that draws the world, and the chrome floating above it.
 * One `stateful` at the top and an `object` split beneath it, so that each
 * piece of the UI reads the fields it needs and wakes for those alone.
 *
 * The input bus is made here and passed down, so every shortcut in the editor
 * waits on the same one set of listeners.
 */
export function editor(initial: World): VNode {
  const input = createInput();

  return stateful(initialState(initial), (state, set) => {
    const update: Update = fn => set(fn(state()));

    return object(state, s =>
      div(
        {
          style: {
            position: 'absolute',
            inset: '0',
            overflow: 'hidden',
          },
        },
        [
          inputListener(input),

          worldCanvas(s.world, s.settings, s.view, input, update),
          toolbar(s.tool),
        ],
      ),
    );
  });
}
