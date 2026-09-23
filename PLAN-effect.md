# Plan: an effect is a ring to a ring

# The laws

Three properties. They are not goals, not things to trade against cost or
against the look: they are the definition of what a scope *is*. Any design
that breaks one of them is wrong, however much else it buys, and the right
response to a break is to change the design, never to weaken the law.

**Law 1 — a scope draws what it resolves to.** Resolving a sealed group that
has effects, whose members have effects, and whose members may themselves be
groups with effects, does not change what is drawn. However deep the nesting,
the outline before the resolve and the outline after it are the same outline.

**Law 2 — sealing draws what was there.** Taking polygons and groups, effects
and all, and sealing them into a group does not change what is drawn — sans
what sealing is for: the inner edges the union swallows, the solids and floors
the seal clips.

**Law 3 — an effect on a scope is an effect on its resolution.** Putting an
effect on a group draws the same as resolving that group first and putting
that effect on the result.

Together they say one thing: **a scope is a fold, and resolving is evaluating
it.** A group is its members' outlines combined and then put through the
group's own effects; nesting is composition of those steps from the innermost
outwards. Nothing about a scope may depend on being at the top, on which
member a piece of the outline came from, or on an amount being re-derivable
from the source the member was drawn as.

What the laws deliberately do *not* say is that amounts add across nesting.
"Two rounds two deep are one round of their sum" is a property of one
particular construction, not a law; under Law 3 a round on a round is a round
laid on an already-rounded ring, and whatever that comes to is by definition
correct. Where the two disagree, Law 3 wins and the summing test is rewritten.
`effects.test.ts`'s *a scope inside a scope* is the test in question.

They are written down in `laws.test.ts`, as properties over generated worlds
rather than as a handful of shapes somebody thought of: a random nesting of
sealed groups, a random kit of effects at each node, and each law asserted on
the drawing. **Nine of them are red today and two are green** — the two being
the bare controls, a world of rooms and nestings with no effect anywhere, which
resolve and seal transparently. That pair is what says the other nine are about
the architecture and not about the way two drawings are compared there.

Those tests are the specification. They go green by the design below and by
nothing else; a law made to pass by narrowing its generator has not passed.

# Why the present design cannot

The present design is in `PLAN-bevel.md` and it is a dead end. The reason is
not the arcs, which are only where it first shows.

**A member publishes amounts instead of geometry.** `namesOf` hands the scope
`Named.lines` — two points on a line, an amplitude, options, an anchor, a reach
— and `Named.corners` — a point, a summed bevel, facets — and `foldShaped`
re-derives the drawn outline from those on the union. That closes only if every
effect is expressible as *an amount attached to a feature of the source*.

- An erosion is: a depth per corner.
- A deform is: an amplitude per edge.
- A round is **not**. A bevel is an amount attached to a corner between two
  straights, and a member whose outline is already curved has no such corner to
  publish.

`foldShaped`'s `arcs` parameter is the admission: a run of the fold that is one
of these "is a curve, not a string of corners, so the group leaves it
unrounded". A scope that cannot round part of its own outline is a scope that
breaks Law 3 on that part, and no amount of further bookkeeping recovers it.
Two rounded members with intersecting arcs needs a corner where two arcs cross,
rounded, possibly teethed — and there is nothing in the vocabulary to say it.

The same hole, from three sides:

- a corner crossed by two arcs has no bevel;
- a partial arc along an edge is neither a line to name nor a corner to round;
- a round of a round would have to re-derive a bevel from geometry that a bevel
  already made.

# The design

**An effect is a function from a shape to a shape, carrying identity.**

```
type Effect = (shape: Shape, ids: Ids) => { shape: Shape, ids: Ids }
```

and a scope is the fold:

```
resolve(scope) = scope.effects.reduce(
  (s, fx) => fx(s),
  combine(scope.members.map(resolve)),
)
```

Law 1 and Law 3 are then near-tautologies: resolving *is* evaluating the fold,
and an effect on a scope is the last step of that fold, which is the same
function applied to the same shape either way. Law 2 reduces to a property of
the boolean op alone, which is where `combineTagged` and `SourceRef` already
live and where it belongs.

What goes: `Named`, `namesOf`, `movedIn`, `Effected`'s publishing half,
`foldShaped`'s `lines` / `arcs` / `corners` / `named` back-channel, `square`,
`seen`, and the `es` / `ids` / `anchors` / `reaches` parallel arrays in
`ArcDeform`. A large part of the hardest code in the repo, deleted rather than
refactored.

## Its type is ring to *shape*

Not a bijection, and not one ring. An erosion closes a notch, splits a ring,
kills a ring outright; a deform can put a ring through itself. So an effect
maps a shape to a shape, and points are **born** and **die**.

That is not a weakening. It is where Law 2 of the earlier plan — *a vertical
pops only where a corner is really made or lost* — is kept: a born point is
born of an identified pair, and it exists exactly while that pair crosses.

## Identity

An identity is a small immutable value, interned so that comparing two is
comparing two integers, because the bake does a great many of those.

```
corner(member, vertex)     a drawn corner, of a polygon somewhere below
born(a, b)                 where two identified pieces cross
on(edge, t)                a point the construction put along an identified edge
```

They compose by nesting, which is what lets the bake follow a corner of a
rounded member through a deformed group inside a rounded group.

**Identity comes from the construction, never from a match.** This is the
single rule that matters. `imagedBy`'s `owner()` matches a point to a corner
within `tol`; `foldShaped`'s naming matches a straight to a member line the
same way. Those matches are where the scope-versus-resolve gaps live, and a
tolerance match is precisely what makes a vertical pop at a threshold in a
classification rather than at a real event. Every point an effect emits must
know what it came of because of how it was made.

## Round is a morphological opening

`round(b) = dilate(b) ∘ erode(b)` — offset in by `b`, offset out by `b`.

- It rounds **every** convex corner at radius `b`, whatever made it: a drawn
  corner, a join between two members, a corner an erosion made, a corner where
  two arcs cross. No classification, no "is this a corner or a curve", no
  rationing table. That is exactly the case the present design cannot say.
- **Identity falls out of the construction.** A point of the outward offset
  lies either on a translate of an identified edge — same identity — or on an
  arc centred on an identified corner, which is that corner's. The inward pass
  is `erode`, which exists and already tracks provenance through
  `erodedCorners` and `Naming`. Nothing is matched within a tolerance.
- Vertex count does not explode under nesting. An arc already at curvature at
  least `1/b` is untouched by the opening, and the output is resampled at a
  fixed accuracy, so `round(a)` then `round(b)` costs what one round costs.
- It composes as `round(max(a, b))` rather than `round(a + b)`. That is the
  honest reading of Law 3 and the reason the summing test is rewritten.
- Concave corners want the closing, `erode(b) ∘ dilate(b)`. Rounding both ways
  is opening then closing, four arrangements. **Open question**: today's
  `arcsWith` rounds concave corners, so both ways is the like-for-like
  behaviour and the one to build; whether it is worth its cost is a thing to
  decide once it can be looked at.
- Cost is two to four arrangements per round, which is the order `foldShaped`
  already pays per scope.

## Every step ends in a canonical resample

Each effect finishes by resampling its output at accuracy `ε`, anchored on the
points that carry identity so that no identified point is resampled away.

This is what makes ring length **a function of the geometry and `ε`, and not of
how many effects have run** — which is what the bake needs across a span, and
what most of `apart` / `apartTo` / `apartAt` / `reach` / `fades` exists to
patch around under `arcsWith`'s rationing today.

## What the bake still needs, and what answers it

Kept from `PLAN-bevel.md`, because none of it has stopped being true:

- **A ring the same length at both ends of a span.** Answered by the canonical
  resample, better than it is answered now.
- **Each step linear in its own amount, in the frame it is taken in.** Still
  true of each step; what is no longer true is that the *composition* is linear
  in a summed amount. A fold of maps each linear in its own amount is what the
  bake now stretches, and the proof has to be re-made in that form. **This is
  the one genuine risk in the design and it is settled first**, at step 1
  below, before anything is built on it.
- **A corner that is born is born blunt.** An opening gives this for nothing: a
  crossing opens from a point at 180° and the arc there has no length until the
  corner has turned.
- **Teeth stay corners in the output**, go through the arrangement and get
  their vertical lines as they do now. Nothing about playback changes.
- **A tooth on an arc is laid as any other tooth**, one every spacing by length
  out from the anchor.

## What it costs

`bake.ts` — 4,754 lines — reads `Effected`, `Imaged`, `imagesOf`, `apart`,
`apartTo`, `apartAt`, `reach` and `fades` directly, and every one of those is a
consequence of the design being replaced. That, and not the fold, is the
budget.

# The plan

Each step is a commit or a few, and each ends with `pnpm typecheck`, `pnpm
test` and `pnpm build` green — `build` because it is the only thing that checks
the module graph, see `CLAUDE.md`.

**0. The laws, red.** Done: `laws.test.ts`, nine red and two green controls.
The number that goes green is how every step below is measured.

**1. Settle the bake's linearity, on paper and in a test.** Whether a span
stretches under a fold of maps each linear in its own amount. Write it as a
property: a world at two keyframes, the ring at an instant between them taken
by stretching against the ring taken by resolving there. If this does not hold
the design changes here, before anything is built on it, and nothing below is
worth starting until it is answered.

**2. `Ids`, interned, and the identity a shape carries.** The type, the
interning, and `combine` carrying it through a boolean op — which is Law 2 on
its own, and the one law that is genuinely about the arrangement. Law 2 goes
green.

**3. `erode` as an `Effect`.** The existing offset, wrapped to take and return
identity, with births named `born(a, b)`. Nothing else moves yet.

**4. The canonical resample.** On its own, tested on its own: identified points
survive, ring length depends on geometry and `ε` alone.

**5. `round` as the opening.** Built on 3 and 4. A polygon only, held against
`arcsWith` for the look — a rounded square must still read as a rounded square,
and a deviation is allowed where it is small.

**6. `deform` as an `Effect`.** Teeth laid along the ring by arc length from an
anchor that is an identity and an offset, rather than by the per-edge parallel
arrays. The pattern's anchoring rules from `PLAN-bevel.md` 2.1 and 2.4 carry
over unchanged; what changes is that they are read off an identity instead of
off a published line.

**7. The fold, behind the present signature.** `resolve` becomes the reduce
above, with `project` kept as the door so the editor and the bake do not move
yet. Laws 1 and 3 go green. Expect `effects.test.ts`'s *a scope inside a scope*
to go red here: rewrite it to Law 3, as the laws say.

**8. Strip the publishing machinery.** `Named`, `namesOf`, `movedIn`,
`foldShaped`'s back-channel and the parallel arrays in `ArcDeform`, now
unreferenced.

**9. The bake.** `Effected` and `Imaged` replaced by the fold's own output, and
`apart` / `apartTo` / `apartAt` / `reach` / `fades` reconsidered one at a time
against the resample. The largest step, and the one that is only safe once 1 is
answered.

**10. `baseline.golden.json` regenerated, once, at the end.**
