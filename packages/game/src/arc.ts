// -----------------------------------------------------------------------------
// The turn, as a rational function of t
//
// A version in flight eases its rotation on from identity, and the obvious way
// to do that is to ease the angle: `rot = theta * t`. Every position in the span
// is then a trigonometric function of `t`, and the bake pays for that in the one
// place it hurts — asking *when* something happens. A corner reaching an edge is
// `cross(q2 - q1, p - q1) = 0`, and with the angle eased linearly that reads
//
//   A(t) + B(t) cos(phi t) + C(t) sin(psi t) = 0
//
// with two incommensurate frequencies where the two features belong to polygons
// turning at different rates. That has no closed form and no finite root count
// to argue from, which is why the span is cut by measuring rather than by
// solving. See *Cutting the span* in `bake.ts`.
//
// Rotating by a rational quadratic instead makes every coordinate in the span a
// ratio of polynomials in `t`. The substitution is the half-angle one:
//
//   u = t * tan(theta / 2),  cos = (1 - u^2) / (1 + u^2),  sin = 2u / (1 + u^2)
//
// which is exactly `angle(t) = 2 atan(t tan(theta / 2))` — the same turn through
// the same angle about the same pivot, arriving at the same place, taken at a
// different speed. The endpoints are identical: `angle(0) = 0` and
// `angle(1) = theta`. What changes is the middle.
//
// This is the trick a rational quadratic Bezier turns a circular arc with, and
// it inherits that construction's one limit: `tan(theta / 2)` runs off at half a
// turn, so an arc has to be cut into pieces short enough to be representable.
//
// How uneven the turn is
// ----------------------
// Within one piece the angle runs fast early and slow late. At the half-way
// point of a piece spanning `phi`, the eased angle is `2 atan(tan(phi/4))`
// against the `phi/2` a linear easing would give, and the gap grows like the
// cube of `phi`:
//
//   phi = pi/2   8.4 degrees off at the midpoint
//   phi = pi/4   0.9 degrees
//   phi = pi/8   0.1 degrees
//
// So `ARC` buys evenness with pieces, and pieces are what the solver pays in:
// each one is a separate polynomial and a separate interval to isolate roots in.
// A quarter turn is the balance struck here — a right-angle gesture, which is
// the common one, is two pieces and under a degree of unevenness at its worst.
//
// A piece boundary is a real seam. The angle is continuous and monotone across
// it, but its derivative is not, so the bake has to treat `breaksOf` as
// keyframes the way it treats the ends of the span. They are known outright from
// the layer chain and cost nothing to place, which is the good kind of cut.
// -----------------------------------------------------------------------------

/** The most one rational piece may turn through. See the table above. */
export const ARC = Math.PI / 4;

/** A turn, as the shader wants it: the two entries of the rotation, never the
 * angle they came from. */
export interface Turn {
  cos: number
  sin: number
}

/** How many pieces a turn through `rotation` is cut into. At least one, so a
 * layer that does not turn is still one ordinary piece. */
export function piecesOf(rotation: number): number {
  return Math.max(1, Math.ceil(Math.abs(rotation) / ARC));
}

/**
 * Where in the turn `t` lands: which piece, and how far through it.
 *
 * `t = 1` lands at the end of the last piece rather than the start of a piece
 * that does not exist, which is the only reason the clamp is here.
 */
export function pieceAt(rotation: number, t: number): { piece: number, at: number } {
  const k = piecesOf(rotation);
  const s = t * k;
  const piece = Math.min(Math.max(Math.floor(s), 0), k - 1);

  return { piece, at: s - piece };
}

/**
 * The rotation of a layer easing on, at `t`.
 *
 * Identity at 0 and the layer's own turn at 1, whatever `ARC` is, because the
 * pieces are contiguous and each one is exact at both of its ends.
 */
export function turnAt(rotation: number, t: number): Turn {
  const k = piecesOf(rotation);
  const phi = rotation / k;
  const { piece, at } = pieceAt(rotation, t);

  const u = at * Math.tan(phi / 2);
  const w = 1 + u * u;
  const c = (1 - u * u) / w, s = 2 * u / w;

  const base = piece * phi;
  const bc = Math.cos(base), bs = Math.sin(base);

  return { cos: bc * c - bs * s, sin: bs * c + bc * s };
}

/**
 * The same as an angle, for the one caller that carries a `Transform` around
 * rather than a matrix.
 *
 * Wrapped into `(-pi, pi]` by `atan2`, and that is harmless: everything
 * downstream of this takes its cosine and its sine. Nothing reads the winding
 * back out, and nothing may start to.
 */
export function angleAt(rotation: number, t: number): number {
  const { cos, sin } = turnAt(rotation, t);

  return Math.atan2(sin, cos);
}

/** Where the pieces of a turn meet, in `t`, ends excluded. Keyframes for the
 * bake: the angle is continuous across one of these and its derivative is not. */
export function breaksOf(rotation: number): number[] {
  const k = piecesOf(rotation);
  const out: number[] = [];

  for (let i = 1; i < k; i++) out.push(i / k);

  return out;
}

/** `turnAt`, transcribed. The shader and `linkAt` have to agree with the bake
 * to the last bit, so there is one statement of it and two readers. */
export const TURN_GLSL = /* glsl */ `
  const float ARC = ${ARC};

  vec2 turnAt(float rotation, float t) {
    float k = max(1.0, ceil(abs(rotation) / ARC));
    float phi = rotation / k;

    float s = t * k;
    float piece = clamp(floor(s), 0.0, k - 1.0);
    float at = s - piece;

    float u = at * tan(phi * 0.5);
    float w = 1.0 + u * u;
    float c = (1.0 - u * u) / w;
    float n = 2.0 * u / w;

    float base = piece * phi;
    float bc = cos(base), bs = sin(base);

    return vec2(bc * c - bs * n, bs * c + bc * n);
  }
`;
