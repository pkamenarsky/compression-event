// -----------------------------------------------------------------------------
// Identity
//
// What a point of a shape *is*, as against where it is. An effect is a map from
// a shape to a shape and points are born and die under it, so the only thing
// that can follow a corner from one instant to the next — through a round,
// through a group's union, through an erosion that closed the notch it sat in —
// is a name the construction gave it.
//
// The rule that makes it worth anything: **identity comes from the
// construction, never from a match.** Nothing here reads a coordinate. A point
// the arrangement emits is either an input vertex, and then it is that vertex,
// or a crossing, and then it is the pair of edges that made it — and the same
// crossing arrived at from geometry that has moved a long way is the same pair
// and so the same identity. A tolerance match is what puts a vertical in the
// bake at a threshold in a classification rather than at a real event, and
// there is none of one here.
//
// They nest, which is the point: `born(corner(3, 1), corner(4, 2))` is where a
// wall of one room crosses a wall of another, and it is as good a thing to be
// crossed, rounded or deformed as a drawn corner is.
//
// They are interned, so that comparing two identities is comparing two numbers.
// The bake does a great many of those, and it does them in the inner loop. The
// table only grows — a world of a given arrangement has a bounded set of
// identities and the same names come back interned to the same handles on every
// instant of a span, which is what makes the growth bounded in practice rather
// than per frame.
//
// The handles themselves are an allocation order and nothing else: they are
// stable within a run and mean nothing across two. Anything written down —
// a test, an error, a file — says `shows`, which renders the structure. So the
// key a name is interned under is that rendering, and an identity keeps it:
// `shows` is then a lookup, and the one place an order over identities is
// needed — which way round a crossing is written — has a structural one to
// hand rather than an allocation order that would differ run to run.
// -----------------------------------------------------------------------------

import type { Cut, Op, Shape, SourceRef, Tag } from './geometry';
import { combineTagged } from './geometry';

declare const ident: unique symbol;

/** An identity: an index into the intern table, compared with `===`. */
export type Ident = number & { readonly [ident]: true };

/** A shape's identities, one per point: `ids[r][i]` names `shape[r][i]`. */
export type Ids = Ident[][];

/** What an identity is made of. */
export type Made =
  | { kind: 'corner', member: number, vertex: number }
  | { kind: 'born', a: Ident, b: Ident }
  | { kind: 'on', edge: Ident, t: number }

const table: Made[] = [];
const written: string[] = [];
const handles = new Map<string, Ident>();

function intern(key: string, what: Made): Ident {
  const had = handles.get(key);

  if (had !== undefined) return had;

  const made = table.length as Ident;

  table.push(what);
  written.push(key);
  handles.set(key, made);

  return made;
}

/**
 * A corner of a drawn polygon: which member of the world it belongs to, and
 * which of its points.
 *
 * The numbering runs across the whole shape rather than per ring, so a polygon
 * with a hole in it has one series and no two of its corners collide.
 */
export function corner(member: number, vertex: number): Ident {
  return intern(`${member}.${vertex}`, { kind: 'corner', member, vertex });
}

/**
 * Where two identified pieces cross. Symmetric — a crossing does not know which
 * of the two operands the arrangement happened to read first — and so ordered
 * before it is interned.
 */
export function born(a: Ident, b: Ident): Ident {
  const first = written[a] <= written[b];
  const x = first ? a : b, y = first ? b : a;

  return intern(`(${written[x]}×${written[y]})`, { kind: 'born', a: x, b: y });
}

/**
 * A point the construction put along an identified edge, `t` of the way along
 * it. This is what the resample and the deform's teeth are named by: an edge
 * and an offset, rather than a position that the next effect would have to
 * find again.
 */
export function on(edge: Ident, t: number): Ident {
  return intern(`${written[edge]}@${t}`, { kind: 'on', edge, t });
}

/** What an identity was made of, one level down. */
export function madeOf(id: Ident): Made {
  return table[id];
}

/** An identity written out in full, for a test or an error. The handles mean
 * nothing across two runs and this means the same thing in every one. */
export function shows(id: Ident): string {
  return written[id];
}

/** A drawn polygon's own identities: its member, and a corner apiece. */
export function identify(shape: Shape, member: number): Ids {
  let vertex = 0;

  return shape.map(ring => ring.map(() => corner(member, vertex++)));
}

/**
 * `combine`, carrying identity through the arrangement — which is Law 2 of
 * `PLAN-effect` at the level it actually lives at.
 *
 * Every point a boolean operation emits is either an input vertex or a
 * crossing, and `combineTagged` already says which and names the input it came
 * of. All this does is read those names as identities: a vertex keeps the one
 * it arrived with, and a crossing is `born` of the two edges that made it.
 *
 * An edge is named by the point it leaves, edges and vertices sharing a
 * numbering throughout the arrangement.
 */
export function combineIdentified(
  a: Shape,
  ai: Ids,
  b: Shape,
  bi: Ids,
  op: Op,
): { shape: Cut, ids: Ids } {
  const tagged = combineTagged(a, b, op);

  const of = (ref: SourceRef): Ident => {
    const got = (ref.shape === 0 ? ai : bi)[ref.ring]?.[ref.index];

    if (got === undefined) {
      throw new Error(`no identity for ${ref.shape}.${ref.ring}.${ref.index}`);
    }

    return got;
  };

  const named = (tag: Tag): Ident =>
    (tag.kind === 'vertex' ? of(tag.at) : born(of(tag.a), of(tag.b)));

  return {
    shape: tagged.rings as Cut,
    ids: tagged.tags.map(tags => tags.map(named)),
  };
}
