// -----------------------------------------------------------------------------
// Two thumbs
//
// On a phone there is no keyboard and no pointer to lock, so the screen is cut
// down the middle the way every touch shooter cuts it: the left thumb walks and
// strafes, the right one looks.
//
// The left is a stick that is wherever the thumb came down rather than a fixed
// one drawn in a corner. A thumb does not land where it is told to, and a stick
// it has to find first is a stick it misses. Forward and back are keys — far
// enough walks full speed, see `STICK_DEAD` — and the sideways is a throttle,
// strafing as fast as the thumb is far to the side. The ring follows the thumb
// past its edge so that coming back is immediate.
//
// The right is a drag: however far it moves across is how far the view turns,
// the way the mouse does it. It is drawn the same as the left, ring and knob,
// so a thumb can see where it is on either side.
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
  /** Which way the left thumb is asking to walk: `ahead` forward, -1, 0 or 1,
   * and `across` to the right, anywhere from -1 to 1. Nought where it is not
   * down. */
  ahead: number
  across: number
  /** Let go of both thumbs, as if they had been lifted. */
  reset(): void
  dispose(): void
}

/**
 * The two thumbs over `host`.
 *
 * `turned` is told how far to turn as the right thumb goes, in radians, so the
 * view moves in the event rather than a frame after it.
 */
export function thumbs(host: HTMLElement, turned: (by: number) => void): Thumbs {
  const out: Thumbs = { ahead: 0, across: 0, reset, dispose };

  const left = drawn(host), right = drawn(host);

  const wasAction = host.style.touchAction;
  host.style.touchAction = 'none';

  /** The walking thumb, and where its stick is centred. */
  let walking: { id: number, x: number, y: number } | null = null;

  /** The looking thumb, where it was last, and where its ring is centred —
   * which is only drawn, since looking is a drag and has no centre to it. */
  let looking: { id: number, x: number, cx: number, cy: number } | null = null;

  const local = (e: PointerEvent): { x: number, y: number } => {
    const box = host.getBoundingClientRect();

    return { x: e.clientX - box.left, y: e.clientY - box.top };
  };

  const down = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse') return;

    const at = local(e);

    // A new thumb on a side takes it over from whatever was there. The one
    // before should have lifted first, but a lift can go missing — a quick
    // run of taps is enough for iOS to lose one — and a side that waited
    // for it would be dead until the next restart happened to clear it.
    if (at.x < host.clientWidth / 2) {
      walking = { id: e.pointerId, ...at };
      left.shown(at.x, at.y);
    }
    else {
      looking = { id: e.pointerId, x: at.x, cx: at.x, cy: at.y };
      right.shown(at.x, at.y);
    }
  };

  const moved = (e: PointerEvent): void => {
    const at = local(e);

    if (walking !== null && e.pointerId === walking.id) {
      const c = left.moved(walking.x, walking.y, at.x, at.y);

      walking.x = c.x;
      walking.y = c.y;

      const dx = at.x - c.x, dy = at.y - c.y;

      // Across is a throttle and ahead is a key: how far to the side is how
      // fast to strafe, and forward is full speed or nothing. See
      // `STICK_DEAD`.
      out.across = dx / REACH;
      out.ahead = Math.abs(dy) > STICK_DEAD * REACH ? -Math.sign(dy) : 0;
    }
    else if (looking !== null && e.pointerId === looking.id) {
      turned((at.x - looking.x) * TOUCH_LOOK);
      looking.x = at.x;

      const c = right.moved(looking.cx, looking.cy, at.x, at.y);

      looking.cx = c.x;
      looking.cy = c.y;
    }
  };

  const lifted = (): void => {
    walking = null;
    out.ahead = out.across = 0;
    left.hidden();
  };

  const unlooked = (): void => {
    looking = null;
    right.hidden();
  };

  const up = (e: PointerEvent): void => {
    if (walking !== null && e.pointerId === walking.id) lifted();
    if (looking !== null && e.pointerId === looking.id) unlooked();
  };

  /** No finger left on the glass at all: whatever either side thought it was
   * holding, it is not. The same missing lift, caught from the other end. */
  const bare = (e: TouchEvent): void => {
    if (e.touches.length === 0) reset();
  };

  function reset(): void {
    lifted();
    unlooked();
  }

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
  window.addEventListener('touchend', bare);
  window.addEventListener('touchcancel', bare);
  host.addEventListener('pointerdown', down);
  window.addEventListener('pointermove', moved);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);

  function dispose(): void {
    host.removeEventListener('contextmenu', refused);
    host.removeEventListener('selectstart', refused);
    host.removeEventListener('touchstart', refused);
    host.removeEventListener('touchmove', refused);
    window.removeEventListener('touchend', bare);
    window.removeEventListener('touchcancel', bare);
    host.removeEventListener('pointerdown', down);
    window.removeEventListener('pointermove', moved);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);

    host.style.touchAction = wasAction;
    left.dispose();
    right.dispose();
  }

  return out;
}

/** One thumb's ring and knob: where it came down, and where it is. */
interface Drawn {
  shown(x: number, y: number): void
  /** The knob to the thumb, and the ring after it where the thumb has gone
   * past its edge — so it is always just behind, and never a long way back
   * to neutral. Says where the ring is centred now. */
  moved(cx: number, cy: number, x: number, y: number): { x: number, y: number }
  hidden(): void
  dispose(): void
}

function drawn(host: HTMLElement): Drawn {
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

  const placed = (el: HTMLElement, x: number, y: number): void => {
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  };

  return {
    shown(x, y) {
      placed(ring, x, y);
      placed(knob, x, y);
      ring.style.display = knob.style.display = 'block';
    },

    moved(cx, cy, x, y) {
      const dx = x - cx, dy = y - cy;
      const l = Math.hypot(dx, dy);

      if (l > REACH) {
        cx += dx * (1 - REACH / l);
        cy += dy * (1 - REACH / l);
        placed(ring, cx, cy);
      }

      placed(knob, x, y);

      return { x: cx, y: cy };
    },

    hidden() {
      ring.style.display = knob.style.display = 'none';
    },

    dispose() {
      ring.remove();
      knob.remove();
    },
  };
}
