// -----------------------------------------------------------------------------
// The warp
//
// The space around the player contracts, and these are ways of making the
// screen say so. Each is a bend in where the dither pass reads the scene from,
// done before the quantising, so whatever it does to the picture comes out in
// the same pixels and the same pattern as everything else rather than smeared
// over the top of them.
//
// Every one of them only *moves* the picture, and maps the screen onto itself:
// the edges stay where they are and nothing is read from off it, so the
// picture always covers the whole of the screen.
//
// Over the top of whichever it is there is a radial blur, reaching in towards
// the middle as hard as the warp is bending — the room rushing in. It comes
// before the dither like the warp does, so the tones it makes are dithered in
// the pixels they are seen in rather than smeared out of them.
//
// One number drives it, `amount`: nothing at rest, rising and falling over a
// shift, a little before one as the beat runs out, and the whole of it while
// dying. Negative is the level opening back up, and every warp is written so
// that the sign turns it round. At zero the pass reads exactly where it always
// did, which is why the editor, which never sets it, is untouched.
//
// `vertigo` is not here at all: it is the camera's view narrowing, and the
// game does it. As far as the shader knows it is `none`.
//
// Experimental, and switched between in the game with `<` and `>`.
// -----------------------------------------------------------------------------

/** The warps in the order `<` and `>` walk them, index as the shader sees it. */
export const WARPS = [
  'none',
  'pinch',
  'pulse',
  'buckle',
  'fisheye',
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
  uniform float uTime;
  uniform float uAspect;
  uniform float uBlur;

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

  vec4 warped(vec2 uv) {
    float a = clamp(uAmount, -1.0, 1.0);

    if (uWarp == 0 || a == 0.0) return texture2D(uScene, uv);

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

    // A pulse in the ears: the whole view throbs, two beats at a time, faster
    // the closer the level is to shut.
    else if (uWarp == 2) {
      float rate = 1.2 + 2.5 * abs(a);
      float t = fract(uTime * rate);
      float beat = exp(-t * 9.0) + 0.6 * exp(-max(t - 0.22, 0.0) * 9.0) * step(0.22, t);
      float k = 0.4 * a * beat;

      q = vec2(bend(p.x, edge.x, k), bend(p.y, edge.y, k));
    }

    // The walls buckling under it: the picture shears in bands, harder
    // towards the edges where the walls are, as if the screen itself were
    // being pressed out of true.
    else if (uWarp == 3) {
      float band = sin(p.y * 22.0 + uTime * 7.0) * sin(p.y * 5.0 - uTime * 3.0);

      q = held(p, vec2(p.x + band * 0.05 * a * r, p.y), edge);
    }

    // A lens — the well-worn fisheye shader, after
    // http://stackoverflow.com/questions/6030814 — the middle bulging out at
    // the eye going in, and caving away from it coming back out.
    //
    // Pinned where it still covers the screen. Bulging, the corners stay put
    // and every other point reads from further in; caving, the short edge
    // stays put and nothing reads from past the circle through it, which is
    // still on screen whichever way it points.
    else if (uWarp == 4 && r > 0.0) {
      float corner = length(edge);
      float power = 3.141593 / (2.0 * corner) * 0.7 * a;
      vec2 dir = p / r;

      if (power > 0.0) {
        q = dir * tan(r * power) * corner / tan(corner * power);
      }
      else {
        float k = -power * 10.0;

        q = dir * atan(r * k) * edge.y / atan(edge.y * k);
      }
    }

    return texture2D(uScene, clamp(q / vec2(uAspect, 1.0) + 0.5, 0.0, 1.0));
  }

  // What the pass sees at a pixel: the warped scene, with how much of it is
  // wall in place of the wall's marker — whole or not at all, until the blur
  // averages it into a share.
  //
  // The blur is a run of reads along the line from the pixel in to the middle
  // of the screen, over the top of whichever warp is on. Every one of them is
  // nearer the middle than the pixel is, so it never reads from off screen.
  vec4 seen(vec2 uv) {
    if (uBlur <= 0.0) {
      vec4 t = warped(uv);

      return vec4(t.rgb, t.a < 0.75 ? 1.0 : 0.0);
    }

    vec4 sum = vec4(0.0);

    for (int i = 0; i < 12; i++) {
      vec4 t = warped(0.5 + (uv - 0.5) * (1.0 - uBlur * float(i) / 11.0));

      sum += vec4(t.rgb, t.a < 0.75 ? 1.0 : 0.0);
    }

    return sum / 12.0;
  }
`;
