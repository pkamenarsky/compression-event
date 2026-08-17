import { Value } from '@incpt/kontinuum';
import { VNode, effect } from '@incpt/kontinuum-dom';
import { canvas } from '@incpt/kontinuum-dom/html';
import { select } from '@incpt/kontinuum-interaction';
import { interactive } from '@incpt/kontinuum-interaction/dom';

import { World } from '../world';
import { Input, blurred, keyPressed, keyReleased } from '../input';
import { Settings } from '../settings';
import { Update } from '../state';
import { View, resized } from '../view';
import { draw } from './draw';
import { pan } from './pan';

/**
 * The world, drawn, and the ways of getting about in it.
 *
 * The element is kept by `ref` and never re-created; everything that happens to
 * it happens either in the effects nested inside it or in the loop beside it.
 * Because the data is read in the effect's value function, the canvas wakes for
 * a change to the world, the settings or the view, and for nothing else.
 *
 * Holding space pans: the loop waits for the key, then races the pan against
 * letting go of it, so the mode is where the loop stands rather than a flag
 * somebody has to remember to clear. Losing focus ends it down the same path,
 * which is why the cursor cannot get stuck.
 */
export function worldCanvas(
  world: Value<World>,
  settings: Value<Settings>,
  view: Value<View>,
  input: Input,
  update: Update,
): VNode {
  let el: HTMLCanvasElement | undefined;
  let ctx: CanvasRenderingContext2D | null = null;

  const cursor = (value: string) => {
    if (el) {
      el.style.cursor = value;
    }
  };

  return interactive(() => ({
    view: canvas(
      {
        style: {
          display: 'block',
          position: 'absolute',
          inset: '0',
          width: '100%',
          height: '100%',
        },

        // Runs before the children below register, so they can count on the element
        ref: (node: HTMLCanvasElement) => {
          el = node;
          ctx = node.getContext('2d');
        },
      },
      [
        effect(() => el && observeSize(el, update)),

        effect(
          () => [world(), settings(), view()] as const,
          ([w, s, v]) => {
            if (el && ctx) {
              draw(el, ctx, w, s, v);
            }
          },
        ),
      ],
    ),

    run: function* () {
      for (;;) {
        // Signals resume their waiters where they were emitted, so this is
        // still inside the listener and space does not also reach the page
        (yield* keyPressed(input, 'Space')).preventDefault();

        cursor('grab');

        yield* select({
          panning: pan(update),
          done: keyReleased(input, 'Space'),
          lost: blurred(),
        });

        cursor('');
      }
    },
  }));
}

/** How big the canvas got is an update like any other, so the draw wakes for it. */
function observeSize(el: HTMLCanvasElement, update: Update): () => void {
  const observer = new ResizeObserver(() => {
    const width = el.clientWidth;
    const height = el.clientHeight;
    const dpr = window.devicePixelRatio || 1;

    update(s => {
      if (s.view.width === width && s.view.height === height && s.view.dpr === dpr) {
        return s;
      }

      return { ...s, view: resized(s.view, width, height, dpr) };
    });
  });

  observer.observe(el);

  return () => observer.disconnect();
}
