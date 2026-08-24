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
  Polygon as GamePolygon,
  Version as GameVersion,
  World as GameWorld,
  turns,
  withNormals,
} from '@ce/game';
import { Bake, Origin, Ref, Rider, Span, Stretch, pivot, spanAt } from './bake';
import { Shape, simplify, subtract, union } from './geometry';
import { IDENTITY, Resolved, resolveAt } from './scene';
import { Id, Point, PolygonId, VersionId, World } from './types';

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
function slotted(riders: Map<PolygonId, Rider>): Slots {
  const ids = new Set<Id>(riders.keys());

  for (const rider of riders.values()) {
    for (const h of rider.holders) ids.add(h.id);
  }

  return new Map([...ids].sort((a, b) => a - b).map((id, i) => [id, i]));
}

/** Every slot's own layer and who holds it, which the riders say once per
 * polygon and the table says once per slot. */
function chains(riders: Map<PolygonId, Rider>): Map<Id, Rider> {
  const out = new Map<Id, Rider>(riders);

  for (const rider of riders.values()) {
    rider.holders.forEach((h, i) => {
      // A group carries no geometry, so it stands on nothing: identity base,
      // its own layer in flight, and whatever holds it in turn.
      out.set(h.id, {
        base: IDENTITY,
        layer: h.layer,
        holders: rider.holders.slice(i + 1),
      });
    });
  }

  return out;
}

/** How deep the deepest chain in the table goes, in slots. */
function deepest(riders: Map<PolygonId, Rider>): number {
  let out = 1;

  for (const rider of riders.values()) out = Math.max(out, rider.holders.length + 1);

  return out;
}

function frames(riders: Map<PolygonId, Rider>, slots: Slots): Float32Array {
  const out = new Float32Array(slots.size * FRAME_STRIDE);
  const all = chains(riders);

  for (const [id, slot] of slots) {
    const { base, layer, holders } = all.get(id)!;
    const held = pivot(layer);
    const o = slot * FRAME_STRIDE;

    out[o] = base.a;
    out[o + 1] = base.b;
    out[o + 2] = base.c;
    out[o + 3] = base.d;
    out[o + 4] = base.tx;
    out[o + 5] = base.ty;

    out[o + 6] = layer.translation.x;
    out[o + 7] = layer.translation.y;
    out[o + 8] = layer.rotation;
    out[o + 9] = layer.scale.x;
    out[o + 10] = layer.scale.y;

    out[o + 11] = held === null ? 0 : 1;
    out[o + 12] = held?.x ?? 0;
    out[o + 13] = held?.y ?? 0;

    // The chain, one link at a time. Everything above this slot is that
    // slot's business, and it says so the same way.
    out[o + 14] = holders.length === 0 ? -1 : slots.get(holders[0].id) ?? -1;
  }

  return out;
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
 * Whether the run turns at `j`, as a factor to fade a vertical by.
 *
 * The ends of a run are open — the boundary carries on into another run, and
 * nothing here says it does not turn — so only the inside of one is asked.
 */
function cornered(points: readonly Point[], j: number): number {
  const a = points[j - 1], b = points[j], c = points[j + 1];

  if (a === undefined || b === undefined || c === undefined) return 1;

  return turns(a, b, c) ? 1 : 0;
}

/** Everything the shader reads, flattened. */
export function bakedSpan(span: Span): BakedSpan {
  const slots = slotted(span.riders);
  const table: Table = { at: new Map(), floats: [] };

  const pointsA: number[] = [], pointsB: number[] = [];
  const slotOf: number[] = [], kinds: number[] = [], crossings: number[] = [];
  const opacityA: number[] = [], opacityB: number[] = [];

  const tracks: BakedTrack[] = span.tracks.map(track => ({
    stretches: track.stretches.map((s): BakedStretch => {
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

          // A point the boundary runs straight through is not a corner, and
          // the vertical the extrusion stands on it would be a line drawn down
          // the middle of a flat wall. Folded into the fade rather than given
          // its own channel: both say how much of a corner is there, and the
          // shader already carries this one from one end of the span to the
          // other. See `turns`.
          opacityA.push(cornered(run.points, j) * (s.opacity[0][i]?.[j] ?? 1));
          opacityB.push(cornered(to.points, j) * (s.opacity[1][i]?.[j] ?? 1));
          slotOf.push(slot);
          kinds.push(cross === null ? CORNER : CROSSING);
          crossings.push(...(cross ?? [-1, -1, -1, -1]));
        });

        return { first, count: run.points.length };
      });

      return { t0: s.t0, t1: s.t1, runs };
    }),
  }));

  return {
    from: span.from,
    frames: frames(span.riders, slots),
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
 */
export function bakedLevel(bake: Bake, world: World): BakedLevel {
  const spans = [];

  for (let from = 0; from + 1 < world.versions.length; from++) {
    const span = spanAt(bake, world, from);
    if (span === null) break;

    spans.push(bakedSpan(span));
  }

  return { spans };
}

/**
 * A polygon as the set wants to see it. The same reasoning `worldset` and the
 * bake both use, and it has to be the same or the three would not agree: a ring
 * that came out of an erosion is an arrangement already and simplifying it
 * again would be work with nothing to do.
 */
function shapeOf(it: Resolved): Shape {
  return it.erosion === 0 ? simplify(it.shape) : it.shape;
}

/**
 * The set at one version, as closed rings: every `level` unioned, every `solid`
 * taken back out.
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
export function unionAt(world: World, v: VersionId): Shape {
  let level: Shape = [], solid: Shape = [];

  for (const it of resolveAt(world, v)) {
    if (it.polygon.type === 'level') level = union(level, shapeOf(it));
    else if (it.polygon.type === 'solid') solid = union(solid, shapeOf(it));
  }

  if (level.length === 0) return [];

  return solid.length === 0 ? level : subtract(level, solid);
}

/**
 * The version as collision and the out-of-bounds check get it: the union's
 * rings, wound and normalled, and the floor polygons that take no part in it.
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
export function versionOf(world: World, v: VersionId): GameVersion {
  const polygons: GamePolygon[] = [];

  for (const ring of unionAt(world, v)) {
    const points = withNormals(ring);

    if (points.length >= 3) polygons.push({ type: 'level', points });
  }

  // Floors are not in the set — `worldset` takes only `level` and `solid` — and
  // are not walls either. They come along so that something can draw them.
  for (const it of resolveAt(world, v)) {
    if (it.polygon.type !== 'floor') continue;

    for (const ring of it.shape) {
      const points = withNormals(ring);

      if (points.length >= 3) polygons.push({ type: 'floor', points });
    }
  }

  return { polygons };
}

/**
 * The world as the game gets it.
 *
 * Artefacts and paths come out empty: the editor has a tool for the first and
 * nothing behind it, and has never had the second. The fields are here so that
 * the day it does, nothing downstream has to change. See `docs/game.md`.
 */
export function shipped(world: World, bake: Bake): GameWorld {
  return {
    paths: [],
    artefacts: [],
    versions: world.versions.map((_unused, v) => versionOf(world, v)),
    baked: bakedLevel(bake, world),
  };
}
