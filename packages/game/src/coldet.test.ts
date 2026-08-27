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
 * `withNormals` has no bisector to give at the tip — the two edges are
 * antiparallel and their normals cancel — so it hands back the edge's own
 * normal, which points straight through the wall on the way back. The quad
 * that made folded over, and the triangle salvaged out of it had all three
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
