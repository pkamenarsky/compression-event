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
// Read once, at the version in front of you
// -----------------------------------------
// The union is taken at one version and that is the shape, at every version the
// geometry stood at. What the members were doing at any *other* version is
// gone, and the versions that said it say nothing afterwards.
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
// So it does the simple thing and says so. `losing` names the versions whose
// layers are about to stop meaning anything, and it is the caller's business to
// put that in front of whoever asked before doing it.
//
// What is kept
// ------------
// The group's own layers, all of them. Its transform stays a transform, so a
// group that turns still turns through its arc rather than becoming corners
// that moved; its depth stays a depth, unbaked, so an author who resolves a
// corridor and then wants another unit of wall can still say so. Only what the
// *members* were doing separately is lost, which is exactly the part that had
// nowhere to go.
//
// Nor is this a layer. Every other edit here lands in one version and flows
// forward; this one rewrites the whole chain, because the thing it replaces
// spans the whole chain. Undo is what takes it back.
//
// Holes
// -----
// The union of a ring of corridors is one room with a courtyard in the middle,
// and that is what it comes out as: one polygon, whose second ring is the
// courtyard. Not a room and a pillar — a pillar is on the other side of the set
// and cuts the rooms around it too, so a neighbour built up against the block
// could never fill the courtyard in, which is not what the group did.
//
// This is what `Vertex.ring` was added for. See `types.ts`.
// -----------------------------------------------------------------------------

import { PolygonType } from '@ce/game/world';
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
  chain,
  contributed,
  depths,
  groupFrame,
  resolveAt,
  standingIn,
  unplace,
} from './scene';
import {
  EMPTY_TRANSFORM,
  Edit,
  GroupId,
  Id,
  Polygon,
  PolygonId,
  Transform,
  Version,
  VersionId,
  Vertex,
  VertexId,
  World,
  parentOf,
  within,
} from './types';

/** The three sides a group contributes to, in the order the CSG reads them.
 * The same list `sideOf` numbers, and for the same reason: a room's boundary
 * and a pillar's are not one boundary. */
const SIDES: readonly PolygonType[] = ['level', 'solid', 'floor'];

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
function signed(ring: readonly Named[]): number {
  let sum = 0;

  for (let i = 0; i < ring.length; i++) {
    const a = ring[i].at, b = ring[(i + 1) % ring.length].at;

    sum += a.x * b.y - b.x * a.y;
  }

  return sum;
}

/**
 * Runs joined end to end into closed rings.
 *
 * A run whose two ends have the same name is already a ring: a member nothing
 * overlaps contributes its whole outline in one piece.
 */
function stitched(runs: readonly NamedRing[]): NamedRing[] {
  const from = new Map<string, NamedRing[]>();

  for (const run of runs) {
    const head = run[0].key;

    (from.get(head) ?? from.set(head, []).get(head)!).push(run);
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
      go = from.get(go[go.length - 1].key)?.find(n => !used.has(n));
    }

    if (ring.length >= 3) out.push(ring);
  }

  return out;
}

/** One side's union, as closed rings in world units. */
function rings(items: readonly Contributed[], kind: PolygonType): NamedRing[] {
  const mine: Member[] = items
    .filter(it => it.kind === kind && it.shape.length !== 0)
    // Everybody a `level`, so that what comes back is the plain union rather
    // than `level - solid`. Which side of the set they are actually on is the
    // caller's question and was answered before this was called.
    .map(it => ({ id: it.id, kind: 'level', shape: it.shape }));

  if (mine.length === 0) return [];

  const on = ground(mine);
  const out: NamedRing[] = [];

  for (const m of mine) {
    for (const run of boundaryRuns(m, mine.filter(o => o.id !== m.id), on)) {
      out.push(run.points.map((p, i) => ({ at: p, key: named(run.whence[i]) })));
    }
  }

  return stitched(out);
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
  kind: PolygonType
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
function nested(rings: readonly NamedRing[]): { hole: boolean, owner: number | null }[] {
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
      if (hole[j] || !contains([other.map(p => p.at)], ring[0].at)) return;
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
function readingAt(world: World, v: VersionId, id: GroupId): Reading[] {
  const inside = new Set(within(world, id).filter(m => m !== id));
  const depth = depths(world, v);

  const items = contributed(
    world,
    resolveAt(world, v).filter(it => inside.has(it.id)),
    // The group itself is transparent: what is being asked for is the union of
    // what is under it, not the shape it already offers. A nested group that
    // erodes stands for its members, exactly as it does for the CSG — its
    // union is a real shape and pulling it apart here would resolve it too.
    g => {
      if (g === id || !inside.has(g)) return null;

      const d = depth.get(g) ?? 0;

      return d === 0 ? null : { depth: d };
    },
  );

  const frame = groupFrame(world, v, id);
  const out: Reading[] = [];

  for (const kind of SIDES) {
    // Into the group's frame first, since that is where the winding is read.
    const mine = rings(items, kind)
      .map(ring => ring.map(p => ({ at: unplace(frame, p.at), key: p.key })));

    const how = nested(mine);
    const base = out.length;

    mine.forEach((ring, i) => out.push({
      kind,
      hole: how[i].hole,
      owner: how[i].owner === null ? null : base + how[i].owner!,
      ring: ring.map(p => p.at),
    }));
  }

  return out;
}

// -----------------------------------------------------------------------------
// The gesture
// -----------------------------------------------------------------------------

export interface Resolution {
  world: World
  /** What to pick afterwards: the group, or the one polygon that replaced it. */
  id: Id
  /**
   * The versions whose layers are about to stop saying anything — every version
   * but the one it was read at that had written something about a member.
   *
   * Not an error and not a refusal. It is the one thing about this that cannot
   * be seen by looking at the result, so it is handed back to be asked about.
   * Empty is the ordinary case: a group nobody has animated resolves with
   * nothing lost at all.
   */
  losing: VersionId[]
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
export function resolveGroup(world: World, v: VersionId, id: GroupId): Resolution | null {
  const group = world.groups.get(id);

  if (group === undefined) return null;

  const readings = readingAt(world, v, id);

  if (readings.length === 0) return null;

  // Every version any of the geometry is there at, rather than every version
  // the *group* is there at.
  //
  // A group made at v1 out of rooms drawn at v0 does not un-draw them —
  // grouping is a handle appearing, which is why `removals` reads a holder's
  // death and never its birth — so those rooms stand at v0 with nothing holding
  // them, and what replaces them has to stand there too.
  const geometry = within(world, id).filter(m => world.polygons.has(m));

  const versions = world.versions
    .map((_unused, k) => k)
    .filter(k => {
      const from = new Set(chain(world, k));

      return geometry.some(m => standingIn(world, m, from));
    });

  if (versions.length === 0) return null;

  // Everything under the group that was geometry. It goes entirely rather than
  // dying at a version: what replaces it stands at every version it stood at,
  // so leaving it would draw the same rooms twice.
  const gone = new Set<Id>(within(world, id).filter(m => m !== id));
  const kept = group.members.filter(m => world.artefacts.has(m));

  const polygons = new Map(world.polygons);
  const groups = new Map(world.groups);

  for (const m of gone) {
    polygons.delete(m);
    groups.delete(m);
  }

  const born = versions[0];
  const dies = versions[versions.length - 1] + 1;
  const death = dies < world.versions.length ? dies : null;

  // One block of ids, so a polygon's corners are the numbers after it — which
  // is what `addPolygon` does and what anything reading a saved file expects.
  let next = world.nextId;
  const made: PolygonId[] = [];

  // An outline and the holes in it are one polygon. A hole whose outline is not
  // here — which the geometry cannot produce, since a hole needs something to
  // be a hole in — would otherwise be a ring nobody draws.
  for (const outer of readings.filter(r => !r.hole)) {
    const parts = [outer, ...readings.filter(r => r.hole && readings[r.owner!] === outer)];
    const mine = next;
    const points: Vertex[] = [];

    parts.forEach((part, ring) => {
      for (const at of part.ring) points.push({ id: ++next, at, ring, birth: born, death });
    });

    polygons.set(mine, { type: outer.kind, birth: born, death, points });
    made.push(mine);
    next++;
  }

  if (made.length === 0) return null;

  // A group of one polygon and nothing else is not a group. Its layers move to
  // the polygon, which composes them in the same order and the same frame — see
  // `groupFrame`, whose walk is the polygon's own transform and then its
  // holders', one version at a time.
  const hoist = made.length === 1 && kept.length === 0;
  const owner = parentOf(world).get(id) ?? null;

  if (hoist) groups.delete(id);
  else groups.set(id, { ...group, members: [...made, ...kept] });

  if (hoist && owner !== null) {
    const up = groups.get(owner)!;

    groups.set(owner, { ...up, members: up.members.map(m => (m === id ? made[0] : m)) });
  }

  const depth = new Map(versions.map(k => [k, depths(world, k).get(id) ?? 0]));

  const versionsOut: Version[] = world.versions.map((version, k) => {
    // Every layer written about a member goes with the member. What it said is
    // not recoverable as a transform on the union — that is the whole of why
    // this reads one version — and leaving it written would be a layer naming
    // something no longer in the world.
    const edits = new Map<Id, Edit>(
      [...version.edits].filter(([who]) => !gone.has(who) && !(hoist && who === id)),
    );

    if (hoist) {
      // The group's own layer, where there is no group left to carry it. The
      // depth is the one it resolved to rather than the one it stated, since a
      // version that stated nothing inherited its base's and there is nothing
      // left to inherit from.
      const d = depth.get(k) ?? 0;
      const transform: Transform = {
        ...(version.edits.get(id)?.transform ?? EMPTY_TRANSFORM),
        // The walls go the other way, and that is the same identity
        // `contributed` states: erode(A - B, d) = erode(A, d) - erode(B, -d).
        erosion: polygons.get(made[0])!.type === 'solid' ? -d : d,
      };

      if (versions.includes(k)) {
        edits.set(made[0], { transform, vertices: new Map<VertexId, Point>(), depths: new Map() });
      }
    }

    return { ...version, edits };
  });

  return {
    world: { ...world, polygons, groups, nextId: next, versions: versionsOut },
    id: hoist ? made[0] : id,
    losing: world.versions
      .map((_unused, k) => k)
      .filter(k => k !== v && [...world.versions[k].edits.keys()].some(who => gone.has(who))),
  };
}
