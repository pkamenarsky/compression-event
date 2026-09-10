// -----------------------------------------------------------------------------
// The bake, as a string in a file
//
// A `BakedLevel` is mostly typed arrays of floats, and a level file is JSON. The
// obvious spelling — arrays of numbers — is about eighteen characters a float
// and does not compress well, so this writes the bake as bytes instead, packs
// them and puts the result in the file as one base64 string.
//
// Lossless, and deliberately so: the shader is held against the editor's own
// reading of a span point for point, and a quantised copy would be a third
// thing that has to agree with both.
//
// What makes it small
// -------------------
// Deflate finds repeats, and the bytes are arranged so that there are more of
// them to find. Two tools, used where each was measured to earn something —
// see `FILTERS`:
//
// - **Filters** turn values that repeat *between* arrays or columns into
//   noughts: most of a level is still in most spans, so a point's far end is
//   its near end, and xor'd together the two are nothing.
// - **The shuffle** splits values into byte planes — every value's first byte,
//   then every value's second — so that the high bytes, which repeat, are not
//   interleaved with the low ones, which are noise. It is what blosc and HDF5
//   do, and it wins on anything that climbs or is laid out in rows.
//
// The structure — tracks, stretches, runs — is small beside the arrays and is
// written as a stream of integers and a stream of doubles, shuffled the same
// way. A run's start is written as its distance from where the one before it
// ended, which is nearly always nought: runs are laid end to end.
//
// The format carries a number, the way the level file does, and a string that
// does not match is refused rather than guessed at.
// -----------------------------------------------------------------------------

import { BakedLevel, BakedSpan, BakedStretch, BakedTrack, ENTRY_STRIDE } from './baked';

/** The version of the byte layout, first in every packed bake. */
export const PACKED = 1;

// -----------------------------------------------------------------------------
// Bytes
// -----------------------------------------------------------------------------

/** What a span's arrays and the structure around them are written into, kept
 * apart by kind so that each shuffle only ever sees values of one sort. */
class Writer {
  ints: number[] = [];
  doubles: number[] = [];
  /** Every typed array, filtered, in the order they are read
   * back — and how many elements each one had. */
  arrays: Uint8Array[] = [];
  lengths: number[] = [];
}

/** A value's bytes spread into planes: every element's byte 0, then every
 * element's byte 1, and so on. */
function shuffled(bytes: Uint8Array, width: number): Uint8Array {
  const n = bytes.length / width;
  const out = new Uint8Array(bytes.length);

  for (let i = 0; i < n; i++) {
    for (let b = 0; b < width; b++) out[b * n + i] = bytes[i * width + b];
  }

  return out;
}

function unshuffled(planes: Uint8Array, width: number): Uint8Array {
  const n = planes.length / width;
  const out = new Uint8Array(planes.length);

  for (let i = 0; i < n; i++) {
    for (let b = 0; b < width; b++) out[i * width + b] = planes[b * n + i];
  }

  return out;
}

function bytesOf(a: ArrayBufferView): Uint8Array {
  return new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
}

// -----------------------------------------------------------------------------
// Filters
//
// The shuffle finds what repeats within a value's bytes. What repeats between
// values it cannot see, and a bake is full of it: most of a level is not moving
// in most spans, so a point's far end is its near end; a table row is a handful of different kinds of number side by side;
// and a run of points all ride the same slot. So each array is filtered first,
// on its bits taken as integers — which is exact whatever the floats hold — and
// only then, where it earns anything, shuffled:
//
// - **against** another array: xor'd with it, so that where the two agree the
//   result is nought. `pointsB` against `pointsA`, `opacityB` against
//   `opacityA`.
// - **pairs** within a row: the same, one column against another — an entry's
//   far end against its near one.
// - **stride**: the rows turned into columns, so that like sits with like.
// - **delta**: each value less the one before it, so that a run of one value
//   is a run of noughts and a count that climbs by one is a run of ones.
// -----------------------------------------------------------------------------

interface Filter {
  /** 1 for `kinds`, which is bytes and is left alone; 4 for the rest. */
  width: 1 | 4
  stride?: number
  pairs?: [number, number][]
  /** Which earlier array of the span this one is xor'd with. */
  against?: number
  delta?: boolean
  /** Whether the result goes to deflate in byte planes. */
  shuffle?: boolean
}

/**
 * One per array of a span, in the order `wroteSpan` writes them.
 *
 * Chosen by measuring rather than by argument, over the biggest levels on the
 * scratch pile, and the measurements did not all go the way the argument did.
 * The points in particular are left alone: a static room's corners recur
 * exactly from one stretch to the next, and deflate finds a whole repeated
 * pair more readily than it finds four repeated planes. Shuffling them cost a
 * third again. The table rows are the opposite, and so are the crossings, which
 * are indices that climb. Together the bytes deflate to about half of what the
 * same bake written as JSON deflates to, and three quarters of what the bytes
 * deflate to unfiltered.
 */
const FILTERS: Filter[] = [
  /* frames */ { width: 4 },
  /* entries */ { width: 4, stride: ENTRY_STRIDE, pairs: [[2, 0], [3, 1]], shuffle: true },
  /* pointsA */ { width: 4 },
  /* pointsB */ { width: 4, against: 2 },
  /* slots */ { width: 4, delta: true, shuffle: true },
  /* kinds */ { width: 1 },
  /* opacityA */ { width: 4 },
  /* opacityB */ { width: 4, against: 6 },
  /* crossings */ { width: 4, delta: true, shuffle: true },
  /* artefacts */ { width: 4, delta: true, shuffle: true },
];

function words(a: Float32Array | Int32Array): Uint32Array {
  return new Uint32Array(a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength));
}

/** Rows of `stride` turned into columns, or back. */
function transposed(u: Uint32Array, stride: number, back: boolean): Uint32Array {
  const rows = u.length / stride;
  const out = new Uint32Array(u.length);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < stride; c++) {
      if (back) out[r * stride + c] = u[c * rows + r];
      else out[c * rows + r] = u[r * stride + c];
    }
  }

  return out;
}

/** An array's words, filtered; `before` is the span's arrays so far, as they
 * were before any filtering. */
function filtered(u: Uint32Array, f: Filter, before: Uint32Array[]): Uint32Array {
  let out: Uint32Array = u.slice();

  if (f.pairs !== undefined && f.stride !== undefined) {
    for (let r = 0; r < out.length; r += f.stride) {
      for (const [c, of] of f.pairs) out[r + c] ^= u[r + of];
    }
  }

  if (f.against !== undefined) {
    const a = before[f.against];
    for (let i = 0; i < out.length; i++) out[i] ^= a[i];
  }

  if (f.stride !== undefined) out = transposed(out, f.stride, false);

  if (f.delta === true) {
    for (let i = out.length - 1; i > 0; i--) out[i] -= out[i - 1];
  }

  return out;
}

/** The other direction, each step undone in the reverse order. */
function unfiltered(u: Uint32Array, f: Filter, before: Uint32Array[]): Uint32Array {
  let out: Uint32Array = u.slice();

  if (f.delta === true) {
    for (let i = 1; i < out.length; i++) out[i] += out[i - 1];
  }

  if (f.stride !== undefined) out = transposed(out, f.stride, true);

  if (f.against !== undefined) {
    const a = before[f.against];
    for (let i = 0; i < out.length; i++) out[i] ^= a[i];
  }

  // Each pair's other column is never itself paired, so it is already back.
  if (f.pairs !== undefined && f.stride !== undefined) {
    for (let r = 0; r < out.length; r += f.stride) {
      for (const [c, of] of f.pairs) out[r + c] ^= out[r + of];
    }
  }

  return out;
}

// -----------------------------------------------------------------------------
// Writing
// -----------------------------------------------------------------------------

function wroteStretch(w: Writer, s: BakedStretch): void {
  w.doubles.push(s.t0, s.t1);
  w.ints.push(s.runs.length);

  let end = 0;

  for (const run of s.runs) {
    w.ints.push(run.first - end, run.count);
    end = run.first + run.count;
  }
}

function wroteTrack(w: Writer, track: BakedTrack): void {
  w.ints.push((track.fill ? 1 : 0) | (track.hole ? 2 : 0), track.stretches.length, track.jumps.length);

  for (const s of track.stretches) wroteStretch(w, s);
  for (const s of track.jumps) wroteStretch(w, s);
}

function wroteSpan(w: Writer, span: BakedSpan): void {
  w.ints.push(span.from, span.depth, span.tracks.length);

  const arrays = [
    span.frames, span.entries,
    span.pointsA, span.pointsB,
    span.slots, span.kinds,
    span.opacityA, span.opacityB,
    span.crossings, span.artefacts,
  ];

  const before: Uint32Array[] = [];

  arrays.forEach((a, i) => {
    const f = FILTERS[i];

    w.lengths.push(a.length);

    if (a instanceof Uint8Array) {
      before.push(new Uint32Array(0));
      w.arrays.push(a.slice());
      return;
    }

    const u = words(a);

    before.push(u);
    const out = bytesOf(filtered(u, f, before));

    w.arrays.push(f.shuffle === true ? shuffled(out, 4) : out);
  });

  for (const track of span.tracks) wroteTrack(w, track);
}

/**
 * The bake as one run of bytes, uncompressed.
 *
 *   header   u32 format, u32 spans, u32 ints, u32 doubles, u32 arrays
 *   lengths  u32 per array, in elements
 *   ints     i32 each, shuffled
 *   doubles  f64 each, shuffled
 *   arrays   each one filtered and shuffled, back to back
 *
 * Every array's element type and filter are fixed by where it comes in a span —
 * see `FILTERS` — so none of them has to say what it is.
 */
export function encoded(level: BakedLevel): Uint8Array {
  const w = new Writer();

  for (const span of level.spans) wroteSpan(w, span);

  const head = new Uint32Array([PACKED, level.spans.length, w.ints.length, w.doubles.length, w.arrays.length]);
  const lengths = new Uint32Array(w.lengths);

  const parts = [
    bytesOf(head),
    bytesOf(lengths),
    shuffled(bytesOf(Int32Array.from(w.ints)), 4),
    shuffled(bytesOf(Float64Array.from(w.doubles)), 8),
    ...w.arrays,
  ];

  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;

  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }

  return out;
}

// -----------------------------------------------------------------------------
// Reading
// -----------------------------------------------------------------------------

/** Where in each stream the next value is. */
class Reader {
  i = 0;
  d = 0;
  a = 0;

  constructor(
    readonly ints: Int32Array,
    readonly doubles: Float64Array,
    readonly arrays: Uint8Array[],
  ) {}

  int(): number {
    return this.ints[this.i++];
  }

  double(): number {
    return this.doubles[this.d++];
  }

  /** The span's arrays read so far, as words and unfiltered, for the ones
   * filtered against them. */
  before: Uint32Array[] = [];

  /** The next array's words, which the caller knows the type of. */
  words(): Uint32Array {
    const i = this.before.length;
    const f = FILTERS[i];
    const bytes = this.arrays[this.a++];
    const u = unfiltered(new Uint32Array((f.shuffle === true ? unshuffled(bytes, 4) : bytes.slice()).buffer), f, this.before);

    this.before.push(u);

    return u;
  }

  f32(): Float32Array {
    return new Float32Array(this.words().buffer);
  }

  i32(): Int32Array {
    return new Int32Array(this.words().buffer);
  }

  u8(): Uint8Array {
    this.before.push(new Uint32Array(0));

    return this.arrays[this.a++].slice();
  }
}

function readStretch(r: Reader): BakedStretch {
  const t0 = r.double(), t1 = r.double();
  const n = r.int();
  const runs = [];

  let end = 0;

  for (let i = 0; i < n; i++) {
    const first = end + r.int();
    const count = r.int();

    runs.push({ first, count });
    end = first + count;
  }

  return { t0, t1, runs };
}

function readTrack(r: Reader): BakedTrack {
  const flags = r.int();
  const stretches = r.int(), jumps = r.int();

  return {
    fill: (flags & 1) !== 0,
    hole: (flags & 2) !== 0,
    stretches: Array.from({ length: stretches }, () => readStretch(r)),
    jumps: Array.from({ length: jumps }, () => readStretch(r)),
  };
}

function readSpan(r: Reader): BakedSpan {
  const from = r.int(), depth = r.int(), tracks = r.int();

  r.before = [];

  // In the order `wroteSpan` pushed them.
  const frames = r.f32(), entries = r.f32();
  const pointsA = r.f32(), pointsB = r.f32();
  const slots = r.i32(), kinds = r.u8();
  const opacityA = r.f32(), opacityB = r.f32();
  const crossings = r.i32(), artefacts = r.i32();

  return {
    from, depth, frames, entries, pointsA, pointsB, slots, kinds, opacityA, opacityB, crossings, artefacts,
    tracks: Array.from({ length: tracks }, () => readTrack(r)),
  };
}

/** The other direction. Throws on a layout this does not write. */
export function decoded(bytes: Uint8Array): BakedLevel {
  // Copied so that every view below starts on an aligned offset.
  const buf = bytes.slice().buffer;
  const head = new Uint32Array(buf, 0, 5);

  const [format, spans, ints, doubles, arrays] = head;

  if (format !== PACKED) throw new Error(`baked data is layout ${format}, and this reads ${PACKED}`);

  const lengths = new Uint32Array(buf, 20, arrays);
  let at = 20 + arrays * 4;

  const take = (n: number): Uint8Array => {
    const out = new Uint8Array(buf, at, n);
    at += n;
    return out;
  };

  const intStream = new Int32Array(unshuffled(take(ints * 4), 4).buffer);
  const doubleStream = new Float64Array(unshuffled(take(doubles * 8), 8).buffer);

  const planes = [...lengths].map((n, i) => take(n * FILTERS[i % FILTERS.length].width));

  const r = new Reader(intStream, doubleStream, planes);

  return { spans: Array.from({ length: spans }, () => readSpan(r)) };
}

// -----------------------------------------------------------------------------
// Into the file
// -----------------------------------------------------------------------------

async function streamed(bytes: Uint8Array, through: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(through);

  return new Uint8Array(await new Response(out).arrayBuffer());
}

function base64(bytes: Uint8Array): string {
  let s = '';

  // In pieces: spreading a whole bake into one call overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }

  return btoa(s);
}

function unbase64(s: string): Uint8Array {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);

  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);

  return out;
}

/** The bake as the level file carries it: shuffled, deflated, base64. */
export async function packed(level: BakedLevel): Promise<string> {
  return base64(await streamed(encoded(level), new CompressionStream('deflate-raw')));
}

export async function unpacked(s: string): Promise<BakedLevel> {
  return decoded(await streamed(unbase64(s), new DecompressionStream('deflate-raw')));
}
