// -----------------------------------------------------------------------------
// Walking into things, held to what it promises
//
// The trace itself is the jam build's and was not changed. What was changed is
// what it is handed — rings rather than polygons, normals precomputed, and a
// hole wound against the room it is in — so that is what this is about: the
// player stops a radius short of a wall whichever side of it the material is
// on, and `standable` answers the same question the union would without ever
// building one.
// -----------------------------------------------------------------------------

import { describe, expect, test } from 'vitest';
import { Hulls, PLAYER_RADIUS } from './coldet';
import { Point, Polygon, signedArea, withNormals } from './world';

/** Counter-clockwise, which is a room: every ring that reaches here is one, or
 * a hole in one. */
function rect(x: number, y: number, w: number, h: number): Point[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

function ring(points: Point[]): Polygon {
  return { points: withNormals(points) };
}

/** The same ring the other way round: a hole, where its outer ring is a room. */
function hole(points: Point[]): Polygon {
  return ring([...points].reverse());
}

/** World units per editor unit. One, so that every number below is both. */
const SCALE = 1;

function room(...polygons: Polygon[]): Hulls {
  return new Hulls(polygons, SCALE);
}

const ROOM = ring(rect(0, 0, 100, 100));

describe('a move into a wall', () => {
  test('stops a radius short of it', () => {
    const at = room(ROOM).trace({ x: 50, y: 50 }, { x: 0, y: -100 });

    expect(at.x).toBeCloseTo(50, 6);
    expect(at.y).toBeGreaterThan(PLAYER_RADIUS - 1e-3);
    expect(at.y).toBeLessThan(PLAYER_RADIUS + 1e-2);
  });

  test('slides along it when it arrives at an angle', () => {
    const at = room(ROOM).trace({ x: 50, y: 50 }, { x: 30, y: -100 });

    expect(at.y).toBeGreaterThan(PLAYER_RADIUS - 1e-3);
    expect(at.y).toBeLessThan(PLAYER_RADIUS + 1e-2);

    // It kept most of the sideways part of the move rather than stopping dead.
    expect(at.x).toBeGreaterThan(70);
  });

  test('stops dead in a corner rather than slipping round it', () => {
    const at = room(ROOM).trace({ x: 20, y: 20 }, { x: -100, y: -100 });

    expect(at.x).toBeGreaterThan(PLAYER_RADIUS - 1e-3);
    expect(at.y).toBeGreaterThan(PLAYER_RADIUS - 1e-3);
    expect(at.x).toBeLessThan(PLAYER_RADIUS + 1e-1);
    expect(at.y).toBeLessThan(PLAYER_RADIUS + 1e-1);
  });

  test('leaves a move that reaches nothing alone', () => {
    const at = room(ROOM).trace({ x: 50, y: 50 }, { x: 5, y: 5 });

    expect(at.x).toBeCloseTo(55, 6);
    expect(at.y).toBeCloseTo(55, 6);
  });
});

describe('which side of a ring is material', () => {
  test('a room stops the player inside it', () => {
    expect(room(ROOM).insideAny({ x: 50, y: 50 })).toBe(false);
    expect(room(ROOM).insideAny({ x: 0.1, y: 50 })).toBe(true);
  });

  test('a hole in a room stops the player outside it', () => {
    const pillar = hole(rect(40, 40, 20, 20));
    const hulls = room(ROOM, pillar);

    // Walking at the pillar from the room stops a radius short of its face.
    const at = hulls.trace({ x: 20, y: 50 }, { x: 100, y: 0 });

    expect(at.x).toBeGreaterThan(40 - PLAYER_RADIUS - 1e-2);
    expect(at.x).toBeLessThan(40 - PLAYER_RADIUS + 1e-2);
  });

});

describe('somewhere to stand', () => {
  test('is inside a room and not inside its wall', () => {
    const hulls = room(ROOM);

    expect(hulls.standable({ x: 50, y: 50 })).toBe(true);
    expect(hulls.standable({ x: 150, y: 50 })).toBe(false);
    expect(hulls.standable({ x: 0.1, y: 50 })).toBe(false);
  });

  test('is not inside a hole, which nothing had to be told is a hole', () => {
    const hulls = room(ROOM, hole(rect(40, 40, 20, 20)));

    expect(hulls.standable({ x: 50, y: 50 })).toBe(false);
    expect(hulls.standable({ x: 20, y: 20 })).toBe(true);
  });

  test('two rooms overlapping is still one place to stand', () => {
    const hulls = room(ROOM, ring(rect(60, 20, 100, 60)));

    expect(hulls.standable({ x: 80, y: 50 })).toBe(true);
    expect(hulls.standable({ x: 140, y: 50 })).toBe(true);
  });
});

/**
 * A ring that runs out along a slit and comes straight back down it.
 *
 * The tip is the one corner a turn cannot place: the two edges are exactly
 * antiparallel, so the sweep round it is half a turn either way and only the
 * edge that arrived says which. Getting that wrong caps the wrong side of the
 * tip — the half disc back down the slit, which the two rectangles already
 * cover — and leaves the tip itself bare.
 *
 * Under the mitre this was worse: the corner had no bisector at all, the quad
 * built from it folded over, and the triangle salvaged out of it had all three
 * corners on one line. A hull with no area catches nothing, and the slit's
 * walls stopped stopping anyone.
 */
describe('a hairpin', () => {
  const slit = ring([
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 50, y: 100 },
    { x: 50, y: 30 },
    { x: 50, y: 100 },
    { x: 0, y: 100 },
  ]);

  test('every wall of it still has a hull with area', () => {
    const areas = hullAreas(room(slit));

    expect(areas.length).toBeGreaterThan(0);
    expect(areas.filter(a => a < 1e-9)).toEqual([]);
  });

  test('walking into the side of the slit stops', () => {
    // Straight at the slit's wall from the room beside it.
    const at = room(slit).trace({ x: 30, y: 60 }, { x: 40, y: 0 });

    expect(at.x).toBeLessThan(50 - PLAYER_RADIUS + 1e-2);
  });
});

describe('a spur that is very nearly a hairpin', () => {
  // The one above is exact — out and back along the same line — and is caught
  // by the test for two normals that cancel. This is the same spur a
  // thousandth of a unit off it, which is what an offset deep enough to split a
  // room actually leaves behind, and which reads as an ordinary corner all the
  // way down. Its mitre was a thousand units long, and the wall it belongs to
  // used to be expanded into a quad whose far corner had slid down the wall
  // rather than across it, leaving the strip beside that wall covered by
  // nothing at all.
  //
  // What that let the player do is held end to end rather than here — `export`
  // has the room it was found in, offset until it splits, walked in at the
  // game's own scale. Both halves of the invariant are what this is for.
  //
  // The proportions are the ones it was found at: a spur a couple of radii long
  // and a ten-thousandth of one wide, hanging off the end of a wall forty
  // radii long. The length of that wall is the point — under the mitre the
  // tip's bisector was what its far corner was built from, so what slid was the
  // whole of the strip beside it.
  const spur = ring([
    { x: 0, y: 0 },
    { x: 60, y: 0 },
    { x: 60, y: 40 },
    { x: 60.00005, y: 39.3 },
  ]);

  test('the wall it hangs off is a radius thick all the way along', () => {
    const hulls = room(spur);

    // Just inside the wall is not somewhere to stand, at every point of it.
    // This is the half a runaway mitre lost: the strip was covered by a quad
    // whose far corner had gone down the wall instead of across it.
    for (let y = 1; y < 39; y += 0.5) {
      expect(hulls.standable({ x: 60 - PLAYER_RADIUS / 2, y })).toBe(false);
    }
  });

  test('and nothing of it reaches out into the open floor', () => {
    const hulls = room(spur);

    // The other half, which is what the mitre could not have: a bevel is the
    // offset and not a superset of it, so a radius and a half from every wall
    // is somewhere to stand however sharp the corner behind it is.
    for (let y = 1; y < 39; y += 0.5) {
      expect(hulls.standable({ x: 60 - PLAYER_RADIUS * 1.5, y })).toBe(true);
    }
  });
});

/**
 * Two sharp spikes facing each other across a gap wide enough to walk through.
 *
 * The one that was found in a level: a room's outline running out to a tip and
 * doubling back, and the corner of a hole a little way off it, both about
 * sixteen degrees and fifty-nine units apart. A mitre at sixteen degrees
 * reaches some fifty units along its wall, so between them the two of them
 * sealed the doorway — ground twenty-nine units from any wall read as inside a
 * wall, and the level was two rooms with no way between them.
 *
 * Sixteen degrees is nowhere near a hairpin, which is why no bound on the
 * mitre was ever going to be the answer.
 *
 * The room it was found in is `scratch/world-2026-09-18T16-23-07Z.json` at
 * keyframe 4, where the doorway stands between a room's outline and the hole
 * left where a third room moved away.
 */
describe('a doorway between two spikes', () => {
  // A room with a spike reaching in from either side wall, seventeen degrees
  // apiece, their tips facing each other 59.4 apart across the way through.
  const spiked = ring([
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 40 },
    { x: 129.4, y: 50 },
    { x: 200, y: 60 },
    { x: 200, y: 100 },
    { x: 0, y: 100 },
    { x: 0, y: 60 },
    { x: 70, y: 50 },
    { x: 0, y: 40 },
  ]);

  test('the middle of it is somewhere to stand', () => {
    // 29.7 from either tip, which is ninety-nine radii of room.
    expect(room(spiked).standable({ x: 99.7, y: 50 })).toBe(true);
  });

  test('and a player walks through it', () => {
    const hulls = room(spiked);
    let at: Point = { x: 99.7, y: 5 };

    for (let i = 0; i < 400; i++) at = hulls.trace(at, { x: 0, y: 0.5 });

    expect(at.y).toBeGreaterThan(99);
  });
});

describe('a wall at an awkward angle', () => {
  /** A room turned off the axes, so that no wall's normal is a round number. */
  const diamond = ring([{ x: 50, y: 0 }, { x: 100, y: 50 }, { x: 50, y: 100 }, { x: 0, y: 50 }]);

  /**
   * A slide runs along the wall it was clipped against, which means its
   * distance from that wall is nothing but what the arithmetic rounded to. It
   * rounded the wrong way, the slide read as heading into the very wall it was
   * sliding along, and the move was abandoned — on a wall at one angle and not
   * on the same wall at another, which is the worst way to have it.
   */
  test('does not stall the slide along it', () => {
    const hulls = room(diamond);
    const step = { x: 1, y: -2 };
    let at: Point = { x: 50, y: 50 };

    // Into the wall first, and then along it for a while.
    for (let i = 0; i < 20; i++) at = hulls.trace(at, step);

    let along = 0;

    for (let i = 0; i < 25; i++) {
      const was = at;

      at = hulls.trace(at, step);

      const went = Math.hypot(at.x - was.x, at.y - was.y);

      // Every step of the slide is the same step, which is what not
      // stuttering means. The first one sets what that is.
      if (along === 0) along = went;

      expect(went).toBeCloseTo(along, 6);
      expect(went).toBeGreaterThan(0);
    }
  });
});

/**
 * A wall that curves, which is a great many short walls each turning a little.
 *
 * The turn per facet is under a degree, which `SAME_PLANE` calls the same wall
 * — rightly, since it is one, and a player walking along it should not meet a
 * corner. What that left behind was worse than a corner: the slide ran along
 * the facet *behind* the player while the facet they were on leaned into them,
 * so every bump gained the width of a `GAP` and four of those is all a move
 * gets. A step kept a quarter of itself at best, which is what walking into
 * treacle feels like.
 *
 * At the game's own scale, because that is the whole of it: `GAP` is in world
 * units and the wall is in editor ones, and how far a bump gains is one over
 * the other.
 */
describe('a wall that curves', () => {
  const RADIUS = 1200, FACET = 17, GAME = 1 / 25;
  const facets = Math.round(2 * Math.PI * RADIUS / FACET);

  const arc = ring(Array.from({ length: facets }, (_unused, i) => {
    const a = (i / facets) * 2 * Math.PI;

    return { x: Math.cos(a) * RADIUS, y: Math.sin(a) * RADIUS };
  }));

  /** Holding one direction against the wall, as a player holds a key. */
  function held(deg: number): { worst: number, total: number } {
    const hulls = new Hulls([arc], GAME);
    const step = 4 * GAME;
    const r = deg * Math.PI / 180;
    const move = { x: Math.cos(r) * step, y: Math.sin(r) * step };

    let at: Point = { x: (RADIUS - 7.6) * GAME, y: 0 };
    let worst = 1, total = 0;

    for (let i = 0; i < 40; i++) {
      const was = at;

      at = hulls.trace(at, move);

      const went = Math.hypot(at.x - was.x, at.y - was.y) / step;

      worst = Math.min(worst, went);
      total += went;
    }

    return { worst, total };
  }

  test('a step along it keeps nearly the whole of itself', () => {
    for (const deg of [80, 85, 88]) {
      expect(held(deg).worst).toBeGreaterThan(0.8);
    }
  });

  test('and forty of them go forty steps of the way', () => {
    for (const deg of [80, 85, 88]) {
      expect(held(deg).total).toBeGreaterThan(38);
    }
  });
});

describe('a slot too narrow to walk into', () => {
  /** A room with a notch cut into the middle of its top wall. */
  function notched(width: number): Polygon {
    return ring([
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 },
      { x: 50 + width / 2, y: 100 }, { x: 50 + width / 2, y: 120 },
      { x: 50 - width / 2, y: 120 }, { x: 50 - width / 2, y: 100 },
      { x: 0, y: 100 },
    ]);
  }

  /**
   * Walking one way a step at a time, the way the game does it, until the
   * player stops moving or the walk runs long.
   *
   * Running long is not a failure: a step nearly into the wall keeps only the
   * sliver of itself that runs along it, so the steepest approaches genuinely
   * crawl. What is asked is where a walk that *stopped* stopped.
   */
  function walked(hulls: Hulls, from: Point, dx: number, dy: number): { at: Point, stuck: boolean } {
    let at = from;

    for (let i = 0; i < 2000; i++) {
      const was = at;

      at = hulls.trace(at, { x: dx, y: dy });

      if (!hulls.standable(at)) return { at, stuck: true };
      if (Math.hypot(at.x - was.x, at.y - was.y) < 1e-7) return { at, stuck: true };
    }

    return { at, stuck: false };
  }

  /**
   * The lip of a slot is two walls and a mitre, met within a hair of each
   * other, and stopping because two of them arrived at once caught the player
   * on it — at some angles, which is the worst way to have it.
   *
   * Every angle, then, and every width the player cannot fit through: the
   * walk has to end at the far wall and never anywhere near the slot.
   */
  test('does not catch a player sliding past it', () => {
    const caught: string[] = [];

    for (let width = 0.1; width < 2 * PLAYER_RADIUS; width += 0.1) {
      const hulls = room(notched(width));

      for (let deg = 1; deg < 90; deg += 1) {
        const r = deg * Math.PI / 180;
        const { at, stuck } = walked(hulls, { x: 45, y: 90 }, Math.cos(r) / 6, Math.sin(r) / 6);

        // The far wall is the one thing entitled to end this walk.
        if (!stuck || at.x > 100 - PLAYER_RADIUS - 1) continue;

        caught.push(`${width.toFixed(1)} wide at ${deg}°: (${at.x.toFixed(2)}, ${at.y.toFixed(2)})`);
      }
    }

    expect(caught).toEqual([]);
  });
});

/** The area of each hull the walls came out as. Reaching inside on purpose:
 * a hull with no area is invisible to every public answer, which is what made
 * it worth a test of its own. */
function hullAreas(hulls: Hulls): number[] {
  const inside = hulls as unknown as { hulls: { verts: Point[] }[] };

  return inside.hulls.map(h => Math.abs(signedArea(h.verts)));
}

// -----------------------------------------------------------------------------
// Against the thing itself
//
// Two questions the cases above cannot ask, because both are about every point
// of a great many rings rather than about one place someone thought of.
//
// The first is what the hulls are *for*: a point is inside one exactly when it
// is within a radius of the ring, and the only reason it is a set of convex
// pieces rather than that distance is that a trace needs planes. So the
// distance is the yardstick, and what is allowed between them is what `wedgeOf`
// says it allows — nothing on the inside, and a corner's own cap on the
// outside, which is a mitre and stands up to a radius proud of the arc.
//
// The second is that the tree is a broad phase and nothing else. It is allowed
// to hand back hulls that are not hit; it is not allowed to miss one that is.
// So every answer has to be the answer the whole list gives, and that is asked
// by taking both.
// -----------------------------------------------------------------------------

/** Deterministic, so a failure is a failure again next time. */
function rolls(seed: number): () => number {
  let s = seed >>> 0;

  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;

    return s / 0x100000000;
  };
}

/**
 * A ring of `n` corners at wandering radii about a middle, which is a room with
 * spikes and bays in it at every angle a ring can have — the sharp ones
 * included, which is the point.
 */
function wobbly(next: () => number, n: number): Point[] {
  return Array.from({ length: n }, (_unused, i) => {
    const a = (i / n) * 2 * Math.PI;
    const r = 8 + next() * 22;

    return { x: 50 + Math.cos(a) * r, y: 50 + Math.sin(a) * r };
  });
}

/** Whether `p` is in the room the ring encloses, which is the only side the
 * walls are expanded towards: a point a hair outside one is not in a hull and
 * has no business being. */
function within(ring: Point[], p: Point): boolean {
  let turns = 0;

  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const side = (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);

    if (a.y <= p.y) {
      if (b.y > p.y && side > 0) turns++;
    }
    else if (b.y <= p.y && side < 0) {
      turns--;
    }
  }

  return turns !== 0;
}

/** How far `p` is from the nearest edge of `ring`. */
function away(ring: Point[], p: Point): number {
  let best = Infinity;

  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = dx * dx + dy * dy;
    const t = len < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));

    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }

  return best;
}

describe('the hulls against the distance they stand for', () => {
  test('nothing a radius clear of every wall is inside one', () => {
    const next = rolls(20260919);
    const inside: string[] = [];

    for (let r = 0; r < 40; r++) {
      const points = wobbly(next, 5 + r % 20);
      const hulls = room(ring(points));

      for (let k = 0; k < 400; k++) {
        const p = { x: next() * 100, y: next() * 100 };

        // A radius and a bit: the cap at a corner is a mitre and may stand a
        // radius proud of the arc, so a radius clear of the *wall* is not yet
        // a promise. Two is, and two is what the doorway needed.
        if (away(points, p) < 2 * PLAYER_RADIUS || !hulls.insideAny(p)) continue;


        inside.push(`ring ${r} at (${p.x.toFixed(2)}, ${p.y.toFixed(2)}): ${away(points, p).toFixed(3)} from any wall`);
      }
    }

    expect(inside).toEqual([]);
  });

  test('and nothing within one is outside them all', () => {
    const next = rolls(19260920);
    const out: string[] = [];

    for (let r = 0; r < 40; r++) {
      const points = wobbly(next, 5 + r % 20);
      const hulls = room(ring(points));

      for (let k = 0; k < 400; k++) {
        const p = { x: next() * 100, y: next() * 100 };

        if (!within(points, p) || away(points, p) > PLAYER_RADIUS) continue;
        if (hulls.insideAny(p)) continue;

        out.push(`ring ${r} at (${p.x.toFixed(2)}, ${p.y.toFixed(2)}): ${away(points, p).toFixed(3)} from a wall`);
      }
    }

    expect(out).toEqual([]);
  });

  /**
   * The same, on the other kind of ring, and it is not the same question.
   *
   * A hole is wound against the room it is in, so every corner of it turns the
   * way a room's corners do not: the ones that part are the ones that overlap
   * on a room. Reading the winding twice — once in the normals and once again
   * to decide which corners have parted — caps a room correctly and leaves
   * every corner of a pillar bare, and only a hole can say so.
   */
  test('and the same of a hole, whose corners are the other way round', () => {
    const next = rolls(18260921);
    const out: string[] = [];
    const walls = rect(-60, -60, 220, 220);

    for (let r = 0; r < 40; r++) {
      const points = wobbly(next, 5 + r % 20);
      const hulls = room(ring(walls), hole(points));

      for (let k = 0; k < 400; k++) {
        const p = { x: next() * 100, y: next() * 100 };

        // Outside the pillar, which is the side that can be walked on.
        if (within(points, p) || away(points, p) > PLAYER_RADIUS) continue;
        if (hulls.insideAny(p)) continue;

        out.push(`pillar ${r} at (${p.x.toFixed(2)}, ${p.y.toFixed(2)}): ${away(points, p).toFixed(3)} from it`);
      }
    }

    expect(out).toEqual([]);
  });
});

describe('the tree against the whole list', () => {
  /** The same `Hulls`, asked to look at everything. */
  function scanned(hulls: Hulls): Hulls {
    const inside = hulls as unknown as { tree: unknown, edges: unknown };
    const all = { nodes: new Float64Array(0), skip: new Int32Array(0), start: new Int32Array(0), count: new Int32Array(0), ids: new Int32Array(0), boxes: new Float64Array(0) };

    return Object.assign(Object.create(Object.getPrototypeOf(hulls)), hulls, {
      tree: everything(inside.tree, all),
      edges: everything(inside.edges, all),
    });
  }

  /** One leaf over every item, which is a tree that skips nothing. */
  function everything(tree: unknown, empty: object): unknown {
    const t = tree as { boxes: Float64Array, ids: Int32Array };
    const n = t.ids.length;

    if (n === 0) return tree;

    return {
      ...empty,
      nodes: new Float64Array([-Infinity, -Infinity, Infinity, Infinity]),
      skip: new Int32Array([1]),
      start: new Int32Array([0]),
      count: new Int32Array([n]),
      ids: t.ids,
      boxes: new Float64Array(n * 4).map((_unused, i) => (i % 4 < 2 ? -Infinity : Infinity)),
    };
  }

  test('answers what a full scan answers, point for point and move for move', () => {
    const next = rolls(20260921);
    const differed: string[] = [];

    for (let r = 0; r < 30; r++) {
      const points = wobbly(next, 5 + r % 20);
      const hulls = room(ring(points));
      const all = scanned(hulls);

      for (let k = 0; k < 200; k++) {
        const at = { x: next() * 100, y: next() * 100 };
        const move = { x: (next() - 0.5) * 30, y: (next() - 0.5) * 30 };

        if (hulls.standable(at) !== all.standable(at)) {
          differed.push(`ring ${r}: standable at (${at.x.toFixed(2)}, ${at.y.toFixed(2)})`);
        }

        const one = hulls.trace(at, move), two = all.trace(at, move);

        if (one.x !== two.x || one.y !== two.y) {
          differed.push(`ring ${r}: trace from (${at.x.toFixed(2)}, ${at.y.toFixed(2)})`);
        }
      }
    }

    expect(differed).toEqual([]);
  });
});
