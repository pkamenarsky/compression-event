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
import { OpSubtract, Shape, erode, shapeArea, simplify } from './geometry';
import { eroding, resampled } from './effect';
import { Drawn, Ident, combineIdentified, corner, identify, on, shows } from './ids';

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
