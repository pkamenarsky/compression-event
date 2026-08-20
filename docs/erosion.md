# Erosion: from design to a working editor

A session's worth of decisions, in the order they were made. [versioning.md](versioning.md)
is the spec this arrived at; this is the reasoning that got there, and what of
it is actually built.

## Starting problem

Worlds shrink over time, but not algorithmically — authoring is artistic, so a
later version is *derived* from an earlier one without being *computed* from
it. Copying geometry per version means every upstream edit has to be replayed
by hand into every later version. The whole thread is about avoiding that
without the result becoming unpredictable or hard to learn.

## The propagation model

Considered a full backward/forward edit-span system — drag handles on a
version strip choosing which versions an edit reaches, pushback through
erosion's inverse via Newton's method, rank-deficient Jacobians for clamped
vertices. Dropped it. The forward-only model — **you edit the version you're
standing in, edits flow forward, ghosts show you the consequences live** — does
almost the same job for an audience that isn't expected to have prior
level-editing experience, and it deletes the hardest subsystem in the design
along with about a third of its edge cases. Precision at a distant version is
the real cost; ghosts mitigate it.

Versions became Illustrator-style layers with per-version eye icons rather
than a fixed onion-skin mode, which folds "pin an arbitrary version for
comparison" into the same mechanism as normal visibility.

## Erosion itself

The mechanic that forced most of the interesting decisions.

**Clamp, never remove.** The classic straight-skeleton algorithm deletes a
vertex when its edges collapse and recomputes its neighbours' bisectors. That
recomputation is what breaks vertex correspondence between versions, which
the interpolation, the bake, and the whole "same id, same thing" model all
depend on. Instead each vertex clamps at its own collapse depth and stays in
the ring as a coincident point — the polygon pinches shut rather than folding
into a bowtie.

**Freeze the bisectors.** Not recomputing them after a clamp isn't just
simpler, it's more correct: an edge with both endpoints free stays exactly
parallel to where it started, and distortion is confined to the vertices
actually touching a clamp. Frozen bisectors are also what makes erosion
*additive* — eroding by `a` then `b` lands exactly where eroding by `a + b`
would, so a whole version chain collapses into one closed-form expression
instead of a rounding chain with one step per version. That was the answer to
"can't we just combine transforms instead of stacking intermediate steps",
and it turned out yes, as long as bisectors don't move.

**Splits clamp too.** A reflex vertex reaching an opposite edge is a
different event from a collapse, and the editor never lets a polygon split in
two — splitting destroys the id that every downstream edit would be naming.
Clamping the contact region is a small fixpoint (clamp, re-resolve, repeat
until no new contacts), free at the vertex counts involved.

**Self-intersection is disallowed by invariant**, not defended against
everywhere. Collision is edge-normal based, so a bowtie pulls the player into
the wall rather than pushing them out.

**Scale had to become uniform.** Non-uniform scale doesn't commute with
offsetting — normals don't transform covariantly — so allowing it would have
forced materializing intermediate geometry at every squash, defeating the
additive-erosion result. Squashing is still reachable by moving vertices by
hand; removing the whole mechanism was worth it for keeping erosion closed-form.

## Provenance through the CSG

The rendered geometry is a boolean combine, not the source polygons — two
`level` rects merge into a room with an opening. So the identity that erosion
gets from stable vertex ids has to survive a boolean operation whose output
vertex count bears no relation to its input's.

It does, because every point a `combine` produces is one of exactly two
things: an original source vertex, or the intersection of two named source
edges. Both are expressible purely in terms of already-stable ids. **Built** —
`combineTagged`/`simplifyTagged` in [geometry.ts](../packages/editor/src/geometry.ts),
alongside the plain entry points which now delegate to them.

The motivating worry was a rotating pillar cutting a wall: does the tag set
for "the two crossings on this wall" ever have to represent an impossible
swap? Worked the geometry and it doesn't — a pillar centred on the wall always
produces exactly two crossings, and as it turns, each corner sweeping through
the wall hands a crossing from one edge to the next. Each handoff is a real
topology event, not a same-tag reordering, so the keyframe mechanism the bake
needs falls out of what already has to be tracked rather than being a
special case for this scenario.

## The bake's interpolation

The game lerps between versions in a vertex shader rather than switching
instantaneously. That only works if consecutive keyframes agree on vertex
count and order, which is exactly the tag correspondence above, plus a
decision about *where* keyframes go: at least at every topology event — a
crossing appearing or disappearing, a ring merging or splitting.

**Built** — [bake.ts](../packages/editor/src/bake.ts), and not by root-finding
in the end. Locating the events analytically was built first, with interval
arithmetic for the completeness sampling cannot give, and it found every event
it was written to find. It was still not enough, because a stretch can go wrong
without any event in it: a corner rides its mitre, the mitre depends on the
corner angle, and nudging a vertex while the polygon erodes turns that angle —
so the path bends and the chord across the stretch cuts the bend, with nothing
discrete happening anywhere. The CSG's own run decomposition can shift with no
coincidence nearby either.

So the bake measures. It evaluates `csg(t)` inside every candidate stretch,
compares it against what the stretch would have drawn there, and splits until
the difference is under 0.05 world units. Splitting stops on width too, and an
interval whose two sides never come to agree is handed back as a gap — which is
the keyframe, found without having to know what kind of event made it. A span
reports the worst it ever measured, and
[divergence.test.ts](../packages/editor/src/divergence.test.ts) checks that again
at 998 instants the bake did not look at.

Keyframes are **per polygon**, not per level. A polygon's share of the outline
depends only on the polygons it overlaps, so its keyframes do too, and a room
losing a corner is no business of a room at the other end of the map. Cutting
the level as one thing made both the bake and the file grow with the square of
it — every event anywhere ended the stretch for everybody, and every keyframe
then stored every polygon's outline, nearly all of it unchanged. A thousand
polygons with two thirds of them moving measured at twenty-odd minutes and half
a gigabyte for one span; cut per polygon, against a neighbourhood of about five,
the same span is half a minute and four megabytes. The neighbourhood is chosen
from where each polygon can reach across the whole span, not from where it
happens to be at either end.

## The editor, built and verified live

[canvas.ts](../packages/editor/src/canvas.ts) was rewritten from two canvases
with separate interaction loops (a world canvas plus a transparent selection
overlay) into one canvas with one loop and drawing expressed as an ordered
list of layer functions. The two-canvas split meant two places could decide
what a press meant with no way for either to know what the other was doing;
collapsing it also made "add something to look at" mean "add one function to
a list" instead of touching a second component.

Implemented and confirmed working in the browser:

- **Point tool** — click to lay down vertices, rubber-band to the cursor,
  click the first point to close. Grid-snapped.
- **Polygon tool** — click to select; hold `t`/`r`/`s`/`e` and move the mouse
  to translate, rotate, scale, or erode the selection, recomputed from the
  transform each gesture started with so it can't drift; `1`/`2` retype
  `level`/`solid`.
- **Live CSG overlay** — the unioned-and-subtracted set the game would
  actually see, drawn in yellow over the source outlines, recomputed on every
  frame of a drag. Confirmed moving, rotating, and eroding a `solid` pillar
  cuts a live, correctly-shaped notch out of a `level` room while dragging.
- **`o`** — downloads the entire `EditorState` as JSON
  ([save.ts](../packages/editor/src/save.ts)), specifically so a world
  producing a wrong CSG result can be handed over as the numbers that produced
  it rather than described from a screenshot. Round-trips exactly
  (`restored(saved(s)) === s`), keyed by polygon id rather than array
  position so ids survive the trip, and refuses a file whose format number it
  doesn't recognise instead of half-reading it.

### The bug this caught

A user-drawn pair of overlapping triangles, one wound clockwise and one
counter-clockwise, unioned into two rings instead of one — the overlap
cancelled to a *hole* under the nonzero fill rule instead of merging, leaving
the wall between them on screen. `worldset`'s live path never hits this
because it runs `simplify` per polygon on the way in, which normalises
winding as a side effect; the new editor's live CSG combined source rings
directly and skipped that.

Fixed in [scene.ts](../packages/editor/src/scene.ts) by normalising each
ring's winding, read from **the points as drawn**, not from the resolved ring
on screen — reading it off the resolved ring would flip an over-eroded
polygon back to agreeing with its neighbours and add ground back where a room
had erosion-collapsed through itself. Regression-tested with the user's exact
triangle coordinates, plus all four winding combinations for union and
subtract.

## Discarded approaches, and the edge cases that killed them

Each of these was worked through in enough detail to hit a concrete failure,
not just judged too complicated in the abstract.

**Backward edit propagation via a two-ended span slider.** Promote a delta
toward the root by re-targeting which layer it lives in; truncate it downstream
by writing a counter-edit. Dropped for the forward-only model. What it would
have had to handle:

- A vertex born at v3 can't take a span reaching back to v0 — nothing to edit
  there — so every handle needs a lifetime bound, and the UI has to explain why
  a handle stops where it does.
- Pushing a geometric delta back through intervening erosion has a
  rank-deficient Jacobian wherever a vertex is clamped: some directions move
  the downstream result, others don't, and the degenerate ones have to be
  detected and drawn as locked rather than silently absorbed.
- Promoting toward the root crosses fork points, so the edit lands on every
  descendant of that ancestor, including inactive branches the strip has to
  mark or the user won't know it happened.
- A promoted delta can conflict with a downstream edit already touching the
  same vertex — compose under it, or clear the override, and the UI needs a
  visible choice rather than picking one silently.
- Truncating writes a counter-edit that accumulates over time, is invisible in
  the canvas, and needs its own garbage collection when the delta it cancels is
  later undone.
- A multi-selection spanning several birth versions has no single valid span,
  so the control needs a defined mixed state rather than picking the tightest
  or loosest bound arbitrarily.

**Newton's method for the erosion inverse**, needed only because of the above.
Fell away with it, but it had already surfaced its own edge case: the clamp is
a kink in the derivative, not a discontinuity in position, and iterating across
it oscillates unless the branch is picked once at grab time and held for the
whole drag.

**Non-uniform scale.** Normals don't transform covariantly under a squash, so
offsetting a non-uniformly scaled polygon isn't the squashed offset of the
unscaled one — the erosion accumulation would have had to materialize
intermediate geometry at every scale change instead of staying a closed-form
expression in the coefficients. One transform component removed an entire
class of required special-casing; squashing by hand-moving vertices was judged
cheap enough to lose.

**Bake-time removal of zero-area lobes, and allowing a polygon to split into
two at bake.** The motivating problem was real — a degenerate neck left a
stray vertical line down the middle of a wall — but splitting was the wrong fix:

- A split destroys the id every downstream edit names, so a polygon that
  splits at v4 leaves every edit from v5 onward ambiguous about which half it
  meant.
- Interpolation needs matching vertex counts on both sides of a stretch, and a
  one-ring shape cannot be lerped into a two-ring shape without an event to do
  it at — which a lobe simply vanishing is not.

Replaced by a per-vertex `lineOpacity`, which was already needed for births and
deaths and turned out to cover this for free: a degenerate vertex just fades
out as the neck closes.

**A single world-spanning `worldset`**, one CSG covering every version at
once. Considered because an incremental global structure sounded appealing, but:

- v0's walls and v3's walls must never be unioned with each other even though
  v3's geometry sits spatially inside v0's, so one shared set would produce
  garbage the moment two versions' polygons overlapped in screen space.
- AABB clustering — the mechanism `worldset` already uses to avoid O(n²) CSG —
  cannot separate them either, for the same reason.

Replaced by one `worldset` instance per version, computed lazily and kept warm
only for the current version and visible ghosts.

**Cherry-pick and merge between forks.** Mechanically nothing stops a version
from being re-parented — it resolves fine as long as the ids its layer names
still exist — but the blast radius is invisible from the UI a newcomer would
be looking at, and re-parenting semantics (what happens to a version whose
*old* base diverged from its *new* one) were never worked out. Dropped for an
audience that isn't expected to reason about a DAG.

**Orphaned edits staying inert rather than being deleted.** The original
reasoning was undo purity — deleting a polygon shouldn't need to record every
edit it cascades away just to stay invertible. But:

- An edit sitting inert for an hour and then silently reapplying because the
  polygon it named got revived (undo, or an id reused by a paste) is a worse
  surprise than a slightly heavier delete operation.
- Inert edits have no natural place to be seen or cleared, so they accumulate
  as invisible state with no cleanup path.

Replaced by cascading delete: removing an entity also removes every edit that
named it at that version or later, with the whole set carried in the undo
entry so invertibility is still free.

**Sampling and sign-change bisection for finding topology events**, before the
interval-arithmetic search. Two cases broke it outright and are exactly the
ones the completeness tests target:

- A corner grazing an edge without crossing through it is a double root — `f`
  touches zero and turns back — so it never changes sign and a sign-change scan
  cannot see it at all, at any sample density.
- Two events closer together than the sampling interval both fall inside one
  bracket and both are missed; a 2,000-sample scan step could straddle a pair
  1e-5 apart without either registering.

Replaced by bisection over provably-safe intervals: a range is only discarded
once its enclosure has been shown not to contain zero, which cannot miss a
graze or a close pair the way a finite sample set can.

**Piecewise-linear approximation of `geometry(t)` with adaptive subdivision.**
The first version of the bake's interpolation plan treated the exact CSG(t)
curve as something to approximate between keyframes, tightened by a tolerance
parameter. It was live when the rotating-pillar "impossible ordering swap" was
first raised as a blocking concern, and it would have needed:

- A tolerance knob with no principled default, trading keyframe count against
  visible error, that someone would have had to tune per world.
- Extra subdivision specifically to keep the approximation error down near a
  rotation, since `cos`/`sin` make the true curve non-polynomial.

Replaced once transform components were interpolated directly rather than
final positions: translation, rotation and scale coalesce into one `Transform`
per stretch, and the shader reconstructs `geometry(t)` exactly rather than
approximating it, which deleted the tolerance parameter entirely rather than
just tuning it.

**Two canvases with two independent interaction loops** — a world canvas plus
a transparent selection overlay stacked on top with `pointer-events: none`
routing clicks through to the one underneath. Concretely:

- Both loops could in principle want to interpret the same press, with no
  shared state to say which one owns it — coordinated only by which one
  happened to have `pointer-events` enabled at the DOM level.
- Anything new that needed to draw over the scene meant deciding, again,
  whether it needed its own canvas and its own event routing.

Replaced by one canvas, one loop, and drawing expressed as an ordered list of
layer functions, so a new thing to look at is one function added to a list
rather than a new component with its own interaction surface.

**Reading a polygon's winding off its resolved, on-screen ring** rather than
off the points as originally drawn, when normalising winding for the live CSG.
The failure case: a polygon eroded past its own middle turns itself
inside-out, and its resolved ring's winding flips as a result — reading
winding from that ring would flip it *back* to agreeing with its neighbours
and silently add solid ground back where the polygon had collapsed through
itself. Fixed by reading winding from the source points, which stay fixed
regardless of what erosion does to the resolved shape.

**Running the bake's CSG over `worldset`'s pre-simplified `Entry.shape`**
rather than over the untouched `Entry.source`. `worldset` already keeps both,
and simplify's pre-pass exists to protect the live editor from
self-intersecting input — but a tag produced by combining already-simplified
rings would name edges of the *simplifier's* output, not of the author's
polygon, requiring a second layer of provenance chained behind the first for
no benefit once the editor enforces simplicity as an invariant on its own.
The bake reads `source` directly; the editor's live path keeps the pre-pass
until that invariant is actually enforced on drawing and dragging.

## What is designed but not built

- **The layer/version model itself.** Everything above renders straight from
  `world.sourcePolygons`; `World.versions` is untouched. This was always the
  next step, not this session's.
- **Clamping fixpoint** in the live editor. `erode` in `geometry.ts` freezes
  bisectors and accumulates correctly but doesn't clamp, so a polygon eroded
  past its own middle turns inside out rather than pinching shut. Both
  behaviours — including the case where collapsing on two axes at once
  cancels out and *adds* ground instead of removing it — are pinned in tests
  so the clamping work has something concrete to change.
- **Groups, forks, undo, delinking, artefacts.** Specified in
  [versioning.md](versioning.md); none implemented yet.

## Session two: fixing the drag bug led to rethinking erosion under versioning

Started from a concrete complaint: creating a polygon, rotating it, then
dragging a single point in point mode wiggled every other point. Same for
scale; erode was worse, off from the cursor by an amount tracking the erosion
factor.

### The immediate bugs, fixed in code

**The pivot was derived from editable geometry.** `resolve`/`toLocal` computed
their rotation/scale pivot as `centroid(p.points)`. Dragging a vertex moves the
centroid, and every other vertex swings by `(I - scale·R)·Δcentroid` — zero
while the polygon is untouched, which is why it only showed up after the first
rotate or scale. Fixed by moving the transform's frame to the world origin and
having each gesture bake its own pivot into the translation at grab time
([scene.ts](../packages/editor/src/scene.ts), [canvas.ts](../packages/editor/src/canvas.ts)).

**Erosion's handle and its write target disagreed.** Vertex handles were hit
against the *eroded* ring, but `toLocal` deliberately does not undo erosion, so
the value written was a point on the *source* ring — off by the erosion depth
along that vertex's bisector.

**Winding moved into the constructor.** `facing()` in `scene.ts` re-derived
winding from the resolved ring on every CSG; replaced by `sourcePolygon()`
normalising winding once at creation, so `csg()` no longer needs to care.

**Stale pointer after a modal gesture.** Rotate, release, press `r` again
without moving the mouse: a visible jump. `pointer` was tracked only in the
top-level `select`'s `tracking` branch, which is torn down for the duration of
every gesture — so it froze at wherever the cursor was when the gesture key went
down. Moved to `Input.pointer()`, a single `pointermove` listener alive for the
editor's lifetime ([input.ts](../packages/editor/src/input.ts)).

A `nudges: Point[]` array was added to `Polygon` at this point, applied *after*
erosion, so a vertex could be dragged exactly under the cursor at any erosion
depth without an inverse. **This is now stale** — see *What changed in code vs.
what the design settled on*, below.

### Sequential resolution replaces the accumulated coefficient

Investigating erosion's failure modes surfaced that the original per-vertex
accumulated coefficient — `coefficient(v) = Σ d_k / s_k`, collapsing the whole
version chain into one expression — was the thing forcing every erosion
constraint downstream of it: uniform scale only, frozen bisectors, and (once
group erosion came up) no way to erode a union at all.

Re-examined what accumulation actually bought:

- **Floating point.** Sequential evaluation rounds once per stage; at the chain
  lengths this design expects (tens of versions), the difference against one
  rounding is around 1e-15 relative. Real, but not load-bearing.
- **Determinism.** Argued to require the closed form; it doesn't. Memoizing a
  pure function is transparent — `resolve(9)` reached from a cached `resolve(5)`
  walks the same stages in the same order as one reached from the root, so
  bit-identity comes from fixed evaluation order, not from collapsing the chain.

Neither survived scrutiny as a reason to keep the constraints. Replaced with
`resolve(v) = apply(v, resolve(v.base))`, walked and memoized, cached per
version so an edit dirties exactly the chain it's actually in.

**Non-uniform scale** came back as a direct consequence — nothing forced scale
to commute with anything once nothing was being collapsed — but transform
*components* were kept separate (`translation`, `rotation`, `scale: {x, y}`)
rather than folded into a general 2×2, because the bake's interpolation still
needs to lerp translation linearly, rotation angularly, and the two scales as
scalars; a matrix lerped entrywise slews through a shear and collapses a
rotating polygon through its own centre.

### Group erosion: what member-wise and per-edge encoding both get wrong

Wanted: eroding a group erodes it *as if it were one polygon*, and a selection
should be able to piggyback on that by becoming a group.

**Rejected: erode each member separately.** A corridor built from two
overlapping rectangles, eroded per-member, pulls back lengthwise at the join —
an overlap shorter than `2d` breaks the corridor in two; longer, it pinches.
Eroding the union pulls back only the outer boundary and the corridor holds.
The author can't see the seam that failed, because it's interior geometry
behind a wall that still looks intact.

**Rejected: push the offset back onto source edges on the union boundary**
(give each contributing source edge line an offset of `d`, evaluated the same
way single-polygon erosion is). Failed on the same confusion twice:

- A source edge partly buried in a sibling contributes only part of itself to
  the union boundary, but the encoding offsets the *whole line* — the buried
  part moves too, and if it sat within `d` of the sibling's far boundary, it
  sweeps past and opens a gap that shouldn't exist.
- An edge *emerging* from behind a sibling contributes a boundary piece whose
  length starts at zero — so offsetting the whole line moves the entire edge
  the instant that piece exists. Drag a member one unit; geometry elsewhere in
  the group jumps by `d`. Discontinuous and unexplainable, and manufactured
  entirely by the encoding rather than inherent to the operation — `erode(union,
  d)` is continuous in member positions away from real topology events.

This also raised, then answered, a caching worry: pushing the offset onto
source edges meant the boundary-set predicate would have to be snapshotted and
invalidated to keep `resolve` a pure function of stored data, which reopened
determinism and revision-tracking machinery for no reason once erosion stopped
writing anything back at all (see *Erosion as a projection*, below).

**Decided:** eroding a group computes `erode(union(members), d)` live at
resolve time, using the CSG already run for rendering. No new erosion
machinery — a union's boundary is a ring like any other, its vertices happen
to be crossings rather than shared corners, but each still has two adjacent
edges and a bisector.

**Selections** can piggyback on groups for a *transform*, because a rigid
motion of a set is a rigid motion of each member — it distributes, and a
virtual temporary group is a faithful description. Erosion does not
distribute, so a selection erode has nowhere to be written; **decided:** the
erode control greys out on a selection, with a status-line message to make a
group first.

### The long argument about vertex identity under erosion

This was the biggest back-and-forth, because "clamp, never remove" from
session one turned out to be wrong on its own terms once looked at directly.

**Rejected (this session): keep clamping as originally designed.** The
original argument for freezing bisectors was that it gives "the better
geometry" — conceded that only edges *touching* a clamp rotate. Worked
through directly: a true mitred offset (every edge line moves inward by `d`,
unconditionally) keeps **every** surviving edge exactly parallel to its
original, forever. Freezing is the thing that *breaks* that — a vertex pinned
at its collapse depth beside a still-moving neighbour drags the edge between
them off its own line. The old design had the comparison backwards.

**Rejected: true offsetting with vertices deleted on collapse, keeping no
identity for the dead ones.** Geometrically correct (parallelism holds
everywhere), but raised: which of a merged pair survives is an arbitrary
choice with real downstream consequences, since the survivor's edits silently
retarget onto a vertex that's now somewhere else — worse than losing the edit,
because nothing says it happened.

**Rejected: kill both endpoints of a collapsed edge, mint `Merged(a, b)`** as a
deterministic id derived from its parents, and cascade-remove or suspend the
parents' downstream edits. Solved the arbitrary-survivor problem but not
`resolve`'s new obligation to walk source-derived ids anyway — dropped once
the deeper problem was found (below).

**Rejected: freeze edges in contact rather than clamping vertices**, letting
every other edge keep moving (a genuinely good piece of geometry — a frozen
*line* stays parallel to itself the same way a still-moving one does, so
parallelism holds everywhere without exception, unlike vertex-clamping). But
its actual purpose was to *cap* erosion below a split, and that's blunt in the
wrong direction: a long room with one narrow neck stops closing everywhere
once the neck pinches, when the intuition (confirmed once raised) was that the
rest of the room should keep closing. Also motivated the question of whether a
split should be allowed to happen at all, rather than prevented.

**Rejected: allow the split, and name each resulting piece** so one lobe could
be deleted after the room divides. Two naming schemes considered:

- Index-based (`Split(originId, 0)`, `Split(originId, 1)`) — fails immediately
  under the identity principle: going from two pieces to three renumbers, and
  every edit naming a piece re-points at the wrong one.
- A path in a **split tree**, with sides labelled combinatorially (the two
  lobes are the two cycles through the pinch point, the one entered first in
  winding order is `0`) rather than geometrically. Stable under scrubbing a
  depth. Not stable under an upstream reshape that reorders which split
  happens first, which permutes the whole tree. Never adopted, but recorded as
  the fallback if the eventual answer (below) proves too coarse.

**The actual resolution, once seen: erosion should never have been feeding the
next version at all.** All of the above were fights about what happens to a
vertex identity that erosion destroys. The fix is that erosion doesn't get to
destroy any identity, because it's read-only:

```
source(k) = transform_k(source(k - 1) + vertexEdits_k)
shape(k)  = erode(source(k), depth_k)
```

`source` is what flows down the chain; `shape` is a view taken fresh at each
version and fed to nothing. This dissolved nearly everything above at once:

- Source vertices are immortal — erosion never writes back, so there's nothing
  to tombstone, no arbitrary survivor, no `Merged` id, no cascade firing off a
  slider drag.
- Erosion is trivially reversible — the depth is a number in a layer and stays
  one, scrubbable forever.
- Group erosion needs nothing written into members — already the answer above,
  now clearly *why* it works: nothing is ever fed forward, so there's nothing
  to keep consistent.
- Crossings need no identity, because they only ever appear in a read-only
  view.
- **Splits are simply allowed** — `resolve` returns a `Shape` rather than a
  `Ring`, the CSG already takes shapes, and no piece ever needs a name: wanting
  one lobe gone is expressed by editing the *source* — deleting the run of
  source edges that generates the unwanted lobe — not by pointing at a
  resolved piece. Costs one honest thing: closing the source ring after
  deletion adds a new edge that also erodes, so the survivor isn't pixel-exact
  to what was on screen before, and the author hand-shapes the difference.

**Consequence for editing:** the eroded outline is not editable at all.
Clicking an eroded polygon shows its **source ring as a ghost, with handles on
it**; dragging a source vertex updates the projection live underneath. You
cannot place an eroded corner at an exact position — only the source corner
that produces it — which is the one real cost, traded for never needing to
bake, invert, or choose a vertex to kill.

**Self-intersection was allowed as a consequence, not a separate decision.**
Once splitting is fine, the same `simplify()` step already in the resolve path
handles a self-crossing *source* ring too — `erode(simplify(source), depth)`.
The old invariant (no self-intersecting polygons, enforced with a crossing
test on drawing and dragging, hatched/badged invalid state, export refusal)
was motivated by collision (`enx/eny` point the wrong way on a flipped
section) and by erosion needing a simple ring to offset. Both turned out to be
constraints on *output*, already guaranteed by the CSG the bake runs anyway —
enforcing simplicity a second time at the source bought nothing. Removed:
the crossing tests, the invalid state, the hatch/badge, the export refusal,
and the bake's "refuse on any invalid polygon" step.

### Accumulation, reintroduced as an optimization only

With erosion no longer writing back, the closed-form chain collapse from
session one turned out to be *safe again*, just no longer necessary: affine
composition is closed regardless of whether scale is uniform, so
`source(k) = (T_k ∘ … ∘ T_1)(P) + Σⱼ (M_k ⋯ M_j) eⱼ` is exact, letting
`resolve(9)` skip intermediate geometry entirely. Recorded explicitly as an
*equivalence a fast path may exploit*, not as the semantics — the failure mode
from session one (constraints growing to protect a closed form treated as
load-bearing) is exactly what this session spent most of its time undoing.

### Groups: leaving and joining don't transfer erosion

Raised: should a polygon leaving a group take the group's erosion depth, the
way it already absorbs a compensating transform to preserve position?

**Rejected: yes, add the group's depth to the polygon's own on leaving.**
Breaks immediately on leave → scrub → rejoin: doubling the erosion on a round
trip with nothing done in between.

**Rejected: replace the polygon's own depth with the group's.** Discards
whatever depth the polygon already had; same round-trip failure from the other
side.

**Decided: erosion never transfers.** A polygon owns one depth; group
membership doesn't touch it. The reason the transform *can* compensate but
depth *can't* is structural, not a design choice: affine transforms form a
group (composing `C` on leave and `C⁻¹` on joining round-trips exactly, even
with edits in between, because composition is associative and invertible);
erosion depths are neither composable in the needed sense (`a` then `b` isn't
`a + b` once a split falls between them) nor invertible at all. Leaving a
group with non-zero erosion therefore visibly changes the polygon's shape —
position is preserved as promised, shape was never part of that promise.

### Shader data layout: bounded nesting beats flattening

For the bake, considered flattening the whole scene graph (polygon transform
composed with every enclosing group's, down to one matrix per vertex) against
a fixed nesting depth with a shared per-polygon chain of transform slots.

**Rejected: flatten to one composed transform, stored as a general matrix.**
Composition isn't closed in `(translation, rotation, scale)` — rotate, squash,
rotate again is a shear — so a flattened slot needs a full matrix, and
interpolating one entrywise slews through a shear mid-transition and collapses
a rotating polygon through its own centre.

**Rejected: flatten to a polar decomposition** (`angle, symmetric 2×2,
translation`) to dodge the matrix-lerp problem. Handles nested *rotation*
exactly, because in 2D angles simply add — but two further problems: the
decomposition returns an angle in a principal range, so a composed rotation
past half a turn re-extracts wound the wrong way and interpolates the short
way round; and once two or more levels in one chain carry non-uniform scale,
the composed product isn't symmetric to begin with, so the composed rotation
stops being the sum of the levels' angles and the intermediate frames are no
longer what per-level interpolation would give.

**Decided: bound nesting at four levels, keep each level's own components.**
A vertex carries one index into a **chain table**, shared per polygon rather
than duplicated per vertex; each polygon's chain lists up to four transform
slots, innermost first. The shader applies and interpolates each level in its
own authored components — already unwrapped, already the right decomposition —
so both flattening failure modes disappear by construction rather than needing
correction. Four was picked deliberately low: nesting is a legibility problem
before a performance one, and the limit is raisable later without breaking
existing worlds, where lowering it would not be. Surfaced to the author as a
status-line message rather than a silent bake failure.

### Discussed but not written into the spec

**The topology-event search budget.** Asked whether an infinite budget or a
brute-force fixed-step scan would work instead of interval bisection.
Established but not recorded in `versioning.md`:

- The search already terminates without a budget — an interval is discarded
  once its enclosure excludes zero, accepted once its width is below `tol`,
  and the `flat`-band check stops the one case (a truly degenerate stretch)
  that would otherwise subdivide forever. The budget bounds wall-clock only,
  and exhausting it already degrades safely (`coarse: true`, still complete).
- A fixed N-step scan is not much cheaper in the region that matters — near a
  root, interval bisection costs about `2·log2(1/tol)` evaluations, the same
  order as a fixed scan — and is *more* expensive across the quiet majority of
  the domain, where one interval evaluation discards a whole subrange at once.
  It also reintroduces exactly the two failure modes the existing tests guard
  against: two close roots falling inside one sample bracket, and a tangential
  graze that never changes sign at any sample density.
- The actual cost driver is the number of edge/vertex pairs checked across
  polygons, not the root-finder inside each pair; a broad phase (cull pairs
  whose swept AABBs don't overlap over the stretch) would matter more than
  swapping the search strategy.

Not added to `versioning.md` on request — recorded here in case the budget or
the search strategy gets revisited.

## What changed in code vs. what the design settled on

The vertex-drag fixes landed in code before the erosion redesign above
happened, and one piece of that code is now stale against `versioning.md`:

- **`nudges: Point[]` on `Polygon`, applied after erosion**
  ([scene.ts](../packages/editor/src/scene.ts),
  [canvas.ts](../packages/editor/src/canvas.ts)) — built to solve the same
  "drag a vertex on an eroded polygon" problem the design section above spent
  most of its time on, and superseded by the projection model's answer:
  eroded points aren't editable at all, only the source ring is, via a ghost
  overlay with handles. The `nudges` field, `placeVertex`, and the erosion
  branch of the vertex-drag gesture need to come back out; dragging should
  become source-only, unconditionally, with the eroded outline rendered but
  not hit-tested for handles when its depth is non-zero.
- Everything else from the drag-bug fixes still matches the design: transform
  frame at the world origin, winding normalised at construction, and the
  `Input.pointer()` fix are all consistent with `versioning.md` as it stands.

The layer/version model itself (`World.versions`), groups, forks, undo,
delinking, and artefacts remain unbuilt, as before this session.
