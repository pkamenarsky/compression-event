// -----------------------------------------------------------------------------
// The warp
//
// The space around the player contracts, and these are ways of making the
// screen say so. Each is a bend in where the dither pass reads the scene from,
// done before the quantising, so whatever it does to the picture comes out in
// the same pixels and the same pattern as everything else rather than smeared
// over the top of them.
//
// Every one of them only *moves* the picture. Nothing is darkened, blended or
// blurred — a colour that was not in the scene is a colour the dither has to
// make a pattern of, and a pattern that was not in the level is not the level
// closing in. And every one of them maps the screen onto itself: the edges stay
// where they are and nothing is read from off it, so the picture always covers
// the whole of the screen.
//
// One number drives it, `amount`: nothing at rest, rising and falling over a
// shift, a little before one as the beat runs out, and the whole of it while
// dying. Negative is the level opening back up, and every warp is written so
// that the sign turns it round. At zero the pass reads exactly where it always
// did, which is why the editor, which never sets it, is untouched.
//
// `vertigo` is not here at all: it is a move of the camera, and the game does
// it. As far as the shader knows it is `none`.
//
// Experimental, and switched between in the game with `<` and `>`.
// -----------------------------------------------------------------------------

/** The warps in the order `<` and `>` walk them, index as the shader sees it. */
export const WARPS = [
  'none',
  'pinch',
  'vice',
  'pulse',
  'shockwave',
  'buckle',
  'vertigo',
] as const;

export type Warp = typeof WARPS[number];

/**
 * Where to read the scene from.
 *
 * `p` is centred and square — x runs wider than y by the aspect — so a circle
 * on screen is a circle here, and the screen is the box out to `edge`. Mixed
 * into the dither pass's fragment shader, which provides `uScene`.
 */
export const warpGLSL = /* glsl */ `
  uniform int uWarp;
  uniform float uAmount;
  uniform float uProgress;
  uniform float uTime;
  uniform float uAspect;

  // One axis bent and its ends left where they were: x in [-h, h] onto
  // itself. Positive k swells the middle and crams the ends; negative does
  // the opposite. Monotone, so nothing folds, for |k| under a half.
  float bend(float x, float h, float k) {
    float u = x / h;

    return x * (1.0 - k + k * u * u);
  }

  // A displacement that fades out towards the edges of the screen, so that it
  // never reads from off it — and clamped in case it tries.
  vec2 held(vec2 p, vec2 q, vec2 edge) {
    vec2 room = edge - abs(p);
    float fade = smoothstep(0.0, 0.15, min(room.x, room.y));

    return clamp(p + (q - p) * fade, -edge, edge);
  }

  vec3 warped(vec2 uv) {
    float a = clamp(uAmount, -1.0, 1.0);

    if (uWarp == 0 || a == 0.0) return texture2D(uScene, uv).rgb;

    vec2 edge = vec2(0.5 * uAspect, 0.5);
    vec2 p = (uv - 0.5) * vec2(uAspect, 1.0);
    float r = length(p);
    vec2 q = p;

    // The middle swells towards the eye and the edges are crammed in behind
    // it: everything that was at the side of the room is now nearer the middle
    // of it.
    if (uWarp == 1) {
      q = vec2(bend(p.x, edge.x, 0.45 * a), bend(p.y, edge.y, 0.3 * a));
    }

    // The sides press in like a vice: what is at the edges of the screen grows
    // towards the middle, hardest halfway up, and the middle is squeezed thin
    // between them.
    else if (uWarp == 2) {
      float bow = 1.0 - 0.5 * (p.y / edge.y) * (p.y / edge.y);

      q = vec2(bend(p.x, edge.x, -0.45 * a * bow), p.y);
    }

    // A pulse in the ears: the whole view throbs, two beats at a time, faster
    // the closer the level is to shut.
    else if (uWarp == 3) {
      float rate = 1.2 + 2.5 * abs(a);
      float t = fract(uTime * rate);
      float beat = exp(-t * 9.0) + 0.6 * exp(-max(t - 0.22, 0.0) * 9.0) * step(0.22, t);
      float k = 0.4 * a * beat;

      q = vec2(bend(p.x, edge.x, k), bend(p.y, edge.y, k));
    }

    // Rings travelling in from the edge of the screen to the middle — out
    // from it, going the other way — bending the picture as they cross it.
    else if (uWarp == 4) {
      vec2 dir = r > 0.0 ? p / r : vec2(0.0);
      float shift = 0.0;

      for (int i = 0; i < 3; i++) {
        float phase = fract(uProgress * 1.5 + float(i) / 3.0);
        float at = a > 0.0 ? 1.1 * (1.0 - phase) : 1.1 * phase;
        float d = r - at;

        shift += d * exp(-d * d * 180.0);
      }

      q = held(p, p - dir * shift * 0.9 * abs(a), edge);
    }

    // The walls buckling under it: the picture shears in bands, harder
    // towards the edges where the walls are, as if the screen itself were
    // being pressed out of true.
    else if (uWarp == 5) {
      float band = sin(p.y * 22.0 + uTime * 7.0) * sin(p.y * 5.0 - uTime * 3.0);

      q = held(p, vec2(p.x + band * 0.05 * a * r, p.y), edge);
    }

    return texture2D(uScene, clamp(q / vec2(uAspect, 1.0) + 0.5, 0.0, 1.0)).rgb;
  }
`;
