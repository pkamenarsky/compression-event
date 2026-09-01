// -----------------------------------------------------------------------------
// A sound that runs out lets go of itself
//
// `playSound` keeps every handle it hands out, so that `stopAll` can reach
// them, and a handle that is never taken back out is a page that leaks one gain
// node per sound it ever played. Most sounds are never stopped by anybody: they
// schedule their own end and are over.
//
// So the sources are watched and the handle releases itself when the last of
// them ends. There is no Web Audio here to watch it happen, which is exactly
// why this is worth writing down: a context that counts what was asked of it is
// enough to hold the bookkeeping to account, and the bookkeeping is the part
// that leaked.
// -----------------------------------------------------------------------------

import { beforeEach, describe, expect, test } from 'vitest';
import { SoundDef, playSound } from './sound';

/** A source that goes nowhere and can be told it is over. */
class FakeSource extends EventTarget {
  started = false;

  connect(): void {}
  start(): void {
    this.started = true;
  }
  stop(): void {}

  /** What the browser does when a scheduled end arrives. */
  end(): void {
    this.dispatchEvent(new Event('ended'));
  }
}

class FakeGain {
  disconnects = 0;
  gain = {
    value: 1,
    setValueAtTime(): void {},
    linearRampToValueAtTime(): void {},
  };

  connect(): void {}
  disconnect(): void {
    this.disconnects++;
  }
}

class FakeContext {
  currentTime = 0;
  sampleRate = 48000;
  state = 'running';
  destination = {};

  /** Every one handed out, in the order they were asked for. The master gain
   * `playSound` puts on the end is the last of them. */
  gains: FakeGain[] = [];
  sources: FakeSource[] = [];

  createGain(): FakeGain {
    const g = new FakeGain();

    this.gains.push(g);

    return g;
  }

  createOscillator(): FakeSource {
    const s = new FakeSource();

    this.sources.push(s);

    return s;
  }

  createBufferSource(): FakeSource {
    return this.createOscillator();
  }

  resume(): void {}
}

// One for the file, because `playSound` builds its context on first use and
// keeps it: a fresh one per test would never be reached. What is per test is
// what it has been asked for.
const ctx = new FakeContext();

(globalThis as unknown as { AudioContext: unknown }).AudioContext =
  function AudioContext(this: unknown) {
    return ctx;
  };

beforeEach(() => {
  ctx.gains = [];
  ctx.sources = [];
});

/** Two oscillators, both given an end: the shape of nearly every sound here. */
const twice: SoundDef = (c, t) => {
  const one = c.createOscillator();
  const two = c.createOscillator();
  const gain = c.createGain();

  one.connect(gain);
  two.connect(gain);
  one.start(t);
  one.stop(t + 0.1);
  two.start(t);
  two.stop(t + 0.2);

  return gain;
};

describe('a sound that ends on its own', () => {
  const master = (): FakeGain => ctx.gains[ctx.gains.length - 1];

  test('lets go once every source it started has ended', () => {
    playSound(twice);

    expect(ctx.sources.length).toBe(2);
    expect(master().disconnects).toBe(0);

    // The first of the two is not the sound being over. A blip that let go
    // here would take its own tail with it.
    ctx.sources[0].end();
    expect(master().disconnects).toBe(0);

    ctx.sources[1].end();
    expect(master().disconnects).toBe(1);
  });

  test('and stopping it afterwards is nothing, not a second release', () => {
    const handle = playSound(twice);

    for (const s of ctx.sources) s.end();
    expect(master().disconnects).toBe(1);

    handle.stop();
    expect(master().disconnects).toBe(1);
  });

  test('a source with no end waits to be stopped, which is the drone', () => {
    const endless: SoundDef = (c, t) => {
      const osc = c.createOscillator();
      const gain = c.createGain();

      osc.connect(gain);
      osc.start(t);

      return gain;
    };

    playSound(endless);

    // Nothing has ended, so nothing is let go. `stop` is the only way out of
    // this one, and it is the caller who holds it.
    expect(master().disconnects).toBe(0);
  });

  test('the factory is handed a context it cannot tell from the real one', () => {
    let seen: { time: number, rate: number } | null = null;

    playSound((c, t) => {
      seen = { time: t, rate: c.sampleRate };

      return c.createGain();
    });

    expect(seen).toEqual({ time: 0, rate: 48000 });
  });
});
