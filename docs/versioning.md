# Versioned world geometry

## The problem

A world is a sequence of versions. Later versions are more shrunk than earlier
ones, and the game walks the sequence forward on a countdown — and backward,
when the player picks up an artefact that reverses it.

Shrinking is not algorithmic. An erode transform exists, but authoring is
artistic: sometimes a polygon erodes, sometimes it moves, sometimes it vanishes,
sometimes a new one appears. So a later version is *derived* from the earlier
one without being *computed* from it.

If versions are copies, an edit to an early version has to be replayed by hand
into every later one. That is the thing this design exists to prevent.

## Principles

**Later versions are edits, not copies.** Version *N* stores what changed
relative to its base, and resolves against it on demand.

**You edit the version you are standing in, and edits flow forward.** That is
the entire propagation model. There is no way to author an edit that lands in an
earlier version than the one on screen — if something is wrong in v0, go to v0
and fix it, and watch the consequences downstream with ghosts.

**Everything a delta names has a stable identity.** Polygons, groups and
vertices are identified by id, never by index. An edit keyed by array index
silently re-points at the wrong thing the moment something upstream is inserted.

**The runtime stays dumb.** `packages/game/src/world.ts` keeps a flat per-version
polygon list. Ids, layers, forks and history are all erased by the bake.

**A newcomer has to be able to learn it.** This is a level editor for people
without level-editing experience. Where a choice is between power and
legibility, legibility wins. That is why there is no merge, no cherry-pick, no
backward propagation, and no per-edit approval dialog.

## The model

### Identities

```ts
type PolygonId = number
type GroupId = number
type VertexId = number
type VersionId = number
```

All come from one monotonic counter on `World`, so an id is unique across the
document and can never be confused for another kind.

`Polygon.points` is a flat, ordered `VertexId[]` — ordered because winding
matters. Two vertices resolving to the same position are still distinct ids;
coincidence is emergent, never declared by the structure.

### Lifetime

Every polygon, group, vertex and artefact has a **birth version**: the version
whose layer introduced it. Nothing may reference it before that. A tombstone
hides it from a given version onward.

Removing an entity at version *V* **cascades**: every edit naming it at *V* or
later is removed too, and the undo entry carries them so the operation stays
invertible. There are no inert orphaned edits — an edit that survives always
means something.

### A version is a layer

```ts
interface Version {
  base: VersionId | null
  name: string
  added: Id[]
  removed: Set<Id>
  edits: Map<Id, Edit>
}

interface Edit {
  transform: Transform
  vertices: Map<VertexId, Point>
  addedVertices: { after: VertexId, at: Point, id: VertexId }[]
  removedVertices: Set<VertexId>
  override?: Polygon
}
```

`base` is a field rather than an assumption that it is `N - 1`, which is what
makes forks free.

A newly created version has empty `added`, `removed` and `edits`, so it renders
identically to its base until touched. There is nothing to diff and nothing to
reconcile, and the difference from a copy-based model is visible on day one.

### Resolution

```
resolve(v) = apply(v, resolve(v.base))
```

Memoized per version. Because edits are keyed by id, a change to one polygon
dirties exactly that polygon's chain; every other cached resolution survives.
That is what makes the live downstream preview affordable.

`Edit.vertices` holds nudges in the polygon's local frame, applied after the
version's transform, so a nudge follows its polygon when an upstream version
moves it.

## Transforms

```ts
interface Transform {
  translation: Point
  /** Uniform. Identity is 1, and composition is multiplicative. */
  scale: number
  rotation: number
  erosion: number
}
```

**Scale is uniform only.** Non-uniform scale and shear do not commute with
offsetting — normals do not transform covariantly — and allowing them would force
the erosion accumulation below to materialize intermediate geometry at every
squash. Squashing a polygon is achievable by moving vertices. Removing a whole
mechanism is worth that.

Semantics are **sequential**: version *N*'s transform applies to the geometry
its base resolved to. Summing erosions across versions is wrong in general,
because offsetting by *a* then *b* equals offsetting by *a + b* only while
topology is unchanged.

Per-vertex coefficient accumulation is an **implementation** fast path, not a
semantic. With bisectors frozen (below) and scale uniform, `v_i + a·b_i` then
`v_i + b·b_i` is exactly `v_i + (a+b)·b_i`, so the whole chain collapses into one
expression evaluated once from the source. This matters for two reasons:

- **Floating point.** Sequential evaluation rounds once per stage, each stage
  reading the previous stage's floats. Accumulated evaluation rounds once,
  regardless of chain length.
- **Determinism.** `resolve(9)` is then a pure function of the coefficients, so
  it is bit-identical whether computed fresh on load or after a cache
  invalidation. Bake reproducibility and tests depend on that.

Where the fast path cannot be proven equivalent — a vertex inserted next door
changes its neighbours' bisectors — it falls back to sequential for that vertex.
None of this is user-visible.

## Erosion

### Clamping, never removal

Offsetting is `v_i -> v_i + t·b_i` along the bisector normal. The classic
straight-skeleton algorithm deletes a vertex when its edges collapse and
recomputes its neighbours' bisectors; that deletion destroys the vertex
correspondence between versions, which everything downstream depends on.

Instead, **bisectors are frozen and each vertex clamps at its own collapse
depth**, staying in the ring as a coincident point. The polygon pinches shut
rather than folding into a bowtie.

Freezing is also the better geometry. An edge with both endpoints free
translates along its original normal and stays exactly parallel to the original.
Only edges touching a clamp rotate, so distortion is confined to the contact
region; recomputing bisectors would feed that rotation into the neighbours and
spread it along the ring.

### Splits clamp too

A reflex vertex whose bisector reaches an opposite edge is a *split* event. The
editor never splits a polygon in two — that would destroy polygon identity and
leave every downstream edit naming that id ambiguous.

Clamping the reflex vertex alone is not enough: the opposite edge keeps eroding
and slides out from under it. The contact region has to be clamped, and that can
push another pair into contact, so resolution is a small fixpoint:

```
erode every vertex to depth t
loop:
  find contacts (vertex-on-edge, edge-crossing)
  clamp the vertices involved at their contact positions
  re-resolve
until no new contacts
```

At tens of vertices per polygon, cached per version, this is free, and it
converges because each pass only adds clamps.

Clamp topology is recomputed as part of the ordinary forward resolve, including
during a drag. There is no iterative solver anywhere in the system, so there is
nothing to oscillate — what changes as you drag is the honest geometry.

### Polygons are always simple

A self-intersecting polygon breaks collision concretely: `PolygonPoint` bakes
`enx/eny` per point and collision is edge-normal based, so on a flipped section
the normals point inward and the player is pulled into the wall. Offsetting
along bisectors is only meaningful on a simple polygon either.

Enforcement is cheap because only two things can break it — affine transforms
preserve simplicity, so groups need no check at all:

- **Drawing.** The only new edge is last-point-to-cursor. Test it against the
  existing edges each mouse move; `O(n)`, no sweep line.
- **Vertex drag.** Moving vertex *i* changes exactly two edges. Test those two
  against the rest.
- **Erosion.** Handled by the clamping fixpoint.

Soft during the gesture, hard on commit. The rubber band turns red while it
crosses, with a dot at the intersection and both offending edges lit, and
releasing there does not place the point. A vertex drag *is* allowed to cross
transiently — you often move a vertex across the polygon to a valid spot on the
far side — but reverts on release if still invalid. Anything invalid that gets in
anyway carries a hatched outline and a strip badge, and export refuses.

Degenerate necks left by clamping are fine and stay. Collision already has to
survive corridors narrower than the player, and the stray vertical line a
degenerate vertex would draw is handled by `lineOpacity` at bake.

## Groups

**Structure is global; the transform is versioned.** Membership is one fact
about the world. The transform has to be per-version or a group could not be
eroded at v3, which is the point of having group transforms at all.

Resolve order is scene-graph order: a polygon's own edit resolves first in its
local frame, then its group's transform applies to the result.

Leaving a group preserves position. Since the group's transform differs per
version, there is no single transform to absorb — baking the current version's
would hold the polygon in place where you are standing and silently shift it
everywhere else. So **leaving writes a compensating transform into every version
where the group transform is non-identity**, as one atomic undo entry. Joining is
the same operation inverted. Both are heavier than they look.

Members that do not exist yet are skipped by resolve.

## Artefacts and paths

**Artefacts are versioned like everything else** — an id, a birth version, and a
per-version position override, absent meaning inherited. One mechanism for
everything positional is more predictable than exempting them, and an artefact
that ends up inside a v4 wall needs to be movable there.

**Paths are global.** They are an authoring aid, not in-world geometry, so they
sit outside `versions` entirely.

## Delinking

Delinking is the deliberate exit from the system: snapshot resolved geometry
into `Edit.override` and stop listening upstream.

It is explicit, per-polygon, and **ranged**: the action reads *delink from here
on*, and the affected versions highlight in the strip, because the delink is
inherited by every descendant whether or not that is noticed. Re-linking is
symmetric — *re-link from here on* restores inheritance.

A delinked polygon renders in its own style, because "why did my edit not
propagate" must be answerable by looking at the canvas.

## Forks

`base` already makes the version set a DAG. A fork is a version whose base is
not the linear successor; storage is O(1) because layers are relative, so
forking is free and should be encouraged.

`World` gains `activeBranch`, a named pointer to a leaf. The bake walks that leaf
to the root and emits the chain in order.

There is no merge and no cherry-pick. Re-parenting a version resolves fine
mechanically, but the blast radius is invisible and it is not worth the
explanation.

## Version operations

**Insert** — a new empty layer between two versions. Free.

**Delete** — allowed only for a version with at most one child, and it composes
its layer into that child so appearance is preserved. Deleting a branch point is
refused; delete the branches first. This kills the layer-duplication problem by
restriction rather than machinery.

**Reorder** — forbidden. Layers do not commute: erosion order matters, and there
is no reading of a reorder that is reliably what was meant.

**Copy/paste** — always mints new ids. A paste is an independent thing, never a
link. Versions are the linking mechanism.

## Undo

**One global stack, ordered by when things were done.** Per-version stacks cannot
work: an edit in v0 changes v4's resolved geometry without leaving any entry in
v4's history, so v4's stack would have silent holes. Causality is temporal.

Each entry records the version and branch its write landed in. Undo pops the
stack, **navigates to that version**, restores the selection, and reverts. Edit
v0, switch to v4, dislike it, undo: the editor jumps back to v0 and the edit
visibly comes undone.

Scoped undo — "undo my last edit in *this* version" — is a separate binding, and
only offered when the entries being skipped are independent of the one being
reverted (disjoint ids). Otherwise it reorders dependent operations. Grey it out
rather than guess.

Deleting a version **clears the undo stack**, with a warning. The alternatives
all cost more than the operation is worth.

Coalescing: a drag is one entry, not two hundred. Add, remove, create version and
fork are atomic.

## Selection

The selection is a set of ids. **Actionable** means present in the current
version; absent ids are held, not dropped, and restored on navigating back.
Operations only touch the actionable subset, so a held id cannot be harmed by an
operation in a version it does not appear in.

**The selection changes only through an explicit selection action.** Navigating
does not change it. Dragging does not change it. Shift-click adds or removes
exactly the id clicked and touches nothing else. A plain click replaces the whole
selection, which is the escape hatch for held ids.

The status line shows the discrepancy — *4 selected, 1 not in this version* — so
it is never silent.

## UI

### The version strip

One widget, at the bottom of the window, doing four jobs. Building these
separately is the main thing to avoid.

1. **Navigation.** Nodes are versions along the active chain, left to right, so
   the shrink sequence reads in the order it happens. Click to view. Versions
   carry names — "first pinch" beats "v3" within a day.
2. **Fork tree.** Branches hang off their base node; the active chain at full
   strength, inactive branches dimmed but present and clickable.
3. **Visibility.** An eye per version, Illustrator-style, controlling whether
   that version's ghost draws. Bulk presets set them in groups: **None**,
   **Previous**, **Subsequent**, **All**. Per-version eyes then cover comparing
   against an arbitrary version, or against a fork, with no extra concept.
4. **Status.** Badges for invalid polygons and for delinked ranges.

There are no span handles. Edits always land in the version on screen.

### Canvas: ghosts

Ghosts are outline-only, no fill. Opacity alone goes muddy past about three
stacked versions, so ramp hue as well as alpha. Cap the depth drawn at around
four and collapse the rest.

**Previous** is the working default: you erode *from* the previous shape, and the
reversal artefact means the backward transition has to read too.

The eyes are only the resting state. **Grabbing a vertex or polygon fades in the
downstream versions and holds them for a moment after release.** This is
load-bearing rather than a nicety — it is the entire mechanism by which an edit
made at v0 can be judged against its effect at v4, and it is what makes dropping
backward propagation affordable. On by default.

Re-resolution during a drag runs on animation frame, not per mouse event, and
touches only the dirtied chain.

### Canvas: polygon states

- **Inherited** — resolved from upstream, untouched here. Muted outline.
- **Edited here** — this version's layer holds a delta for it. Accent.
- **Delinked** — overridden, no longer tracking upstream. Distinct, hatched.
- **Invalid** — self-intersecting. Red, hatched, badged on the strip.

No dropdown menus anywhere in this flow.

## The bake

The bake is where ids, layers, forks and history disappear, and where the
runtime's interpolation buffers are built.

### Interpolation is a bake output, not a runtime feature

The game lerps between versions rather than switching instantaneously. It does
so in the vertex shader from static buffers, so the bake's job is to emit the
connectivity and the per-vertex inputs from which the shader can reconstruct the
world at any moment.

### The exact morph

There is an exact answer to "what does the world look like part way between v3
and v4":

```
geometry(t) = CSG(source polygons interpolated at t)
```

Source polygons interpolate unambiguously. Their vertex ids are fixed, and a
version never permutes ring order — it only moves positions and gives birth to or
kills vertices. So there is no correspondence problem at the source level at
all.

They interpolate on **transform components**, not on final positions:
translation linearly, rotation angularly, scale and erosion as scalars. A
polygon that rotates between versions therefore rotates through the morph
instead of collapsing through its own centre, which plain vertex lerping would
do.

The bake does not approximate this. It reproduces it exactly, by giving the
shader the same inputs.

### Transforms coalesce; erosion does not

Translation, rotation and uniform scale compose, so the whole chain from the
root down to a keyframe collapses into **one `Transform` per polygon per
keyframe** — five floats. That is the entire per-polygon payload.

Erosion cannot join it, because clamping makes the depth per-vertex. So each
source vertex carries its own coefficient, one float, alongside its frozen
bisector.

A source vertex's position is then

```
p(t) = apply(lerp(T_k, T_k1, t), local + lerp(e_k, e_k1, t) * bisector)
```

with `local` and `bisector` constant within a stretch, because a nudge or a
vertex insertion can only happen at a version boundary and every version
boundary is a keyframe.

### Keyframes are exactly the topology events

The shader can compute *where* a vertex is. It cannot compute *whether it should
exist*, or what order the ring visits its vertices in. Those are discrete facts,
and their change points are the only keyframes needed:

- **a crossing appears or disappears** — a corner passes through another edge, so
  two edges start or stop intersecting within their segment bounds
- **rings merge or split** — two rooms connect, a wall pinches into two
- **a vertex is born or dies** — a version boundary
- **an erosion clamp engages** — a vertex reaches its collapse depth, and each
  further step of the contact fixpoint
- **every version boundary**, because transform interpolation is piecewise
  linear in the version parameter and its derivative changes there

Find the first two by bisection on `t`: the crossings move continuously, so a
sign change brackets the event. The rest are known from the layer chain.

The span between two consecutive keyframes is a **stretch**. The word is used
throughout rather than "segment", which already means a piece of a line in
`geometry.ts` and would be ambiguous in every sentence that mentions both.
Across a stretch the ring's vertex set and order are constant by construction,
correspondence is ring traversal, and the shader reproduces `geometry(t)`
exactly. There is no tolerance parameter and no adaptive
subdivision anywhere in the bake.

The rotating-pillar case falls out correctly without needing a special rule. A
pillar centred on a wall always cuts exactly two crossings, but as it turns,
each corner sweeping through the wall hands a crossing off from one edge to the
next. Each handoff is an event, so each gets a keyframe, and between them the
two crossings slide along the wall. The player sees the hole widen and narrow
continuously; it never closes and its sides never touch.

### Finding the events

Bisection is what the prototype uses and it cannot diverge — a bracketed
bisection is unconditionally convergent, halving the interval every step. But
divergence is the wrong thing to worry about. The failure modes are missing
events, not overshooting them.

**The event function.** A crossing appears or disappears exactly when an
intersection parameter reaches an endpoint, which is to say when a vertex lies
on an edge. So the quantity to track is the orientation determinant

```
f(t) = cross(A(t), B(t), V(t))
```

for edge `A-B` and vertex `V`, and an event is a sign change. This is much
better than bisecting on "does this tag exist", which is what the test does: `f`
is continuous, it gives a sign to bracket, and it does not depend on the CSG's
own snap tolerance.

**Analytic where it is cheap.** If the two polygons have no relative rotation,
`p(t)` is polynomial in `t` and so is `f` — low degree, roots in closed form, no
iteration. That covers pure erosion, which is the common case and the core
mechanic. With two different rotation rates `f` picks up `cos` and `sin` of two
different angles and becomes a trigonometric polynomial with no closed-form
root, so iteration is unavoidable there.

**The real risks:**

- **Two events inside one sampling interval.** `f` changes sign twice, the scan
  sees no sign change, and both are missed. This is the one that actually bites.
- **Tangential contact.** A corner grazing an edge is a double root: `f` touches
  zero without crossing. Bisection cannot see it at all; it needs a search for
  local minima of `|f|`.
- **Coincident events.** Symmetric geometry — a square eroding until four
  corners clamp at once — puts several roots at the same `t`. One keyframe has
  to absorb all of them rather than the search iterating per root.
- **Precision floor.** Near the root `f` is a difference of nearly equal
  quantities, so its sign is noise below some epsilon. Bisection converges to
  that floor and no further, which is fine as long as the next point is handled.

**Completeness rather than convergence.** Built, in `interval.ts` and
`events.ts`. Rather than bound `|f'|` analytically, `f` is evaluated over whole
*intervals* of `t`: every operation returns a range guaranteed to contain the
true range of its result, so an interval whose enclosure excludes zero has been
*proved* free of roots and is discarded outright. Anything unproven is
subdivided. A root always lives inside some interval whose enclosure holds zero,
and those are exactly the ones never thrown away, so nothing can be missed —
including the graze, which never changes sign, and the close pair, which shares
a sample interval.

**The answer is a superset, and that is the right trade.** The arithmetic cannot
know that the several appearances of `t` in an expression move together, so its
ranges are wider than the truth and it may name a moment where nothing actually
happens. The cost is one redundant keyframe: a stretch across which the topology
happens not to change, which is harmless. A missed event tears the geometry.

**Degenerate stretches are answered, not searched.** Three points that stay
collinear for a whole stretch give `f ≡ 0`, and hunting for the instant it
vanishes subdivides for ever. The search takes a `flat` band — an `|f|` small
enough to count as zero — and reports such a stretch once. The test is on how
big `f` gets, not on how narrow the enclosure is: enclosures narrow under
subdivision for *every* function, so a width test would cut every search short.
Since `f` is twice a signed area, `flat` scales as the square of the world units
in play, and a genuine root has `f` steep enough around it to reach that band
only well inside `tol`.

**Running out is safe.** A budget bounds the work. Exhausting it returns
`coarse: true` and a cover that is wider than `tol` but still complete — never
one that has dropped something.

**A keyframe is a discontinuity, not a shared frame.** At an event the two sides
genuinely have different vertex sets; that is what the event *is*. Continuity
comes from the appearing or disappearing vertex being exactly degenerate at the
boundary — sitting on the edge between its ring-neighbours, `lineOpacity` 0 —
rather than from the two sides sharing a geometry. So converge the bracket
properly and build the boundary so both sides agree by construction: take the
shared vertices from one evaluation, and place the appearing one at exactly its
ring-neighbour position. A bracket left `w` wide leaves a pop proportional to
`w`, because the vertex is only nearly degenerate.

### What the shader evaluates

CSG output vertices are of exactly two kinds, and both reduce to source vertex
positions:

- `Original(v)` — evaluate `p(t)` for that source vertex.
- `Cross(a, b)` — evaluate `p(t)` for the four endpoints of the two edges, then
  solve the 2x2 line intersection. About ten multiply-adds.

Within a stretch the two edges are guaranteed to still meet inside their
segment bounds, because an endpoint passing through the other edge is an event
and would have ended the stretch.

### Data layout

Per stretch:

- **Polygon table** — `Transform` at both ends, ten floats per polygon.
- **Source vertex table** — `local` (2), `bisector` (2), erosion coefficient at
  both ends (2), polygon index (1). Lives in an SSBO or texture.
- **Ring index buffer** — per output vertex: a kind flag, one or four source
  vertex indices, and `lineOpacity` at both ends. Around twenty bytes.

Output vertices carry indices rather than data, so a crossing costs four
lookups rather than four copies. Connectivity comes from the baked ring; the
shader only positions.

A side table records each stretch's byte offsets and the `t` range it spans. The
countdown maps to a global `t`, which selects a stretch and a normalised
position within it. Running backward for the reversal artefact is the same table
read in reverse.

### lineOpacity

A vertex that does not exist across a whole stretch is still present in that
stretch's ring, positioned on the edge between its ring-neighbours at its
parametric position, with `lineOpacity` 0. Because births and deaths land
exactly on keyframes, the line fades in over precisely the stretch where the
vertex is emerging.

Degenerate neck vertices left by erosion clamping get opacity 0 the same way,
which is why zero-area lobes need no removal and why polygons are never split at
bake — splitting would break correspondence, since a one-ring shape cannot be
morphed into a two-ring shape without an event to do it at.

Ring merges and splits need no special case: they are events, so they get a
keyframe, and on the merged side the passage's vertices sit on the wall as a
zero-width bridge until the event opens them.

### Steps

1. Walk `activeBranch` to the root; resolve each version's layer chain.
2. Run the erosion clamping fixpoint per version.
3. Refuse on any invalid polygon.
4. Collect the known events — version boundaries, births, deaths, clamps.
5. Bisect on `t` for the geometric events — crossings appearing, disappearing,
   rings merging or splitting.
6. At every keyframe, CSG the **source** rings — union `level`, subtract
   `solid` — keeping provenance tags.
7. For each stretch, emit the ring index buffer plus the polygon and source
   vertex tables for its two ends.
8. Recompute `bnx/bny` and `enx/eny` per point.

### Provenance

Built, in `geometry.ts`. `combineTagged` and `simplifyTagged` sit beside the
existing entry points, which now delegate to them, so there is one arrangement
algorithm rather than two.

```ts
export interface SourceRef {
  shape: 0 | 1
  ring: number
  index: number
}

export type Tag =
  | { kind: 'vertex', at: SourceRef }
  | { kind: 'cross', a: SourceRef, b: SourceRef }
```

A tag names only the input — which operand, which ring, which vertex or edge —
so it says nothing about where anything is. That is what makes it survive the
geometry moving, and it is what the shader needs: a tag is a recipe for
recomputing the point, either by looking up a source vertex or by intersecting
two named source edges.

Four details the prototype settled:

- **Ties resolve canonically.** Where several cut parameters collapse into one
  point, a `vertex` tag beats a `cross` tag, and the lower `SourceRef` wins
  among equals. So three edges meeting is one point with one name, and the name
  does not depend on the order the arrangement happened to be walked in.
- **Collinear overlaps produce `vertex` tags, not crossings.** Two collinear
  segments meet at each other's *endpoints*, so that is what the points are.
- **Tags are per output point**, parallel to the rings: `tags[r][i]` describes
  `rings[r][i]`.
- **Tags stay inside the bake.** The runtime sees indices.

### The bake reads `source`, not `shape`

`worldset` already keeps both — `Entry.source` is the polygon exactly as it came
in, and `Entry.shape` is a simplified copy. The bake takes `source` and combines
it directly, because a tag from a combine over simplified rings would name edges
of the *simplifier's* output rather than of the author's polygon, and composing
the two levels of provenance would put a chain behind every reference.

This is safe because polygons are simple by invariant. Two caveats worth
holding on to: the editor does not enforce that yet, and the pre-pass also
normalises winding, which the bake would then be assuming of its input. A
single simple ring is fine either way — nonzero fill does not care which way it
winds — so this holds as long as a source polygon is one ring, with holes
modelled as `solid` polygons rather than as reversed rings.

The editor's own path keeps the pre-pass. It is doing real work there until the
no-self-intersection invariant is enforced on drawing and dragging.

### What the tests hold

In `geometry.test.ts`:

- **A tag reconstructs its point from the input alone**, across union, subtract
  and intersect. This is exactly the operation the vertex shader performs, so it
  validates the scheme rather than the plumbing.
- **The morph property.** Inside a stretch where the tag rings are unchanged,
  the tags taken once at the stretch's start rebuild the entire result at any
  moment inside it, to within 1e-6. Checked by `fast-check` over four base
  shapes, three operations, and random component-wise interpolated transforms —
  translation, rotation, uniform scale and erosion depth. The property is not
  vacuous: weaken the stability condition to compare ring counts instead of tag
  rings and it fails.
- **Tags name combinatorics**, so applying a rigid motion to the whole scene
  leaves every tag identical.
- **The rotating pillar behaves as this section claims.** Its crossings sit on
  pillar edges 1 and 3, hand off to edges 0 and 2, and hand back — and bisecting
  on the tag set finds the handoff at 78.690068 degrees, which is
  `atan(100/20)`, the angle at which a corner reaches the wall. Event detection
  by bisection works.
In `events.test.ts`:

- **Interval arithmetic encloses.** `cos`, `sin` and products contain every
  value they can take, checked by sampling inside the input range.
- **A graze is found where sampling is blind.** `(t - 0.4)²` touches zero
  without crossing it; a 100,000-sample scan reports nothing and the search
  finds it.
- **A close pair is found where sampling is blind.** Two roots 1e-5 apart, which
  a 2,000-sample scan steps straight over; both are located.
- **Nothing a dense scan finds is ever missed**, over random grid-quantised
  motions — 400 cases, several hundred real roots.
- **Degenerate geometry is answered cheaply**, never going coarse across those
  same 400 cases.
- **The pillar corner reaches the wall at `atan(5)`**, found to eight decimals
  from the moving geometry rather than from tags.

A note on generators: they quantise to a grid, the way a level is actually
authored. `fc.double` given half a chance produces 3e-323, and a world
coordinate that small is not geometry but noise — it made every property fail
on configurations that cannot occur.

- **Comparing only the endpoints invents a swap that never happens.** Half a
  turn leaves the same two tags in opposite ring order, but no tag survives the
  path between: they die and are reborn twice. The conflict this section was
  once built around is an artefact of looking only at the ends.

## Implementation notes

**worldset** — the bake reads `Entry.source`; the editor's live path keeps its
simplify pre-pass. One instance per version, computed lazily, kept warm only for the
current version and visible ghosts. A single global set cannot work: v0's and
v3's walls must never union with each other, and AABB clustering will not
separate them since v3 sits inside v0. An upstream edit fans out as an
incremental update per version, but the fan-out is far smaller than it looks,
because a version whose chain does not touch a polygon has identical resolved
geometry for it and is skipped.

**Serialization** — plain JSON with arrays in place of `Map` and `Set`, rebuilt
on load, behind a format version number.

## Known limits

**Long-chain intent drift.** An edit at v0 reshapes every downstream delta. The
strip can say *what* changed; it cannot say what is now artistically wrong. No
mechanism is planned for v1 — the visibility eyes are the review tool — and this
is the most likely thing to need revisiting once worlds get long.

**Strip layout at scale.** Twenty versions across three branches will not fit.
Scrolling plus collapsing untouched runs, settled against a real strip rather
than on paper.

## TODOS / Questions

- Undo "`worldset` already keeps both — `Entry.source` is the polygon exactly as it came
in, and `Entry.shape` is a simplified copy" after enforcing non-self-intersection invariant

- How many false positive keyframes can theoretically be generated during the topology event search?
