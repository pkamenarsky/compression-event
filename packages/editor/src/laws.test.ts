// -----------------------------------------------------------------------------
// The three laws
//
// PLAN-effect states them; this is them, as properties over generated worlds
// rather than over a handful of shapes somebody thought of. A world here is a
// tree: rooms at the leaves, sealed groups above them, and a kit of effects on
// any node of it — a list of erosions, rounds and deforms, in any order.
//
// What every one of them compares is the drawing, `csg`, point for point. Not
// an area, not a distance: the laws say *the same outline*, and an area that
// agrees to a tolerance is how a broken one hides.
// -----------------------------------------------------------------------------

import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import { Point } from '@ce/game/world';
import { TOP, addPolygon, csg, grouped, sealing } from './scene';
import { resolveGroup } from './resolve';
import { added } from './effects';
import { inSegments, wrote } from './testing';
import { Id, Layer, World, emptyWorld } from './types';


function rect(x: number, y: number, w: number, h: number): Point[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

/**
 * The drawing, said so that two of them can be compared outright: the set of
 * maximal straight pieces the walls are made of.
 *
 * Not the rings as they come. `csg` hands back *runs* — open stretches of wall
 * — and where a run starts, how many runs one wall is cut into and which way
 * each is wound are all answers about how the arrangement got there, not about
 * what is drawn. Two rooms sharing a wall draw it as two runs meeting at a
 * point; sealed, the same geometry is one run. That is exactly the difference
 * law 2 sets aside, and a comparison that called it a break would be a
 * comparison of the wrong thing.
 *
 * So: every segment, two collinear ones sharing an end merged into one
 * wherever nothing else meets them there, each written down without a
 * direction. Nothing about the order survives, and everything about the
 * outline does — which is why the answer is compared by `differing` and not by
 * being sorted into a list.
 *
 * **Two points are the same point within an ulp, and nothing looser than
 * that.** The two sides of a law reach the same corner by multiplying the same
 * numbers in a different order — a scope folds its effects over a union, its
 * resolution folds them over one polygon — and they land some 4e-14 apart on
 * coordinates of order three hundred. That is the one difference no
 * implementation can be asked to close, and it is measured rather than assumed:
 * where these properties are red for a real reason the two drawings differ by
 * whole points and by tenths of a unit, never by an ulp.
 *
 * It is still point for point. Every piece of one drawing has its own piece of
 * the other at the same place, and a piece the other lacks is a break however
 * short it is. What is *not* here is any comparison of area or of total length,
 * which is how a broken one would hide.
 */
function drawn(world: World): [Point, Point][] {
  const runs = csg(world, 0);
  const eps = spanOf(runs.flat()) * 1e-9;

  // Every point standing for the one place it is, so that the merge below
  // counts two ends of a junction as meeting there. Within one drawing: two
  // points of it that are an ulp apart are one point, and which of them stands
  // for the pair is settled by whichever came first.
  const held = clustered(eps);
  const at = (p: Point) => {
    const q = held(p);

    return `${q.x},${q.y}`;
  };
  const segs: [Point, Point][] = [];
  const gone: boolean[] = [];

  for (const run of runs) {
    for (let i = 0; i + 1 < run.length; i++) {
      if (at(run[i]) !== at(run[i + 1])) {
        segs.push([run[i], run[i + 1]]);
        gone.push(false);
      }
    }
  }

  // How many ends stand at each point: a piece is only grown through a point
  // two pieces meet at, so a wall running into a junction keeps its end.
  const ends = new Map<string, number>();
  const count = (p: Point) => ends.set(at(p), (ends.get(at(p)) ?? 0) + 1);

  for (const s of segs) {
    count(s[0]);
    count(s[1]);
  }

  // Where each point's pieces are, so growing one is a lookup and not a scan.
  const meeting = new Map<string, number[]>();

  segs.forEach((s, i) => {
    for (const p of s) meeting.set(at(p), [...(meeting.get(at(p)) ?? []), i]);
  });

  // Straight is `b` lying within `eps` of the chord from `a` to `c`: the same
  // distance the points are clustered at, and the one the arrangement snaps
  // at. An angle would not do — a vertex the arrangement welded onto a wall
  // 3e-7 off it, on a wall twenty long, turns by 2e-8 there, and a sine
  // tolerance calls that a corner where the other drawing has none.
  const straight = (a: Point, b: Point, c: Point) => {
    const wx = c.x - a.x, wy = c.y - a.y;
    const len = Math.hypot(wx, wy);

    return len === 0 || Math.abs((b.x - a.x) * wy - (b.y - a.y) * wx) <= eps * len;
  };

  for (let i = 0; i < segs.length; i++) {
    let grew = true;

    while (grew) {
      grew = false;

      if (gone[i]) break;

      const s = segs[i];

      for (const end of [0, 1] as const) {
        const p = s[end], other = s[1 - end];

        if (ends.get(at(p)) !== 2) continue;

        const j = (meeting.get(at(p)) ?? []).find(k => k !== i && !gone[k]);

        if (j === undefined) continue;

        const t = segs[j];
        const far = at(t[0]) === at(p) ? t[1] : t[0];

        if (!straight(other, p, far)) continue;

        segs[i] = end === 0 ? [far, other] : [other, far];
        gone[j] = true;
        grew = true;
        break;
      }
    }
  }

  return segs.flatMap((s, i) => (gone[i] ? [] : [[held(s[0]), held(s[1])] as [Point, Point]]));
}

/** The span of the box round a set of points, and 1 for a set with no size to
 * speak of: the unit the comparison's own tolerance is written in, so that it
 * says the same thing whatever units the rooms were drawn in. */
function spanOf(points: readonly Point[]): number {
  let lo = Infinity, hi = -Infinity;

  for (const p of points) {
    lo = Math.min(lo, p.x, p.y);
    hi = Math.max(hi, p.x, p.y);
  }

  const d = hi - lo;

  return Number.isFinite(d) && d > 0 ? d : 1;
}

/**
 * Points to the one place each stands for, within `eps`.
 *
 * Bucketed at `eps` and asked of the nine cells round it, which is what makes
 * it a clustering rather than a rounding: a pair that straddles a cell's own
 * boundary still finds each other, where `toFixed` would have written them
 * either side of it.
 */
function clustered(eps: number): (p: Point) => Point {
  const cells = new Map<string, Point[]>();

  return p => {
    const cx = Math.round(p.x / eps), cy = Math.round(p.y / eps);

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const q of cells.get(`${cx + dx}:${cy + dy}`) ?? []) {
          if (Math.hypot(p.x - q.x, p.y - q.y) <= eps) return q;
        }
      }
    }

    const k = `${cx}:${cy}`;
    const held = cells.get(k);

    if (held === undefined) cells.set(k, [p]);
    else held.push(p);

    return p;
  };
}

/**
 * What one drawing has that the other has not: the pieces of `a` with no piece
 * of `b` at the same place, and then the other way about. Empty both ways is
 * the two drawing the same outline.
 *
 * **One clustering over both of them**, which is the whole of how the ulp is
 * set aside. Every point of either drawing is asked which place it stands for,
 * `a`'s first, so a point of `b` that is 4e-14 from one of `a`'s comes back as
 * that same place — and then the two are compared for equality, exactly, as
 * multisets of pieces. There is no boundary for a pair to straddle, which is
 * what went wrong when this was two lists of `toFixed` strings.
 *
 * A multiset and not a set: a wall drawn twice in one and once in the other is
 * a difference.
 */
function differing(a: readonly [Point, Point][], b: readonly [Point, Point][]): string[] {
  const eps = spanOf([...a.flat(), ...b.flat()]) * 1e-9;
  const held = clustered(eps);
  const key = (s: readonly [Point, Point]) => [held(s[0]), held(s[1])]
    .map(p => `${p.x.toFixed(6)},${p.y.toFixed(6)}`)
    .sort()
    .join(' → ');

  const mine = new Map<string, number>();

  // `a` first, so it is `a`'s points that stand for the places and `b`'s that
  // are drawn to them.
  for (const s of a) {
    const k = key(s);

    mine.set(k, (mine.get(k) ?? 0) + 1);
  }

  const theirs = new Map<string, number>();

  for (const s of b) {
    const k = key(s);

    theirs.set(k, (theirs.get(k) ?? 0) + 1);
  }

  const out: string[] = [];

  for (const [k, n] of mine) {
    const m = theirs.get(k) ?? 0;

    if (n > m) out.push(`only here${n - m > 1 ? ` (${n - m}×)` : ''}: ${k}`);
  }

  for (const [k, n] of theirs) {
    const m = mine.get(k) ?? 0;

    if (n > m) out.push(`only there${n - m > 1 ? ` (${n - m}×)` : ''}: ${k}`);
  }

  return out.sort();
}

// -----------------------------------------------------------------------------
// What a world is made of
// -----------------------------------------------------------------------------

/** One layer of a kit: its kind, and the amount written for it. */
interface Laid {
  kind: 'erode' | 'round' | 'deform'
  by: number
}

/** A list of layers, laid first to last: any kinds, in any order, the same
 * kind as often as it likes. */
type Kit = readonly Laid[];

const e = (by: number): Laid => ({ kind: 'erode', by });
const r = (by: number): Laid => ({ kind: 'round', by });
const d = (by: number): Laid => ({ kind: 'deform', by });

/** A room with a kit of its own, or a sealed group of them with one. */
type Spec =
  | { kind: 'room', at: Point[], kit?: Kit }
  | { kind: 'group', kit: Kit, members: Spec[] };

const ZIGZAG = { spacing: 25, pattern: 'zigzag' as const, seed: 1, sides: 'both' as const, jitter: 0 };

function optionsOf(l: Laid): Omit<Layer, 'id'> {
  if (l.kind === 'round') return { kind: 'round', ...inSegments(8, l.by) };
  if (l.kind === 'deform') return { kind: 'deform', ...ZIGZAG };

  return { kind: 'erode' };
}

/** `k` laid at the end of `id`'s list, each layer with a fresh id and its
 * amount written at the first keyframe. */
function kitted(world: World, id: Id, k: Kit): World {
  let w = world;

  for (const l of k) {
    const made = added(w, id, optionsOf(l));

    w = wrote(made.world, 0, id, { kind: 'amount', layer: made.layer, by: l.by });
  }

  return w;
}

/** A spec built into a world, handing back what stands for it. */
function built(world: World, spec: Spec): { world: World, id: Id } {
  if (spec.kind === 'room') {
    const { world: w, id } = addPolygon(world, { level: 'hollow' }, spec.at, 0, TOP);

    return { world: kitted(w, id, spec.kit ?? []), id };
  }

  let w = world;
  const ids: Id[] = [];

  for (const m of spec.members) {
    const made = built(w, m);

    w = made.world;
    ids.push(made.id);
  }

  const g = grouped(w, 0, ids, TOP)!;

  return { world: kitted(sealing(g.world, g.id, true), g.id, spec.kit), id: g.id };
}

// -----------------------------------------------------------------------------
// Generating them
// -----------------------------------------------------------------------------

/** A tree with nothing drawn in it yet: the shape of the nesting, and a kit at
 * each scope. The rooms are filled in afterwards, so that a world's rooms can
 * be made distinct from one another. */
type Shape =
  | { kind: 'room', kit: Kit }
  | { kind: 'group', kit: Kit, members: Shape[] };

/**
 * Rooms drawn on a coarse grid, so that a pair of them overlaps, touches along
 * a wall or stands clear about as often as each — which is where the laws are
 * actually tested. Room-sized rather than arbitrary: a sliver has its own
 * troubles and they are not these.
 */
const arbRect = fc.record({
  x: fc.integer({ min: 0, max: 4 }),
  y: fc.integer({ min: 0, max: 4 }),
  w: fc.integer({ min: 2, max: 5 }),
  h: fc.integer({ min: 2, max: 5 }),
});

const rectOf = (r: { x: number, y: number, w: number, h: number }) =>
  rect(r.x * 60, r.y * 60, r.w * 40, r.h * 40);

const arbLaid: fc.Arbitrary<Laid> = fc.oneof(
  fc.integer({ min: 1, max: 20 }).map(e),
  fc.integer({ min: 1, max: 40 }).map(r),
  fc.integer({ min: 1, max: 12 }).map(d),
);

/** Nought to three layers, in any order, a kind allowed twice. */
const arbKit: fc.Arbitrary<Kit> = fc.array(arbLaid, { maxLength: 3 });

/** A room, or a group of two or three shapes one level shallower. A group
 * wants two members, so the leaves are where the recursion stops and not a
 * choice. */
function arbShape(depth: number): fc.Arbitrary<Shape> {
  const room = arbKit.map(kit => ({ kind: 'room' as const, kit }));

  if (depth <= 0) return room;

  return fc.oneof(
    { weight: 1, arbitrary: room },
    {
      weight: 2,
      arbitrary: fc.record({
        kit: arbKit,
        members: fc.array(arbShape(depth - 1), { minLength: 2, maxLength: 3 }),
      }).map(({ kit, members }) => ({ kind: 'group' as const, kit, members })),
    },
  );
}

function leaves(shape: Shape): number {
  return shape.kind === 'room' ? 1 : shape.members.reduce((n, m) => n + leaves(m), 0);
}

/**
 * The tree with a room written into each leaf, taken from `rects` in order.
 *
 * Distinct rooms, which is what `roomed` is for. Two rooms drawn exactly on
 * top of one another is a real thing an author can do and the laws hold of it
 * too, but it is a question about coincident edges in the arrangement rather
 * than about what a scope is — and it is what every counterexample shrinks to,
 * which buries the answer these properties are asked for.
 */
function roomed(shape: Shape, rects: readonly { x: number, y: number, w: number, h: number }[]): Spec {
  let next = 0;

  const fill = (s: Shape): Spec => (s.kind === 'room'
    ? { kind: 'room', at: rectOf(rects[next++]), kit: s.kit }
    : { kind: 'group', kit: s.kit, members: s.members.map(fill) });

  return fill(shape);
}

/** A tree of the given shape, with a distinct room at each of its leaves. */
const specOf = (shape: Shape): fc.Arbitrary<Spec> => fc
  .uniqueArray(arbRect, {
    minLength: leaves(shape),
    maxLength: leaves(shape),
    selector: r => `${r.x},${r.y},${r.w},${r.h}`,
  })
  .map(rects => roomed(shape, rects));

/** A world whose top is a sealed group, which is what the laws are about. */
const arbScope: fc.Arbitrary<Spec> = fc.record({
  kit: arbKit,
  members: fc.array(arbShape(2), { minLength: 2, maxLength: 3 }),
}).map(({ kit, members }) => ({ kind: 'group' as const, kit, members })).chain(specOf);

/** The same, loose: several things that nothing holds together yet. */
const arbLoose: fc.Arbitrary<Spec[]> = fc
  .array(arbShape(2), { minLength: 2, maxLength: 3 })
  .chain(members => specOf({ kind: 'group', kit: [], members }).map(spec => (spec as { members: Spec[] }).members));

/** Slow properties over arrangements: enough to find a break, not so many that
 * nobody runs them. */
const RUNS = { numRuns: 60, ...(process.env.LAW_SEED === undefined ? {} : { seed: Number(process.env.LAW_SEED), path: process.env.LAW_PATH, endOnFailure: true }) };

/**
 * Long enough that a property which finds nothing is allowed to say so.
 *
 * Sixty arrangements over a nested world is a minute's work and more, and
 * `fc.assert` is synchronous — so a runner that gives up at five seconds cannot
 * stop it, it can only mark what it did afterwards, and a green property came
 * back as a failed one with a timeout where its counterexample should be. That
 * is worse than a slow suite: it is a red that says nothing about the code.
 */
const SLOW = 600_000;

/**
 * The same world with every kit emptied: nesting and rooms alone, and no
 * effect anywhere.
 *
 * Each law is asked of one of these first. A bare world is the case the
 * pipeline has always got right, so a bare property failing would say the
 * break is in the way these two drawings are compared rather than in the
 * thing being compared — and a bare property passing while the effected one
 * fails says the opposite, outright.
 */
const bare = (spec: Spec): Spec => (spec.kind === 'room' ? { ...spec, kit: [] } : { ...spec, kit: [], members: spec.members.map(bare) });

// -----------------------------------------------------------------------------
// Law 1 — a scope draws what it resolves to
// -----------------------------------------------------------------------------

describe('law 1: a scope draws what it resolves to', () => {
  test('with no effect anywhere', () => {
    fc.assert(fc.property(arbScope, spec => {
      const { world, id } = built(emptyWorld(), bare(spec));
      const out = resolveGroup(world, 0, id);

      if (out === null) return;

      expect(differing(drawn(out.world), drawn(world))).toEqual([]);
    }), RUNS);
  }, SLOW);

  test('resolving the top scope does not move the outline', () => {
    fc.assert(fc.property(arbScope, spec => {
      const { world, id } = built(emptyWorld(), spec);
      const out = resolveGroup(world, 0, id);

      if (out === null) return;

      const scope = drawn(world);

      expect(differing(drawn(out.world), scope)).toEqual([]);
    }), RUNS);
  }, SLOW);

  /**
   * The counterexample this property shrank to for as long as an offset was
   * taken over a whole shape at once, kept as a case of its own because a
   * property that finds it in a minute is a property nobody reruns.
   *
   * What it turned on: the middle scope erodes by fourteen, and what it erodes
   * is two polygons about two units apart. A near-hairpin corner of the second
   * is moved along a bisector scaled by `1 / cosHalf` — thirty-five units, on a
   * polygon twenty-five wide — so three quads of its swept band reached back
   * into the *first* polygon and subtracted material there. The resolution,
   * which offsets one polygon at a time, could not do that, and the two
   * drawings differed by exactly those three points.
   */
  test('and a scope whose erosion sweeps a band out past its own polygon', () => {
    const spec: Spec = { kind: 'group', kit: [e(1)], members: [
      { kind: 'group', kit: [e(14), r(1), d(3)], members: [
        { kind: 'group', kit: [e(11), d(12)], members: [
          { kind: 'room', at: rect(0, 0, 120, 80) },
          { kind: 'room', at: rect(0, 0, 80, 80) },
        ] },
        { kind: 'group', kit: [r(13)], members: [
          { kind: 'room', at: rect(0, 0, 80, 120) },
          { kind: 'room', at: rect(0, 60, 80, 80) },
        ] },
      ] },
      { kind: 'room', at: rect(120, 0, 80, 80) },
    ] };

    const { world, id } = built(emptyWorld(), spec);
    const out = resolveGroup(world, 0, id)!;

    expect(differing(drawn(out.world), drawn(world))).toEqual([]);
  });

  /**
   * Found by seed 19. The inner scope deforms its left wall, and a room outside
   * it covers that wall: the teeth pointing out are buried, and the one tooth
   * pointing in leaves a notch the room does not reach. The notch is a hole in
   * the union that touches its outline at the corner the tooth starts from.
   *
   * What it turned on: `nested`, in the resolve, asked whether the hole was in
   * the outline at the hole's first point — that corner, on the outline's own
   * boundary — got no, owned it by nothing and dropped it. The scope drew the
   * notch and the resolution did not.
   */
  test('and a notch that touches the outline at a corner is still a hole in it', () => {
    const spec: Spec = { kind: 'group', kit: [], members: [
      { kind: 'group', kit: [d(9)], members: [
        { kind: 'room', at: rect(120, 120, 200, 200) },
        { kind: 'room', at: rect(240, 180, 120, 120) },
      ] },
      { kind: 'room', at: rect(0, 120, 120, 120) },
    ] };

    const { world } = built(emptyWorld(), spec);
    const scope = drawn(world);

    for (const id of world.groups.keys()) {
      const out = resolveGroup(world, 0, id)!;

      expect([id, differing(drawn(out.world), scope)]).toEqual([id, []]);
    }
  });

  /**
   * Found by seed 27. The eroding scope's two rooms touch at one corner, and
   * the union of them passes through that corner twice: once going on along
   * the first room's bottom wall, once along the second's top.
   *
   * What it turned on: the arrangement called both visits by one tag, the
   * first room's corner, so the name that says which wall leaves a point was
   * left along two walls. After the erosion and the other scope's teeth had cut
   * the second room's top into pieces, the outer deform asked which wall each
   * crossing was on, found a wall with points on two lines, and laid every
   * piece from its own middle. The resolution, which names each visit after
   * its own corner, laid them as one wall, and the teeth came out 3.7 apart.
   */
  test('and a corner two rooms touch at is two corners, each leaving by its own wall', () => {
    const spec: Spec = { kind: 'group', kit: [d(2)], members: [
      { kind: 'group', kit: [e(1)], members: [
        { kind: 'room', at: rect(60, 120, 120, 120) },
        { kind: 'room', at: rect(180, 240, 120, 120) },
      ] },
      { kind: 'group', kit: [d(11)], members: [
        { kind: 'room', at: rect(120, 240, 120, 200) },
        { kind: 'room', at: rect(120, 240, 200, 80) },
      ] },
    ] };

    const { world } = built(emptyWorld(), spec);
    const scope = drawn(world);

    for (const id of world.groups.keys()) {
      const out = resolveGroup(world, 0, id)!;

      expect([id, differing(drawn(out.world), scope)]).toEqual([id, []]);
    }
  });

  /**
   * Found by seed 20. The middle scope deforms, and one of its walls is named
   * by a crossing that heads two runs, so the first tooth of that wall is laid
   * twice under one name: once far off on the right, once as a flank the outer
   * erosion leaves standing and another wall cuts in two.
   *
   * What it turned on: the outer deform follows each piece of a cut wall back
   * to the edge it carries on, and asked that every other point of that edge
   * lie on the piece's line. The copy on the right did not, so the pieces were
   * never joined and each was laid from its own middle; and where they were,
   * the line was taken from whichever piece by that name came first. The
   * resolution, whose flank is one corner's edge, laid them as one wall.
   */
  test('and a tooth laid twice under one name still carries its cut pieces as one wall', () => {
    const spec: Spec = { kind: 'group', kit: [e(16), d(1)], members: [
      { kind: 'group', kit: [e(9), d(8)], members: [
        { kind: 'room', at: rect(180, 0, 120, 120) },
        { kind: 'group', kit: [e(1), r(1), d(1)], members: [
          { kind: 'room', at: rect(180, 120, 120, 160) },
          { kind: 'room', at: rect(240, 0, 160, 120) },
        ] },
      ] },
      { kind: 'room', at: rect(60, 0, 80, 120) },
    ] };

    const { world } = built(emptyWorld(), spec);
    const scope = drawn(world);

    for (const id of world.groups.keys()) {
      const out = resolveGroup(world, 0, id)!;

      expect([id, differing(drawn(out.world), scope)]).toEqual([id, []]);
    }
  });

  test('nor does resolving a scope inside it', () => {
    fc.assert(fc.property(arbScope, spec => {
      const { world } = built(emptyWorld(), spec);
      const inner = [...world.groups.keys()];
      const scope = drawn(world);

      for (const id of inner) {
        const out = resolveGroup(world, 0, id);

        if (out === null) continue;

        expect([id, differing(drawn(out.world), scope)]).toEqual([id, []]);
      }
    }), RUNS);
  }, SLOW);

  test('and resolving every scope, innermost first, leaves the same outline', () => {
    fc.assert(fc.property(arbScope, spec => {
      const { world } = built(emptyWorld(), spec);
      const was = drawn(world);
      let w = world;

      // Innermost first: a group holding no group is one, and resolving it
      // makes its holder the innermost in turn.
      while (true) {
        const id = [...w.groups.keys()].find(g => ![...w.groups.values()].some(h => h.members?.includes?.(g)));
        const out = id === undefined ? null : resolveGroup(w, 0, id);

        if (out === null) break;

        w = out.world;
        expect(differing(drawn(w), was)).toEqual([]);
      }
    }), RUNS);
  }, SLOW);
});

// -----------------------------------------------------------------------------
// Law 2 — sealing draws what was there
// -----------------------------------------------------------------------------

describe('law 2: sealing draws what was there', () => {
  test('with no effect anywhere', () => {
    fc.assert(fc.property(arbLoose, members => {
      let loose = emptyWorld();
      const ids: Id[] = [];

      for (const m of members) {
        const made = built(loose, bare(m));

        loose = made.world;
        ids.push(made.id);
      }

      const g = grouped(loose, 0, ids, TOP)!;

      expect(differing(drawn(sealing(g.world, g.id, true)), drawn(loose))).toEqual([]);
    }), RUNS);
  }, SLOW);

  test('sealing things into a scope that lays nothing does not move the outline', () => {
    fc.assert(fc.property(arbLoose, members => {
      let loose = emptyWorld();
      const ids: Id[] = [];

      for (const m of members) {
        const made = built(loose, m);

        loose = made.world;
        ids.push(made.id);
      }

      const g = grouped(loose, 0, ids, TOP)!;
      const sealed = sealing(g.world, g.id, true);

      expect(differing(drawn(sealed), drawn(loose))).toEqual([]);
    }), RUNS);
  }, SLOW);
});

// -----------------------------------------------------------------------------
// Law 3 — an effect on a scope is an effect on its resolution
// -----------------------------------------------------------------------------

/**
 * `kit` laid at the end of the scope's list, against `kit` laid on what the
 * scope resolves to.
 *
 * The resolution is several polygons and the effect goes on *them*, not on
 * each: sealed back into a scope of their own, which by law 1 draws what they
 * draw, and the kit put on that. A single polygon takes it at the end of its
 * own list, which the resolve handed it as the scope's.
 */
function bothWays(spec: Spec, kit: Kit): void {
  expect(bothWaysDiffer(spec, kit)).toEqual([]);
}

function bothWaysDiffer(spec: Spec, kit: Kit): string[] {
  const { world, id } = built(emptyWorld(), spec);
  const onScope = drawn(kitted(world, id, kit));
  const out = resolveGroup(world, 0, id);

  if (out === null) return [];

  const after = out.ids.length < 2
    ? kitted(out.world, out.ids[0], kit)
    : (() => {
        const g = grouped(out.world, 0, out.ids, TOP)!;

        return kitted(sealing(g.world, g.id, true), g.id, kit);
      })();

  return differing(drawn(after), onScope);
}

describe('law 3: an effect on a scope is an effect on its resolution', () => {
  test('a round, on a scope with no effect under it', () => {
    fc.assert(fc.property(arbScope, fc.integer({ min: 1, max: 40 }), (spec, by) => {
      bothWays(bare(spec), [r(by)]);
    }), RUNS);
  }, SLOW);

  test('a round', () => {
    fc.assert(fc.property(arbScope, fc.integer({ min: 1, max: 40 }), (spec, by) => {
      bothWays(spec, [r(by)]);
    }), RUNS);
  }, SLOW);

  test('an erosion', () => {
    fc.assert(fc.property(arbScope, fc.integer({ min: 1, max: 20 }), (spec, by) => {
      bothWays(spec, [e(by)]);
    }), RUNS);
  }, SLOW);

  test('a deform', () => {
    fc.assert(fc.property(arbScope, fc.integer({ min: 1, max: 12 }), (spec, by) => {
      bothWays(spec, [d(by)]);
    }), RUNS);
  }, SLOW);

  test('a list of them', () => {
    fc.assert(fc.property(arbScope, arbKit, (spec, kit) => {
      bothWays(spec, kit);
    }), RUNS);
  }, SLOW);
});

// -----------------------------------------------------------------------------
// A list on a scope is its layers on nested scopes
// -----------------------------------------------------------------------------

/**
 * `spec` with its top scope's list taken apart: the scope keeps none, and each
 * of its layers is a scope of its own around the one before, first innermost.
 *
 * A group wants two members, so each of those scopes holds a room far off as
 * well, and `near` crops the drawing back to where the rooms are. `together`
 * is the list left whole, with the same far rooms standing loose beside it: a
 * drawing's span sets the tolerance it is compared at, so both have them.
 */
function unnested(spec: Spec & { kind: 'group' }): { apart: World, together: World } {
  const { world, id } = built(emptyWorld(), { ...spec, kit: [] });
  let apart = world, top = id;
  let together = built(emptyWorld(), spec).world;

  spec.kit.forEach((l, i) => {
    const far = rect(FAR + i * 300, 0, 60, 60);
    const away = addPolygon(apart, { level: 'hollow' }, far, 0, TOP);
    const g = grouped(away.world, 0, [top, away.id], TOP)!;

    apart = kitted(sealing(g.world, g.id, true), g.id, [l]);
    top = g.id;
    together = addPolygon(together, { level: 'hollow' }, far, 0, TOP).world;
  });

  return { apart, together };
}

/** Past anything `arbRect` draws, and past its teeth. */
const FAR = 2000;

const near = (lines: [Point, Point][]) => lines.filter(([a, b]) => a.x < FAR - 100 && b.x < FAR - 100);

describe('a list on a scope draws what its layers on nested scopes draw', () => {
  test('one each, innermost first', () => {
    fc.assert(fc.property(arbScope, spec => {
      if (spec.kind === 'room') return;

      const { apart, together } = unnested(spec);

      expect(differing(near(drawn(apart)), near(drawn(together)))).toEqual([]);
    }), RUNS);
  }, SLOW);
});

// -----------------------------------------------------------------------------
// Shrinking a counterexample by hand
// -----------------------------------------------------------------------------

/**
 * A law 1 counterexample, shrunk: `LAW_SHRINK='<spec json>' pnpm vitest run
 * laws -t shrink`, or with `LAW_NEST=1` one of a list against its nesting,
 * or with `LAW_THREE='<kit json>'` one of law 3 laying that kit. fast-check will not shrink a replayed seed, and even
 * unreplayed its shrinks keep the arrangement's shape. This one drops
 * members, lifts a group's members into its holder and lowers each amount,
 * one step at a time for as long as some scope still resolves to a different
 * drawing, and prints what is left with the difference.
 */
test.skipIf(process.env.LAW_SHRINK === undefined)('shrink a law 1 counterexample', () => {
  const diffs = (spec: Spec) => {
    if (process.env.LAW_THREE !== undefined) {
      const d = bothWaysDiffer(spec, JSON.parse(process.env.LAW_THREE));

      return d.length > 0 ? [[-1, d] as [Id, string[]]] : [];
    }

    if (process.env.LAW_NEST !== undefined) {
      if (spec.kind === 'room') return [];

      const { apart, together } = unnested(spec);
      const d = differing(near(drawn(apart)), near(drawn(together)));

      return d.length > 0 ? [[-1, d] as [Id, string[]]] : [];
    }

    const { world } = built(emptyWorld(), spec);
    const scope = drawn(world);
    const out: [Id, string[]][] = [];

    for (const id of world.groups.keys()) {
      const r = resolveGroup(world, 0, id);

      if (r === null) continue;

      const d = differing(drawn(r.world), scope);

      if (d.length > 0) out.push([id, d]);
    }

    return out;
  };
  const fails = (spec: Spec) => {
    try {
      return diffs(spec).length > 0;
    }
    catch {
      return false;
    }
  };
  const smaller = function* (s: Spec): Generator<Spec> {
    for (let i = 0; i < (s.kit ?? []).length; i++) {
      const k = s.kit!, l = k[i];
      const kit = (by: Laid[]) => [...k.slice(0, i), ...by, ...k.slice(i + 1)];

      yield { ...s, kit: kit([]) };
      for (let v = 1; v < l.by; v++) yield { ...s, kit: kit([{ ...l, by: v }]) };
    }

    if (s.kind === 'room') return;

    const at = (i: number, ...by: Spec[]) => [...s.members.slice(0, i), ...by, ...s.members.slice(i + 1)];

    for (let i = 0; i < s.members.length; i++) {
      const m = s.members[i];

      if (s.members.length > 2) yield { ...s, members: at(i) };

      if (m.kind === 'group') {
        for (const inner of m.members) yield { ...s, members: at(i, inner) };
        yield { ...s, members: at(i, ...m.members) };
      }

      for (const v of smaller(m)) yield { ...s, members: at(i, v) };
    }
  };

  let spec: Spec = JSON.parse(process.env.LAW_SHRINK!);

  expect(fails(spec)).toBe(true);

  let again = true;

  while (again) {
    again = false;

    for (const v of smaller(spec)) {
      if (fails(v)) {
        spec = v;
        again = true;
        break;
      }
    }
  }

  console.log(JSON.stringify(spec));
  console.log(JSON.stringify(diffs(spec), null, 1));
}, SLOW);
