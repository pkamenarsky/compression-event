// -----------------------------------------------------------------------------
// Two thumbs
//
// On a phone there is no keyboard and no pointer to lock, so the screen is cut
// down the middle the way every touch shooter cuts it: the left thumb walks and
// strafes, the right one looks.
//
// The left is a stick that is wherever the thumb came down rather than a fixed
// one drawn in a corner. A thumb does not land where it is told to, and a stick
// it has to find first is a stick it misses. It is four keys rather than a
// throttle: far enough along an axis walks full speed that way — see
// `STICK_DEAD` — and the ring follows the thumb past its edge so that coming
// back is immediate.
//
// The right is a drag: however far it moves across is how far the view turns,
// the way the mouse does it, with nothing to hold.
//
// Pointer events rather than touch events, with `touch-action: none` on the
// host. The touches themselves are cancelled as well, for iOS's sake — see
// `refused` below.
// -----------------------------------------------------------------------------

import { STICK_DEAD, STICK_REACH as REACH, TOUCH_LOOK } from './controls';

/**
 * Whether this is something held rather than something sat at.
 *
 * The pointer a device answers to first, and that it can be touched at all:
 * a laptop with a touchscreen is still coarse on neither count, and a phone
 * asking for a desktop page still has fingers.
 */
export function handheld(): boolean {
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;

  return coarse && navigator.maxTouchPoints > 0;
}

export interface Thumbs {
  /** Which way the left thumb is asking to walk, -1, 0 or 1 each way: `ahead`
   * forward, `across` to the right. Nought where it is not down. */
  ahead: number
  across: number
  dispose(): void
}

/**
 * The two thumbs over `host`.
 *
 * `turned` is told how far to turn as the right thumb goes, in radians, so the
 * view moves in the event rather than a frame after it.
 */
export function thumbs(host: HTMLElement, turned: (by: number) => void): Thumbs {
  const out: Thumbs = { ahead: 0, across: 0, dispose };

  const ring = document.createElement('div');
  const knob = document.createElement('div');

  ring.style.cssText = `
    position: absolute; width: ${REACH * 2}px; height: ${REACH * 2}px;
    margin: -${REACH}px 0 0 -${REACH}px; border-radius: 50%;
    border: 1px solid rgba(255, 255, 255, 0.25); pointer-events: none;
    z-index: 8; display: none;
  `;
  knob.style.cssText = `
    position: absolute; width: 36px; height: 36px; margin: -18px 0 0 -18px;
    border-radius: 50%; background: rgba(255, 255, 255, 0.2);
    pointer-events: none; z-index: 8; display: none;
  `;

  host.append(ring, knob);

  const wasAction = host.style.touchAction;
  host.style.touchAction = 'none';

  /** The walking thumb, and where its stick is centred. */
  let walking: { id: number, x: number, y: number } | null = null;

  /** The looking thumb, and where it was last. */
  let looking: { id: number, x: number } | null = null;

  const placed = (el: HTMLElement, x: number, y: number): void => {
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  };

  const local = (e: PointerEvent): { x: number, y: number } => {
    const box = host.getBoundingClientRect();

    return { x: e.clientX - box.left, y: e.clientY - box.top };
  };

  const down = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse') return;

    const at = local(e);

    if (at.x < host.clientWidth / 2) {
      if (walking !== null) return;

      walking = { id: e.pointerId, ...at };

      placed(ring, at.x, at.y);
      placed(knob, at.x, at.y);
      ring.style.display = knob.style.display = 'block';
    }
    else {
      if (looking !== null) return;

      looking = { id: e.pointerId, x: at.x };
    }
  };

  const moved = (e: PointerEvent): void => {
    const at = local(e);

    if (walking !== null && e.pointerId === walking.id) {
      let dx = at.x - walking.x, dy = at.y - walking.y;
      const l = Math.hypot(dx, dy);

      // Past the edge the ring comes along, so the stick is always just
      // behind the thumb and never a long way back to neutral.
      if (l > REACH) {
        walking.x += dx * (1 - REACH / l);
        walking.y += dy * (1 - REACH / l);
        dx = at.x - walking.x;
        dy = at.y - walking.y;

        placed(ring, walking.x, walking.y);
      }

      placed(knob, at.x, at.y);

      const dead = STICK_DEAD * REACH;

      out.across = Math.abs(dx) > dead ? Math.sign(dx) : 0;
      out.ahead = Math.abs(dy) > dead ? -Math.sign(dy) : 0;
    }
    else if (looking !== null && e.pointerId === looking.id) {
      turned((at.x - looking.x) * TOUCH_LOOK);
      looking.x = at.x;
    }
  };

  const up = (e: PointerEvent): void => {
    if (walking !== null && e.pointerId === walking.id) {
      walking = null;
      out.ahead = out.across = 0;
      ring.style.display = knob.style.display = 'none';
    }

    if (looking !== null && e.pointerId === looking.id) looking = null;
  };

  // A held thumb is a long press to the browser, which answers with a menu, a
  // selection or — on iOS, whatever the CSS says — the magnifying loupe. Only
  // cancelling the touch itself stops that last one. Pointer events still
  // arrive after it; the click does not, which is why the title screen also
  // takes a finger lifting. See `say` in `hud.ts`.
  const refused = (e: Event): void => e.preventDefault();
  const active = { passive: false };

  host.addEventListener('contextmenu', refused);
  host.addEventListener('selectstart', refused);
  host.addEventListener('touchstart', refused, active);
  host.addEventListener('touchmove', refused, active);
  host.addEventListener('pointerdown', down);
  window.addEventListener('pointermove', moved);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);

  function dispose(): void {
    host.removeEventListener('contextmenu', refused);
    host.removeEventListener('selectstart', refused);
    host.removeEventListener('touchstart', refused);
    host.removeEventListener('touchmove', refused);
    host.removeEventListener('pointerdown', down);
    window.removeEventListener('pointermove', moved);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);

    host.style.touchAction = wasAction;
    ring.remove();
    knob.remove();
  }

  return out;
}
