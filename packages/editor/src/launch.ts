// -----------------------------------------------------------------------------
// The game page
//
// A window of its own for the game, with a level in it: whatever the server
// hands out as `/level.json`, which is a file the editor wrote. See
// `scripts/server.mjs`, which is what `pnpm server -- level.json` runs.
//
// Here rather than in the game because a level file is the editor's format.
// What the game plays is flat — resolved rings per version and the bake's
// buffers — and turning one into the other is the editor's `shipped`, which
// the game has no business knowing how to do.
//
// A file that came with its bake plays at once. One that did not is baked
// here first, a slice at a time the way the editor does it, so that the page
// goes on saying how far along it is.
// -----------------------------------------------------------------------------

import { play } from '@ce/game';
import { Bake, bakeAll } from './bake';
import { shipped } from './export';
import { Saved, reopened } from './save';

const host = document.getElementById('screen')!;

function said(text: string): void {
  host.textContent = text;
  host.style.cssText += `
    display: flex; align-items: center; justify-content: center;
    font: 13px ui-monospace, monospace; color: #666;
  `;
}

function quiet(): void {
  host.textContent = '';
  host.style.display = '';
}

/** The level being served, or null where there is none. */
async function fetched(): Promise<Saved | null> {
  const response = await fetch('/level.json', { cache: 'no-store' });
  if (!response.ok) return null;

  // A dev server with nothing at the path may still answer with a page.
  try {
    return await response.json() as Saved;
  }
  catch {
    return null;
  }
}

/** The whole level baked, in slices with the browser given its turn between. */
function baked(state: Awaited<ReturnType<typeof reopened>>): Promise<Bake> {
  const job = bakeAll(state.world);

  return new Promise(resolve => {
    const pump = (): void => {
      const until = performance.now() + 50;
      let step = job.next();

      while (!step.done && performance.now() < until) step = job.next();

      if (step.done) {
        resolve({ ...state.bake, spans: step.value, progress: null });
        return;
      }

      said(`baking ${Math.round(step.value * 100)}%`);
      setTimeout(pump, 0);
    };

    pump();
  });
}

async function main(): Promise<void> {
  said('loading');

  const file = await fetched();

  if (file === null) {
    said('no level here — run `pnpm server -- level.json`, or press ⌘\\ in the editor');
    return;
  }

  const state = await reopened(file);
  const bake = file.baked === undefined ? await baked(state) : state.bake;

  quiet();
  play(host, shipped(state.world, bake));
}

main().catch(e => {
  said(`this level would not load: ${e}`);
  console.error(e);
});
