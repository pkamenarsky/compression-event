/**
 * Simple full-screen overlay UI for displaying text messages.
 */

let overlay: HTMLDivElement | null = null;
let textEl: HTMLDivElement | null = null;
let subtextEl: HTMLDivElement | null = null;
let descriptionEl: HTMLDivElement | null = null;

const FONT_FAMILY = "'AsteroidsDisplay', monospace";

function ensureOverlay(): void {
  if (overlay) return;

  overlay = document.createElement('div');
  overlay.id = 'game-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 0; left: 0; width: 100%; height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: rgba(0,0,0,0.85);
    z-index: 1000;
    pointer-events: auto;
    opacity: 1;
    transition: opacity 0.3s;
  `;

  textEl = document.createElement('div');
  textEl.style.cssText = `
    color: #ffffff;
    font-family: ${FONT_FAMILY};
    font-size: 48px;
    text-align: center;
    letter-spacing: 8px;
    text-transform: uppercase;
  `;

  subtextEl = document.createElement('div');
  subtextEl.style.cssText = `
    color: #888888;
    font-family: ${FONT_FAMILY};
    font-size: 24px;
    text-align: center;
    margin-top: 24px;
    letter-spacing: 4px;
    text-transform: uppercase;
  `;

  overlay.appendChild(textEl);
  overlay.appendChild(subtextEl);
  document.body.appendChild(overlay);
}

function ensureDescription(): void {
  if (descriptionEl) return;

  descriptionEl = document.createElement('div');
  descriptionEl.id = 'game-description';
  descriptionEl.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    color: #ffffff;
    font-family: ${FONT_FAMILY};
    font-size: 24px;
    text-align: center;
    letter-spacing: 4px;
    text-transform: uppercase;
    z-index: 999;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.2s;
  `;
  document.body.appendChild(descriptionEl);
}

/**
 * Show a full-screen overlay message. Returns a promise that resolves
 * after `durationMs` or when the user clicks, whichever comes first.
 */
export function showMessage(
  text: string,
  durationMs: number,
  subtext = ''
): Promise<void> {
  ensureOverlay();
  textEl!.textContent = text;
  subtextEl!.textContent = subtext;
  overlay!.style.display = 'flex';
  overlay!.style.opacity = '1';
  overlay!.style.background = 'rgba(0,0,0,0.85)';

  return new Promise<void>((resolve) => {
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      overlay!.style.display = 'none';
      overlay!.removeEventListener('click', onClick);
      document.removeEventListener('click', onClick);
      resolve();
    };

    const onClick = () => {
      done();
    };

    // Listen on both the overlay and document so clicks while
    // the pointer is locked (going to the canvas) still dismiss.
    overlay!.addEventListener('click', onClick);
    document.addEventListener('click', onClick);

    if (durationMs > 0) {
      setTimeout(() => {
        done();
      }, durationMs);
    }
  });
}

/**
 * Show a permanent black screen (end of game).
 */
export function showBlackScreen(): void {
  ensureOverlay();
  textEl!.textContent = '';
  subtextEl!.textContent = '';
  overlay!.style.display = 'flex';
  overlay!.style.opacity = '1';
  overlay!.style.background = '#000000';
}

/**
 * Show a description near the bottom of the screen.
 */
export function showDescription(text: string): void {
  ensureDescription();
  descriptionEl!.textContent = text;
  descriptionEl!.style.opacity = '1';
}

/**
 * Hide the description.
 */
export function hideDescription(): void {
  if (!descriptionEl) return;
  descriptionEl!.style.opacity = '0';
}

/**
 * Returns true if the overlay is currently visible (blocking gameplay).
 */
export function isOverlayVisible(): boolean {
  return overlay !== null && overlay.style.display !== 'none';
}
