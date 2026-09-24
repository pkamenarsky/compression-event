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

**1. Settle the bake's linearity, on paper and in a test.** Done, and the
answer is yes: `linearity.test.ts`.

Not by pairing points — two instants hand back different rings with different
numbers of points, and pairing them is what the design is getting rid of. The
boundary is read as a *field* instead, signed distance at a probe, and the
number taken is the second difference across a stretch, which is twice the
error a lerp makes in the middle of it. Nought is affine, `h²` is smooth, `h`
is a kink, and not shrinking is a jump. The probes are the middles of the
facets and not the corners: an offset slides a corner along its own bisector,
so a probe sitting on one reads a `|t|` where the boundary is doing nothing of
the kind, and probing corners puts a first-order floor under everything and
measures only itself.

What it found:

- **Each step is affine in its own amount, to machine precision.** Not nearly:
  a point of a dilated boundary lies either on a translate of an edge, whose
  line moves by exactly `b` along its normal, or on an arc of radius `b` about
  a corner, whose distance from a fixed probe is `|p - v| - b`. So dilation
  moves the field by `-b` outright and erosion by `+b`, whatever the shape.
- **The opening is affine too**, which it had no right to be, wherever no
  feature changes across the stretch.
- **The fold of them is smooth**, and it is non-smooth only where the nearest
  feature changes — a notch closing, a ring going. Which is to say only at
  events, which is what a stretch boundary already is.
- **`round(max(a, b))` kinks where the two amounts cross**, and stays first
  order however far the ladder is run. The bisection still converges; the
  crossing is one instant per pair of rounds per span, and it is known from the
  keyframes outright rather than having to be hunted for. **Nothing in the
  design changes for it.**

So the proof `PLAN-bevel` had from summed amounts is re-made in the fold's own
form, and the rest of the plan may be built.

**2. `Ids`, interned, and the identity a shape carries.** Done: `ids.ts`, and
`ids.test.ts` for it. The type, the three constructions, and
`combineIdentified` — `combineTagged`'s provenance read as identity, a vertex
keeping the name it came in with and a crossing `born` of the two edges that
made it, nesting as deep as the arrangements do. Nothing in a name comes off a
coordinate, which is what the tests are mostly about: slide an operand, carry
the whole arrangement thousands of units off, and the names come back the same
list to the character.

They are interned under their own rendering rather than under their handles.
The handles are an allocation order and mean nothing across two runs, and a
crossing has to be written one way round — so the order that settles it is
structural, and `shows` is then a lookup rather than a walk.

**Law 2 does not go green here**, which this step expected it to. The break is
not in the arrangement: sealing moves the outline with any of a member's own
effects under it, an erosion or a round as much as a deform, because every one
of them is re-derived from the published lines of a run that sealing has
changed. So Law 2 is not, after all, a law about the boolean op on its own — it
waits on the fold, at steps 6 and 7, with Laws 1 and 3.

**3. `erode` as an `Effect`.** Done: `effect.ts`, with `Effect`, `Drawn` and
`eroding`, and `effect.test.ts` for it. The existing offset wrapped and not a
second one — it draws what `erode` draws point for point, and half the tests
are about nothing else.

The names come out of the band rather than out of anything that looks at the
result. Every point of the band is a corner of the source or the place that
corner moved to, which for identity is the same corner, so the arrangement
between shape and band names its own output: a corner that survives keeps its
name, one pushed inwards keeps it, and a corner the erosion made is `born` of
the two walls whose bands crossed. A notch closing and parting a room in two
says so outright, and says the same however far the geometry has travelled.

Two things the step turned up that were not in the plan. The band has to report
where its points came of, so `swept` carries that and `sweptBand` hands it
over. And a point and the edge leaving it are two different questions: a quad's
second point is the far corner of the wall while the edge leaving it is the
moved wall, which belongs to the near one. Naming an edge by the point it
leaves is right for a walked ring and wrong for a band, so `Drawn` carries an
optional `edges` and `combineIdentified` asks the two questions separately.
Without it a crossing on a moved wall gets a different name from the same
crossing on the wall it moved from, which is the kind of thing that only shows
up as a vertical in the bake a long way downstream.

**4. The canonical resample.** Done: `resampled` in `effect.ts`. The same
circle handed in at 64, 128 and 256 facets comes back at the same count and
with the same names for those points, and handing the answer back in changes
nothing but the last few digits.

The reading it settles, which the plan left open: **what may move is read off
the identity, not off an angle.** A `corner` or a `born` is a feature — the
boundary turns there because a construction turned it — and it stays where it
is; an `on` is a sample something laid to describe a curve, and where it sits
is an accident of the effect that laid it. So "no identified point is
resampled away" means the anchors, and the samples between two of them are
laid again at `n` equal steps of arc length, `n` the least power of two whose
chords stay within `ε`. Powers of two so that `n` changes rarely and visibly
rather than creeping by one as a run grows. A straight run takes `n` of 1 and
keeps nothing between its ends.

It never emits more points than it was handed, so a ring cannot grow under a
fold however deep the nesting goes. Nothing wires it into `eroding`: an erosion
lays no samples, and the caller that needs it is the round.

**5. `round` as the opening.** Done: `dilating` and `rounding` in `effect.ts`.
In by `by` with step 3's offset, out by `by` with the Minkowski sum of a disc —
the shape, a quad per wall, a fan at every corner the boundary turns out at —
and step 4's resample on the end.

Not the mitred offset run backwards, which was worth finding out early: a mitre
out of a mitre in is the shape it started as and nothing has been rounded. The
disc is what puts an arc there, and identity falls out of it exactly as this
plan said it would — a point is on a translate of a wall and is that wall's, or
on an arc about a corner and is `on(corner, t)` with `t` sweeping the turn.

Held against the look, on a 200 square at `ε` of 0.5:

- against a **true circular fillet** it is within 0.43 at bevels of 10, 20 and
  50 — the faceting, and nothing else;
- **`arcsWith` is 1.5, 3.0 and 7.5 from that same circle**, growing with the
  bevel, because it draws a tension curve and never did draw an arc. The whole
  of the difference between the two is that. A rounded square still reads as a
  rounded square and reads as one *more* exactly than it did;
- `round(10)` then `round(30)` is `round(30)` to a billionth and at the same
  point count. `round(max(a, b))`, measured;
- **a concave corner comes out exactly where it was**, named of the two walls
  that meet there. An opening takes nothing off one, which is a real difference
  from `arcsWith` and leaves the closing where this plan left it: an open
  question, not built.

Two things the resample had to learn, which step 4 could not have known. An
arc's two ends are features — but only where the corner it was laid about was
one, since a round lays a fan at *every* turn and a turn between two facets of
an arc it rounded last time is the curve carrying on. And a run leaving
`on(e, 0)` is the arc about `e`, so its samples are named in that family rather
than nested on the anchor, or a round of a round of a round would carry a name
as long as the fold is deep. With both, six rounds of 20 on a square go 20, 32,
44, 48, 48, 56 points and stop.

What it costs that is worth knowing: the erosion's band crosses a faceted arc
at every facet, so each round makes a crop of `born` points, and a `born` name
holds both its parents' names. Six rounds deep the longest name is about 300
characters. The handles stay integers and comparing two is still comparing two
numbers; it is the interning that pays. Nothing in the editor nests that deep,
but the bake is where it would show.

**6. `deform` as an `Effect`.** Done: `deforming` in `effect.ts`. Teeth laid
along the ring by arc length between the points a construction turned the
boundary at — the same runs the resample calls anchors. `patternRun` carries
over unchanged and does all the work it did; the per-edge parallel arrays do
not come with it.

2.1 carries over word for word, with the run's anchor standing in for the
lowest-ranked member edge: one name to a run, teeth from that name's middle
across the whole of it, two members side by side along one wall getting one
pattern across the join. The name is an identity, so nothing about it can flip
as members slide past one another — which is what rank was there to prevent,
and the reason rank is no longer needed.

2.4 is `tooth(run, j)`, **a fourth construction, and the one thing here the
plan did not list**. `on(run, t)` would have slid every tooth the moment a
neighbour moved; a number does not, and tooth `j` is tooth `j` whatever the
run's ends do. `reach`, `clear`, and carrying a source length through an
erosion go with it: a deform is a step of the fold, it lays its teeth on the
ring in front of it, and whatever runs after carries them as points like any
others rather than laying them again.

An arc takes its teeth as a wall does, keeping its own facets between them. So
`ArcTeeth`, `drawnBevels`, `CRAMMED` and `ArcTeeth.seen` answer a question that
no longer exists — an arc is more of the ring — and they join the list at step
8.

Measured: a wall grown through forty units gains two teeth and each of them
arrives standing flat on the wall, so nothing pops; teeth tall enough to cut a
room in two come back as thirteen rings whose crossings are named of the walls
that crossed.

**7. The fold, behind the present signature.** In part. A scope's shape is the
reduce: its members reach it *drawn* and `folded` lays the scope's own on what
they came to. Nothing is published and nothing is re-derived.

`project` keeps its signature and **does not keep its body**, which the plan
did not allow for. `arcsWith` is a tension curve and the opening is an arc, so
a scope rounding by the opening while the polygons it resolves into round by
`arcsWith` cannot make Law 3 green however right either is alone. Both sides
are the fold now, and there is no other path through `project`.

What stood in the way of that was per-corner amounts, and the answer is that
**an effect's amount is per identity**: one number, or a number written against
an `Ident`. A polygon's corners have the plainest identities there are, so a
depth on one corner is a map with one entry and the effect is the same effect —
and it survives the notch closing, the arcs going in and the scope above,
because the amount is against the corner and not against an index. A point the
construction made asks whatever it was made of, a born point taking the larger
of its two, which is `round(max(a, b))` said of an amount.

**Per-corner rounds are dropped.** An opening is a statement about the whole
shape: a depth at one corner and nought at its neighbours leaves the wall
between them a chord sloping back rather than a wall offset by `b`, and the arc
that grows off it lands short — forty comes back as thirty. A ring takes the
largest bevel anybody on it asked for. It could be had by keeping only the
pieces an opening removes whose arc is named by a corner that asked — the
pieces know — but that is a second construction with a caveat on it and it buys
one editor feature.

The resolve reads its members drawn and publishes nothing; the scope's own
amounts go onto the ring as the ring's own and the same fold lays them again,
which is Law 1 by construction.

**Two questions the deform was answering with one predicate.** Where the
resample may not move a point, and where a deform's rhythm may restart, are
not the same question, and they were `anchorsOf` both. So an arc's two ends
started runs, each arc was a run of its own, and each run centred its teeth in
itself whatever its length: a rounded square came back as four long rhythms
with a single spike stuck on each of its four arcs. `runsOf` is the second
question — an `on` is a point on a curve and a curve is not where a run starts
— and a rounded ring, having no corner left on it, falls through to the least
of its names and takes its teeth one spacing apart the whole way round. That
is what *an arc is more of the ring* was always meant to say.

**One default for `offset`.** A polygon's teeth started off each run's middle
by a share of the spacing, a scope's fold's were centred, and a resolve wrote
the difference onto the ring it made so the two would agree. That is Law 3 held
up by hand, and it is exactly the kind of thing one pipeline is for: one
default — centred — and the writing down goes. Law 3's deform is green over
worlds where nothing else is laid.

**Identity is carried up from the members.** `folded` named the union it was
handed with `identify`, which calls every point of a shape a drawn corner —
true of a ring nobody has touched, false of the union of two rounded rooms.
Every facet of every arc came out a `corner`, a corner is where a run may
start, and a sealed group of rounded members took a tooth on every facet of
every round. No predicate fixes that: the names were wrong before anything read
them, and a scope may not work out from coordinates what a point is.

So the members hand their names up. `project` returns a `Drawn` and mints in a
member of its own (the polygon's id, which joins the memo key: what is
remembered is a drawing *and who drew it*). `Resolved` carries `ids` beside
`shape`. `keeping` splices names in lockstep, still minting none of its own —
it says which edge a point went into and how far along, and the caller says
what that is called. `drawnUnion`, `settledDrawn` and `underfootDrawn` are the
arrangement run through `combineIdentified`. Two rounded rooms sealed and
deformed: 105 runs before, 2 after.

Law 2 went green with it, having been red since step 0.

**Where it stands.** Seven of eleven law properties red, four green. What is
left is one break at one boundary, and it is the same bug one step further out:
**a published ring loses what its points are.** A resolve hands its members the
bare ring and the scope's own effects, so that the same fold lays them again —
which is Law 1 by construction, *if* the ring's names survive being written
down. They do not. The ring becomes a polygon of `Vertex`es and `identify`
calls every one of them a drawn corner, so an arc a scope was carrying comes
back as a row of corners and the deform after it lays different teeth. The
counterexample shows it outright: an arc's facets on one side, a tooth standing
where they were on the other.

The fix is for a `Vertex` to carry what its construction made it, rather than
for `identify` to assume. `Vertex.sample` is that: which of the polygon's own
corners starts the run this point is a sample of, and how far along it sits.
Not the member's old name, which named a member the new polygon has no memory
of — the same *structure*, said in this polygon's own corners, which is all
anything downstream asks. Getting a value there meant naming the union's points
rather than minting them, and the arrangement was already most of the way:
`Whither` says a boundary point is a member's vertex or a crossing of two, so
`nameOf` reads the contributor's own name or `born` of the two walls that
crossed — the same rule `combineIdentified` uses, and it has to be.

It needed a second answer to be worth anything. An arrangement is free to cut
an arc, and where it cuts one the `on(e, 0)` end is exactly what goes: what is
left is samples whose start gave out, written down as corners, each starting a
run of its own. A stretch a scope laid as one run of seven points over 24.17
units with one tooth came back, resolved, as six runs of 0.10, 0.17, 0.17,
0.17, 0.17 and 23.37 with a tooth forced onto each. So a sample whose start is
missing takes the run it is actually in: the last point before it that is not a
sample, which is what the scope's own deform reads too, and which is the
crossing that cut the arc.

**What is left is not about identity at all.** Instrumented on the generated
counterexample, the naming now matches one run for one: same starts, same
lengths, same teeth, and with the scope's own effects taken off, resolving is
point-for-point identical. What breaks is narrower and older, and it is in the
erosion — see *Open bugs* at the end.

Twenty-three tests go red with the step — `effects.test` 14, `bake.test` 8, one
export — and they are the old look and the old machinery, which steps 8, 9 and
10 take out and regenerate.

**8. Strip the publishing machinery.** `Named`, `namesOf`, `movedIn`,
`foldShaped`'s back-channel and the parallel arrays in `ArcDeform`, now
unreferenced.

Done ahead of the rest: the per-corner round, everywhere it stood outside the
geometry. The pane's *Round corners* heading and its `as the polygon` link,
the gesture that switched a picked corner's round back on, `cornerRound`,
`cornerRounding`, `ownRound`, `cornersSwitched`, `cornersOptioned` and
`cornersInheriting`, and the slot in the save format. `publishing` in
`resolve.ts` went with them — step 7 left it with no caller and half of what it
wrote down was that round.

`cornerEffects` stays, and stays under its name so an old file still loads. It
is the deform's alone now: an edge's own options keyed by the corner it leaves,
which the fold honours exactly. A round a file carries there is dropped on the
way in.

Still standing, and for this step proper: a per-corner bevel *amount* reaches
the fold, where `most` takes the largest of them. That is the rig rather than
the options.

**9. The bake.** `Effected` and `Imaged` replaced by the fold's own output, and
`apart` / `apartTo` / `apartAt` / `reach` / `fades` reconsidered one at a time
against the resample. The largest step, and the one that is only safe once 1 is
answered.

**10. `baseline.golden.json` regenerated, once, at the end.**

# Open bugs

What is known to be wrong and is not any step's to fix. Each one is written so
it can be picked up cold: what was measured, what was ruled out, and what is
still unknown. Nothing here is a guess dressed as a finding — where the
mechanism was not found it says so.

## A ring's erosion depends on a ring thirty units away

**This is what the one law property that was chased all the way down turns out
to be.** Whether it is also what the other six are has not been shown — each
would have to be instrumented the same way. What is shown is that for `law 1:
resolving the top scope` the naming is now right and this is the whole of the
remaining difference.

Two rings, eroded by nine, from the world `law 1: resolving the top scope`
shrinks to. They are thirty-one units apart at their nearest, not nested, and
wound the same way:

```
ERODE together  [7,9,3, 17,16, 9,4,7,13,7,10,9,9,8,12,11]
ERODE 1 alone   [       16,14, 9,4,7,13,7,10,9,9,8,12,11]
ERODE 1 + far   [7,9,3, 16,14, 9,4,7,13,7,10,9,9,8,12,11]
```

The neighbour at its real distance puts three points into the **other** ring's
erosion. Moved a hundred thousand units away it does not, and every other ring
of both is unchanged, including its own three.

Why it breaks the laws: a resolve splits one shape into one polygon per
outline, and each is then eroded alone. So a scope that erodes `[A, B]` as one
shape does not draw what its resolution draws, and the three points are the
whole of the difference. The same three survive the round — they are already
there at `eroded`, before `dilating` and before the resample — and come out as
three points of the final drawing.

Ruled out, each by measurement rather than by argument:

- **The two shapes meeting.** A depth of nine cannot reach thirty-one units.
- **Nesting.** The bounding boxes are disjoint in x — `[234..326]` against
  `[-6..203]` — and both signed areas are positive, so neither is the other's
  hole.
- **Tolerance by extent.** Coincidence is judged against a tolerance taken off
  the extent of what is being worked on — `scale * 1e-9`, as `keeping` does it
  — so the suspicion was that a bigger shape snaps coarser and loses points a
  smaller one keeps. It is the wrong way round: moving the neighbour a hundred
  thousand units away *raises* the extent three hundredfold and gives the
  **alone** answer.
- **Duplicate names.** Counted at the resample on both paths: none, either way.

**Mechanism not found.** What is known is that it is `eroding`, not `dilating`
and not `resampled`, and that it is the presence of the second ring rather than
its distance in any way that a nine-unit offset could feel. The next thing to
look at is `sweptBand` over a two-ring shape against the same ring alone —
whether the band it builds for one ring is the same geometry in both, or
whether it is the single `combineIdentified` over the pair that differs.

The reproduction is `laws.test.ts`'s own counterexample. To get it back: run
`law 1: resolving the top scope`, take the printed `Counterexample` spec, build
it with that file's `built`, and read the two rings out of `rounding`'s input.
Beware that the spec is printed with `undefined` in it, which JSON has no word
for — parsed as `null`, every `=== undefined` in `optionsOf` answers false and
the world comes out with every effect on it.

## Law 2 is green, and was not expected to be

Recorded because it is a claim in this plan that turned out wrong, not because
anything is broken. Step 2 said Law 2 could not go green yet and gave evidence:
with the deform taken out of the generator it was still red, so erode and round
broke it too. It went green when identity started being carried up from the
members. The evidence was sound and the conclusion drawn from it was too
strong — what it showed was that the deform was not the *only* thing breaking
Law 2, not that the breakage was in erode and round themselves.

## Two copies of one formula

`sagitta` in `scene/core.ts` and `sagittaOf` in `scene/reading.ts` are the same
expression character for character. Harmless today, and exactly the kind of
thing that stops being harmless when somebody changes one. For step 8.

## The per-corner bevel amount outlives the per-corner round

Per-corner rounds are dropped and their options are gone, but a bevel amount
written against a single corner still reaches the fold, where `most` takes the
largest. So the drag gesture on a corner raises the whole ring's bevel rather
than doing nothing — odd, not broken. It is the rig rather than the options,
and it goes with the rest of the old machinery at step 8.
