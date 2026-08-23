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
  withNormals,
} from '@ce/game';
import { Bake, Origin, Ref, Rider, Span, Stretch, pivot, spanAt } from './bake';
import { resolveAt } from './scene';
import { PolygonId, World } from './types';

// -----------------------------------------------------------------------------
// One span
// -----------------------------------------------------------------------------

/** Where a polygon's frame sits in the span's frame table. Ids are dense enough
 * to index by in a small level and are not promised to be, so they are looked
 * up rather than assumed. */
type Slots = Map<PolygonId, number>;

function slotted(riders: Map<PolygonId, Rider>): Slots {
  const ids = [...riders.keys()].sort((a, b) => a - b);

  return new Map(ids.map((id, i) => [id, i]));
}

function frames(riders: Map<PolygonId, Rider>, slots: Slots): Float32Array {
  const out = new Float32Array(slots.size * FRAME_STRIDE);

  for (const [id, slot] of slots) {
    const { base, layer } = riders.get(id)!;
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

/** Everything the shader reads, flattened. */
export function bakedSpan(span: Span): BakedSpan {
  const slots = slotted(span.riders);
  const table: Table = { at: new Map(), floats: [] };

  const pointsA: number[] = [], pointsB: number[] = [];
  const slotOf: number[] = [], kinds: number[] = [], crossings: number[] = [];

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
    entries: new Float32Array(table.floats),
    pointsA: new Float32Array(pointsA),
    pointsB: new Float32Array(pointsB),
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
 * The source rings at one version, wound and normalled: what collision and the
 * out-of-bounds check run on.
 *
 * The projection rather than the authored ring, because that is the geometry
 * the version actually has — a room eroded until its walls meet is two rooms,
 * and the player should be stopped by both of them. Each ring comes out as its
 * own entry; which of them are holes is in their winding, and `withNormals`
 * reads it there.
 */
export function versionOf(world: World, v: number): GameVersion {
  const polygons: GamePolygon[] = [];

  for (const it of resolveAt(world, v)) {
    for (const ring of it.shape) {
      const points = withNormals(ring);

      if (points.length >= 3) polygons.push({ type: it.polygon.type, points });
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
