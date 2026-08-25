// -----------------------------------------------------------------------------
// An immutable bounding-volume tree
//
// A persistent binary tree of axis-aligned boxes: leaves hold ids, branches
// hold the box enclosing their two children. Insertion picks the sibling that
// grows the tree's total surface area least, and every write copies only the
// path it walked — the rest of the tree is shared with the version it came
// from, so holding on to an old tree costs nothing but the nodes that changed.
//
// Queries are the point of it: everything overlapping a box, without touching
// the parts of the plane the box is nowhere near.
//
// Ids are the caller's. The tree does not check for duplicates, and removal
// wants the box the id went in with — that is what lets it descend to the leaf
// instead of scanning.
// -----------------------------------------------------------------------------

import { Point } from '@ce/game/world';

export interface AABB {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

// -----------------------------------------------------------------------------
// Boxes
// -----------------------------------------------------------------------------

export function box(minX: number, minY: number, maxX: number, maxY: number): AABB {
  return { minX, minY, maxX, maxY };
}

export function ofPoints(points: readonly Point[]): AABB {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  return { minX, minY, maxX, maxY };
}

export function ofRings(rings: readonly (readonly Point[])[]): AABB {
  return rings.reduce((b, r) => merge(b, ofPoints(r)), empty());
}

/** The box that contains nothing — merging into it is the identity. */
export function empty(): AABB {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

export function isEmpty(a: AABB): boolean {
  return a.maxX < a.minX || a.maxY < a.minY;
}

export function merge(a: AABB, b: AABB): AABB {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/** Touching counts as overlapping: two polygons that share an edge share a
 * boundary, and the CSG that follows has to see them together. */
export function overlaps(a: AABB, b: AABB): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

export function containsBox(a: AABB, b: AABB): boolean {
  return a.minX <= b.minX && a.minY <= b.minY && a.maxX >= b.maxX && a.maxY >= b.maxY;
}

export function containsPoint(a: AABB, p: Point): boolean {
  return p.x >= a.minX && p.x <= a.maxX && p.y >= a.minY && p.y <= a.maxY;
}

export function expand(a: AABB, m: number): AABB {
  return { minX: a.minX - m, minY: a.minY - m, maxX: a.maxX + m, maxY: a.maxY + m };
}

export function equals(a: AABB, b: AABB): boolean {
  return a.minX === b.minX && a.minY === b.minY && a.maxX === b.maxX && a.maxY === b.maxY;
}

/** The cost a box contributes to the tree. In two dimensions the surface-area
 * heuristic is a perimeter heuristic. */
export function perimeter(a: AABB): number {
  if (isEmpty(a)) return 0;

  return 2 * (a.maxX - a.minX + a.maxY - a.minY);
}

// -----------------------------------------------------------------------------
// The tree
// -----------------------------------------------------------------------------

export interface Leaf {
  tag: 'leaf'
  box: AABB
  id: number
}

export interface Branch {
  tag: 'branch'
  box: AABB
  height: number
  count: number
  left: Node
  right: Node
}

export type Node = Leaf | Branch;

/** An empty tree is no tree at all. */
export type Tree = Node | null;

export const emptyTree: Tree = null;

export function size(tree: Tree): number {
  return tree === null ? 0 : tree.tag === 'leaf' ? 1 : tree.count;
}

export function depth(tree: Tree): number {
  return tree === null ? -1 : height(tree);
}

export function bounds(tree: Tree): AABB {
  return tree === null ? empty() : tree.box;
}

function height(n: Node): number {
  return n.tag === 'leaf' ? 0 : n.height;
}

function join(a: Node, b: Node): Branch {
  return {
    tag: 'branch',
    box: merge(a.box, b.box),
    height: 1 + Math.max(height(a), height(b)),
    count: size(a) + size(b),
    left: a,
    right: b,
  };
}

// -----------------------------------------------------------------------------
// Insertion
// -----------------------------------------------------------------------------

export function insert(tree: Tree, id: number, b: AABB): Tree {
  const leaf: Leaf = { tag: 'leaf', box: b, id };

  return tree === null ? leaf : into(tree, leaf);
}

/**
 * Down to the cheapest sibling, then back up rebuilding the path. The choice
 * at each branch weighs making the new leaf a sibling here against carrying it
 * further down, paying for the growth every ancestor would inherit.
 */
function into(node: Node, leaf: Leaf): Node {
  if (node.tag === 'leaf') return join(node, leaf);

  const combined = perimeter(merge(node.box, leaf.box));
  const inherited = combined - perimeter(node.box);

  const left = descent(node.left, leaf, inherited);
  const right = descent(node.right, leaf, inherited);

  if (combined <= left && combined <= right) return join(node, leaf);

  if (left <= right) {
    return balance(join(into(node.left, leaf), node.right));
  }
  else {
    return balance(join(node.left, into(node.right, leaf)));
  }
}

function descent(child: Node, leaf: Leaf, inherited: number): number {
  const grown = perimeter(merge(child.box, leaf.box));

  return (child.tag === 'leaf' ? grown : grown - perimeter(child.box)) + inherited;
}

/**
 * One rotation is enough to keep the tree shallow. Nothing here is ordered, so
 * the taller grandchild simply moves up and the shorter one goes down with the
 * sibling — no second case to handle.
 */
function balance(n: Branch): Node {
  const diff = height(n.left) - height(n.right);

  if (diff > 1) {
    const l = n.left as Branch;
    const [up, down] = height(l.left) >= height(l.right) ? [l.left, l.right] : [l.right, l.left];

    return join(up, join(down, n.right));
  }

  if (diff < -1) {
    const r = n.right as Branch;
    const [up, down] = height(r.left) >= height(r.right) ? [r.left, r.right] : [r.right, r.left];

    return join(join(n.left, down), up);
  }

  return n;
}

// -----------------------------------------------------------------------------
// Removal
// -----------------------------------------------------------------------------

/**
 * The id is looked for inside `b`, so pass the box it was inserted with. A tree
 * that does not hold the id comes back unchanged, identity and all.
 */
export function remove(tree: Tree, id: number, b: AABB): Tree {
  if (tree === null) return null;

  const r = without(tree, id, b);

  return r === undefined ? tree : r;
}

/** `undefined` means the id was not down here; `null` means it was, and took
 * the whole subtree with it. */
function without(node: Node, id: number, b: AABB): Node | null | undefined {
  if (!overlaps(node.box, b)) return undefined;
  if (node.tag === 'leaf') return node.id === id ? null : undefined;

  const l = without(node.left, id, b);
  if (l !== undefined) return l === null ? node.right : balance(join(l, node.right));

  const r = without(node.right, id, b);
  if (r !== undefined) return r === null ? node.left : balance(join(node.left, r));

  return undefined;
}

export function update(tree: Tree, id: number, from: AABB, to: AABB): Tree {
  return insert(remove(tree, id, from), id, to);
}

// -----------------------------------------------------------------------------
// Queries
// -----------------------------------------------------------------------------

/** Every id whose box overlaps `b`, in no particular order. */
export function search(tree: Tree, b: AABB): number[] {
  const out: number[] = [];
  each(tree, b, id => out.push(id));

  return out;
}

export function each(tree: Tree, b: AABB, fn: (id: number) => void): void {
  if (tree === null || !overlaps(tree.box, b)) return;

  if (tree.tag === 'leaf') {
    fn(tree.id);

    return;
  }

  each(tree.left, b, fn);
  each(tree.right, b, fn);
}

export function searchPoint(tree: Tree, p: Point): number[] {
  return search(tree, { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y });
}

export function ids(tree: Tree): number[] {
  return search(tree, { minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity });
}

export function has(tree: Tree, id: number, b: AABB): boolean {
  let found = false;
  each(tree, b, i => { found = found || i === id; });

  return found;
}

// -----------------------------------------------------------------------------
// Bulk construction
// -----------------------------------------------------------------------------

/**
 * A tree over everything at once. Splitting each run of boxes at the median of
 * its longer axis beats inserting one by one, both in shape and in the time it
 * takes to get there, so this is what a rebuild should use.
 */
export function build(items: readonly { id: number, box: AABB }[]): Tree {
  if (items.length === 0) return null;

  return split(items.slice());
}

function split(items: { id: number, box: AABB }[]): Node {
  if (items.length === 1) return { tag: 'leaf', box: items[0].box, id: items[0].id };

  const centres = items.map(i => ({
    item: i,
    x: (i.box.minX + i.box.maxX) / 2,
    y: (i.box.minY + i.box.maxY) / 2,
  }));

  // Walked rather than spread into `Math.max`. A build is handed one box per
  // segment of an arrangement, and a level of ten thousand polygons is eighty
  // thousand of them — the same order as the argument count an engine will
  // take before a spread overflows the stack, which it does by throwing rather
  // than by slowing down.
  let loX = Infinity, hiX = -Infinity, loY = Infinity, hiY = -Infinity;

  for (const c of centres) {
    if (c.x < loX) loX = c.x;
    if (c.x > hiX) hiX = c.x;
    if (c.y < loY) loY = c.y;
    if (c.y > hiY) hiY = c.y;
  }

  const wide = hiX - loX >= hiY - loY;

  centres.sort((a, b) => (wide ? a.x - b.x : a.y - b.y));

  const half = centres.length >> 1;

  return join(
    split(centres.slice(0, half).map(c => c.item)),
    split(centres.slice(half).map(c => c.item)),
  );
}
