// -----------------------------------------------------------------------------
// Walking into things
//
// The jam build's collision, carried over with three changes.
//
// **The normals arrive precomputed.** `PolygonPoint` carries the edge normal,
// worked out once where the world is written rather than on every level load.
// Nothing here recomputes it.
//
// **A polygon is a ring, and a version has more of them than it was authored
// with.** Erosion is a projection: a room whose walls close until they meet is
// two rooms, and a room with something taken out of it has a hole wound the
// other way. Which side of a ring is material follows from its winding and its
// type, and is the one thing this has to get right — see `sideOf`.
//
// **The rings are the union's, not the author's.** This is the one that
// mattered. Hulls built from the source rings give the player walls the union
// does not have: two rooms overlapping is the ordinary way to author a level
// here, and the seam between them stopped the player dead in the middle of open
// floor. So what arrives here is the CSG at each version — every `level`
// unioned, every pillar taken back out — and a seam is not in it, because the
// union dissolved it. That is `versionOf` in the editor's exporter, and it is
// why everything below deals only in `level` rings.
//
// Which leaves the walls a version behind the walls being drawn, since the
// drawn ones morph continuously and these snap. The transition is short and the
// lag is a wall that has visually moved slightly ahead of where it stops you —
// which is what the jam build had between its snaps too. Rebuilding the hulls
// off the morphing boundary every frame would close that gap and cost a
// per-frame CSG readback to do it; it is not worth the trade.
//
// Everything else is Quake 2's: expand each wall by the player's radius so the
// player is a point, trace the point against the convex hulls that produces,
// stop at the first, turn along it, and trace again with what is left.
//
// The expansion is a rectangle per wall and a cap per corner — `wallOf` and
// `wedgeOf` — and the hulls are in a tree rather than a list, since every one
// of those traces is a query and a level is meant to carry ten thousand
// polygons.
//
// There are two traces in here and only one of them is wired up. `traceQ2` is
// the above; `traceOld` is what the jam build did, which slid once and then cut
// the slide short at the next wall rather than turning it again. The second is
// kept so that the first can be switched away from and felt against — see
// `trace`, which is one line and names which.
// -----------------------------------------------------------------------------

import { Packed, eachPacked, pack, somePacked } from './bvh';
import { Point, Polygon, PolygonPoint, signedArea } from './world';

/** World units. The player is a point and the walls are this much closer. */
export const PLAYER_RADIUS = 0.3;

/** One convex hull: the expansion of a single wall. */
interface Hull {
  /** Counter-clockwise, so the plane normals come out pointing outward. */
  verts: Point[]
  planes: { nx: number, ny: number, d: number }[]
  /** The original wall's outward normal. Only `traceOld` reads it: telling two
   * hulls of one wall apart from a corner was how it knew what a corner was. */
  wallNx: number
  wallNy: number
}

/**
 * Which way a ring's walls are expanded.
 *
 * `withNormals` points a ring's normals away from the region it encloses in the
 * counter-clockwise sense, whichever way round it happens to be wound. Every
 * ring that gets here encloses somewhere to stand, so the walls move against
 * the normal — and a hole, wound against the room it is in, has that flipped
 * for it by the winding without anything having to know it is a hole.
 */
function sideOf(polygon: Polygon): number {
  return signedArea(polygon.points) > 0 ? -1 : 1;
}

function planesOf(verts: Point[]): { nx: number, ny: number, d: number }[] {
  const planes = [];

  for (let i = 0; i < verts.length; i++) {
    const a = verts[i], b = verts[(i + 1) % verts.length];
    const ex = b.x - a.x, ey = b.y - a.y;
    const len = Math.hypot(ex, ey);

    if (len < 1e-12) continue;

    // Counter-clockwise winding puts the outward normal at (ey, -ex).
    const nx = ey / len, ny = -ex / len;

    planes.push({ nx, ny, d: nx * a.x + ny * a.y });
  }

  return planes;
}

/**
 * A turn too small for the cap it would want to have any area.
 *
 * Not a tolerance, and there was one here that had to go. A corner that fans
 * out leaves the wedge between its two rectangles uncovered, and the tempting
 * measure of that wedge is how deep it is — `radius * (1 - cos(half the
 * turn))`, which at seven and a half degrees is six ten-thousandths of a
 * radius and sounds like nothing. It is not nothing, because the wedge is not
 * a dent in the surface: it is a crack, it runs the whole way in to the corner
 * itself, and the player is a point. Hugging a rounded pillar of forty-eight
 * sides, they are driven into one within half a turn and wedged at its apex —
 * standing, by then, on the pillar's own outline. Every fan-out corner is
 * capped, however slight, and this is only the width at which the cap stops
 * having an inside.
 */
const FLAT = 1e-9;

/**
 * The expansion of one wall: the edge, and the edge moved a radius off it.
 *
 * Along the edge's own normal, both ends alike, so the moved edge is a
 * translate of the original at exactly a radius and the rectangle is exactly
 * the part of the offset that belongs to this edge. What it does not cover is
 * the corner at either end, which is `wedgeOf`.
 */
function wallOf(
  a: PolygonPoint,
  b: PolygonPoint,
  scale: number,
  side: number,
  radius: number,
): Hull | null {
  const wa = { x: a.x * scale, y: a.y * scale };
  const wb = { x: b.x * scale, y: b.y * scale };

  if (Math.hypot(wb.x - wa.x, wb.y - wa.y) < 1e-12) return null;

  const mx = a.enx * radius * side, my = a.eny * radius * side;

  return hullOf(
    [wa, wb, { x: wb.x + mx, y: wb.y + my }, { x: wa.x + mx, y: wa.y + my }],
    a.enx,
    a.eny,
  );
}

/**
 * What is left over at a corner, where the two walls meeting there have turned
 * away from each other and their rectangles have parted.
 *
 * Nothing where they have not. A corner that turns the other way has its two
 * rectangles overlapping — the inside of a room's corner is covered twice —
 * and anything added there would be a piece of wall standing in open floor.
 *
 * Which way is which is one sign, and it needs no help from the winding. A
 * ring's normals point away from what it encloses and `side` turns them
 * towards what can be walked on, and between them they leave the expansion
 * pointing to the left of the way the ring is walked — on a room and on a hole
 * wound against one alike, which is the whole of what `sideOf` is for. So the
 * rectangles part at a right turn and overlap at a left one, and the turn is
 * the sign of the cross product. Reading `side` again here is reading it
 * twice: it capped a room's spikes and left a round pillar's corners bare,
 * which is every corner of it.
 *
 * `prev` is where the edge arriving here started, so it carries that edge's
 * normal. Its position is read only to settle the one case the turn cannot:
 * two edges exactly antiparallel, where the tip of a spur needs a half disc
 * and the sweep to it is a half turn either way. The one that is wanted goes
 * *round* the tip, which is the one whose middle points on along the edge that
 * arrived.
 *
 * What is built is the mitre, cut off where it has run a radius along either
 * of its walls. Not the arc it stands for, which would be the exact thing and
 * is the wrong thing: the arcs round the two sides of a gap narrower than the
 * player cross, and where they cross the free space comes to a cusp — a notch
 * the player can walk into and be wedged in, at a slot they should simply have
 * slid past. A mitre contains its arc and fills that, which is what the slot in
 * `coldet.test.ts` is about.
 *
 * What a mitre must not do is run away. Its apex stands `radius * tan(half the
 * sweep)` along the wall, which is a radius at a right angle and seven of them
 * at the sixteen-degree spike this was found at — and a corner reaching seven
 * radii into open floor is a wall that is not there. Two of those facing each
 * other closed a doorway fifty-nine units wide.
 *
 * A radius is where those two meet, and is not a dial. A gap the player cannot
 * fit through is narrower than two radii, so a radius from either side bridges
 * it; a gap they can is wider, so a radius from either side leaves the middle
 * of it alone. Everything sharper than a right angle is cut, and everything
 * blunter never reaches that far to begin with.
 *
 * The bound sits on the corner rather than on the bisector, which is what
 * `wallOf` is separate for: the walls either side are translates at exactly a
 * radius whatever happens here, so cutting this costs nothing crossways. That
 * was the objection to bounding the old bisector, and it is answered by the
 * corner being its own hull.
 */
function wedgeOf(
  prev: PolygonPoint,
  at: PolygonPoint,
  scale: number,
  side: number,
  radius: number,
): Hull | null {
  const m0x = prev.enx * side, m0y = prev.eny * side;
  const m1x = at.enx * side, m1y = at.eny * side;

  const cross = m0x * m1y - m0y * m1x;
  const dot = m0x * m1x + m0y * m1y;

  let sweep: number;

  if (dot < -1 + 1e-12) {
    const dx = at.x - prev.x, dy = at.y - prev.y;

    sweep = Math.PI * (-m0y * dx + m0x * dy >= 0 ? 1 : -1);
  }
  else if (cross < 0) {
    sweep = Math.atan2(cross, dot);
  }
  else {
    return null;
  }

  if (Math.abs(sweep) < FLAT) return null;

  const turn = Math.sign(sweep);

  // Out along each offset edge, as far as the apex or as far as a radius,
  // whichever comes first. Both sides reach the same distance, so the two
  // points are the apex itself while the mitre is short enough to keep, and
  // the cut across it once it is not.
  const reach = Math.min(radius * Math.tan(Math.abs(sweep) / 2), radius);

  const p = { x: at.x * scale, y: at.y * scale };
  const e0 = { x: p.x + m0x * radius, y: p.y + m0y * radius };
  const e1 = { x: p.x + m1x * radius, y: p.y + m1y * radius };

  const verts: Point[] = [
    p,
    e0,
    { x: e0.x - m0y * turn * reach, y: e0.y + m0x * turn * reach },
    { x: e1.x + m1y * turn * reach, y: e1.y - m1x * turn * reach },
    e1,
  ];

  // The wall it is named after is the one leaving the corner. A corner is not a
  // wall of its own, and `traceOld` tells a corner from two walls by exactly
  // this — see `SAME_WALL`.
  return hullOf(verts, at.enx, at.eny);
}

function hullOf(verts: Point[], wallNx: number, wallNy: number): Hull | null {
  if (signedArea(verts) < 0) verts.reverse();

  const planes = planesOf(verts);
  if (planes.length < 3) return null;

  return { verts, planes, wallNx, wallNy };
}

/** The box a hull sits in, four numbers, as `pack` wants them. */
function boxOf(hull: Hull, into: number[]): void {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const v of hull.verts) {
    if (v.x < minX) minX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.x > maxX) maxX = v.x;
    if (v.y > maxY) maxY = v.y;
  }

  into.push(minX, minY, maxX, maxY);
}

/** What a trace against one hull found: where it went in, where it would come
 * out, and the plane it went in through. */
interface Crossed {
  enter: number
  exit: number
  nx: number
  ny: number
}

const MISSED: Crossed = { enter: 1, exit: -1, nx: 0, ny: 0 };

function traced(from: Point, to: Point, hull: Hull): Crossed {
  let enter = -1, exit = 1, nx = 0, ny = 0;

  for (const plane of hull.planes) {
    const ds = plane.nx * from.x + plane.ny * from.y - plane.d;
    const de = plane.nx * to.x + plane.ny * to.y - plane.d;

    // Outside this plane the whole way is outside the hull, whatever the
    // others say.
    if (ds > 0 && de > 0) return MISSED;
    if (ds <= 0 && de <= 0) continue;

    const frac = ds / (ds - de);

    if (ds > 0) {
      if (frac > enter) {
        enter = frac;
        nx = plane.nx;
        ny = plane.ny;
      }
    }
    else if (frac < exit) {
      exit = frac;
    }
  }

  return { enter, exit, nx, ny };
}

function hit(c: Crossed): boolean {
  return c.enter < c.exit && c.enter >= 0 && c.enter <= 1;
}

/**
 * How far off the wall the trace stops, so that the next frame does not start
 * inside it.
 *
 * Off it along the wall's own normal, which is the only direction that says
 * anything. Backing up along the move instead — which is what this did — puts
 * the player `GAP * sin(the angle they met it at)` clear of the wall, and a
 * slide meets the next wall at no angle worth speaking of, so it put them a
 * millionth of that clear and sometimes nothing at all. See `traceQ2`, where
 * that turned a gently curved wall into a grind.
 */
const GAP = 1e-4;

/** `traceOld` only: two hulls whose walls point the same way are one wall,
 * not a corner. */
const SAME_WALL = 0.99;

/** `traceOld` only: hits this much of the move apart are the same instant. */
const TOGETHER = 0.01;

/** How many times one move may be turned before what is left of it is given
 * up on. Quake 2's number, for Quake 2's reason: a move that is still finding
 * new walls after four of them is in a place no amount of turning gets it out
 * of. */
const BUMPS = 4;

/** Two planes this alike are one plane, and a long wall's hulls share theirs. */
const SAME_PLANE = 0.999;

/**
 * How far into a plane a slide may read as heading before it is disbelieved.
 *
 * A slide runs exactly along the plane it was clipped against, and *exactly*
 * is not something the arithmetic can say: the dot product that ought to come
 * back as zero comes back as the last bit or two of a double, on one side of
 * it or the other depending on the angle of the wall. Read as a slide heading
 * into the very wall it is sliding along, the move was given up on — a player
 * stuck fast against one wall and walking freely along the next one.
 *
 * Scaled by the move, so it stays a statement about precision rather than a
 * distance anyone could walk. Quake 2 gets the same effect by clipping a
 * hundredth past the plane rather than onto it, which also lifts the player
 * off every wall by a hundredth of the speed they hit it at; this does not.
 */
const TOUCHING = 1e-9;

/**
 * The move turned to run along one of the planes it has met without running
 * into any of the others, or nothing when there is no such direction.
 *
 * Every plane is tried rather than the last one hit, which is the whole of why
 * a corner is not the same thing as two walls. Sliding along the wall in front
 * may drive the player into the wall beside them, and sliding along that one
 * may drive them back into the first — and then there is nowhere to go and the
 * corner is real. But most pairs are not that: a slot in a wall too narrow to
 * walk into is met as two walls and a mitre, and one of the three has a slide
 * that clears all of them. Taking the first plane's answer and stopping if it
 * failed was what caught the player on the lip of one.
 */
function along(move: Point, planes: readonly { nx: number, ny: number }[]): Point | null {
  for (const plane of planes) {
    const into = move.x * plane.nx + move.y * plane.ny;
    const slid = { x: move.x - into * plane.nx, y: move.y - into * plane.ny };
    const touching = -TOUCHING * Math.hypot(slid.x, slid.y);

    if (planes.every(other => slid.x * other.nx + slid.y * other.ny >= touching)) return slid;
  }

  return null;
}

/**
 * One version's walls, expanded and ready to be walked into.
 *
 * The rings are the union's, so there is one kind of them. A pillar was taken
 * back out where the union was worked out, and what it left behind is a hole
 * wound against the room it is in — so nothing here has to be told which was
 * which, or that a hole is a hole. `sideOf` is the whole of that.
 *
 * Every ring handed over is one of them. Floors are drawn rather than walked
 * into and travel in a list of their own, so there is nothing here to skip.
 */
export class Hulls {
  private hulls: Hull[] = [];

  /**
   * The hulls by their boxes, and the rings' own edges by theirs.
   *
   * Two, because the two questions are not the same shape. Whether a point is
   * inside a wall is a question about hulls, in world units; how many times the
   * rooms wind round it is a ray cast at the rings themselves, in the units
   * they were written in. Sharing one tree would mean scaling one of them on
   * every query to save building a tree once at load.
   *
   * Without them every query was every hull, four times over per move — fine at
   * the hundred and twenty a room or two comes to, and eighty thousand at the
   * ten thousand polygons the set is built to carry.
   */
  private tree: Packed;
  private edges: Packed;
  /** Per edge of `edges`, `ax, ay, bx, by`, in the rings' own units. */
  private ends: Float64Array;

  constructor(
    polygons: Polygon[],
    private scale: number,
    radius = PLAYER_RADIUS,
  ) {
    const boxes: number[] = [];
    const edges: number[] = [];
    const ends: number[] = [];

    for (const polygon of polygons) {
      // Repeated points have no edge and no normal, and a corner at one is
      // between the two edges either side of it rather than against nothing.
      // Taking them out here is what lets everything below read `i - 1` and
      // `i + 1` and mean it.
      const points = polygon.points.filter(p => p.enx !== 0 || p.eny !== 0);

      if (points.length < 3) continue;

      const side = sideOf({ points });
      const n = points.length;

      for (let i = 0; i < n; i++) {
        const a = points[i], b = points[(i + 1) % n];

        const wall = wallOf(a, b, this.scale, side, radius);
        const wedge = wedgeOf(points[(i - 1 + n) % n], a, this.scale, side, radius);

        for (const made of [wall, wedge]) {
          if (made === null) continue;

          this.hulls.push(made);
          boxOf(made, boxes);
        }

        edges.push(
          Math.min(a.x, b.x), Math.min(a.y, b.y),
          Math.max(a.x, b.x), Math.max(a.y, b.y),
        );
        ends.push(a.x, a.y, b.x, b.y);
      }
    }

    this.tree = pack(Float64Array.from(boxes));
    this.edges = pack(Float64Array.from(edges));
    this.ends = Float64Array.from(ends);
  }

  /** Inside a wall, which is not somewhere the player is allowed to be. */
  insideAny(at: Point): boolean {
    return somePacked(this.tree, at.x, at.y, at.x, at.y, id => {
      const hull = this.hulls[id];

      return hull.planes.every(p => p.nx * at.x + p.ny * at.y - p.d <= 0);
    });
  }

  /**
   * Somewhere to stand: not inside a wall, and inside some room.
   *
   * Two questions rather than three, because being inside a pillar is not a
   * separate one: a pillar is a hole in the union, wound against the room
   * it is in, so the nonzero rule takes it back out without anything here
   * having to know which ring is which.
   */
  standable(at: Point): boolean {
    if (this.insideAny(at)) return false;

    return this.winding(at) !== 0;
  }

  /**
   * How many times the rooms wind round the point.
   *
   * The ray runs out along positive x, so the query is the point stretched to
   * infinity that way: an edge whose box ends short of the point cannot be
   * crossed by it, and one that does not straddle the point's own `y` cannot
   * either. Every edge the tree does hand back is put through exactly the test
   * it was put through when they all were.
   */
  private winding(at: Point): number {
    const x = at.x / this.scale, y = at.y / this.scale;
    const ends = this.ends;
    let turns = 0;

    eachPacked(this.edges, x, y, Infinity, y, id => {
      const i = id * 4;
      const ax = ends[i], ay = ends[i + 1], bx = ends[i + 2], by = ends[i + 3];

      if (ay <= y) {
        if (by > y && (bx - ax) * (y - ay) - (x - ax) * (by - ay) > 0) turns++;
      }
      else if (by <= y && (bx - ax) * (y - ay) - (x - ax) * (by - ay) < 0) {
        turns--;
      }
    });

    return turns;
  }

  /**
   * Every hull a move from `at` to `to` could possibly meet.
   *
   * The move's own box, which is all the broad phase can say: a hull whose box
   * misses it cannot be crossed, and one whose box meets it usually is not
   * crossed either, which is what `traced` is for. Nothing that would have been
   * hit is missed, so the answer is the answer the whole list gave.
   */
  private near(at: Point, to: Point, fn: (hull: Hull) => void): void {
    eachPacked(
      this.tree,
      Math.min(at.x, to.x),
      Math.min(at.y, to.y),
      Math.max(at.x, to.x),
      Math.max(at.y, to.y),
      id => fn(this.hulls[id]),
    );
  }

  /** The one in force. Swap for `traceOld` to feel the difference. */
  trace = this.traceQ2;

  /**
   * A move, stopped and turned along whatever it meets — Quake 2's slide move,
   * in two dimensions.
   *
   * A move is traced, cut short at the first thing in the way, turned to run
   * along it, and then traced *again* with what is left, up to `BUMPS` times.
   * The second trace is the point: sliding along one wall is how the player
   * reaches the next one, and a slide that merely stopped at the next one made
   * every second wall a full stop. Each wall met is kept, and the turn has to
   * clear all of them at once — see `along`.
   *
   * It ends where it is when a turn runs out of directions, or when the
   * direction left points back the way the move came. That last test is the
   * one that says a corner is a corner: not that two walls were touched, but
   * that between them there is nothing forward left to do.
   */
  traceQ2(start: Point, move: Point): Point {
    const planes: { nx: number, ny: number }[] = [];

    let at = { ...start };
    let left = { ...move };

    for (let bump = 0; bump < BUMPS; bump++) {
      const length = Math.hypot(left.x, left.y);
      if (length < 1e-8) break;

      const end = { x: at.x + left.x, y: at.y + left.y };
      let first = null as Crossed | null;

      this.near(at, end, hull => {
        const crossed = traced(at, end, hull);

        if (hit(crossed) && (first === null || crossed.enter < first.enter)) first = crossed;
      });

      if (first === null) return end;

      const plane = { nx: first.nx, ny: first.ny };

      // Up to the wall and then a hair off it, along its normal. Not short of
      // it along the move: see `GAP`.
      const off = {
        x: at.x + left.x * first.enter + plane.nx * GAP,
        y: at.y + left.y * first.enter + plane.ny * GAP,
      };

      // Unless a hair is thicker than what is being stood off. A room split by
      // an erosion leaves the two halves a thousandth of a unit apart, which at
      // the game's scale is thinner than `GAP` — so the step off one side of it
      // lands on the other, and the player is through a wall. Where that
      // happens there is nothing to be gained by standing off at all, and the
      // old way of it, short along the move, is what is left.
      at = this.insideAny(off)
        ? {
          x: at.x + left.x * Math.max(0, first.enter - GAP / length),
          y: at.y + left.y * Math.max(0, first.enter - GAP / length),
        }
        : off;
      left = { x: left.x * (1 - first.enter), y: left.y * (1 - first.enter) };

      // A long wall is one hull per edge and they share a face, so the same
      // plane arrives under two names. Kept once, or the list fills with
      // copies of a wall the player is simply walking along.
      //
      // Kept once, and kept *current*. A wall that curves is one hull per
      // facet and the facets differ by a degree or less, which is the same
      // wall by this test and not the same plane to slide along: sliding along
      // the facet behind them drove the player into the facet they were on, a
      // `GAP` at a time, and four of those is as far as a move goes. Which of
      // the two is the wall they are against is not in doubt — it is the one
      // that just stopped them.
      const same = planes.findIndex(p => p.nx * plane.nx + p.ny * plane.ny > SAME_PLANE);

      if (same < 0) {
        planes.push(plane);
      }
      else {
        planes[same] = plane;
      }

      const turned = along(left, planes);

      if (turned === null) break;
      if (turned.x * move.x + turned.y * move.y <= 0) break;

      left = turned;
    }

    return at;
  }

  /**
   * The trace as it was before `traceQ2`: one slide, and then a second trace
   * that only cuts the slide short rather than turning it again.
   *
   * Kept to be switched to and felt, not because anything calls it. It is a
   * wall away from the other one in two places — a corner is two walls at once
   * here and nowhere left to go there, and a slide ends at the next wall here
   * and carries on along it there.
   *
   * Everything is traced, not just the first thing in the way: two walls
   * arriving at the same instant is a corner and stops the player dead, where
   * sliding along either one of them would walk through the other.
   */
  traceOld(start: Point, move: Point): Point {
    const length = Math.hypot(move.x, move.y);
    if (length < 1e-8) return { ...start };

    const end = { x: start.x + move.x, y: start.y + move.y };
    const hits: (Crossed & { frac: number, wall: Hull })[] = [];

    this.near(start, end, hull => {
      const crossed = traced(start, end, hull);

      if (hit(crossed)) {
        hits.push({ frac: crossed.enter, ...crossed, wall: hull });
      }
    });

    if (hits.length === 0) return end;

    hits.sort((a, b) => a.frac - b.frac);

    const first = hits[0];
    const safe = Math.max(0, first.frac - GAP / length);
    const stopped = { x: start.x + move.x * safe, y: start.y + move.y * safe };

    // Two hulls off one wall are not two walls: a long wall is one hull per
    // edge, and crossing where they meet would otherwise read as a corner.
    const walls: typeof hits = [];

    for (const h of hits) {
      if (h.frac - first.frac >= TOGETHER) break;

      const known = walls.some(w =>
        h.wall.wallNx * w.wall.wallNx + h.wall.wallNy * w.wall.wallNy > SAME_WALL);

      if (!known) walls.push(h);
    }

    if (walls.length >= 2) return stopped;

    const rest = { x: move.x * (1 - first.frac), y: move.y * (1 - first.frac) };
    const into = rest.x * first.nx + rest.y * first.ny;
    const slide = { x: rest.x - into * first.nx, y: rest.y - into * first.ny };

    const along = Math.hypot(slide.x, slide.y);
    if (along < 1e-8) return stopped;

    // The slide is traced too: sliding along one wall is how the player
    // reaches the next one.
    const to = { x: stopped.x + slide.x, y: stopped.y + slide.y };
    let frac = 1;

    this.near(stopped, to, hull => {
      const crossed = traced(stopped, to, hull);

      if (hit(crossed) && crossed.enter < frac) frac = crossed.enter;
    });

    const safely = Math.max(0, frac - GAP / along);

    return { x: stopped.x + slide.x * safely, y: stopped.y + slide.y * safely };
  }
}
