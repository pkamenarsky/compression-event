import { Point } from '@ce/game/world';

/** What a remembered function may be asked about: plain geometry, which is
 * what makes its text a faithful name for it. */
export type Key = number | null | Point | readonly Key[];

/** How many answers a remembered function holds on to. */
const HELD = 1024;

/**
 * `f`, answering from memory whenever it is asked what it was asked recently.
 *
 * For the arrangements: a projection or a group's offset union is a pure
 * function of some geometry, and the editor asks for the same ones over and
 * over — every frame of a drag, and again for every ghost version on screen.
 * The arguments are fresh arrays every time, so identity is no answer and they
 * are keyed by content, which is one pass over the geometry against an
 * arrangement over it.
 *
 * Keyed by what is asked rather than by who asks, so there is no caller that
 * can forget to look: a new path to a projection goes through the same
 * function and finds the same answers. Held most recently used first and cut
 * at `HELD`, so what is kept is bounded by the size of a screenful and not by
 * the length of a session.
 *
 * What comes back is shared, and must not be written to.
 */
export function remembered<A extends Key[], R>(f: (...args: A) => R): (...args: A) => R {
  const held = new Map<string, R>();

  return (...args) => {
    const key = JSON.stringify(args);
    const known = held.get(key);

    if (known !== undefined) {
      held.delete(key);
      held.set(key, known);

      return known;
    }

    const out = f(...args);

    held.set(key, out);
    if (held.size > HELD) held.delete(held.keys().next().value!);

    return out;
  };
}
