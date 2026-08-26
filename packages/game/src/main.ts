// -----------------------------------------------------------------------------
// The page
//
// A level arrives from the editor rather than from a file: the editor opens
// this page and posts the world it is holding, buffers and all. Structured
// clone carries a typed array as a typed array, so the bake crosses whole and
// nothing here parses anything.
//
// Opened on its own — a bookmark, a reload — there is nothing to play, and it
// says so rather than standing in an empty void.
// -----------------------------------------------------------------------------

import { play } from './play';
import { World } from './world';

const host = document.getElementById('screen')!;

/** How long to wait for the opener to answer before giving up on it. */
const PATIENCE = 5000;

/**
 * The level the opener is holding.
 *
 * This page asks rather than being told, because it cannot be told: a window
 * that has only just been opened has no listener yet, and a message posted
 * into one is gone. So the ask is the handshake — the opener replies to it —
 * and both sides check the origin, since anything at all can hold a handle on
 * a window it opened.
 */
function asked(): Promise<World | null> {
  const opener = window.opener as Window | null;

  if (opener === null) return Promise.resolve(null);

  return new Promise<World | null>(resolve => {
    const heard = (e: MessageEvent): void => {
      if (e.origin !== window.location.origin || e.source !== opener) return;

      window.removeEventListener('message', heard);
      resolve(e.data as World);
    };

    window.addEventListener('message', heard);
    opener.postMessage({ ce: 'ready' }, window.location.origin);

    setTimeout(() => {
      window.removeEventListener('message', heard);
      resolve(null);
    }, PATIENCE);
  });
}

void asked().then(world => {
  if (world === null || world.versions.length === 0) {
    host.textContent = 'nothing to play — open a level from the editor with ⌘↵';
    host.style.cssText += 'display: flex; align-items: center; justify-content: center;'
      + 'font: 13px ui-monospace, monospace; color: #666;';

    return;
  }

  play(host, world);
});
