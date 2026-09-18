// -----------------------------------------------------------------------------
// The screen distances
//
// What the loop and the drawing both measure to, and so the one thing under
// `canvas/` that both read. It is small on purpose: it exists so that
// `draw.ts` never has to reach back into the loop for a number, which would
// put a cycle through the two biggest files here.
// -----------------------------------------------------------------------------

/** Screen pixels within which a vertex is grabbable, or the first point closes. */
export const HANDLE = 9;

/**
 * Screen pixels the pointer may wander between going down and coming up while
 * the press still counts as a click rather than a drag. See `pointerDragged`.
 */
export const SLOP = 3;

/**
 * How long after a click another one in the same place is the second half of a
 * double-click. The platform's own interval, which is not readable from a page
 * — 500ms is the Mac default and 350 is what most editors settle on, being
 * short enough that two deliberate clicks on the same room are still two.
 *
 * Timed here rather than read off the event, because a pointer event does not
 * carry a click count: `detail` is the click count on `mousedown` and zero on
 * `pointerdown`, and this loop is built on pointer events so that a press,
 * a drag and a release are one story.
 */
export const DOUBLE_MS = 350;

/** Takes the picked corners out, or the picked polygons under the other tool. */
export const REMOVE = ['Backspace', 'Delete'];
