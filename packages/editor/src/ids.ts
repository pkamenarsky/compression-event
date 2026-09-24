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
  | { kind: 'tooth', run: Ident, j: number }

const table: Made[] = [];
const written: string[] = [];
const keys: number[] = [];
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

/**
 * A tooth a pattern laid along an identified run, counted out from the run's
 * middle the way `patternRun` counts them.
 *
 * By its number and not by where it falls, which is the whole of PLAN-bevel's
 * *the tooth keeps its place*: the run's ends are free to move and its length
 * with them, and tooth `j` is still tooth `j`. A fraction along would slide
 * every one of them the moment a neighbour did anything.
 */
export function tooth(run: Ident, j: number): Ident {
  return intern(`${written[run]}#${j}`, { kind: 'tooth', run, j });
}

/**
 * A number to key a pattern by, the same for a given name in every run of the
 * program and different for names that differ.
 *
 * The handle will not do: it is an allocation order, so the noise on a wall
 * would depend on what else had been named before it. The name will, and this
 * is it hashed down to the integer `patternRun` wants.
 */
export function keyOf(id: Ident): number {
  const had = keys[id];

  if (had !== undefined) return had;

  const name = written[id];

  let h = 0x811c9dc5;

  for (let i = 0; i < name.length; i++) {
    h = Math.imul(h ^ name.charCodeAt(i), 0x01000193);
  }

  return (keys[id] = h | 0);
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

/**
 * A drawn polygon's own identities: its member, and a corner apiece.
 *
 * Of a walked shape, and that is not a formality — an arrangement is free to
 * start a ring where it likes, and naming the points of a shape that has not
 * been through one gives names that move when it does.
 */
export function identify(shape: Cut, member: number, was: readonly number[] | null = null): Ids {
  let vertex = 0;

  return shape.map(ring => ring.map(() => {
    const here = vertex++;
    const of = was === null ? -1 : was[here * 2];

    // A point a construction sampled rather than turned at: `on` the run
    // leaving corner `of`, at the same `t` it sat at before. Not the name the
    // point had when it was made — that named somebody this shape has no
    // memory of — but the same shape of name, which is all anything reading it
    // asks. See `Vertex.sample`.
    return of < 0 ? corner(member, here) : on(corner(member, of), was![here * 2 + 1]);
  }));
}

/**
 * A shape and a name for each of its points.
 *
 * A `Shape` and not a `Cut`: what an effect hands on is walked, but a band or
 * a fan an effect builds to combine against is not, and those carry names too.
 * Where it matters — `identify`, which numbers a ring's corners — it is asked
 * for outright.
 *
 * `edges` is there because a point and the edge leaving it are two different
 * questions, and for everything an arrangement hands back they have the same
 * answer — a walked ring's edge `i` runs from its vertex `i`. Only a shape
 * somebody constructed, the band of an offset being the one so far, has an
 * edge belonging to a corner other than the one it starts at. Left out, it is
 * the names.
 */
export interface Drawn {
  shape: Shape
  ids: Ids
  edges?: Ids
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
 * What comes back is walked, so its own edges leave its own points and it needs
 * no `edges` of its own.
 */
export function combineIdentified(
  a: Drawn,
  b: Drawn,
  op: Op,
  inert?: (ring: number, index: number) => boolean,
): Drawn {
  const tagged = combineTagged(a.shape, b.shape, op, undefined, inert);

  const at = (ref: SourceRef): Ident => {
    const got = (ref.shape === 0 ? a : b).ids[ref.ring]?.[ref.index];

    if (got === undefined) {
      throw new Error(`no identity for ${ref.shape}.${ref.ring}.${ref.index}`);
    }

    return got;
  };

  const leaving = (ref: SourceRef): Ident => {
    const it = ref.shape === 0 ? a : b;

    return it.edges === undefined ? at(ref) : it.edges[ref.ring][ref.index];
  };

  const named = (tag: Tag): Ident =>
    (tag.kind === 'vertex' ? at(tag.at) : born(leaving(tag.a), leaving(tag.b)));

  return {
    shape: tagged.rings as Cut,
    ids: tagged.tags.map(tags => tags.map(named)),
  };
}
