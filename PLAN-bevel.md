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

**Done.** How it differs from the plan below:

- **The round is drawn in the projection, not as corners.** Arcs that were
  corners of the polygon would take the drawn corner out of its ring, and the
  editor's handles, edges and `addVertex` all stand on it. So `Resolved`
  keeps its corners as they were — drawn corners and the straights' teeth —
  and `project` draws the outline from them (`outlineOf`: arcs laid along the
  drawn corners either side, teeth along the arcs) and erodes that. The bake
  already recomputes the projection at every instant from lerped amounts, so
  it kept its structure: `effectsOver` lerps the bevels and now the arcs'
  amplitudes.
- **An arc's teeth push the whole arc.** Each of its points is pushed off the
  curve by what the teeth either side say, in proportion, as a straight runs
  straight between its teeth. Laid only as points among the facets, a tooth
  sliding past a facet point swapped places with it in the ring, the outline
  jumped, and the bake cut every such instant down to its narrowest width.
  A test bake went from minutes to a second.
- **Open, may change: an arc tooth's shape and its curvature limit.** An
  arc tooth is a triangle standing on the curve: its tip, and a foot on the
  curve either side where its flanks come down, `falloff` of the spacing
  away, never less than `NARROWEST`; at one they run tooth to tooth. And an
  arc is never pushed further in than 0.9 of the radius it bends at. The
  curvature limit did nothing for the jump below; it is a guard and may go.
- **The jump in `scratch/world-2026-09-22T14-17-44Z.json`**, a room with
  inward teeth of 294 on held arcs of some 465, eroding, and jumping by up to
  130 where it had moved by 0.48 before phase 1. Three things, found in turn:
  1. *An arc's point beside a tooth's tip* (fixed). The arc's points were
     pushed with the teeth, so one sliding under a tooth stood a hair from
     its tip, and the edge between the two had its own direction: the
     erosion moves a tip along the mitre of the edges there, and that
     mitre flipped as the point came and went — or as `simplify` welded it
     to the tip at one instant and not the next — 586 one moment and 1,113
     the next at a depth of 112. Now an arc's points under a flank are left
     out, and the flank runs straight to a foot; one is left out as it
     reaches a foot, where it is the foot. Tested.
  2. *An island born* (not a fault). Eroding the teeth pinches off specks
     of material that grow out of nothing; the jump measure read them as a
     jump of their distance from everything else.
  3. *Walls starting to cross* (kept from happening). Held, the arcs grow as the room
     erodes, so the teeth move during an erosion span and start crossing
     each other and the walls. Where two start to cross there is a new
     notch, a corner of some 160°, and the erosion mitres it: its mitre,
     five times the depth, is there whole the instant the corner is. This is
     `erode`'s own, not the round's — two members of a sealed group starting
     to overlap while it erodes do the same — and before phase 1 the teeth
     did not move during an erosion span, so it did not arise here.
  4. *The teeth held still* (the fix for 3). A held arc's teeth are laid
     along the arc as it is seen, at the bevel asked for, and carried onto
     the drawn arc where they fall on its curve (`ArcTeeth.seen`). The seen
     bevel does not change while only the depth does, so the teeth keep
     their places along the curve as the erosion grows the drawn arc, and
     do not start crossing anything part way. Tested.
  After all of it, the room's worst step over two hundred of a span is 0.54
  to 1.53 at every falloff, against 0.48 before phase 1.
  `scratch/jump-walls-crossing.json` is the room at a falloff of 0.15, which
  jumped at 61% of v0 → v1.
- **Then: a falloff.** The push above made an arc read as a zigzag along
  the curve, and spikes on the curve read better. Now each tooth adds its
  height to the arc falling away with the distance along it — first as an
  exponential, `falloff` of the spacing to a factor of e, now as the triangle
  above — and the teeth and the arc's own points are samples of that one
  function. Near nought it is spikes on the
  curve; further, a wave. Continuous whatever it is set to.
- **And an offset.** Each edge's and arc's teeth start off its middle by a
  share of the spacing its seed gives it (`Effecting.offset`), so a short
  edge may have none. Not for a group's deform laid on its members: two
  members' teeth along a shared wall then fall anywhere and the arrangement
  flickers where they meet. Phase 2 lays that on the union instead.
- **A corner the bake invents is rounded apart** (`Effected.apart`). It sits
  where its neighbours put it at the end that does not have it — between two
  teeth, often — and a drawn corner there would turn the arcs beside it. Its
  arc is a sliver along the points either side, with no teeth.
- **The bake seeds a corner on the straight as it is drawn**: `straightOf`
  answers with the ends of the arcs before the erosion, not fractions of the
  drawn edge, since the outline no longer runs to the drawn corner. A drawn
  corner seeded between two teeth of a rounded polygon goes where they cross
  the drawn edge, or as near as they come, so the arcs beside it barely turn
  when it starts to exist: a pop of 0.4 left in one test, where the two
  teeth are on one side.
- **`held` is optional and on by default**, a tick in the round's section.
  `clear` is gone from the type and the inspector; a saved one is ignored,
  with no converter, since nothing reads it.
- **A group's round is as it was**, on its union after its erosion, still
  leaving its members' teeth and the corners beside them square. That is
  phase 2.

Stretches, the new code against the old on a 200 square room, spacing 20:
depth 0 → 20, 54 against 18; bevel 6 → 18, 18 against 9; amplitude 1 → 6, 4
against 4; bevel 10 → 40, 16 against 5.


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

A union edge is a run of member edges. The run takes one name — the
lowest-ranked member edge lying along it (2.9) — and its teeth are laid from
**that edge's own middle**, across the whole run, exactly as a polygon lays
them from its edge's middle. So:

- two members side by side along one wall get one pattern across the join;
- the anchor is a member's edge rather than the run's ends, so nothing at
  either end of the run moves a tooth;
- a run split in two leaves the piece that keeps the naming edge untouched,
  and only the other piece re-anchors, at an event the arrangement already
  has.

It was the run's own middle first, which slid every tooth on a wall whenever
anything at either end of it moved, and slid them all again when a member
crossing the wall cut the run in two. A polygon never does either, and the
whole point of phase 2 is that a group should not.

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
`{ facets, bevel, held, deform }` per scope, the deform carrying its spacing
and amplitude at each end: a group's spacing goes with its scale, as its
members' corners do, and taking the near end's for the whole span puts the
bake a whole tooth away from the editor at the far one.

### 2.6 What goes

`roundedFold` went with 2.2. What stays until phase 3, because it is what
keeps a group's round off its members' teeth: `squaredThrough`, `squareFrom`,
`squareIn`, `Resolved`'s `square` and the `squares` map in `reading.ts`,
`effectedSquare` and `imaged`, and `restSquare`.

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

### 2.8 Done, and what is left

Done: a sealed group with a round or a deform folds its slots at depth
nought, and `foldShaped` rounds (held), deforms and erodes the fold as one
shape. The group's deform is no longer pushed onto its members. The bake
carries the deform's spacing and amplitude across the span. The square
machinery stays, until phase 3, for members' own teeth under a group round.

It left the union's straights anonymous — one noise for every wall, and teeth
laid from a run's own middle, which moves whenever either of its ends does.
That is 2.9, which is now done too; 2.11 says where the two together leave it.

One thing from here stands either way: a member's teeth next to a straight
make that straight untoothed, the group not toothing its members' deformed
geometry again.

### 2.8b What the one-pipeline experiment found

Before going further, the other way round was measured: fold the members
*before* any erosion and run one pass — round, deform, erode — over that ring,
each corner carrying whichever effects it inherits, so that a group is a
polygon and there are not two pipelines to drift. `experiments/onepipe.test.ts`
resolves both ways and reports how far the outlines are apart.

| case | apart | points |
|---|---|---|
| group round, plain members | 0.00 | 37 vs 37 |
| group round + erode, no deform | 0.00 | 37 vs 37 |
| group round + deform | 5.73 | 77 vs 85 |
| the same, amplitude 12 | 10.27 | 77 vs 85 |
| member rounds, group deforms | 4.74 | 83 vs 71 |
| member erodes, group rounds | 5.65 | 69 vs 37 |

And the bake, the group eroding 0 → 20: with no teeth, one stretch either
way; with teeth, 41 stretches and 6 jumps today against 132 and 45.

- **Where only the group has effects the two already agree exactly**, erosion
  and all. The acid test needs no restructuring.
- **The deform gaps are the pattern's phase, not the pipeline**: they double
  with the amplitude and the point counts do not move. That is 2.9's naming,
  and no reordering touches it.
- **The one real difference is a member's own depth**, and one pipeline
  cannot express it: a polygon's depth is per corner and interpolates along
  its edges, a member's is per edge, so a corner where two members meet would
  carry two depths and slant the edge between them. It would need per-edge
  depths, which do not exist.

So the order stays as it is, and the work is 2.9.

### 2.9 Naming the union's straights and arcs

**What it is for.** A sealed group that is rounded, deformed and eroded should
resolve to what a polygon of the same outline resolves to: the same shape in
the editor and the same walls in the game, with the group's deform running
along its members' arcs as it runs along a polygon's. The morph may fade a
vertical in where it cannot carry a tooth across a span; the still may not
differ at all.

What 2.8 left was anonymity. A union straight had no name, so its teeth were
keyed nought — one noise for every wall — and were laid from the run's own
middle, which moved whenever anything at either end of the run did.

**By the line, not by the arrangement.** A union straight lies on the line of
exactly one member edge: the arrangement cuts edges up and drops the pieces
inside, but it never moves one off its line. So a member publishes its eroded
edges as lines, and the fold names each straight by the line along it.

The other way was to tag the union: `combineTagged` keeps every output point's
provenance and `unionAll` throws it away. Rejected, because a tag names a
*shape* point — a member's arcs and teeth, not its source edges — so it would
still have to be taken back to an edge, and it would have to survive `erode`
on the way up through a nested scope, which a line does for nothing.

**What was built.**

1. **`namesOf(resolved)` → `Named`.** Per source edge that reaches the
   projection, the line it lies on *after* the erosion, named by the corner it
   leaves; and per rounded corner with any length, its arc as points. Off
   `imagesOf` where a polygon has effects and off `mitred` where it has none.
   A tooth names nothing: it belongs to the edge its `root` names, and that
   edge's line runs from the arc at one end of it to the arc at the other,
   which the teeth stand off but do not move.
2. **`movedIn(named, depth)`.** A line goes along its own normal, which is
   exactly where the erosion puts it; an arc's points each on the mitre of the
   two segments at them — the two inside the run, and at its ends the line
   that leaves it, which is why lines and arcs are moved together. A line's
   ends are then taken from the moved arc's, so the two keep sharing points
   exactly: `movedIn` finds an arc's neighbouring segments *by* those points,
   so a nested scope moving an already-moved outline depends on it. `slotted`
   gathers what its members publish and moves it in by the slot's signed
   depth; `resolves` publishes a scope's own, moved in by its depth.
3. **A straight takes a name and an anchor.** `foldShaped` finds the first
   line along a straight — first being lowest-ranked, which is what settles a
   shared edge in the union — keys its teeth by that corner id, and lays them
   from that edge's own middle (2.3). `patternRun` gained `from`, where along
   the run the pattern is centred, and `subdivided` passes one per edge. An
   anchor off the run is walked from all the same: the way out that reaches
   the run lays what lands on it, and the other stops at once.
4. **An arc is a curve, not a string of corners.** `teethAlong` came out of
   `arcsWith` as a function over a `Curved` — `{ points, us, on, normal, bend }`
   — so teeth can stand on a curve that arrives as points. `curveThrough`
   reads such a curve back off a point run: `on` walks the polyline, `normal`
   is the segment's, `bend` the circle through three neighbours. A run of the
   fold that matches a published arc is then left unrounded and takes the
   group's teeth along the whole curve, cut back to the piece the fold kept —
   so a crossing eating part of an arc moves none of its teeth. The point a
   run ends at stands as itself: the straight leaving the curve starts there.
5. **Teeth stand in the fold before they turn.** A polygon's teeth are corners
   of its own, lying flat on a wall an amplitude of nought leaves straight.
   The fold had none, and a flat tooth is in line with its neighbours, so the
   arrangement dropped it. `FoldShaped.fades` reports each flat tooth with
   nought beside it; `Contributed.faded` keeps it in the ring and gives the
   bake a value to fade the line up from. Arcs take their teeth at nought
   amplitude too, for the same reason and one more: an arc's teeth take its
   own points off it, so an arc that gains them at the first instant of a span
   changes what it is made of, all at once.

**What the curve experiment found** (`experiments/curve.test.ts`). A corner is
rounded, its curve thrown away, and the same teeth laid on a curve read back
off the facet points. Same tips, same points, same folds in every case —
including three-facet arcs and amplitudes pushed hard enough inward to reach
the fold limit, where `bend` is only an estimate. The tips land 0.24 to 4.72
off the analytic ones, growing with coarseness, which is the polyline sitting
inside the curve it was laid as. In a fold that is not error: the polyline is
the outline, and the curve it came from is gone.

### 2.10 What went wrong on the way

Each of these was found by measuring a world, not by reading the code, and
each is worth keeping: they are the ways this construction fails.

1. **Faceted as drawn rather than as seen.** A held round drawn deeper by the
   erosion gained a facet — twelve to thirteen — and the line on it faded in
   across a whole span where nothing anyone could see had changed. Faceted by
   the seen bevel now.
2. **An arc gaining its teeth all at once.** With no teeth at nought
   amplitude, an arc kept all of its points; at the first instant after the
   keyframe the teeth took out every point under a flank — forty of ninety-five
   — and the outline moved 14.87. Laid at nought amplitude: 0.18, and the span
   went from eight stretches and two jumps to one and none.
3. **The seen ratio cut off at one.** `ArcTeeth.seen` lays an arc's teeth as
   it is seen so the erosion does not slide them, and it was held to at most
   one to stop a negative erosion cramming a whole pattern into nothing. That
   threw away the reflex case, where a held round is drawn *smaller* than it
   is seen, and those teeth crept along their shrinking arc: 8.68 in one span,
   46.19 in another. Capped at `CRAMMED` instead of one — `min` is continuous
   either way — giving 0.50 and 13.46.
4. **A held round eroded away.** A reflex corner with any round at all erodes
   to a fan of radius the depth; a square one mitres to a point. So when the
   erosion ate the last of a held round the whole fan went at once — 6,848 of
   area on an L drawn for the purpose. A held round now keeps `SEEDING` of
   itself, which is what a corner barely turning already keeps: 13.46 to 2.69.
5. **Teeth arriving all at once.** With the amplitude starting at nought a
   fold had nine points at the keyframe and twenty-six at the next instant.
   That is piece 5 above: 1 stretch and no jumps, against 8 and 2.

And two designs that were built and taken out again:

- **Seeding flat teeth at their pattern place.** A tooth with no room is one
  inside the clear by an arc, where the arc already is, so laying it flat
  there puts a point off the outline: the group's outline jumped 2.47 where it
  should move less than 0.5.
- **A line as solid as its tooth is tall.** It dims every short tooth for
  good — a tooth near the end of a wall stands at a fifth of the amplitude
  forever and is a corner all the same, so its line is drawn. In the world it
  was found in, teeth sat at 0.24, 0.10 and 0.03 permanently, and jumped to
  solid at the keyframe. What a fade must say is whether the corner is
  *there*, not how big it is.

Two of my own mistakes, for the record: the anchor work added loops that laid
some teeth twice, the ordinary walk already handling an anchor off the run;
and a `process.env` debug print left in `foldShaped` broke the editor at load.
`tsc`, the tests and the cycle check all run in node, so none of them sees
that.

### 2.11 Where phase 2 stands

`world-2026-09-22T21-40-17Z` — two overlapping rooms sealed, rounded 180 with
a noise deform, then eroded 61 four times — span by span, with the worst the
outline moves between neighbouring instants and how many lines come or go at a
seam with anything left to see:

| span | stretches | jumps | worst step | lines popping |
|---|---|---|---|---|
| 0, the deform arriving | 1 | 0 | 0.18 | 0 |
| 1 | 98 | 20 | 0.50 | 0 |
| 2 | 60 | 10 | 0.58 | 0 |
| 3 | 91 | 14 | 2.69 | 14 |
| 4 | 41 | 6 | 0.65 | 2 |

The other worlds kept for this — `jump-walls-crossing` and
`world-2026-09-22T14-17-44Z` — are unchanged at 0.61/0.55 and 1.53/1.18.

**Tests.** In `effects.test.ts`: what a plain room publishes and what a
rounded, deformed one does; names moved in by a depth landing where that depth
puts the outline; a run's teeth staying put while the far end moves; a run cut
in two keeping the teeth on the piece its naming edge is on; the deform
running along a member's arc, which gives teeth of the group's own size rather
than a stunted one per facet; a held round eroded past its bevel keeping a
hair of itself; and a held round faceted as it is seen. In `bake.test.ts`: a
group's deform starting from nought fading its verticals in; a group's tooth
standing solid however short it is; a union edge cut in two keeping its teeth.

**What is left.**

- **A reflex arc under an erosion deeper than its bevel**, which is where the
  fourteen and the two come from: see the `CRAMMED` table below. Everything
  before that depth is clean.
- **A run splitting or merging** re-anchors the piece that loses the naming
  edge, at an event the arrangement already has.
- **A scope's own arcs have no names**, its corners having no ids, so a group
  nested in another names its straights but not its curves.
- **Phase 3**, which the naming was most of.

**What it does not fix.** A straight splitting or merging still re-anchors the
pattern, and still does it where the arrangement already has an event (2.3).

**And what an erosion deeper than the bevel leaves.** A corner turning into
the material is drawn at less than its bevel and seen at more, and its teeth
are laid as it is seen (`ArcTeeth.seen`), so what the erosion takes back off
the drawn arc does not slide them. Past a point that stops working: the seen
arc's whole pattern has to be crammed into what is drawn, and teeth a fraction
of their own flanks apart make hairpins. `CRAMMED` is where that is held, and
it is a trade: hold it low and the teeth slide as the arc shrinks, hold it
high and they crowd. Measured on `world-2026-09-22T21-40-17Z`, whose erosion
of 244 is deeper than its bevel of 180, as the worst the outline moves between
neighbouring instants over five spans:

| `CRAMMED` | 1 | 2 | 4 | 8 | 16 |
|---|---|---|---|---|---|
| worst step | 8.68 | 3.27 | **2.69** | 10.27 | 34.41 |

So four; one is the behaviour before the reflex case was honoured. Going
further here is not another constant: it would be to lay a deeply eroded
reflex arc's teeth on the arc as it is *seen* — the fan the erosion makes —
rather than cramming them onto the sliver that is drawn, which is a deform
after the erosion for that one case and cuts against the order phase 2 is
built on.

**Where a straight has no name.** Not at a crossing: a crossing is a corner,
and every piece of the union's boundary is a piece of some member's edge. What
has no name is a piece of a line that is not a *source* edge — a flank of a
member's teeth, or a fold's own teeth from a nested scope, both of which are
left untoothed anyway. A member's arc facets are named by the arc they belong
to, which is what piece 4 is for.

**Which member names a shared run.** Two members' collinear edges along one
wall are one run, and the name is whichever edge lies under the run's middle —
so members sliding until the join passes the middle flip the name and jump the
pattern, with no event to hide it. So the run takes the lowest-ranked member
edge along it rather than the one under its middle: rank is already what
settles a shared edge in the union, and it changes only when the run does.

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
