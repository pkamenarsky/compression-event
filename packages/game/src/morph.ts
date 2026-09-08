// -----------------------------------------------------------------------------
// The walls, positioned by the GPU
//
// A span holds every stretch of every polygon, and only some of them are alive
// at any instant. That could be a per-frame upload, or a per-track draw call, or
// this: one static buffer holding all of it, and a vertex shader that collapses
// everything outside its own stretch's `t` range to a degenerate triangle. Time
// is then a uniform, the whole span is one draw call, and nothing is written
// after load.
//
// What the shader evaluates is `outline` from `baked.ts`, transcribed. That
// function exists to be the readable statement of it, and `export.test.ts` ties
// it back to the CSG, so the shader has something exact to be wrong against
// rather than a picture someone remembers.
//
// The tables go up as float textures rather than uniforms because a level has
// thousands of entries and uniform space is counted in hundreds. Four texels per
// frame, two per entry, `texelFetch` throughout — no filtering, no mipmaps, and
// no normalised coordinates to get half a texel wrong.
//
// The floors are the same, now
// ----------------------------
// They were the one thing left being written per frame: which diagonals cut a
// ring into triangles is a question about where its points are, and they move.
// `cutting` answers it in advance instead — every triangulation the span ever
// needs, in the same buffer, each gated by the window it is right over, which
// is the gate the stretches already had. Nothing in a span is written after
// load, and `seek` is three numbers.
//
// The same walls as the still source
// ----------------------------------
// The topology and the shading are `walls.ts`, called from here and from
// `still.ts` alike, because the editor crosses between the two every time a
// transition starts or ends and anything that differs across that crossing is a
// flicker. What is left here is the one thing that genuinely differs: where a
// vertex is.
// -----------------------------------------------------------------------------

import * as THREE from 'three';
import { BakedSpan, CROSSING, placedAt } from './baked';
import {
  NEARCLIP,
  Source,
  Span,
  WallOptions,
  extrude,
  fan,
  looped,
  materials,
  nesting,
} from './walls';
import { Point, TOLERANCE } from './world';

/** Texels across in both tables. Wide enough that a big level is a few rows,
 * narrow enough to be legal everywhere. */
const WIDTH = 512;

/**
 * Everything both of a span's vertex shaders are built on: the tables, the walk
 * up the chain of frames, and where one point of the bake stands at an instant.
 *
 * Built per span rather than once, because how deep the chain of groups goes is
 * a fact about the level and the walk up it is per vertex. A bounded loop is
 * unrolled and its register cost is known; `while (slot >= 0)` would be legal
 * and would leave that to the driver.
 */
const tablesFor = (depth: number): string => /* glsl */ `
  uniform sampler2D uFrames;
  uniform sampler2D uEntries;
  uniform float uTime;
  uniform float uScale;
  uniform float uWallHeight;

  varying vec3 vWorldPosition;
  varying float vHeightFrac;
  varying float vOpacity;

  const int WIDTH = ${WIDTH};

  vec4 fetch(sampler2D tex, int texel) {
    return texelFetch(tex, ivec2(texel % WIDTH, texel / WIDTH), 0);
  }

  const int DEPTH = ${depth};

  /**
   * One slot's own frame: the version in flight eased from identity to itself,
   * composed onto the chain it already stood in.
   *
   * Column-major, so that \`m * vec3(p, 1.0)\` is the point placed.
   */
  mat3 linkAt(int slot, float t) {
    int o = slot * 6;
    vec4 f0 = fetch(uFrames, o);
    vec4 f1 = fetch(uFrames, o + 1);
    vec4 f2 = fetch(uFrames, o + 2);
    vec4 f3 = fetch(uFrames, o + 3);
    vec4 f4 = fetch(uFrames, o + 4);
    vec4 f5 = fetch(uFrames, o + 5);

    float rot = f2.x * t;
    float sx = mix(1.0, f2.y, t);
    float sy = mix(1.0, f2.z, t);

    float co = cos(rot), si = sin(rot);
    float a = co * sx, b = si * sx, c = -si * sy, d = co * sy;

    // A turn goes round the layer's own fixed point; a layer that has none
    // takes its translation in a straight line, which for a translation is
    // exactly right anyway. Both ends agree either way.
    bool held = f2.w != 0.0 && t != 0.0 && t != 1.0;
    vec2 p = f3.xy;
    vec2 tr = held
      ? p - vec2(a * p.x + c * p.y, b * p.x + d * p.y)
      : f1.zw * t;

    // The chain it stood in, part way to where it stands at the far end. The
    // two are the same matrix for everything that inherits its base, which is
    // everything but a thing unchained at the far version.
    vec2 ba = mix(f0.xy, f4.xy, t);
    vec2 bc = mix(f0.zw, f4.zw, t);
    vec2 bt = mix(f1.xy, f5.xy, t);

    return mat3(
      vec3(a * ba.x + c * ba.y, b * ba.x + d * ba.y, 0.0),
      vec3(a * bc.x + c * bc.y, b * bc.x + d * bc.y, 0.0),
      vec3(a * bt.x + c * bt.y + tr.x, b * bt.x + d * bt.y + tr.y, 1.0)
    );
  }

  /**
   * The frame a vertex actually rides: its own, and every group holding it,
   * each eased on its own terms and multiplied.
   *
   * Not one composed matrix handed over ready-made. Composing two layers gives
   * a general matrix, and a general matrix lerped entrywise slews through a
   * shear — a group turning round a polygon that is turning would collapse
   * through its own middle on the way. So the chain stays a chain, exactly as
   * \`resolveAt\` walks it one stage at a time.
   */
  mat3 frameAt(int slot, float t) {
    mat3 m = linkAt(slot, t);

    for (int i = 1; i < DEPTH; i++) {
      slot = int(fetch(uFrames, slot * 6 + 3).z);

      if (slot < 0) break;

      m = linkAt(slot, t) * m;
    }

    return m;
  }

  vec2 entryAt(int e, float t, float u) {
    vec4 e0 = fetch(uEntries, e * 2);
    vec4 e1 = fetch(uEntries, e * 2 + 1);

    return (frameAt(int(e1.x), t) * vec3(mix(e0.xy, e0.zw, u), 1.0)).xy;
  }

  /** How far through its own stretch a point is at \`t\`. The stretch belongs
   * to the track rather than to the span, so it rides on the vertex. */
  float withinAt(vec2 range, float t) {
    return range.y == range.x
      ? 0.0
      : clamp((t - range.x) / (range.y - range.x), 0.0, 1.0);
  }

  /**
   * Where one point of the bake stands at \`t\`, in editor units.
   *
   * A crossing is solved from the four entries it is the meeting of, and
   * anything else — a corner of its own polygon, or a crossing that comes out
   * parallel — rides its polygon's frame. \`placedAt\` in \`baked.ts\` is this
   * on the CPU, and is what the cut is taken with.
   */
  vec2 pointAt(vec4 pts, vec4 meets, vec2 meta, float t, float u) {
    if (meta.y > 0.5) {
      vec2 p = entryAt(int(meets.x), t, u);
      vec2 q = entryAt(int(meets.y), t, u);
      vec2 r = entryAt(int(meets.z), t, u);
      vec2 w = entryAt(int(meets.w), t, u);

      vec2 du = q - p, dv = w - r;
      float det = du.x * dv.y - du.y * dv.x;

      // Parallel only at the instant an event is arriving. Give up rather than
      // divide by nothing; the corner path below is what a point the bake could
      // not place does too.
      if (det != 0.0) {
        return p + du * (((r.x - p.x) * dv.y - (r.y - p.y) * dv.x) / det);
      }
    }

    return (frameAt(int(meta.x), t) * vec3(mix(pts.xy, pts.zw, u), 1.0)).xy;
  }

  /**
   * Whether a vertex is alive at \`t\`, given the window it claims.
   *
   * Half-open, and both halves matter. A stretch holds its start and not its
   * end, so the instant two of them share belongs to the later one and to
   * nothing else; the gaps a converged event used to leave are closed in the
   * bake — see \`abutting\` — so there is no instant without an owner either.
   * The ends abut exactly, and without this rule both sides claim the instant
   * they share and a frame landing on one draws the topology from either side
   * of the event at once.
   *
   * A frame lands on one far more often than it looks. The bake cuts by
   * halving, so its boundaries are dyadic, and a clock at a steady rate lands
   * on dyadic instants all the time — an ease-out cubes them and they are
   * dyadic still, pulled in where the cuts are densest. One frame of a doubled
   * wall, which is exactly how a stray vertical reads.
   *
   * The last window keeps its end: nothing follows it to take \`t\` on.
   */
  bool aliveAt(vec2 window, float t) {
    return t >= window.x && (t < window.y || window.y >= 1.0);
  }

  /** Somewhere no triangle of it can land, for a vertex with nothing to draw. */
  const vec4 NOWHERE = vec4(2.0, 2.0, 2.0, 1.0);
`

/**
 * The walls and the lines: one point, its own stretch, and a height that is a
 * flag rather than a coordinate.
 */
const shaderFor = (depth: number): string => /* glsl */ `
  ${tablesFor(depth)}

  attribute vec2 aPointA;
  attribute vec2 aPointB;
  attribute float aSlot;
  attribute float aKind;
  attribute vec4 aCross;
  attribute vec2 aRange;
  attribute float aHeight;
  /** How solid this point is at each end of the stretch, and whether the line
   * standing on it is the vertical that can be wrong about it. */
  attribute vec3 aFade;

  void main() {
    float t = uTime;

    // Everything outside its own stretch collapses. One buffer, one draw, and
    // the frame's worth of it that is alive is chosen here.
    if (!aliveAt(aRange, t)) {
      gl_Position = NOWHERE;
      return;
    }

    float u = withinAt(aRange, t);

    // The horizontals along a wall are drawn whatever their ends turn out to
    // be; only the vertical claims there is a corner here.
    vOpacity = aFade.z > 0.5 ? mix(aFade.x, aFade.y, u) : 1.0;

    vec2 at = pointAt(vec4(aPointA, aPointB), aCross, vec2(aSlot, aKind), t, u);

    vWorldPosition = vec3(at.x * uScale, aHeight * uWallHeight, at.y * uScale);
    vHeightFrac = aHeight;

    gl_Position = projectionMatrix * viewMatrix * vec4(vWorldPosition, 1.0);
  }
`;

/**
 * The floors: a triangle at a time, each corner carrying the other two.
 *
 * Three corners rather than one because of the near plane — see `NEARCLIP` in
 * `walls.ts`, which is the whole reason the fill is unindexed and cut in
 * advance. The other two are solved only when this one turns out to be behind
 * the camera, which is a handful of vertices on the frames it happens at all
 * and none on any other.
 *
 * The window a corner claims is the cut's, not the point's. They are the same
 * thing for a floor that stands through the whole span and are not when a
 * triangulation had to be split part way — see `cutting`. Each corner keeps its
 * own stretch alongside, because how far through *it* is is what places it.
 */
const fillShaderFor = (depth: number): string => /* glsl */ `
  ${tablesFor(depth)}

  ${NEARCLIP}

  /** This corner: the two ends of its stretch, the entries it crosses, and
   * \`(slot, kind, t0, t1)\`. */
  attribute vec4 aOwnPoints;
  attribute vec4 aOwnCross;
  attribute vec4 aOwnMeta;

  /** The triangle's other two corners, the same three ways over. */
  attribute vec4 aSidePointsA;
  attribute vec4 aSideCrossA;
  attribute vec4 aSideMetaA;
  attribute vec4 aSidePointsB;
  attribute vec4 aSideCrossB;
  attribute vec4 aSideMetaB;

  /** What the whole triangle is alive for, which is the cut it belongs to. */
  attribute vec2 aWindow;

  /** One corner of the triangle, in world units and on the ground plane. */
  vec3 cornerAt(vec4 pts, vec4 meets, vec4 meta, float t) {
    vec2 at = pointAt(pts, meets, meta.xy, t, withinAt(meta.zw, t));

    return vec3(at.x * uScale, 0.0, at.y * uScale);
  }

  void main() {
    float t = uTime;

    if (!aliveAt(aWindow, t)) {
      gl_Position = NOWHERE;
      return;
    }

    // The fill is flat and unlit: nothing shades it, and nothing about it is
    // ever part way into existence.
    vHeightFrac = 0.0;
    vOpacity = 1.0;

    vec3 own = cornerAt(aOwnPoints, aOwnCross, aOwnMeta, t);

    // The other two are solved only when this corner is behind the eye, which
    // is the only case in which it can move at all — a handful of vertices on
    // the frames it happens on, and none on any other.
    if (behindNear(own, viewMatrix, projectionMatrix)) {
      own = nearClipped(
        own,
        cornerAt(aSidePointsA, aSideCrossA, aSideMetaA, t),
        cornerAt(aSidePointsB, aSideCrossB, aSideMetaB, t),
        viewMatrix,
        projectionMatrix
      );
    }

    vWorldPosition = own;

    gl_Position = projectionMatrix * viewMatrix * vec4(own, 1.0);
  }
`;

/** What both materials are told about the world, and what changes per frame. */
export interface MorphUniforms extends Record<string, { value: unknown }> {
  uFrames: { value: THREE.DataTexture }
  uEntries: { value: THREE.DataTexture }
  uTime: { value: number }
  uScale: { value: number }
  uWallHeight: { value: number }
}

/** A span, ready to draw: the meshes and the one number that moves. */
export interface Morph extends Source {
  /** Where in the span, 0 at the earlier version and 1 at the later one. */
  seek(t: number): void
}

/**
 * A table as a float texture: four floats per texel, `WIDTH` texels a row, and
 * whatever height that comes to.
 *
 * Nearest everywhere and no mipmaps, because nothing is sampled — every read is
 * a `texelFetch` at an integer the buffer layout put there.
 */
function tabled(data: Float32Array): THREE.DataTexture {
  const texels = Math.max(1, Math.ceil(data.length / 4));
  const height = Math.max(1, Math.ceil(texels / WIDTH));
  const padded = new Float32Array(WIDTH * height * 4);

  padded.set(data);

  const tex = new THREE.DataTexture(padded, WIDTH, height, THREE.RGBAFormat, THREE.FloatType);

  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;

  return tex;
}

/**
 * Every stretch of every wall track, one after another: a span is one buffer
 * and one draw of each kind, and which of it is alive at an instant is the
 * shader's business.
 *
 * The floors are not in here. What is built on them is not answered once — see
 * `fills` — so they are gathered as the vertices that cut needs instead.
 */
function walling(span: BakedSpan): Span[] {
  const out: Span[] = [];

  for (const track of span.tracks) {
    if (track.fill) continue;

    for (const s of track.stretches) out.push(...s.runs);
  }

  return out;
}

/**
 * The floor vertices, and which run each belongs to.
 *
 * A vertex per point of every fill run, in run order, and the runs as lists of
 * indices into those vertices — renumbered from zero, so what the cut hands
 * back indexes the fill's own buffer rather than the span's points. `points`
 * maps back the other way, which is what reads the span.
 *
 * Its own function because what the runs are cut into is answered separately
 * from what they are — see `cutting` — and because a test that stitched its own
 * would be checking something other than what is drawn.
 */
export function fills(span: BakedSpan): { points: number[], runs: number[][] } {
  const points: number[] = [];
  const runs: number[][] = [];

  for (const track of span.tracks) {
    if (!track.fill) continue;

    for (const s of track.stretches) {
      for (const run of s.runs) {
        const ring: number[] = [];

        for (let i = 0; i < run.count; i++) {
          ring.push(points.length);
          points.push(run.first + i);
        }

        runs.push(ring);
      }
    }
  }

  return { points, runs };
}

// -----------------------------------------------------------------------------
// Cutting the floors, once
//
// A wall is the quad between two consecutive points and stays that quad however
// they move, so `extrude` is answered once and the shader does the rest. Which
// diagonals cut a ring into triangles is not like that: it is a question about
// where the points *are*, and they move. So the fill used to be recut every
// frame — the one thing in a span that was.
//
// It does not have to be. What a recut answers is only ever one of a handful of
// answers, each right over a stretch of the walk, so the answers can be found
// in advance and every one of them put in the buffer at once, each gated by the
// window it is right over. Which is exactly what the walls already do with
// their stretches, and the shader already had the gate for it.
//
// How long a cut lasts
// --------------------
// Two things end one. The first is a stretch boundary: which runs are alive
// changes there, so the ring the cut fills is a different ring. Those instants
// are known — they are on the vertices — and they are the intervals this starts
// from.
//
// The second is the geometry, and it is not known. Inside one interval the ring
// is stitched out of runs off several polygons, each riding a frame of its own,
// with crossings solved between them: the points move, and they do not move
// affinely together. A diagonal that lay inside the ring at one instant can lie
// outside it at another, and then the cut spills over the edge and leaves a
// bite out of the middle.
//
// So this measures, the way the bake does. Take the interval, cut it in the
// middle, and check that cut across the interval; if it does not hold, split
// and ask again. What "holds" means is the exact thing that makes a
// triangulation a fill: no triangle turns inside out. A set of triangles whose
// boundary edges cancel to the ring covers the ring exactly once as long as
// they all keep the same orientation, and covers it wrongly the instant one of
// them flips — the flipped one is drawn outside the shape and the ground it
// used to cover is drawn by nobody. The stitching is checked with it, because a
// cut whose ring has been restitched is filling something else entirely.
//
// A floor that is only translated and turned needs one cut for the whole span,
// which is the common case and costs one triangulation. A reflex corner
// swinging across its neighbours costs a few.
// -----------------------------------------------------------------------------

/**
 * How thin an interval has to get before the split gives up and keeps the best
 * cut it has.
 *
 * Six halvings, which is a cap on what a span's floors can cost as much as it
 * is a floor of precision: every split doubles the buffer, and an interval the
 * check will not pass however finely it is cut — endpoints wobbling in and out
 * of the stitch tolerance either side of a converged event would do it — would
 * otherwise take a floor's ring a thousand times over. The bake gives up on
 * width the same way, for the same reason. See `GAP`.
 */
const THINNEST = 1 / 64;

/** How many instants inside an interval a cut is checked at. The failure it is
 * looking for is a triangle's area passing through zero, which is smooth in
 * `t`: a handful of samples finds it, and the split that follows looks again. */
const SAMPLES = 8;

/** A triangulation, and the window over which it is the right one. */
export interface Cut {
  t0: number
  t1: number
  /** Corner after corner, three to a triangle, indexing the fill's own points
   * — which is what `fills` hands back. */
  tri: number[]
}

/** Twice the signed area of a triangle. Sign is all this is read for. */
function turn(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
}

/**
 * Every instant at which the set of floor runs alive can change, in order.
 *
 * The ends of the span included: a cut has to be right from 0 to 1, and a floor
 * standing through the whole of it has no boundary of its own to offer.
 */
function boundaries(
  mine: readonly number[],
  where: readonly number[][],
  range: Float32Array,
): number[] {
  const edge = new Set<number>([0, 1]);

  for (const run of where) {
    const p = mine[run[0]];

    if (range[p * 2] > 0 && range[p * 2] < 1) edge.add(range[p * 2]);
    if (range[p * 2 + 1] > 0 && range[p * 2 + 1] < 1) edge.add(range[p * 2 + 1]);
  }

  return [...edge].sort((a, b) => a - b);
}

/**
 * The floors of a span cut into triangles, once, as a list of windows.
 *
 * Every cut in the list is right over its own window and the windows cover the
 * span, so the shader picks one by the same half-open rule it picks a stretch
 * by. See the header above.
 */
export function cutting(
  span: BakedSpan,
  mine: readonly number[],
  where: readonly number[][],
  range: Float32Array,
): Cut[] {
  if (where.length === 0) return [];

  /** Where every one of the fill's points stands at `t`, in world units — the
   * same arithmetic the shader does, on the CPU. See `placedAt`. */
  const solve = (t: number): Point[] => mine.map(p => {
    const a = range[p * 2], b = range[p * 2 + 1];
    const u = b === a ? 0 : Math.min(Math.max((t - a) / (b - a), 0), 1);

    return placedAt(span, p, t, u);
  });

  /** The same gate the shader draws by, asked of a whole run: a stretch holds
   * its start and not its end, and the last one keeps both. */
  const alive = (run: readonly number[], t: number): boolean => {
    const a = range[mine[run[0]] * 2], b = range[mine[run[0]] * 2 + 1];

    return t >= a && (t < b || b >= 1);
  };

  /** The rings a floor set has at `t`: one polygon's share of the boundary at
   * a time, stitched back into the loops it was cut out of. */
  const stitch = (at: Point[], t: number): number[][] =>
    looped(where.filter(run => alive(run, t)), i => at[i], TOLERANCE);

  const triangulate = (rings: number[][], at: Point[]): number[] => {
    const contours = nesting(rings.map(ring => ring.map(i => at[i]))).map(n => ({
      outer: rings[n.outer],
      holes: n.holes.map(h => rings[h]),
    }));

    return [...fan(contours, i => at[i])];
  };

  /** Whether a cut is still a fill at `t`: the same rings under it, and not one
   * triangle turned inside out. */
  const holds = (tri: number[], rings: number[][], t: number): boolean => {
    const at = solve(t);
    const now = stitch(at, t);

    if (now.length !== rings.length) return false;

    for (let i = 0; i < now.length; i++) {
      if (now[i].length !== rings[i].length) return false;
      for (let j = 0; j < now[i].length; j++) if (now[i][j] !== rings[i][j]) return false;
    }

    let sign = 0;

    for (let i = 0; i + 2 < tri.length; i += 3) {
      // A triangle with no area covers nothing and cannot be wrong about which
      // side it is on. Two with area disagreeing is one of them inside out.
      const s = Math.sign(turn(at[tri[i]], at[tri[i + 1]], at[tri[i + 2]]));

      if (s === 0) continue;
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }

    return true;
  };

  const out: Cut[] = [];

  const take = (t0: number, t1: number): void => {
    const mid = (t0 + t1) / 2;
    const at = solve(mid);
    const rings = stitch(at, mid);
    const tri = triangulate(rings, at);

    // The interval's own start, where the runs alive were decided, and a spread
    // of instants inside it. Never the far end: at it the next window's runs
    // are the live ones and this cut is not what is drawn.
    const when = [t0, t1 - (t1 - t0) * 1e-6];

    for (let k = 1; k < SAMPLES; k++) when.push(t0 + (t1 - t0) * (k / SAMPLES));

    if (t1 - t0 <= THINNEST || when.every(t => holds(tri, rings, t))) {
      out.push({ t0, t1, tri });
      return;
    }

    take(t0, mid);
    take(mid, t1);
  };

  const bound = boundaries(mine, where, range);

  for (let i = 0; i + 1 < bound.length; i++) take(bound[i], bound[i + 1]);

  return out;
}

/** The stretch each point belongs to, so a vertex can be told whether it is
 * alive at the instant being drawn. */
export function ranges(span: BakedSpan): Float32Array {
  const out = new Float32Array(span.slots.length * 2);

  for (const track of span.tracks) {
    for (const s of track.stretches) {
      for (const run of s.runs) {
        for (let i = run.first; i < run.first + run.count; i++) {
          out[i * 2] = s.t0;
          out[i * 2 + 1] = s.t1;
        }
      }
    }
  }

  return out;
}

/**
 * The fill's buffer: every cut of every floor, a triangle at a time.
 *
 * Unindexed, which is the one thing that looks like waste here and is the whole
 * point. A vertex has to carry the *other two corners of its triangle* — see
 * `NEARCLIP` in `walls.ts` — and a point shared by two triangles is a corner of
 * two different ones, so there is nothing for an index buffer to share. Three
 * vertices a triangle, each holding its triangle.
 *
 * Six vec4s of that is the two others, and they are only ever read on a vertex
 * that turns out to be behind the eye.
 */
function filling(
  span: BakedSpan,
  mine: readonly number[],
  cuts: readonly Cut[],
  range: Float32Array,
): THREE.BufferGeometry {
  let n = 0;

  for (const cut of cuts) n += cut.tri.length;

  const window = new Float32Array(n * 2);
  const points = [new Float32Array(n * 4), new Float32Array(n * 4), new Float32Array(n * 4)];
  const crossings = [new Float32Array(n * 4), new Float32Array(n * 4), new Float32Array(n * 4)];
  const meta = [new Float32Array(n * 4), new Float32Array(n * 4), new Float32Array(n * 4)];

  /** One corner written into one of the three slots a vertex has: where it is
   * at each end of its own stretch, what it crosses, and which stretch. */
  const corner = (slot: number, v: number, i: number): void => {
    const p = mine[i];

    points[slot][v * 4] = span.pointsA[p * 2];
    points[slot][v * 4 + 1] = span.pointsA[p * 2 + 1];
    points[slot][v * 4 + 2] = span.pointsB[p * 2];
    points[slot][v * 4 + 3] = span.pointsB[p * 2 + 1];

    for (let j = 0; j < 4; j++) crossings[slot][v * 4 + j] = span.crossings[p * 4 + j];

    meta[slot][v * 4] = span.slots[p];
    meta[slot][v * 4 + 1] = span.kinds[p] === CROSSING ? 1 : 0;
    meta[slot][v * 4 + 2] = range[p * 2];
    meta[slot][v * 4 + 3] = range[p * 2 + 1];
  };

  let v = 0;

  for (const cut of cuts) {
    for (let i = 0; i + 2 < cut.tri.length; i += 3) {
      // Each corner in turn as the vertex's own, the other two after it in the
      // order they came round the triangle.
      for (let k = 0; k < 3; k++) {
        window[v * 2] = cut.t0;
        window[v * 2 + 1] = cut.t1;

        corner(0, v, cut.tri[i + k]);
        corner(1, v, cut.tri[i + (k + 1) % 3]);
        corner(2, v, cut.tri[i + (k + 2) % 3]);

        v++;
      }
    }
  }

  const g = new THREE.BufferGeometry();

  // Positions come out of the shader, so there is nothing to put in
  // `position`. Something has to be, or three has no vertex count to draw.
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('aWindow', new THREE.BufferAttribute(window, 2));
  g.setAttribute('aOwnPoints', new THREE.BufferAttribute(points[0], 4));
  g.setAttribute('aOwnCross', new THREE.BufferAttribute(crossings[0], 4));
  g.setAttribute('aOwnMeta', new THREE.BufferAttribute(meta[0], 4));
  g.setAttribute('aSidePointsA', new THREE.BufferAttribute(points[1], 4));
  g.setAttribute('aSideCrossA', new THREE.BufferAttribute(crossings[1], 4));
  g.setAttribute('aSideMetaA', new THREE.BufferAttribute(meta[1], 4));
  g.setAttribute('aSidePointsB', new THREE.BufferAttribute(points[2], 4));
  g.setAttribute('aSideCrossB', new THREE.BufferAttribute(crossings[2], 4));
  g.setAttribute('aSideMetaB', new THREE.BufferAttribute(meta[2], 4));

  return g;
}

/** One span's meshes, sharing one set of uniforms so that seeking is one
 * write. */
export function morph(span: BakedSpan, options: WallOptions): Morph {
  const uniforms: MorphUniforms = {
    uFrames: { value: tabled(span.frames) },
    uEntries: { value: tabled(span.entries) },
    uTime: { value: 0 },
    uScale: { value: options.scale },
    uWallHeight: { value: options.wallHeight },
  };

  const { wall, line, fill } = materials(
    shaderFor(span.depth),
    options,
    uniforms,
    fillShaderFor(span.depth),
  );

  const shape = extrude(walling(span));
  const range = ranges(span);

  const geometry = (
    point: Int32Array,
    height: Float32Array,
    vertical: Float32Array | null,
    index: Uint32Array | null,
  ): THREE.BufferGeometry => {
    const g = new THREE.BufferGeometry();
    const n = point.length;

    const a = new Float32Array(n * 2), b = new Float32Array(n * 2);
    const slot = new Float32Array(n), kind = new Float32Array(n);
    const cross = new Float32Array(n * 4), within = new Float32Array(n * 2);
    const fade = new Float32Array(n * 3);

    for (let i = 0; i < n; i++) {
      const p = point[i];

      a[i * 2] = span.pointsA[p * 2];
      a[i * 2 + 1] = span.pointsA[p * 2 + 1];
      b[i * 2] = span.pointsB[p * 2];
      b[i * 2 + 1] = span.pointsB[p * 2 + 1];
      slot[i] = span.slots[p];
      kind[i] = span.kinds[p] === CROSSING ? 1 : 0;

      for (let j = 0; j < 4; j++) cross[i * 4 + j] = span.crossings[p * 4 + j];

      within[i * 2] = range[p * 2];
      within[i * 2 + 1] = range[p * 2 + 1];

      fade[i * 3] = span.opacityA[p];
      fade[i * 3 + 1] = span.opacityB[p];
      fade[i * 3 + 2] = vertical === null ? 0 : vertical[i];
    }

    // Positions come out of the shader, so there is nothing to put in
    // `position`. Something has to be, or three has no vertex count to draw.
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('aPointA', new THREE.BufferAttribute(a, 2));
    g.setAttribute('aPointB', new THREE.BufferAttribute(b, 2));
    g.setAttribute('aSlot', new THREE.BufferAttribute(slot, 1));
    g.setAttribute('aKind', new THREE.BufferAttribute(kind, 1));
    g.setAttribute('aCross', new THREE.BufferAttribute(cross, 4));
    g.setAttribute('aRange', new THREE.BufferAttribute(within, 2));
    g.setAttribute('aHeight', new THREE.BufferAttribute(height, 1));
    g.setAttribute('aFade', new THREE.BufferAttribute(fade, 3));

    if (index !== null) g.setIndex(new THREE.BufferAttribute(index, 1));

    return g;
  };

  const { points: mine, runs: where } = fills(span);

  const wallGeometry = geometry(shape.wallPoint, shape.wallHeight, null, shape.index);
  const lineGeometry = geometry(shape.linePoint, shape.lineHeight, shape.lineVertical, null);
  const fillGeometry = filling(span, mine, cutting(span, mine, where, range), range);

  const walls = new THREE.Mesh(wallGeometry, wall);
  const lines = new THREE.LineSegments(lineGeometry, line);
  const floors = new THREE.Mesh(fillGeometry, fill);

  // The shader puts the fill on the ground plane; this is the hair of clearance
  // that keeps it over the tiles and under the walls standing on them.
  floors.position.y = options.fillHeight;

  // Nothing is where its `position` attribute says it is, so there is no box
  // worth testing against the frustum.
  walls.frustumCulled = false;
  lines.frustumCulled = false;
  floors.frustumCulled = false;

  return {
    walls,
    lines,
    fill: floors,

    // Every buffer in the span is written at load and never again: the walls
    // are positioned by the shader and the floors were cut in advance, each cut
    // gated by the window it is right over. Seeking is three numbers.
    seek(to: number): void {
      wall.uniforms.uTime.value = to;
      line.uniforms.uTime.value = to;
      fill.uniforms.uTime.value = to;
    },

    dispose(): void {
      uniforms.uFrames.value.dispose();
      uniforms.uEntries.value.dispose();
      wallGeometry.dispose();
      lineGeometry.dispose();
      fillGeometry.dispose();
      wall.dispose();
      line.dispose();
      fill.dispose();
    },
  };
}
