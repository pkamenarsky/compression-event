# Plan: bevel first, erosion next, deform last

Before this plan a thing went **deform → erode → round**: its edges got teeth
as though drawn by hand, the teeth were eroded with everything else, and the
round was laid on what the erosion left. So a round ran into the teeth, and
everything between the two — `clear`, `unrounded`, the `flat` flags,
`squareIn`, `restSquare` — existed to keep them out of each other's way.

Phase 1 turned it to **round → deform → erode** for a polygon, phase 2 gave a
sealed group the same pipeline over the fold of its members, and phase 3 moved
the deform past the erosion to **round → erode → deform** — done for a polygon,
not for a group.

Phase 4 takes the last step, to **erode → round → deform**. The reason is not
the look, which barely moves: it is that the depth is the only one of the three
that cannot be lifted onto a union, so putting it first is what collapses a
group's two pipelines into one. *Phase 4* has the case and the measurements.

So, at every level:

- a polygon is eroded at its drawn corners, the round is laid on what comes
  out, and the deform lays its teeth along that — straights and curves alike,
  one kind of run;
- a sealed group erodes its members by their own depths, folds them, erodes the
  union by its own depth, and then rounds and deforms once, each run taking the
  amounts it inherits;
- a member's round and deform are laid there too, with everything else. There
  is nothing to push down and nothing to delay.

Teeth stay corners in the output. They go through the arrangement, change
topology, and get their vertical lines exactly as they do now — detecting slope
at runtime is not an option. Nothing about the playback design changes.

## What changes in the look

- **A corner the erosion makes is square.** Where two walls grow into each
  other, or a tooth pinches off, nothing rounds the result: such a corner has
  no name, so it inherits no bevel and no amplitude.
- **A group looks like a polygon.** One pattern along the union's outline, none
  on the joins inside it, teeth on the group's arcs.
- **Teeth do not erode.** They are laid on the eroded outline, so nothing is
  self-limiting; the pinch comes back as a law of its own (*4.5*).
- Every deformed or rounded level changes. `baseline.golden.json` is
  regenerated once, at the end.

## Why it bakes

Each step is linear in its own amount, in the frame it is taken in:

- an erosion moves a corner by the depth along a direction of its angle alone
  (`mitred`);
- a round's point is the corner plus the bevel along its two edges, times
  multiples of the corner's angle and `u` alone (`Curve`);
- a tooth is a point of the path plus the amplitude along the path's normal
  there, times the pattern.

So a stretch holds wherever the combinatorics hold, and the round and the
deform are, to the bake, what drawn corners and today's teeth are to it:
corners with ids, carried by `budding` and `effectsOver` across a span.

The deform being last is what buys the exactness. A tooth's apex sits on an
edge, not at a corner: the offset line, linear in the depth, plus the amplitude
along a normal that does not turn. No mitre, no `1/sin`. Today's order walks
each apex along its own mitre by `d / sin(θ/2)`, and a deform whose amplitude
moves is a deform whose every θ moves — a curve per tooth.

**A tooth on an arc is laid as any other tooth**: a tooth every spacing by
length out from the anchor, fading within a spacing of either end through
`room`, at full height everywhere else. `patternRun` does not care whether a
run came from an edge or an arc. Teeth may cross each other and other walls,
and the arrangement settles that as it does for any tooth.

## Phase 1: a polygon — done

**The round is drawn in the projection, not as corners.** Arcs that were
corners of the polygon would take the drawn corner out of its ring, and the
editor's handles, edges and `addVertex` all stand on it. So `Resolved` keeps
its corners as they were and `project` draws the outline from them.

**An arc's teeth push the whole arc**, each of its points off the curve by what
the teeth either side say, in proportion. Laid only as points among the facets,
a tooth sliding past a facet point swapped places with it in the ring and the
bake cut every such instant to its narrowest width.

**A falloff and an offset.** Each tooth adds its height to the arc falling away
with distance along it — a triangle standing on the curve, its feet `falloff`
of the spacing away, never less than `NARROWEST`. Each edge's teeth start off
its middle by a share of the spacing its seed gives it (`Effecting.offset`), so
a short edge may have none.

**`held`.** `Options['round']` carries it, on by default. Held, a corner's
bevel is drawn as `bevel ± depth` so that what the erosion leaves is the arc
asked for at any depth. Phase 4 ends its usefulness — see *4.3*.

**A corner the bake invents is rounded apart** (`Effected.apart`), its arc a
sliver along the points either side, with no teeth. The geometric half of this
is now inert and goes with the removals; the naming half is load-bearing.

**What phase 1 found the hard way**, on `world-2026-09-22T14-17-44Z` (a room
with inward teeth of 294 on held arcs of some 465, jumping by up to 130):

1. *An arc's point beside a tooth's tip.* Arc points under a flank are now left
   out and the flank runs straight to a foot; otherwise the mitre between a
   point and a tip flips as the point comes and goes.
2. *An island born* — specks pinched off by the erosion, read as a jump. Not a
   fault.
3. *Walls starting to cross.* Where two teeth begin to cross there is a notch
   of some 160°, and `erode` mitres it: five times the depth, whole, the
   instant the corner exists. This is `erode`'s own.
4. *The teeth held still* (the fix for 3): a held arc's teeth are laid along
   the arc as it is *seen* and carried onto the drawn arc, so they keep their
   places while the erosion grows it.

## Phase 2: a sealed group — done

A sealed group with a round or a deform folds its slots at depth nought and
`foldShaped` rounds, deforms and erodes the fold as one shape. The group's
deform is no longer pushed onto its members. Two pieces of it are what phase 3
and phase 4 stand on.

### 2.1 Where a pattern is anchored

A union edge is a run of member edges. The run takes one name — the
lowest-ranked member edge lying along it — and its teeth are laid from **that
edge's own middle**, across the whole run. So two members side by side along
one wall get one pattern across the join; nothing at either end of the run
moves a tooth; and a run split in two leaves the piece that keeps the naming
edge untouched.

Rank rather than the edge under the run's middle, because members sliding until
the join passes the middle would otherwise flip the name and jump the pattern
with no event to hide it.

### 2.2 Naming the union's straights and arcs

A union straight lies on the line of exactly one member edge: the arrangement
cuts edges up and drops the pieces inside, but never moves one off its line. So
a member publishes its eroded edges as lines, and the fold names each straight
by the line along it.

- **`namesOf(resolved)` → `Named`.** Per source edge that reaches the
  projection, the line it lies on *after* the erosion, named by the corner it
  leaves; per rounded corner with any length, its arc as points. A tooth names
  nothing: it belongs to the edge its `root` names.
- **`movedIn(named, depth)`.** A line goes along its own normal; an arc's
  points each on the mitre of the two segments at them, which is why lines and
  arcs move together. `slotted` moves what its members publish by the slot's
  signed depth.
- **An arc is a curve, not a string of corners.** `teethAlong` works over a
  `Curved` — `{ points, us, on, normal, bend }` — and `curveThrough` reads one
  back off a point run, so a fold's arc takes the group's teeth along the whole
  curve. Measured in `experiments/curve.test.ts`: same tips, same folds, the
  tips 0.24 to 4.72 off the analytic ones, which is the polyline sitting inside
  the curve it was laid as.
- **Teeth stand in the fold before they turn.** `FoldShaped.fades` reports each
  flat tooth with nought beside it and `Contributed.faded` keeps it in the ring,
  so a pattern comes up rather than arriving. Without it a fold went from nine
  points to twenty-six between the keyframe and the next instant.

Tagging the union was rejected: a tag names a *shape* point, so it would still
have to be taken back to an edge, and it would have to survive `erode` on the
way up through a nested scope, which a line does for nothing.

### 2.3 What phase 2 left standing

- A run splitting or merging re-anchors the piece that loses the naming edge,
  at an event the arrangement already has. Unchanged, and acceptable.
- **A scope's own arcs have no names**, its corners having no ids, so a group
  nested in another names its straights but not its curves. Phase 4 needs the
  naming for everything, so this is work rather than a known gap.
- A member's teeth next to a straight make that straight untoothed.

### 2.4 What the one-pipeline experiment found

`experiments/onepipe.test.ts` folded the members *before* any erosion and ran
one pass over that ring, each corner carrying whichever effects it inherits.

| case | apart | points |
|---|---|---|
| group round, plain members | 0.00 | 37 vs 37 |
| group round + erode, no deform | 0.00 | 37 vs 37 |
| group round + deform | 5.73 | 77 vs 85 |
| the same, amplitude 12 | 10.27 | 77 vs 85 |
| member rounds, group deforms | 4.74 | 83 vs 71 |
| member erodes, group rounds | 5.65 | 69 vs 37 |

- **Where only the group has effects the two already agree exactly.**
- **The deform gaps are the pattern's phase, not the pipeline**: they double
  with the amplitude and the point counts do not move.
- **The one real difference is a member's own depth**, and one pipeline cannot
  express it: a polygon's depth is per corner and interpolates along its edges,
  a member's is per shape, so a corner where two members meet would carry two
  depths and slant the edge between them.

That last line is the whole of phase 4's case, read three phases early. It says
the depth is the one thing that has to happen before the fold — which is an
argument for putting it *first*, not for keeping two pipelines.

## Phase 3: the deform moves past the erosion — done for a polygon

**Why it ends the jumps.** Every jump this plan has fought is a
*classification* flipping: straight against arc, `unrounded`, `clear`, `flat`,
`restSquare`, `squareIn`, and the seen arc against the drawn one. Each exists
because the deform runs while it still matters what kind of thing it is
standing on, and a classification flips at a threshold — that is what the jump
*is*. Laid last there is one curve.

**The tooth keeps its place.** Teeth laid on the eroded outline do not slide,
because the pattern is not keyed by arc length. `patternRun` takes an anchor and
allows it outside the run, and a mitred offset keeps an edge's identity: the
eroded edge is the source edge translated along its normal and re-trimmed. So
the anchor is the source edge's middle pushed out by the depth, its coordinate
along the edge does not move with the depth at all, and teeth only enter and
leave at the ends, through the `room` fade.

### 3.1 What is in, on a polygon

- `deformedAt` no longer subdivides. `imagedBy` rounds the drawn corners,
  erodes that, and lays the teeth on what comes out. `Vertex.root` is dead in
  every path a polygon takes.
- The step is `foldShaped`, which phase 2 already wrote. Its round and its
  erosion switch off by their own arguments, so a polygon's call is the same
  one with nought in those two places.
- A polygon names its runs from `owner` rather than by matching lines. A corner
  the bake invented names no wall, and the sliver arc it is rounded into does
  not break the run through it.
- `patternRun` has `reach`; an edge can carry more than one pattern; both
  namings of a splitting wall are laid and **added**, each read at every station
  with the offsets standing on each other — interleaving them put a return to
  the wall between every pair of apexes. A pattern is read across an edge's
  ends, and a ring point interior to a run is lifted onto it.
- A corner is set aside for the geometry only where it is flat, which is the
  end that invented it — `near[i] && far[i]`, needing no knowledge of `t`.
- `reach` boxes a polygon with its teeth's amplitude, which they no longer
  bring along inside `placed`. This is the one that fails quietly: an undersized
  box drops a polygon from a neighbour's neighbourhood and the events between
  them are never looked for. The case had to be built to fail before the fix
  meant anything — two rooms twelve apart whose teeth meet, drifting 96.7.
- **A deform from nought fades in.** `imagedBy` keeps `foldShaped`'s `fades`
  and reports them as `Imaged.flat`; `invented` keeps them through the bake's
  own arrangement; `teethFading` gives each one a fade. That last changes no
  opacity at all — what it changes is `explained`, which called a tooth
  standing up out of a flat wall an unaccounted corner and cut instead of
  letting the line fade in.

**The pop is gone.** `rounded as well, its outline never pops` passes at a
worst step of 0.31 against a bar of 0.5, both ends the editor's outline to six
places.

### 3.2 What the experiment found

`experiments/deformlast.test.ts`, on a room with no two corners alike, against
a tolerance of 0.05. Each figure is the worst a point is from the lerp of the
span's two ends.

| span | today | last |
|---|---|---|
| amplitude 0 → 3 | 1.34 | **0** |
| amplitude 1 → 6 | 0.16 | **0** |
| bevel and depth, no teeth | 0.89 | **0** |
| bevel 4 → 14 | 2.00 | **0.71** |
| all three | 2.04 | **0.38** |
| depth 0 → 20 | 1.98 | **1.36** |
| depth 0 → 5 | **0.25** | 0.56 |
| a corner moving 30 | **0.44** | 0.60 |

- **A span that moves the amplitude is exact**, and so is one with no teeth.
- **Every mixed span is better**, by two to five times.
- **The one thing not better is a tooth on an arc**, which is every remaining
  worst point — and it is the geometry, not the prototype: at 2, 4, 8, 16 and
  32 segments an arc the figure converges on 1.19. A tooth marched out by the
  spacing sits at an angle of its length over the radius, and the erosion moves
  the radius. Anchoring by `u` instead holds the angle and is worse everywhere
  (0.93, 2.04, 1.18 against 0.56, 1.36, 0.71), because the spacing then drifts
  with the radius.

**Points carried, at amplitude 6:**

| depth | 0 | 6 | 20 | 40 |
|---|---|---|---|---|
| today | 34 | 31 | 16 | 1 |
| last | 38 | 38 | 38 | 42 |

Eroded, today's outline thins out and at the end is gone; laid last it never
does. This is what the pinch (*4.5*) buys back.

### 3.3 The two parked bake tests

**`an edge growing longer gets more points, and they fade in`.** The pattern
*re-phases*: a tooth is anchored at the run's middle and marches out by the
spacing, and the middle moves as the wall grows. Tooth `j` runs −1 to 1 at the
near end and −2 to 3 at the far. The sliding is fine — tooth `j` is the same
tooth and its place is a lerp of its two ends. What has no answer is `j` of −2
at the near end, which would stand off the end of the wall with nowhere to be;
`reach` clamps it onto the corner and it is dropped as a duplicate. This wants
the pattern laid over the *union* of the two ends' reaches, which is the same
shape of answer as the two namings.

**`a corner arriving on a deformed floor starts from the editor's pattern`.**
Four of seven jumps are gone. `effectedAt` now carries both namings at either
end, the far one at nought, while `apartAt` of nought or one keeps the geometry
that end's own; a corner set aside is kept through the cleaning by
`deform.aside`, not by `square`, which would have left the edges either side
untoothed; and which points lie flat is read back off what `simplify` returned
rather than predicted from the amplitude. The three left are together at `t` of
0.6939, where the arriving corner and a tooth of the far naming cross: two ring
points swapping order, which is an event and not a fade, and one crossing costs
three cuts. Worst step 0.85 against a bar of 0.5.

### 3.4 Why a group still pops: the erosion amplifies a tooth coming up

`world-2026-09-22T21-40-17Z` — two overlapping rooms sealed, rounded 180 with a
noise deform, eroded 61 four times — pops on span 3 at 2.84.

It is not the naming and it is not the erosion. The fold's ring, its runs'
names, anchors, reaches and amplitudes are identical either side of the
instant; the only input that differs is the depth, 136.8626 against 136.8817,
and the same ring swept from 136.5 to 137.5 moves by at most 0.0066.

**It is the amplification.** Taking the two toothed rings either side and
eroding each:

| | apart |
| --- | --- |
| the two rings, before the erosion | 0.0273 |
| each eroded at its own depth | 2.8621 |
| both eroded at the *same* depth | 2.8812 |
| the *same* ring at the two depths | 0.0251 |

A tooth that shallow is a pair of nearly parallel walls, and the wedge `erode`
makes reaches where the two moved walls cross — off towards infinity as they
close on parallel. A tenth of a unit of tooth becomes three units of outline.

**It wants both the deform and the round**: with the deform alone the span's
worst is 0.23, with the round alone 0.20, with both 2.73. The round's `clear`
is what makes a tooth ramp in and out at a run's ends, and that is what
manufactures a tooth standing at nearly no height.

**So `fades` and a deep erosion cannot both be last.** `FoldShaped.fades` keeps
a flat tooth in the ring deliberately, and a flat tooth is exactly the worst
thing to hand a deep erosion. The two are in direct conflict for as long as the
erosion comes after the teeth — which for a polygon it no longer does, and for
a group it still does.

## Phase 4: the erosion first

### 4.1 The property

Of a group's three effects, **only the depth cannot be lifted onto the union**.
A bevel is per corner and an amplitude is per edge, and *2.2*'s naming carries
both onto a union run — that is what the naming is for. A member's depth is per
shape, and *2.4* measured what a corner carrying two of them would cost.

So the erosion is the one step that has to run before the fold, and every order
that does not put it first leaves a liftable step in front of the fold — which
forces the members to run it and then forces the group to run it again over the
top. That is the two pipelines, and it is where `squareIn`, `restSquare`,
`squaredThrough` and "hold a member's deform back and find it again on the
union edge its edge became" all come from.

Erosion first is the only order where the un-liftable step is alone in front of
the fold and everything after it is one pass:

```
members eroded by their own depths → fold → eroded by the group's depth
  → rounded once → deformed once, each run taking the amounts it inherits
```

**For a polygon, held, it is not a change at all.** Held draws a corner at
`bevel ± depth` so that what the erosion leaves is the arc asked for, which
makes round-then-erode give `centre(bevel) + (r ± d)·u(φ)` and erode-then-round
give `(corner + d·mitre) + bevel·u(φ)` — the same point. The whole value is at
the group.

### 4.2 What was measured

`experiments/erodefirst.test.ts`, on *3.4*'s world by *3.4*'s method.
`shapedFold` carries an `ORDER` switch over the three orders, unset being what
ships. The harness reproduces *3.4*'s figures exactly, so it is measuring the
same thing.

Worst step per span, 1600 steps:

| span | rde (ships) | red | **erd** |
|---|---|---|---|
| 0 | 0.0230 | 0.0230 | 0.0230 |
| 1 | 0.2138 | 0.0510 | 0.0539 |
| 2 | 0.0722 | 0.0510 | 0.0539 |
| 3 | **2.8434** | 0.0510 | 0.0539 |
| 4 | 0.3718 | 0.0509 | 0.0539 |

Refined to 6400, `erd` has **one** outlier in the whole world: 3.28 at `t`
0.1303, two adjacent steps, ring 50 → 49 → 51. That is a point leaving and two
arriving — one topology event, which is a stretch boundary the bake cuts at.
`rde` has two, at 2.87 and 1.68, tied to no event at all. Everything else in
`erd`, and everything in `red`, is median = worst = the figure moving.

**Wherever the depth is nought, `erd` is today's figure exactly** — nought
apart at the first two keyframes, the same 55 points — and from there it parts
smoothly: 5.9, 20.8, 38.0, 35.1 at the later keyframes. That is the erosion
alone talking, which is the one step that moved.

**`red` draws a different figure from the start.** 14.8 apart at zero depth,
where nothing has been eroded at all, and 167 points against 55. Its second
pass lays the teeth from the names with `reach` instead of onto the ring the
round came to, so it is toothier everywhere, not just at depth. By the last
keyframe it is 87 from today's outline where `erd` is 35.

**A finding that was the prototype's own.** An earlier run had `red` popping
21.34 on span 1 and read it as the group's deform arriving with nothing fading
it. It was the switch: `shapedFold` took the shipped single-pass path whenever
the depth was nought, so the first step of an erosion crossed between two
different constructions — ring 55 → 165 at `t` 0.00016, the first step of the
span. With the shortcut gone both orders are smooth at every refinement. The
thing to take from it is the method rule and not the number: a prototype that
switches on the quantity being swept will manufacture a discontinuity at the
switch, and it will converge like a real one.

### 4.3 What it costs

- **`held: false` goes.** With the round laid after the erosion there is no
  drawn-against-seen left, so every round is the seen one. Held is the default
  and is what a round looks like today, and unheld eroded past its radius costs
  the bake 18 stretches against 1 — but it is a capability removed, not a
  refactor.
- **The group's depth is a second erosion.** It cannot go with the members, the
  union not existing yet, and it cannot go after the round. So it is
  E(members) → fold → E(union) → R → D, and "one pipeline" is really one
  *post-fold* pipeline. A nested group still erodes once per scope.
- **The rounds have to add**, and *4.9* now measures what they do instead:
  today a member's own round replaces the group's outright. The deform's half is already answered: *3.1*
  makes two namings' patterns add as offsets standing on each other, and group
  amplitude plus member amplitude is the same arithmetic. The round has no such
  answer today, the group's round being laid over a member's already-rounded
  corner by construction rather than by a sum.
- **Fewer teeth at depth**, per *4.2*. Whether that is the right look is a look
  question, and the one thing here numbers cannot settle.

### 4.4 The work

1. **Done** — the measurement of *4.2*, and the `ORDER` switch it rides on.
2. **The rounds add, and so do the amplitudes.** *4.9* measures what stands in
   its place today, and it is nothing: a member's round replaces the group's. Members stop applying their own
   round and deform and publish them per edge and per corner instead, beside the
   lines and arcs *2.2* already has them publishing. A run of the fold sums what
   it inherits. This is the piece the ordering is *for*, and nothing in *4.2*
   tests it: that prototype still has members rounding themselves before the
   fold, so no corner ever carries two bevels. Measure it the same way, on the
   same world, before building on it.
3. **A scope's own arcs get names** (*2.3*), since a nested group needs its
   curves named and not only its straights.
4. **Done, and there is nothing to build** — see *4.8*. A group already has its
   fades, and measured, `erd` needs them less than what ships does.
5. **The pinch** (*4.5*), on by default.
6. **The removals** (*4.6*), once nothing reads them. `baseline.golden.json`
   regenerated once, at the end.

### 4.5 The pinch, reproduced

Teeth laid after the erosion are not eroded, so nothing makes a tooth vanish as
the walls thicken. Three things this is *not*, each checked rather than assumed:

- **Not a bad outline.** The crossing opens from a point, so the outline is
  continuous; what changes is combinatorics, which is what a stretch boundary is
  for.
- **Not more events.** A tooth pinching off today is also one event per tooth.
  The difference is direction: a pinch is terminal, so past that depth the wall
  is quiet, while teeth that persist keep making events. Bounded either way.
- **Not a broken guarantee.** Nothing downstream reads the depth as clearance.
  `BakedSpan.depth` is the nesting depth, the game is handed outlines and never
  sees an erosion, and no connectivity is taken anywhere.

So the look and the vertex count are had back by reproducing the pinch rather
than measuring the clearance: today's pinch is a function of the amplitude, the
spacing, the depth and the tooth's own angle — all local, all in hand — so the
amplitude is faded by that same law. Measuring the true clearance is the thing
to avoid: it is a medial-axis query, so the deform would depend on the whole
outline and would jump wherever the nearest opposite wall changes identity, a
discontinuity tied to no event the arrangement has.

It costs some exactness — the amplitude regains a dependence on the depth — but
it is a smooth scalar on the height and the apex still does not walk a mitre.

### 4.6 What goes

`CRAMMED` and `ArcTeeth.seen`, with the whole of the drawn-arc-against-seen-arc
handling; `ArcTeeth` itself, and `arcRun`'s merging of a tooth with a facet; the
curvature limit of phase 1; whatever is left of `squareIn`, `restSquare` and the
`flat` flags; `effectedSquare` and `imaged`; `Options['round'].held` and the
tick beside it; the geometric half of `Effected.apart`, which is inert — counted
over `bake.test.ts` the naming's list is consulted 972 times and the geometry's
aside is true twice, at the two ends of a span where it changes the outline by
nothing to sixteen digits.

What stays: the arcs and their ids, the fold at depth nought, the naming of
*2.2*, and `patternRun` unchanged but for the arguments it is given.

### 4.7 Tests

A polygon eroded, rounded and deformed has teeth of one size along straights and
arcs alike, with none on a corner the erosion made. A tooth stays put along its
edge as the depth runs, and the ends fade in and out. A sealed group's outline
is a polygon's: one pattern, no seam where two members meet, teeth on the arcs.
A member with a round and a deform of its own inside a group with both gets the
sum at every corner and edge, and the same shape as a polygon drawn that way.
With the pinch on, a wall eroded past the teeth is smooth; off, it is not. And
the baked span of each against its still.

### 4.8 A group's fades: measured, and already there

`experiments/groupfades.test.ts`. Two rooms sealed with a round of their own
and a span over which the group's deform comes up out of nothing, baked and
then checked at nine hundred instants that are not the ones the bake checked
itself at:

| span | rde (ships) | erd |
|---|---|---|
| deform up from nothing | 1 stretch, 0 jumps, drift 0 | 1 stretch, 0 jumps, drift 0 |
| the same, bevel 40 | 1 stretch, 0 jumps, drift 0 | 1 stretch, 0 jumps, drift 0 |
| deform there, growing | 1 stretch, 0 jumps, drift 0 | 1 stretch, 0 jumps, drift 0 |
| **deform up while eroding** | 28 stretches, 2 jumps, drift **0.2933** | 18 stretches, 2 jumps, drift **0.0141** |

A deform arriving on a group costs one stretch and nothing else — the fade
machinery reaches a scope already: `shapedFold` keeps both passes' fades,
`Contributed.faded` carries them and `groupFading` puts them onto the side
beside its members'. So *3.1*'s work was not the polygon's half of anything.

The one span that costs is the deform arriving *while* the group erodes, which
is *3.4*'s case again, and it is the second measurement saying the same thing:
`erd` pays 18 stretches where the shipped order pays 28, and stays twenty times
nearer the truth between them.

### 4.9 Two rounds at one corner: today there is no law

`experiments/sumrounds.test.ts`. A room inside a sealed group, the room rounded
by `member` and the group by `group`, against a plain polygon rounded outright
by one amount. Three rooms — a square corner, a shallow one and a sharp one —
and the amounts crossed.

**A member's round replaces the group's, exactly.** In fifteen of eighteen
cases the group's outline is the polygon rounded by the *member's* amount alone,
to 3e-14. The group's bevel is not diminished, not averaged and not clipped: it
is gone.

**And it is one line.** `foldShaped`, in `geometry.ts`:

```ts
const bevels = ring.map((_p, i) => (sq[i] || mine[i] !== null ? 0 : drawnAt(ring, i)));
```

`mine[i]` is the member arc the ring point lies on, and a point on one takes a
bevel of nought. So a corner a member has rounded is not rounded again — the
group's round reaches only the corners no member published an arc for, which in
a group whose members round themselves is the joins and nothing else. It is not
a law that loses an argument; it is a rule that says the second round does not
apply, and at every amount, every angle and every facet count it holds exactly.

**And it goes at the first hundredth of a unit.** Group 30, and the room
rounded by nought draws R(30); by 0.01 it draws R(0.01), which is 7.95 away.
There is no ramp between them.

| member | group | what it draws | from R(group) |
|---|---|---|---|
| 0 | 30 | R(30) | 0 |
| 0.01 | 30 | R(0.01) | 7.952 |
| 1 | 30 | R(1) | 7.690 |
| 10 | 30 | R(10) | 5.303 |

**The three that do not vanish are worse.** Sharp corners with a member bevel
of 30 or 40 keep something of both — and blow the ring from 36 points to 168,
the group's round re-rounding the facets of the member's arc.

**It does not pop, which is why nobody saw it.** A span over which a member's
round comes up from nought inside a group's 30 bakes to one stretch, no jumps
and no drift at nine hundred instants: the outline is R(m(t)) the whole way,
with the group's 30 absent at both ends and everywhere between. A silently
missing effect, not a discontinuity.

So step 2 is not a change of law. It is a law where there is none, and the sum
costs nothing to draw: R(member + group) keeps the same 37 points today's
composition does.

What *4.9* does not settle is the sum where the two together exceed the edge
they stand on — the clamp, and what a corner does when its neighbours' bevels
meet. That wants the prototype.

## Method

Three rules, each of which cost several passes to learn.

**Rank the steps, do not max them.** *3.4*'s pop reads 2.73 at four hundred
steps and the ambient step on that span is 0.23 — a figure nobody had asked for
until late. Ranked, the span is median 0.232, 90th 0.415, and two outliers.
Measure the floor before the peak.

**Refine until the number stops moving.** At 400, 1600 and 6400 steps a smooth
figure's worst divides by four each time; a discontinuity converges. This is the
cheapest test there is for telling them apart and it should come before any
reading of the geometry. It is also why the whole step profile matters rather
than the single worst number: the pop of *3.1* was three unrelated defects
stacked on one figure, and the one that owned it was at the opposite end of the
span from where forty steps made it look.

**A prototype must not switch on what is being swept.** The `ORDER` rig took
the shipped path whenever the depth was nought, and so manufactured a
discontinuity at the first step of every erosion — one that ranked, converged
and read exactly like a real one (*4.2*). Sweep a quantity and every branch on
it is a suspect before the geometry is.

## Open questions

- **How two rounds add at one corner.** *4.4* step 2. *4.9* settles what today
  does — the member's round wins outright — but not what the sum should look
  like where the two together exceed the edge they stand on.
- **Seams at the middle of an arc** between two differently deformed edges, or
  one deform carried round the corner, which gives up the middle anchor on one
  side. Making the arc an ordinary run does not answer this; it makes it the
  same question a straight already asks.
- **The arc tooth's angle** (*3.2*): marched by length it is not linear in the
  depth, and by `u` it is worse. There may be a third way — an anchor that holds
  the angle while the spacing stays a world length — or it may be a term to pay,
  as today's teeth pay one.
- **What the pinch's law should be exactly** — the depth at which a tooth of a
  given amplitude, spacing and angle would have pinched is arithmetic, but
  whether the fade should reach nought there or short of it is a look question.
- **A tooth with no wall to stand on** (*3.3*): whether to lay the pattern over
  the union of a span's two reaches, and whether a tooth off the end of its wall
  should be kept at all.
