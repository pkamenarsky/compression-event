# Plan: erode first, round next, deform last

Before this plan a thing went **deform → erode → round**: its edges got teeth as
though drawn by hand, the teeth were eroded with everything else, and the round
was laid on what the erosion left. Everything between the two — `clear`,
`unrounded`, the `flat` flags, `squareIn`, `restSquare` — existed to keep them
out of each other's way.

Phase 1 turned it to **round → deform → erode** for a polygon, phase 2 gave a
sealed group the same pipeline over the fold of its members, and phase 3 moved
the deform past the erosion to **round → erode → deform**, for a polygon.

Phase 4 takes the last step, to **erode → round → deform**, at every level. The
reason is not the look, which barely moves: the depth is the only one of the
three that cannot be lifted onto a union, so putting it first is what collapses
a group's two pipelines into one.

```
members eroded by their own depths → fold → eroded by the scope's depth
  → rounded once → deformed once, each run taking the amounts it inherits
```

So a member no longer rounds or deforms itself. It publishes what it is owed —
a bevel per corner, an amplitude per edge — and the scope that folds it lays
both, once, on the union. A member's amounts and the scope's **add**.

Teeth stay corners in the output. They go through the arrangement, change
topology, and get their vertical lines exactly as they do now; detecting slope
at runtime is not an option. Nothing about the playback design changes.

**Three properties this is for.** Nothing below is worth having if one of them
breaks:

1. **A sealed group draws what its members draw.** The same shape drawn as one
   polygon and drawn as members of a group is the same outline, however deep
   the nesting. Today it is not: *4.5*.
2. **A vertical pops only where a corner is really made or lost** — by an
   erosion closing a notch, by a tooth crossing a wall — and never at a
   threshold in a classification.
3. **A scope composes.** A group of groups resolves as the flattened thing
   would, so nothing in the pipeline may depend on being at the top.

## What changes in the look

- **A corner the erosion makes is square**, and only that kind. Where two walls
  grow into each other, or a tooth pinches off, nothing rounds the result: such
  a corner has no name, and it comes and goes with the depth, so there is
  nothing for it to inherit. **A join is not one of these.** Where two members'
  outlines cross, the union has a corner that is there at depth nought and
  stays, and it takes the scope's own bevel and amplitude as any corner of the
  scope's outline does — it is rounded today and must go on being rounded.
- **A group looks like a polygon.** One pattern along the union's outline, none
  on the joins inside it, teeth on the group's arcs.
- **A member's bevel starts working inside a group.** Today it silently
  replaces the group's (*4.5*); summed, both are drawn. Every existing level
  that rounds a member inside a rounded group changes.
- **Teeth do not erode.** They are laid on the eroded outline, so nothing is
  self-limiting; the pinch comes back as a law of its own (*Step 7*).
- `baseline.golden.json` is regenerated once, at the end.

## Why it bakes

Each step is linear in its own amount, in the frame it is taken in:

- an erosion moves a corner by the depth along a direction of its angle alone
  (`mitred`);
- a round's point is the corner plus the bevel along its two edges, times
  multiples of the corner's angle and `u` alone (`Curve`);
- a tooth is a point of the path plus the amplitude along the path's normal
  there, times the pattern.

So a stretch holds wherever the combinatorics hold, and the round and the deform
are, to the bake, what drawn corners and today's teeth are to it: corners with
ids, carried by `budding` and `effectsOver` across a span.

The deform being last is what buys the exactness. A tooth's apex sits on an
edge, not at a corner: the offset line, linear in the depth, plus the amplitude
along a normal that does not turn. No mitre, no `1/sin`. The old order walks
each apex along its own mitre by `d / sin(θ/2)`, and a deform whose amplitude
moves is a deform whose every θ moves — a curve per tooth.

**A tooth on an arc is laid as any other tooth**: one every spacing by length
out from the anchor, fading within a spacing of either end through `room`, at
full height between. `patternRun` does not care whether a run came from an edge
or an arc, and the fold's `curved` lays them along the curve as `arcRun` does
for a polygon.

# What the earlier phases established

Everything here is in and is load-bearing for phase 4.

### The round is drawn in the projection, not as corners

Arcs that were corners of the polygon would take the drawn corner out of its
ring, and the editor's handles, edges and `addVertex` all stand on it. So
`Resolved` keeps its corners as they were and `project` draws the outline.

### An arc's teeth push the whole arc

Each of its points goes off the curve by what the teeth either side say, in
proportion — a tooth is a triangle standing on the curve, its feet `falloff` of
the spacing away, never less than `NARROWEST`. Laid only as points among the
facets, a tooth sliding past a facet point swapped places with it in the ring
and the bake cut every such instant to its narrowest width.

Each edge's teeth start off its middle by a share of the spacing its seed gives
it (`Effecting.offset`), so a short edge may have none.

### Where a pattern is anchored (2.1)

A union edge is a run of member edges. The run takes one name — the
lowest-ranked member edge lying along it — and its teeth are laid from **that
edge's own middle**, across the whole run. So two members side by side along one
wall get one pattern across the join, nothing at either end of the run moves a
tooth, and a run split in two leaves the piece that keeps the naming edge
untouched.

Rank rather than the edge under the run's middle: members sliding until the join
passes the middle would otherwise flip the name and jump the pattern with no
event to hide it.

### Naming the union's straights (2.2)

A union straight lies on the line of exactly one member edge — the arrangement
cuts edges up and drops the pieces inside, but never moves one off its line. So
a member publishes its eroded edges as lines and the fold names each straight by
the line along it. `namesOf` publishes, `movedIn` carries a published line
through an enclosing scope's erosion.

Tagging the union was rejected: a tag names a *shape* point, so it would still
have to be taken back to an edge, and it would have to survive `erode` on the
way up through a nested scope, which a line does for nothing.

### The tooth keeps its place

`patternRun` takes an anchor and allows it outside the run, and a mitred offset
keeps an edge's identity: the eroded edge is the source edge translated along
its normal and re-trimmed. So the anchor is the source edge's middle pushed out
by the depth, its coordinate along the edge does not move with the depth at all,
and teeth only enter and leave at the ends, through the `room` fade.

`reach` is how: given the length the teeth belong to, the same teeth are laid at
every depth and one whose room has run out stands flat rather than going.

### What phase 3 put in for a polygon (3.1)

- `deformedAt` no longer subdivides; `Vertex.root` is dead in every path a
  polygon takes.
- A polygon names its runs from `owner` rather than by matching lines.
- An edge can carry more than one pattern: both namings of a splitting wall are
  laid and **added**, each read at every station with the offsets standing on
  each other. Interleaving them put a return to the wall between every pair of
  apexes. This is the arithmetic a member's amplitude and a scope's will use.
- A corner is set aside for the geometry only where it is flat, which is the end
  that invented it — `near[i] && far[i]`, needing no knowledge of `t`.
- `reach` boxes a polygon with its teeth's amplitude. This is the one that fails
  quietly: an undersized box drops a polygon from a neighbour's neighbourhood
  and the events between them are never looked for.
- **A deform from nought fades in.** `foldShaped.fades` keeps a flat tooth in
  the ring, `Imaged.flat` and `Contributed.faded` carry it, `teethFading` gives
  it a fade. It changes no opacity: it changes `explained`, which called a tooth
  standing out of a flat wall an unaccounted corner and cut instead of letting
  the line fade in.

### What the deform-last experiment found (3.2)

`experiments/deformlast.test.ts`, on a room with no two corners alike. A span
that moves the amplitude is exact, and so is one with no teeth; every mixed span
is two to five times better. The one thing not better is a tooth on an arc, and
it is the geometry rather than the prototype: at 2, 4, 8, 16 and 32 segments the
figure converges on 1.19, because a tooth marched out by the spacing sits at an
angle of its length over the radius and the erosion moves the radius. Anchoring
by `u` instead holds the angle and is worse everywhere.

Points carried, at amplitude 6 — what the pinch has to buy back:

| depth | 0 | 6 | 20 | 40 |
|---|---|---|---|---|
| today | 34 | 31 | 16 | 1 |
| deform last | 38 | 38 | 38 | 42 |

### The two parked bake tests (3.3)

**`an edge growing longer gets more points, and they fade in`.** The pattern
re-phases as the wall grows: tooth `j` runs −1 to 1 at the near end and −2 to 3
at the far. The sliding is fine. What has no answer is `j` of −2 at the near
end, which would stand off the end of the wall; `reach` clamps it onto the
corner and it is dropped as a duplicate. Wants the pattern laid over the *union*
of the two ends' reaches — the same shape of answer as the two namings.

**`a corner arriving on a deformed floor starts from the editor's pattern`.**
Four of seven jumps gone. The three left are together at `t` 0.6939, where the
arriving corner and a tooth of the far naming cross: two ring points swapping
order, which is an event and not a fade, and one crossing costs three cuts.

### Why the group popped (3.4)

`world-2026-09-22T21-40-17Z` — two overlapping rooms sealed, rounded 180 with a
noise deform, eroded 61 four times — pops on span 3 at 2.84. Not the naming and
not the erosion: the ring, its names, anchors, reaches and amplitudes are
identical either side, and the same ring swept over the whole depth range moves
by 0.0066.

| | apart |
|---|---|
| the two rings, before the erosion | 0.0273 |
| each eroded at its own depth | 2.8621 |
| both eroded at the *same* depth | 2.8812 |
| the *same* ring at the two depths | 0.0251 |

**It is amplification.** A tooth that shallow is a pair of nearly parallel
walls, and the wedge `erode` makes reaches where the two moved walls cross — off
towards infinity as they close on parallel. A tenth of a unit of tooth becomes
three units of outline. It wants both effects: deform alone 0.23, round alone
0.20, both 2.73 — the round's `clear` is what ramps a tooth in and out, and that
is what manufactures a tooth standing at nearly no height.

**So `fades` and a deep erosion cannot both be last**, and that is the whole
argument for moving the erosion to the front.

# Phase 4: the erosion first

## 4.1 The property

Of a scope's three effects, **only the depth cannot be lifted onto the union**.
A bevel is per corner and an amplitude is per edge, and 2.2's naming carries
both onto a union run. A member's depth is per shape, so a corner where two
members meet would carry two of them and slant the edge between.

Every order that does not put the erosion first leaves a liftable step in front
of the fold, which forces the members to run it and then forces the scope to run
it again over the top. That is the two pipelines, and it is where `squareIn`,
`restSquare`, `squaredThrough` and "hold a member's deform back and find it
again on the union edge its edge became" all come from.

**For a polygon, held, it is not a change at all.** Held draws a corner at
`bevel ± depth` so that what the erosion leaves is the arc asked for, which
makes round-then-erode give `centre(bevel) + (r ± d)·u(φ)` and erode-then-round
give `(corner + d·mitre) + bevel·u(φ)` — the same point. The whole value is at
the group.

## 4.2 What was measured

`experiments/erodefirst.test.ts`, on 3.4's world: the worst step over 1600, and
refinement at 400 / 1600 / 6400 to tell a discontinuity from a figure moving.
`shapedFold` carries an `ORDER` switch over the three orders.

| span | rde (ships) | red | **erd** |
|---|---|---|---|
| 0 | 0.0230 | 0.0230 | 0.0230 |
| 1 | 0.2138 | 0.0510 | 0.0539 |
| 2 | 0.0722 | 0.0510 | 0.0539 |
| 3 | **2.8434** | 0.0510 | 0.0539 |
| 4 | 0.3718 | 0.0509 | 0.0539 |

Refined, `erd` has **one** outlier in the whole world: 3.28 at `t` 0.1303, two
adjacent steps, ring 50 → 49 → 51 — a point leaving and two arriving, which is
one topology event and a stretch boundary the bake cuts at. `rde` has two, at
2.87 and 1.68, tied to no event. Everything else is median = worst.

**Wherever the depth is nought, `erd` is today's figure exactly** — nought apart
at the first two keyframes, the same 55 points — and parts from it smoothly as
the erosion runs: 5.9, 20.8, 38.0, 35.1.

**A finding that was the prototype's own.** An earlier run had `red` popping
21.34 on span 1 and read it as a missing fade. It was the switch: `shapedFold`
took the shipped single-pass path whenever the depth was nought, so the first
step of an erosion crossed between two constructions. With the shortcut gone
both orders are smooth at every refinement.

**And the point counts are not a trade.** `red` keeps 162 points to `erd`'s 50,
and *3.2* read that as a win. It is not: `patternRun`'s `clear` keeps teeth out
of a bevel — a tooth inside one is a corner the bevel cannot reach past — and
the `red` prototype hands its deform pass a bevel of nought, so it has no
`clear` and lays teeth straight through every arc. `erd` passes the real bevel
and keeps 50 against the 55 that ship.

## 4.3 What it costs

- **`held: false` goes.** With the round laid after the erosion there is no
  drawn-against-seen left, so every round is the seen one. A capability removed,
  not a refactor.
- **The scope's depth is a second erosion.** It cannot go with the members, the
  union not existing yet, and it cannot go after the round. So "one pipeline" is
  one *post-fold* pipeline, and a nested group still erodes once per scope.
- **Every level with a rounded member inside a rounded group changes**, because
  that bevel draws nothing today.

## 4.4 A group's fades: already there

`experiments/groupfades.test.ts`. Two rooms sealed, a span over which the
group's deform comes up out of nothing, baked and checked at nine hundred
instants that are not the ones the bake checked itself at.

| span | rde (ships) | erd |
|---|---|---|
| deform up from nothing | 1 stretch, 0 jumps, drift 0 | 1 stretch, 0 jumps, drift 0 |
| the same, bevel 40 | 1 stretch, 0 jumps, drift 0 | 1 stretch, 0 jumps, drift 0 |
| deform there, growing | 1 stretch, 0 jumps, drift 0 | 1 stretch, 0 jumps, drift 0 |
| **deform up while eroding** | 28 stretches, 2 jumps, drift **0.2933** | 18 stretches, 2 jumps, drift **0.0141** |

The fade machinery reaches a scope already: `shapedFold` keeps both passes'
fades, `Contributed.faded` carries them, `groupFading` puts them onto the side
beside its members'. The one span that costs is 3.4's case again, and `erd` pays
18 stretches where the shipped order pays 28 and stays twenty times nearer.

## 4.5 Two rounds at one corner: today there is no law

`experiments/sumrounds.test.ts`. A room inside a sealed group, the room rounded
by `member` and the group by `group`, against a plain polygon rounded outright.

**A member's round replaces the group's, exactly** — in fifteen of eighteen
cases the outline is the polygon rounded by the member's amount alone, to 3e-14,
and it goes at the first hundredth of a unit:

| member | group | draws | from R(group) |
|---|---|---|---|
| 0 | 30 | R(30) | 0 |
| 0.01 | 30 | R(0.01) | 7.952 |
| 1 | 30 | R(1) | 7.690 |
| 10 | 30 | R(10) | 5.303 |

**It is one line**, in `foldShaped`:

```ts
const bevels = ring.map((_p, i) => (sq[i] || mine[i] !== null ? 0 : drawnAt(ring, i)));
```

`mine[i]` is the member arc the ring point lies on, and a point on one takes a
bevel of nought — a corner a member has rounded is not rounded again. The
scope's round reaches only corners no member published an arc for, which in a
group whose members round themselves is the joins and nothing else.

**The three that do not vanish are worse**: sharp corners with a member bevel of
30 or 40 keep something of both and blow the ring from 36 points to 168, the
scope's round re-rounding the facets of the member's arc.

**It never pops, which is why nobody saw it.** A span over which a member's
round comes up from nought inside a group's 30 bakes to one stretch, no jumps
and no drift: the outline is R(m(t)) the whole way, with the group's bevel
absent at both ends and everywhere between. A silently missing effect.

So summing is not a change of law. It is a law where there is none, and it costs
nothing to draw: R(member + group) keeps the same 37 points.

# The work

Each step stands on its own, is committable, and has something to measure. The
existing harnesses — `erodefirst`, `groupfades`, `sumrounds` — are the yardstick
throughout, and each step must leave them where the step before did.

### Step 1: a member publishes amounts, not geometry

`Named` (`scene/core.ts`) loses its arc points and gains the amounts:

```ts
interface Named {
  lines: { id: VertexId, a: Point, b: Point, amplitude: number }[]
  corners: { id: VertexId, at: Point, bevel: number, facets: Facets }[]
}
```

`namesOf` stops asking `imagesOf` for arc runs. With the member no longer
rounding, a drawn corner's image is `mitred(source, rings, i, depth)` — one
point — and each edge's line runs from one corner's image to the next.
`movedIn` keeps working unchanged: a line goes along its normal, a corner along
its mitre, which is the one-point case of what it already does to an arc.

The amounts ride along untouched; nothing reads them yet.

*Measured by*: a member with no round and no deform must give the fold exactly
today's outline, at every depth. Nothing in the harnesses may move.

### Step 2: a member under a shaping scope resolves eroded only

`slotted` (`scene/reading.ts`) asks each member for its shape. Under a scope
with `shapedBy !== null` that shape must be the member **eroded at its own
depth, with its round and its deform not applied** — `resolveAt` / `imagedBy`
gain the mode, `Effected` contributing its depth and nothing else.

This is the step that makes a corner available to be rounded once, and it is
what takes `squareIn`, `squaredThrough`, `restSquare` and `effectedSquare` out
of the path: with no member effect geometry on the union there is nothing on it
to protect from the scope's round.

*Measured by*: the fold's ring now has the members' true corners in it. With the
scope's own effects only, `erodefirst` must be unchanged; with a member's
effects on, the outline loses them — which is expected and is what step 3 gives
back.

### Step 3: `foldShaped` takes a bevel and facets per corner

`bevel: number` becomes a function of the name, beside `deform.amplitude(key)`,
and 4.5's line stops zeroing:

```ts
const bevels = ring.map((_p, i) => (sq[i] ? 0 : bevelAt(names[i], ring, i)));
```

A ring point that is a named corner's image takes **the scope's bevel plus that
corner's own**. `facets` resolves the same way, per corner, since two members
may ask for different precision.

A ring point that names nothing is one of two things and they are not alike:

- **a join** — two members' outlines crossing — which is in the fold at depth
  nought and takes the scope's own bevel and amplitude, as it does today;
- **a corner an erosion made**, which appears only once the scope's erosion has
  run and takes nought.

The two are told apart by construction, and cheaply: the fold happens at depth
nought on members already eroded, so every corner of *that* ring is either a
member's or a join, and anything the scope's erosion adds after it is the other
kind. Where a cheaper test is wanted, a join is an unnamed corner with a named
run on both sides of it, and an erosion's corner has a nameless run beside it.

**The clamp is the one there is now, unchanged.** `arcsWith` already rations a
corner's bevel: `t = min(wants[i], room(before), room(after))`, where a
neighbour's room is `length - min(wants[other], length / 2)` — each corner takes
at most half an edge where its neighbour wants half too, and all of what is left
where the neighbour wants less. Summing changes `wants[i]` and nothing else, so
two bevels that together exceed the edge they stand on are rationed exactly as
one too-large bevel is today. Symmetric, order-independent, and continuous in
both amounts.

Continuous, but bent: the crossover from *what was asked* to *what there is room
for* is a kink in an otherwise linear path, not a jump. No corner is made or
lost there, so it wants no event — the chase re-cuts the stretch if the bend
costs more than the tolerance, which is what the chase is for.

The amplitude's half needs no new machinery: `deform.amplitude(key)` already
takes a name, and 3.1 already adds two patterns on one edge as offsets standing
on each other. Summing what a run inherits is the same arithmetic.

*Measured by*: `sumrounds` — a member rounded 10 inside a group rounded 30 must
draw R(40), to the same 3e-14 with which it draws R(10) today, and keep the same
point count. Then the same for amplitudes, and then both at once.

### Step 4: the scope's erosion moves after the fold

`shapedFold`'s `erd` branch becomes the path and the `ORDER` switch goes: fold
the members — already eroded by their own depths — at depth nought, erode the
union by the scope's depth, then one `foldShaped` pass that rounds and deforms
at depth nought. The `held` argument goes with it.

*Measured by*: `erodefirst` with no switch set must print what `ORDER=erd`
prints today, and `groupfades` must keep its 18 stretches and 0.0141.

### Step 5: a scope publishes its own names

For nesting, `resolves` must publish what the *fold* came to and not what its
members published: each union straight with the amount its run inherits, each
union corner with its summed bevel, each join nought, the lot moved in by the
scope's depth. This answers 2.3's "a scope's own arcs have no names" by removing
the question — there are no arcs to name, only corners and amounts.

**The naming needs nothing new.** Ids are counted out of one `world.nextId`, so
a `VertexId` is unique across the world and not merely within its polygon. Once
step 2 has the members' real corners in the fold's ring, every corner of the
fold is one of two things: a member corner's image, which keeps that member's
id at any nesting depth, or a join — or a corner the erosion made — which takes
no name, and so no bevel and no amplitude, which is what *What changes in the
look* already says. `movedIn` carries the id up with the point.

What is left to settle is not the id but the arithmetic above it: a scope two
deep publishes a corner whose bevel is already a sum, and the scope above adds
its own to that. Associative on the face of it, and to be tested rather than
assumed.

**Where it can go.** This step needs 1 for the amounts, 2 for the corners and 3
for the sum, but it does not need 4 — it can be taken directly after 3 if the
nesting is what wants proving first.

*Measured by*: property 3 — a group of groups against the flattened thing, at a
depth for each scope. This is the first step that can break composition, so it
is the first that must test it.

### Step 6: the polygon takes the same order

`imagedBy` becomes erode → round → deform, which by 4.1 draws what it draws
today wherever `held` is on. `Options['round'].held` and the tick beside it go.

*Measured by*: `deformlast`'s table must not regress, and `divergence` must hold
its tolerance on every world in it.

### Step 7: the pinch — optional, and measured

**It is not necessary.** `experiments/pinch.test.ts` erodes a room with teeth
and without, a polygon already laying its teeth last:

| depth | amplitude | stretches | jumps | points, 0 → ½ → 0.9 → 1 |
|---|---|---|---|---|
| 40 | 0 | 157 | 36 | 84 → 38 → 21 → 45 |
| 40 | 6 | 430 | 83 | 91 → 85 → 63 → 62 |
| 80 | 0 | 166 | 40 | 84 → 21 → 13 → **29** |
| 80 | 6 | 566 | 118 | 91 → 62 → 28 → **29** |
| 80 | 14 | 595 | 124 | 91 → 61 → 28 → **29** |

**The arrangement eats the teeth on its own.** At the end of a deep span the
outline has the same points with teeth as without — 29 at a depth of 80, 21 at
95 — because a wall thin enough loses its teeth to the crossing whether they
were eroded or not. 3.2's 38 → 38 → 38 → 42 was the geometry `imagedBy` makes,
not the outline the arrangement returns. So nothing runs away, and doubling the
amplitude costs five per cent.

**What it would buy is the middle and the bill.** Halfway into a depth of 80 the
toothed outline holds 62 points against 21, which is the look question; and
teeth cost about three times the stretches and the jumps for the whole span,
which a fade to nothing would quiet over its second half.

So this is an economy and a look, to be taken when the rest is in and judged in
the browser — not a correctness step, and nothing above depends on it.

### How it would be done

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

So the look and the vertex count are had back by **reproducing** the pinch:
today's is a function of the amplitude, the spacing, the depth and the tooth's
own angle — all local, all in hand — so the amplitude is faded by that same law.
Measuring the true clearance is the thing to avoid: it is a medial-axis query,
so the deform would depend on the whole outline and would jump wherever the
nearest opposite wall changes identity, a discontinuity tied to no event the
arrangement has.

It costs some exactness — the amplitude regains a dependence on the depth — but
it is a smooth scalar on the height and the apex still does not walk a mitre.

*Measured by*: with the pinch on, a wall eroded past its teeth is smooth; off,
it is not. Point counts against 3.2's table.

### Step 8: the removals

`CRAMMED` and `ArcTeeth.seen`, with the whole of the drawn-arc-against-seen-arc
handling; `ArcTeeth` itself, and `arcRun`'s merging of a tooth with a facet; the
curvature limit of phase 1; whatever is left of `squareIn`, `restSquare` and the
`flat` flags; `effectedSquare` and `imaged`; the geometric half of
`Effected.apart`, which is inert — over `bake.test.ts` the naming's list is
consulted 972 times and the geometry's aside is true twice, at the two ends of a
span where it changes the outline by nothing to sixteen digits.

What stays: the arcs and their ids, the fold at depth nought, the naming of 2.2,
and `patternRun` unchanged but for the arguments it is given.

`baseline.golden.json` regenerated once, here and not before.

## The edge-to-arc handover pops, today

`experiments/arcseam.test.ts`. An edge's teeth stop short of its corners'
bevels (`patternRun`'s `clear`) and an arc's teeth are a run of their own,
keyed by the arc and anchored at its middle. So as a bevel grows the edge
shortens, the arc lengthens, and a tooth is handed from one run to the other —
at a threshold, not at an event. Sweeping the bevel with teeth on, ranked and
refined:

| span | 400 steps | 1600 steps | worst at |
|---|---|---|---|
| bevel 4 → 14, no teeth | median 0.0067, worst 0.0513 | 0.0017 / 0.0500 | ring 35 → 36 |
| bevel 4 → 14, amplitude 6 | 0.0075 / **4.0924** | 0.0019 / **4.0953** | `t` 0.6006, ring 87 → 85 |
| bevel 0 → 60, amplitude 6 | 0.0486 / **4.1268** | 0.0121 / **4.0961** | `t` 0.1663, ring 87 → 85 |
| bevel 0 → 60, amplitude 14 | 0.1049 / **8.8147** | 0.0262 / **8.7493** | `t` 0.1663, ring 87 → 85 |

**It is a discontinuity and it scales with the amplitude.** The median divides
by four with the steps, so the figure is smooth; the worst does not move at all
between refinements, and it goes 4.10 to 8.75 as the amplitude goes 6 to 14 —
a tooth of full height leaving the ring rather than fading out of it. Same `t`
for both amplitudes, same two points.

This is today's polygon, so it is not the ordering's doing and phase 4 inherits
it. It is also exactly the shape property 2 forbids: a threshold in a
classification, with no corner made or lost to hang an event on.

It is not yet diagnosed. Both runs fade at their ends — the edge's through
`clear`'s ramp, the arc's through `room` — so the fault is in the handover
between them and not in either fade. The likely suspects, in order: the arc's
run takes no `reach`, so a tooth with no room is dropped where an edge's is
kept flat; and the arc's run is keyed by the arc, so a tooth that crosses is a
different tooth with a different `j`, which no fade can join up.

**Where it goes in the work.** It blocks nothing in steps 1 to 6 — it is there
now — but it must be answered before the plan can claim property 2, and the
answer probably lives in the same place as the two parked bake tests: a pattern
laid over a run's ends rather than per classified piece.

## Tests

A polygon eroded, rounded and deformed has teeth of one size along straights and
arcs alike, with none on a corner the erosion made. A tooth stays put along its
edge as the depth runs, and the ends fade in and out. A sealed group's outline
is a polygon's: one pattern, no seam where two members meet, teeth on the arcs.
A member with a round and a deform of its own inside a group with both gets the
sum at every corner and edge, and the same shape as a polygon drawn that way. A
group of groups is the flattened thing. With the pinch on, a wall eroded past
the teeth is smooth. And the baked span of each against its still.

## Method

Four rules, each of which cost several passes to learn.

**Rank the steps, do not max them.** 3.4's pop reads 2.73 at four hundred steps
and the ambient step on that span is 0.23 — a figure nobody had asked for until
late. Ranked, the span is median 0.232, 90th 0.415, and two outliers. Measure
the floor before the peak.

**Refine until the number stops moving.** At 400, 1600 and 6400 steps a smooth
figure's worst divides by four each time; a discontinuity converges. The
cheapest test there is for telling them apart, and it comes before any reading
of the geometry.

**A prototype must not switch on what is being swept.** The `ORDER` rig took the
shipped path whenever the depth was nought and so manufactured a discontinuity
at the first step of every erosion — one that ranked, converged and read exactly
like a real one (*4.2*). Sweep a quantity and every branch on it is a suspect
before the geometry is.

**Find the line.** Both of the surprises here — the vanishing bevel, the extra
points — read as structural trades until the one line that caused each was
found, and in both cases the line said something simpler than the story did.

## Open questions

- **What names a corner of the fold** (*Step 5*), a `VertexId` being a
  polygon's, and what a join publishes to the scope above.
- **Seams at the middle of an arc** between two differently deformed edges, or
  one deform carried round the corner, which gives up the middle anchor on one
  side. An arc is its own run, anchored at its own middle and keyed by its own
  id, so where it meets an edge's run the two phases have nothing to do with
  each other and the gap across the join is whatever it happens to be. Carrying
  one edge's pattern round instead buys the phase and spends the anchor — and
  the anchor is what stops teeth sliding when the run's ends move (*2.1*). A
  tooth's height already crosses the arc as `mix(before, after, u)`, so the
  amplitude is a ramp and not a seam; it is the spacing that breaks. Making the
  arc an ordinary run does not answer this; it makes it the same question a
  straight already asks.
- **The arc tooth's angle** (*3.2*): marched by length it is not linear in the
  depth, and by `u` it is worse. There may be a third way — an anchor that holds
  the angle while the spacing stays a world length — or it may be a term to pay,
  as today's teeth pay one.
- **What the pinch's law should be exactly**, if it is wanted at all (*Step 7*).
- **The two parked bake tests**, both of which want a pattern laid over the
  union of two ends' reaches.
