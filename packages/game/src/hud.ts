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
   */
  say(text: string, ms: number, under?: string): Promise<void>

  /** The line naming what is within reach, or nothing. */
  note(text: string | null): void

  /** The end: black, and no way out of it. */
  black(): void

  /** Whether a message is up, which is the whole of being paused. */
  busy(): boolean

  dispose(): void
}

export function hud(host: HTMLElement): Hud {
  loaded();

  const sheet = (el: HTMLElement, css: string): void => {
    el.style.cssText = css;
  };

  const screen = document.createElement('div');
  const line = document.createElement('div');
  const under = document.createElement('div');
  const near = document.createElement('div');

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

  screen.append(line, under);
  host.append(near, screen);

  return {
    say(text: string, ms: number, beneath = ''): Promise<void> {
      line.textContent = text;
      under.textContent = beneath;

      screen.style.display = 'flex';
      screen.style.background = 'rgba(0, 0, 0, 0.85)';

      return new Promise<void>(resolve => {
        let done = false;

        const over = (): void => {
          if (done) return;

          done = true;
          screen.style.display = 'none';
          document.removeEventListener('click', over);
          resolve();
        };

        // On the document rather than on the overlay: with the pointer locked
        // a click goes to the canvas, and a message nobody can dismiss is a
        // game nobody can start.
        document.addEventListener('click', over);

        if (ms > 0) setTimeout(over, ms);
      });
    },

    note(text: string | null): void {
      if (text !== null) near.textContent = text;

      near.style.opacity = text === null ? '0' : '1';
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
      screen.remove();
      near.remove();
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
