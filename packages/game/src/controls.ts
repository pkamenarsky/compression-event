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

// ── Turning, whatever it is driven by ──

/**
 * How long the view takes to catch up with a turn asked for, in seconds: the
 * time constant it closes the gap on, so about two thirds of a flick lands in
 * this and nearly all of it in three times this.
 *
 * Only the turn. It takes the jitter out of a mouse's or a thumb's steps
 * without changing how far they go; the walk already eases on `GRIP` and
 * `DRAG`. Nought turns it off.
 */
export const TURN_SMOOTH = 0.04;

// ── Keyboard and mouse ──

/** Turn per pixel of mouse, in radians. */
export const MOUSE_LOOK = 0.002;

// ── Two thumbs ──

/** How far the left thumb can take the stick from where it came down, in CSS
 * pixels. Past this the ring follows the thumb. */
export const STICK_REACH = 56;

/**
 * How far forward or back the left thumb has to go before it walks that way,
 * as a share of `STICK_REACH`.
 *
 * Forward and back are keys rather than a throttle: past this walks full speed,
 * short of it does not walk at all. The sideways has no such line — it strafes
 * as fast as the thumb is far to the side, all the way to `STICK_REACH`.
 */
export const STICK_DEAD = 0.35;

/** How close together, in milliseconds, three clicks or taps have to come —
 * each within this of the one before — to restart the level. Anywhere on the
 * screen, with a mouse or a finger. */
export const RESTART_GAP = 400;

/** How far, in CSS pixels, a press may travel between going down and coming
 * up and still count as a tap towards that. A thumb that walks or looks is
 * never one. */
export const TAP_SLOP = 10;

/** Turn per CSS pixel of right thumb, in radians. Well above the mouse's: a
 * thumb covers a phone's width in a few centimetres, and one swipe across it
 * should be a good way round. */
export const TOUCH_LOOK = 0.008;
