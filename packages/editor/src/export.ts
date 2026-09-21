// -----------------------------------------------------------------------------
// The editor's world, as the game gets it
//
// One direction only. The editor resolves versions, keys everything by id and
// cuts the morph per polygon; the game does none of that, and this is where all
// of it is spent. What comes out is `@ce/game/world`'s `World`: flat arrays for
// the shader, and one list of source rings per version for collision.
//
// The flattening is mechanical, and deliberately so. `bakedSpan` is the same
// walk `drawn` makes in `bake.ts`, written out to arrays instead of evaluated,
// so the two can be held against each other point for point — which is what
// `export.test.ts` does, and what makes the shader worth writing.
// -----------------------------------------------------------------------------

import {
  BakedLevel,
  BakedRun,
  BakedStretch,
  BakedTrack,
  BakedSpan,
  CORNER,
  CROSSING,
  ENTRY_STRIDE,
  FRAME_STRIDE,
  Floor,
  OP_ABOUT,
  OP_MOVE,
  OP_STAND,
  OP_STRIDE,
  Artefact as GameArtefact,
  Polygon as GamePolygon,
  Version as GameVersion,
  World as GameWorld,
  nesting,
  withNormals,
} from '@ce/game';
import { Bake, Flight, Origin, Ref, Rider, Span, Stretch, loadedFor, spanAt } from './bake';
import { Motion, aboutOf, flying } from './rig';
import { Shape, simplify, subtract, union } from './geometry';
import { Contributed, EMPTY_LIVE, contributing, live, placeAt, resolveAt, settled, sourced } from './scene';
import { ArtefactId, Id, PolygonId, SLOTS, SetName, KeyframeId, World, slotOf } from './types';

// -----------------------------------------------------------------------------
// One span
// -----------------------------------------------------------------------------

/** Where a polygon's or a group's frame sits in the span's frame table. Ids are
 * dense enough to index by in a small level and are not promised to be, so they
 * are looked up rather than assumed. */
type Slots = Map<Id, number>;

/**
 * A slot for every polygon, and one for every group holding any of them.
 *
 * The groups are in the same table rather than a second one, because what a
 * vertex walks is one chain: a group's frame is composed exactly the way a
 * polygon's is, and giving it its own kind of slot would be two readers of two
 * tables agreeing by hand.
 */
function slotted(riders: Map<Id, Rider>): Slots {
  const ids = new Set<Id>(riders.keys());

  for (const rider of riders.values()) {
    for (const h of rider.holders) ids.add(h.id);
  }

  return new Map([...ids].sort((a, b) => a - b).map((id, i) => [id, i]));
}

/** Every slot's own flight and who holds it, which the riders say once per
 * polygon and the table says once per slot. A group is its own flight and
 * whatever holds it in turn, which every rider it holds says alike. */
function chains(riders: Map<Id, Rider>): Map<Id, Rider> {
  const out = new Map<Id, Rider>(riders);

  for (const rider of riders.values()) {
    rider.holders.forEach((h, i) => {
      if (!out.has(h.id)) out.set(h.id, { frame: h.frame, ops: h.ops, holders: rider.holders.slice(i + 1) });
    });
  }

  return out;
}

/** How deep the deepest chain in the table goes, in slots. */
function deepest(riders: Map<Id, Rider>): number {
  let out = 1;

  for (const rider of riders.values()) out = Math.max(out, rider.holders.length + 1);

  return out;
}

/** The most operations any slot plays. */
function most(riders: Map<Id, Rider>): number {
  let out = 0;

  for (const rider of chains(riders).values()) out = Math.max(out, rider.ops.length);

  return out;
}

/**
 * One key as the table holds it. See `OP_STRIDE`.
 *
 * Which kind it is is how the painted point moves: round the point the key
 * leaves still where it has one, and in a line eased by the stretch where it
 * has none. `aboutOf` is the one that answers that, and the reader tells the
 * two apart by the kind alone — it has no solve of its own.
 */
export function record(p: Motion): number[] {
  if (!flying(p)) throw new Error('an amount is in the geometry, not in the frame table');

  if (p.stand !== undefined) {
    const f = p.stand.frame;

    return [OP_STAND, f.t.x, f.t.y, f.angle, f.scale.x, f.scale.y, f.skew, 0, 0, 0, 0, 0];
  }

  const d = p.by!;
  const about = aboutOf(d);
  const go = about ?? d.move;

  return [
    about === null ? OP_MOVE : OP_ABOUT,
    p.ref.x, p.ref.y,
    go.x, go.y,
    d.angle,
    d.skew,
    d.scale.x, d.scale.y,
    d.along, d.lean,
    0,
  ];
}

/** Every slot's frame, and every slot's operations laid end to end. */
function frames(riders: Map<Id, Rider>, slots: Slots): { frames: Float32Array, ops: Float32Array } {
  const out = new Float32Array(slots.size * FRAME_STRIDE);
  const ops: number[] = [];
  const all = chains(riders);

  for (const [id, slot] of slots) {
    const { frame, ops: mine, holders }: Flight & Pick<Rider, 'holders'> = all.get(id)!;
    const o = slot * FRAME_STRIDE;

    out[o] = frame.t.x;
    out[o + 1] = frame.t.y;
    out[o + 2] = frame.angle;
    out[o + 3] = frame.scale.x;
    out[o + 4] = frame.scale.y;

    // The chain, one link at a time. Everything above this slot is that
    // slot's business, and it says so the same way.
    out[o + 5] = holders.length === 0 ? -1 : slots.get(holders[0].id) ?? -1;

    out[o + 6] = ops.length / OP_STRIDE;
    out[o + 7] = mine.length;
    out[o + 8] = frame.skew;

    for (const op of mine) ops.push(...record(op));
  }

  return { frames: out, ops: new Float32Array(ops) };
}

/**
 * The entry table for one stretch, appended to the span's.
 *
 * A ring is in it only when both ends of the stretch have it, because an entry
 * is a pair of positions to interpolate between and half of one is not
 * something a crossing can be solved from. The reader's answer to a ring it
 * cannot place is to fall back to interpolating the run point, and leaving the
 * entry out here is how it is asked that question.
 */
interface Table {
  /** `id:ring:index` to entry. */
  at: Map<string, number>
  floats: number[]
}

function key(id: PolygonId, ring: number, index: number): string {
  return `${id}:${ring}:${index}`;
}

function tabled(s: Stretch, slots: Slots, into: Table): void {
  for (const [id, both] of s.table) {
    const slot = slots.get(id);
    if (slot === undefined) continue;

    both.a.forEach((ring, r) => {
      const far = both.b[r];
      if (ring === undefined || far === undefined || ring.length === 0) return;

      const first = into.floats.length / ENTRY_STRIDE;

      ring.forEach((p, i) => {
        const q = far[i % far.length];

        into.at.set(key(id, r, i), first + i);
        into.floats.push(
          p.x, p.y,
          q.x, q.y,
          slot,
          first + (i + 1) % ring.length,
          0, 0,
        );
      });
    });
  }
}

/**
 * The two entries an edge runs between, or nothing when the stretch's table
 * does not hold the ring it lies on.
 *
 * The wrap is taken against the near end's ring, exactly as `drawn` takes it:
 * that is the ring the entry indices were laid out along.
 */
function edge(s: Stretch, table: Table, r: Ref): [number, number] | null {
  const ring = s.table.get(r.id)?.a[r.ring];
  if (ring === undefined || ring.length === 0) return null;

  const i = r.index % ring.length;
  const a = table.at.get(key(r.id, r.ring, i));
  const b = table.at.get(key(r.id, r.ring, (i + 1) % ring.length));

  return a === undefined || b === undefined ? null : [a, b];
}

function solvable(s: Stretch, table: Table, origin: Origin | null | undefined): number[] | null {
  if (origin === null || origin === undefined || origin.kind !== 'cross') return null;

  const one = edge(s, table, origin.a), two = edge(s, table, origin.b);

  return one === null || two === null ? null : [one[0], one[1], two[0], two[1]];
}

/**
 * Everything the shader reads, flattened.
 *
 * `carrying` names the artefacts the shipped world will hold, in the order it
 * will hold them, so that the span can say where each one's frame sits. They
 * are already in the frame table — `ridersOf` puts them there — and this is
 * only the index back to them.
 */
export function bakedSpan(span: Span, carrying: readonly ArtefactId[] = []): BakedSpan {
  const slots = slotted(span.riders);
  const table: Table = { at: new Map(), floats: [] };

  const pointsA: number[] = [], pointsB: number[] = [];
  const slotOf: number[] = [], kinds: number[] = [], crossings: number[] = [];
  const opacityA: number[] = [], opacityB: number[] = [];

  // One stretch, flattened into the shared buffers. Jumps go through it too:
  // they are geometry at an instant rather than an interval, but they are the
  // same geometry, written the same way.
  const flatten = (s: Stretch): BakedStretch => {
    // Per stretch, because the tables are: two stretches of one track name
    // different rings, and a stretch of one track names a neighbour's.
    table.at.clear();
    tabled(s, slots, table);

    const runs: BakedRun[] = s.a.map((run, i) => {
      const to = s.b[i] ?? run;
      const origins = s.origins[i] ?? [];
      const slot = slots.get(run.id) ?? 0;
      const first = slotOf.length;

      run.points.forEach((p, j) => {
        const q = to.points[j] ?? p;
        const cross = solvable(s, table, origins[j]);

        pointsA.push(p.x, p.y);
        pointsB.push(q.x, q.y);

        // How much of a corner is there, at each end of the stretch, for the
        // shader to carry across. Whether the boundary turns here at all is
        // already in it — see `faded` — because that and a vertex emerging
        // say the same thing about the same vertical, and one channel lerps
        // as well as two.
        opacityA.push(s.opacity[0][i]?.[j] ?? 1);
        opacityB.push(s.opacity[1][i]?.[j] ?? 1);
        slotOf.push(slot);
        kinds.push(cross === null ? CORNER : CROSSING);
        crossings.push(...(cross ?? [-1, -1, -1, -1]));
      });

      return { first, count: run.points.length };
    });

    return { t0: s.t0, t1: s.t1, runs };
  };

  const tracks: BakedTrack[] = span.tracks.map(track => ({
    fill: track.fill,
    hole: track.hole,
    stretches: track.stretches.map(flatten),
    jumps: track.jumps.map(flatten),
  }));

  const ridden = frames(span.riders, slots);

  return {
    from: span.from,
    frames: ridden.frames,
    ops: ridden.ops,
    most: most(span.riders),
    depth: deepest(span.riders),
    entries: new Float32Array(table.floats),
    pointsA: new Float32Array(pointsA),
    pointsB: new Float32Array(pointsB),
    opacityA: new Float32Array(opacityA),
    opacityB: new Float32Array(opacityB),
    slots: new Int32Array(slotOf),
    kinds: new Uint8Array(kinds),
    crossings: new Int32Array(crossings),
    tracks,
    artefacts: new Int32Array(carrying.map(id => slots.get(id) ?? -1)),
  };
}

// -----------------------------------------------------------------------------
// The whole level
// -----------------------------------------------------------------------------

/**
 * Every span that has been baked and still stands, in version order.
 *
 * It stops at the first one that has not, rather than skipping it: `t` runs
 * evenly across however many spans come back, so a hole in the middle would
 * silently rescale the walk and play the wrong geometry at the wrong moment. A
 * short level is honest about being short.
 *
 * Where the level came out of a file with a bake in it and nothing has been
 * edited since, that bake is the same answer already worked out — so whichever
 * of the two covers more of the level is the one that goes.
 */
export function bakedLevel(bake: Bake, world: World): BakedLevel {
  const spans = [];
  const carrying = shipping(world);

  for (let from = 0; from + 1 < world.keyframes.length; from++) {
    const span = spanAt(bake, world, from);
    if (span === null) break;

    spans.push(bakedSpan(span, carrying));
  }

  const loaded = loadedFor(bake, world);

  return loaded !== null && loaded.spans.length > spans.length ? loaded : { spans };
}

/**
 * A contributor as the set wants to see it. The same reasoning `worldset` and
 * the bake both use, and it has to be the same or the three would not agree: a
 * ring that came out of an erosion is an arrangement already and simplifying it
 * again would be work with nothing to do.
 */
function shapeOf(it: Contributed): Shape {
  return it.simple ? it.shape : simplify(it.shape);
}

/**
 * One set at one version, as closed rings: each slot unioned on its own, and
 * `inside` deciding what covering which of them means.
 *
 * The same set the bake cuts into stretches, evaluated at one instant and left
 * whole instead of being cut into runs. Runs are what the drawing wants,
 * because a run belongs to one polygon and can be kept up to date on its own; a
 * ring is what collision wants, because a wall needs two neighbours to mitre
 * against and the ring is where they are.
 *
 * Rebuilt from nothing per version rather than kept incrementally. A version is
 * not an edit — a version that erodes moves every polygon it names — so there
 * would be nothing for a diff to skip, and this runs once where the editor's
 * own set runs once a frame.
 */
export function setAt(world: World, v: KeyframeId, set: SetName): Shape {
  const slots: Shape[] = Array.from({ length: SLOTS[set] }, () => []);

  // Through `contributing`, which is what makes this the same set the editor
  // draws rather than a second one that usually agrees. A group with a depth on
  // it stands in for its members and hands over its union offset inward, and a
  // version whose only edit is a group erosion was a version this could not see
  // at all: it read each polygon's own erosion, found none, and shipped the
  // version before it under the next version's name.
  for (const it of contributing(world, v, resolveAt(world, v))) {
    const slot = slotOf(it.kind, set);

    if (slot === null) continue;

    slots[slot] = union(slots[slot], shapeOf(it));
  }

  // The same fold a scope makes of its own slots, and it has to be the same
  // one: this is the set the game is shipped and that is the set the editor
  // draws. See `settled` in `scene.ts`.
  return settled(slots);
}

/** The level: what collision and the walls are made of. */
export function unionAt(world: World, v: KeyframeId): Shape {
  return setAt(world, v, 'level');
}

/**
 * The version as collision and the out-of-bounds check get it: the union's
 * rings, wound and normalled, and the floor polygons that take no part in it.
 * And as a still draws it: the walls standing, as the editor's view has them.
 *
 * The union rather than the polygons it was made of, which is the whole of the
 * fix recorded as *3b* in `docs/game.md`. Source rings carry walls the set does
 * not have — two rooms overlapping is the ordinary way to author a level here,
 * and the seam between them was a wall the player could see through and not
 * walk through. The union has no seam, because dissolving it is what a union
 * is.
 *
 * Every ring comes out as `level`, whatever it was made of: a `solid` has been
 * subtracted by now and is a hole, and a hole is one because of the way it is
 * wound. `withNormals` reads the winding and `sideOf` in `coldet.ts` acts on
 * it, and neither needs telling which is which.
 */
export function versionOf(world: World, v: KeyframeId): GameVersion {
  const polygons: GamePolygon[] = [];

  for (const ring of unionAt(world, v)) {
    const points = withNormals(ring);

    if (points.length >= 3) polygons.push({ points });
  }

  // The walls as the editor's own view stands them — `sourced`, which is
  // where a still's verticals are decided — rather than anything worked out
  // again here off the rings.
  const walls = sourced(live(EMPTY_LIVE, contributing(world, v, resolveAt(world, v))));

  return { polygons, floors: floorsAt(world, v), walls };
}

/**
 * The floor at a version: drawn flat underfoot, and taking part in nothing.
 *
 * Its own set, resolved exactly as the level is — floors added, floor holes
 * taken back out — and then cut into the outlines a fill can be laid over.
 * Not part of the level and not walls, so it comes along in a list of its own
 * rather than as rings the collision would have to know to skip. Points and
 * nothing else: normals are for deciding which side of a ring is material, and
 * a shape that is only ever filled has no such side.
 *
 * Its own function because the 3D view wants it without wanting the level, and
 * the level is the expensive half of `versionOf`.
 */
export function floorsAt(world: World, v: KeyframeId): Floor[] {
  return filled(setAt(world, v, 'floor'));
}

/**
 * An arrangement as the things that get filled: each outline with the holes
 * that belong to it.
 *
 * A hole has to go with the outline it is a hole in, rather than being handed
 * over as one more ring, because the triangulator is told a contour and its
 * holes and has no way to work out which is which — and filling a hole as an
 * outline in its own right fills exactly the part that is supposed to be gone.
 *
 * Through `nesting` rather than by working the containment out here, because
 * the morph has to answer the same question about the same set — off runs it
 * has just stitched, where this has the rings in hand — and a floor drawn
 * standing still that was cut a different way from the same floor a frame into
 * a transition is a floor that jumps at the version boundary.
 */
export function filled(shape: Shape): Floor[] {
  const rings = shape.filter(ring => ring.length >= 3);

  return nesting(rings).map(n => ({
    points: rings[n.outer],
    holes: n.holes.map(h => rings[h]),
  }));
}

/**
 * Every artefact: its own point, and where it stands at every version.
 *
 * The places are resolved here because the game has no versions to resolve
 * through — what it is handed is flat, and an artefact's place *at* a version
 * is a point. Between two of them it rides the span's frame table, which is
 * why its own point comes too.
 */
export function artefactsShipped(world: World): GameArtefact[] {
  return shipping(world).map(id => {
    const it = world.artefacts.get(id)!;

    return {
      type: it.type,
      at: it.at,
      places: world.keyframes.map(k => placeAt(world, id, k.id)),
    };
  });
}

/** The artefacts in the order they are shipped, which is the order every span
 * names its slots in. By id, because it has to be something and nothing else
 * about an artefact is stable. */
function shipping(world: World): ArtefactId[] {
  return [...world.artefacts.keys()].sort((a, b) => a - b);
}

/**
 * The world as the game gets it.
 *
 * Paths come out empty: the editor has never had them. The field is here so
 * that the day it does, nothing downstream has to change. See `docs/game.md`.
 */
export function shipped(world: World, bake: Bake): GameWorld {
  return {
    paths: [],
    artefacts: artefactsShipped(world),
    // As it stands, once: it is in no version's layer, so there is nothing to
    // resolve it through and nothing per version to say about it.
    start: { at: world.start.at, facing: world.start.facing },
    versions: world.keyframes.map(k => versionOf(world, k.id)),
    baked: bakedLevel(bake, world),
  };
}
