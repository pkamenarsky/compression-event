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
import { EMPTY_RIG, Entry, KeyRig, Rig, keysOf, once, stateAt } from './rig';
import {
  GroupId,
  Id,
  PolygonId,
  KeyframeId,
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
    // The group itself is transparent, sealed or not: what is being asked for
    // is the union of what is under it, not the shape it already offers. Which
    // is also why resolving works the same on a loose group as on a scope —
    // the gesture is *make this one shape*, and whether it already was one is
    // not the question.
    //
    // A sealed group nested inside it stands for its members, exactly as it
    // does for the CSG: its shape is a real shape and pulling it apart here
    // would resolve it too, which is not what was asked.
    g => {
      if (g === id || !inside.has(g)) return null;

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
  const sides: [PolygonKind, readonly Ring[]][] = [
    [SLOT_KINDS.level[level ?? 0], walls],
    [SLOT_KINDS.floor[floor ?? 0], level === 0 ? floors(items, walls) : rings(items, 'floor').map(ring => ring.map(p => p.at))],
  ];

  for (const [kind, side] of sides) {
    // Into the group's frame first, since that is where the winding is read.
    const mine = side.map(ring => ring.map(p => unplace(frame, p)));
    const how = nested(mine);
    const base = out.length;

    mine.forEach((ring, i) => out.push({
      kind,
      hole: how[i].hole,
      owner: how[i].owner === null ? null : base + how[i].owner!,
      ring,
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

  // Read without its own deform: the rings it makes take the deform on,
  // with its timeline, and would otherwise have it done to them twice. What
  // is inside it — its members' own deforms, and those of groups within —
  // comes into the rings as the shape they make.
  const own = world.effects.get(id);
  const bare = own?.deform === undefined
    ? world
    : { ...world, effects: new Map(world.effects).set(id, { ...own, deform: undefined }) };
  const readings = readingAt(bare, v, id);

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
  for (const outer of readings.filter(r => !r.hole)) {
    const parts = [outer, ...readings.filter(r => r.hole && readings[r.owner!] === outer)];
    const mine = next;
    const points: Vertex[] = [];

    parts.forEach((part, ring) => {
      for (const at of part.ring) points.push({ id: ++next, at, ring, birth: born, death });
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
