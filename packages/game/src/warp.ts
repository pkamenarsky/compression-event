// -----------------------------------------------------------------------------
// The warp
//
// The space around the player contracts, and these are ways of making the
// screen say so. Each is a bend in where the screen pass reads the scene from,
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
// One number drives it, `amount`: nothing at rest, rising a little before a
// beat, over and back off after it — how far either side is the config's, in
// beats — and the whole of it while dying. Negative is the level opening back up, and every warp is written so
// that the sign turns it round. At zero the pass reads exactly where it always
// did, which is why the editor, which never sets it, is untouched.
//
// `vertigo` is not here at all: it is the camera's view narrowing, and the
// game does it. As far as the shader knows it is `none`.
//
// Experimental, and switched between in the game with `<` and `>`.
// -----------------------------------------------------------------------------

import * as THREE from 'three';
import { MAX_TAPS, RenderConfig } from './config';
import type { Stage } from './screen';

/** The warps in the order `<` and `>` walk them. The shader numbers them from
 * one, and none is zero. */
export const WARPS = [
  'pinch',
  'pulse',
  'buckle',
  'fisheye',
  'vertigo',
] as const;

export type Warp = typeof WARPS[number];

/** The warp's part of the render config: what the envelope below reads. */
type Warping = RenderConfig['warp'];

// ── How hard, and when ──
//
// The one number that drives every warp, as a function of where the beat is.
// Here rather than in the game because the editor's first-person view plays
// transitions too and has to bend them the same way.

/**
 * How hard the picture is bent `since` seconds after a beat — negative before
 * one — on a beat `beat` seconds long.
 *
 * The window is the config's, in beats either side of the moment a shift
 * begins: from `from` (at or before it) a run-up to `braced`, and from the beat
 * to `to` (at or after it) over and back off again, never under where the
 * run-up left it until it has passed. Nothing outside it.
 *
 * The level opening back up bends the other way and has no run-up, since that
 * comes of a pickup rather than the clock.
 */
export function beaten(since: number, beat: number, opening: boolean, w: Warping): number {
  const u = since / beat;

  if (u < 0) {
    const from = Math.min(w.from, 0);

    return from < 0 && u > from ? w.braced * (1 - u / from) : 0;
  }

  if (u >= w.to) return 0;

  const p = u / w.to;
  const swell = Math.sin(Math.PI * p);

  return opening ? -swell : Math.max(swell, w.braced * (1 - p));
}

/**
 * The camera's field of view, in degrees, under the vertigo warp: `wide`
 * narrowed as the level closes, and widened as it opens. Short of closing it
 * altogether, however hard it is turned up. Anything else leaves it alone.
 */
export function narrowed(wide: number, amount: number, w: Warping): number {
  if (!w.on || w.kind !== 'vertigo') return wide;

  const by = Math.min(w.vertigo.narrow * w.strength * amount, 0.95);

  return Math.atan(Math.tan(wide / 2 * Math.PI / 180) * (1 - by)) * 2 * 180 / Math.PI;
}

/**
 * The warp stage: `warped(uv)` is the target read at where the warp says `uv`
 * shows. Needs `occluded` from `ssao.ts` ahead of it.
 *
 * `p` is centred and square — x runs wider than y by the aspect — so a circle
 * on screen is a circle here, and the screen is the box out to `edge`.
 */
export const warp: Stage = {
  glsl: /* glsl */ `
    uniform int uWarp;
    uniform float uAmount;
    uniform float uTime;
    uniform float uAspect;
    uniform float uWarpStrength;
    uniform vec2 uPinch;
    uniform vec3 uPulse;
    uniform vec2 uBuckle;
    uniform float uFisheye;

    // One axis bent and its ends left where they were: x in [-h, h] onto
    // itself. Positive k swells the middle and crams the ends; negative does
    // the opposite. Monotone, so nothing folds, for |k| under a half — which
    // is where it stops, however hard it is asked.
    float bend(float x, float h, float k) {
      float u = x / h;

      k = clamp(k, -0.49, 0.49);

      return x * (1.0 - k + k * u * u);
    }

    // A displacement that fades out towards the edges of the screen, so that it
    // never reads from off it — and clamped in case it tries.
    vec2 held(vec2 p, vec2 q, vec2 edge) {
      vec2 room = edge - abs(p);
      float fade = smoothstep(0.0, 0.15, min(room.x, room.y));

      return clamp(p + (q - p) * fade, -edge, edge);
    }

    Texel warped(vec2 uv) {
      float a = clamp(uAmount, -1.0, 1.0) * uWarpStrength;

      if (uWarp == 0 || a == 0.0) return occluded(uv);

      vec2 edge = vec2(0.5 * uAspect, 0.5);
      vec2 p = (uv - 0.5) * vec2(uAspect, 1.0);
      float r = length(p);
      vec2 q = p;

      // The middle swells towards the eye and the edges are crammed in behind
      // it: everything that was at the side of the room is now nearer the middle
      // of it.
      if (uWarp == 1) {
        q = vec2(bend(p.x, edge.x, uPinch.x * a), bend(p.y, edge.y, uPinch.y * a));
      }

      // A pulse in the ears: the whole view throbs, two beats at a time, faster
      // the closer the level is to shut.
      else if (uWarp == 2) {
        float rate = uPulse.y + uPulse.z * abs(a);
        float t = fract(uTime * rate);
        float beat = exp(-t * 9.0) + 0.6 * exp(-max(t - 0.22, 0.0) * 9.0) * step(0.22, t);
        float k = uPulse.x * a * beat;

        q = vec2(bend(p.x, edge.x, k), bend(p.y, edge.y, k));
      }

      // The walls buckling under it: the picture shears in bands, harder
      // towards the edges where the walls are, as if the screen itself were
      // being pressed out of true.
      else if (uWarp == 3) {
        float band = sin(p.y * uBuckle.y + uTime * 7.0) * sin(p.y * 5.0 - uTime * 3.0);

        q = held(p, vec2(p.x + band * uBuckle.x * a * r, p.y), edge);
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
        // Short of the whole of it, where the tangent runs off to infinity at
        // the corners.
        float power = 3.141593 / (2.0 * corner) * clamp(uFisheye * a, -0.98, 0.98);
        vec2 dir = p / r;

        if (power > 0.0) {
          q = dir * tan(r * power) * corner / tan(corner * power);
        }
        else {
          float k = -power * 10.0;

          q = dir * atan(r * k) * edge.y / atan(edge.y * k);
        }
      }

      return occluded(clamp(q / vec2(uAspect, 1.0) + 0.5, 0.0, 1.0));
    }
  `,
  uniforms: () => ({
    uWarp: { value: 0 },
    uAmount: { value: 0 },
    uTime: { value: 0 },
    uAspect: { value: 1 },
    uWarpStrength: { value: 1 },
    uPinch: { value: new THREE.Vector2() },
    uPulse: { value: new THREE.Vector3() },
    uBuckle: { value: new THREE.Vector2() },
    uFisheye: { value: 0 },
  }),

  // Vertigo has a number and no case in the shader, so it reads the scene
  // straight: it is the camera that does it.
  apply(u, { warp: w }): void {
    u.uWarp.value = w.on ? WARPS.indexOf(w.kind) + 1 : 0;
    u.uWarpStrength.value = w.strength;
    u.uPinch.value.set(w.pinch.across, w.pinch.up);
    u.uPulse.value.set(w.pulse.depth, w.pulse.rate, w.pulse.quicken);
    u.uBuckle.value.set(w.buckle.shear, w.buckle.bands);
    u.uFisheye.value = w.fisheye.power;
  },
};

/**
 * The blur stage: `blurred(uv)` is a run of reads along the line from `uv` in
 * to the middle of the screen, each through the warp — so the blur is over the
 * top of whichever warp is on, and the two cannot be swapped round. Needs
 * `warped` ahead of it.
 *
 * Every read is nearer the middle than the pixel is, so it never reads from off
 * screen. It reaches in as far as the warp's `uAmount` says the level is
 * closing, times the config's reach.
 */
export const blur: Stage = {
  glsl: /* glsl */ `
    uniform float uReach;
    uniform int uTaps;

    Texel blurred(vec2 uv) {
      float reach = uReach * min(abs(uAmount), 1.0);

      if (reach <= 0.0 || uTaps < 2) return warped(uv);

      Texel sum = Texel(vec3(0.0), 0.0, 0.0, 0.0);
      float last = float(uTaps - 1);

      for (int i = 0; i < ${MAX_TAPS}; i++) {
        if (i >= uTaps) break;

        Texel t = warped(0.5 + (uv - 0.5) * (1.0 - reach * float(i) / last));

        sum.rgb += t.rgb;
        sum.wall += t.wall;
        sum.shade += t.shade;
        sum.sky += t.sky;
      }

      float n = float(uTaps);

      return Texel(sum.rgb / n, sum.wall / n, sum.shade / n, sum.sky / n);
    }
  `,
  uniforms: () => ({ uReach: { value: 0 }, uTaps: { value: 1 } }),

  apply(u, { blur: b }): void {
    u.uReach.value = b.on ? b.reach : 0;
    u.uTaps.value = Math.min(Math.max(Math.round(b.taps), 1), MAX_TAPS);
  },
};
