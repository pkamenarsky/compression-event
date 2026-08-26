// -----------------------------------------------------------------------------
// What the game says
//
// The jam build's overlay, carried over: a full-screen message that waits, a
// line in the middle naming whatever one is standing next to, and a black
// screen at the end. All of it is the page rather than the scene — it is text,
// and a texture of text in a dithered 3D view would be unreadable at the
// resolution the look depends on.
//
// One element per thing it can say, built once and shown or hidden, so that a
// message arriving does not reflow the page.
// -----------------------------------------------------------------------------

import font from '../../../assets/asteroids-display.otf?url';

const FAMILY = 'AsteroidsDisplay';

export interface Hud {
  /**
   * A full-screen message, resolving after `ms` — or, where that is zero, when
   * it is clicked. A click dismisses it either way, which is what makes the
   * title screen the gesture that also grants the audio and the pointer.
   *
   * Disposing resolves whatever is waiting, so nothing is left holding a
   * promise that will never settle. Whoever was waiting has to check that it
   * is still wanted — see `Game.dispose`.
   */
  say(text: string, ms: number, under?: string): Promise<void>

  /** The line naming what is within reach, or nothing. */
  note(text: string | null): void

  /** A line in the corner for whoever is looking into something, or nothing.
   * Never on unless it is asked for. */
  stat(text: string | null): void

  /** The end: black, and no way out of it. */
  black(): void

  /** Whether a message is up, which is the whole of being paused. */
  busy(): boolean

  dispose(): void
}

export function hud(host: HTMLElement): Hud {
  loaded();

  /** How to end the message that is up, if one is. Held so that disposing can
   * end it: a timeout and a click listener both outlive the element they were
   * put up for. */
  let waiting: (() => void) | null = null;

  const sheet = (el: HTMLElement, css: string): void => {
    el.style.cssText = css;
  };

  const screen = document.createElement('div');
  const line = document.createElement('div');
  const under = document.createElement('div');
  const near = document.createElement('div');
  const corner = document.createElement('div');

  sheet(screen, `
    position: absolute; inset: 0;
    display: none;
    flex-direction: column; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, 0.85);
    z-index: 10;
  `);

  sheet(line, `
    color: #fff; font-family: '${FAMILY}', monospace; font-size: 48px;
    text-align: center; letter-spacing: 8px; text-transform: uppercase;
  `);

  sheet(under, `
    color: #888; font-family: '${FAMILY}', monospace; font-size: 24px;
    text-align: center; letter-spacing: 4px; text-transform: uppercase;
    margin-top: 24px;
  `);

  sheet(near, `
    position: absolute; left: 0; right: 0; top: 50%;
    transform: translateY(-50%);
    color: #fff; font-family: '${FAMILY}', monospace; font-size: 24px;
    text-align: center; letter-spacing: 4px; text-transform: uppercase;
    z-index: 9; pointer-events: none;
    opacity: 0; transition: opacity 0.2s;
  `);

  sheet(corner, `
    position: absolute; left: 8px; top: 8px;
    color: #7f7; font: 11px ui-monospace, monospace; white-space: pre;
    z-index: 9; pointer-events: none; display: none;
  `);

  screen.append(line, under);
  host.append(near, corner, screen);

  return {
    say(text: string, ms: number, beneath = ''): Promise<void> {
      line.textContent = text;
      under.textContent = beneath;

      screen.style.display = 'flex';
      screen.style.background = 'rgba(0, 0, 0, 0.85)';

      return new Promise<void>(resolve => {
        let timer = 0;

        const over = (): void => {
          if (waiting === null) return;

          waiting = null;
          clearTimeout(timer);
          screen.style.display = 'none';
          document.removeEventListener('click', over);
          resolve();
        };

        // A second message over the first would leave the first's waiter
        // holding a promise nothing will settle. There is only ever one.
        waiting?.();
        waiting = over;

        // On the document rather than on the overlay: with the pointer locked
        // a click goes to the canvas, and a message nobody can dismiss is a
        // game nobody can start.
        document.addEventListener('click', over);

        if (ms > 0) timer = setTimeout(over, ms) as unknown as number;
      });
    },

    note(text: string | null): void {
      if (text !== null) near.textContent = text;

      near.style.opacity = text === null ? '0' : '1';
    },

    stat(text: string | null): void {
      corner.style.display = text === null ? 'none' : 'block';

      if (text !== null) corner.textContent = text;
    },

    black(): void {
      line.textContent = '';
      under.textContent = '';
      screen.style.display = 'flex';
      screen.style.background = '#000';
    },

    busy(): boolean {
      return screen.style.display !== 'none';
    },

    dispose(): void {
      waiting?.();
      screen.remove();
      near.remove();
      corner.remove();
    },
  };
}

/** The face, asked for once however many games are started. A second
 * declaration of the same family is not an error, only noise. */
let asked = false;

function loaded(): void {
  if (asked) return;

  asked = true;

  const style = document.createElement('style');

  style.textContent = `@font-face {
    font-family: '${FAMILY}';
    src: url('${font}') format('opentype');
  }`;

  document.head.append(style);
}
