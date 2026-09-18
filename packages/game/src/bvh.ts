// -----------------------------------------------------------------------------
// A flat bounding-volume tree
//
// The editor's `aabb.ts` keeps a persistent tree, which is what an editor wants
// of the set it keeps and edits. This one is the other kind: a tree over every
// item of one arrangement, made, asked a few thousand questions and kept as
// long as the arrangement is. The bake builds several per combine and runs
// combines by the thousand, and collision builds two per version at load and
// asks them on every move — so making it and walking it both have to be cheap,
// and most of what made the persistent one expensive was objects, allocated per
// node and per query box.
//
// So this one is flat. Nodes are laid out depth first in typed arrays: a
// branch's first child is the next node, and every node knows where its subtree
// ends, so a query is a loop down the array skipping whatever misses, with no
// stack and no recursion. Leaves hold a few items rather than one, which halves
// the nodes and tests the boxes that would have been their leaves in a row.
//
// Ids are positions in the array it was built from, since that is what every
// caller was handing in anyway.
//
// It is here rather than beside the persistent tree because the game reads it
// and the game does not read the editor. Nothing in it needs a `Point` or an
// `AABB`: it is four numbers an item, in and out.
// -----------------------------------------------------------------------------

export interface Packed {
  /** Per node, `minX, minY, maxX, maxY`. */
  nodes: Float64Array
  /** Per node, the index just past its subtree. */
  skip: Int32Array
  /** Per node, where its items start in `ids`, or `-1` for a branch. */
  start: Int32Array
  count: Int32Array
  /** Items in leaf order, and their boxes alongside, four numbers apiece. */
  ids: Int32Array
  boxes: Float64Array
}

/** Items per leaf, at most. */
const LEAF = 16;

/**
 * A tree over `boxes`, four numbers an item, where item `i` is the `i`th four.
 * The array is read and not kept.
 */
export function pack(boxes: Float64Array): Packed {
  const n = boxes.length >> 2;
  const order = new Int32Array(n);
  const xs = new Float64Array(n), ys = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    order[i] = i;
    xs[i] = (boxes[i * 4] + boxes[i * 4 + 2]) / 2;
    ys[i] = (boxes[i * 4 + 1] + boxes[i * 4 + 3]) / 2;
  }

  // A tree of `n` items split down the middle has fewer than `n` nodes once the
  // leaves hold two or more, and never more than `2n` however it falls.
  const cap = Math.max(1, 2 * n);
  const nodes = new Float64Array(cap * 4);
  const skip = new Int32Array(cap);
  const start = new Int32Array(cap);
  const count = new Int32Array(cap);
  let used = 0;

  const make = (lo: number, hi: number): void => {
    const at = used++;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let loX = Infinity, hiX = -Infinity, loY = Infinity, hiY = -Infinity;

    for (let k = lo; k < hi; k++) {
      const i = order[k], b = i * 4;

      if (boxes[b] < minX) minX = boxes[b];
      if (boxes[b + 1] < minY) minY = boxes[b + 1];
      if (boxes[b + 2] > maxX) maxX = boxes[b + 2];
      if (boxes[b + 3] > maxY) maxY = boxes[b + 3];

      if (xs[i] < loX) loX = xs[i];
      if (xs[i] > hiX) hiX = xs[i];
      if (ys[i] < loY) loY = ys[i];
      if (ys[i] > hiY) hiY = ys[i];
    }

    nodes[at * 4] = minX;
    nodes[at * 4 + 1] = minY;
    nodes[at * 4 + 2] = maxX;
    nodes[at * 4 + 3] = maxY;

    if (hi - lo <= LEAF) {
      start[at] = lo;
      count[at] = hi - lo;
    }
    else {
      const mid = lo + ((hi - lo) >> 1);

      select(order, hiX - loX >= hiY - loY ? xs : ys, lo, hi, mid);

      start[at] = -1;
      make(lo, mid);
      make(mid, hi);
    }

    skip[at] = used;
  };

  if (n > 0) make(0, n);

  const out = new Float64Array(n * 4);

  for (let k = 0; k < n; k++) {
    const b = order[k] * 4;

    out[k * 4] = boxes[b];
    out[k * 4 + 1] = boxes[b + 1];
    out[k * 4 + 2] = boxes[b + 2];
    out[k * 4 + 3] = boxes[b + 3];
  }

  return { nodes, skip, start, count, ids: order, boxes: out };
}

/**
 * Rearranges `order[lo, hi)` so that the item at `k` is the one a sort by `key`
 * would put there, everything before it no greater and everything after no
 * less. The median is all a split needs, and this finds it in linear time.
 */
function select(order: Int32Array, key: Float64Array, lo: number, hi: number, k: number): void {
  let l = lo, r = hi - 1;

  while (r > l) {
    const pivot = key[order[(l + r) >> 1]];
    let i = l, j = r;

    while (i <= j) {
      while (key[order[i]] < pivot) i++;
      while (key[order[j]] > pivot) j--;

      if (i <= j) {
        const t = order[i];
        order[i] = order[j];
        order[j] = t;
        i++;
        j--;
      }
    }

    if (k <= j) {
      r = j;
    }
    else if (k >= i) {
      l = i;
    }
    else {
      break;
    }
  }
}

/**
 * Every id whose box overlaps the one given, touching included, in no order a
 * caller should rely on. The box is four numbers rather than an `AABB` so that
 * a query in a hot loop allocates nothing.
 */
export function eachPacked(
  t: Packed,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  fn: (id: number) => void,
): void {
  const { nodes, skip, start, count, ids, boxes } = t;
  const end = skip.length === 0 || ids.length === 0 ? 0 : skip[0];
  let i = 0;

  while (i < end) {
    const b = i * 4;

    if (nodes[b] > maxX || nodes[b + 2] < minX || nodes[b + 1] > maxY || nodes[b + 3] < minY) {
      i = skip[i];
      continue;
    }

    const s = start[i];

    if (s >= 0) {
      for (let k = s, e = s + count[i]; k < e; k++) {
        const c = k * 4;

        if (boxes[c] <= maxX && boxes[c + 2] >= minX && boxes[c + 1] <= maxY && boxes[c + 3] >= minY) {
          fn(ids[k]);
        }
      }
    }

    i++;
  }
}

/**
 * Whether anything whose box overlaps the one given answers `true`, stopping at
 * the first that does.
 *
 * `eachPacked` walks the whole query however early the answer was settled,
 * which is right when the caller wants every candidate and wrong when it wants
 * to know whether there is one. Collision asks the second question of every
 * point it is handed: inside a wall is inside a wall, and which wall is not the
 * question.
 */
export function somePacked(
  t: Packed,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  fn: (id: number) => boolean,
): boolean {
  const { nodes, skip, start, count, ids, boxes } = t;
  const end = skip.length === 0 || ids.length === 0 ? 0 : skip[0];
  let i = 0;

  while (i < end) {
    const b = i * 4;

    if (nodes[b] > maxX || nodes[b + 2] < minX || nodes[b + 1] > maxY || nodes[b + 3] < minY) {
      i = skip[i];
      continue;
    }

    const s = start[i];

    if (s >= 0) {
      for (let k = s, e = s + count[i]; k < e; k++) {
        const c = k * 4;

        if (boxes[c] <= maxX && boxes[c + 2] >= minX && boxes[c + 1] <= maxY && boxes[c + 3] >= minY) {
          if (fn(ids[k])) return true;
        }
      }
    }

    i++;
  }

  return false;
}
