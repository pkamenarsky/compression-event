// -----------------------------------------------------------------------------
// How a version transition is played
//
// Not what it *is*: the geometry is exact at every instant of a span, and this
// only chooses which instants get looked at. See *Easing is a runtime concern*
// in `docs/versioning.md`.
//
// Here rather than in the editor because both sides play the same transition
// and it should look the same in both. The editor is watching a level compress
// and the game is standing in it, but it is one motion and it has one clock.
// -----------------------------------------------------------------------------

/** How long one span takes to play, in milliseconds. Slow enough to watch a
 * room pinch in two. */
export const REPLAY_MS = 400;

/** A curve through a walk: 0 to 1, both ends pinned. */
export type Easing = (t: number) => number;

/**
 * The curves a version switch can be played on.
 *
 * Applied to the position as it is written rather than by whoever reads it, so
 * that everything looking at one walk stays on one clock — the editor's canvas
 * draws the outline the walk passes through and its 3D view flies the same
 * instant into the shader, and a curve applied twice or applied in one place
 * only would pull them apart.
 *
 * Every one of them has to pin both ends: the walk is over when the position
 * reaches 1, and a curve that arrived early or late would either cut the last
 * frames off or leave the geometry short of the version it is supposed to have
 * landed on.
 */
export const EASINGS = {
  linear: t => t,

  /** Cubic. Leaves at speed and settles, which is what a switch between two
   * arrangements wants: the change reads immediately and the arrival is soft. */
  out: t => 1 - (1 - t) ** 3,

  in: t => t ** 3,
  inOut: t => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
} satisfies Record<string, Easing>;

export type Ease = keyof typeof EASINGS;

/** Which curve a version switch plays on. */
export const REPLAY_EASE: Ease = 'out';
