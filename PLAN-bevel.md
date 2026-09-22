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

- **The bevel is drawn, not seen.** An eroded convex arc tightens and goes
  sharp once the depth passes its radius; a concave one opens out. Today the
  bevel is the same wherever it is. See *Open questions* for holding it.
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

What keeps this true is that **a tooth on an arc keeps its `u`**. A tooth laid
by length along the path would slide round the arc as the bevel changes, and
the slide is not linear in anything. So on a straight a tooth is where the
spacing puts it, measured from the middle as now; on an arc the teeth are at
fixed fractions of the arc, and a change in their count across a span comes up
out of the curve the way a change in facets does (`Facets.from/to/at`,
`facetFades`).

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
- **On an arc**, a new `arcRun`: the tooth count from the arc's length at the
  keyframe over the spacing, the teeth at even fractions of `u` between its
  ends, each pushed along the curve's normal at `u` — from `Curve`'s tangent,
  not from the facet it lands on, so the teeth follow the curve and not its
  facets. Each shrinks to nothing at the arc's ends as a straight's do at
  theirs, and its pattern is keyed by the corner's id, so noise belongs to the
  corner.
- **Its amplitude** is the corner's two edges' amplitudes, blended across
  the arc, so a corner between an edge deformed on its own and one that is not
  goes smoothly from one to the other.
- **Its ids**: `toothId(owner, corner, j)` for the straight's teeth as now; an
  arc's are `arcToothId(owner, corner, j)` under a different tag, so a tooth
  that moves from a straight onto an arc is a different corner and the bake
  sees one go and another come, each out of nothing.

A tooth on an arc lies between two arc points, so its own normal is not the
facet's: at few facets the teeth stand off the facets a little. That is the
curve they are meant to follow, and at the facet counts in use it is not
visible. If it is, lay them on the facets instead — see *Open questions*.

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
- a tooth on an arc keeps its `u` across a span whose bevel changes;
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

- **Hold the bevel as seen?** A bevel of `bevel + depth` at a convex corner
  and `bevel - depth` at a concave one, clamped at nought, keeps the rounding
  the same size at any depth, and stays linear. It changes what the bevel
  number means, and the author may want the arcs to tighten as walls grow.
- **Teeth on the curve or on the facets?** On the curve (as planned) follows
  the round; on the facets is simpler and exact to the drawn outline, and at a
  coarse round shows the facets through the pattern.
- **Seams at the middle of an arc** between two differently deformed edges, or
  one deform carried round the corner, which gives up the middle anchor on one
  side.
- **Phase 3's trade-off**: teeth eroded by the group's depth only. The other
  choice is to leave members' deforms inside them and the group's round to
  leave their teeth square, which is phase 2 without phase 3.
