// -----------------------------------------------------------------------------
// The erosion, as an effect
//
// Two things to hold it to, and they pull opposite ways. It has to draw exactly
// what `erode` draws — this is the existing offset wrapped, not a second one,
// and a wrapper that moved the outline by a hair would have replaced the thing
// it was meant to carry names through. And the names have to be the ones the
// construction gives: a corner that survives is itself, a corner pushed inwards
// is still itself, and a corner the erosion *made* is `born` of the two walls
// whose bands crossed to make it.
//
// The second is what the whole design turns on, so the tests for it are the
// cases where a corner is genuinely made and genuinely lost: a notch closing
// and taking the room with it into two rooms, and a shape eroded past its own
// middle.
// -----------------------------------------------------------------------------

import { describe, expect, test } from 'vitest';
import { Point } from '@ce/game/world';
import { Effecting, OpSubtract, Shape, along, erode, rounded, shapeArea, simplify } from './geometry';
import { deforming, dilating, eroding, resampled, rounding } from './effect';
import { Drawn, Ident, combineIdentified, corner, identify, madeOf, on, shows } from './ids';

function rect(x: number, y: number, w: number, h: number): Point[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

function drawn(shape: Shape, member: number): Drawn {
  const cut = simplify(shape);

  return { shape: cut, ids: identify(cut, member) };
}
const names = (it: Drawn) => it.ids.map(ring => ring.map(shows));

/** A room with a slot cut into it from above, and the slot narrow enough that
 * an erosion closes it — which is where a corner is born and a ring dies. */
const notched = (): Drawn => combineIdentified(
  drawn([rect(0, 0, 200, 120)], 0),
  drawn([rect(80, 40, 40, 100)], 1),
  OpSubtract,
);

describe('it draws what the offset draws', () => {
  const cases: [string, Shape, number][] = [
    ['a room', [rect(0, 0, 200, 100)], 10],
    ['a room, grown', [rect(0, 0, 200, 100)], -10],
    ['a room with a hole in it', [rect(0, 0, 200, 200), rect(160, 60, 20, 80).reverse()], 8],
    ['a notch, open', notched().shape, 5],
    ['a notch, closed', notched().shape, 25],
    ['eroded away altogether', [rect(0, 0, 40, 40)], 30],
  ];

  for (const [what, shape, depth] of cases) {
    test(what, () => {
      const was = erode(simplify(shape), depth);
      const now = eroding(depth)(drawn(shape, 0));

      expect(now.shape.map(ring => ring.map(p => [p.x, p.y]))).toEqual(
        was.map(ring => ring.map(p => [p.x, p.y])),
      );
      expect(shapeArea(now.shape)).toBe(shapeArea(was));
    });
  }
});

describe('and names what it draws', () => {
  test('every point has exactly one name', () => {
    const r = eroding(25)(notched());

    expect(r.ids.length).toBe(r.shape.length);
    r.shape.forEach((ring, i) => expect(r.ids[i].length).toBe(ring.length));
  });

  test('a corner that only moves is the corner it was', () => {
    const r = eroding(10)(drawn([rect(0, 0, 200, 100)], 0));

    expect(names(r)).toEqual([['0.0', '0.1', '0.2', '0.3']]);
    expect(r.shape[0].map(p => [p.x, p.y])).toEqual([[10, 10], [190, 10], [190, 90], [10, 90]]);
  });

  test('and so is one that turns a concave corner', () => {
    // An L: six corners in and six out, the erosion having consumed none of
    // them and made none.
    const l: Shape = [[
      { x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 60 },
      { x: 80, y: 60 }, { x: 80, y: 160 }, { x: 0, y: 160 },
    ]];

    expect(names(eroding(12)(drawn(l, 1)))).toEqual([['1.0', '1.1', '1.2', '1.3', '1.4', '1.5']]);
  });

  test('a corner the erosion makes is born of the two walls that made it', () => {
    const it = notched();

    // Open, the notch is a notch and nothing is born of the erosion: the two
    // crossings are the ones the subtraction made, and they are the names the
    // shape came in with.
    expect(names(eroding(5)(it))).toEqual(names(it));

    // Closed, the room is two rooms, and each of the corners where they parted
    // knows which walls closed on each other to part them.
    expect(names(eroding(25)(it))).toEqual([
      ['((0.2×1.1)×0.0)', '0.1', '0.2', '(0.2×1.1)'],
      ['0.0', '(0.0×1.0)', '(0.2×1.3)', '0.3'],
    ]);
  });

  test('a name is of the construction, so the geometry may move', () => {
    const at = (dx: number, dy: number): Shape => notched().shape.map(
      ring => ring.map(p => ({ x: p.x + dx, y: p.y + dy })),
    );
    const said = (dx: number, dy: number) =>
      names(eroding(25)({ shape: at(dx, dy), ids: notched().ids }));

    expect(said(600, -250)).toEqual(said(0, 0));
  });

  test('a second erosion names off the first, as deep as it goes', () => {
    const once = eroding(12)(notched());
    const twice = eroding(13)(once);

    // 12 then 13 closes the same notch 25 did, and says so in the same names —
    // the second erosion having found the first's corners already named.
    expect(names(twice).flat().some(s => s.includes('×'))).toBe(true);
    expect(names(twice).flat()).toContain('(0.0×1.0)');
  });

  test('a growing erosion names its points too', () => {
    const r = eroding(-10)(drawn([rect(0, 0, 200, 100)], 0));

    expect(names(r)).toEqual([['0.0', '0.1', '0.2', '0.3']]);
    expect(r.shape[0].map(p => [p.x, p.y])).toEqual([[-10, -10], [210, -10], [210, 110], [-10, 110]]);
  });

  test('a shape eroded away has nothing to name', () => {
    expect(names(eroding(30)(drawn([rect(0, 0, 40, 40)], 0)))).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// The canonical resample
//
// The promise is that how many points a ring has is a question about the
// geometry and `eps`, and not about how many effects have run over it. So the
// tests hand it the same circle sampled three different ways and ask for the
// count, hand it its own answer back and ask again, and check that the points
// a construction turned the boundary at are all still there afterwards.
// -----------------------------------------------------------------------------

/** A circle of `n` facets: one corner to hang the run on, and samples after it. */
function disc(n: number, radius = 100, member = 9): Drawn {
  const ring: Point[] = [];
  const ids: Ident[] = [];
  const first = corner(member, 0);

  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;

    ring.push({ x: Math.cos(a) * radius, y: Math.sin(a) * radius });
    ids.push(i === 0 ? first : on(first, i / n));
  }

  return { shape: [ring], ids: [ids] };
}

/** A square whose walls have been sampled to death: the four corners, and
 * `per` samples along each wall between them. */
function sampled(per: number, member = 8): Drawn {
  const at = rect(0, 0, 200, 200);
  const ring: Point[] = [];
  const ids: Ident[] = [];

  at.forEach((p, i) => {
    const q = at[(i + 1) % at.length];
    const here = corner(member, i);

    ring.push(p);
    ids.push(here);

    for (let s = 1; s <= per; s++) {
      const t = s / (per + 1);

      ring.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
      ids.push(on(here, t));
    }
  });

  return { shape: [ring], ids: [ids] };
}

describe('the canonical resample', () => {
  test('how many points a curve keeps is a question about eps, not about its input', () => {
    for (const eps of [0.5, 2, 8]) {
      const counts = [64, 128, 256].map(n => resampled(disc(n), eps).shape[0].length);

      expect(counts).toEqual([counts[0], counts[0], counts[0]]);
    }

    // And a coarser accuracy really does keep fewer of them.
    const at = (eps: number) => resampled(disc(128), eps).shape[0].length;

    expect(at(0.5)).toBeGreaterThan(at(2));
    expect(at(2)).toBeGreaterThan(at(8));
  });

  test('and it says the same names for them at any sampling', () => {
    const said = (n: number) => resampled(disc(n), 2).ids[0].map(shows);

    expect(said(128)).toEqual(said(64));
    expect(said(256)).toEqual(said(64));
    expect(said(64).slice(0, 3)).toEqual(['9.0', '9.0@0.0625', '9.0@0.125']);
  });

  test('running it again changes nothing', () => {
    // The names outright, the points to machine precision: a station is found
    // by walking arc length, and walking a hundred chords instead of a
    // thousand does not add up quite the same way.
    for (const eps of [0.5, 2, 8]) {
      const once = resampled(disc(128), eps);
      const twice = resampled(once, eps);

      expect(twice.ids.map(r => r.map(shows))).toEqual(once.ids.map(r => r.map(shows)));

      once.shape[0].forEach((p, i) => {
        expect(Math.hypot(p.x - twice.shape[0][i].x, p.y - twice.shape[0][i].y)).toBeLessThan(1e-9);
      });
    }
  });

  test('a point a construction turned the boundary at is never resampled away', () => {
    const it = sampled(7);
    const r = resampled(it, 1);
    const held = it.ids[0].filter(id => !shows(id).includes('@')).map(shows);

    expect(r.ids[0].map(shows)).toEqual(expect.arrayContaining(held));
    expect(r.shape[0]).toEqual(expect.arrayContaining(rect(0, 0, 200, 200)));
  });

  test('and a straight run keeps nothing between its ends', () => {
    // Four corners and nothing else: every sample along a wall is describing a
    // wall that the two corners already say everything about.
    const r = resampled(sampled(7), 1);

    expect(r.ids[0].map(shows)).toEqual(['8.0', '8.1', '8.2', '8.3']);
  });

  test('a ring never grows under it', () => {
    for (const per of [0, 1, 7]) {
      const it = sampled(per);

      expect(resampled(it, 1).shape[0].length).toBeLessThanOrEqual(it.shape[0].length);
    }

    expect(resampled(disc(16), 0.001).shape[0].length).toBeLessThanOrEqual(16);
  });

  test('a shape it has nothing to say about comes back as it was', () => {
    const it = drawn([rect(0, 0, 200, 100)], 0);
    const r = resampled(it, 1);

    expect(r.shape).toEqual(it.shape);
    expect(r.ids.map(g => g.map(shows))).toEqual(it.ids.map(g => g.map(shows)));
  });

  test('every point still has exactly one name', () => {
    const r = resampled(disc(128), 2);

    expect(r.ids.length).toBe(r.shape.length);
    r.shape.forEach((ring, i) => expect(r.ids[i].length).toBe(ring.length));
  });
});

// -----------------------------------------------------------------------------
// The round, as the opening
//
// Held against two things. Against the circle it claims to be, which is what
// `circled` is: a rounded square of true arcs, worked out rather than drawn.
// And against `arcsWith`, which is what the editor draws today and is the look
// that must not change — held, and found to differ, for a reason worth writing
// down.
// -----------------------------------------------------------------------------

/** A square of side `w` with every corner a true arc of radius `b`. */
function circled(w: number, b: number): Point[] {
  const out: Point[] = [];
  const about: [number, number, number][] = [
    [w - b, w - b, 0], [b, w - b, Math.PI / 2], [b, b, Math.PI], [w - b, b, -Math.PI / 2],
  ];

  for (const [cx, cy, from] of about) {
    for (let k = 0; k <= 64; k++) {
      const a = from + (k / 64) * (Math.PI / 2);

      out.push({ x: cx + Math.cos(a) * b, y: cy + Math.sin(a) * b });
    }
  }

  return out;
}

/** How far the two outlines are from one another, either way about: the most
 * any point of each is from the nearest wall of the other. */
function apart(a: readonly Point[], b: readonly Point[]): number {
  const to = (p: Point, ring: readonly Point[]) => Math.min(...ring.map((q, i) => {
    const w = along(q, ring[(i + 1) % ring.length], p);

    return Math.hypot(p.x - w.x, p.y - w.y);
  }));

  return Math.max(
    Math.max(...a.map(p => to(p, b))),
    Math.max(...b.map(p => to(p, a))),
  );
}

const L: Shape = [[
  { x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 60 },
  { x: 80, y: 60 }, { x: 80, y: 160 }, { x: 0, y: 160 },
]];

describe('the dilation', () => {
  test('is the Minkowski sum, to the accuracy it was asked for', () => {
    // A square grown by `by` is the square, four slabs and a disc.
    for (const by of [5, 20]) {
      const r = dilating(by, 0.2)(drawn([rect(0, 0, 200, 200)], 0));
      const want = 200 * 200 + 4 * 200 * by + Math.PI * by * by;

      expect(shapeArea(r.shape)).toBeGreaterThan(want * 0.999);
      expect(shapeArea(r.shape)).toBeLessThan(want);
    }
  });

  test('a wall keeps its name and a corner becomes its own arc', () => {
    const said = dilating(20, 5)(drawn([rect(0, 0, 200, 200)], 0)).ids[0].map(shows);

    // Every point of it is either an end of an arc or a point along one, and
    // every arc is about the corner it was laid on.
    expect(said.every(s => /^0\.[0-3]@/.test(s))).toBe(true);
    expect(said).toContain('0.0@0');
    expect(said).toContain('0.0@1');
  });

  test('and nothing is asked of it at nought', () => {
    const it = drawn([rect(0, 0, 200, 200)], 0);

    expect(dilating(0, 1)(it)).toBe(it);
  });
});

describe('the round', () => {
  test('is the circle it says it is', () => {
    for (const by of [10, 20, 50]) {
      const r = rounding(by, 0.5)(drawn([rect(0, 0, 200, 200)], 0));

      expect(apart(r.shape[0], circled(200, by))).toBeLessThan(0.5);
    }
  });

  test('which is not quite what `arcsWith` draws, and that is `arcsWith`', () => {
    // The old round is a tension curve and not an arc, and it sits further
    // from a true circle the bigger the bevel gets — which is the whole of the
    // difference between the two. A rounded square still reads as a rounded
    // square; it reads as one more exactly than it did.
    for (const by of [10, 20, 50]) {
      const square = rect(0, 0, 200, 200);
      const mine = rounding(by, 0.5)(drawn([square], 0)).shape[0];
      const was = rounded(square, () => by, 24);
      const truth = circled(200, by);

      expect(apart(mine, truth)).toBeLessThan(apart(was, truth) / 3);
    }
  });

  test('rounds every convex corner, whatever made it', () => {
    const r = rounding(15, 0.5)(drawn(L, 1));

    // Six corners in; the five that turn out come back as arcs about
    // themselves, and the one that turns in is untouched.
    for (const v of [0, 1, 2, 4, 5]) {
      expect(r.ids[0].map(shows)).toEqual(expect.arrayContaining([`1.${v}@0`, `1.${v}@1`]));
    }
  });

  test('and leaves a corner that turns in where it was', () => {
    // An opening takes nothing off a concave corner, and the point that comes
    // out of it is born of the two walls meeting there rather than found near
    // where they do.
    const r = rounding(15, 0.5)(drawn(L, 1));
    const at = r.shape[0].findIndex(p => Math.hypot(p.x - 80, p.y - 60) < 1e-9);

    expect(at).toBeGreaterThanOrEqual(0);
    expect(shows(r.ids[0][at])).toBe('(1.2×1.3)');
    expect(r.shape[0][at]).toEqual({ x: 80, y: 60 });
  });

  test('composes as round(max(a, b)) and not as round(a + b)', () => {
    const square = drawn([rect(0, 0, 200, 200)], 0);
    const big = rounding(30, 0.5)(square);
    const after = rounding(30, 0.5)(rounding(10, 0.5)(square));

    // The small round leaves nothing for the big one to find, and the big one
    // is the answer outright — not a round of 40.
    expect(after.shape[0].length).toBe(big.shape[0].length);
    expect(apart(after.shape[0], big.shape[0])).toBeLessThan(1e-9);
    expect(apart(big.shape[0], circled(200, 30))).toBeLessThan(0.5);
  });

  test('and an arc already round enough is left alone', () => {
    const square = drawn([rect(0, 0, 200, 200)], 0);
    const big = rounding(30, 0.5)(square);

    expect(apart(rounding(10, 0.5)(big).shape[0], big.shape[0])).toBeLessThan(1);
  });

  test('a ring does not run away under a fold of them', () => {
    // What it costs must be what one round costs, or nesting is unaffordable.
    let it = drawn([rect(0, 0, 400, 400)], 0);
    const counts: number[] = [];

    for (let k = 0; k < 6; k++) {
      it = rounding(20, 0.5)(it);
      counts.push(it.shape[0].length);
    }

    expect(counts[0]).toBeLessThan(32);
    expect(counts[5]).toBeLessThan(counts[0] * 3);
  });

  test('every point of it has exactly one name', () => {
    const r = rounding(15, 0.5)(drawn(L, 1));

    expect(r.ids.length).toBe(r.shape.length);
    r.shape.forEach((ring, i) => expect(r.ids[i].length).toBe(ring.length));
  });
});

// -----------------------------------------------------------------------------
// The deform
//
// The pattern's rules are PLAN-bevel's and are not restated here; what these
// ask is that they are now read off an identity. A run takes one name and its
// teeth are laid from that name's middle; a tooth is `tooth(run, j)` and stays
// tooth `j` whatever the run's ends do; and an arc takes its teeth exactly as
// a wall does, there being no such thing as an arc any more — only more ring.
// -----------------------------------------------------------------------------

const ZIGZAG: Effecting = {
  spacing: 25,
  pattern: 'zigzag',
  seed: 1,
  sides: 'both',
  jitter: 0,
  falloff: 0.15,
  offset: false,
};

const NOISE: Effecting = { ...ZIGZAG, pattern: 'noise' };

/** How far each named point stands off the outline it was laid on. */
function standing(it: Drawn, was: readonly Point[]): Map<string, number> {
  const out = new Map<string, number>();

  it.shape[0].forEach((p, i) => {
    const off = Math.min(...was.map((q, k) => {
      const w = along(q, was[(k + 1) % was.length], p);

      return Math.hypot(p.x - w.x, p.y - w.y);
    }));

    out.set(shows(it.ids[0][i]), off);
  });

  return out;
}

describe('the deform', () => {
  test('lays its teeth along a run and leaves the run\'s ends alone', () => {
    const square = rect(0, 0, 200, 200);
    const r = deforming(8, ZIGZAG)(drawn([square], 0));
    const said = r.ids[0].map(shows);

    // Four corners, and seven teeth a wall counted out from its middle.
    expect(said.filter(s => !s.includes('#'))).toEqual(['0.0', '0.1', '0.2', '0.3']);
    expect(said.filter(s => s.startsWith('0.0#'))).toEqual(
      [-3, -2, -1, 0, 1, 2, 3].map(j => `0.0#${j}`),
    );
    expect(r.shape[0].filter(p => square.some(q => q.x === p.x && q.y === p.y))).toHaveLength(4);
  });

  test('and stands each of them off the run by the amount it was given', () => {
    const r = deforming(8, ZIGZAG)(drawn([rect(0, 0, 200, 200)], 0));
    const off = standing(r, rect(0, 0, 200, 200));

    for (const [name, d] of off) {
      expect(d).toBeCloseTo(name.includes('#') ? 8 : 0, 9);
    }
  });

  test('a run is named by its anchor, so the same wall is the same pattern', () => {
    // The noise belongs to the name and to nothing else: the same name laid on
    // a wall twice as long is the same teeth, as far as the wall reaches.
    const wide = deforming(8, NOISE)(drawn([rect(0, 0, 400, 200)], 0));
    const narrow = deforming(8, NOISE)(drawn([rect(0, 0, 200, 200)], 0));
    const held = (it: Drawn) => new Map(
      it.ids[0].map((id, i) => [shows(id), it.shape[0][i]] as const).filter(([s]) => s.startsWith('0.0#')),
    );

    const a = held(wide), b = held(narrow);

    for (const [name, p] of b) {
      const q = a.get(name);

      if (q === undefined) continue;

      // The same tooth, at the same height off the wall, its middle having
      // moved with the wall.
      expect(Math.abs(p.y)).toBeCloseTo(Math.abs(q.y), 9);
    }

    expect([...b.keys()].filter(k => a.has(k)).length).toBeGreaterThan(3);
  });

  test('and a different name is a different pattern', () => {
    const one = deforming(8, NOISE)(drawn([rect(0, 0, 200, 200)], 0));
    const two = deforming(8, NOISE)(drawn([rect(0, 0, 200, 200)], 1));
    const at = (it: Drawn, k: number) => it.shape[0][k].y;

    expect([1, 2, 3].map(k => at(one, k))).not.toEqual([1, 2, 3].map(k => at(two, k)));
  });

  test('an arc takes its teeth as a wall does', () => {
    // A rounded square has no corner left on it — every one of them is an arc
    // — so there is nowhere for the rhythm to restart and it does not: one run
    // the whole way round, teeth a spacing apart across walls and arcs alike.
    //
    // This is the thing that was wrong while the resample's anchors and the
    // deform's run starts were one question. Each arc was its own run, each
    // run centred a tooth in itself, and a rounded square came back with four
    // long rhythms and a spike stuck on each corner.
    const square = drawn([rect(0, 0, 200, 200)], 0);
    const round = rounding(30, 0.5)(square);
    const r = deforming(6, ZIGZAG)(round);
    const said = r.ids[0].map(shows);
    const teeth = said.flatMap((s, i) => (s.includes('#') ? [i] : []));

    // The arc's own facets are still there, and the teeth are not them.
    expect(said.some(s => /^0\.1@0\.\d/.test(s))).toBe(true);
    expect(r.shape[0].length).toBeGreaterThan(round.shape[0].length);

    // One run: every tooth belongs to it, and no two of them to different ones.
    expect(new Set(teeth.map(i => said[i].split('#')[0])).size).toBe(1);

    // At least one of them stands on an arc rather than on a wall, which is
    // what `an arc is more of the ring` comes to.
    const onArc = (i: number) => /@0?\.\d/.test(said[(i + said.length - 1) % said.length]);

    expect(teeth.some(onArc)).toBe(true);
  });

  test('a tooth comes and goes as the room for it does, and not at a step', () => {
    // The wall grows a spacing's worth; every tooth that arrives over that
    // arrives standing on the wall, and none of them appears at a height.
    const was = (w: number) => rect(0, 0, w, 200);
    const at = (w: number) => standing(deforming(8, ZIGZAG)(drawn([was(w)], 0)), was(w));

    let before = at(180);

    for (let w = 181; w <= 220; w++) {
      const now = at(w);

      for (const [name, d] of now) {
        if (!name.startsWith('0.0#') || before.has(name)) continue;

        expect([name, d]).toEqual([name, expect.closeTo(0, 0)]);
      }

      before = now;
    }
  });

  test('teeth that cross are named of the walls that crossed', () => {
    // A tall amplitude on a narrow room: the teeth of two facing walls cut
    // each other, and the arrangement says so.
    const r = deforming(70, ZIGZAG)(drawn([rect(0, 0, 200, 60)], 0));

    expect(r.ids.flat().map(shows).some(s => s.includes('×'))).toBe(true);
  });

  test('nothing is asked of it at nought', () => {
    const it = drawn([rect(0, 0, 200, 200)], 0);

    expect(deforming(0, ZIGZAG)(it)).toBe(it);

    // Spacing is asked for a run at a time now, so nought is answered a run at
    // a time too: the ring comes back as it was rather than untouched.
    const none = deforming(8, { ...ZIGZAG, spacing: 0 })(it);

    expect(none.shape).toEqual(it.shape);
    expect(none.ids.map(g => g.map(shows))).toEqual(it.ids.map(g => g.map(shows)));
  });

  test('every point of it has exactly one name, and no two share one', () => {
    const r = deforming(8, ZIGZAG)(rounding(30, 0.5)(drawn([rect(0, 0, 200, 200)], 0)));
    const said = r.ids.flat().map(shows);

    expect(r.ids.length).toBe(r.shape.length);
    r.shape.forEach((ring, i) => expect(r.ids[i].length).toBe(ring.length));
    expect(new Set(said).size).toBe(said.length);
  });
});

// -----------------------------------------------------------------------------
// An amount per identity
//
// A polygon may carry a different depth at each corner and a different
// amplitude along each edge, and an effect takes one number. The way through
// is that the number may be written against an *identity* instead — and a
// polygon's corners have the plainest identities there are.
//
// By identity and not by index is the whole of why it survives the pipeline:
// an erosion closes a notch and the ring is two rings, a round puts arcs where
// corners were, a scope above unions the lot with somebody else's wall, and a
// depth written against corner four is still against corner four.
// -----------------------------------------------------------------------------

describe('an amount per identity', () => {
  test('an erosion takes a depth at each corner, and exactly', () => {
    const it = drawn([rect(0, 0, 200, 200)], 0);
    const r = eroding(new Map([[it.ids[0][1], 20]]))(it);
    const at = (x: number, y: number) => r.shape[0].some(p => Math.hypot(p.x - x, p.y - y) < 1e-9);

    // The corner goes to the point twenty from both of its walls, and its
    // neighbours do not move at all.
    expect(at(180, 20)).toBe(true);
    expect(at(0, 0)).toBe(true);
    expect(at(200, 200)).toBe(true);
    expect(at(200, 0)).toBe(false);
  });

  test('a deform takes an amplitude along each edge', () => {
    const it = drawn([rect(0, 0, 200, 200)], 0);
    const r = deforming(new Map([[it.ids[0][0], 8]]), ZIGZAG)(it);
    const said = r.ids[0].map(shows);

    expect(said.filter(s => s.startsWith('0.0#')).length).toBeGreaterThan(4);
    expect(said.filter(s => /^0\.[123]#/.test(s))).toEqual([]);
  });

  test('and its options too, a run at a time', () => {
    const it = drawn([rect(0, 0, 200, 200)], 0);
    const wide = { ...ZIGZAG, spacing: 100 };
    const r = deforming(8, (id => (id === it.ids[0][0] ? wide : ZIGZAG)))(it);
    const said = r.ids[0].map(shows);

    expect(said.filter(s => s.startsWith('0.0#')).length)
      .toBeLessThan(said.filter(s => s.startsWith('0.1#')).length);
  });

  test('a point the construction made asks whatever it was made of', () => {
    // The teeth of a wall are the wall's, and the arc about a corner is the
    // corner's — so a second effect written against the corner reaches them.
    const it = drawn([rect(0, 0, 200, 200)], 0);
    const toothed = deforming(8, ZIGZAG)(it);
    const only = new Map([[it.ids[0][0], 6]]);
    const r = eroding(only)(toothed);

    // Every tooth of wall nought moved; nothing of wall two did.
    const held = new Map(r.ids[0].map((id, i) => [shows(id), r.shape[0][i]] as const));
    const was = new Map(toothed.ids[0].map((id, i) => [shows(id), toothed.shape[0][i]] as const));

    for (const [name, p] of held) {
      const q = was.get(name);

      if (q === undefined || !name.startsWith('0.')) continue;

      const moved = Math.hypot(p.x - q.x, p.y - q.y) > 1e-6;

      if (name.startsWith('0.2')) expect([name, moved]).toEqual([name, false]);
    }
  });

  test('and a born point takes the larger of the two it was born of', () => {
    // Which is `round(max(a, b))` again, said of an amount: a corner where two
    // pieces crossed belongs to both, and the one that asks for more wins.
    const room: Shape = [rect(0, 0, 200, 120)];
    const bite: Shape = [rect(80, -20, 40, 60)];
    const a = drawn(room, 0), b = drawn(bite, 1);
    const cut = combineIdentified(a, b, OpSubtract);
    const born = cut.ids[0].find(id => shows(id).includes('×'))!;

    const where = cut.shape[0][cut.ids[0].indexOf(born)];

    // Written against neither parent, it gets nothing and stands still.
    const none = eroding(new Map([[a.ids[0][2], 10]]))(cut);
    const still = none.shape[0][none.ids[0].indexOf(born)];

    expect([still.x, still.y]).toEqual([where.x, where.y]);

    // Written against one of the two it was born of, it takes that one.
    const what = madeOf(born);
    const parents = what.kind === 'born' ? [what.a, what.b] : [];
    const one = eroding(new Map([[parents[0], 10]]))(cut);
    const near = one.shape[0][one.ids[0].indexOf(born)];

    expect(Math.hypot(near.x - where.x, near.y - where.y)).toBeCloseTo(10 * Math.SQRT2, 6);

    // Written against both, the larger wins — `round(max(a, b))` again, said
    // of an amount rather than of a round.
    const both = eroding(new Map([[parents[0], 10], [parents[1], 30]]))(cut);
    const far = both.shape[0][both.ids[0].indexOf(born)];

    expect(Math.hypot(far.x - where.x, far.y - where.y)).toBeCloseTo(30 * Math.SQRT2, 6);
  });
});
