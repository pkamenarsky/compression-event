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

### Nudges

`Edit.vertices` holds per-vertex displacements against the geometry the base
resolved to, and a layer applies them **first** — before its own erosion, before
its own transform. So eroding after nudging erodes the shape that was actually
made, and a nudge is an ordinary part of the ring by the time anything else
looks at it: erosion reads it, the CSG sees it, and it is subject to the same
simplicity check as any other edit.

They are held in the polygon's local frame, so a nudge turns with its polygon
when an upstream version moves it.

#### Dragging a vertex on an eroded polygon bakes the erosion

Nudging first is right, but it leaves the drag itself to answer for, because a
displacement applied *after* an erosion makes that edge stop offsetting parallel
to itself. Without a nudge, `a + d·b_a` and `b + d·b_b` keep the edge between them parallel
to `ab` at every depth. Add a fixed displacement `n` to one end and the
direction becomes `(b - a)(1 + dλ) + n`: the first term scales with the depth
and the second does not, so scrubbing the erosion makes that wall pivot instead
of retreating.

So dragging a vertex of a polygon whose erosion is non-zero **resolves it
first**: write the eroded ring into this version's vertex positions, set the
layer's erosion to zero, and then drag as an ordinary edit. Everything after
that is the un-eroded case — the vertex lands exactly under the cursor, nothing
else moves at all, and there is no constraint on where it may go.

The author's model is the whole reason for doing it this way. Somebody who has
eroded a room and wants to move one corner has no notion of a pre-image and
should not acquire one. Solving for the source point that erodes to the cursor
is possible in closed form — the two adjacent edge lines have to be tangent to
the circle of radius `d` about the target, which is elementary and exact to
about 1e-14 — but it is undefined when the target comes within `d` of a
neighbour, and it moves the two adjacent vertices, because their bisectors
genuinely depend on the point being dragged. Both are correct geometry and
neither is explicable to somebody who just wants to move a corner.

What is lost by baking is the depth, not accuracy. The bake is one rounding, at
about 1e-16 relative, and it does not compound. But the layer no longer records
*how far* it eroded, so that slider cannot be scrubbed back afterwards — the
version now says what the shape is rather than how it got there. This is the
same trade as hand-moving the vertices to shrink a room, which is a first-class
thing to do, and it is not delinking: the polygon still inherits from upstream,
and the positions are still an edit like any other.

It should be visible when it happens. Silently zeroing a parameter the author
set is the kind of thing that is discovered a week later.

**Only `Original` vertices take nudges.** A crossing has no degree of freedom of
its own — it is a function of the four endpoints of two edges — so there is
nothing to write to. Giving it a slot would mean giving it an identity,
`Cross(a, b)`, that geometry destroys rather than the author: slide a member and
the crossing stops existing, leaving exactly the inert orphaned edit that
Lifetime rules out. Cascading it away on a drag is worse than the orphan, because
every other cascade in the system fires from an explicit removal.

This only arises on the boundary of an eroded group, since a polygon's own ring
has nothing but its own vertices. Crossings there draw as a different kind of
handle and are not grabbable. Shaping the outline is done by inserting a vertex
on a member's edge — a real edit,
on a real ring, minting a real id — after which the crossing moves as a
consequence, continuously. This keeps a useful invariant for the bake: the set
of things that can be dragged and the set of things that carry stable ids are
the same set, which is what lets crossings appear and disappear at keyframes
with no edit ever needing to be cleaned up.

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

A layer applies its transform in one order, always: **erode first, in the frame
it was handed, then scale, rotate and translate**. Erosion has to come first or
it would be measured in a frame the squash had already distorted.

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
Under sequential resolution there is no correspondence to destroy: each version
erodes the ring it was handed and passes on the ring it produced. A vertex that
died upstream is simply not in what arrives, which is the same thing a birth or
a death already is elsewhere in the model.

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

### Erosion stops at a split

A reflex vertex whose bisector reaches an opposite edge is a *split* event: past
that depth the polygon would divide in two, which would leave a polygon id
naming two rings and every downstream edit on it ambiguous.

So the depth is **capped**. Each polygon has a maximum erosion, found the same
way every other event is found, and asking for more than that gets the shape at
the cap. Walls stop when they meet; they never pass through each other.

That is blunt on purpose. A long room with one narrow neck stops eroding
everywhere once the neck closes, not just at the neck. The alternative is to cap
locally, which is the clamping fixpoint this replaced — more machinery, and it
buys back the edge rotation the section above just got rid of. Reshaping past
the cap is done by moving the reflex vertex, which is a thing the author can see
and reach.

There is no fixpoint and no iterative solver. The cap is one number per polygon
per version, recomputed by the ordinary forward resolve, including during a
drag.

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
- **Erosion.** Cannot break it: the depth is capped below the first split.

Soft during the gesture, hard on commit. The rubber band turns red while it
crosses, with a dot at the intersection and both offending edges lit, and
releasing there does not place the point. A vertex drag *is* allowed to cross
transiently — you often move a vertex across the polygon to a valid spot on the
far side — but reverts on release if still invalid. Anything invalid that gets in
anyway carries a hatched outline and a strip badge, and export refuses.

Zero-length edges left by a collapse are fine and stay for the stretch in which
they vanish. Collision already has to survive corridors narrower than the
player, and the stray line a degenerate edge would draw is handled by
`lineOpacity` at bake.

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

**What was rejected, and why it is worth recording.** The tempting encoding is
to push the erosion back onto the members: work out which source edges lie on
the union boundary, and give those edges an offset of `d`. It fails twice, and
both failures are the same confusion — between an edge and the piece of boundary
that edge contributes.

A source edge partly buried in a sibling contributes only part of itself, but
the encoding offsets the whole line. The buried part moves too, and if it lay
within `d` of the sibling's far boundary it sweeps past and opens a gap that
should not exist. Worse, an edge *emerging* from behind a sibling contributes a
boundary piece whose length starts at zero — so offsetting the whole line moves
the entire edge the instant that piece exists. Drag a member one unit and
geometry elsewhere in the group jumps by `d`: a discontinuous, non-local
response to a continuous input, and unexplainable to the person making it.

Neither artefact is inherent to group erosion. `erode(union, d)` is continuous
in member positions away from genuine topology events, and those the author
causes and understands. Both are manufactured by the encoding, which is the
argument for not having one.

**The split cap is the union's, not each member's.** Once the union is one ring
being offset normally, a member's edge meeting another's is not a special case
at all — it is the same reflex-vertex-reaches-an-opposite-edge event as any
other, on that ring, and the group stops eroding there. Nothing is scoped per
polygon, which is what keeps the artefacts above from reappearing through the
back door.

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
to *be* a group, and the UI offers to make one rather than pretending otherwise.

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
and offsetting. Bisectors are constant within a stretch, and both an edge
collapsing and the split cap are keyframes, so the piecewise break never lands
inside one. The old per-vertex
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
accumulation of the chain. Every version boundary is a keyframe, so at most one
version's layer is partway applied across any stretch, and everything before it
is already inside `local`. That is why transforms never have to compose, and
therefore why they are free to be non-uniform.

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
- **erosion reaches its split cap** — the polygon stops shrinking
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

- **Polygon table** — the in-flight transform components at both ends: five
  floats each end, ten per polygon. A grouped polygon carries its group's
  in-flight transform too, applied after its own in scene-graph order.
- **Vertex table** — `local` at both ends (4) and a polygon index (1). Lives in
  an SSBO or texture. Entries are the inputs to the final CSG: source vertices
  for an ungrouped polygon, eroded-union vertices for a grouped one.
- **Ring index buffer** — per output vertex: a kind flag, one or four vertex
  table indices, and `lineOpacity` at both ends. Around twenty bytes.

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
2. Find each polygon's split cap and its edge-collapse depths.
3. Refuse on any invalid polygon.
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

**Exactness when a squash and an erosion share a stretch.** Erosion applied
after a non-uniform scale is not linear in that scale, so interpolating the two
stretch endpoints approximates there rather than reproducing. Every other
combination is exact. The fix is keyframe density — make a squash a version
boundary so no stretch carries both — and the bake's posture is already that a
redundant keyframe is harmless while a missed one tears geometry.

**Strip layout at scale.** Twenty versions across three branches will not fit.
Scrolling plus collapsing untouched runs, settled against a real strip rather
than on paper.

## TODOS / Questions

- Undo "`worldset` already keeps both — `Entry.source` is the polygon exactly as it came
in, and `Entry.shape` is a simplified copy" after enforcing non-self-intersection invariant

- How many false positive keyframes can theoretically be generated during the topology event search?

- A vertex dies when an upstream depth is scrubbed up, so a downstream edit can
  be left naming an id that no longer arrives. The removal cascade covers this
  mechanically, but it fires from dragging a slider rather than from an explicit
  removal, and a depth is easy to scrub back. Flagging the edit is probably
  better than dropping it — undecided.

- How does a vertex nudge work on a polygon inside an *eroded group*? The bake
  above resolves a polygon's own erosion into its points, but a group's erosion
  lives on the union boundary and does not map back onto member rings. Either
  members are not vertex-editable while their group's erosion is non-zero, or
  something else is needed. Unresolved, and the one place the group story is
  still open.

- Is the split cap too blunt? It stops a whole polygon because of one neck. The
  local alternative is the clamping fixpoint that was just removed, so this is
  worth living with first and revisiting against a real level.

- Where does a selection erode get stored? Groups are global structure, so a
  version cannot mint an anonymous one, and erosion does not distribute onto
  members. Current answer is that the UI offers to make a real group; worth
  revisiting if that turns out to be friction rather than clarity.

- How many levels of nested group transform should the shader apply, and is it
  cheaper to flatten them at bake? The polygon table currently assumes at most
  own-plus-one.

- The morph property test in `geometry.test.ts` covers uniform scale only. It
  needs a per-axis case, and one where a group's eroded union is the input.

- Disallow the creation of zero area and self intersecting polygons both when creating a polygon and when editing
