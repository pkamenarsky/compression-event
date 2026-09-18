// -----------------------------------------------------------------------------
// What a gesture leaves on screen while it runs
//
// The half-finished state a gesture keeps — a marquee, a polygon being drawn,
// a walk being laid — which the loop writes and the drawing reads. Its own
// file for that reason: both sides need the shapes, and neither should have
// to read the other to get them.
// -----------------------------------------------------------------------------

import { effect } from '@incpt/kontinuum-dom';

import { Ring } from '../geometry';
import { under, runs } from '../scene';
import { OnPath } from '../paths';
import { PathId, Point } from '../types';

// -----------------------------------------------------------------------------

/** In world units, so it stays over what it was drawn over. */
export interface Marquee {
  a: Point
  b: Point
}

/** The points laid down so far, and where the rubber band currently ends. */
export interface Draft {
  points: Point[]
  at: Point
}

/**
 * A shape being dragged out, and what it currently comes to.
 *
 * The label is not decoration. Both of these gestures read something off an
 * axis that has nothing on it to read against — how many sides, how far across
 * — and a number by the cursor is the whole of what says which of them the
 * hand is moving.
 */
export interface Forming {
  ring: Ring
  label: string
}

/**
 * A measuring path being laid down.
 *
 * `id` is the path it will be written back to, which is null for a new one and
 * set when an existing one is being carried on with — resuming is the same
 * gesture, started from the points that are already there.
 */
export interface Walk {
  id: PathId | null
  points: Point[]
  at: Point
}

export interface Local {
  marquee: Marquee | null
  draft: Draft | null
  /** The open measuring path, if one is being laid down. */
  laying: Walk | null
  /** The rectangle or n-gon under the cursor mid-drag, before it is committed.
   * A ring rather than a shape: what is being drawn is one outline. */
  forming: Forming | null
  /** The picked point of a committed path, which is what Backspace takes. Not
   * in the document's selection: a path is not part of the level, and nothing
   * else in the editor has anything to say about one. */
  onPath: OnPath | null
  /** What an amount gesture has come to, said by the cursor: the reading of
   * an axis with nothing on it to read against. */
  reading: { at: Point, label: string } | null
  /**
   * A gesture is running, so the versions downstream of this one are drawn
   * whatever their eyes say.
   *
   * This is load-bearing rather than a nicety: it is the entire mechanism by
   * which an edit made at v0 can be judged against its effect at v4, and it is
   * what makes dropping backward propagation affordable.
   */
  previewing: boolean
}

export const EMPTY_LOCAL: Local = {
  marquee: null,
  draft: null,
  laying: null,
  forming: null,
  onPath: null,
  reading: null,
  previewing: false,
};

