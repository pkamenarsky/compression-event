# Plan: bevel before deform, erosion last

Today a thing goes **deform → erode → round**: its edges get teeth as though
drawn by hand, the teeth are eroded with everything else, and the round is
laid on what the erosion left. So a round runs into the teeth, and everything
between the two — `clear`, `unrounded`, the `flat` flags, `squareIn`,
`restSquare` — exists to keep them out of each other's way.

This plan turns it round to **round → deform → erode**, at every level:

- a polygon's corners are rounded as though drawn, its deform is laid along
  the rounded outline — the straights and the curves — and the erosion
  offsets the lot;
- a sealed group does the same to the fold of its members: rounds the union's
  corners, lays its deform along the union's outline, and then offsets it by
  its own depth, which is what its depth already means;
- a member's deform under a group that rounds waits for the group's round, so
  its teeth run along the group's bevel, crossings included.

Teeth stay corners. They go through the arrangement, change topology, and get
their vertical lines exactly as they do now — detecting slope at runtime is not
an option. Nothing about the playback design changes.

## What changes in the look

- **The bevel is drawn, not seen — unless it is held.** An eroded convex arc
  tightens and goes sharp once the depth passes its radius; a concave one
  opens out. Today the bevel is the same wherever it is. A round's new `held`
  option keeps it so: see *1.1*.
- **Everything erodes.** Teeth on arcs as well as on straights; their mitres
  lengthen and they pinch off as walls grow, as straight teeth already do.
- **A corner the erosion makes is square.** Where two walls grow into each
  other, or a tooth pinches off, nothing rounds the result. Today it takes
  `rest`.
- **A group looks like a polygon.** One pattern along the union's outline,
  none on the joins inside it, teeth on the group's arcs.
- Every deformed or rounded level changes: `baseline.golden.json` is
  regenerated once, at the end of phase 1, and again at the end of phase 2.

## Why it bakes

Each step is linear in its own amount, in the frame it is taken in:

- a round's point is the corner plus the bevel along its two edges, times
  multiples of the corner's angle and `u` alone (`Curve`);
- a tooth is a point of the path plus the amplitude along the path's normal
  there, times the pattern;
- an erosion moves a corner by the depth along a direction of its angle alone
  (`mitred`).

So a stretch still holds wherever the combinatorics hold, and the round and
the deform are, to the bake, what drawn corners and today's teeth are to it:
corners with ids, carried by `budding` and `effectsOver` across a span.

**A tooth on an arc is laid as any other tooth.** The arc is one more run for
`patternRun`: a tooth every spacing by length out from its middle, shrinking to
nothing within a spacing of either end, and at full height everywhere else.
Teeth may cross each other and other walls, and the arrangement settles that
as it does for any tooth now. As an arc grows it gains teeth at its ends out
of nothing, as a growing edge does. This is not linear in the bevel, since a
tooth at a fixed length along a curve that scales moves round it. The
experiment puts that at a few more stretches, not a different picture (see
*Fading and groups*).

## What the experiment found

`packages/editor/src/experiments/bevel.test.ts` prototypes phase 1's
geometry (round, teeth on the straights and on the arcs, then
`erodedCorners`) beside today's order, and measures how far the middle of a
span is from the lerp of its ends, point by point, named as the bake names
them. That is what the bake cuts a stretch finer for: each figure is a worst
point, in world units, against a tolerance of 0.05.

| span | today | planned |
|---|---|---|
| depth 0 → 5 | 1.00 | 0 |
| bevel 4 → 14 and depth 0 → 5, no teeth | 0.76 | 0 |
| held bevel, depth 0 → 8, no teeth | — | 0 |
| bevel 4 → 14, teeth on | 2.09 | 3.47 |
| amplitude 0 → 3 | 0.11 | 0.83 |
| all three together | 1.72 | 0.93 |
| a corner moving 30 | 2.75 | 0.66 |

- **A round with no teeth is exact** under any bevel and depth, held or not,
  where today's is not: the arc's points are fixed multiples of the bevel
  along directions that do not change, and so are their mitres.
- **A tooth on an arc is the one thing worse**, and only where the bevel or
  the amplitude changes with a depth on: its mitre turns with its angle,
  which is the ratio of the two. Today's teeth have the same term, smaller
  because a straight's teeth are blunter. More stretches where it happens,
  not a wrong picture. Three teeth forced onto a small arc make it worse
  (4.26), so the count from the arc's length matters.
- **A tooth and a facet turn at the same `u` must be one point**: flat, they
  coincide, the edge between them has no length, and its mitre is anything.
  So `arcRun` merges them (*1.2*). The same holds for anything the round lays
  on top of anything else — a flat tooth is never put on an arc's end.
- **The arrangement keeps them**: 70 points in, 66 out on a shallow erosion,
  one ring and the right area past the radius, 2–5 ms an erosion.
- **A union's corners can be named** by the member corner they are or the two
  member edges that cross there, and the names hold across a motion that
  keeps the topology (*2.2*).

### The real bake

The same file bakes a 200-unit square room both ways with `bakeSpan`:
- **Today:** its effects, with the amounts written at each keyframe.
- **Planned:** a plain room whose corners are the prototype's round and teeth
  at each keyframe, the far keyframe's written as nudges, and the same
  erosion.

The planned version is exactly the plan's pipeline wherever that is linear in
time, and the table above says where that is. Spacing 20, four segments, one
tooth on each arc. Each figure counts stretches:

| span | today | planned | held | held, no arc teeth |
|---|---|---|---|---|
| no teeth, bevel 6 → 18, depth 0 → 20 | 1 | 18 | **1** | — |
| no teeth, depth under the bevel | 1 | 1 | 1 | — |
| teeth, depth 0 → 6 | 1 | 6 | 6 | 2 |
| teeth, bevel 4 → 12 | 4 | 7 | 6 | **1** |
| teeth, amplitude 1 → 6 | 4 | 10 | 5 | **4** |
| teeth, all three, small | 5 | 12 | 8 | 6 |

Every span stays inside the tolerance. Here is what the counts show:

- **An unheld round eroded past its radius is expensive.** Its facet edges
  shrink to nothing one at a time, and each one is a topology event. Held,
  that never happens and the cost is today's. So held is the default, and it
  is what the bake wants as well as how a round looks today.
- **Teeth on the straights cost about what they do today**, sometimes less.
- **Teeth on the arcs are nearly all of the extra.** On a short arc a tooth is
  a spike: its edges are a facet long and a tooth high. Erosion collapses
  them, and those are real events in the new picture, not the bake being
  careless. What a tooth on an arc costs follows from how sharp it is, so the
  count and height `arcRun` gives an arc matter for the bake as well as the
  look. One way is to scale a tooth's height by how much room it has along
  the arc, as a straight's is scaled by its distance from an end.

### Fading and groups

Both are in the same file. A point that only one end of a span has is placed
at the other end the way the bake seeds a corner: half way between its
nearest neighbours there. This covers a straight's tooth that a growing bevel
eats, and a tooth arriving on an arc. The other way an arc can fade a tooth in
is **rising**: the far end's teeth are laid at both ends, flat on the curve at
the near one, as the plan's fade does.

**Fading.** A 200 square with teeth, held, while the bevel grows:

| span | today | seeded | rising |
|---|---|---|---|
| bevel 10 → 40, depth 4 (arc teeth 0 → 2, 16 straight teeth eaten) | 5 | 14 | 28 |
| bevel 10 → 40, depth 0 → 10 (0 → 3, 20 eaten) | 9 | 14 | 12 |
| bevel 10 → 60, depth 4 (0 → 3, 28 eaten) | 9 | 12 | 13 |

**A sealed group.** Two rooms overlapping, with one sliding so that the
crossings move in straight lines. Today is the group with its effects. Planned
is the union's ring at each end, named, rounded and deformed by the prototype
(held), and baked as one plain room:

| span | today | planned |
|---|---|---|
| round only | 8 | 8 |
| round, group depth 0 → 6 | 12 | 8 |
| round and deform | 12 | 8 |
| round, deform, depth, an arc tooth arriving, seeded | 12 | **48** |
| the same, no arc teeth | 12 | 8 |
| the same, the arc tooth there throughout | 12 | 10 |
| the same, the arc tooth rising | 12 | 12 |

What the two tables show:

- **A group's round and deform cost no more than today**, and sometimes less,
  when laid on the union. The crossings here move in straight lines. A
  turning member would make them curve, both today and planned.
- **Teeth arriving on an arc must not be seeded like corners.** A tooth put
  half way between its neighbours then has to reach its place and rise while
  it is eroded. That cost 48 stretches against 12.
- **Arc teeth laid as any other** (see *Why it bakes*) cost 10, 16 and 14 in
  the fading rows, and 8 in the group. That is the best or near it
  everywhere, and it is what the plan now says. The table cannot see a tooth
  moving round the curve, because the planned side moves its corners in
  straight lines. That was measured on its own: half way through a span, a
  tooth is 0.06–1.1 units from its straight line, for bevels 30 → 40 up to
  10 → 40. Most of it comes from the end ramp. It is about the size of
  today's own nonlinear terms, and the bake chases it with a few more
  stretches.
- **Rising is not always better.** On a small arc that grows fast (the first
  fading row), laying the far end's teeth flat onto the near end's arc packs
  them tightly among the facets, and it cost twice what seeding did. Laying them
  as any other avoids this.
- **Where the bevel grows a lot, fading costs 1.3–3× today.** This is the one
  place the plan is clearly dearer, and it is bounded.

## Phase 1: a polygon

### 1.1 Rounded as drawn

`rounded` already makes a ring with every corner's arc in it, `n + 1` points a
corner whatever the bevel. It becomes the first thing done to a polygon's
standing corners, in its own frame, before the deform:

- each arc point is a corner of its own, with an id made the way `toothId` is
  — the corner it rounds and which point of the arc — so the bake carries it
  and a keyframe's arc point is the same point at the next;
- its extra depth is its corner's; a varying erosion leaves an arc offset
  evenly;
- a bevel of nought is still `n + 1` coincident points, and the arrangement
  welds them as now; the bake seeds such an end rather than collapse it
  (`seed` in `effectsOver`).

**Held.** `Options['round']` gains `held: boolean`. Held, a corner's bevel
is drawn as `bevel + depth` where it turns out of the material and
`bevel - depth` where it turns in, clamped at nought, so what the erosion
leaves is an arc of the bevel asked for, at any depth. Still linear in the
bevel and the depth, and continuous as a corner flattens and turns the other
way, since its arc there is a sliver along its wall whatever its bevel. The
clamp is a kink in time, which the bake cuts a stretch at like any other. The
default is held, which is how a round looks today; unheld tightens as walls
grow. A tick in the round's section of the inspector.

Where: a new `roundedAt` beside `deformedAt` in `scene/core.ts`, called first
in `resolveAt`, and the same in the bake's `effectsOver` path. `effectedOf`
stops describing a round laid after erosion and describes the round laid
before it: facets per corner, bevels, and nothing else — `own`, `bevel` and
`flat` go (see *1.4*).

### 1.2 Deform along the rounded path

`subdivided` takes a ring and lays teeth on its edges. It learns what a run is:
a straight between two arcs, or an arc.

- **On a straight**, `patternRun` as today, with `clear` and `clearTo` the
  lengths the arcs at its ends take off it — always, not as an option. The
  teeth shrink to nothing where the arc starts, and are continuous in the
  bevel.
- **On an arc**, a new `arcRun`: `patternRun` over the arc's length, each
  tooth put back on the curve at the `u` its length falls at (the curve's
  lengths tabulated once per angle, as `spread` tabulates its weights), and
  pushed along the curve's normal there. The normal comes from `Curve`'s
  tangent, not from the facet the tooth lands on, so the teeth follow the
  curve and not its facets, which is the point of the whole change. Its
  pattern is keyed by the corner's id, so noise belongs to the corner.
- **Its amplitude** is the corner's two edges' amplitudes, blended across
  the arc, so a corner between an edge deformed on its own and one that is not
  goes smoothly from one to the other.
- **Its ids**: `toothId(owner, corner, j)` for the straight's teeth as now; an
  arc's are `arcToothId(owner, corner, j)` under a different tag, so a tooth
  that moves from a straight onto an arc is a different corner and the bake
  sees one go and another come, each out of nothing.

A tooth on an arc is a point of the curve, not of a facet, so the facets and
the teeth are laid together: the arc's points are its facets' turns and its
teeth, merged in order of `u`, each on the curve.

Where: `geometry.ts` (`arcRun`, `subdivided` taking runs), `deformedAt`
taking the rounded ring and the arc points' ids.

### 1.3 Erosion last

What goes into `project` is now the source with its arcs and teeth in it, and
the effects are nothing: `offsetOf(source, rings, erosion, depths)` and the
arrangement, as a polygon with no effects has always been. `imagedBy` and the
`effects` branch of `project` go.

The bake stops asking `imagesOf` where a round is: every point it cares about
is a corner and `mitred` is the answer, as it is for a polygon with no effects.
Its three uses go with it:

- `straightOf` (`bake.ts`) — the straight of an edge is now between two corners
  of its own;
- the seeding and fading at `bake.ts:1430` and `:1540` — an arc's fading points
  are its own corners' points on the facets, read off the source ring rather
  than off `imaged`.

### 1.4 What goes

- `Effects.deform.clear`, the "clear corners" tick in `inspector.ts`, and
  `Deforming.clear`; a saved `clear` is dropped by the version's converter.
- `unrounded`, `Effected.flat`, `own` and `bevel`, and `effectKey`'s share of
  them.
- In `geometry.ts`: `imaged`, `Imaged`, `effectedSquare`, `effected`,
  `arcRuns` for polygons — whatever of them phase 2 does not still need.
- The comment block at the head of *Effects: deform and round* in
  `geometry.ts`, rewritten for the new order.

### 1.5 Tests

- a round is linear in the bevel through the erosion: resolve at bevels `a`,
  `b` and their mean, same depth, and the mean's points are the mean of the
  others' until the arrangement changes;
- the same for the amplitude, with teeth on arcs;
- an arc gaining a tooth as its bevel grows gains it at its ends, out of nothing;
- the teeth count on an arc changing across a span comes up out of the curve:
  at `t = 0` the new teeth lie on it;
- a convex arc eroded past its radius comes out as the mitred corner;
- the bake reproduces `resolveAt` at every stretch end on a rounded, deformed,
  eroded room, including one whose teeth pinch off (the existing bake-vs-still
  tests, extended);
- save: a file with `clear` loads, and saves without it.

Regenerate the golden. Commit.

## Phase 2: a sealed group

### 2.1 Where the depth goes today

A sealed group's depth offsets the union of its members, slot by slot, with
the sign alternating with how deep the slot is nested (`slotted`,
`offsetUnion`); the slots are folded after, and the group's round is laid on
the fold (`roundedFold`). So a group already erodes a union. What moves is
the round, and the group's deform, which today is not the group's at all but
pushed onto every member's edges (`deforms`, which walks `enclosing`).

### 2.2 Fold, round, deform, erode

For a sealed group with a round or a deform of its own, `resolves` becomes:

1. the slots at depth nought, folded (`settled`) — the group's union as its
   members left it;
2. rounded at its corners, as a polygon's are in *1.1*;
3. deformed along its outline, as in *1.2*;
4. offset by the group's depth, as one shape.

Eroding the fold is eroding the slots with alternating signs and folding them
— eroding `level - solid` is the eroded level less the dilated solid — so a
group with neither a round nor a deform keeps `slotted` as it is, and one with
them gives the same outline where it has no corners.

The union's corners have no ids of their own: they are vertices of an
arrangement. Its arc points and teeth get ids from what the corner is made of
— the member corner it is, or the two member edges that cross there — so the
same corner at two keyframes has the same arc, and the bake can carry it. A
corner that is a crossing and stops being one is a topology event, and its arc
goes with it: the event is already there.

### 2.3 Where the pattern is anchored

A union edge is a run of member edges. Its teeth are laid from the middle of
the maximal straight run of the union's outline they are on, keyed by the
member edge at that middle, so:

- two members side by side along one wall get one pattern across the join;
- the anchor moves as the run's ends move, continuously;
- a run splitting or merging jumps the pattern, and that happens only where
  the arrangement already has an event.

### 2.4 The group's deform stops going to its members

`deforms` stops walking `enclosing` for sealed groups that have a round or a
deform: the group's deform is laid on its outline in *2.2* and nowhere else.
A loose group has no union and keeps pushing its deform onto its members, as
now.

### 2.5 The bake

The group's round rides the path it rides today — `shapes` in the bake's
scope, the facets and bevel mixed across the span — but before the scope's
depth instead of after the fold. The group's teeth ride it with the group's
amplitude added beside the bevel. The bake's group effects become
`{ facets, bevel, amplitude, deform }` per scope.

### 2.6 What goes

`roundedFold`, `squaredThrough`, `squareFrom`, `squareIn`, `Resolved`'s
`square` and the `squares` map in `reading.ts`; `effectedSquare` and `imaged`
if phase 1 left them; `restSquare`.

### 2.7 Tests

- a sealed group of one polygon rounds, deforms and erodes as the polygon
  would on its own;
- two rooms side by side along a wall: one pattern across the join, no teeth
  on the join inside;
- a group with a round and a depth: rooms still pull apart at a corridor where
  their own depths take them apart;
- the bake reproduces the still at every stretch end on a rounded, deformed,
  eroded group.

Regenerate the golden. Commit.

## Phase 3: a member's deform under a group's bevel

A member whose group rounds keeps its deform back: it resolves rounded and
eroded by its own depth, without teeth, and hands the group its deform with
the edges it applies to. The group lays it in *2.2* step 3, on the union edges
those member edges became, along the group's arcs at the corners they end at —
a member's own corner or a crossing with another member's edge, which at that
point is a corner like any other.

- **Which deform on a union edge**: the member's where it has one, else the
  group's. At an arc between two edges with different deforms, each side's
  teeth shrink to nothing at the arc's middle.
- **Where they come from**: a union edge lies on one member's eroded edge, and
  that is a source edge, found by which line it lies on — not by matching
  points. The member carries its eroded edges' lines and ids up with its
  shape.
- **What it costs**: the member's teeth are eroded by the group's depth only,
  not by the member's own. Where a member has no depth of its own it is
  nothing; where it has one, its teeth are sharper than its walls.
- Only under a group with a round of its own. Under one without, the member's
  deform stays in the member, as in phase 1.

Tests: a deformed member under a rounded group has teeth along the group's arc
at its own corner and at a crossing; one under an unrounded group is exactly
as it is alone. Commit.

## Open questions

- **Seams at the middle of an arc** between two differently deformed edges, or
  one deform carried round the corner, which gives up the middle anchor on one
  side.
- **Phase 3's trade-off**: teeth eroded by the group's depth only. The other
  choice is to leave members' deforms inside them and the group's round to
  leave their teeth square, which is phase 2 without phase 3.
