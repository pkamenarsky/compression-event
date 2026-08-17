import { VNode, stateful, text } from '@incpt/kontinuum-dom';
import { div } from '@incpt/kontinuum-dom/html';

import { World } from './world';

/** The whole editor, over one world. Nothing in it yet but the shell. */
export function editor(initial: World): VNode {
  return stateful(initial, world =>
    div(
      {
        style: {
          position: 'absolute',
          inset: '0',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#666',
        },
      },
      text(() => `editor — ${world().versions.length} versions`),
    ),
  );
}
