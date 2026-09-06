// -----------------------------------------------------------------------------
// Resolving a group: the union its members make, turned back into polygons
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
// What this is not
// ----------------
// It is not a bake. The group's own depth is left where it is — on the group,
// or hoisted onto the single polygon that replaced it — rather than pressed
// into the points. An author who resolves a corridor and then wants another
// unit of wall should be able to say so, and eroding a resolved ring by hand is
// a different shape from eroding the union it came out of.
//
// Nor is it a layer. Every other edit here lands in one version and flows
// forward; this one rewrites the whole chain, because the thing it replaces
// spans the whole chain. Undo is what takes it back.
//
// Identity across versions
// ------------------------
// This is the whole difficulty, and it has one answer: **a point of a union is
// not a position, it is a name.** `boundaryRuns` already says so — every point
// it hands back is either a corner of one member's outline or the crossing of
// two members' edges, and both are named in the members' own terms rather than
// measured. The bake leans on exactly this to pair two instants of a span.
//
// So the union is taken once per version and the readings are matched by name.
// A corner that is member M's vertex V is the same corner at v0 and at v6,
// however far M has been moved in between. A crossing of M's edge with N's is
// the same corner for as long as those two go on crossing. A member rotated at
// v4 moves its corners and keeps them; deleted at v4, it takes them out, and
// they die there; two members that did not overlap and now do bring a crossing
// into being, and it is born there.
//
// Which is exactly the vocabulary a `Vertex` already has. Names become vertex
// ids, first sighting becomes `birth`, the version after the last becomes
// `death`, and the position per version becomes what each layer displaces by.
//
// Where the names run out
// -----------------------
// A name is only as good as what it names, and two cases blunt it. Both are
// reported rather than papered over — see `Resolution.loose`.
//
//   * A member under a depth contributes its *projection*, whose corners are
//     the arrangement's rather than the polygon's. At depth nought they can be
//     looked up by position and come back as vertex ids, exactly; under a depth
//     they can only be named by where they sit in the ring, and a corner added
//     to that member later shifts every index past it. What follows the
//     insertion then reads as a death and a birth.
//
//   * A nested group that is itself eroding stands for its members as one
//     shape, and that shape's corners belong to nobody. Named by position too.
//
// What is lost
// ------------
// A version's transform is one transform for a whole polygon, and the union of
// members that move *differently* has no such thing. The group's own motion
// survives — it stays on the group, or is hoisted onto the polygon that
// replaced it, and either way it is still a rotation and still interpolates
// along its arc. A member turned on its own does not: its corners become
// displacements, and a displacement is interpolated straight. A ring of rooms
// each spinning about its own middle resolves to a polygon whose corners cut
// across the arcs they used to travel.
//
// That is not a bug with a fix. It is what handles cost.
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
// Naming the union's corners
// -----------------------------------------------------------------------------

/**
 * One corner of the union: where it is, and what it is.
 *
 * The name is the point of it. Positions are compared across versions by
 * nobody — they move, that is what versions are for — and two readings agree
 * about a corner exactly when they agree about its name.
 */
interface Named {
  at: Point
  key: string
}

/** A closed ring of them, in walk order. */
type NamedRing = Named[];

/** A position as a key that survives exact comparison and nothing else. Only
 * ever used to look a point up in a table it was put into unchanged. */
function at(p: Point): string {
  return `${p.x},${p.y}`;
}

/** Names for the corners of one version's contributors, and a tally of the
 * ones that could only be named by where they sit. */
interface Names {
  of: (w: Whither) => string
  loose: () => number
}

/**
 * How to name a corner of each contributor at one version.
 *
 * A polygon standing at a depth of nought contributes `simplify([source])` —
 * the same points it was handed, cut where the winding says — so its corners
 * can be looked up by position and come back as vertex ids, which is a name
 * that means the same thing at every version.
 *
 * Anything else contributes an arrangement whose corners belong to nobody.
 * Those are named by where they sit, and counted.
 */
function naming(world: World, v: VersionId, items: readonly Contributed[]): Names {
  const shapes = new Map<Id, readonly Ring[]>(items.map(it => [it.id, it.shape]));
  const tables = new Map<Id, Map<string, VertexId>>();

  for (const it of resolveAt(world, v)) {
    if (it.erosion !== 0 || it.depths !== null || !shapes.has(it.id)) continue;

    const table = new Map<string, VertexId>();

    it.source.forEach((p, i) => table.set(at(p), it.corners[i].id));
    tables.set(it.id, table);
  }

  let loose = 0;

  const named = (id: number, ring: number, index: number): string => {
    const p = shapes.get(id)?.[ring]?.[index];
    const found = p === undefined ? undefined : tables.get(id)?.get(at(p));

    if (found !== undefined) return `${found}`;

    loose++;

    return `@${id}:${ring}:${index}`;
  };

  return {
    of: w => w.kind === 'vertex'
      ? `v${named(w.at.id, w.at.ring, w.at.index)}`
      // Sorted, so that A crossing B and B crossing A are one crossing: the
      // arrangement does not promise which way round it saw them.
      : `x${[named(w.a.id, w.a.ring, w.a.index), named(w.b.id, w.b.ring, w.b.index)].sort().join('|')}`,
    loose: () => loose,
  };
}

// -----------------------------------------------------------------------------
// The union, as rings
// -----------------------------------------------------------------------------

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
 * By name rather than by position, which is what makes it exact. A run ends
 * where the boundary leaves the polygon it belongs to and carries on into
 * somebody else's, and both readings of that junction name it the same way —
 * it is one crossing of one pair of edges, seen from either side. So the join
 * needs no tolerance at all, which a join by coordinate would.
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

/** One side's union at one version, as closed named rings in world units. */
function rings(items: readonly Contributed[], kind: PolygonType, names: Names): NamedRing[] {
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
      out.push(run.points.map((p, i) => ({ at: p, key: names.of(run.whence[i]) })));
    }
  }

  return stitched(out);
}

/**
 * One ring of the union: which side of the set it is on, whether it is a hole,
 * and which of this version's outlines it is a hole in.
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
  /** The reading it is a hole in, by index in the version's own list. */
  owner: number | null
  ring: NamedRing
}

/** Which ring of a set is which, in one pass.
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
 * What the group's members come to at one version, ring by ring.
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
function readingAt(world: World, v: VersionId, id: GroupId): { rings: Reading[], loose: number } {
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

  const names = naming(world, v, items);
  const frame = groupFrame(world, v, id);
  const out: Reading[] = [];

  for (const kind of SIDES) {
    // Into the group's frame first, since that is where the winding is read.
    const mine = rings(items, kind, names)
      .map(ring => ring.map(p => ({ at: unplace(frame, p.at), key: p.key })));

    const how = nested(mine);
    const base = out.length;

    mine.forEach((ring, i) => out.push({
      kind,
      hole: how[i].hole,
      owner: how[i].owner === null ? null : base + how[i].owner!,
      ring,
    }));
  }

  return { rings: out, loose: names.loose() };
}

// -----------------------------------------------------------------------------
// Lineage
//
// One ring read at nine versions is nine rings, and which of them are the same
// ring is the question. Shared names answer it: two readings are the same ring
// when they have corners in common, and the more they have in common the more
// obviously so. A reading nothing continues is a ring born there; a line
// nothing continues is a ring that dies.
//
// Only against the version immediately before, so a line is a contiguous run.
// A ring that goes away at v3 and comes back at v5 is two rings, because a
// vertex has one birth and one death and there is nowhere to write the second
// pair. Saying so is better than pretending the gap was not there.
// -----------------------------------------------------------------------------

/**
 * One ring followed across the versions it stands at.
 *
 * `slots` is the ring order, and it holds every corner the ring has ever had —
 * exactly what `Polygon.points` holds, and for the same reason. A slot is a
 * name plus an incarnation, because a crossing can come and go and come back,
 * and the second sighting is a new corner however familiar its name.
 */
interface Line {
  kind: PolygonType
  /** Whether it is a hole, and in which line. Settled where the line is born:
   * a courtyard does not change which room it is the courtyard of, and if the
   * union rearranges itself that far it is a different ring. */
  hole: boolean
  owner: Line | null
  slots: string[]
  /** Where each slot stood, per version. */
  at: Map<string, Map<VersionId, Point>>
  /** Which slots each version had. */
  seen: Map<VersionId, Set<string>>
  /** The name each live slot is currently going by, so a returning name knows
   * it needs a fresh incarnation. */
  live: Map<string, string>
  born: VersionId
  last: VersionId
}

/**
 * `ring` folded into the order `slots` already holds.
 *
 * Anchored on the slots both have: what is new goes in beside the corner it
 * came in beside, which is the whole of what keeping the dead in place is for.
 * A reading that shares nothing goes on the end, which is the honest answer
 * where there is no order to agree with.
 */
function merged(slots: readonly string[], ring: readonly string[]): string[] {
  const held = new Set(slots);
  const start = ring.findIndex(k => held.has(k));

  if (start < 0) return [...slots, ...ring];

  const out = [...slots];

  let after = ring[start];
  let fresh: string[] = [];

  const flush = (): void => {
    if (fresh.length === 0) return;

    out.splice(out.indexOf(after) + 1, 0, ...fresh);
    fresh = [];
  };

  for (let i = 1; i <= ring.length; i++) {
    const k = ring[(start + i) % ring.length];

    if (held.has(k)) {
      flush();
      after = k;
    }
    else if (!fresh.includes(k)) {
      fresh.push(k);
    }
  }

  flush();

  return out;
}

/** How much two readings agree about: the corners they both have. */
function shared(line: Line, v: VersionId, ring: NamedRing): number {
  const before = line.seen.get(v) ?? new Set();
  let n = 0;

  for (const p of ring) {
    if (before.has(line.live.get(p.key) ?? '')) n++;
  }

  return n;
}

/** The lines every version's reading makes, in the order the chain applies. */
function lineage(world: World, id: GroupId, versions: readonly VersionId[]): {
  lines: Line[]
  loose: number
} {
  const lines: Line[] = [];
  let loose = 0;
  let previous: VersionId | null = null;

  for (const v of versions) {
    const reading = readingAt(world, v, id);

    loose += reading.loose;

    const claimed = new Set<Line>();
    const mine = new Map<Reading, Line>();

    for (const it of reading.rings) {
      const best = previous === null ? null : lines
        .filter(l => l.kind === it.kind && l.hole === it.hole
          && l.last === previous && !claimed.has(l))
        .map(l => ({ l, n: shared(l, previous!, it.ring) }))
        .filter(s => s.n > 0)
        .sort((a, b) => b.n - a.n)[0]?.l ?? null;

      const line = best ?? {
        kind: it.kind,
        hole: it.hole,
        owner: null,
        slots: [],
        at: new Map(),
        seen: new Map(),
        live: new Map(),
        born: v,
        last: v,
      };

      if (best === null) lines.push(line);

      claimed.add(line);

      const now = new Set<string>();
      const order: string[] = [];

      for (const p of it.ring) {
        // A name that was standing at the version before carries its slot on.
        // One that was not is a fresh corner, whatever it is called: a crossing
        // that went away and came back is not the corner it was.
        const held = line.live.get(p.key);
        const carried = held !== undefined && (line.seen.get(line.last)?.has(held) ?? false);
        const slot = carried ? held : `${p.key}#${v}`;

        line.live.set(p.key, slot);
        now.add(slot);
        order.push(slot);

        const where = line.at.get(slot) ?? line.at.set(slot, new Map()).get(slot)!;

        where.set(v, p.at);
      }

      line.slots = merged(line.slots, order);
      line.seen.set(v, now);
      line.last = v;
      mine.set(it, line);
    }

    // After the lot of them, since a hole read before its outline would have
    // nothing to point at yet. Only for a line being born: which outline a hole
    // belongs to is settled once, and a hole that changed hands would be a
    // hole somewhere else.
    for (const [it, line] of mine) {
      if (line.owner !== null || !line.hole || it.owner === null) continue;

      line.owner = mine.get(reading.rings[it.owner]) ?? null;
    }

    previous = v;
  }

  return { lines, loose };
}

// -----------------------------------------------------------------------------
// Writing it down
// -----------------------------------------------------------------------------

/** The version after `v` in the chain, or nothing where `v` is the last. */
function after(versions: readonly VersionId[], v: VersionId): VersionId | null {
  const i = versions.indexOf(v);

  return i < 0 || i + 1 >= versions.length ? null : versions[i + 1];
}

/** How big a line's ring gets, over every version it stands at: the scale its
 * own round-trip error is measured against. */
function span(line: Line): number {
  let lo = Infinity, hi = -Infinity;

  for (const where of line.at.values()) {
    for (const p of where.values()) {
      lo = Math.min(lo, p.x, p.y);
      hi = Math.max(hi, p.x, p.y);
    }
  }

  return hi > lo ? hi - lo : 1;
}

/**
 * One outline and the holes in it, as a polygon and the layers that move it.
 *
 * `parts` is the outline first and its holes after, which is the order a
 * polygon keeps its corners in and the order `ringsOf` reads them back out of.
 * A hole born later than its outline is corners born later, and one that closes
 * up is corners that die: a courtyard opening as two wings of a building come
 * apart is exactly the vertex arithmetic a version already does, and needs
 * nothing said about rings at all.
 */
function written(
  parts: readonly Line[],
  id: PolygonId,
  first: VertexId,
  versions: readonly VersionId[],
): { polygon: Polygon, edits: Map<VersionId, Map<VertexId, Point>> } {
  const outer = parts[0];
  const alive = versions.filter(v => (outer.seen.get(v)?.size ?? 0) > 0);
  const points: Vertex[] = [];

  /** Every slot's vertex id, by the line it belongs to. Slots are only unique
   * within a line: two rings can cross the same pair of edges. */
  const ids = parts.map(() => new Map<string, VertexId>());

  let next = first;

  parts.forEach((line, ring) => {
    for (const slot of line.slots) {
      const where = line.at.get(slot)!;
      const mine = alive.filter(v => where.has(v));

      // A corner of a hole at a version the outline is not there at is not a
      // corner of anything. It cannot happen — a hole needs something to be a
      // hole in — but the id would be minted either way and a polygon with a
      // corner nothing ever places is worse than one ring short.
      if (mine.length === 0) continue;

      const gone = after(versions, mine[mine.length - 1]);

      ids[ring].set(slot, next);

      points.push({
        id: next++,
        at: where.get(mine[0])!,
        ring,
        birth: mine[0],
        // Where the corner outlives the ring, the ring's death says so and one
        // here as well would be two statements of one fact.
        death: gone !== null && line.seen.has(gone) ? gone : null,
      });
    }
  });

  // A layer states where a corner is by how far it has moved since it was last
  // stated, because that is what `resolveAt` accumulates. So the position is
  // carried along and each version writes the difference — which is nothing at
  // all for a corner nobody has touched, and a map that stays empty.
  //
  // Nothing, rather than nearly nothing. Every corner here has been through a
  // frame and back — placed by the group to be unioned, unplaced to be written
  // down — and a rotation does not come back bit for bit. Left alone, turning a
  // group writes a displacement of 1e-16 onto every corner it turned, and then
  // the polygon is one the author has nudged: the group's motion stops being a
  // rotation the moment anything reads it as corners that happened to move.
  //
  // So the round trip's error is dropped, and only that. It is measured against
  // the ring rather than fixed, because it is relative error, and it is far
  // below anything a grid can put on screen.
  const held = new Map<VertexId, Point>();
  const edits = new Map<VersionId, Map<VertexId, Point>>();
  const still = span(outer) * 1e-12;

  for (const v of alive) {
    const now = new Map<VertexId, Point>();

    parts.forEach((line, ring) => {
      for (const slot of line.seen.get(v) ?? []) {
        const vertex = ids[ring].get(slot);

        if (vertex === undefined) continue;

        const p = line.at.get(slot)!.get(v)!;
        const was = held.get(vertex);

        if (was === undefined || Math.abs(was.x - p.x) + Math.abs(was.y - p.y) > still) {
          if (was !== undefined) now.set(vertex, { x: p.x - was.x, y: p.y - was.y });

          held.set(vertex, p);
        }
      }
    });

    edits.set(v, now);
  }

  const end = after(versions, alive[alive.length - 1]);

  return {
    polygon: {
      type: outer.kind,
      birth: outer.born,
      death: end,
      points,
    },
    edits,
  };
}

// -----------------------------------------------------------------------------
// The gesture
// -----------------------------------------------------------------------------

export interface Resolution {
  world: World
  /** What to pick afterwards: the group, or the one polygon that replaced it. */
  id: Id
  /** How many corners could only be named by where they sat rather than by
   * whose they were. Nought is a resolve whose lineage is exact. */
  loose: number
}

/**
 * A group replaced by the polygons its union comes to, at every version.
 *
 * Nothing where there is nothing to do — no such group, or nothing under it
 * with any geometry. The group's artefacts stay members: an artefact is a place
 * and has nothing to do with a union.
 *
 * The group survives where there is more than one ring, because there is then
 * something for it to hold and somewhere for its depth and its motion to go.
 * Where the union came to one ring it does not: a group of one is a level of
 * structure that says nothing, so its layers are hoisted onto the polygon,
 * which reads them in exactly the frame the group read them in.
 */
export function resolveGroup(world: World, id: GroupId): Resolution | null {
  const group = world.groups.get(id);

  if (group === undefined) return null;

  // Every version any of the geometry is there at, rather than every version
  // the *group* is there at.
  //
  // A group made at v1 out of rooms drawn at v0 does not un-draw them —
  // grouping is a handle appearing, which is why `removals` reads a holder's
  // death and never its birth — so those rooms stand at v0 with nothing holding
  // them, and what replaces them has to stand there too. Taken from the group's
  // own birth instead, resolving emptied v0 and grew the whole level out of its
  // middle at v1.
  //
  // At a version before the group, its layers say nothing and its depth is
  // nought, so the union taken there is the union of the members as they stand:
  // the same set the CSG was making of them one by one.
  const geometry = within(world, id).filter(m => world.polygons.has(m));

  const versions = world.versions
    .map((_unused, v) => v)
    .filter(v => {
      const from = new Set(chain(world, v));

      return geometry.some(m => standingIn(world, m, from));
    });

  if (versions.length === 0) return null;

  const { lines, loose } = lineage(world, id, versions);

  if (lines.length === 0) return null;

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

  // One block of ids, so a polygon's corners are the numbers after it — which
  // is what `addPolygon` does and what anything reading a saved file expects.
  let next = world.nextId;
  const made: { id: PolygonId, edits: Map<VersionId, Map<VertexId, Point>> }[] = [];

  // An outline and the holes in it are one polygon. A hole whose outline is not
  // here — which the geometry cannot produce, since a hole needs something to
  // be a hole in — would otherwise be a ring nobody draws.
  for (const outer of lines.filter(l => !l.hole)) {
    const parts = [outer, ...lines.filter(l => l.hole && l.owner === outer)];
    const mine = next;
    const out = written(parts, mine, mine + 1, versions);

    next = mine + 1 + out.polygon.points.length;
    polygons.set(mine, out.polygon);
    made.push({ id: mine, edits: out.edits });
  }

  // A group of one polygon and nothing else is not a group. Its layers move to
  // the polygon, which composes them in the same order and the same frame — see
  // `groupFrame`, whose walk is the polygon's own transform and then its
  // holders', one version at a time.
  const hoist = made.length === 1 && kept.length === 0;
  const owner = parentOf(world).get(id) ?? null;

  if (hoist) groups.delete(id);
  else groups.set(id, { ...group, members: [...made.map(m => m.id), ...kept] });

  if (hoist && owner !== null) {
    const up = groups.get(owner)!;

    groups.set(owner, {
      ...up,
      members: up.members.map(m => (m === id ? made[0].id : m)),
    });
  }

  const depth = new Map(versions.map(v => [v, depths(world, v).get(id) ?? 0]));

  const rewritten: Version[] = world.versions.map((version, v) => {
    const edits = new Map<Id, Edit>(
      [...version.edits].filter(([who]) => !gone.has(who) && !(hoist && who === id)),
    );

    for (const m of made) {
      const vertices = m.edits.get(v);

      if (vertices === undefined) continue;

      // The group's own layer, where there is no group left to carry it. The
      // depth is the one it resolved to rather than the one it stated, since a
      // version that stated nothing inherited its base's and there is nothing
      // left to inherit from.
      const transform: Transform = hoist
        ? {
          ...(version.edits.get(id)?.transform ?? EMPTY_TRANSFORM),
          // The walls go the other way, and that is the same identity
        // `contributed` states: erode(A - B, d) = erode(A, d) - erode(B, -d).
        erosion: polygons.get(m.id)!.type === 'solid'
          ? -(depth.get(v) ?? 0)
          : depth.get(v) ?? 0,
        }
        : EMPTY_TRANSFORM;

      if (vertices.size === 0 && !hoist) continue;

      edits.set(m.id, { transform, vertices, depths: new Map() });
    }

    return { ...version, edits };
  });

  return {
    world: { ...world, polygons, groups, nextId: next, versions: rewritten },
    id: hoist ? made[0].id : id,
    loose,
  };
}
