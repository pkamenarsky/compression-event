// -----------------------------------------------------------------------------
// How the player is moved
//
// Every number that decides how walking and looking feel, on either kind of
// device, in one place so they can be tuned against one another. The code that
// reads them is in `play.ts` (the keyboard and the mouse, and the speed both
// kinds of walking chase) and `touch.ts` (the two thumbs).
// -----------------------------------------------------------------------------

// ── Walking, whatever it is driven by ──

/** How fast the player would go with nothing in the way, in world units per
 * second. Every direction walks at this, a diagonal included. */
export const WALK_SPEED = 10;

/** How sharply that speed is reached, and lost again once nothing asks for
 * it. Both per second, and exponential — see `urged`. */
export const GRIP = 30;
export const DRAG = 8;

// ── Keyboard and mouse ──

/** Turn per pixel of mouse, in radians. */
export const MOUSE_LOOK = 0.002;

// ── Two thumbs ──

/** How far the left thumb can take the stick from where it came down, in CSS
 * pixels. Past this the ring follows the thumb. */
export const STICK_REACH = 56;

/**
 * How far along one axis the left thumb has to go before it walks that way, as
 * a share of `STICK_REACH`.
 *
 * The stick is four keys rather than a throttle: past this on an axis walks
 * full speed along it, short of it does not walk along it at all. So a thumb
 * pushing forward with a little drift to one side walks straight.
 */
export const STICK_DEAD = 0.35;

/** Turn per CSS pixel of right thumb, in radians. Well above the mouse's: a
 * thumb covers a phone's width in a few centimetres, and one swipe across it
 * should be a good way round. */
export const TOUCH_LOOK = 0.012;
