// -----------------------------------------------------------------------------
// Reading the result
//
// What the world at a keyframe turns into once it has been resolved: what the
// CSG is handed, what comes back out of it, and what a click on the result
// finds. `core.ts` is what the world *is* at a keyframe; this is what it
// looks like, and the arrow only goes that way — this file reads the core and
// the core does not read it.
//
// `painted` and `middleOf` are at the end for that reason. Where a thing's
// middle is depends on what it is drawn as, which is `outlining` and so is
// this side of the cut; the `Painted` record they fill in is a plain shape
// and stays in the core with the operations that are written against it.
// -----------------------------------------------------------------------------

import { Point } from '@ce/game/world';
import {
  along,
  Facets,
  SQUARE,
  Fade,
  arcRuns,
  facetFades,
  facetsOf,
  Shape,
  contains,
  effected as effectedAll,
  effectedSquare,
  Effecting,
  encloses,
  foldShaped,
  erode,
  keeping,
  mitred,
  nextOf,
  prevOf,
  onBoundary,
  simplify,
  sliced,
  intersect,
  subtract,
  unionAll,
} from '../geometry';
import {
  GroupId,
  Id,
  PARTS,
  SETS,
  SLOT_KINDS,
  SLOT_PARTS,
  SLOTS,
  PolygonId,
  PolygonKind,
  SetName,
  KeyframeId,
  VertexId,
  World,
  enclosing,
  clickable,
  inside,
  kindOf,
  kindKey,
  opened,
  parentOf,
  inverted,
  sameKind,
  slotOf,
  standing,
  voidOnly,
  within,
} from '../types';
import {
  Edit as SetEdit,
  WorldSet,
  edited,
  emptyWorldSet,
  outline,
  pieces,
} from '../worldset';
import { remembered } from '../memo';
import { Affine, IDENTITY, place, unplace } from '../affine';
import { once, placed, stateAt, worldFrame } from '../rig';

import {
  facetKey,
  groupDeform,
  erodedOf,
  movedIn,
  namesOf,
  Named,
  PATTERNS,
  SIDES as DEFORM_SIDES,
  Painted,
  Resolved,
  artefactsIn,
  chain,
  eroding,
  imagesOf,
  middle,
  optionOf,
  pathAt,
  pathsIn,
  placeAt,
  polygonsIn,
  reaching,
  resolveAt,
  scaleAt,
  scaledState,
  segmentsOf,
  standingIn,
  under,
  unrounded,
} from './core';

// -----------------------------------------------------------------------------

/**
 * What the CSG is actually handed: a polygon, or the projection an eroding
 * group takes over what its members produced.
 *
 * Separate from `Resolved` because a group has none of what a `Resolved`
 * is — no source ring, no corners, nothing to put a handle on. What it has is
 * a shape, which is all this end of the pipe ever wanted.
 */
export interface Contributed {
  id: Id
  /** Which set it goes into, and which way. A group contributes one of these
   * per side it has anything on. */
  kind: PolygonKind
  shape: Shape
  /**
   * The frame the shape is placed by, which is what the bake keeps its points
   * in so that a turn is a turn rather than a chord.
   *
   * The identity for a group. Its members' frames already carry its own —
   * that is what `worldFrame` does — so the union comes out in world units
   * with the motion in it, and a group that applied its own frame again would
   * apply it twice.
   */
  frame: Affine
  /** Whether the shape is already an arrangement and `simplify` may be
   * skipped. A projection is one by construction. */
  simple: boolean
  /** The bake's invented corners, carried through the arrangement. A group's
   * union has none: nothing invents a corner on it. See `Resolved.keep`. */
  keep?: readonly (Point | Fade)[]
  /** A group's arc points on their facets part way through a span, with how
   * solid each stands. See `facetFades`. */
  faded?: readonly Fade[]
}

/**
 * Every group's depth as keyframe `v` leaves it: what its erosions add up to.
 *
 * A group that is not there at `v` has no depth, whatever was written about it
 * before it was taken out. Nothing reaches its members either — they went with
 * it — so this is about the ghost rather than about the geometry, and a ghost
 * with a depth is one more thing for a reader to have to rule out.
 */
export function depths(world: World, v: KeyframeId): Map<Id, number> {
  const from = new Set(chain(world, v));
  const out = new Map<Id, number>();

  for (const id of world.groups.keys()) {
    if (!standingIn(world, id, from)) continue;

    const d = eroding(world, id) ? scaledState(world, id, v).erosion : 0;

    if (d !== 0) out.set(id, d);
  }

  return out;
}

/** A group's round and deform as keyframe `v` leaves them. Nothing where it
 * has neither. */
export function groupEffects(world: World, v: KeyframeId, id: GroupId): Standing['effects'] {
  const round = optionOf(world.effects.get(id), 'round');
  const state = scaledState(world, id, v), scale = scaleAt(world, id, v);
  const deform = groupDeform(world, id, state.amplitude, scale);

  if (round === undefined && deform === null) return undefined;

  return {
    facets: round === undefined ? SQUARE : facetsOf(segmentsOf(round, state.bevel, scale), round.tension),
    bevel: round === undefined ? 0 : state.bevel,
    ...(deform === null ? {} : { deform }),
  };
}

/**
 * The resolved polygons as the CSG should see them: a group with a depth on it
 * standing in for its members, and everything else passed straight through.
 *
 * A group erodes **as if it were one polygon** — union the members, offset that
 * boundary inward — rather than each member being offset on its own. Two
 * rectangles making a corridor, each eroded by `d`, both pull back lengthwise
 * at the join and the corridor breaks in two; eroding the union pulls back only
 * the outer boundary and the corridor stays put. The author cannot see the seam
 * that failed, because it is interior geometry behind a wall that still looks
 * right, which is what makes it unacceptable rather than approximate.
 *
 * A group at depth zero contributes nothing of its own and hands its members
 * over one by one. That is not a special case for speed — the union of a set is
 * what the CSG does with them anyway — but it is what keeps an edit inside an
 * unerroded group as cheap as an edit outside one.
 *
 * The two kinds are unioned apart. A group holding a room and a pillar is one
 * group, but the room's boundary and the pillar's are not one boundary, and
 * there is no shape that is the union of a thing and a hole in it.
 */
export function contributing(
  world: World,
  v: KeyframeId,
  items: readonly Resolved[],
): Contributed[] {
  const depth = depths(world, v);

  // Every sealed group stands, whether or not it is eroding: a scope is a scope
  // at depth zero as much as at any other, and what its solids and voids cut
  // they cut inside it either way.
  //
  // A loose one is not here at all, `contributed` having walked past it to its
  // members. It used to be the depth that decided this — a group with none was
  // taken to be doing nothing — which asked erosion to stand for a question it
  // is not about. Sealing is that question, asked outright.
  return contributed(world, items, id => ({ depth: depth.get(id) ?? 0, effects: groupEffects(world, v, id) }));
}

/**
 * What a group does where it is being read.
 *
 * `null` is transparent: it contributes nothing of its own and hands its
 * members over one by one. Anything else means it stands for them, and then
 * `depth` is how far its union is offset — which may be zero, and that is not
 * the same as being transparent. A depth arriving over a span is zero at one
 * end of it, and a group that stopped standing for its members at that end
 * would change what the boundary is *made of* half way through a stretch,
 * which no interpolation describes.
 */
/** The kinds a group can contribute as, in the order `sideOf` numbers them.
 * The first keeps the group's own id; the rest are given one. */
const SIDES: readonly PolygonKind[] = PARTS;

/**
 * The id one side of a group goes by.
 *
 * A group holding a room and a pillar contributes as both a level and a solid,
 * and one id names one contributor: the two unions have different boundaries,
 * take different tracks, and are told apart everywhere downstream by nothing
 * but this number. Its floor and its voids are more of them again, and for the
 * same reason.
 *
 * So every side but the first gets an id of its own, and the first keeps the
 * group's. Negative, because ids come from a counter that only counts up, so
 * nothing authored can ever collide with one — and reversible, so what it
 * belongs to can always be read back.
 */
export function sideOf(id: Id, kind: PolygonKind): Id {
  const at = SIDES.findIndex(k => sameKind(k, kind));

  return at <= 0 ? id : -(id * SIDES.length + at);
}

/** Whose side that is, or nothing where the id is an ordinary one. */
export function sidedWith(id: Id): Id | null {
  return id < 0 ? Math.floor(-id / SIDES.length) : null;
}

/**
 * One kind as the parts it plays, one per set it takes part in, each narrowed
 * to that set.
 *
 * A kind in a single set comes back as itself. One in both — a room with
 * ground laid in it, a void cutting the solids and the floors at once — is two
 * members of two sets that happen to have been drawn once, and everything
 * downstream is built on a contributor belonging to one set. So the split
 * happens here, where the contribution is made, rather than being carried the
 * whole way down.
 *
 * The first part keeps the thing's own id; a second is minted by `sideOf` the
 * way a group's sides are. Which means only the floor half of a polygon in
 * both sets is ever renamed, and a polygon's own id still names the polygon
 * everywhere it did before.
 */
export function parts(kind: PolygonKind): PolygonKind[] {
  return [
    ...(kind.level === undefined ? [] : [{ level: kind.level }]),
    ...(kind.floor === undefined ? [] : [{ floor: kind.floor }]),
  ];
}

/**
 * One set from its slots, the rule worked from the inside out.
 *
 * `level - (solid - void)`, `floor - void`: each slot has the one below it
 * taken out of it, and the answer is the outermost. The pointwise version of
 * the same rule is `inside` in the game's `world.ts`, and the two have to
 * agree — this is what the shapes say and that is what a point query says.
 */
export function settled(slots: readonly Shape[]): Shape {
  let out = slots[slots.length - 1];

  for (let k = slots.length - 2; k >= 0; k--) {
    out = out.length === 0 || slots[k].length === 0 ? slots[k] : subtract(slots[k], out);
  }

  return out;
}

/**
 * A scope's floor, cut to the level that scope makes.
 *
 * The whole of what sealing does to a floor, in one place because two things
 * do it: the reader that hands the floor to the CSG and to the drawing, and
 * the gesture that bakes a scope into polygons. Two cuts that could disagree
 * would be a floor drawn in one place and shipped in another.
 *
 * A scope with no level keeps its floor whole. There is nothing there for the
 * clip to mean, and clipping to an outline that is not there would resolve the
 * floor out of existence — which is a group of nothing but floors vanishing.
 *
 * And a floor already inside its walls keeps its floor whole too, because there
 * the clip *is* the identity and the intersect would hand back the shape it was
 * given. That is the ordinary case — a room with ground laid in it — and it is
 * the case the bake pays for over and over: this runs at every instant the cut
 * evaluates, and every one of them would otherwise be an arrangement built to
 * discover that nothing crosses. `encloses` asks that question directly and
 * says no where it cannot tell, so what is left to the boolean is the floors
 * that really do run past the walls, and the ones drawn flush against them.
 */
export function underfoot(floor: Shape, level: Shape): Shape {
  if (floor.length === 0 || level.length === 0) return floor;

  return encloses(level, floor) ? floor : intersect(floor, level);
}

export interface Standing {
  depth: number
  /** Its round and its deform, on its fold after the depth: see
   * `foldShaped`. Absent is neither. */
  effects?: { facets: Facets, bevel: number, deform?: { e: Effecting, amplitude: number } }
  /**
   * The frame to keep the union's points in.
   *
   * The identity, or nothing, says world units — which is what anything
   * drawing them wants and what anything interpolating them does not. See
   * `groupFrame`.
   */
  frame?: Affine
}

/**
 * The same, with what each group is doing asked for rather than read off a
 * version.
 *
 * The bake wants the depths part way between two versions, where a depth being
 * scrubbed on is a number in flight like any other — and it wants which groups
 * stand for their members settled for the whole span rather than per instant.
 *
 * Only what `items` reaches: the walk starts at what it was given and goes up,
 * so handing it a neighbourhood rather than the world gives that
 * neighbourhood's contributors, which is what a track is cut against.
 */
/**
 * The slot of `set` a scope publishes into: the outermost one anything in it
 * fills, or nothing where it holds nothing in that set.
 *
 * So a scope is whatever its outermost member is. A room with pillars in it is
 * a level; pillars with holes in them and no room around them are a solid, and
 * go on to cut whatever room they are put in, exactly as a pillar would. There
 * is no flag for it, and nothing to retype: what a group is follows from what
 * it holds, the way a polygon's does from its kind.
 *
 * Read off membership, which is global, and not off what stands at any one
 * keyframe. A polygon's kind never changes from one keyframe to the next and a
 * group's does not either — a scope whose only room is taken out at v2 is a
 * level with nothing in it from there on, not a solid from v2, which would have
 * it shrink away with its room across the span and come back whole at the end.
 * An author wanting the solid to outlive the room nests it: a sealed solid in
 * a sealed level has been a solid all along.
 *
 * A void is the outermost thing only in a scope where nothing but voids play
 * a part other than it. Anywhere else it came to cut something in the scope,
 * and is spent there: a floor with a hole through both sets is a floor with a
 * hole in it, and not a floor and a hole left over in the level for whatever
 * solid it lands on. A polygon that is a floor and a void in the level is not
 * that: its void is not cutting its own floor, which is in the other set, and
 * a scope of it alone is what it is loose.
 *
 * Descending through sealed groups as much as loose ones, because a sealed one
 * publishes into its own outermost slot and the least of the least is the
 * least.
 */
export function outermostSlot(world: World, id: Id, set: SetName): number | null {
  return outermostOf(polygonsUnder(world, id), set);
}

/** `outermostSlot` over kinds already in hand. The one rule, for the scope and
 * for a resolve, which reads what is under it rather than a group. */
export function outermostOf(kinds: readonly PolygonKind[], set: SetName): number | null {
  let out: number | null = null;

  for (const kind of kinds) {
    const k = slotOf(kind, set);

    if (k !== null && (out === null || k < out)) out = k;
  }

  if (out !== null && SLOT_PARTS[set][out] === 'void' && kinds.some(k => k[set] !== 'void' && !voidOnly(k))) {
    return null;
  }

  return out;
}

/** Every polygon's kind under `id`, whether or not it stands anywhere. */
function polygonsUnder(world: World, id: Id): PolygonKind[] {
  const group = world.groups.get(id);

  if (group === undefined) {
    const p = world.polygons.get(id);

    return p === undefined ? [] : [p];
  }

  return group.members.flatMap(m => polygonsUnder(world, m));
}

/**
 * Each of `points` that is a vertex of `shape`, with the inward normal of the
 * edge through it: the left of the way round, which is where the material is
 * for any ring an arrangement makes. What moves a kept point in with the
 * edge it is kept on when the edge is offset.
 */
function inwards(shape: Shape, points: readonly Point[]): { p: Point, n: Point }[] {
  if (points.length === 0) return [];

  return points.flatMap(p => {
    for (const ring of shape) {
      const i = ring.findIndex(q => q.x === p.x && q.y === p.y);

      if (i < 0) continue;

      const a = ring[(i - 1 + ring.length) % ring.length], b = ring[(i + 1) % ring.length];
      const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy);

      return l === 0 ? [] : [{ p, n: { x: -dy / l, y: dx / l } }];
    }

    return [];
  });
}

/**
 * The union of `shapes`, offset by `depth`: what one slot of a scope comes to.
 *
 * Remembered, because a group with erosion on it is two arrangements per slot
 * and the drawing asks afresh every frame — once for the version being edited
 * and once more for every ghost on screen, about groups the hand is nowhere
 * near. See `remembered`.
 */
const offsetUnion = remembered((shapes: readonly Shape[], depth: number): Shape => {
  const all = unionAll(shapes);

  return depth === 0 || all.length === 0 ? all : erode(all, depth);
});

/** Where the points of `square` land in `offsetUnion(shapes, depth)`, with
 * what the union and the erosion make beside them: see `effectedSquare`. */
const squaredThrough = remembered((shapes: readonly Shape[], depth: number, square: readonly Point[]): Point[] => {
  const all = unionAll(shapes);
  const eroded = depth === 0 || all.length === 0 ? all : erode(all, depth);

  return eroded.length === 0 ? [] : effectedSquare(shapes, all, eroded, depth, SQUARE, 0, square).square;
});

/** A scope's fold as its own effects draw it, by `shapeKey`: see
 * `foldShaped`. */
const shapedFold = remembered((
  fold: Shape,
  square: readonly Point[],
  keep: readonly Point[],
  /** The members' lines, three entries each — the corner that names it, and
   * its two ends — since what is remembered is named by plain geometry. */
  lines: readonly (number | Point)[],
  /** The members' corners, seven entries each — the corner that names it,
   * where it is, the round it asks for, and the facets it asks for it in. */
  corners: readonly (number | Point)[],
  key: readonly number[],
  depth: number,
) => {
  const [n, from, to, at, tension, bevel, ...d] = key;
  const deform = d.length === 0
    ? null
    : { e: { spacing: d[0], pattern: PATTERNS[d[1]], seed: d[2], sides: DEFORM_SIDES[d[3]], jitter: d[4], falloff: d[5], offset: false }, amplitude: (key: number) => d[6] + (mine.get(key) ?? 0) };

  // What each member asked for along the edge its corner names, to add to the
  // scope's: two deforms on one run are one run standing as high as both, the
  // way two rounds at one corner are one round of both. See PLAN-bevel's
  // step 3.
  const mine = new Map<number, number>();
  const named = [];

  for (let i = 0; i + 3 < lines.length; i += 4) {
    named.push({
      id: lines[i] as number,
      a: lines[i + 1] as Point,
      b: lines[i + 2] as Point,
      amplitude: lines[i + 3] as number,
    });

    if (lines[i + 3] !== 0) mine.set(lines[i] as number, lines[i + 3] as number);
  }

  const ends: Named['corners'] = [];

  for (let i = 0; i + 6 < corners.length; i += 7) {
    ends.push({
      id: corners[i] as number,
      at: corners[i + 1] as Point,
      bevel: corners[i + 2] as number,
      facets: {
        n: corners[i + 3] as number,
        from: corners[i + 4] as number,
        to: corners[i + 5] as number,
        at: (corners[i + 6] as Point).x,
        tension: (corners[i + 6] as Point).y,
      },
    });
  }

  // A member publishes no arc any more: its corner reaches the fold as a
  // corner and the fold rounds it, by its own amount over the scope's. See
  // PLAN-bevel's steps 1 to 3.
  const curves: { id: number, points: Point[] }[] = [];

  const facets = { n, from, to, at, tension };

  // Erode, then round and deform — PLAN-bevel's step 4. The one step that
  // cannot be lifted onto the union goes first, on a ring with no teeth in it
  // and nothing rounded to cut back; the members' lines and corners are moved
  // in by the same depth, and one pass lays the rest on what comes out, at a
  // depth of nought.
  // No corners in the first pass: a member's corner carries its own round —
  // step 3 — and the erosion is meant to run on a ring with nothing rounded
  // in it. They go in the second, where the scope's amount is added to them.
  const first = foldShaped(fold, square, keep, named, curves, [], SQUARE, 0, null, depth);
  const moved = movedIn({ lines: named, corners: ends }, depth);
  const then = foldShaped(first.shape, first.square, first.keep, moved.lines, curves, moved.corners, facets, bevel, deform, 0);

  // Beside what it drew: what it drew *from*, for a scope holding this one,
  // which takes this fold's corners as its own members' and rounds them once.
  // Its names come with it, on `then`. See PLAN-bevel's step 5.
  return { ...then, bare: first.shape, fades: [...first.fades, ...then.fades] };
});

/**
 * The points of a polygon's shape that are deformed geometry, which a group's
 * round leaves square: its teeth, along its edges and along its arcs, and the
 * corners at the ends of its edges with teeth, which its own round is laid
 * clear of but a group's is not — where its erosion put them.
 */
function squareIn(it: Resolved): Point[] {
  const teeth = unrounded(it.corners);
  const n = it.corners.length;
  const flags = teeth.map((t, i) => t || teeth[nextOf(it.rings, n, i)] || teeth[prevOf(it.rings, n, i)]);
  const im = imagesOf(it);

  if (im !== null) return [...flags.flatMap((f, i) => (f ? im.corners[i] ?? [] : [])), ...(im.teeth ?? [])];

  if (!flags.some(Boolean)) return [];

  return flags.flatMap((f, i) => {
    const m = f ? mitred(it.source, it.rings, i, it.depths?.[i] ?? it.erosion) : null;

    return m === null ? [] : [m];
  });
}

/** A group's round and deform as `shapedFold` takes them, or nothing where
 * they do nothing. */
function shapeKey(s: Standing | null): number[] | null {
  const fx = s?.effects;

  if (fx === undefined) return null;

  const round = fx.facets.n > 0 && fx.bevel > 0;
  const d = fx.deform;

  if (!round && d === undefined) return null;

  return [
    ...facetKey(round ? fx.facets : SQUARE), round ? fx.bevel : 0,
    ...(d === undefined ? [] : [d.e.spacing, PATTERNS.indexOf(d.e.pattern), d.e.seed, DEFORM_SIDES.indexOf(d.e.sides), d.e.jitter, d.e.falloff, d.amplitude]),
  ];
}

export function contributed(
  world: World,
  items: readonly Resolved[],
  standing: (id: GroupId) => Standing | null,
  /**
   * Where the group projections are kept, if the caller wants them kept.
   *
   * A group's offset union is a full arrangement, and the bake asks for the
   * same one over and over: every track whose neighbourhood the group falls
   * into needs it, at whatever instant that track is looking at. The caller
   * owns the map because only the caller knows what makes two asks the same
   * ask — for the bake, the same instant.
   */
  held?: Map<string, Shape>,
): Contributed[] {
  const mine = new Map(items.map(it => [it.id as Id, it]));
  const out: Contributed[] = [];
  const outer = new Map<string, number | null>();

  /** The slot a scope publishes into. See `outermostSlot`. */
  const top = (id: Id, set: SetName): number | null => {
    const key = `${id}:${set}`;

    if (!outer.has(key)) outer.set(key, outermostSlot(world, id, set));

    return outer.get(key)!;
  };

  /** What one member offers of a kind, projected if it is an eroding group. */
  /**
   * What one member puts into slot `k` of `set`, in the scope that is asking.
   *
   * A polygon puts its shape into the one slot its kind names. A group that
   * stands puts in what it *resolved to*, at the slot its own kind names —
   * whatever cut inside it was spent inside it, so what arrives here is a
   * shape with a part to play and nothing else, exactly like a polygon's. A
   * group that is open has no scope of its own for the moment and hands its
   * members up into this one.
   */
  const from = (id: Id, set: SetName, k: number, bare = false): Shape[] => {
    const it = mine.get(id);

    if (it !== undefined) {
      if (slotOf(kindOf(it.polygon), set) !== k) return [];

      // Under a scope that shapes, eroded and nothing else: its corners have
      // to reach the fold as corners for the fold to round them once. What it
      // asked for comes with `namesOf`, beside them. See PLAN-bevel's step 2.
      return [bare ? erodedOf(it) : it.shape];
    }

    const group = world.groups.get(id);

    if (group === undefined) return [];

    // A sealed scope puts in one shape, in the slot of its outermost kind:
    // whatever cut inside it was spent inside it, so what arrives is a level,
    // or a solid with its voids already taken out, and nothing that cuts it
    // back. A loose group, or one standing open, has no scope of its own and
    // hands its members up into this one.
    if (group.sealed && standing(id) !== null) {
      return k === top(id, set) ? [resolves(id, set, bare)] : [];
    }

    return group.members.flatMap(m => from(m, set, k, bare));
  };

  /** One slot of one scope, offset by that scope's own depth the way the
   * slot's place in the rule means. */
  const slotted = (id: Id, set: SetName, k: number, flat = false, bare = false): { shape: Shape, keep: Point[], square: Point[], named: Named } => {
    const group = world.groups.get(id);

    if (group === undefined) return { shape: [], keep: [], square: [], named: { lines: [], corners: [] } };

    // Flat, at depth nought: for a scope whose effects are laid on its fold
    // before its depth. See `foldShaped`.
    const here = standing(id);
    const d = flat ? 0 : here?.depth ?? 0;

    // What is taken away goes the other way, and this is not a choice — it is
    // what eroding the scope as one shape *means*: eroding a complement is
    // dilating, so the sign alternates with how deeply a slot is nested. See
    // `inverted` in the game's `world.ts` for the identity.
    //
    // The slots are eroded apart and folded after, which is what lets them come
    // out as though they had been eroded together. A pillar shrunk along with
    // its room leaves a gap that never narrows.
    //
    // Counted from the slot the scope publishes into, since that is the shape
    // the depth erodes: a scope that is a solid shrinks as a solid does, and
    // its voids grow against it.
    const kinds = SLOT_KINDS[set];
    const depth = inverted(kinds[k]) !== inverted(kinds[top(id, set) ?? 0]) ? -d : d;
    const shapes = group.members.flatMap(m => from(m, set, k, bare));
    const union = offsetUnion(shapes, depth);

    // What its members' deforms made, which a round leaves square — its own,
    // after the fold, or a scope's holding it — where the erosion moved it.
    //
    // Nothing at all where the scope shapes: with the members eroded only
    // there is no effect geometry on the union for its round to protect, and
    // the teeth it wants are the ones it lays itself. See PLAN-bevel's step 2.
    const inside = bare ? [] : group.members.flatMap(m => squareFrom(m, set, k));
    const square = inside.length === 0 ? [] : depth === 0 ? inside : squaredThrough(shapes, depth, inside);

    // What its members keep for the bake, moved in with their edges: a union
    // is an arrangement, and would drop them — see `Resolved.keep`. A member
    // eroded only invented nothing and lies flat nowhere; what this fold keeps
    // is its own.
    const keep = bare ? [] : group.members.flatMap(m => keptFrom(m, set, k))
      .map(({ p, n }) => ({ x: p.x + n.x * depth, y: p.y + n.y * depth }));

    // What its members' outlines are made of, moved in with them: the fold
    // names its straights and its arcs by these. See `namesOf`.
    const named = group.members
      .map(m => namedFrom(m, set, k, bare))
      .reduce((all, n) => ({ lines: [...all.lines, ...n.lines], corners: [...all.corners, ...n.corners] }), { lines: [], corners: [] } as Named);

    return { shape: keep.length === 0 ? union : keeping(union, keep), keep, square, named: movedIn(named, depth) };
  };

  /** What one member of slot `k` publishes about its outline: a polygon's
   * own, and a scope's what its own fold came to. See `Named`. */
  const namedFrom = (id: Id, set: SetName, k: number, bare = false): Named => {
    const it = mine.get(id);
    const none: Named = { lines: [], corners: [] };

    if (it !== undefined) return slotOf(kindOf(it.polygon), set) === k ? namesOf(it) : none;

    const group = world.groups.get(id);

    if (group === undefined) return none;

    if (group.sealed && standing(id) !== null) {
      if (k !== top(id, set)) return none;

      const key = `${id}:${set}${bare ? ':bare' : ''}`;

      if (!named.has(key)) resolves(id, set, bare);

      return named.get(key) ?? none;
    }

    return group.members.flatMap(m => [namedFrom(m, set, k, bare)])
      .reduce((all, n) => ({ lines: [...all.lines, ...n.lines], corners: [...all.corners, ...n.corners] }), none);
  };

  /** The points of what one member puts into slot `k` of `set` that are
   * deformed geometry: see `squareIn`. A scope's are what it left square. */
  const squareFrom = (id: Id, set: SetName, k: number): Point[] => {
    const it = mine.get(id);

    if (it !== undefined) return slotOf(kindOf(it.polygon), set) === k ? squareIn(it) : [];

    const group = world.groups.get(id);

    if (group === undefined) return [];

    if (group.sealed && standing(id) !== null) {
      if (k !== top(id, set)) return [];

      // Resolved already, as `from` put it in.
      const key = `${id}:${set}`;

      if (!squares.has(key)) resolves(id, set);

      return squares.get(key) ?? [];
    }

    return group.members.flatMap(m => squareFrom(m, set, k));
  };

  /**
   * The points a member keeps for the bake, on its shape, each with the
   * inward normal of the edge it lies on: a polygon's own, and a scope's
   * inside, which kept its members'.
   */
  const keptFrom = (id: Id, set: SetName, k: number): { p: Point, n: Point }[] => {
    const it = mine.get(id);

    if (it !== undefined) {
      return slotOf(kindOf(it.polygon), set) === k ? inwards(it.shape, (it.keep ?? []).map(p => ('p' in p ? p.p : p))) : [];
    }

    const group = world.groups.get(id);

    if (group === undefined) return [];

    if (group.sealed && standing(id) !== null) {
      return k === top(id, set) ? inwards(resolves(id, set), kept.get(`${id}:${set}`) ?? []) : [];
    }

    return group.members.flatMap(m => keptFrom(m, set, k));
  };

  const kept = new Map<string, Point[]>();
  const named = new Map<string, Named>();
  const fading = new Map<string, Fade[]>();
  const squares = new Map<string, Point[]>();

  /**
   * What one scope puts into `set`: its slots folded by the rule, and, for the
   * floor, clipped to what the same scope puts into the level.
   *
   * The clip is what makes a group a scope rather than a bag. A floor running
   * out past the walls it belongs to is floor laid where the group is not, and
   * it was only ever invisible because a wall stood in front of it. This is the
   * same `(floor - void) and (level - (solid - void))` that resolving a group
   * has always produced — see the header of `resolve.ts` — now taken without
   * the group having to be destroyed to get it.
   *
   * A scope with no level keeps its floor whole. There is nothing there for the
   * clip to mean, and clipping to an outline that is not there would resolve
   * the floor out of existence. Nor does one that is a solid: a solid is
   * something standing in a room, not the room a floor is laid in.
   *
   * The fold starts at the scope's outermost slot rather than the first, so a
   * solid with voids in it is `solid - void` and not `nothing - (solid - void)`.
   */
  const resolves = (id: Id, set: SetName, bare = false): Shape => {
    const key = `${id}:${set}${bare ? ':bare' : ''}`;
    const known = held?.get(key);

    if (known !== undefined) {
      kept.set(key, held?.get(`${key}:keep`)?.[0] ?? []);
      squares.set(key, held?.get(`${key}:square`)?.[0] ?? []);

      // Held as a shape, as everything here is: the points, and beside them
      // how solid each is.
      const [points = [], solid = []] = held?.get(`${key}:faded`) ?? [];

      fading.set(key, points.map((p, i) => ({ p, v: solid[i].x })));

      return known;
    }

    const from = top(id, set);
    const here = standing(id);
    const shapedBy = shapeKey(here);
    const slots: { shape: Shape, keep: Point[], square: Point[], named: Named }[] = [];

    for (let k = from ?? SLOTS[set]; k < SLOTS[set]; k++) {
      slots.push(slotted(id, set, k, shapedBy !== null, bare || shapedBy !== null));
    }

    const settles = slots.length === 0 ? [] : settled(slots.map(u => u.shape));

    // With effects of its own, folded flat, rounded, deformed and then eroded
    // as one shape — which is what eroding the slots apart and folding them
    // comes to, where there are no corners: see `foldShaped`. After the fold,
    // so a solid cutting the level leaves corners the round takes as it takes
    // any, and before a floor is cut to its level, whose arcs it takes as they
    // come.
    const inside = slots.flatMap(u => u.square);
    const shaped = shapedBy === null
      ? null
      : shapedFold(
        settles,
        inside,
        slots.flatMap(u => u.keep),
        slots.flatMap(u => u.named.lines.flatMap(l => [l.id, l.a, l.b, l.amplitude])),
        slots.flatMap(u => u.named.corners.flatMap(c =>
          [c.id, c.at, c.bevel, c.facets.n, c.facets.from, c.facets.to, { x: c.facets.at, y: c.facets.tension }])),
        shapedBy,
        here!.depth,
      );
    const rounded = shaped ?? { shape: settles, runs: [], square: inside, keep: slots.flatMap(u => u.keep), fades: [] };

    // Taken bare by a scope above: the fold before its own round and deform,
    // which are published instead of drawn — `shaped.bare`, or the union
    // itself where there are none. Its corners have to reach that fold as
    // corners for it to round them once, exactly as a polygon's do at step 2.
    const drew = bare ? shaped?.bare ?? settles : rounded.shape;
    const cut = set === 'floor' && top(id, 'level') === 0
      ? underfoot(drew, resolves(id, 'level', bare))
      : drew;

    // Where the bake has its arcs on their facets, fading: see `facetFades`.
    const fx = here?.effects;
    const faded = bare ? [] : [
      ...(fx === undefined || shapedBy === null || (fx.facets.from === fx.facets.to && fx.facets.from >= fx.facets.n)
        ? []
        : rounded.runs.flatMap(run => facetFades(run, fx.facets))),

      // And its teeth still lying flat in it: see `FoldShaped.fades`.
      ...(shaped?.fades ?? []),
    ];

    // Folding the slots is an arrangement again, and would drop them again.
    // And the points its arcs have on their facets, at the end they lie
    // straight.
    // A bare fold invented nothing and lies flat nowhere: what it keeps and
    // what it leaves square are the holder's business, as a bare member's are.
    const keep = bare ? [] : [...rounded.keep, ...faded.filter(f => f.v === 0).map(f => f.p)];
    const out = keep.length === 0 ? cut : keeping(cut, keep);

    const square = bare ? [] : rounded.square;

    // Its own, for a scope holding it: what its fold came to, which is where
    // its own amounts are — each straight with the amount its run inherits and
    // each corner with its summed bevel, a join with nothing, the depth
    // already in them. With no effects there is nothing of its own to add, and
    // what its members published, moved in by its depth, is that fold. See
    // PLAN-bevel's step 5.
    named.set(key, shaped?.named ?? movedIn(slots.reduce(
      (all, u) => ({ lines: [...all.lines, ...u.named.lines], corners: [...all.corners, ...u.named.corners] }),
      { lines: [], corners: [] } as Named,
    ), here?.depth ?? 0));

    kept.set(key, keep);
    fading.set(key, faded);
    squares.set(key, square);
    held?.set(key, out);
    held?.set(`${key}:keep`, [keep]);
    held?.set(`${key}:square`, [square]);
    held?.set(`${key}:faded`, [faded.map(f => f.p), faded.map(f => ({ x: f.v, y: 0 }))]);

    return out;
  };

  const emit = (id: Id): void => {
    const it = mine.get(id);

    if (it !== undefined) {
      parts(kindOf(it.polygon)).forEach((kind, k) => {
        out.push({
          id: k === 0 ? id : sideOf(id, kind),
          kind,
          shape: it.shape,
          frame: it.frame,
          // Already an arrangement, whatever its depth. See `plainly`.
          simple: true,
          keep: it.keep,
        });
      });

      return;
    }

    const how = standing(id);
    const group = world.groups.get(id);

    // A loose group contributes nothing of its own. It is a handle, and its
    // members are already here in their own right — `tops` walked past it to
    // find them, exactly as it walks past an open one.
    if (group === undefined || how === null || !group.sealed) return;

    // One contribution per set at most, and both under the group's own kind: a
    // scope publishes what it *is*, not what it is made of. Whatever cut inside
    // it has been spent inside it, so there is nothing here for a sibling's
    // room to be cut by — which is the whole of what scoping means.
    //
    // A group whose kind is in only one of the sets puts nothing into the
    // other. A block assembled out of parts has floors inside it and they are
    // inside a block, which is not somewhere a floor is drawn.
    // One contribution per set, both plain: a scope publishes what it *is*, not
    // what it is made of — the outermost kind it holds, so a level or a solid
    // here and a floor there, and nothing that cuts either. Two ids, because
    // they are two boundaries. See `outermostSlot`.
    for (const set of SETS) {
      const shape = resolves(id, set);

      if (shape.length === 0) continue;

      const kind = SLOT_KINDS[set][top(id, set)!];
      const faded = fading.get(`${id}:${set}`) ?? [];

      out.push({
        id: sideOf(id, kind),
        kind,
        shape,
        frame: how.frame ?? IDENTITY,
        simple: true,
        ...(faded.length === 0 ? {} : { faded }),
      });
    }
  };

  // Upwards from what is actually here, rather than down from the top.
  //
  // Down would reach a standing group by way of a transparent one holding it,
  // with none of that group's members in hand — and answer for it anyway, out
  // of nothing. Every polygon here names the one thing that stands for it, and
  // a group nothing here belongs to is never asked about at all.
  const tops = new Set<Id>();

  for (const it of items) {
    const up = enclosing(world, it.id)
      .filter(g => standing(g) !== null && world.groups.get(g)?.sealed === true);

    tops.add(up[up.length - 1] ?? it.id);
  }

  for (const id of tops) emit(id);

  return out;
}

/**
 * What is on screen, as things that can be picked: a closed group as one shape,
 * an open one as whatever is inside it.
 *
 * This is `contributing` asked a different question. The CSG wants to know
 * which groups are *eroding*, because that is the only thing that changes what
 * the set is made of. Drawing wants to know which groups are *closed*, because
 * a group is one thing to the hand whether or not it erodes — and a group at
 * depth zero still draws as its own outline.
 *
 * The two answers are the same walk over the same structure, so the same
 * function gives both. Only the question differs: `standing` here is "is this
 * group shut?".
 *
 * A group's shape comes out per kind, and a group holding a room and a pillar
 * has two of them. There is no shape that is the union of a thing and a hole
 * in it, and drawing one outline over both would draw a boundary that is not
 * anywhere. See `solidSide`.
 */
export function showing(
  world: World,
  v: KeyframeId,
  items: readonly Resolved[],
  /** The groups standing open, from `opened`. Everything else is shut. */
  path: readonly GroupId[],
): Contributed[] {
  const depth = depths(world, v);
  const open = new Set<Id>(path);

  return contributed(world, items, id =>
    open.has(id) ? null : { depth: depth.get(id) ?? 0 },
  );
}

/** One shut group as it is drawn: its whole contribution, as one boundary. */
export interface Occupied {
  id: GroupId
  /**
   * Why the group has no boundary of its own, where it has none. `shape` is
   * then the union of everything it holds — where the group *is* — rather than
   * an edge of any set.
   *
   * `loose` is a handle. Its members are in the set one by one and their own
   * outlines are on screen in their own right, so this is drawn round them and
   * nothing about them changes: what it says is *these are held together*.
   *
   * `empty` is a scope that came to nothing — a room swallowed by its own
   * pillar, a level whose rooms have all been taken out, or one eroded past its
   * own middle.
   * Nothing else of it is on screen at all, so this is the whole of what says
   * it is there, and it is drawn the way an eroded-away polygon is.
   *
   * Either way what can be picked is what is drawn, which is the rule
   * everywhere else too — see `standingFor`.
   */
  gone?: 'loose' | 'empty'
  /**
   * Which of the two sets `shape` is the group's contribution to, and which
   * way it goes.
   *
   * `level`/`add` in the ordinary case, which is any group with a room in it.
   * `level`/`subtract` for a group made of nothing but pillars, which has no
   * level side to take them out of and is drawn as the pillars — a group must
   * be visible, and one made of holes is still a thing. `floor`/`add` for a
   * group with neither, which is drawn as its floor for the same reason.
   */
  kind: PolygonKind
  /**
   * The added side with the subtracted side taken out of it: what the group
   * puts into the level, and the whole of what a click on it can land on.
   *
   * A shut group draws no pillar of its own — a pillar's outline is exactly
   * the internal geometry that shutting it was meant to put away — so there is
   * nothing on screen to click in the hole one leaves, and the click falls
   * through, as a click on anything not drawn does.
   *
   * Empty for a group of nothing but floors, which occupies no level at all.
   * Then `floor` is the whole of it and `kind` says so.
   *
   * Always an arrangement, whichever branch built it: a union, or a union with
   * the subtracted side taken out of it. That is what lets `erodedShape` offset
   * it ring by ring — material is on the left of every ring a walk produces,
   * hole and outer alike, so one depth moves them all the right way.
   */
  shape: Shape
  /**
   * The group's floor set — its floors added and its floor holes taken back
   * out — whole.
   *
   * It has to end up drawn inside `shape` — a floor running out past the walls
   * it belongs to would put floor where the group is not — but it is handed
   * over unclipped, because the one thing that wants it is painting it and a
   * canvas clips for free. Intersecting with `shape` here would be a boolean
   * per redraw to work out a boundary nothing asks a question about: nothing
   * is picked by a floor, and where it is cut short the group's own outline is
   * already drawn along the cut.
   *
   * The subtraction *within* the floor set is a different matter and is done
   * here, because there is no outline anywhere else saying where those edges
   * are. A hole cut in a floor is a boundary of the floor.
   */
  floor: Shape
}

/**
 * What one shut group is on screen as, which is its level side where it has
 * one and its floor where it has nothing else.
 *
 * Both, where the level side is not a room. A floor is cut to a level and to
 * nothing else — see `resolves` in `contributed` — so a solid's floor runs
 * wherever it was laid and is on screen as much as the solid is.
 *
 * The same fallback the drawing makes and the picking makes, in one place so
 * that they cannot drift: what can be clicked is what is drawn.
 */
export function occupiedShape(o: Occupied): Shape {
  if (o.shape.length === 0) return o.floor;
  if (o.floor.length === 0 || floorsIn(o)) return o.shape;

  return unionAll([o.shape, o.floor]);
}

/** Whether a shut group's floor lies inside its outline: only where the
 * outline is a room, which is the only thing a floor is cut to. */
export function floorsIn(o: Occupied): boolean {
  return o.shape.length !== 0 && o.kind.level === 'hollow';
}

/**
 * What each shut group occupies, as the one outline that says so.
 *
 * A group resolves internally. Its level union with its solid union taken out
 * is what it puts into the level, and it is one boundary with nothing inside
 * it — which is the whole of what shutting a group is supposed to do to the
 * eye. Drawing the two sides separately puts the pillar's own outline back on
 * screen, and a pillar inside a room is exactly the internal geometry that
 * grouping was meant to stop showing.
 *
 * It is the same principle as eroding: a group erodes as one shape, so a group
 * resolves as one shape. What happens *between* its members is its own
 * business; what happens between it and the rest of the level is not, and is
 * left to the CSG outline over the top, exactly as it is for a lone polygon —
 * whose outline is also drawn whole, whatever cuts it.
 *
 * A group with nothing but walls in it has no level side to take them out of,
 * and is drawn as the walls. A group must be visible: it is the thing being
 * picked and dragged, and one made of pillars is still a thing.
 *
 * This is a question only drawing asks. The CSG needs the two sides apart —
 * a group's walls cut the rooms around it too, not only its own — which is
 * what `contributed` is careful to give it. See `showing`.
 */
export function occupying(
  world: World,
  v: KeyframeId,
  items: readonly Resolved[],
  path: readonly GroupId[],
): Occupied[] {
  return withExtents(world, items, path, occupied(world, showing(world, v, items, path)));
}

/**
 * The shut groups `items` reaches, outermost first for each of them.
 *
 * `contributed` walks the same way but stops at scopes; this stops at whatever
 * the hand would grab, which is any shut group, loose or sealed.
 */
function shutGroups(
  world: World,
  items: readonly Resolved[],
  path: readonly GroupId[],
): Set<GroupId> {
  const open = new Set<Id>(path);
  const out = new Set<GroupId>();

  for (const it of items) {
    const up = enclosing(world, it.id).filter(g => !open.has(g));
    const top = up[up.length - 1];

    if (top !== undefined) out.add(top);
  }

  return out;
}

/** The shut groups that occupy nothing, given their extent to stand in. */
function withExtents(
  world: World,
  items: readonly Resolved[],
  path: readonly GroupId[],
  shown: Occupied[],
): Occupied[] {
  const held = new Map<Id, Shape>(shown.map(o => [o.id, occupiedShape(o)]));
  const missing = [...shutGroups(world, items, path)].filter(id => !held.has(id));

  if (missing.length === 0) return shown;

  const mine = new Map(items.map(it => [it.id as Id, it.shape]));

  /**
   * Everything the group holds, unioned: where it *is*, for a group that has
   * no boundary of its own.
   *
   * What each member is on screen as, rather than what it is made of. A scope
   * inside the group has already answered that — it is in `held`, as the one
   * outline it draws — and going past it to the polygons underneath would put
   * its internal geometry back into the union: a loose group round a sealed
   * one would bulge out over the hole the scope cut in itself, which is the
   * very shape sealing took off the screen.
   */
  const extent = (id: Id): Shape => held.get(id)
    ?? mine.get(id)
    ?? offsetUnion((world.groups.get(id)?.members ?? []).map(extent), 0);

  for (const id of missing) {
    const shape = extent(id);

    if (shape.length === 0) continue;

    shown.push({
      id,
      kind: { level: 'hollow' },
      shape,
      floor: [],
      gone: world.groups.get(id)?.sealed === true ? 'empty' : 'loose',
    });
  }

  return shown;
}

/**
 * The same, with every shut group's own depth left off: the boundary the
 * group's erosion moved, rather than where it moved it to.
 *
 * A group has no source ring — it has no corners at all, which is the whole
 * reason `Occupied` is not a `Resolved` — so the only thing there is to say
 * where its erosion started from is the union taken again at depth zero. Its
 * members are resolved once either way and the union is the cheap half, so
 * this is a second pass over shapes already in hand rather than a second
 * resolve.
 *
 * Only drawing asks, and only about a group that is picked: it is the far end
 * of a leader line. See `moved`.
 */
export function occupyingSource(
  world: World,
  v: KeyframeId,
  items: readonly Resolved[],
  path: readonly GroupId[],
): Occupied[] {
  const open = new Set<Id>(path);

  return occupied(world, contributed(world, items, id =>
    open.has(id) ? null : { depth: 0 },
  ));
}

/** The four sides of each group put together into the one outline it draws as. */
function occupied(world: World, shown: readonly Contributed[]): Occupied[] {
  const sides = new Map<GroupId, Map<string, Shape>>();

  for (const c of shown) {
    const id = sidedWith(c.id) ?? c.id;

    if (!world.groups.has(id)) continue;

    const side = sides.get(id) ?? new Map<string, Shape>();

    side.set(kindKey(c.kind), c.shape);
    sides.set(id, side);
  }

  const out: Occupied[] = [];

  for (const [id, side] of sides) {
    const at = (k: PolygonKind): Shape => side.get(kindKey(k)) ?? [];

    // Nothing is folded or clipped here any more. A scope arrives resolved —
    // one shape per set, its solids and voids already spent inside it and its
    // floor already cut to it — because that is what it hands the CSG too, and
    // the two must not be two answers. See `resolves` in `contributed`.
    const floor = at({ floor: 'floor' });

    for (const kind of SLOT_KINDS.level) {
      const shape = at(kind);

      if (shape.length !== 0) {
        out.push({ id, kind, shape, floor });
        break;
      }
    }

    // Nothing in the level at all. Then the floor is the whole of it, and it is
    // drawn as a floor rather than as nothing — the same reason a group of
    // pillars is drawn as pillars. `shape` empty is what says so on top of
    // `kind`, and it is what stops the drawing clipping the floor to an outline
    // that is not there.
    if (!out.some(o => o.id === id)) out.push({ id, kind: { floor: 'floor' }, shape: [], floor });
  }

  return out;
}

/**
 * The outline of what is picked, as points: where a gesture takes the selection
 * to be.
 *
 * What is drawn, rather than what it was drawn from. A shut group's outline is
 * its level side with its solid side taken out of it — `occupying` says why —
 * and a pillar is not part of where a room is. It is a hole in one. So a group
 * whose pillar reaches out into the dark is still a group centred on its room,
 * and turning it does not swing about a point out in the middle of nothing.
 *
 * Which is the same answer the eye gives, because it is the same answer the
 * drawing gives: the two ask `occupying` and get one shape back.
 *
 * Anything drawn by itself speaks for itself. A lone pillar is a thing that has
 * been picked and is on screen, so it is where it is.
 *
 * The source rings where there is no outline at all — eroded past its own
 * middle, on every side. The same fallback the drawing makes, and for the same
 * reason: a selection with nothing on screen still has to be somewhere.
 */
export function outlining(
  world: World,
  v: KeyframeId,
  items: readonly Resolved[],
  path: readonly GroupId[],
): Point[] {
  const out: Point[] = [];

  for (const g of occupying(world, v, items, path)) {
    for (const ring of occupiedShape(g)) out.push(...ring);
  }

  for (const it of items) {
    if (swallowed(world, it.id, path)) continue;

    for (const ring of it.shape.length === 0 ? [it.source] : it.shape) out.push(...ring);
  }

  return out.length > 0 ? out : items.flatMap(it => it.source);
}

/**
 * Whether a polygon is drawn by itself, or swallowed by a group drawing for it.
 *
 * Any enclosing group that is not on the open path shuts it in. It does not
 * matter which one — the outermost shut group is what draws — because a
 * polygon inside a shut group has no outline of its own on screen either way.
 */
export function swallowed(world: World, id: Id, path: readonly GroupId[]): boolean {
  const open = new Set<Id>(path);

  // Only a sealed one. Shutting a scope takes several outlines away and leaves
  // one, which is the whole of what it does to the eye — but a loose group
  // takes nothing away, because its members are in the set in their own right
  // and their outlines are the set's. Hiding them would leave a green ring
  // round an empty patch of level that is demonstrably still there.
  return enclosing(world, id).some(g => !open.has(g) && world.groups.get(g)?.sealed === true);
}

/**
 * The polygons the point tool may have handles on: everything drawn by itself,
 * plus the members of whatever groups are picked.
 *
 * A shut group hides its members' outlines, and their corners went with them —
 * a handle on a shape that is not on screen is a handle on nothing. Picking
 * the group puts them back, corners only: the group is still one outline, and
 * what a click on it does is still pick the group, but the shapes underneath
 * are named now and their corners are worth reaching. That is the same bargain
 * command-click already makes for one polygon at a time, offered to the whole
 * of what the selection names.
 *
 * Which of those corners are worth a square is a second question, and it is
 * `handles` that answers it: a member offers only the corners standing on the
 * group's own boundary.
 */
export function editable(
  world: World,
  items: readonly Resolved[],
  path: readonly GroupId[],
  inside: GroupId | null,
  /** What the selection reaches, from `polygonsIn`. */
  picked: ReadonlySet<PolygonId>,
): Resolved[] {
  return items.filter(it =>
    reachable(world, it.id, inside)
    && (picked.has(it.id) || !swallowed(world, it.id, path)),
  );
}

/** One corner the point tool can put a square on and a click can land on:
 * which corner it is, and where it is standing. */
export interface Handle extends Grabbed {
  at: Point
}

/**
 * Every handle on screen, which is what the point tool draws and what a click
 * under it hits.
 *
 * A corner rather than a polygon, because a picked group's members do not
 * offer all of theirs. A group is one outline and the corners under it are of
 * two kinds: the ones on that outline, which are the shape of the thing being
 * looked at, and the seams where two members meet, which are the internal
 * geometry shutting the group put away. Handing back every corner of every
 * member puts the seams back as squares — the outline of the members without
 * the lines, which is the most confusing form the hidden geometry could take.
 * So a swallowed member offers the corners that are on the group's boundary
 * and no others.
 *
 * The group's *source* boundary, and its floor's: the union with the group's
 * own depth left off, which is where the members' corners actually are, and
 * the floor union beside it, which is drawn inside the group and is nobody's
 * outline but is on screen all the same. See `occupyingSource`.
 *
 * Drawing and hitting share this and have to: a square drawn where no click
 * lands is worse than no square, and a click that moves a corner with no
 * square on it is worse still.
 */
export function handles(
  world: World,
  v: KeyframeId,
  items: readonly Resolved[],
  path: readonly GroupId[],
  inside: GroupId | null,
  /** What the selection reaches, from `polygonsIn`. */
  picked: ReadonlySet<PolygonId>,
): Handle[] {
  const mine = editable(world, items, path, inside, picked);
  const shut = mine.filter(it => swallowed(world, it.id, path));

  // Only where a picked group is standing for something, which is the only
  // case that needs a boundary to test against.
  const on = new Map<Id, (p: Point) => boolean>();

  if (shut.length !== 0) {
    for (const g of occupyingSource(world, v, items, path)) {
      const edge = onBoundary(g.shape);
      const floor = g.floor.length === 0 ? null : onBoundary(g.floor);

      on.set(g.id, p => edge(p) || (floor !== null && floor(p)));
    }
  }

  const out: Handle[] = [];

  for (const it of mine) {
    const edge = on.get(reaching(world, it.id, path));

    it.source.forEach((at, index) => {
      if (edge !== undefined && !edge(at)) return;

      // A tooth a deform made is not a corner anyone drew, and there is
      // nothing of it to move: its place is its edge's.
      if (it.corners[index].root !== undefined) return;

      out.push({ id: it.id, index, vertex: it.corners[index].id, at });
    });
  }

  return out;
}

/**
 * Whether a click can reach `id` at all.
 *
 * Everything outside the group standing open is out of reach: it is drawn, so
 * that what is being edited can be judged against the level around it, but it
 * cannot be picked or dragged. That is what makes going inside a group a scope
 * rather than a hint — a slip of the cursor onto the room next door does not
 * silently take the selection out with it.
 */
export function reachable(world: World, id: Id, inside: GroupId | null): boolean {
  // Hidden or locked from its row in the timeline. See `Flags`.
  if (!clickable(world, id)) return false;

  // A group that is no longer there holds nothing in, which is the same answer
  // `opened` gives: undo can restore a world the open path was never in, and
  // the way out of that is being outside rather than being nowhere.
  if (inside === null || !world.groups.has(inside)) return true;

  return enclosing(world, id).includes(inside);
}


/** Resolved polygons as contributors, one for one. What the CSG sees wherever
 * no group is eroding, and what the bake works in. */
export function plainly(items: readonly Resolved[]): Contributed[] {
  return items.flatMap(it => parts(kindOf(it.polygon)).map((kind, k) => ({
    id: k === 0 ? it.id : sideOf(it.id, kind),
    kind,
    shape: it.shape,
    frame: it.frame,
    keep: it.keep,

    // A projection came out of an arrangement and is already simple, at every
    // depth. Depth zero is not the exception it used to be: `project` decomposes
    // there too, so that a ring which has not started eroding is cut the same
    // way as the same ring a moment later — see `project`. Saying otherwise
    // costs an arrangement per polygon per evaluation, for an answer that is
    // already in hand.
    simple: true,
  })));
}

/**
 * The set the game would get — every level polygon added, every one subtracted
 * taken out — as the open runs its outline is made of.
 *
 * Runs rather than rings because that is what can be kept up to date: a run
 * belongs to one polygon, so an edit only disturbs the polygons it overlaps.
 * See `worldset.ts`. Nothing that reads this wants a closed loop — the overlay
 * is stroked, and collision is edge-normal based.
 */
export function csg(world: World, v: KeyframeId): Point[][] {
  return runs(live(EMPTY_LIVE, contributing(world, v, resolveAt(world, v))));
}

/** The same for the floor, which is a set of its own and answered by the same
 * machinery. See `Live`. */
export function csgFloor(world: World, v: KeyframeId): Point[][] {
  return floorRuns(live(EMPTY_LIVE, contributing(world, v, resolveAt(world, v))));
}

/**
 * The two sets, held on to between draws so that redrawing costs only what
 * actually moved. Rebuilding one from nothing is O(n) in polygons and measured
 * at nearly two seconds for ten thousand of them; bringing it up to date after
 * a dragged vertex is about a millisecond.
 *
 * Two, because there are two: the level, which is what collision and the walls
 * are made of, and the floor, which is drawn flat and takes part in nothing.
 * They are kept apart rather than tagged and mixed because they are separate
 * questions — a pillar does not cut a floor and a hole in a floor does not cut
 * a room — and because keeping them apart is what makes each of them a set
 * `worldset` already knows how to answer.
 */
export interface Live {
  level: WorldSet
  floor: WorldSet
  /** What each contributor resolved to when the sets were last brought up to
   * date. A group with a depth on it is one of them; its members are not. */
  seen: Map<Id, Contributed>
}

/** An empty set of each, each knowing the shape of the set it is. */
export const emptySet = (set: SetName): WorldSet =>
  emptyWorldSet(SLOTS[set], on => inside(set, on));

export const EMPTY_LIVE: Live = {
  level: emptySet('level'),
  floor: emptySet('floor'),
  seen: new Map(),
};

export function runs(l: Live): Point[][] {
  return outline(l.level);
}

export function floorRuns(l: Live): Point[][] {
  return outline(l.floor);
}

/**
 * The same runs, each carrying whether the boundary turns at each of its
 * points.
 *
 * What the walls need and what `runs` throws away. The answer comes off the
 * CSG rather than off the runs, because it is a question about a polygon and
 * its neighbours — see `cornering` in `geometry.ts` — and the bake is handed
 * the very same answer, so the walls standing still and the walls in flight
 * agree about every vertical.
 */
export function sourced(l: Live): { points: Point[], corner: boolean[] }[] {
  return pieces(l.level).map(p => ({ points: p.points, corner: p.corner }));
}

/**
 * The sets brought up to date against `items`, doing only the work the
 * differences call for.
 *
 * `resolveAt` builds fresh arrays every time, so what changed cannot be read
 * off object identity and is compared point by point instead. That costs one
 * pass over the geometry, which is the same order as resolving it — and far
 * less than rebuilding the set for a world where nothing moved.
 *
 * A polygon that changes which set it is in is a removal from one and an
 * insertion into the other, which falls out of doing this per set: it is
 * missing from the one and unknown to the other, and neither has to be told
 * that a retype is what happened.
 */
export function live(previous: Live, items: readonly Contributed[]): Live {
  const seen = new Map<Id, Contributed>();
  const edits = new Map<SetName, SetEdit[]>([['level', []], ['floor', []]]);

  for (const it of items) {
    seen.set(it.id, it);

    const was = previous.seen.get(it.id);
    const moved = was === undefined || !unmoved(was.shape, it.shape);
    const retyped = was !== undefined && !sameKind(was.kind, it.kind);

    // Each set on its own, because one kind can be in both: a void cutting the
    // solids and the floors alike is a member of each, under the same id and
    // in slots that have nothing to do with one another. The two sets are two
    // id spaces, so there is nothing to tell apart.
    for (const set of SETS) {
      const slot = slotOf(it.kind, set);
      const before = was === undefined ? null : slotOf(was.kind, set);

      // Gone from this set — a retype that dropped it, or one that never had
      // it. Either way it is removed and nothing is inserted.
      if (slot === null) {
        if (before !== null) edits.get(set)!.push({ op: 'remove', id: it.id });
        continue;
      }

      if (!moved && slot === before) continue;

      // A slot it did not have has to go in as an insert: an update keeps the
      // slot it had.
      // What it keeps through the arrangement goes with it: a pile of flat
      // teeth on one corner is the one thing the boundary cannot find again
      // for itself. See `Member.keep`.
      const keep = it.keep === undefined ? undefined : it.keep.map(p => ('p' in p ? p.p : p));

      edits.get(set)!.push(
        before === null || slot !== before
          ? { op: 'insert', id: it.id, slot, shape: it.shape, simple: it.simple, keep }
          : { op: 'update', id: it.id, shape: it.shape, simple: it.simple, keep },
      );
    }
  }

  for (const [id, was] of previous.seen) {
    if (seen.has(id)) continue;

    for (const set of SETS) {
      if (slotOf(was.kind, set) !== null) edits.get(set)!.push({ op: 'remove', id });
    }
  }

  const level = edits.get('level')!, floor = edits.get('floor')!;

  if (level.length === 0 && floor.length === 0) return previous;

  return {
    level: level.length === 0 ? previous.level : edited(level)(previous.level),
    floor: floor.length === 0 ? previous.floor : edited(floor)(previous.floor),
    seen,
  };
}

function unmoved(a: Shape, b: Shape): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;

  for (let r = 0; r < a.length; r++) {
    const p = a[r], q = b[r];

    if (p.length !== q.length) return false;

    for (let i = 0; i < p.length; i++) {
      if (p[i].x !== q[i].x || p[i].y !== q[i].y) return false;
    }
  }

  return true;
}

/** The topmost polygon under a point, hit against what is on screen. */
export function hitPolygon(items: Resolved[], at: Point): PolygonId | null {
  return hitPolygons(items, at)[0] ?? null;
}

/** Every polygon under a point, topmost first, which is what clicking through
 * a stack of them needs. */
export function hitPolygons(items: Resolved[], at: Point): PolygonId[] {
  const out: PolygonId[] = [];

  for (let i = items.length - 1; i >= 0; i--) {
    if (contains(standingFor(items[i]), at)) out.push(items[i].id);
  }

  return out;
}

/**
 * The shape a click is tested against: the projection, or the source ring
 * where the projection is empty.
 *
 * A polygon eroded away has nothing on screen and nothing to click, and being
 * unpickable is how it stays that way for good — there is no gesture that
 * takes the depth back off a shape that cannot be selected. So the source ring
 * stands in for it, and the drawing puts that ring on screen for exactly the
 * same shapes: what can be picked is what is drawn, which is the rule
 * everywhere else too.
 */
function standingFor(it: Resolved): Shape {
  return it.shape.length === 0 ? sliced(it.source, it.rings) : it.shape;
}

/**
 * What a click lands on, topmost first: the things it could pick, tested
 * against the shapes they are drawn as.
 *
 * A shut group is one outline — its members' union, eroded by its own depth —
 * and that outline is what has to answer, not the members underneath it. They
 * are not eroded; the group is. Test them and a group eroded well inward is
 * still picked from anywhere inside the rings it was made of, which is a long
 * way outside anything on screen.
 *
 * Walked in draw order and reversed, so a group answers from where its topmost
 * member is in the stack and the reaching stays in step with what is painted
 * over what. A group is asked once however many members lead to it: the answer
 * cannot differ, it being one shape.
 *
 * Everything out of reach is skipped, which with a group open is everything
 * outside it. It is drawn, so that it can be seen where the work is going, but
 * it is not there to be clicked on.
 */
export function hitting(
  world: World,
  v: KeyframeId,
  items: readonly Resolved[],
  path: readonly GroupId[],
  at: Point,
): Id[] {
  const shut = new Map(occupying(world, v, items, path).map(o => [o.id, occupiedShape(o)]));
  const asked = new Set<Id>();
  const out: Id[] = [];

  const open = path[path.length - 1] ?? null;

  // The source union, for the groups that eroded away to nothing. Taken once
  // and only where one has, since it is a second union over every member of
  // every shut group. A group standing at a depth that leaves nothing is
  // otherwise unpickable for good, the same trap `standingFor` keeps a polygon
  // out of, and its source ring is on screen for the same reason.
  let source: Map<GroupId, Shape> | null = null;

  const drawn = (id: Id, it: Resolved): Shape => {
    const shape = shut.get(id);

    if (shape !== undefined && shape.length !== 0) return shape;

    // A polygon standing for itself answers with its own ring; a group has to
    // answer with the union, and cannot be left to answer with the member this
    // pass happens to be looking at — every member maps to the one id, and the
    // first of them to be asked is the only one that gets to.
    if (id === it.id) return standingFor(it);

    source ??= new Map(
      occupyingSource(world, v, items, path).map(o => [o.id, occupiedShape(o)]),
    );

    return source.get(id as GroupId) ?? shape ?? [];
  };

  for (let i = items.length - 1; i >= 0; i--) {
    if (!reachable(world, items[i].id, open)) continue;

    const id = reaching(world, items[i].id, path);

    if (asked.has(id)) continue;

    asked.add(id);

    if (contains(drawn(id, items[i]), at)) out.push(id);
  }

  return out;
}

/**
 * The nearest source vertex within `radius` world units, topmost first.
 *
 * The source ring, never the projection. The eroded outline carries no handles
 * at all and there is no gesture that pretends it does — it is derived
 * geometry, in the same sense the CSG result is, and nobody expects to drag
 * that either.
 */
export function hitVertex(
  on: readonly Handle[],
  at: Point,
  radius: number,
): Grabbed | null {
  let best: Grabbed | null = null;
  let bestDistance = radius;

  for (const h of on) {
    const d = Math.hypot(h.at.x - at.x, h.at.y - at.y);

    if (d <= bestDistance) {
      bestDistance = d;
      best = { id: h.id, index: h.index, vertex: h.vertex };
    }
  }

  return best;
}

/** One corner of one polygon: where it is in the ring, and which corner it is.
 * The index moves when a corner is inserted before it; the id never does. */
export interface Grabbed {
  id: PolygonId
  index: number
  vertex: VertexId
}

/**
 * The nearest point of a source edge within `radius`, and which edge it is on.
 *
 * `index` is the corner the edge leaves, so what gets inserted for this hit
 * goes directly after it. Callers are expected to have asked `hitVertex` first
 * and taken its answer: every corner lies on two edges, and a click on one
 * means the corner rather than either edge.
 */
export function hitEdge(
  items: Resolved[],
  at: Point,
  radius: number,
): { id: PolygonId, index: number, at: Point } | null {
  let best: { id: PolygonId, index: number, at: Point } | null = null;
  let bestDistance = radius;

  for (const it of items) {
    const ring = it.source;

    for (let i = 0; i < ring.length; i++) {
      const on = along(ring[i], ring[nextOf(it.rings, ring.length, i)], at);
      const d = Math.hypot(on.x - at.x, on.y - at.y);

      if (d <= bestDistance) {
        bestDistance = d;
        best = { id: it.id, index: i, at: on };
      }
    }
  }

  return best;
}

/** Every corner inside the box, by id, which is what a marquee over the points
 * is asking for. */
export function verticesWithinBox(on: readonly Handle[], a: Point, b: Point): VertexId[] {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);

  return on
    .filter(h => h.at.x >= x0 && h.at.x <= x1 && h.at.y >= y0 && h.at.y <= y1)
    .map(h => h.vertex);
}

// -----------------------------------------------------------------------------
// What a thing is on screen as
// -----------------------------------------------------------------------------

export function painted(world: World, v: KeyframeId, id: Id, items?: readonly Resolved[]): Painted {
  const frame = stateAt(world, id, v).frame;
  const ref = unplace(worldFrame(world, id, v), middleOf(world, v, id, items));

  return { ref, at: placed(frame, ref), frame, held: under(world, v, id) };
}

/**
 * The middle of what a thing is on screen as, at a keyframe.
 *
 * A group is what it is drawn as, shut: the union its members make, with
 * whatever is held inside it. A lone polygon is its own outline, and an
 * artefact is its point.
 *
 * `all` is the keyframe resolved, where the caller has it already: a gesture
 * over a selection asks this once for everything picked.
 */
export function middleOf(
  world: World,
  v: KeyframeId,
  id: Id,
  all: readonly Resolved[] = resolveAt(world, v),
): Point {
  if (world.artefacts.has(id)) return placeAt(world, id, v) ?? { x: 0, y: 0 };
  if (world.paths.has(id)) return middle(pathAt(world, id, v) ?? []);

  const reached = new Set(polygonsIn(world, [id]));
  const items = all.filter(it => reached.has(it.id));
  const open = opened(world, parentOf(world).get(id) ?? null);

  const places = artefactsIn(world, [id]).flatMap(a => {
    const at = placeAt(world, a, v);

    return at === null ? [] : [at];
  });

  const walks = pathsIn(world, [id]).flatMap(p => pathAt(world, p, v) ?? []);
  const drawn = items.length === 0 ? [] : outlining(world, v, items, open);

  return middle([...drawn, ...places, ...walks]);
}
