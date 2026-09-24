// -----------------------------------------------------------------------------
// Resolving a group: the union its members make, turned into polygons
//
// A group is a read. What it puts into the level is the union of what its
// members produced, offset by its own depth, and nothing is ever written back
// into the members — which is what makes a group cheap to author and impossible
// to edit. There are no handles on a union. The corner where two rooms meet is
// a corner of neither of them, so there is nothing there to drag.
//
// Resolving turns that read into geometry: the union is worked out, and the
// rings it came out as become polygons with corners of their own.
//
// Read once, at the keyframe in front of you
// ------------------------------------------
// The union is taken at one keyframe and that is the shape, at every keyframe
// the geometry stood at. What the members were doing at any *other* keyframe is
// gone, and what was written about them goes with them.
//
// This was not always so, and the thing it replaced was much larger. A point of
// a union is a name rather than a position — `boundaryRuns` hands back every
// point as either a corner of one member's outline or the crossing of two
// members' edges, named in the members' own terms — so the union can be taken
// once per version and the readings matched up by name. Corners then carry
// their identity across the whole chain: a member moved at v4 keeps its
// corners, one deleted takes them out, two that start overlapping bring a
// crossing into being. It worked, and the tests for it passed.
//
// It was still the wrong thing to build, because of what it could not carry. A
// version's transform is one transform for a whole polygon, and the union of
// members that move *differently* has no such thing. So a member turned on its
// own came out as corners that had each happened to move, and a displacement is
// interpolated straight: a ring of rooms each spinning about its own middle
// resolved to a polygon whose corners cut across the arcs they used to travel.
// The lineage was exact and the motion was a lie, which is a worse thing to
// hand somebody than nothing — it looks like it worked.
//
// So it does the simple thing and says so. `losing` names the keyframes whose
// entries are about to stop meaning anything, and it is the caller's business
// to put that in front of whoever asked before doing it.
//
// What is kept
// ------------
// The group's own timeline, all of it. Its turns stay turns, so a group that
// turns still turns through its arc rather than becoming corners that moved;
// its depth stays a depth, unbaked, so an author who resolves a corridor and
// then wants another unit of wall can still say so. Only what the *members*
// were doing separately is lost, which is exactly the part that had nowhere to
// go.
//
// Nor is this an entry. Every other edit here lands in one keyframe and plays
// from there; this one rewrites every keyframe, because the thing it replaces
// spans them all. Undo is what takes it back.
//
// What comes out
// --------------
// The set the group makes, and the floors clipped to it. Nothing else.
//
// A group holding a room and a pillar is not two shapes that happen to be
// grouped; it is a room with a pillar in it, and what it puts into the level is
// `level - solid`. So that is the one thing resolving produces on that side,
// and a solid is a hole in it rather than a polygon of its own. Which is the
// whole reason a polygon can have more than one ring — see `Vertex.ring` in
// `types.ts`.
//
// Nothing is left over. A pillar reaching out past the room it was in was also
// cutting the rooms *around* the group, and that goes with it: the price of
// the shape being one shape, and the shape being one shape is what resolving
// is. Where there is no room at all — a group of nothing but pillars — the
// pillars are the outermost thing, and what comes out is pillars with their
// voids as holes in them: `solid - void`, which is what such a group is.
//
// A floor is in no level — see `filling` in `bake.ts` — so it neither cuts the
// walls nor is cut by them, and it is resolved as a set of its own: floors
// added, floor holes taken back out. What comes out is that set intersected
// with the level, `(floor - hole) and (level - solid)`. A floor reaching past
// the walls or across a pillar is a floor drawn where there is no room, and it
// was only ever invisible because a wall stood in front of it. Resolving is
// where that stops being true.
//
// A group with no level at all keeps its floor whole. There is nothing there
// for the clip to mean, and a gesture that emptied such a group would be
// resolving it out of existence.
// -----------------------------------------------------------------------------

import { PolygonKind, SLOTS, SLOT_KINDS, SetName, inside, slotOf } from '@ce/game/world';
import {
  Member,
  Point,
  Ring,
  Whence,
  Whither,
  boundaryRuns,
  contains,
  ground,
} from './geometry';
import {
  Contributed,
  Landing,
  // This file has a `Named` of its own — a point of a boundary run — so the
  // scope's is taken under a name that says whose it is.
  Named as Published,
  chain,
  contributed,
  depths,
  groupEffects,
  groupFrame,
  joined,
  keyAt,
  order,
  outermostOf,
  resolveAt,
  rigOf,
  standingIn,
  underfoot,
  ungrouping,
  unplace,
  keyRigOf,
} from './scene';
import { AmountKind, EMPTY_RIG, Entry, KeyRig, Rig, amountedBy, keysOf, nextKey, once, stateAt } from './rig';
import { cornerRound } from './effects';
import {
  GroupId,
  Id,
  Options,
  PolygonId,
  KeyframeId,
  VertexId,
  Unrolled,
  Vertex,
  World,
  within,
} from './types';

// -----------------------------------------------------------------------------
// The union, as rings
//
// `boundaryRuns` gives one polygon's share of a boundary as open runs, never as
// closed loops — deliberately, and the header of `worldset.ts` says why. Here
// they have to be closed, because a ring is what a polygon is.
// -----------------------------------------------------------------------------

/** One corner of the union: where it is, and what the arrangement calls it. */
interface Named {
  at: Point
  key: string
}

type NamedRing = Named[];

/**
 * A boundary point as a name.
 *
 * Only ever compared against other points of the same reading, so where each
 * corner sits in the shape it came off is name enough. What it is for is the
 * join: a run ends where the boundary leaves the polygon it belongs to and
 * carries on into somebody else's, and both readings of that junction name it
 * identically, because it is one crossing of one pair of edges seen from either
 * side. So the join needs no tolerance at all, which a join by coordinate
 * would.
 */
function named(w: Whither): string {
  const of = (p: Whence): string => `${p.id}:${p.ring}:${p.index}`;

  return w.kind === 'vertex'
    ? `v${of(w.at)}`
    // Sorted, so that A crossing B and B crossing A are one crossing: the
    // arrangement does not promise which way round it saw them.
    : `x${[of(w.a), of(w.b)].sort().join('|')}`;
}

/** Twice the signed area, which is what says which way a ring is wound. */
function signed(ring: Ring): number {
  let sum = 0;

  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];

    sum += a.x * b.y - b.x * a.y;
  }

  return sum;
}

/**
 * Runs joined end to end into closed rings.
 *
 * A run whose two ends have the same name is already a ring: a member nothing
 * overlaps contributes its whole outline in one piece.
 *
 * The one junction a name does not settle is two members' corners standing on
 * the same spot, which is what two rooms sharing an edge exactly do at either
 * end of it. A corner lying along somebody else's edge is named after the
 * corner from both sides, but a corner lying on another corner is two
 * corners, and each side names it after its own — so the run ending at one
 * found nothing starting there and closed on itself, and two rooms side by
 * side resolved to a triangle each. A corner is where it was drawn, bit for
 * bit, so where the name finds nothing the corner's position is still a join
 * with no tolerance in it. The name is asked first, so that two rooms
 * touching at one corner stay two rings rather than one pinched through it.
 */
function stitched(runs: readonly NamedRing[]): NamedRing[] {
  const from = new Map<string, NamedRing[]>();
  const at = new Map<string, NamedRing[]>();
  const spot = (p: Named): string => `${p.at.x},${p.at.y}`;

  for (const run of runs) {
    const head = run[0];

    (from.get(head.key) ?? from.set(head.key, []).get(head.key)!).push(run);

    if (head.key.startsWith('v')) (at.get(spot(head)) ?? at.set(spot(head), []).get(spot(head))!).push(run);
  }

  const used = new Set<NamedRing>();
  const out: NamedRing[] = [];

  for (const run of runs) {
    if (used.has(run)) continue;

    const ring: Named[] = [];

    let go: NamedRing | undefined = run;

    while (go !== undefined && !used.has(go)) {
      used.add(go);
      // Every run's last point is the next one's first. Dropping it here is
      // what leaves the ring closed rather than doubled at every junction.
      ring.push(...go.slice(0, -1));

      const tail: Named = go[go.length - 1];

      // Back where it started, which the name-by-position below would not
      // otherwise notice: it would carry on into whatever else begins there.
      if (tail.key === ring[0].key) break;

      go = from.get(tail.key)?.find(n => !used.has(n))
        ?? (tail.key.startsWith('v') ? at.get(spot(tail))?.find(n => !used.has(n)) : undefined);
    }

    if (ring.length >= 3) out.push(ring);
  }

  return out;
}

/**
 * The outermost slot of `set` anything in `items` fills, or nothing where
 * nothing does: what the union of them *is*, the same way a sealed group is
 * whatever its outermost member is. See `outermostSlot` in `scene.ts`.
 */
export function outermostIn(items: readonly Contributed[], set: SetName): number | null {
  return outermostOf(items.filter(it => it.shape.length > 0).map(it => it.kind), set);
}

/**
 * One set's union, as closed rings in world units.
 *
 * Folded from the outermost slot anything fills rather than from the first. A
 * group of pillars with holes in them is `solid - void`, and that is a shape
 * whether or not there is a room for it to stand in.
 */
export function rings(items: readonly Contributed[], set: SetName): NamedRing[] {
  const top = outermostIn(items, set);

  if (top === null) return [];

  const mine: Member[] = [];

  for (const it of items) {
    const slot = slotOf(it.kind, set);

    // The other set is another question entirely: a pillar does not cut a
    // floor and a hole in a floor does not cut a room.
    if (it.shape.length === 0 || slot === null) continue;

    mine.push({ id: it.id, slot: slot - top, shape: it.shape });
  }

  // The slots above the outermost are dropped, and the rule for what is left
  // is the same rule: each slot taken out of the one before it. From the first
  // slot that is `inside` itself.
  const slots = SLOTS[set] - top;
  const rule = top === 0
    ? (on: readonly boolean[]) => inside(set, on)
    : (on: readonly boolean[]) => alternating(on, 0);
  const on = ground(mine, slots);
  const out: NamedRing[] = [];

  // Every member, solids and voids included: the edge of a hole lies on the
  // polygon that cut it, so a solid owns its share of the boundary exactly as
  // a room owns its own. This is `worldset` asked about one neighbourhood.
  for (const m of mine) {
    for (const run of boundaryRuns(m, mine.filter(o => o.id !== m.id), slots, rule, on)) {
      out.push(run.points.map((p, i) => ({ at: p, key: named(run.whence[i]) })));
    }
  }

  return stitched(out);
}

/** Slot `k` taken out of by everything after it, the way `inside` folds. */
function alternating(on: readonly boolean[], k: number): boolean {
  return k < on.length && on[k] && !alternating(on, k + 1);
}

/**
 * The group's floor set, clipped to the ground it just worked out.
 *
 * A floor is a fill drawn where the level is, and a floor reaching out past the
 * walls or across a pillar is a floor drawn where there is no room — which is
 * only ever invisible because a wall stands in front of it. Resolving is where
 * that stops being true, since what comes out is meant to be the shape rather
 * than the parts it was made of.
 *
 * `(floor - hole) and (level - solid)`, so the pillars appear in the floor as
 * they do in the walls, and so do the holes cut in the floor itself. The first
 * half comes through the same `rings` the walls do, because it is the same
 * question about a different set; the second is straight out of `intersect`,
 * which hands back an arrangement, and there is nothing there to stitch —
 * the boundary of an intersection is not partitioned by source and does not
 * need to be.
 *
 * Unclipped where there is no ground at all. A group of nothing but floors
 * makes no level, and clipping its floor to that would resolve it away: what
 * is on screen is a floor, so what it resolves to is that floor.
 */
function floors(items: readonly Contributed[], walls: readonly Ring[]): Ring[] {
  return underfoot(rings(items, 'floor').map(ring => ring.map(p => p.at)), [...walls]);
}

// -----------------------------------------------------------------------------
// What the group comes to
// -----------------------------------------------------------------------------

/**
 * One ring of the union: which side of the set it is on, whether it is a hole,
 * and which of this reading's outlines it is a hole in.
 *
 * A hole stays with the outline it is a hole in rather than becoming something
 * taken back out. It is one polygon's second ring, which is what a courtyard
 * is: the union of a ring of corridors is one room with a gap in the middle,
 * and saying it as a room and a pillar would put a wall between them that is
 * not anywhere.
 */
interface Reading {
  kind: PolygonKind
  hole: boolean
  /** The reading it is a hole in, by index in this same list. */
  owner: number | null
  /**
   * What the fold published about each point of the ring: the corner it was,
   * where it was one of a member's, and the line leaving it. Nothing for a
   * join, or a corner an erosion made — which asks for nothing and takes the
   * ring's own amounts. See `Contributed.named`.
   */
  corners: (Published['corners'][number] | null)[]
  lines: (Published['lines'][number] | null)[]
  ring: Ring
}

/**
 * Which ring of a set is which, in one pass.
 *
 * By area and by containment rather than by winding on its own. A shape read in
 * a frame that mirrors comes back wound the other way from end to end, and the
 * nonzero rule does not mind — an outline at -1 is as filled as one at +1 — so
 * the sign that matters is the one *relative to the biggest ring*, which is an
 * outline whichever way round the frame put it.
 */
function nested(rings: readonly Ring[]): { hole: boolean, owner: number | null }[] {
  const area = rings.map(signed);
  const biggest = area.reduce((b, a, i) => (Math.abs(a) > Math.abs(area[b]) ? i : b), 0);
  const outward = Math.sign(area[biggest]);
  const hole = area.map(a => Math.sign(a) !== outward);

  return rings.map((ring, i) => {
    if (!hole[i]) return { hole: false, owner: null };

    // The tightest outline round it. Tightest rather than first, so a courtyard
    // inside a room inside a courtyard belongs to the room.
    let owner: number | null = null;

    rings.forEach((other, j) => {
      if (hole[j] || !contains([other], ring[0])) return;
      if (owner === null || Math.abs(area[j]) < Math.abs(area[owner])) owner = j;
    });

    return { hole: true, owner };
  });
}

/** A point as a key: a corner of the fold *is* the member's corner, so it is
 * found by where it is and not by what is near it. */
function key(p: Point): string {
  return `${p.x},${p.y}`;
}

/**
 * Which published line a ring edge lies on: the first along it, as the fold
 * itself names its straights.
 *
 * By the line and not by the ends, because the ends are where the union put
 * them. A wall two rooms share starts at a crossing that is neither room's
 * corner, and it is still that member edge's wall — the arrangement cuts
 * edges up and drops the pieces inside, but it never moves one off its line.
 * See `foldShaped`'s `namedBy` and PLAN-bevel 2.2.
 */
function lineAlong(lines: Published['lines'], a: Point, b: Point, scale: number): Published['lines'][number] | null {
  const near = scale * 1e-6;
  const off = (line: { a: Point, b: Point }, p: Point) =>
    Math.abs((p.x - line.a.x) * (line.b.y - line.a.y) - (p.y - line.a.y) * (line.b.x - line.a.x))
      / Math.max(Math.hypot(line.b.x - line.a.x, line.b.y - line.a.y), 1e-300);

  if (a.x === b.x && a.y === b.y) return null;

  return lines.find(line => off(line, a) <= near && off(line, b) <= near) ?? null;
}

/**
 * What the group's members come to, ring by ring, as one version sees them.
 *
 * In the group's own frame, which is what leaves the group's motion on the
 * group. `groupFrame` is the composition `resolveAt` will put back when it
 * walks the chain, so taking the union back through it and letting the group
 * apply it again is the identity — and the rotation stays a rotation, rather
 * than becoming a set of corners that happen to have moved.
 *
 * The group's own depth is not applied. It stays where it was written.
 *
 * Which ring is a hole is decided here, in the frame the corners are written
 * down in, because that is the frame `project` will read their winding in.
 */
function readingAt(world: World, v: KeyframeId, id: GroupId): Reading[] {
  const inside = new Set(within(world, id).filter(m => m !== id));
  const depth = depths(world, v);

  const items = contributed(
    world,
    resolveAt(world, v).filter(it => inside.has(it.id)),
    // The group itself stands, at depth nought: what is asked for is its own
    // fold, bare — its members eroded at their own depths, folded, and
    // rounded and deformed nowhere — with what it would have laid on that
    // fold published beside it. Anything drawn into the ring is geometry a
    // polygon would round and deform all over again; anything published is an
    // amount the ring can carry as its own. See PLAN-bevel's *The resolve
    // carries geometry*.
    //
    // Nought rather than its depth, which the ring takes as an erosion of its
    // own further down, so that the names come back on the points the ring
    // actually has.
    //
    // A sealed group nested inside it stands for its members, exactly as it
    // does for the CSG: its shape is a real shape and pulling it apart here
    // would resolve it too, which is not what was asked. Bare reaches it too,
    // so its own round and deform are published rather than drawn.
    g => {
      // The scope itself stands and lays nothing: what is wanted is the union
      // of its members *drawn*, and the scope's own amounts go onto the ring
      // as the ring's own, where the same fold lays them again. A member is
      // drawn and not published — that is the whole of `PLAN-effect` — so
      // everything under it reads as it does anywhere else.
      if (g === id) return { depth: 0 };
      if (!inside.has(g)) return null;

      return world.groups.get(g)?.sealed === true ? { depth: depth.get(g) ?? 0, effects: groupEffects(world, v, g) } : null;
    },
  );

  const frame = groupFrame(world, v, id);
  const out: Reading[] = [];

  // The set the group makes, and the floor set clipped to it. Two sides rather
  // than four: what a pillar contributes is a hole in the level, and once it is
  // one there is nothing of the pillar left to be. A pillar sticking out past
  // the room it was in goes with it — it was cutting the rooms *around* the
  // group as well, and that is what resolving to one shape costs.
  const walls = rings(items, 'level').map(ring => ring.map(p => p.at));
  const level = outermostIn(items, 'level');
  const floor = outermostIn(items, 'floor');

  // Each comes out as the outermost kind of its set: what a pillar contributed
  // is a hole in the level and what a void contributed is a hole in that hole,
  // and once either is a ring of the shape there is nothing left for it to cut.
  // Where there is no room, the pillars are the outermost thing, and they come
  // out as pillars with their holes in them.
  //
  // The floor is clipped only to a level. A solid is something standing in a
  // room, not the room a floor is laid in, so a group that is one keeps its
  // floor whole, as the scope it resolves does. See `resolves` in `scene.ts`.
  /** What the contributions of one set published, together. */
  const namesIn = (set: SetName): Published => items
    .filter(it => slotOf(it.kind, set) !== null && it.named !== undefined)
    .reduce(
      (all, it) => ({ lines: [...all.lines, ...it.named!.lines], corners: [...all.corners, ...it.named!.corners] }),
      { lines: [], corners: [] } as Published,
    );

  const sides: [PolygonKind, readonly Ring[], Published][] = [
    [SLOT_KINDS.level[level ?? 0], walls, namesIn('level')],
    [
      SLOT_KINDS.floor[floor ?? 0],
      level === 0 ? floors(items, walls) : rings(items, 'floor').map(ring => ring.map(p => p.at)),
      namesIn('floor'),
    ],
  ];

  for (const [kind, side, names] of sides) {
    // Matched where the fold left them, in world units, before the ring goes
    // into the group's frame: a corner of the fold *is* the member's corner,
    // and a line runs from one to the next, so both are found by the point.
    const corner = new Map(names.corners.map(c => [key(c.at), c] as const));

    let scale = 1;

    for (const ring of side) for (const p of ring) scale = Math.max(scale, Math.abs(p.x), Math.abs(p.y));

    // Into the group's frame first, since that is where the winding is read.
    const mine = side.map(ring => ring.map(p => unplace(frame, p)));
    const how = nested(mine);
    const base = out.length;

    mine.forEach((ring, i) => out.push({
      kind,
      hole: how[i].hole,
      owner: how[i].owner === null ? null : base + how[i].owner!,
      ring,
      corners: side[i].map(p => corner.get(key(p)) ?? null),
      lines: side[i].map((p, k) => lineAlong(names.lines, p, side[i][(k + 1) % side[i].length], scale)),
    }));
  }

  return out;
}

// -----------------------------------------------------------------------------
// The gesture
// -----------------------------------------------------------------------------

export interface Resolution {
  world: World
  /**
   * What to pick afterwards: the polygons the union came to, each its own
   * thing.
   *
   * Several, because a union is not one shape. Two rooms that do not touch
   * union to two rings, and a room with a pillar in it to a ring on each side
   * of the set — and the whole point of resolving is to be able to get at them,
   * so handing them back held together in a group would be the gesture
   * pretending to have happened.
   *
   * The group itself, in the one case it could not be taken apart: see
   * `resolveGroup`.
   */
  ids: Id[]
  /**
   * The keyframes whose entries are about to stop saying anything — every
   * keyframe but the one it was read at that had written something about a
   * member.
   *
   * Not an error and not a refusal. It is the one thing about this that cannot
   * be seen by looking at the result, so it is handed back to be asked about.
   * Empty is the ordinary case: a group nobody has animated resolves with
   * nothing lost at all.
   */
  losing: KeyframeId[]
  /** The repeats taking the group apart turned into single entries. See
   * `carried` in `scene.ts`. */
  unrolled: Unrolled[]
}

/**
 * A group replaced by the polygons its union comes to at version `v`.
 *
 * Nothing where there is nothing to do — no such group, or nothing under it
 * with any geometry. The group's artefacts stay members: an artefact is a place
 * and has nothing to do with a union.
 *
 * The group survives where there is more than one ring, because there is then
 * something for it to hold and somewhere for its layers to go. Where the union
 * came to one ring it does not: a group of one is a level of structure that
 * says nothing, so its layers are hoisted onto the polygon, which reads them in
 * exactly the frame the group read them in.
 */
export function resolveGroup(world: World, v: KeyframeId, id: GroupId): Resolution | null {
  const group = world.groups.get(id);

  if (group === undefined) return null;

  // Bare, always. A scope lays one round and one deform on the *union*, so
  // the ring carries those as amounts and draws them itself — which is what
  // `publishing` writes down. A scope laying nothing of its own still folds,
  // and still hands its members' amounts on; see `shapeKey`.
  const readings = readingAt(world, v, id);

  // Every version any of the geometry is there at, rather than every version
  // the *group* is there at.
  //
  // A group made at v1 out of rooms drawn at v0 does not un-draw them —
  // grouping is a handle appearing, which is why `removals` reads a holder's
  // death and never its birth — so those rooms stand at v0 with nothing holding
  // them, and what replaces them has to stand there too.
  const geometry = within(world, id).filter(m => world.polygons.has(m));

  const standing = world.keyframes
    .map(k => k.id)
    .filter(k => {
      const from = new Set(chain(world, k));

      return geometry.some(m => standingIn(world, m, from));
    });

  if (standing.length === 0) return null;

  // Everything under the group that was geometry. It goes entirely rather than
  // dying at a keyframe: what replaces it stands at every keyframe it stood at,
  // so leaving it would draw the same rooms twice.
  //
  // Geometry, and nothing else. An artefact is a place and a path is a walk,
  // and neither has anything to do with a union — nothing of theirs went into
  // one and none of it is lost by taking one, so a resolve has no business
  // touching either. They came out here because `within` reaches everything,
  // and the artefact was arriving with its moves deleted and `losing` naming
  // keyframes that were losing nothing.
  const aside = (m: Id): boolean => world.artefacts.has(m) || world.paths.has(m);

  const gone = new Set<Id>(within(world, id).filter(m => m !== id && !aside(m)));
  const kept = group.members.filter(aside);

  const polygons = new Map(world.polygons);
  const groups = new Map(world.groups);
  const rigs = new Map(world.rigs);

  // Everything written about a member goes with the member. What it said is
  // not recoverable as an operation on the union — that is the whole of why
  // this reads one keyframe — and leaving it written would be a timeline naming
  // something no longer in the world.
  for (const m of gone) {
    polygons.delete(m);
    groups.delete(m);
    rigs.delete(m);
  }

  const born = standing[0];
  const last = order(world, standing[standing.length - 1]);
  const death = keyAt(world, last + 1);

  // One block of ids, so a polygon's corners are the numbers after it — which
  // is what `addPolygon` does and what anything reading a saved file expects.
  let next = world.nextId;
  const made: PolygonId[] = [];

  // An outline and the holes in it are one polygon. A hole whose outline is not
  // here — which the geometry cannot produce, since a hole needs something to
  // be a hole in — would otherwise be a ring nobody draws.
  //
  // None of them at all is an answer, not a refusal. A room swallowed by the
  // pillar standing in it makes no set, so what it resolves to is nothing, and
  // it goes. Anything else would be a gesture that did what it said on some
  // groups and quietly declined on others.
  /** What each new corner was told about itself, to be written down once the
   * polygons are in: see `publishing`. */
  const told: {
    id: PolygonId
    corner: VertexId
    was: Reading['corners'][number]
    line: Reading['lines'][number]
    /** The edge leaving it, which is what its own anchor is read off. */
    from: Point
    to: Point
  }[] = [];

  for (const outer of readings.filter(r => !r.hole)) {
    const parts = [outer, ...readings.filter(r => r.hole && readings[r.owner!] === outer)];
    const mine = next;
    const points: Vertex[] = [];

    parts.forEach((part, ring) => {
      part.ring.forEach((at, i) => {
        const corner = ++next;
        const to = part.ring[(i + 1) % part.ring.length];

        points.push({ id: corner, at, ring, birth: born, death });
        told.push({ id: mine, corner, was: part.corners[i], line: part.lines[i], from: at, to });
      });
    });

    polygons.set(mine, { ...outer.kind, birth: born, death, points });
    made.push(mine);
    next++;
  }

  // The group's depth, written onto every ring as it goes: an erosion at every
  // keyframe it changes at, adding up to what the group's was.
  //
  // This is the one thing an ordinary ungroup cannot carry and this one can.
  // A group's depth offsets the *union* of what its members produced, so once
  // the members are back to being members there is no union for it to be about
  // and the fold drops it. Here each ring already is that union, so a depth on
  // the ring means exactly what the group's meant.
  //
  // The depth as the group had it, never the other way about. `contributed` has
  // to flip the sign on what a group takes away — erode(A - B, d) = erode(A,
  // d) - erode(B, -d) — and that flip has already happened here: every ring out
  // of `readingAt` is added, holes included, so every one of them erodes
  // inward.
  //
  // Its rounds and deforms go the same way, and its effects with them: the
  // ring is the union they rounded and deformed.
  const eroding = new Map<KeyframeId, readonly Entry[]>();
  const fx = world.effects.get(id);
  let was = { erosion: 0, bevel: 0, amplitude: 0 };

  for (const k of standing) {
    const state = stateAt(world, id, k);
    const now = {
      erosion: depths(world, k).get(id) ?? 0,
      bevel: fx === undefined ? 0 : state.bevel,
      amplitude: fx === undefined ? 0 : state.amplitude,
    };
    const list: Entry[] = [];

    if (now.erosion !== was.erosion) list.push(once({ kind: 'erode', by: now.erosion - was.erosion }));
    if (now.bevel !== was.bevel) list.push(once({ kind: 'round', by: now.bevel - was.bevel }));
    if (now.amplitude !== was.amplitude) list.push(once({ kind: 'deform', by: now.amplitude - was.amplitude }));
    if (list.length > 0) eroding.set(k, list);

    was = now;
  }

  const effects = new Map(world.effects);

  for (const m of made) {
    const rig: Rig = { ...EMPTY_RIG, keys: eroding };

    if (eroding.size > 0) rigs.set(m, keysOf(rig));
    // The ring's teeth are a fold's: they start at each run's middle, where a
    // polygon's start off it by a share of the spacing. Written down here
    // because the ring is a polygon from now on and nothing else would say
    // so. See `Effects['deform'].offset`.
    if (fx !== undefined) effects.set(m, fx.deform === undefined ? fx : { ...fx, deform: { ...fx.deform, offset: false } });
  }

  // The rings go in where the members were, and the group comes apart round
  // them. Everything the group's own timeline was doing is carried onto them
  // by `ungrouped`, which is the one piece of this that already existed and the
  // reason the group is used as scaffolding rather than dismantled by hand.
  groups.set(id, { ...group, members: [...made, ...kept] });

  // What the scope itself was asking for at the keyframe the ring was read
  // at, which its rig carries: what a published amount is *over*.
  const here = fx === undefined ? { bevel: 0, amplitude: 0 } : stateAt(world, id, v);

  // Nothing to publish any more. A member drew its own effects into the ring
  // this became, so there is no amount of its to be written down over the
  // scope's — which is what `publishing` was for and what `PLAN-effect` step 8
  // takes out with the rest of the machinery. What the ring carries is the
  // scope's own, above, and the same fold lays it again.
  const held = { ...world, polygons, groups, rigs, effects, nextId: next };

  // Taken apart, so that what came out is pickable one ring at a time. It is
  // the whole reason to resolve: a union you cannot get at is the group you
  // already had.
  //
  // Refused only where coming apart would not leave everything where it was,
  // which no frame gives it cause to — a group's shear on what it held goes
  // into their skews. Should it ever be, the group stays, and what is handed
  // back says so.
  const apart = ungrouping(held, id);

  return {
    world: apart?.world ?? held,
    ids: apart === null ? [id] : made,
    unrolled: apart?.unrolled ?? [],
    losing: world.keyframes
      .map(k => k.id)
      .filter(k => k !== v && [...gone].some(m => written(keyRigOf(world, m), k))),
  };
}

/**
 * What the fold published, written onto the ring it became.
 *
 * A scope lays one round and one deform on amounts its members publish — a
 * bevel per corner, an amplitude and options per edge — and the ring it hands
 * back is bare, so the polygon that ring becomes has to be told the same
 * amounts if it is to draw the same outline. What is written is what the
 * member asked for *over* the scope's, since the scope's own is on the
 * polygon already as its own amount: a corner both rounded draws the sum
 * either way.
 *
 * A point the fold named nothing about — a join between two members, a corner
 * an erosion made — is outline like the rest and takes the polygon's own. The
 * one exception is a run no line named at all, which the fold gives no teeth:
 * it is written down as the amplitude taken back off, so that the polygon
 * lays none there either.
 *
 * See PLAN-bevel's *The resolve carries geometry*.
 */
function publishing(
  held: World,
  world: World,
  born: KeyframeId,
  told: readonly {
    id: PolygonId
    corner: VertexId
    was: Reading['corners'][number]
    line: Reading['lines'][number]
    from: Point
    to: Point
  }[],
  scope: { bevel: number, amplitude: number },
): World {
  const cornerEffects = new Map(held.cornerEffects);
  const rigs = new Map(held.rigs);
  const amounts = new Map<PolygonId, KeyRig>();

  /** One corner's amount of one kind, added to what its polygon's rig says. */
  const amounted = (id: PolygonId, kind: AmountKind, corner: VertexId, by: number) => {
    if (by === 0) return;

    const rig = amounts.get(id) ?? keyRigOf(held, id);

    amounts.set(id, amountedBy(rig, nextKey(rig), kind, corner, born, by));
  };

  /** A corner's own options for an effect, where they are not what its
   * polygon would have given it anyway. */
  const optioned = <N extends keyof Options>(id: PolygonId, corner: VertexId, name: N, option: Options[N] | undefined) => {
    const mine = held.effects.get(id)?.[name];

    if (option === undefined || same(option, mine)) return;

    cornerEffects.set(corner, { ...cornerEffects.get(corner), [name]: option });
  };

  /** How far along `from` → `to` a point sits, projected onto it. */
  const along = (p: Point, from: Point, to: Point): number => {
    const dx = to.x - from.x, dy = to.y - from.y, l = Math.hypot(dx, dy);

    return l === 0 ? 0 : ((p.x - from.x) * dx + (p.y - from.y) * dy) / l;
  };

  for (const { id, corner, was, line, from, to } of told) {
    if (was !== null) {
      amounted(id, 'round', corner, was.bevel - scope.bevel);

      // Not the options it asked for but the count the fold actually drew it
      // in, written down as a count. The ring carries the summed bevel as an
      // amount, and a precision at that sum is not what was drawn — the fold
      // facets a corner its member gave no options for in the scope's own
      // count, whatever the sum comes to. A count is what says that, which is
      // the whole of why `Effects['round'].facets` is there.
      // The count, and something to fall back on past the bevel it was taken
      // at: the options the member published where it published any, and the
      // ring's own — the scope's, which is what faceted this corner — where
      // it did not. A precision of nought would chamfer.
      const mine = held.effects.get(id)?.round;

      optioned(id, corner, 'round', was.facets === undefined ? undefined : {
        precision: was.round?.precision ?? mine?.precision ?? 0,
        tension: was.round?.tension ?? mine?.tension ?? was.facets.tension,
        chamfer: was.round?.chamfer ?? mine?.chamfer ?? false,
        facets: was.facets,
        facetsAt: was.bevel,
      });
    }

    if (line === null) amounted(id, 'deform', corner, -scope.amplitude);
    else {
      amounted(id, 'deform', corner, line.amplitude - scope.amplitude);

      // Where the fold put this edge's pattern, as an offset from where the
      // edge would put it itself, and how far the fold let it run. The fold
      // centres a run on the member edge that named it; the ring has no
      // member edge, so it is told. See `Effects['deform'].anchor`.
      optioned(id, corner, 'deform', line.deform === null ? undefined : {
        spacing: line.deform.spacing,
        pattern: line.deform.pattern,
        seed: line.deform.seed,
        sides: line.deform.sides,
        jitter: line.deform.jitter,
        falloff: line.deform.falloff,
        offset: line.deform.offset,
        anchor: along(line.at, from, to) - Math.hypot(to.x - from.x, to.y - from.y) / 2,
        reach: line.reach,

        // The run was this member edge's, so its pattern is that edge's: the
        // same teeth nudged the same ways, which a seeded start, a jitter and
        // the noise all read off the name.
        key: line.id,
      });
    }
  }

  for (const [id, rig] of amounts) rigs.set(id, rig);

  return { ...held, cornerEffects, rigs };
}

/** Two sets of options, field for field. */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Whether anything is written about a thing at a keyframe. */
function written(rig: KeyRig, k: KeyframeId): boolean {
  return rig.keys.has(k);
}

/**
 * The picked things replaced by the polygons their union comes to.
 *
 * What the gesture actually calls. A selection is not a group and does not have
 * to be one to be read as one — but it is made one anyway, and taken apart
 * again at the end, because a group is *exactly* "these things, read together"
 * and everything that follows from that is already written. Making one costs a
 * map entry; the alternative is a second copy of `groupFrame`, a second copy of
 * the frame each ring is written down in, and a second answer to what becomes
 * of an artefact when the thing holding it goes.
 *
 * `ids` are what a click picked, already reduced to what moves as one at the
 * level being worked at — `reaching`, which the caller has done.
 */
export function resolveInto(
  world: World,
  v: KeyframeId,
  ids: readonly Id[],
  where: Landing,
): Resolution | null {
  if (ids.length === 0) return null;

  // One group is the thing itself, and reading it in its own frame is what
  // leaves its motion on what comes out. Wrapping it in another would read it
  // in the frame outside it and press this version's turn into the points.
  if (ids.length === 1 && world.groups.has(ids[0])) return resolveGroup(world, v, ids[0]);

  if (!ids.some(id => within(world, id).some(m => world.polygons.has(m)))) return null;

  const made = enclosed(world, ids, where);

  return resolveGroup(made.world, v, made.id);
}

/**
 * A group over `ids`, made only so that it can be taken apart again.
 *
 * `grouped` is the gesture and refuses things this must not refuse — fewer than
 * two, or everything the open group already holds. Both are refusals about a
 * group being worth making, and this one is not being made to be kept.
 *
 * It holds its members at every keyframe they stand at, as every group does.
 * Nothing is compensated, exactly as in `grouped`: its frame is at rest
 * everywhere, so everything is where it was.
 */
function enclosed(world: World, ids: readonly Id[], where: Landing): {
  world: World
  id: GroupId
} {
  const id = world.nextId;
  const held = new Set<Id>(ids);
  const groups = new Map(world.groups);
  const parent = where.into === null ? undefined : groups.get(where.into);

  groups.set(id, { members: [...ids], sealed: true });

  // Taken out of wherever they were, so nothing is claimed twice.
  if (where.into !== null && parent !== undefined) {
    groups.set(where.into, { ...parent, members: parent.members.filter(m => !held.has(m)) });
  }

  return { world: joined({ ...world, groups, nextId: id + 1 }, where.into, [id]), id };
}
