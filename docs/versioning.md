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

**Resolution is sequential.** Version *N*'s layer applies to the geometry its
base resolved to, one stage at a time, and nothing is collapsed into a closed
form. An earlier design accumulated erosion into a per-vertex coefficient so a
chain of any length could be evaluated in one step. It bought a rounding
argument worth about 1e-15, it cost uniform-scale-only transforms, and it made
group erosion inexpressible. Walking the chain is cheap and cached, and it puts
no algebra in the way of what a version is allowed to do.

**You edit the version you are standing in, and edits flow forward.** That is
the entire propagation model. There is no way to author an edit that lands in an
earlier version than the one on screen — if something is wrong in v0, go to v0
and fix it, and watch the consequences downstream with ghosts.

**Everything a delta names has a stable identity.** Polygons, groups and
vertices are identified by id, never by index. An edit keyed by array index
silently re-points at the wrong thing the moment something upstream is inserted.

Stable is not the same as immortal. A vertex dies when erosion collapses the
edge it sits on, so *which* ids exist at a version depends on geometry upstream
of it, not only on what was authored. An id is never reused and never means two
things; it can simply stop being there.

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

Read literally: each stage reads the geometry the previous stage produced.
Memoized per version. Because edits are keyed by id, a change to one polygon
dirties exactly that polygon's chain; every other cached resolution survives.
That is what makes the live downstream preview affordable.

Evaluating the chain rather than a closed form is what lets a layer do anything
at all to the geometry beneath it — squash it non-uniformly, erode a group as one
shape — without that operation having to commute with every other operation in
the chain. The cost is a walk of a few dozen stages over a few dozen vertices,
memoized, which is nothing beside the CSG that follows it.

Determinism does not need the closed form either. Memoizing a pure function is
transparent: `resolve(9)` reached from a cached `resolve(5)` walks the same
stages in the same order as one reached from the root, and lands on the same
bits. Bit-identity comes from fixed evaluation order, which the recursion gives
by construction.

### Vertex edits

`Edit.vertices` holds per-vertex displacements against the geometry the base
resolved to, in the polygon's local frame, so an edit turns with its polygon
when an upstream version moves it.

They land on the **source** ring, always, and there is nothing else they could
land on: erosion is a projection, and what it projects to is not editable. That
is the next section.

### Erosion is a projection, not a stage

A layer's erosion does not feed the layer above it. Resolution is

```
source(k) = transform_k(source(k - 1) + vertexEdits_k)
shape(k)  = erode(source(k), depth_k)
```

so `source` is the thing that flows down the chain and `shape` is a read-only
view taken at each version. Version *k+1* erodes `source(k)`, never `shape(k)`.

A grouped polygon projects twice within one version's read — its own depth on its
own ring, then the group's depth on the union of those — and that is still
terminal in the sense that matters: nothing is written back, and version *k+1*
still starts from `source(k)`.

This is the single decision that most of the rest of the document used to be
working around, and almost every hard case dissolves into it:

- **Source vertices are immortal.** Nothing an erosion does can delete one,
  because erosion never writes back. No tombstoned vertices, no arbitrary choice
  of which of a merged pair survives, no downstream edit left naming an id that
  stopped arriving, no cascade firing off a slider drag.
- **Erosion is always reversible.** The depth is a number in a layer and stays
  one. Scrub it back and the shape comes back, at any point, forever.
- **Nothing has to be baked**, so the trilemma between placing a vertex exactly,
  moving only that vertex, and keeping the depth scrubbable never arises — the
  drag is on the source, where all three are free.
- **Group erosion is just a depth on the group's transform.** The union is
  formed and offset at read time. There is nothing to write into the members,
  which is what the whole rejected per-source-edge encoding was trying to do.
- **Crossings need no identity.** They only ever appear in a projection, and a
  projection has no handles.
- **Depths do not accumulate**, so none of the algebra about whether offsetting
  by *a* then *b* equals offsetting by *a + b* applies. To shrink progressively
  the author raises the depth version by version — 2, 5, 9, 14 — which is more
  direct to author than compounding and exactly reproducible.

Non-uniform scale comes out right for free: the transform chain reshapes
`source`, and the single offset at the end is a true constant-width offset of
whatever shape that produced.

### Editing an eroded polygon

Clicking an eroded polygon shows its **source ring as a ghost, with the
handles on it**. The eroded outline draws solid and carries no handles at all.
Drag a source vertex and the projection updates live underneath.

The eroded points are not editable and there is no gesture that pretends they
are. This costs the one thing it looks like it costs — you cannot put an eroded
corner at an exact position, only the source corner that produces it — and buys
back everything in the list above. It is also the honest presentation: the
eroded outline is derived geometry, in the same sense that the CSG result is
derived geometry, and nobody expects to drag that either.

## Transforms

```ts
interface Transform {
  translation: Point
  rotation: number
  /** Per axis. Identity is 1. */
  scale: { x: number, y: number }
  /** How far each edge has moved inward. */
  erosion: number
}
```

A layer applies its transform in one order, always: **scale, rotate and
translate the source, and erode last**. Erosion is the projection, so it comes
after everything that reshapes the ring — which is also what makes a squashed
polygon offset to a true constant width rather than to one that varies with
direction.

**The frame is the world origin.** A transform reads nothing but its own
numbers — in particular not a centroid of the points it is transforming. Deriving
the pivot from the geometry ties the frame to the very thing being edited:
moving one vertex moves the centroid, and every other vertex swings by
`(I - M)·Δcentroid`, which is zero while the polygon is untouched and a visible
smear the moment it is turned or scaled. The gesture that builds a transform
puts whatever pivot it wants into the translation, so a pivot is a property of
the gesture and never of the document.

**Scale is per axis.** An earlier design allowed uniform scale only, because
non-uniform scale does not commute with offsetting — normals do not transform
covariantly — and a chain that had to collapse into one closed-form expression
could not tolerate that. Nothing collapses now, so nothing has to commute. A
squash is just another stage, applied to what the stage before it produced.

The components stay separate rather than becoming a 2x2, for one reason:
interpolation. Translation interpolates linearly, rotation angularly, the two
scales as scalars. A general matrix lerped entrywise slews through a shear on
the way, and a rotating polygon would collapse through its own centre — which is
the whole reason the morph interpolates on components in the first place.

Composition is not closed in this family: rotate, squash, rotate again is a
shear. That is fine, because nothing composes. Each version holds its own
transform and applies it to what it was given, and the bake never needs an
accumulated one — see *Nothing coalesces*.

A zero axis is refused. It is not invertible, and there is no geometry on the
far side of it worth having.

## Erosion

### Offsetting is ordinary, and vertices die

Erosion is the plain mitred offset: every edge line moves inward by `t`, each
vertex goes where its two lines now meet, and when an edge shrinks to nothing
its endpoints merge and one of them is gone.

This replaces an earlier design that froze bisectors and clamped each vertex at
its own collapse depth so that no vertex ever died. Two arguments held it up and
neither survives.

The first was that deletion destroys vertex correspondence between versions.
There is no correspondence to destroy. Erosion is a projection, so the vertices
it deletes are the projection's, and those never had an identity to lose — no
edit names one, and nothing downstream reads one. The source ring keeps every
vertex it ever had.

The second was that freezing gives the better geometry. It gives the worse.
A true offset keeps **every** surviving edge exactly parallel to its original,
unconditionally and forever, because every surviving edge lies on a translate of
its own original line. Freezing is the thing that breaks that: a vertex pinned
at its collapse depth beside a neighbour still moving makes the edge between
them rotate. The old text conceded this — "only edges touching a clamp rotate" —
while presenting the alternative as worse. There is no rotation for recomputed
bisectors to spread, because a proper offset produces none.

What recomputing does change is a vertex's *trajectory*: it slides along one
bisector until an event, then along another. That is exactly right, and it stays
piecewise linear in depth with the breaks at events, which is all the bake needs.

### Splitting is allowed; a polygon resolves to a shape

A reflex vertex whose offset reaches an opposite edge is a *split*: past that
depth the room divides in two. The author often wants exactly that — erode a
room with a reflex corner until it becomes two rooms, and trap the player in one
of them — so the erosion goes through it rather than stopping.

**`resolve` returns a `Shape`, not a `Ring`.** That costs less than it sounds
like. The source polygon is still one ring and still one id; the CSG
takes shapes already; and *rings merge or split* is on the keyframe list, so the
bake handles it with the zero-width bridge it uses for every other topology
event. Vertex identity is untouched, because the split happens in the
projection, and the source ring never divides.

**Pieces are never named**, and wanting one of two rooms gone is said by
editing the source rather than by pointing at the piece. Each lobe of a split is
generated by a contiguous run of source edges, so deleting that run at version
*k* leaves both rooms at *k-1* and one at *k*. The discarded lobe's source
shrinks away across the boundary, with a keyframe and a `lineOpacity` fade,
rather than a piece blinking out.

It is cruder than pointing at the piece, and it costs one thing honestly:
closing the source ring after the deletion introduces a new edge that also
erodes, so the survivor is not exactly the lobe that was on screen and the
author hand-shapes the difference.

What it buys is that no piece ever needs an identity. Every naming scheme for a
piece is downstream of geometry and therefore fragile — a path in the split tree
is stable under scrubbing a depth but permutes the moment an upstream reshape
changes which split happens first — and none of that has to be built, explained
or debugged.

An earlier draft stopped the erosion instead, by freezing the edges in contact
and letting the rest of the ring carry on. The geometry of that is good — a
frozen edge still lies on a translate of its own original line, so parallelism
holds everywhere, which pinning a *vertex* can never manage. It is the fallback
if splitting proves worse in practice. But it means a room with a reflex corner
can never finish closing, and closing rooms are what this game is.

### Source polygons may self-intersect

They are allowed to, and nothing checks otherwise.

Once erosion is permitted to split a ring, the machinery for turning a
self-crossing loop into a set of loops that do not cross is already in the
resolve path — `simplify` is the CSG run against an empty second operand, and it
is the same code either way. Having it there for the projection and forbidding
it on the input would be an invariant enforced for its own sake.

So the projection is `erode(simplify(source), depth)`: decompose first, then
offset each resulting ring, with `erode` reading each ring's winding so holes
move outward as the material shrinks.

The old objection was about collision, and it survives — `PolygonPoint` bakes
`enx/eny` per point, so on a flipped section the normals point inward and the
player is pulled into the wall. But that is a constraint on **baked output**,
not on authored input, and the CSG guarantees it: what reaches the bake has been
through the arrangement and is simple by construction. Enforcing it a second
time at the source bought nothing.

What goes with this: no crossing test on the rubber band, no two-edge test on a
vertex drag, no invalid state, no hatched outline, no strip badge, no export
refusal. A polygon that crosses itself is a shape with the overlap cancelled
under the nonzero rule, which is a legitimate thing to draw and occasionally a
useful one.

Zero-area polygons are equally harmless — they contribute nothing and the
arrangement drops them.

## Groups

**Structure is global; the transform is versioned.** Membership is one fact
about the world. The transform has to be per-version or a group could not be
eroded at v3, which is the point of having group transforms at all.

Resolve order is scene-graph order, and each level does the same two things —
transform, then project:

```
shape(A)     = erode(T_A(source_A), d_A)
shape(group) = erode(T_G(union of member shapes), d_G)
```

nesting to any depth. A member's own depth offsets its own ring; the group's
offsets the union of what its members produced. Neither writes back, so this is
still a projection rather than a stage: `source` is untouched and version *k+1*
starts from `source(k)` as always.

It is deliberately the same shape of composition as the version chain — apply
mine, then the enclosing one's — so there is one rule to learn rather than two
that happen to rhyme.

Leaving a group preserves position. Since the group's transform differs per
version, there is no single transform to absorb — baking the current version's
would hold the polygon in place where you are standing and silently shift it
everywhere else. So **leaving writes a compensating transform into every version
where the group transform is non-identity**, as one atomic undo entry. Joining is
the same operation inverted. Both are heavier than they look.

**Erosion is not compensated, and leaving does not take the group's depth.** A
polygon owns one erosion depth, membership does not touch it, and a group's
depth is the group's. Leaving a group with a non-zero depth therefore changes
the polygon's shape — it stops being offset by the group's amount — while its
position is preserved as promised. Position is what the compensation is about;
shape was never in the promise.

The reason is that transforms compensate and depths cannot. Affine transforms
form a group: leaving composes `C` into the member's own transform, joining
composes `C⁻¹`, and the round trip is exact even if the author scrubs the
transform in between, because composition is associative and invertible. Erosion
has neither property — offsetting by `a` then `b` is not offsetting by `a + b`
once an event falls between them, and there is no inverse at all.

Both ways of trying it break on a round trip. Adding the group's depth on
leaving and not removing it on joining doubles the erosion for a polygon pulled
out and put straight back. Replacing the polygon's own depth with the group's
discards what the polygon had. Leave, scrub, rejoin has no defensible answer
under either. Owning one depth and never transferring it has exactly one
answer, and leave-then-rejoin is the identity.

Members that do not exist yet are skipped by resolve.

**Groups nest four deep.** The limit is the shader's — a vertex carries a chain
of transforms rather than one composed matrix, so the chain has to be bounded —
and it is stated in the status line when a fifth level is asked for rather than
being discovered as a bake failure. Four is low on purpose: nesting is a
legibility problem before it is a performance one, and the number is raisable
later without breaking worlds.

### Eroding a group erodes the union

A group erodes **as if it were a single polygon**: union the members, offset that
boundary inward, and that is the result.

Not each member offset separately. That is a different operation and a visibly
wrong one. Build a corridor from two overlapping rectangles and erode each by
`d`: both pull back lengthwise at the join, so an overlap shorter than `2d`
breaks the corridor in two and a longer one pinches it. Eroding the union pulls
back only the outer boundary and the corridor stays put. What makes this
unacceptable rather than merely approximate is that the author cannot see the
seam that failed — it is interior geometry, behind a wall that still looks right.

This is affordable precisely because resolution is sequential. The stage
computes `erode(union(members), d)` from the geometry it was handed, using the
CSG it already runs, and passes the result on. There is nothing to store,
nothing to invalidate, and no predicate to keep consistent with anything.

It also needs no new erosion machinery. A union boundary is a ring like any
other — its vertices happen to be crossings between members rather than shared
corners, but each still has two adjacent edges and therefore a bisector — so
`erode` applies to it unchanged, and the winding it already reads per ring makes
holes erode outward without a special case.

**The depth lives on the group's transform**, and the offset is taken on the
union at read time. Nothing is written into the members and nothing is scoped
per polygon. A member's edge meeting another's is not a special case either —
it is the same split as any other, on that ring.

### Transforms distribute over a selection; erosion does not

A selection can borrow the group machinery for a transform, because a rigid
motion of a set is a rigid motion of each member: the result distributes, and
what gets written down is a transform per member. A virtual, temporary group is
a faithful description of that.

Erosion does not distribute — that is the whole content of the section above — so
a selection erode cannot be written as per-member erosion, and there is nothing
else in a version's layer to write it to. Since groups are global structure
rather than per-version, minting an anonymous one inside a version is not
available either. Eroding several polygons as one shape therefore requires them
to *be* a group.

So the erode control is **greyed out for a selection**, with the status line
reading *to erode a selection, make it a group first*. Refusing in the one place
the author would try it is cheaper than any of the alternatives, all of which
amount to inventing somewhere to put a number that has nowhere to go.

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
4. **Status.** Badges for delinked ranges.

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
translation linearly, rotation angularly, the two scales and the erosion depth
as scalars. A
polygon that rotates between versions therefore rotates through the morph
instead of collapsing through its own centre, which plain vertex lerping would
do.

The bake does not approximate this. It reproduces it exactly, by evaluating the
same expression at the ends of each stretch and letting the shader interpolate
between them. The one exception is a squash and an erosion sharing a stretch,
under *Known limits*.

### Nothing coalesces; the bake evaluates

An earlier design collapsed the whole chain from root to keyframe into one
`Transform` per polygon plus one erosion coefficient per vertex, so a chain of
any length could be evaluated in one step. That went with the accumulation it
rested on. The bake computes each keyframe's geometry on the CPU, sequentially,
at whatever cost it likes, and **the shader only ever interpolates between two
adjacent keyframes.**

Nothing is lost by this, because erosion is linear in depth:

```
lerp(v + e_k·b, v + e_k1·b, t)  =  v + lerp(e_k, e_k1, t)·b
```

Interpolating two precomputed positions is identical to interpolating the depth
and offsetting. Bisectors are constant within a stretch, and a collapse or a
split is a keyframe, so the piecewise break never lands inside one. The old per-vertex
`bisector` and erosion coefficient were carrying exactly this linear function
into the shader; the bake now evaluates it at the two ends instead of shipping
its parameters.

Rotation still has to stay factored out, because interpolating positions through
a turn collapses a polygon through its own centre. So a vertex carries its
**eroded, untransformed position** at both ends of the stretch, and its polygon
carries transform components at both ends:

```
p(t) = apply(lerp(T_0, T_1, t), lerp(local_0, local_1, t))
```

which is the same expression as before with the erosion folded into its
endpoints.

The transform interpolated here is the **in-flight version's own**, never an
accumulation of the version chain. Every version boundary is a keyframe, so at
most one version's layer is partway applied across any stretch, and everything
before it is already inside `local`. That is why the chain never has to compose,
and therefore why a version's scale is free to be non-uniform.

The *scene graph* is a different axis, and it is not collapsed either. A polygon
and the groups above it can all be in flight at once, so the shader keeps them
apart and interpolates each in its own components — see *Data layout*.

This also fixes something the old scheme got wrong. With `local` constant across
a stretch, a vertex nudge could only pop at a version boundary. With `local`
interpolated between its endpoints, a nudge morphs like everything else.

### Keyframes are exactly the topology events

The shader can compute *where* a vertex is. It cannot compute *whether it should
exist*, or what order the ring visits its vertices in. Those are discrete facts,
and their change points are the only keyframes needed:

- **a crossing appears or disappears** — a corner passes through another edge, so
  two edges start or stop intersecting within their segment bounds
- **rings merge or split** — two rooms connect, a wall pinches into two
- **a vertex is born or dies** — a version boundary
- **an edge collapses** — its two endpoints meet, one vertex dies, and the
  neighbours' bisectors change, so the trajectory bends
- **an edge collapses in the projection** — its endpoints meet and the
  offset ring loses a vertex
- **an eroded group's own arrangement changes** — a member's edge starts or stops
  contributing to the union boundary, or two members touch. The union is an
  input to the final CSG, so an event inside it is an event
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
  corners collapse at once — puts several roots at the same `t`. One keyframe has
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

**How many false positives.** Three bounds, in increasing usefulness.

The budget is a hard cap by construction: the search stops there, so the cover
can never exceed what the budget allows whatever the geometry does.

Structurally, the cover holds one cluster of intervals per true root, one per
flat stretch, and one per near-tangency the search cannot resolve. Adjacent
intervals merge, so a cluster is one keyframe rather than several. Nothing else
survives, because interval arithmetic's overestimation is `O(w)` in the interval
width: an interval holding no root is discarded as soon as `w` falls below
`|f| / L`, which happens almost immediately away from zero. False positives
concentrate exactly where `|f|` sits inside the flat band or the precision
floor — a corner passing within noise of an edge without touching it — and there
are as many of those as the geometry has near-misses, not as many as `1 / tol`.

In the common case there are none at all, because there is no search: with no
relative rotation `f` is polynomial and its roots come in closed form. Pure
erosion, which is the core mechanic, is entirely inside that case.

The cost of one is a stretch across which the topology happens not to change:
duplicated buffers, identical connectivity either side of the keyframe, nothing
rendering differently. That asymmetry is the whole reason the search is built to
over-report — a redundant keyframe costs bytes, a missed one tears geometry.

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

Final CSG output vertices are of exactly two kinds, and both reduce to entries
in the vertex table:

- `Original(v)` — evaluate `p(t)` for that entry.
- `Cross(a, b)` — evaluate `p(t)` for the four endpoints of the two edges, then
  solve the 2x2 line intersection. About ten multiply-adds.

Within a stretch the two edges are guaranteed to still meet inside their
segment bounds, because an endpoint passing through the other edge is an event
and would have ended the stretch.

A table entry is not necessarily a source vertex. For an ungrouped polygon it
is; for a member of an eroded group it is a vertex of that group's eroded union,
which may itself have been a crossing between two members. Which of those it was
is the CPU's business — by the time the shader sees an entry, both are two
positions to interpolate between. This is deliberately where the two levels of
provenance stop: the bake resolves the inner one into positions rather than
composing tags, so no reference ever carries a chain behind it.

### Data layout

Per stretch:

- **Transform table** — one slot per distinct transform in the scene, in
  component form at both ends: translation (2), rotation (1), scale (2). Five
  floats each end, ten per slot. A group's transform is one slot however many
  vertices sit under it.
- **Chain table** — per polygon, the transform slots that apply to it, innermost
  first, up to the nesting limit. A handful of indices, sized by polygons rather
  than by vertices.
- **Vertex table** — `local` at both ends (4) and a chain index (1). Lives in an
  SSBO or texture. Entries are the inputs to the final CSG: source vertices for
  an ungrouped polygon, eroded-union vertices for a grouped one.
- **Ring index buffer** — per output vertex: a kind flag, one or four vertex
  table indices, and `lineOpacity` at both ends. Around twenty bytes.

**Group nesting is bounded, not flattened.** A vertex reads its chain and
applies each transform in turn, interpolating every level in its own components.
The limit is **four levels**, and the editor says so in the status line rather
than silently failing when a fifth is asked for.

The alternative was to flatten the chain into one composed transform per vertex,
which does not work as cleanly as it looks. Composition is not closed in
`(translation, rotation, scale)` — rotate, squash, rotate again is a shear — so a
flattened slot needs a general matrix, and interpolating one entrywise slews
through a shear and collapses a rotating polygon through its own centre. Storing
a polar decomposition instead avoids that, but it has to re-extract an angle
into a principal range, so a composed rotation past half a turn unwinds the
wrong way; and once two levels carry non-uniform scale the composed rotation
stops being the sum of the levels' angles, so the intermediate frames are no
longer what per-level interpolation would give.

Keeping the levels makes all of that go away by construction. Each level is
authored, so its angle is already unwrapped and its scale is already in
components, and the shader reproduces `geometry(t)` exactly at any nesting depth
rather than approximately. The price is a bounded loop — four iterations at
worst, one in the overwhelmingly common case — and one indirection through the
chain table.

Four is chosen low on purpose. Deep nesting is a legibility problem before it is
a performance one, and the limit is trivially raisable later without breaking
worlds, where lowering it would not be.

Output vertices carry indices rather than data, so a crossing costs four
lookups rather than four copies. Connectivity comes from the baked ring; the
shader only positions.

A side table records each stretch's byte offsets and the `t` range it spans. The
countdown maps to a global `t`, which selects a stretch and a normalised
position within it. Running backward for the reversal artefact is the same table
read in reverse.

### Easing is a runtime concern

Whatever shape the transitions have — ease in and out of each version, hold, snap
— is entirely a question of how the countdown maps to `t`, and the bake neither
knows nor needs to. `geometry(t)` is exact at every `t`; easing only chooses
which ones get looked at.

This is safe rather than merely convenient, because **the mapping is monotonic**.
A monotonic reparameterisation cannot create or destroy a topology event or
reorder two of them, so the completeness the event search guarantees in `t`
carries over unchanged. That is the whole condition. An easing that overshoots
its endpoints — the elastic and back families — would sample outside the baked
range and has to be clamped; running backward is fine and already supported.

Easing each version transition separately rather than the run as a whole needs
the version boundaries in `t`, and the side table already carries them, since
every version boundary is a keyframe.

### lineOpacity

A vertex that does not exist across a whole stretch is still present in that
stretch's ring, positioned on the edge between its ring-neighbours at its
parametric position, with `lineOpacity` 0. Because births and deaths land
exactly on keyframes, the line fades in over precisely the stretch where the
vertex is emerging.

A vertex dying to an edge collapse is the same case seen from the other side:
the edge reaches zero length exactly at the keyframe, so it fades out over
precisely the stretch in which it is vanishing, and there is no pop at the
moment the vertex leaves the ring. Polygons are still never split at bake —
erosion caps below the split depth, and a one-ring shape cannot be morphed into
a two-ring shape without an event to do it at.

Ring merges and splits need no special case: they are events, so they get a
keyframe, and on the merged side the passage's vertices sit on the wall as a
zero-width bridge until the event opens them.

### Steps

1. Walk `activeBranch` to the root; resolve each version's layer chain,
   sequentially, stage by stage.
2. Project each version's sources through their depths, recording the
   collapse and split depths on the way.
4. Collect the known events — version boundaries, births, deaths, collapses,
   caps.
5. Search on `t` for the geometric events — crossings appearing or disappearing,
   rings merging or splitting — in the final arrangement and inside every eroded
   group.
6. At every keyframe, CSG the resolved rings — union `level`, subtract
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

### The bake combines projections, and provenance stays one level deep

What the bake combines at a keyframe is each version's **projection** — the
decomposed, offset `Shape` — not the source rings. Its vertices are entries in
the vertex table, carrying positions the CPU has already computed.

That is what keeps provenance one level deep. The inner step, which decomposes a
possibly self-crossing source and offsets it, is resolved into numbers before
the combine ever runs, so only the outer combine emits tags and no reference
ever carries a chain behind it. An earlier draft combined `Entry.source`
directly to avoid exactly that chain, and had to assume simple input to do it;
resolving the inner level into positions gets the same result without the
assumption.

Winding is normalised at the source, once, so the bake can assume it. Holes are
modelled as `solid` polygons rather than as reversed rings.

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

**worldset** — both paths simplify, since a source ring is allowed to cross
itself; `Entry.shape` is where that lands. One instance per version, computed lazily, kept warm only for the
current version and visible ghosts. A single global set cannot work: v0's and
v3's walls must never union with each other, and AABB clustering will not
separate them since v3 sits inside v0. An upstream edit fans out as an
incremental update per version, but the fan-out is far smaller than it looks,
because a version whose chain does not touch a polygon has identical resolved
geometry for it and is skipped.

**Composing the chain instead of walking it.** The semantics are sequential and
should stay that way, but the projection makes the chain collapsible, and that
is worth exploiting for a long one. Writing a layer as `T_k(x) = M_k x + t_k`
over `source(k) = T_k(source(k - 1) + e_k)`, affinity gives
`source(k) = T_k(source(k - 1)) + M_k e_k`, and unrolling gives

```
source(k) = (T_k ∘ … ∘ T_1)(P)  +  Σ_j (M_k ⋯ M_j) e_j
```

One composed affine applied to the points once, plus each version's vertex edits
pushed through the linear parts of every transform after it. Exact rather than
approximate, so `resolve(9)` needs no intermediate geometry: matrix products
down the chain, then a single pass over the points.

Erosion is exactly what used to block this. As a stage its output had to exist
before the next stage could read it; as a projection it reads `source(k)` and
writes nowhere, so there is nothing to serialise.

No constraint comes back with it. The composed map is a general 2x2 and
composition of those is closed, so per-axis scale is untouched — components are
kept separate for *interpolation*, and the bake never interpolates an
accumulated transform, since every version boundary is a keyframe and the one
in flight is stored per version in component form.

Two things to hold on to. **This is an equivalence, not the model.** The last
time this document had an accumulation it was written as the formulation, and
constraints grew to protect it — uniform scale only, frozen bisectors, the
per-edge encoding. Kept as an identity that may be exploited, anything later
needing a stage that does not compose costs a slow path rather than an argument.
And **the vertex set still wants the chain walk**: adds and removes change which
vertices exist, so the composed form applies to whatever ring exists at *k*.
That walk is set operations rather than geometry, so O(1) resolve is really
O(chain) in sets and one pass in points.

**Serialization** — plain JSON with arrays in place of `Map` and `Set`, rebuilt
on load, behind a format version number.

## Known limits

**Long-chain intent drift.** An edit at v0 reshapes every downstream delta. The
strip can say *what* changed; it cannot say what is now artistically wrong. No
mechanism is planned for v1 — the visibility eyes are the review tool — and this
is the most likely thing to need revisiting once worlds get long.

**Exactness when a squash and an erosion share a stretch.** The offset direction
depends on the source's edge directions, so a source that is being reshaped
non-rigidly while the depth changes moves its projection non-linearly, and
interpolating the two stretch endpoints approximates there rather than
reproducing. Pure erosion is exact, and so is erosion under translation,
rotation or uniform scale, because a rigid motion carries the bisectors with it
and the transform is factored out anyway. Only a squash is affected. The fix is keyframe density — make a squash a version
boundary so no stretch carries both — and the bake's posture is already that a
redundant keyframe is harmless while a missed one tears geometry.

**Strip layout at scale.** Twenty versions across three branches will not fit.
Scrolling plus collapsing untouched runs, settled against a real strip rather
than on paper.

## TODOS / Questions

- The morph property test in `geometry.test.ts` covers uniform scale only. It
  needs a per-axis case, and one where a group's eroded union is the input.

- Show available options during edit in the status bar
