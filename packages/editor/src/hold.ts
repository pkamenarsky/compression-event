/**
 * Whether the arrangements now running keep the points a construction laid
 * that do not turn. A leaf, read by `memo.ts` and `ids.ts` and reading
 * neither.
 *
 * An arrangement drops every point it does not turn at (`cornersOnly`), and
 * for a still that is right. The bake needs a ring as long at both ends of a
 * span as in the middle of it, and the points that lie flat at an end — an
 * arc's samples on a coarser facet, a tooth at nought, a corner arriving —
 * are exactly the ones dropped. So while it folds an instant it asks for them
 * held, by name: everything but a crossing, which is a corner by
 * construction. See `combineIdentified`.
 *
 * A dynamic scope rather than an argument, because it has to reach every
 * arrangement of every effect of every fold under the call; and part of every
 * remembered key, so that a held answer is never handed to a caller that did
 * not ask for one.
 */
let on = false;

export function holding(): boolean {
  return on;
}

export function held<T>(f: () => T): T {
  const was = on;

  on = true;

  try {
    return f();
  }
  finally {
    on = was;
  }
}
