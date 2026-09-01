// -----------------------------------------------------------------------------
// Sound
//
// The jam build's, carried over as it stands. Every sound is a factory that
// builds a fresh graph of Web Audio nodes when it is played, so the same
// definition can be in flight several times over, and `playSound` hands back
// something that can stop it. Nothing in here knows about the game.
// -----------------------------------------------------------------------------

/**
 * A sound definition: given an AudioContext, build a subgraph and return
 * its final output node.  The factory may also start OscillatorNodes /
 * AudioBufferSourceNodes internally — `playSound` will connect the
 * returned node to `ctx.destination`.
 *
 * The factory receives a `startTime` (in AudioContext time) so envelopes
 * can be scheduled precisely.
 */
export type SoundDef = (ctx: AudioContext, startTime: number) => AudioNode;

export interface SoundHandle {
  /** Stop the sound immediately (with a tiny fade-out to avoid clicks). */
  stop(): void
}

// ── Shared AudioContext (lazy) ──

let _ctx: AudioContext | null = null;

function getContext(): AudioContext {
  if (!_ctx) {
    _ctx = new AudioContext();
  }
  // Resume if suspended (browser autoplay policy)
  if (_ctx.state === 'suspended') {
    _ctx.resume();
  }
  return _ctx;
}

/** Expose the shared context for advanced use. */
export function audioContext(): AudioContext {
  return getContext();
}

// ── Active sounds ──

const _active = new Set<SoundHandle>();

/** Stop every currently-playing sound. */
export function stopAll(): void {
  for (const h of _active) {
    h.stop();
  }
  _active.clear();
}

// ── playSound ──

/**
 * Instantiate a sound definition and start playing it.
 *
 * Returns a `SoundHandle` whose `stop()` method will silence it
 * immediately (with a short fade-out to avoid clicks).
 */
export function playSound(def: SoundDef): SoundHandle {
  const ctx = getContext();
  const startTime = ctx.currentTime;

  // Build the node graph, watching for the sources it starts.
  //
  // A sound that runs out on its own — every oscillator stopped, every buffer
  // played to its end — never calls `stop()`, so without this its handle sits
  // in `_active` for the life of the page with its master gain still wired to
  // the destination. Most sounds are that kind. `playSoundFor` happens to stop
  // them on a timer, which is what has been keeping the set from growing, but
  // that is a caller's habit rather than something `playSound` can rely on.
  //
  // A factory only says what its output node is, so the sources are collected
  // as it asks for them. `ended` fires on each one that was started and given
  // an end, and the last of them is the sound being over. One that is never
  // given an end — the drone — has to be stopped by whoever started it, which
  // is what `stop` is for.
  const sources: AudioScheduledSourceNode[] = [];
  const output = def(watching(ctx, sources), startTime);

  // Master gain so we can fade out on stop
  const master = ctx.createGain();
  master.gain.value = 1;
  output.connect(master);
  master.connect(ctx.destination);

  let stopped = false;

  const handle: SoundHandle = {
    stop() {
      if (stopped) return;
      stopped = true;
      // Short fade-out to avoid click
      const now = ctx.currentTime;
      master.gain.setValueAtTime(master.gain.value, now);
      master.gain.linearRampToValueAtTime(0, now + 0.02);
      // Disconnect after fade
      setTimeout(() => {
        try {
          master.disconnect();
        } catch (_) {
          /* already disconnected */
        }
        _active.delete(handle);
      }, 50);
    },
  };

  _active.add(handle);

  // The sound running out is the handle's business being over. The nodes are
  // let go the same way `stop` lets them go, minus the fade: there is nothing
  // left to fade.
  let left = sources.length;

  const finished = (): void => {
    if (--left > 0 || stopped) return;
    stopped = true;
    try {
      master.disconnect();
    } catch (_) {
      /* already disconnected */
    }
    _active.delete(handle);
  };

  for (const source of sources) source.addEventListener('ended', finished, { once: true });

  return handle;
}

/**
 * The same context, with every source it is asked for noted down.
 *
 * A proxy rather than a wrapper with a method apiece, because a factory may
 * reach for anything on a context — `currentTime`, `sampleRate`, `destination`,
 * whichever `create` it needs — and only two of those are of any interest here.
 * Everything is handed straight through, bound to the real context, so a
 * factory cannot tell the difference.
 */
function watching(ctx: AudioContext, into: AudioScheduledSourceNode[]): AudioContext {
  return new Proxy(ctx, {
    get(target, key) {
      const value = Reflect.get(target, key, target) as unknown;

      if (typeof value !== 'function') return value;

      return (...args: unknown[]): unknown => {
        const made = (value as (...a: unknown[]) => unknown).apply(target, args);

        if (key === 'createOscillator' || key === 'createBufferSource') {
          into.push(made as AudioScheduledSourceNode);
        }

        return made;
      };
    },
  });
}

// ── Helper: auto-stop after a duration ──

/**
 * Play a sound and automatically stop it after `durationSec` seconds.
 */
export function playSoundFor(def: SoundDef, durationSec: number): SoundHandle {
  const handle = playSound(def);
  const id = setTimeout(() => handle.stop(), durationSec * 1000);
  // Wrap stop so clearing the timeout also works if stopped early
  const originalStop = handle.stop;
  handle.stop = () => {
    clearTimeout(id);
    originalStop();
  };
  return handle;
}

// ── Helper: create a white-noise AudioBuffer ──

function createNoiseBuffer(ctx: AudioContext, durationSec: number): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const length = Math.ceil(sampleRate * durationSec);
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  return buffer;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sound defs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Short rising "pickup" blip.
 */
export const pickup: SoundDef = (ctx, t) => {
  const osc = ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.setValueAtTime(20, t);
  osc.frequency.exponentialRampToValueAtTime(80, t + 0.12);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.25, t);
  gain.gain.linearRampToValueAtTime(0, t + 0.15);

  osc.connect(gain);
  osc.start(t);
  osc.stop(t + 0.15);

  return gain;
};

/**
 * Low buzz / error tone.
 */
export const error: SoundDef = (ctx, t) => {
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(20, t);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.2, t);
  gain.gain.linearRampToValueAtTime(0, t + 0.3);

  osc.connect(gain);
  osc.start(t);
  osc.stop(t + 0.3);

  return gain;
};

/**
 * Ambient low drone — runs indefinitely until stopped.
 */
export const drone: SoundDef = (ctx, t) => {
  const osc1 = ctx.createOscillator();
  osc1.type = 'sine';
  osc1.frequency.value = 55;

  const osc2 = ctx.createOscillator();
  osc2.type = 'sine';
  osc2.frequency.value = 55.5; // slight detune for beating

  const gain = ctx.createGain();
  gain.gain.value = 0.08;

  osc1.connect(gain);
  osc2.connect(gain);
  osc1.start(t);
  osc2.start(t);

  return gain;
};

// ─────────────────────────────────────────────────────────────────────────────
// Synthesised whip crack
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a whip-crack transient and connect it to `output` at time `t`.
 *
 * The whip crack is built from two layers:
 *
 *  1. **Crack** — a very short white-noise burst (~60 ms) through a bandpass
 *     filter whose centre frequency sweeps rapidly downward (8 kHz → 1.5 kHz).
 *     This gives the sharp, cutting "crack" with a sense of motion.
 *
 *  2. **Tail** — a slightly longer noise burst (~100 ms) through a lower
 *     bandpass (2 kHz → 400 Hz) at reduced volume, giving a brief airy
 *     "whoosh" tail that follows the crack.
 *
 * Both have near-instant attack and fast exponential decay.
 */
function buildWhipCrack(
  ctx: AudioContext,
  t: number,
  output: AudioNode,
  gain: number = 1.0,
): void {
  // ── Crack layer ──
  const crackLen = 0.2;
  const crackSource = ctx.createBufferSource();
  crackSource.buffer = createNoiseBuffer(ctx, crackLen + 0.01);

  const crackBP = ctx.createBiquadFilter();
  crackBP.type = 'bandpass';
  crackBP.Q.value = 1.0;
  crackBP.frequency.setValueAtTime(8000, t);
  crackBP.frequency.exponentialRampToValueAtTime(1500, t + crackLen);

  const crackGain = ctx.createGain();
  crackGain.gain.setValueAtTime(gain * 1.2, t);
  crackGain.gain.exponentialRampToValueAtTime(0.001, t + crackLen);

  crackSource.connect(crackBP);
  crackBP.connect(crackGain);
  crackGain.connect(output);

  crackSource.start(t);
  crackSource.stop(t + crackLen + 0.01);

  // ── Tail / whoosh layer ──
  const tailLen = 1.20;
  const tailSource = ctx.createBufferSource();
  tailSource.buffer = createNoiseBuffer(ctx, tailLen + 0.01);

  const tailBP = ctx.createBiquadFilter();
  tailBP.type = 'bandpass';
  tailBP.Q.value = 1.0;
  tailBP.frequency.setValueAtTime(4000, t);
  tailBP.frequency.exponentialRampToValueAtTime(400, t + tailLen);

  const tailGain = ctx.createGain();
  tailGain.gain.setValueAtTime(gain * 0.8, t);
  tailGain.gain.exponentialRampToValueAtTime(0.001, t + tailLen);

  tailSource.connect(tailBP);
  tailBP.connect(tailGain);
  tailGain.connect(output);

  tailSource.start(t);
  tailSource.stop(t + tailLen + 0.01);

  // ── Click transient — ultra-short spike for initial impact ──
  const clickLen = 0.08;
  const clickSource = ctx.createBufferSource();
  clickSource.buffer = createNoiseBuffer(ctx, clickLen + 0.005);

  const clickHP = ctx.createBiquadFilter();
  clickHP.type = 'highpass';
  clickHP.frequency.value = 1000;

  const clickGain = ctx.createGain();
  clickGain.gain.setValueAtTime(gain * 1.9, t);
  clickGain.gain.exponentialRampToValueAtTime(0.001, t + clickLen);

  clickSource.connect(clickHP);
  clickHP.connect(clickGain);
  clickGain.connect(output);

  clickSource.start(t);
  clickSource.stop(t + clickLen + 0.005);
}

// ─────────────────────────────────────────────────────────────────────────────
// Version-shift sound — escalating 5-second microtonal drone
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for the version-shift sound.
 * Every field has a sensible default so you can call `versionShift()` bare.
 */
export interface VersionShiftOptions {
  /** Base frequency in Hz.  Default ~55 Hz (randomised ±5 Hz). */
  baseFreq?: number
  /** Total duration in seconds.  Default 5. */
  duration?: number
  /** Number of layers to add (one per second after the base).  Default 4. */
  layers?: number
  /** Peak gain (before final fade-out).  Default 0.15. */
  peakGain?: number
  /**
   * Approximate 31-EDO steps to jump per layer (~15 = half octave).
   * Default 15.  Randomised ± a few steps each layer.
   */
  edoStepPerLayer?: number
  /** Random seed-ish intensity scalar (0–1).  Higher = wilder detuning.  Default 0.6. */
  chaos?: number
  /** Gain of the initial whip crack (0–1).  Default 1.0. */
  whipGain?: number
}

/**
 * Create a version-shift SoundDef.
 *
 * Each call produces a slightly different result because layer pitches,
 * waveforms, and detuning are randomised within the configured bounds.
 *
 * The sound begins with a punchy synthesised whip crack, then escalates:
 * a base drone starts immediately, and a new microtonal layer punches in
 * every second with a sharp attack.  Each layer jumps roughly half an
 * octave in 31-EDO (≈15 steps), so the pitch clearly rises with each
 * escalation.
 *
 * Pitches are chosen from 31-EDO (equal division of the octave into 31
 * steps — step ratio = 2^(1/31) ≈ 1.02263).  This gives intervals that
 * sit between familiar 12-TET notes, producing an unsettling but
 * harmonically rich texture.
 */
export function versionShift(opts: VersionShiftOptions = {}): SoundDef {
  const baseFreq = opts.baseFreq ?? 52 + Math.random() * 6; // ~52-58 Hz
  const duration = opts.duration ?? 5;
  const layers = opts.layers ?? 4;
  const peakGain = opts.peakGain ?? 0.15;
  const edoStepPerLayer = opts.edoStepPerLayer ?? 15;
  const chaos = opts.chaos ?? 0.6;
  const whipGain = opts.whipGain ?? 1.0;

  // Pre-roll the random choices for each layer so every *play* of this
  // particular SoundDef instance sounds the same, but different
  // *instances* (from separate versionShift() calls) differ.
  const layerParams: Array<{
    /** Cumulative 31-EDO step from the base frequency. */
    edoStep: number;
    detuneCents: number;
    waveform: OscillatorType;
    panValue: number;
  }> = [];

  const waveforms: OscillatorType[] = ['sine', 'triangle', 'sawtooth', 'square'];

  let cumulativeStep = 0;

  for (let i = 0; i < layers; i++) {
    // Jump roughly half an octave (±3 steps for variety)
    const jitter = Math.floor((Math.random() * 2 - 1) * 3);
    cumulativeStep += edoStepPerLayer + jitter;

    // Extra random detuning in cents (±chaos * 12 cents)
    const detuneCents = (Math.random() * 2 - 1) * chaos * 12;

    // Later layers use harsher waveforms
    const waveIdx = Math.min(
      waveforms.length - 1,
      Math.floor((i + 1) / layers * waveforms.length * (0.5 + chaos * 0.5))
    );
    const waveform = waveforms[waveIdx];

    // Stereo spread
    const panValue = (Math.random() * 2 - 1) * 0.7;

    layerParams.push({ edoStep: cumulativeStep, detuneCents, waveform, panValue });
  }

  // The actual SoundDef
  return (ctx: AudioContext, t: number): AudioNode => {
    const master = ctx.createGain();

    // Master envelope: instant on, fade out over last 0.6s
    const fadeOut = Math.min(0.6, duration * 0.15);
    master.gain.setValueAtTime(peakGain, t);
    master.gain.setValueAtTime(peakGain, t + duration - fadeOut);
    master.gain.linearRampToValueAtTime(0, t + duration);

    // ── Whip crack at the very start ──
    buildWhipCrack(ctx, t, master, whipGain);

    // ── Base layer (always present) ──
    const base1 = ctx.createOscillator();
    base1.type = 'sine';
    base1.frequency.value = baseFreq;
    base1.start(t);
    base1.stop(t + duration + 0.1);

    const base2 = ctx.createOscillator();
    base2.type = 'sine';
    base2.frequency.value = baseFreq + 0.3 + Math.random() * 0.5; // beating
    base2.start(t);
    base2.stop(t + duration + 0.1);

    const baseGain = ctx.createGain();
    baseGain.gain.value = 0.8;
    base1.connect(baseGain);
    base2.connect(baseGain);
    baseGain.connect(master);

    // ── Escalating layers — one per second ──
    for (let i = 0; i < layers; i++) {
      const lp = layerParams[i];
      const layerStart = t + (i + 1); // exactly 1 second apart

      if (layerStart >= t + duration) continue;

      // 31-EDO frequency: baseFreq * 2^(step/31)
      const freq = baseFreq * Math.pow(2, lp.edoStep / 31);

      // Main oscillator
      const osc = ctx.createOscillator();
      osc.type = lp.waveform;
      osc.frequency.value = freq;
      osc.detune.value = lp.detuneCents;
      osc.start(layerStart);
      osc.stop(t + duration + 0.1);

      // Per-layer gain: sharp attack (30ms), then sustain
      // Each layer is full volume — the escalation should be unmistakable
      const layerGain = ctx.createGain();
      const attackTime = 0.03;
      const sustainLevel = 0.7;
      // Percussive transient: brief spike then settle to sustain
      layerGain.gain.setValueAtTime(0, layerStart);
      layerGain.gain.linearRampToValueAtTime(1.0, layerStart + attackTime);
      layerGain.gain.exponentialRampToValueAtTime(sustainLevel, layerStart + 0.12);

      // Stereo panner
      const panner = ctx.createStereoPanner();
      panner.pan.value = lp.panValue;

      osc.connect(layerGain);
      layerGain.connect(panner);
      panner.connect(master);
    }

    return master;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Level-complete sound — inspired by Quake 3 megasphere pickup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for the level-complete sound.
 */
export interface LevelCompleteSoundOptions {
  /** Overall gain.  Default 0.35. */
  gain?: number
  /** Total duration in seconds.  Default 2.0. */
  duration?: number
}

/**
 * Epic, rewarding level-complete sound inspired by the Quake 3 megasphere
 * pickup.  Built from five synthesised layers:
 *
 *  1. **Sub impact** — a short sine-wave pitch drop (120 → 35 Hz) for a
 *     visceral low-end punch.
 *
 *  2. **Rising noise sweep** — filtered white noise whose bandpass centre
 *     sweeps upward (400 Hz → 6 kHz), giving the ascending "power-up"
 *     whoosh.
 *
 *  3. **Shimmer chimes** — several detuned high-frequency sine
 *     oscillators that fade in quickly and ring out, creating a bright,
 *     crystalline sparkle.
 *
 *  4. **Harmonic swell** — a mid-range triangle-wave chord (root + fifth
 *     + octave) that swells up and sustains briefly, giving body and
 *     musicality.
 *
 *  5. **Reverb tail** — a longer filtered noise burst that decays slowly,
 *     simulating the ambient tail / room response.
 *
 * The result is a ~2-second front-loaded "thwomph-shimmer-swell" that
 * feels powerful and satisfying.
 */
export function levelComplete(opts: LevelCompleteSoundOptions = {}): SoundDef {
  const masterGain = opts.gain ?? 0.35;
  const duration = opts.duration ?? 1.2;

  return (ctx: AudioContext, t: number): AudioNode => {
    const master = ctx.createGain();
    master.gain.setValueAtTime(masterGain, t);
    // Fade out over the last 30% of the duration
    const fadeStart = t + duration * 0.7;
    master.gain.setValueAtTime(masterGain, fadeStart);
    master.gain.exponentialRampToValueAtTime(0.001, t + duration);

    // ── 3. Shimmer chimes — detuned high sines ──
    {
      // Frequencies chosen to be bright and slightly inharmonic
      const chimeFreqs = [737, 520, 186, 698, 274];
      const chimeLen = Math.min(1.6, duration * 0.8);

      for (let i = 0; i < chimeFreqs.length; i++) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        // Add slight random detuning for shimmer
        osc.frequency.value = chimeFreqs[i] * (1 + (Math.random() * 2 - 1) * 0.008);

        const env = ctx.createGain();
        const attackEnd = t + 0.02 + i * 0.015;
        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(0.25, attackEnd);
        env.gain.exponentialRampToValueAtTime(0.001, t + chimeLen);

        // Spread across stereo field
        const pan = ctx.createStereoPanner();
        pan.pan.value = (i / (chimeFreqs.length - 1)) * 1.4 - 0.7;

        osc.connect(env);
        env.connect(pan);
        pan.connect(master);
        osc.start(t);
        osc.stop(t + chimeLen + 0.05);
      }
    }

    // ── 4. Harmonic swell — triangle chord (root + fifth + octave) ──
    {
      const swellStart = t + 0.05;
      const swellLen = Math.min(1.4, duration * 0.7);
      const rootFreq = 100; // A3
      const chordRatios = [1, 1.5, 2, 2.52]; // root, fifth, octave, ~minor 10th

      for (let i = 0; i < chordRatios.length; i++) {
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = rootFreq * chordRatios[i];

        const env = ctx.createGain();
        // Swell in over ~150ms, sustain, then decay
        env.gain.setValueAtTime(0, swellStart);
        env.gain.linearRampToValueAtTime(0.35, swellStart + 0.15);
        env.gain.setValueAtTime(0.35, swellStart + swellLen * 0.4);
        env.gain.exponentialRampToValueAtTime(0.001, swellStart + swellLen);

        const pan = ctx.createStereoPanner();
        pan.pan.value = (Math.random() * 2 - 1) * 0.3;

        osc.connect(env);
        env.connect(pan);
        pan.connect(master);
        osc.start(swellStart);
        osc.stop(swellStart + swellLen + 0.05);
      }
    }

    return master;
  };
}
