// -----------------------------------------------------------------------------
// The render config
//
// Everything about how the picture is made that is worth turning by hand, in
// one object: which stages of the screen pass run, and the numbers that shape
// each of them. The stages themselves are in `screen.ts`'s list; each reads its
// own part of this and nothing else.
//
// Presets live here as code, which is where a configuration worth keeping ends
// up. The tweak panel (`tweak.ts`), over the editor's first-person view, edits
// the one in force, saves ones worth coming back to in the browser, and copies
// any of them out as a literal to paste into `PRESETS`. The game starts from
// whichever was last in force.
//
// A saved configuration is laid over the default rather than trusted whole, so
// one saved before a field existed picks the field up at its default.
// -----------------------------------------------------------------------------

import type { Sky } from './sky';
import type { Warp } from './warp';

export interface RenderConfig {
  /** The picture bent as the level closes in. See `warp.ts`. */
  warp: {
    on: boolean
    /** Which one; `<` and `>` walk them in the game. */
    kind: Warp
    /** Everything the level closing does to the picture, scaled. */
    strength: number
    /** Where it starts, in beats from the moment a shift begins: at or before
     * it, so negative. A beat is `BEAT_MS`. */
    from: number
    /** Where it has gone again, in beats after the same moment. The shift
     * itself is `REPLAY_MS` of it, 0.08 of a beat at the time of writing;
     * past that the level has arrived and the picture is still going. */
    to: number
    /** How far the run-up has got by the time the shift begins, 0 to 1. */
    braced: number
    pinch: {
      /** How hard the middle swells, across and up; under a half keeps it
       * from folding. */
      across: number
      up: number
    }
    pulse: {
      depth: number
      /** Beats per second at rest, and how many more at the height of it. */
      rate: number
      quicken: number
    }
    buckle: {
      /** How far the bands shear, as a share of the screen's height. */
      shear: number
      /** How many bands, roughly, from the top of the screen to the bottom. */
      bands: number
    }
    fisheye: {
      /** Share of the most the lens can take before it tears; under 1. */
      power: number
    }
    vertigo: {
      /** How far the view narrows at the height of it. */
      narrow: number
    }
  }

  /** A radial blur over the warp, in towards the middle. See `warp.ts`. */
  blur: {
    on: boolean
    /** How far in the run of reads reaches at the height of a shift, as a
     * share of the way to the middle. */
    reach: number
    /** How many reads make the run. More is smoother and costs more. */
    taps: number
  }

  /** The walls' Bayer nudge, which keeps a large flat surface from banding.
   * See `dither.ts`. */
  nudge: {
    on: boolean
    /** How far the 4x4 threshold pushes a wall's colour either way. */
    spread: number
  }

  /** The shadows' stipple. The stipple *is* the shadow — off, there is none.
   * See `artefacts.ts`. */
  stipple: {
    on: boolean
  }

  /** The colour to a handful of levels per channel, the 8x8 threshold
   * choosing which way. See `dither.ts`. */
  quantise: {
    on: boolean
    levels: number
    /** 0 quantises without dithering; 1 is the full Bayer spread. */
    strength: number
  }

  /** What is over the level, in one bit. See `sky.ts`. */
  sky: {
    on: boolean
    /** Which one; `;` and `'` walk them in the game. */
    kind: Sky
    /** Share of the sky's cells that have a star in them, in the skies that
     * have stars. */
    stars: number
    /** How much there is of whatever the sky is: for the night, the
     * nebula. */
    weight: number
    /** How much the stars that breathe shrink at the bottom of a breath; 1
     * puts them out. */
    twinkle: number
    /** How fast the sky wheels and the nebula works, against real time. */
    drift: number
  }
}

export const DEFAULT: RenderConfig = {
  warp: {
    on: true,
    kind: 'pulse',
    strength: 1,
    from: -0.16,
    to: 0.08,
    braced: 0.25,
    pinch: { across: 0.45, up: 0.3 },
    pulse: { depth: 0.2, rate: 1.2, quicken: 2.5 },
    buckle: { shear: 0.05, bands: 22 },
    fisheye: { power: 0.5 },
    vertigo: { narrow: 0.45 },
  },
  blur: { on: true, reach: 0.02, taps: 2 },
  nudge: { on: true, spread: 1.2 },
  stipple: { on: true },
  quantise: { on: true, levels: 5, strength: 1.1 },
  sky: { on: true, kind: 'night', stars: 0.3, weight: 0.45, twinkle: 0.6, drift: 1 },
};

export const FISHEYE: RenderConfig = {
  warp: {
    on: true,
    kind: 'fisheye',
    strength: 1,
    from: -0.24,
    to: 0.08,
    braced: 0.25,
    pinch: {
      across: 0.45,
      up: 0.3
    },
    pulse: {
      depth: 0.4,
      rate: 1.2,
      quicken: 2.5
    },
    buckle: {
      shear: 0.05,
      bands: 22
    },
    fisheye: {
      power: 0.15
    },
    vertigo: {
      narrow: 0.45
    }
  },
  blur: {
    on: true,
    reach: 0.12,
    taps: 12
  },
  nudge: {
    on: true,
    spread: 1.2
  },
  stipple: {
    on: true
  },
  quantise: {
    on: true,
    levels: 5,
    strength: 1.1
  },
  sky: {
    on: true,
    kind: 'night',
    stars: 0.3,
    weight: 0.45,
    twinkle: 0.6,
    drift: 1
  }
};

/** The configurations worth keeping, by name. The first is where a fresh
 * browser starts. */
export const PRESETS: Record<string, RenderConfig> = {
  default: DEFAULT,

  plain: over(DEFAULT, {
    warp: { on: false },
    blur: { on: false },
  }),

  fisheye: FISHEYE
};

/** The most taps the blur's loop will run, whatever the config asks for. */
export const MAX_TAPS = 32;

/** Where the tweak panel's slider for each number runs, and in what steps, by
 * its path. A number with none gets a range guessed off its default. */
export const RANGES: Record<string, [min: number, max: number, step: number]> = {
  'warp.strength': [0, 2, 0.01],
  'warp.from': [-1, 0, 0.01],
  'warp.to': [0, 1, 0.01],
  'warp.braced': [0, 1, 0.01],
  'warp.pinch.across': [0, 0.49, 0.01],
  'warp.pinch.up': [0, 0.49, 0.01],
  'warp.pulse.depth': [0, 0.49, 0.01],
  'warp.pulse.rate': [0, 5, 0.1],
  'warp.pulse.quicken': [0, 8, 0.1],
  'warp.buckle.shear': [0, 0.2, 0.005],
  'warp.buckle.bands': [0, 60, 1],
  'warp.fisheye.power': [0, 0.98, 0.01],
  'warp.vertigo.narrow': [0, 0.9, 0.01],
  'blur.reach': [0, 0.5, 0.01],
  'blur.taps': [1, MAX_TAPS, 1],
  'nudge.spread': [0, 2, 0.05],
  'quantise.levels': [2, 16, 1],
  'quantise.strength': [0, 2, 0.05],
  'sky.stars': [0, 1, 0.01],
  'sky.weight': [0, 1, 0.01],
  'sky.twinkle': [0, 1, 0.01],
  'sky.drift': [0, 10, 0.1],
};

/**
 * `base` with everything `patch` says laid over it, as a new object.
 *
 * Deep, and only over fields `base` has: a saved configuration from before a
 * field was added gets the field, and one from after a field was taken out
 * leaves it behind.
 */
export function over<T>(base: T, patch: unknown): T {
  if (typeof base !== 'object' || base === null) {
    return typeof patch === typeof base ? patch as T : base;
  }

  const out = { ...base } as Record<string, unknown>;
  const from = (typeof patch === 'object' && patch !== null ? patch : {}) as Record<string, unknown>;

  for (const key of Object.keys(out)) {
    if (key in from) out[key] = over(out[key], from[key]);
  }

  return out as T;
}

// ── Kept in the browser ──

const CURRENT = 'compression-event:render-config';
const SAVED = 'compression-event:render-configs';

/** Storage can be refused outright — a private window, a sandboxed page — and
 * a config that cannot be remembered is still a config. */
function stored<T>(key: string, fallback: T): T {
  try {
    const it = localStorage.getItem(key);

    return it === null ? fallback : JSON.parse(it) as T;
  }
  catch {
    return fallback;
  }
}

function store(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  }
  catch {
    // Not remembered, and nothing else to be done about it.
  }
}

/** The configuration last in force here, or the first preset. */
export function current(): RenderConfig {
  return over(DEFAULT, stored<unknown>(CURRENT, PRESETS[Object.keys(PRESETS)[0]]));
}

export function remember(config: RenderConfig): void {
  store(CURRENT, config);
}

/** The ones saved in this browser, by name. */
export function saved(): Record<string, RenderConfig> {
  const all = stored<Record<string, unknown>>(SAVED, {});

  return Object.fromEntries(Object.entries(all).map(([name, it]) => [name, over(DEFAULT, it)]));
}

export function save(name: string, config: RenderConfig): void {
  store(SAVED, { ...stored<Record<string, unknown>>(SAVED, {}), [name]: config });
}

export function forget(name: string): void {
  const all = stored<Record<string, unknown>>(SAVED, {});

  delete all[name];
  store(SAVED, all);
}
