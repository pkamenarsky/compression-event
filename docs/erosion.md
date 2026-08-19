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
decision about *where* keyframes go: **exactly at topology events** — a
crossing appearing or disappearing, a ring merging or splitting — found by
treating the arrangement as a continuous function of `t` and root-finding on
it, rather than by sampling and hoping nothing was missed between samples.

**Built** — [interval.ts](../packages/editor/src/interval.ts) and
[events.ts](../packages/editor/src/events.ts). Interval arithmetic gives a
completeness guarantee sampling can't: every operation returns a range
*guaranteed* to contain the function's true range over that interval, so a
range that excludes zero has *proved* no root lives there and can be
discarded outright; anything unproven gets subdivided. Verified against two
cases sampling is blind to — a tangential graze that never changes sign, and
two roots 1e-5 apart that a 2,000-sample scan steps straight over — and
against 400 random configurations where nothing a 3,000-sample scan noticed
was ever missing from the search's answer.

Two things fell out that weren't part of the original ask: degenerate
stretches (three points staying collinear for a whole interval) need a `flat`
magnitude threshold or the search subdivides forever hunting for an instant
that never arrives; and a budget makes the search *safe* to run unbounded —
exhausting it returns a coarser-but-still-complete cover rather than
something wrong.

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
