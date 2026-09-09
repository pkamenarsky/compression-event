// -----------------------------------------------------------------------------
// What a wall is, whichever way it is positioned
//
// There are two sources of geometry — the boundary as it stands right now, and
// the boundary in flight between two versions — and they have to be the same
// walls. Not similar: the same. The editor crosses between them every time a
// transition starts or ends, and anything that differs across that crossing
// reads as a flicker in the one place a viewer is paying most attention.
//
// So the topology and the shading live here and both sources call them. What is
// left to differ is the one thing that genuinely does: where a vertex is. The
// still one reads it off an attribute; the morph one rebuilds it from the frame
// and entry tables at an instant. See `still.ts` and `morph.ts`.
//
// Anything neither of them can work out alike is worked out for them, upstream,
// and arrives as data. Whether there is a corner at a point is the one of
// those: it is a question about a polygon *and its neighbours*, `still` holds
// the whole boundary and the morph holds one polygon's cut of it, and the two
// would answer differently every time two rooms abut. So the CSG answers it
// once and it rides in on the run. See `Run`, and `cornering` in the editor's
// `geometry.ts`.
// -----------------------------------------------------------------------------

import * as THREE from 'three';
import { bayerGLSL } from './dither';
import { Point } from './world';

/**
 * One run of the boundary, with the corner question already answered.
 *
 * `corner[i]` says whether the boundary actually turns at `points[i]`, which is
 * whether the vertical the extrusion stands there is telling the truth. The CSG
 * leaves a point wherever two edges met, and where the set runs straight
 * through one — two rooms overlapping, a solid cutting across the pair, two
 * rooms abutting so that one flat wall is made of two polygons' runs — the
 * point it leaves sits in the middle of what is now one flat wall. The wall is
 * right; a line drawn down the middle of it is not.
 *
 * Answered upstream rather than here, and that is the whole point: the question
 * is about a polygon *and its neighbours*, and the only place that ever sees
 * both is where the boundary is computed. See `cornering` in the editor's
 * `geometry.ts`. Asked here it could only be answered from the runs in hand,
 * and the two sources do not hold the same ones — `still` gets the whole
 * boundary and the morph gets one polygon's cut of it — so the two would
 * disagree at every junction between two polygons, and the disagreement would
 * show as a line flickering on at the start of every transition and off at the
 * end. See the header above.
 */
export interface Run {
  points: readonly Point[]
  corner: readonly boolean[]
}

/** A stretch of consecutive points in whatever flat array of them the caller
 * holds. Open — a ring of the union belongs to no one polygon, and a wall was
 * never more than a consecutive pair. */
export interface Span {
  first: number
  count: number
}

/**
 * The wall topology of a set of runs, as indices back into their points.
 *
 * Four vertices and two triangles per consecutive pair for the walls; the top
 * and bottom of each one, and a vertical at every corner, for the lines. Which
 * is the jam build's, and is why the level reads as drawn rather than as
 * shaded.
 *
 * Indices rather than positions, because the two sources disagree about what a
 * position is and agree exactly about this.
 */
export interface Extruded {
  /** Per wall vertex: which point of the outline it stands on. */
  wallPoint: Int32Array
  /** Per wall vertex: 0 on the floor, 1 at the top. */
  wallHeight: Float32Array
  linePoint: Int32Array
  lineHeight: Float32Array
  /**
   * Per line vertex: 1 for the vertical at a corner, 0 for the top and bottom
   * of a wall.
   *
   * Only the vertical is a claim that there is a corner there, so only it can
   * be wrong about one. The horizontals run along a wall and are drawn whatever
   * the points at their ends turn out to be.
   */
  lineVertical: Float32Array
  index: Uint32Array
}

export function extrude(spans: Iterable<Span>): Extruded {
  const wallPoint: number[] = [], wallHeight: number[] = [];
  const linePoint: number[] = [], lineHeight: number[] = [], lineVertical: number[] = [];
  const index: number[] = [];

  const wall = (point: number, height: number): void => {
    wallPoint.push(point);
    wallHeight.push(height);
  };

  const line = (point: number, height: number, vertical: number): void => {
    linePoint.push(point);
    lineHeight.push(height);
    lineVertical.push(vertical);
  };

  for (const span of spans) {
    const last = span.first + span.count - 1;

    for (let i = span.first; i < last; i++) {
      const base = wallPoint.length;

      wall(i, 0);
      wall(i + 1, 0);
      wall(i, 1);
      wall(i + 1, 1);

      index.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);

      line(i, 0, 0);
      line(i + 1, 0, 0);
      line(i, 1, 0);
      line(i + 1, 1, 0);
    }

    for (let i = span.first; i <= last; i++) {
      line(i, 0, 1);
      line(i, 1, 1);
    }
  }

  return {
    wallPoint: new Int32Array(wallPoint),
    wallHeight: new Float32Array(wallHeight),
    linePoint: new Int32Array(linePoint),
    lineHeight: new Float32Array(lineHeight),
    lineVertical: new Float32Array(lineVertical),
    index: new Uint32Array(index),
  };
}

// -----------------------------------------------------------------------------
// Shading
//
// The jam build's `retroWallShader`, with its normal taken from the derivatives
// of the world position rather than from an attribute. A morphing wall has no
// fixed normal to ship, and shipping one per end of a stretch and lerping it
// would be a third thing to keep in step with the other two. For a flat quad
// the derivative is exact and it is free.
// -----------------------------------------------------------------------------

/**
 * The near plane, done by hand, for the one surface the hardware drops.
 *
 * A triangle spanning the eye plane — two corners behind the camera, one in
 * front — is dropped whole by the near-plane clip when the two behind it agree
 * exactly in `clip.x` or `clip.y`. Not one pixel of it rasterises, at any
 * `side`, and three's own `MeshBasicMaterial` does it too. The failure band is
 * one float32 step wide and it is reachable from the likeliest place to stand:
 * a floor is authored on the grid, the walk starts facing due north, and the
 * fill is one shape spanning the room, so an edge running north lines up to the
 * bit. See `scratch/clip.html`.
 *
 * The floor is the only thing exposed. A wall has two corners behind whenever
 * one ground point is, but those two are one point at two heights and so differ
 * in `clip.y` by the height of the wall; a floor is the one surface whose every
 * vertex sits at one height, which hands over half the condition for nothing.
 *
 * So the fill clips itself, and only in the case that is broken. Of a triangle
 * with two corners behind the near plane, what survives the clip is exactly the
 * triangle made by the front corner and the two points where its edges cross
 * the plane — three corners in, three corners out, which is the one case a
 * vertex shader can do at all, because no vertex has to become two. Each behind
 * corner walks up its own edge to the plane and the triangle is the clipped one
 * before the hardware ever sees it.
 *
 * The other cases are left alone. One corner behind clips to a quad and cannot
 * be done here — and does not need to be, because the hardware gets it right;
 * three behind is nothing on screen either way.
 *
 * Attributes interpolate over the repaired triangle exactly as they would have
 * over the clipped one: the corners keep their true `w`, and a clip walks its
 * edges linearly too.
 */
export const NEARCLIP = /* glsl */ `
  /** How far past the near plane a walked corner lands, as a fraction of it.
   * Far enough that rounding cannot leave it behind the plane it was moved to,
   * and thousandths of a pixel across a viewport. */
  const float PAST = 1.0001;

  /** The near distance, out of the projection three built. */
  float nearPlane(mat4 projection) {
    return projection[3][2] / (projection[2][2] - 1.0);
  }

  /**
   * Whether a point is behind the near plane, which is the only case in which
   * anything below has anything to do.
   *
   * False under an orthographic projection whatever the point: w is 1
   * everywhere, there is no eye plane to span, and no triangle is at risk.
   */
  bool behindNear(vec3 at, mat4 view, mat4 projection) {
    return projection[2][3] == -1.0
      && (view * vec4(at, 1.0)).z > -nearPlane(projection);
  }

  /**
   * This corner, moved up its own edge onto the near plane — if exactly one of
   * the other two is behind the plane as well.
   *
   * All three in world units, and the answer in them too. \`own\` is behind the
   * plane already: the caller asked \`behindNear\` before solving the other two,
   * because on almost every frame nothing is and there is nothing to solve.
   *
   * Both others behind is a triangle wholly behind the eye, and neither of them
   * behind is the case the hardware gets right. The factor is worked out in the
   * view, where the plane is a plane, and applied in the world, where the point
   * is: the view is affine, so the two are the same walk along the same edge.
   */
  vec3 nearClipped(vec3 own, vec3 a, vec3 b, mat4 view, mat4 projection) {
    float edge = -nearPlane(projection);

    float zo = (view * vec4(own, 1.0)).z;
    float za = (view * vec4(a, 1.0)).z;
    float zb = (view * vec4(b, 1.0)).z;

    bool behindA = za > edge, behindB = zb > edge;

    if (behindA == behindB) return own;

    vec3 front = behindA ? b : a;
    float zf = behindA ? zb : za;

    return mix(own, front, (edge * PAST - zo) / (zf - zo));
  }
`;

/** What both vertex shaders promise the fragment shader. */
export const VARYINGS = /* glsl */ `
  varying vec3 vWorldPosition;
  varying float vHeightFrac;
  varying float vOpacity;
`;

/**
 * A fill vertex that is already placed: the ground plane in editor units, and
 * the triangle it is a corner of.
 *
 * Used for the still's fan, which does not move, and for both sources' cover
 * quad, which does not either. The morph's fan is the same shader with the
 * point rebuilt from the tables instead of read off an attribute — see
 * `fillShaderFor` in `morph.ts`.
 */
export const laidShader = /* glsl */ `
  uniform float uScale;

  /** The triangle's other two corners, in the same editor units \`position\`
   * holds this one in. */
  attribute vec2 aSideA;
  attribute vec2 aSideB;

  ${VARYINGS}

  ${NEARCLIP}

  /**
   * A corner on the ground plane, in world units.
   *
   * Through \`modelMatrix\`, which for a fill is the hair of clearance that
   * keeps it over the ground tiles and under the walls standing on them. The
   * walls are at the origin and take \`viewMatrix\` alone; the fill is the one
   * thing that is placed.
   */
  vec3 laid(vec2 at) {
    return (modelMatrix * vec4(at.x * uScale, 0.0, at.y * uScale, 1.0)).xyz;
  }

  void main() {
    // Flat, unlit, and never part way into existence.
    vHeightFrac = 0.0;
    vOpacity = 1.0;

    vec3 own = laid(position.xz);

    // The other two matter only when this corner is behind the eye.
    if (behindNear(own, viewMatrix, projectionMatrix)) {
      own = nearClipped(own, laid(aSideA), laid(aSideB), viewMatrix, projectionMatrix);
    }

    vWorldPosition = own;

    gl_Position = projectionMatrix * viewMatrix * vec4(own, 1.0);
  }
`;

export const wallFragment = /* glsl */ `
  uniform vec3 uWallColor;

  ${VARYINGS}

  // Under GLSL 3 there is no \`gl_FragColor\` and three does not put one back,
  // so the output is declared here rather than inherited.
  layout(location = 0) out vec4 fragColor;

  ${bayerGLSL}

  void main() {
    vec3 n = normalize(cross(dFdx(vWorldPosition), dFdy(vWorldPosition)));
    if (!gl_FrontFacing) n = -n;

    vec3 key = normalize(vec3(0.5, 0.8, 0.3));
    vec3 fill = normalize(vec3(-0.3, 0.4, -0.6));

    float light = max(dot(n, key), 0.0) * 0.7 + max(dot(n, fill), 0.0) * 0.3;

    light = light * 0.6 + 0.4;
    light *= mix(0.7, 1.0, vHeightFrac);

    vec3 color = uWallColor * light + (bayerDither(gl_FragCoord.xy) - 0.5) * 1.2;

    fragColor = vec4(color, 1.0);
  }
`;

export const lineFragment = /* glsl */ `
  uniform vec3 uLineColor;

  ${VARYINGS}

  layout(location = 0) out vec4 fragColor;

  void main() {
    // A vertical standing at a corner that is not there yet is not drawn at
    // all, and fades in as the corner emerges. Everything else is opaque.
    if (vOpacity < 0.02) discard;

    fragColor = vec4(uLineColor, vOpacity);
  }
`;

/**
 * One thing to fill: an outline and the holes cut in it, each a closed ring
 * given as indices into whatever flat array of points the caller holds.
 *
 * Open, in the sense that the first index is not repeated at the end. A contour
 * handed the same point twice has a zero-length edge and the triangulator has
 * nothing to do with it.
 *
 * The holes go with the outline rather than beside it because a triangulator is
 * told a contour and its holes and cannot work out which is which — and a hole
 * filled as an outline in its own right fills exactly the part that is supposed
 * to be gone. Which ring is a hole in which is `nesting`.
 */
export interface Contour {
  outer: readonly number[]
  holes: readonly (readonly number[])[]
}

/**
 * The triangles a set of contours fills with, as indices into whatever flat
 * array of points the caller holds.
 *
 * The other half of `extrude`, and the same bargain: indices rather than
 * positions, because the two sources disagree about what a position is and
 * agree exactly about this.
 *
 * Unlike `extrude`, this is not answered once and kept. A wall is the quad
 * between two consecutive points and stays that quad however they move; which
 * diagonals cut a ring into triangles is a question about where the points
 * *are*. A vertex convex at one end of a stretch can be reflex at the other,
 * and then the cut taken at the near end has triangles lying outside the shape
 * and a bite missing from it — which is what it did, and what it looked like
 * was a triangle vanishing as the transition ran out.
 *
 * A stretch fixes a ring's combinatorics; it does not fix its geometry. So a
 * still cuts once, because it does not move, and a morph cuts once per window
 * it measured a cut to hold over — see `cutting` in `morph.ts`, which is this
 * called at load rather than at the instant of drawing. It is a handful of
 * small rings and an ear clip is quadratic in the small either way.
 */
export function fan(contours: Iterable<Contour>, at: (i: number) => Point): Int32Array {
  const out: number[] = [];

  const traced = (ring: readonly number[]): THREE.Vector2[] =>
    ring.map(i => {
      const p = at(i);

      return new THREE.Vector2(p.x, p.y);
    });

  for (const contour of contours) {
    if (contour.outer.length < 3) continue;

    const holes = contour.holes.filter(h => h.length >= 3);

    // One flat list in the order the triangulator numbers them: the outline
    // first and each hole after it, which is what its faces index into.
    const all = [contour.outer, ...holes].flat();

    for (const face of THREE.ShapeUtils.triangulateShape(traced(contour.outer), holes.map(traced))) {
      for (const i of face) out.push(all[i]);
    }
  }

  return new Int32Array(out);
}

/**
 * Which of a set of closed rings are outlines, and which are holes in which.
 *
 * By area and by containment rather than by winding on its own. A set read in a
 * frame that mirrors comes back wound the other way from end to end, and the
 * nonzero rule does not mind — an outline at -1 is as filled as one at +1 — so
 * the sign that matters is the one *relative to the biggest ring*, which is an
 * outline whichever way round the frame put it.
 *
 * Tightest container wins, so a courtyard inside a room inside a courtyard
 * belongs to the room. A hole inside nothing is dropped: it is a ring the
 * arrangement wound inward with no outline to be inward of, which nothing can
 * fill and nothing should try to.
 *
 * The one place either source answers this, so a floor drawn standing still and
 * the same floor part way through a morph are cut the same way. See `filled` in
 * the editor's `export.ts`, which is this asked about points it already holds.
 */
export function nesting(
  rings: readonly (readonly Point[])[],
): { outer: number, holes: number[] }[] {
  if (rings.length === 0) return [];

  const area = rings.map(twiceArea);
  const biggest = area.reduce((b, a, i) => (Math.abs(a) > Math.abs(area[b]) ? i : b), 0);
  const outward = Math.sign(area[biggest]);

  const out = rings.map((_unused, outer) => ({ outer, holes: [] as number[] }));

  rings.forEach((ring, i) => {
    if (Math.sign(area[i]) === outward || ring.length === 0) return;

    let owner: number | null = null;

    rings.forEach((other, j) => {
      if (Math.sign(area[j]) !== outward || !inside(other, ring[0])) return;
      if (owner === null || Math.abs(area[j]) < Math.abs(area[owner])) owner = j;
    });

    if (owner !== null) out[owner].holes.push(i);
  });

  return out.filter(o => Math.sign(area[o.outer]) === outward);
}

/** Twice the signed area, which is what says which way a ring is wound. */
function twiceArea(ring: readonly Point[]): number {
  let sum = 0;

  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];

    sum += a.x * b.y - b.x * a.y;
  }

  return sum;
}

/** Whether a point is inside one ring, by the even-odd rule. Only ever asked
 * about a point of a ring that does not cross this one, so which rule it is
 * decides nothing. */
function inside(ring: readonly Point[], p: Point): boolean {
  let on = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];

    if ((a.y > p.y) !== (b.y > p.y)
      && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      on = !on;
    }
  }

  return on;
}

/**
 * Open runs joined end to end into closed rings, as index lists.
 *
 * A ring of a set belongs to no one polygon — that is the whole reason the
 * boundary is handed out as runs, and the header of the editor's `worldset.ts`
 * says why — so anything that needs the loop has to put it back. A wall never
 * does: it is the quad between two consecutive points, and a run is all it ever
 * sees. A fill does, because a triangulation is about the ring.
 *
 * By position and to a tolerance, not by name and not exactly. A junction is
 * two readings of one point, and the two are taken off *different tracks*: each
 * lerps across its own stretch, and two stretches covering the same instant
 * agree about that point only to whatever the bake measured. Exact matching
 * therefore joins nothing at all. The gap between two junctions is a wall's
 * width and the disagreement at one is hundredths of a unit, so nearest-within-
 * tolerance is not a guess — there is nothing else it could be.
 *
 * `at` must answer in one frame for every run, which means world units. A run's
 * points are kept in its own polygon's frame everywhere else, and two runs
 * meeting at a crossing have no reason to agree in either of them.
 *
 * A run whose two ends are already the same point is a ring on its own: a
 * polygon nothing overlaps contributes its whole outline in one piece.
 *
 * Anything that does not close is dropped. It is not a shape, and a fill is the
 * one thing here that cannot be drawn as an open thing.
 */
export function looped(
  runs: Iterable<readonly number[]>,
  at: (i: number) => Point,
  /** How far apart two readings of one junction may be. The bake's own
   * `TOLERANCE`, in the units the level is drawn in. */
  tol: number,
): number[][] {
  const mine = [...runs].filter(run => run.length >= 2);
  const head = mine.map(run => at(run[0]));
  const tail = mine.map(run => at(run[run.length - 1]));
  const used = new Set<number>();

  const limit = tol * tol;

  /** The unused run starting nearest `p`, if one starts near enough. */
  const from = (p: Point): number | undefined => {
    let best: number | undefined;
    let near = limit;

    for (let i = 0; i < mine.length; i++) {
      if (used.has(i)) continue;

      const d = (head[i].x - p.x) ** 2 + (head[i].y - p.y) ** 2;

      if (d <= near) {
        near = d;
        best = i;
      }
    }

    return best;
  };

  const closes = (p: Point, q: Point): boolean =>
    (p.x - q.x) ** 2 + (p.y - q.y) ** 2 <= limit;

  const out: number[][] = [];

  for (let start = 0; start < mine.length; start++) {
    if (used.has(start)) continue;

    const ring: number[] = [];

    let go: number | undefined = start;
    let shut = false;

    while (go !== undefined) {
      used.add(go);

      // Every run's last point is the next one's first. Dropping it here is
      // what leaves the ring closed rather than doubled at every junction.
      ring.push(...mine[go].slice(0, -1));

      if (closes(tail[go], head[start])) {
        shut = true;
        break;
      }

      go = from(tail[go]);
    }

    if (shut && ring.length >= 3) out.push(ring);
  }

  return out;
}

export interface WallOptions {
  /** World units per editor unit. */
  scale: number
  wallHeight: number
  wallColor: THREE.ColorRepresentation
  lineColor: THREE.ColorRepresentation
  /** What an authored floor is filled with. */
  fillColor: THREE.ColorRepresentation
  /** Where a filled floor lies, in world units: over the ground and under the
   * walls standing on it. */
  fillHeight: number
}

export const fillFragment = /* glsl */ `
  uniform vec3 uFillColor;

  ${VARYINGS}

  layout(location = 0) out vec4 fragColor;

  void main() {
    fragColor = vec4(uFillColor, 1.0);
  }
`;

// -----------------------------------------------------------------------------
// Filling a floor without cutting it up
//
// A polygon is filled by counting, not by carving. Fan every edge of every ring
// to one shared point, and the number of triangles covering a pixel — signed by
// which way each was wound — is the winding number of the ring at that pixel.
// The cones between the shared point and the ring cancel exactly, because every
// internal edge is walked once each way. Fill where the count is not zero and
// the nonzero rule is what you have drawn.
//
// That is a stencil buffer, and three draws: the fan with front faces
// incrementing, the fan again with back faces decrementing, and a quad over the
// lot drawn where the count is not zero. Two passes rather than one, and a
// buffer the renderer has to be asked for.
//
// Three more where the floor set has holes in it, a count being additive where
// a set is not: what the floors filled is marked, the holes are counted inside
// that mark, and the quad goes down where the mark is left standing. See
// `FillMaterials`.
//
// What it is worth
// ----------------
// Nothing has to be triangulated, so nothing can be triangulated wrongly. Which
// diagonals cut a ring is a question with a wrong answer and this asks no such
// question: an ear clip needs a *simple* polygon, and a ring interpolated part
// way through a stretch is not always one — the bake's tolerance covers how far
// the replay sits from the CSG, not whether the ring crosses itself on the way.
// A count is defined for any closed ring however many times it crosses itself.
//
// Rings do not have to be sorted into outlines and holes either, and they do not
// even have to be stitched. A run's cone cancels against its neighbour's at the
// point they share, so the runs off several polygons add up to their loop with
// nobody having worked out which loop that is. See `nesting` and `looped`, which
// the fill no longer calls.
//
// What it costs
// -------------
// A stencil buffer on the renderer and on the target the dither pass draws into.
// Three draws where there was one. A cover quad big enough for everything the
// fan rasterises, which is why it is sized off the points rather than guessed.
// And the fill becomes the one thing in the scene with an order of its own.
// -----------------------------------------------------------------------------

/**
 * What a fill is drawn with: two passes that count, one that fills, and the
 * three more a hole costs.
 *
 * A hole cannot be counted with the floors. A count is additive where a set is
 * not — two floors over the same ground count two, and a hole through both of
 * them takes one away and leaves it filled — so the two go into the same
 * buffer one after the other, with a bit set aside to carry the first answer
 * across the second.
 *
 * The high bit is that mark and the low seven are the count, which is a
 * winding number and never comes near the roof. So: the floors are counted, the
 * mark is written wherever that count stood and the count wiped as it goes, the
 * holes are counted inside the mark, and the colour goes down where the mark
 * stands and nothing was counted over it. Six draws where there are holes and
 * three where there are none — for the whole floor set, however much is in it.
 */
export interface FillMaterials {
  /** Front faces, counting up. */
  up: THREE.ShaderMaterial
  /** Back faces, counting down. Two materials rather than two-sided stencil
   * ops, which three does not expose. */
  down: THREE.ShaderMaterial
  /** What the floors filled, marked, and their count wiped under it. */
  mark: THREE.ShaderMaterial
  /** The holes' own count, taken only inside the mark. */
  holeUp: THREE.ShaderMaterial
  holeDown: THREE.ShaderMaterial
  /** The colour, wherever the count came out other than zero. Where there are
   * no holes, which is one draw rather than four. */
  cover: THREE.ShaderMaterial
  /** The colour where the mark stands and no hole was counted over it. */
  holed: THREE.ShaderMaterial
}

/** The high bit of the stencil, which carries what the floors filled across the
 * holes' count. */
const MARK = 0x80;

/** The rest of it, which is where a count goes. A winding number over one
 * level's floors does not come near the roof, and the ops wrap rather than
 * clamp, so the mark is never trodden on. */
const COUNT = 0x7f;

/**
 * The materials a source draws with: its own vertex shader, the shared fragment
 * ones, and whatever uniforms it needs on top of the colours.
 *
 * The fill takes a vertex shader of its own, and three materials. It is the one
 * surface that has to know what triangle a vertex is a corner of — see
 * `NEARCLIP` — which is a thing walls and lines have no attributes for and no
 * need of, and the one that is drawn by counting rather than by covering.
 */
export function materials(
  vertexShader: string,
  options: WallOptions,
  uniforms: Record<string, { value: unknown }>,
  fillShader: string = vertexShader,
): { wall: THREE.ShaderMaterial, line: THREE.ShaderMaterial, fill: FillMaterials } {
  const wall = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader,
    fragmentShader: wallFragment,
    uniforms: { ...uniforms, uWallColor: { value: new THREE.Color(options.wallColor) } },
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });

  const line = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader,
    fragmentShader: lineFragment,
    uniforms: { ...uniforms, uLineColor: { value: new THREE.Color(options.lineColor) } },

    // A fading vertical is the only thing that is ever part way there, and it
    // is a hairline over a wall it is about to lie flat against, so there is
    // nothing for it to sort against.
    transparent: true,
    depthWrite: false,
  });

  // Counting, not covering: no colour, no depth, and the stencil moved one way
  // by whichever faces this pass is drawing. Depth is left to the cover — the
  // fan is flat, so a wall in front of it hides all of it or none of it at a
  // pixel, and that is a question about one plane rather than about each
  // triangle of it.
  const counting = (
    side: THREE.Side,
    op: THREE.StencilOp,
    /** Where this pass counts at all. The floors count everywhere; the holes
     * count only inside what the floors filled, so that a hole hanging off the
     * edge of one takes nothing away from ground no floor laid. */
    within: boolean,
  ): THREE.ShaderMaterial =>
    new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: fillShader,
      fragmentShader: fillFragment,
      uniforms: { ...uniforms, uFillColor: { value: new THREE.Color(options.fillColor) } },
      side,
      colorWrite: false,
      depthTest: false,
      depthWrite: false,
      stencilWrite: true,
      stencilFunc: within ? THREE.EqualStencilFunc : THREE.AlwaysStencilFunc,
      stencilRef: MARK,
      stencilFuncMask: MARK,

      // The mark is left alone: it is the answer this pass is being read
      // against, and a count that trod on it would wipe the question.
      stencilWriteMask: COUNT,
      stencilFail: within ? THREE.KeepStencilOp : op,
      stencilZFail: op,
      stencilZPass: op,
    });

  /**
   * What the cover quad is drawn with, in whichever of its two jobs.
   *
   * Flat and unlit, laid on the ground under everything that stands on it. It
   * is a shape rather than a surface: nothing about which way it faces means
   * anything, so nothing shades it.
   *
   * `over` writes the colour and puts the buffer back as it goes — zeroed
   * whatever the test said, depth-failed fragments included, or a wall standing
   * in front of a floor would leave the count behind it for whatever draws
   * next. The marking pass writes no colour and replaces instead: `stencilRef`
   * is both what a stencil test compares against and what `Replace` writes, so
   * the one number says *where the floors filled* and *what to leave there*.
   */
  const reading = (
    func: THREE.StencilFunc,
    ref: number,
    mask: number,
    over: boolean,
  ): THREE.ShaderMaterial =>
    new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: laidShader,
      fragmentShader: fillFragment,
      uniforms: { ...uniforms, uFillColor: { value: new THREE.Color(options.fillColor) } },
      side: THREE.DoubleSide,
      colorWrite: over,
      depthTest: over,
      depthWrite: over,
      stencilWrite: true,
      stencilFunc: func,
      stencilRef: ref,
      stencilFuncMask: mask,
      stencilWriteMask: 0xff,
      stencilFail: THREE.ZeroStencilOp,
      stencilZFail: THREE.ZeroStencilOp,
      stencilZPass: over ? THREE.ZeroStencilOp : THREE.ReplaceStencilOp,
    });

  const fill = {
    up: counting(THREE.FrontSide, THREE.IncrementWrapStencilOp, false),
    down: counting(THREE.BackSide, THREE.DecrementWrapStencilOp, false),

    // Where the floors' count stands, and nowhere else: the mark goes on and
    // the count comes off in the one pass, so the holes start theirs from zero
    // over ground the floors laid.
    mark: reading(THREE.NotEqualStencilFunc, MARK, COUNT, false),
    holeUp: counting(THREE.FrontSide, THREE.IncrementWrapStencilOp, true),
    holeDown: counting(THREE.BackSide, THREE.DecrementWrapStencilOp, true),
    cover: reading(THREE.NotEqualStencilFunc, 0, 0xff, true),

    // The mark still standing with nothing counted over it: filled by a floor
    // and holed by nothing. Anything else the quad passes over is zeroed on the
    // way, which is what leaves the buffer as it was found.
    holed: reading(THREE.EqualStencilFunc, MARK, 0xff, true),
  };

  return { wall, line, fill };
}

/** How far a fill reaches, in editor units — the plane the floors are authored
 * in, where x and y are the ground's x and z. */
export interface Extent {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** How far outside the fill the cover is taken, in editor units. A fragment
 * marked and not covered is one left in the buffer for whatever draws next, and
 * the count is written by triangles whose corners are these bounds exactly. */
const MARGIN = 1;

/**
 * The quad the count is read through: a rectangle over everything the fan can
 * rasterise, on the ground plane.
 *
 * Two triangles, and each of its corners carrying the other two, because a
 * ground-plane rectangle is the near-plane clip's own favourite shape — every
 * edge axis-aligned, every vertex at one height. See `NEARCLIP`.
 */
export function covering(extent: Extent | null): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();

  if (extent === null) {
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    g.setAttribute('aSideA', new THREE.BufferAttribute(new Float32Array(0), 2));
    g.setAttribute('aSideB', new THREE.BufferAttribute(new Float32Array(0), 2));

    return g;
  }

  const x0 = extent.minX - MARGIN, x1 = extent.maxX + MARGIN;
  const y0 = extent.minY - MARGIN, y1 = extent.maxY + MARGIN;

  const at: Point[] = [
    { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 },
    { x: x0, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
  ];

  const position = new Float32Array(at.length * 3);
  const side = [new Float32Array(at.length * 2), new Float32Array(at.length * 2)];

  for (let i = 0; i < at.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = i + k;

      position[v * 3] = at[v].x;
      position[v * 3 + 2] = at[v].y;

      for (let j = 0; j < 2; j++) {
        const q = at[i + (k + 1 + j) % 3];

        side[j][v * 2] = q.x;
        side[j][v * 2 + 1] = q.y;
      }
    }
  }

  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('aSideA', new THREE.BufferAttribute(side[0], 2));
  g.setAttribute('aSideB', new THREE.BufferAttribute(side[1], 2));

  return g;
}

/**
 * A fill, ready to draw: the fan counted twice and the cover over it — and,
 * where there are holes, their own fan counted between the two.
 *
 * One object rather than three or six, because a fill is hidden and shown as
 * one thing and half of one on screen is not a fill at all.
 *
 * Three draws or six, and never more: what they cost is the ground they cover,
 * not how many floors or holes went into them. See `FillMaterials`.
 */
export function stencilled(
  fan: THREE.BufferGeometry,
  /** The holes' fan, or nothing where the floor set has none — which is most
   * levels, and the three-draw case. */
  holes: THREE.BufferGeometry | null,
  cover: THREE.BufferGeometry,
  fill: FillMaterials,
  height: number,
): THREE.Group {
  const group = new THREE.Group();

  const meshes = holes === null
    ? [
      new THREE.Mesh(fan, fill.up),
      new THREE.Mesh(fan, fill.down),
      new THREE.Mesh(cover, fill.cover),
    ]
    : [
      new THREE.Mesh(fan, fill.up),
      new THREE.Mesh(fan, fill.down),
      new THREE.Mesh(cover, fill.mark),
      new THREE.Mesh(holes, fill.holeUp),
      new THREE.Mesh(holes, fill.holeDown),
      new THREE.Mesh(cover, fill.holed),
    ];

  // The whole mechanism is the order. Each pass reads what the one before it
  // left in the buffer, and any two of them swapped is a floor set that is
  // simply wrong rather than one drawn a little differently. Nothing else in
  // the scene cares what order it is drawn in — depth sorts the walls — so this
  // is the one place an order is stated.
  meshes.forEach((mesh, i) => (mesh.renderOrder = i + 1));

  for (const mesh of meshes) {
    // Nothing is where its `position` attribute says it is — the shader places
    // it — so there is no box worth testing against the frustum.
    mesh.frustumCulled = false;
    mesh.position.y = height;
    group.add(mesh);
  }

  return group;
}

/** What both sources give the renderer: the meshes and a way to be rid of
 * them. */
export interface Source {
  walls: THREE.Mesh
  lines: THREE.LineSegments
  /**
   * The authored floors, filled and laid flat. Empty where there are none,
   * which is most levels.
   *
   * Three meshes rather than one — six where the floor set has holes in it —
   * because a fill is counted before it is covered. See `stencilled`.
   */
  fill: THREE.Group
  dispose(): void
}
