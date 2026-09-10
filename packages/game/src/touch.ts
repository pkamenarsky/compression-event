// -----------------------------------------------------------------------------
// Two thumbs
//
// On a phone there is no keyboard and no pointer to lock, so the screen is cut
// down the middle the way every touch shooter cuts it: the left thumb walks and
// strafes, the right one looks.
//
// The left is a stick that is wherever the thumb came down rather than a fixed
// one drawn in a corner. A thumb does not land where it is told to, and a stick
// it has to find first is a stick it misses. How far it is dragged from there,
// up to `REACH`, is how hard the player walks; further than that walks no
// harder, and the ring follows the thumb so that coming back is immediate.
//
// The right is a drag: however far it moves across is how far the view turns,
// the way the mouse does it, with nothing to hold.
//
// Pointer events rather than touch events, and `touch-action: none` on the host
// rather than a `preventDefault` on every touch — which would also swallow the
// click the title screen waits for.
// -----------------------------------------------------------------------------

/** How far the left thumb goes, in CSS pixels, to walk flat out. */
const REACH = 56;

/** Turn per CSS pixel of right thumb. Slower than the mouse's pixel is, since a
 * thumb covers more of them to mean the same thing. */
const LOOK = 0.006;

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
  /** How hard the left thumb is asking to walk, -1 to 1 each way: `ahead`
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

      out.across = dx / REACH;
      out.ahead = -dy / REACH;
    }
    else if (looking !== null && e.pointerId === looking.id) {
      turned((at.x - looking.x) * LOOK);
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

  host.addEventListener('pointerdown', down);
  window.addEventListener('pointermove', moved);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);

  function dispose(): void {
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
