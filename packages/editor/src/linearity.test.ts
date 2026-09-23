// -----------------------------------------------------------------------------
// Does a span still stretch, under a fold of effects?
//
// `PLAN-effect` step 1, and the question that is asked before anything is
// built. The bake cuts a span into stretches and lerps across each, so it needs
// the outline to move *smoothly enough in `t`* that halving a stretch quarters
// the error. `PLAN-bevel` had that from each step being linear in its own
// amount and the amounts being summed across nesting. The fold has no sum in
// it, so the property has to be re-made in the fold's own form: **a composition
// of maps each linear in its own amount**, which is not the same claim and does
// not follow from it.
//
// What is measured is the fold's, not the editor's. The pipeline being replaced
// cannot say `round` as an opening at all — that is the whole of why it is
// being replaced — so measuring it would answer a question about the design
// going out. The effects here are built from the boolean ops and nothing else:
// `dilate` is the Minkowski sum with a disc, `erode` is that of the complement,
// and `round` is the opening, exactly as the plan states them.
//
// How it is measured
// ------------------
// Not by pairing points. Two evaluations at two instants have different rings
// with different numbers of points in them, and pairing them is precisely what
// the design is getting rid of. What is compared instead is the boundary as a
// *field*: a probe, and how far it is from the outline, signed. That is defined
// at every instant with no reference to how either outline was cut.
//
// A lerp across a stretch is exact when the field is affine in `t`, so the
// number taken is the second difference
//
//   D(h) = max over probes | φ(t₀) - 2φ(t₀ + h/2) + φ(t₀ + h) |
//
// which is twice the error a lerp makes in the middle. Nought is affine; `h²`
// is smooth, so halving `h` quarters `D`, which is what the bisection in
// `bake.ts` lives on; `h` is a kink, which bisection still converges on, only
// linearly; and not shrinking at all is a jump, which nothing but a stretch
// boundary answers.
//
// The probes are the **middles of the facets** of the outline at the instant
// being checked, and not its corners. A corner is the one place the field says
// the wrong thing: an offset moves a corner *along its own bisector*, so a
// probe sitting on one watches the boundary slide past it tangentially and
// reads a `|t|` where the boundary is doing nothing of the kind. A facet's
// middle keeps the facet as its nearest feature throughout, and what it reads
// is the normal displacement, which is what the lerp has to reproduce. Probing
// the corners instead puts a first-order floor under every case here, and that
// floor is the only thing it measures.
//
// What it finds
// -------------
// **The fold stretches.** Each step on its own is affine in its own amount to
// machine precision — not nearly affine, affine — and the reason is worth
// having in one line, because it is the whole answer:
//
//   a point of a dilated boundary lies either on a translate of an edge, whose
//   line moves by exactly `b` along its own normal, or on an arc of radius `b`
//   about a corner, whose distance from any fixed probe is `|p - v| - b`.
//
// So dilation moves the field by `-b` outright and erosion by `+b`, whatever
// the shape is. A union takes the smallest field of its members and an
// intersection the largest, which are smooth wherever one member is strictly
// nearest and kink where two are equidistant — on the medial axis, which is
// where a notch closes and a corner is born, and which is an *event*. A fold is
// therefore a composition of maps each affine in its own amount and each smooth
// in the frame it is taken in, and it is non-smooth only where the nearest
// feature changes — which is what a stretch boundary already is.
//
// The opening comes out affine too, which it had no right to be: it puts an arc
// of radius `b` where a corner was and leaves every wall on its own line, so
// the field moves by nothing on the walls and by `b` on the arcs. That holds
// only while no feature changes across the stretch, and where one does — a
// notch closing under an erosion, a ring going — the ladder's coarse rung is
// enormous and its fine rungs are at the floor. That is an *event*, it is what
// a stretch boundary is for, and it is the shape of the answer rather than a
// failure of it.
//
// What is not affine is the composition, and nothing here claims it is: two
// rounds one inside the other move the boundary by a quantity that is smooth in
// both amounts and linear in neither. What the ladders show is that it is
// *smooth*, which is all the bisection ever needed.
//
// The one thing genuinely new is `round(max(a, b))`. The plan's reading of law
// 3 puts a max where the old design put a sum, and a max of two amounts that
// are both moving has a kink in `t` where they cross. That is the last ladder,
// and it comes down like `h` and not like `h²`. It costs one stretch boundary
// per pair of rounds per span, it is known from the keyframes outright rather
// than having to be hunted for, and the bisection converges on it either way.
// Nothing in the design has to change for it.
// -----------------------------------------------------------------------------

import { describe, expect, test } from 'vitest';
import { Point } from '@ce/game/world';
import { Cut, Shape, contains, isCCW, simplify, subtract, unionAll } from './geometry';

// -----------------------------------------------------------------------------
// The effects, as the plan says them
// -----------------------------------------------------------------------------

/** How many sides a disc is drawn with. */
const FACETS = 24;

/** How fine a boundary is kept between one effect and the next: `PLAN-effect`'s
 * canonical resample, in the crudest form that answers this question. What it
 * is here for is only that the point count stops depending on how many effects
 * have run — a fold three deep with every facet of every pass kept is a
 * boundary of tens of thousands of points, and what that costs is not the thing
 * being measured. */
const EPS = 1;

/** A disc of radius `b` about `c`, as a polygon through the radius. */
function disc(c: Point, b: number): Point[] {
  const out: Point[] = [];

  for (let i = 0; i < FACETS; i++) {
    const a = (i / FACETS) * Math.PI * 2;

    out.push({ x: c.x + b * Math.cos(a), y: c.y + b * Math.sin(a) });
  }

  return out;
}

/** The same ring wound anticlockwise: what the nonzero rule wants of rings that
 * are meant to add up rather than cancel. */
function wound(ring: Point[]): Point[] {
  return isCCW(ring) ? ring : [...ring].reverse();
}

/** Points closer together than `EPS` dropped, and a ring left with fewer than
 * three of them dropped with them. */
function thinned(shape: Cut): Cut {
  const out: Point[][] = [];

  for (const ring of shape) {
    const kept: Point[] = [];

    for (const p of ring) {
      const last = kept.at(-1);

      if (last === undefined || Math.hypot(p.x - last.x, p.y - last.y) > EPS) kept.push(p);
    }

    if (kept.length >= 3) out.push(kept);
  }

  return out as Cut;
}

/**
 * The Minkowski sum of `shape` with a disc of radius `b`.
 *
 * A rectangle of half-width `b` laid along every edge and a disc at every
 * corner, unioned with the shape. The half of each rectangle that falls inside
 * is within `b` of an edge and so inside the sum anyway, which is what lets
 * this take no notice of which way a ring is wound.
 *
 * Three shapes go to the arrangement and not two thousand: rings of one winding
 * inside one shape are already their union under the nonzero rule, and a shape
 * apiece costs a field apiece — which is what ran a fold three deep out of
 * memory.
 */
function dilate(shape: Shape, b: number): Cut {
  if (b === 0) return simplify(shape);

  const quads: Point[][] = [];
  const discs: Point[][] = [];

  for (const ring of shape) {
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length];
      const dx = q.x - p.x, dy = q.y - p.y, len = Math.hypot(dx, dy);

      if (len > 0) {
        const nx = (-dy / len) * b, ny = (dx / len) * b;

        quads.push(wound([
          { x: p.x + nx, y: p.y + ny },
          { x: q.x + nx, y: q.y + ny },
          { x: q.x - nx, y: q.y - ny },
          { x: p.x - nx, y: p.y - ny },
        ]));
      }

      discs.push(disc(p, b));
    }
  }

  return thinned(unionAll([shape, quads, discs]));
}

/** Where everything in these worlds happens, with room for the widest dilation
 * round it: what a complement is taken against. */
const BOX: Point[] = [{ x: -2000, y: -2000 }, { x: 2000, y: -2000 }, { x: 2000, y: 2000 }, { x: -2000, y: 2000 }];

/** The offset in, as the dilation of the complement — arcs where the mitred
 * offset spikes, and the same construction read the other way, which is what
 * the two passes of an opening need of each other. */
function erode(shape: Shape, b: number): Cut {
  if (b === 0) return simplify(shape);

  return subtract([BOX], dilate(subtract([BOX], shape), b));
}

/** The round: the morphological opening, in by `b` and out by `b`. */
function round(shape: Shape, b: number): Cut {
  return dilate(erode(shape, b), b);
}

// -----------------------------------------------------------------------------
// The field, and the second difference taken of it
// -----------------------------------------------------------------------------

/** How far `p` is from the nearest edge of `shape`, negative inside it. */
function field(shape: Shape, p: Point): number {
  let near = Infinity;

  for (const ring of shape) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
      const u = l2 === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));

      near = Math.min(near, Math.hypot(p.x - a.x - dx * u, p.y - a.y - dy * u));
    }
  }

  return contains(shape, p) ? -near : near;
}

/** The middles of the facets of `shape`: where the field is asked. See the head
 * of the file for why it is these and not the corners. */
function probes(shape: Shape): Point[] {
  const out: Point[] = [];

  for (const ring of shape) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];

      out.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    }
  }

  return out;
}

/** A world in flight: the outline at any instant of the span. */
type World = (t: number) => Shape;

/** Twice the error a lerp across `[t₀, t₀ + h]` makes in the middle of it. */
function second(world: World, t0: number, h: number): number {
  const a = world(t0), m = world(t0 + h / 2), b = world(t0 + h);
  let worst = 0;

  for (const p of probes(m)) {
    worst = Math.max(worst, Math.abs(field(a, p) - 2 * field(m, p) + field(b, p)));
  }

  return worst;
}

const lines: string[] = [];

/**
 * The ladder: the second difference at `h`, `h/2` and `h/4`, and what each
 * halving bought.
 *
 * The finest rung is what the assertions are made on. A coarse stretch may
 * still have a feature change inside it, which is a fact about that stretch and
 * not about the fold; what the bisection needs to know is what happens as the
 * stretch shortens, which is the far end of the ladder.
 */
function ladder(name: string, world: World, t0: number, h: number) {
  const at = [h, h / 2, h / 4].map(step => second(world, t0, step));
  const ratios = [at[0] / at[1], at[1] / at[2]];

  lines.push(`${name.padEnd(32)}${at.map(d => d.toExponential(2).padStart(10)).join(' ')}`
    + `   ×${ratios.map(r => r.toFixed(2).padStart(7)).join(' ×')}`);

  return { at, ratios };
}

/**
 * The same ladder, kept centred on `about` as it shortens.
 *
 * A ladder anchored at its left end walks *off* an instant in the middle of it,
 * which is exactly what must not happen when the instant is the thing being
 * measured: the second rung would end on the kink and the third would be clear
 * of it, and a kink would read as smooth.
 */
function ladderAt(name: string, world: World, about: number, h: number) {
  const at = [h, h / 2, h / 4].map(step => second(world, about - step / 2, step));
  const ratios = [at[0] / at[1], at[1] / at[2]];

  lines.push(`${name.padEnd(32)}${at.map(d => d.toExponential(2).padStart(10)).join(' ')}`
    + `   ×${ratios.map(r => r.toFixed(2).padStart(7)).join(' ×')}`);

  return { at, ratios };
}

// -----------------------------------------------------------------------------
// The worlds
// -----------------------------------------------------------------------------

function rect(x: number, y: number, w: number, h: number): Point[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

function turned(ring: Point[], about: Point, angle: number): Point[] {
  const c = Math.cos(angle), s = Math.sin(angle);

  return ring.map(p => ({
    x: about.x + (p.x - about.x) * c - (p.y - about.y) * s,
    y: about.y + (p.x - about.x) * s + (p.y - about.y) * c,
  }));
}

/** Two rooms crossing, standing still: the members of a scope, with nothing
 * moving but the amounts laid on them. */
const still: Shape = [rect(-200, -60, 400, 120), rect(-40, -180, 80, 360)];

/** The same, with the upright sliding across the other and turning as it goes:
 * what the members are doing while the effects run. */
const moving = (t: number): Shape => [
  rect(-200, -60, 400, 120),
  turned(rect(-40 + 90 * t, -180, 80, 360), { x: 90 * t, y: 0 }, 0.6 * t),
];

/** An amount going from `a` to `b` across the span, which is what a keyframe
 * writing one comes to. */
const amount = (a: number, b: number) => (t: number) => a + (b - a) * t;

// -----------------------------------------------------------------------------
// The ladders
// -----------------------------------------------------------------------------

describe('a span stretches under a fold of effects', () => {
  /** What an affine step leaves behind: the arrangement's own arithmetic, and
   * nothing else. Units, against rooms four hundred across. */
  const EXACT = 1e-6;

  /** The floor the crude resample here puts under everything: points are
   * dropped by a rule that is a threshold, so which points survive changes
   * discretely with `t` and a hundredth of a unit of that reaches the field.
   * `PLAN-effect` step 4 is where that is done properly; nothing below is asked
   * for anything finer. */
  const FLOOR = 1e-1;

  describe('each step alone is affine in its own amount', () => {
    test('a dilation', () => {
      const by = amount(10, 40);

      expect(Math.max(...ladder('dilate', t => dilate(still, by(t)), 0.2, 0.4).at)).toBeLessThan(EXACT);
    });

    test('an erosion', () => {
      const by = amount(4, 26);

      expect(Math.max(...ladder('erode', t => erode(still, by(t)), 0.2, 0.4).at)).toBeLessThan(EXACT);
    });

    /**
     * And the opening, which is two steps and had no reason to be affine at
     * all: it is, wherever no feature changes across the stretch. An opening by
     * `b` puts an arc of radius `b` where a corner was and leaves every wall on
     * its own line, so the field moves by nothing on the walls and by `b` on
     * the arcs, and neither is only nearly linear.
     */
    test('a round', () => {
      const by = amount(20, 38);

      expect(Math.max(...ladder('round', t => round(still, by(t)), 0.2, 0.16).at)).toBeLessThan(EXACT);
    });
  });

  describe('a fold of them is smooth', () => {
    /** A stretch of a twentieth of a span, and how far a lerp across it is from
     * the truth: what the bisection is trying to get under, and what these
     * cases are held to. */
    const fine = (r: { at: number[] }) => r.at[2];

    test('a round over an erosion, both moving', () => {
      const depth = amount(4, 16), by = amount(24, 40);
      const r = ladder('erode → round', t => round(erode(still, depth(t)), by(t)), 0.2, 0.16);

      expect(fine(r)).toBeLessThan(FLOOR);
    });

    /**
     * Three deep: a member rounded, that eroded, and the scope over it rounded
     * again, every amount moving. This is the case `PLAN-bevel` cannot say at
     * all — the outermost round is laid on a boundary that is already arcs —
     * and it is the one the whole question is asked for.
     *
     * Its coarse rung is enormous and its fine ones are at the floor, which is
     * the shape of the answer and not a failure of it: at a sixth of a span the
     * erosion is closing the notch between the two rooms, which is a feature
     * change and so an event, and the moment the stretch is short enough to sit
     * clear of it the fold is smooth again. A stretch boundary is exactly what
     * that asks for.
     */
    test('a fold three deep', () => {
      const inner = amount(12, 22), depth = amount(4, 12), outer = amount(30, 40);
      const world = (t: number) => round(erode(round(still, inner(t)), depth(t)), outer(t));
      const r = ladder('round → erode → round', world, 0.2, 0.16);

      expect(fine(r)).toBeLessThan(FLOOR);
    });

    /** And with the members moving under it, which is the rest of what a span
     * has in it. The room is crossing the other at ninety units a span, so what
     * a lerp has to reproduce here is mostly the motion, and it comes down like
     * the motion does. */
    test('a fold three deep over members that are moving', () => {
      const inner = amount(12, 22), depth = amount(4, 12), outer = amount(30, 40);
      const world = (t: number) => round(erode(round(moving(t), inner(t)), depth(t)), outer(t));
      const r = ladder('the same, members moving', world, 0.2, 0.16);

      expect(r.at[2]).toBeLessThan(r.at[1] / 2.5);
    });
  });

  describe('where it kinks, and what that costs', () => {
    const a = amount(16, 40), b = amount(40, 16);
    const crossing = (t: number) => round(round(still, a(t)), b(t));
    let atCrossing = 0;

    /**
     * Two rounds whose amounts cross inside the span.
     *
     * `round(a)` then `round(b)` is `round(max(a, b))` — an opening by the
     * smaller does nothing to a boundary already open by the larger — so the
     * outline has a kink in `t` at the instant the two are equal. Halving the
     * stretch halves the error and does not quarter it, and it goes on halving
     * it however far the ladder is run, which is what says the kink is real and
     * not something the arrangement left behind.
     */
    test('two rounds whose amounts cross', () => {
      const r = ladderAt('round × round, crossing at ½', crossing, 0.5, 0.24);

      atCrossing = r.at[2];

      // What a kink leaves: the slope of `max(a, b)` turns by 48 units a span
      // here, so a stretch of `h` about the crossing carries `h · 48 / 4` of
      // error however short it is — 0.72 at the finest rung, against a floor of
      // a tenth. It is an order clear of the floor and it stays there.
      expect(atCrossing).toBeGreaterThan(0.3);

      for (const ratio of r.ratios) expect(ratio).toBeLessThan(3.2);
    });

    /** The same pair, clear of the crossing, where `max` has nothing to choose:
     * the kink is an instant, not a condition of the span. */
    test('the same two rounds, clear of the crossing', () => {
      const r = ladderAt('round × round, clear of it', crossing, 0.15, 0.24);

      expect(r.at[2]).toBeLessThan(FLOOR);
      expect(r.at[2]).toBeLessThan(atCrossing / 10);
    });
  });

  test('the ladders', () => {
    console.log(`\n${''.padEnd(32)}${['h', 'h/2', 'h/4'].map(s => s.padStart(10)).join(' ')}\n${lines.join('\n')}\n`);
  });
});
