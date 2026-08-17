import { Op, perform } from '@incpt/kontinuum-interaction';

import { Update } from '../state';
import { panBy } from '../view';

/**
 * Panning, for as long as it is running: the mouse drags the world along, and
 * the listener goes when the branch does.
 *
 * It never finishes on its own — whoever runs it decides when panning is over
 * by racing it against something else, and cancelling is the whole of the
 * cleanup. Nothing here knows what started it, so it serves a held space bar,
 * a middle mouse button or a hand tool equally well.
 *
 * The first move only marks where the pan began; the world moves from there.
 */
export function pan(update: Update): Op<never> {
  return perform(() => {
    let last: { x: number, y: number } | null = null;

    function onPointerMove(e: PointerEvent) {
      const at = { x: e.clientX, y: e.clientY };

      if (last !== null) {
        const dx = at.x - last.x;
        const dy = at.y - last.y;

        update(s => ({ ...s, view: panBy(s.view, dx, dy) }));
      }

      last = at;
    }

    window.addEventListener('pointermove', onPointerMove);

    return () => window.removeEventListener('pointermove', onPointerMove);
  });
}
