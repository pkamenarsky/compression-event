# The game, against the new world

The game in `packages/game/src.old` was written in a couple of days for a game
jam, against an editor that no longer exists. That editor shipped a flat list of
polygons per version and the game switched between them; the new editor ships a
*bake*, and the game is expected to move continuously through it.

This is the plan for getting from one to the other. It is deliberately cut into
pieces that can be done on their own, in order, each with something testable at
the end of it.

## What changes

**The world the game is handed.** `packages/game/src/world.ts` is the contract
between the two halves. It keeps two things that answer two different
questions:

- `versions` — the set at each version as closed rings, in editor units, with
  edge and bisector normals precomputed. This is what collision and the
  out-of-bounds check run on. It is flat, id-free and dumb, exactly as before.
- `baked` — the morph, as buffers. One `BakedSpan` per pair of adjacent
  versions, holding what the vertex shader needs to reconstruct the outline at
  any instant inside it. Nothing in here is resolved at runtime; it is read and
  lerped.

**The outline is not the source.** The old game extruded walls straight off the
authored polygons. The new one extrudes them off the *CSG boundary* — every
`level` polygon unioned with every `solid` one taken back out — which is what
`worldset` computes and what the bake cuts into stretches. A wall segment is a
consecutive pair of points in a run.

**Collision is on the union, a version at a time.** `versions[k].polygons` is
the CSG at that version as closed rings, not the polygons it was made of — the
authored rings carry seams the set does not have, and a seam is a wall you can
see through and cannot walk through. Hulls are rebuilt per version rather than
per frame, so during a transition the wall you see is slightly ahead of the wall
that stops you. That lag is fine and was chosen; the seams were not.

## The baked format

Per span, all flat:

- **Frame table** — sixteen floats per polygon: the composed chain it already
  stood in as an affine (6), the version in flight as components (translation,
  rotation, two scales — 5), and that layer's fixed point (3, one of them a
  flag). The shader eases the layer from identity to itself and composes.
- **Entry table** — eight floats: a point of some polygon's eroded ring at both
  ends of the stretch (4), the frame slot it rides (1), and the entry the edge
  carries on to (1). Only the rings some crossing actually names are in here.
- **Output points** — one record per point of every run of every stretch: the
  point at both ends in its owner's frame, its slot, whether it is a corner or
  a crossing, and for a crossing the four entries the two edges come from.
- **Stretches** — `t0`, `t1` and the runs that belong to them, grouped into one
  track per polygon. Tracks are cut independently and their keyframes do not
  line up; that is the point.

A vertex of a run interpolates exactly, in its polygon's own frame. A crossing
does not interpolate at all — the four endpoints are evaluated and the 2x2 is
solved, which is about ten multiply-adds. This is `drawn` in `bake.ts`, moved
onto the GPU.

Everything outside its own stretch's `t` range is collapsed to a degenerate
triangle in the vertex shader, so the whole span is one static buffer and one
draw call, and moving through time is a uniform.

## The tasks

Each is meant to be picked up cold.

### 1. The baked format and the exporter — *done*

`packages/game/src/baked.ts` defines it and evaluates it on the CPU;
`packages/editor/src/export.ts` flattens a `Span` into it and resolves each
version's source polygons with their normals.

The CPU evaluator is not there for the game — it is the proof. `export.test.ts`
holds it against `sample` from `bake.ts`, which the bake's own tests already
hold against `truth`. If the chain holds, the shader has something exact to be
written against.

### 2. The renderer — *done*

`renderer(element)` in `packages/game/src/render.ts`, returning a handle with
`load`, `seek`, `between`, `camera`, `scene`, `resize`, `render` and `dispose`.
It owns a canvas, a scene, a camera and the dither pass, and nothing else — no
game state, no input, no sound — so the editor can put one in a panel and the
game can put one on the page and neither knows about the other.

`morph.ts` is the shader. Frame and entry tables go up as float textures read
with `texelFetch`; output points go up as attributes; `t` is a uniform, and
everything outside its own stretch's range collapses to a degenerate triangle,
so a span is one static buffer and one draw call. The fragment shader is the jam
build's `retroWallShader` with its normal taken from `dFdx`/`dFdy` of the world
position, since a morphing wall has no fixed normal to ship. `dither.ts` is the
jam build's pass, unchanged but for its names.

Checked against task 1's CPU evaluator rather than by eye: `scratch/preview.ts`
draws `outline` as a line at the foot of the wall the shader positioned, over a
level with rooms eroding and pillars turning inside walls, and the two coincide
at every instant including the crossings. Any disagreement would show as green
peeling off the wall.

### 3. Collision — *done*

`packages/game/src/coldet.ts`, off `PolygonPoint[]`, which carries the edge
normals and the scaled bisectors the jam build recomputed on every level load.
The trace itself is unchanged: same Minkowski expansion, same Quake 2 sweep,
same corner rule.

Two things around it did change.

**The rings are the union's.** Hulls built from the authored rings stop the
player at walls the set does not have. Two rooms overlapping is the ordinary way
to author a level here, and the seam between them was a wall the player could
see through and could not walk through — measured at the time as a stop at
x = 99.7 walking east across rooms at `(0,0,100,100)` and `(60,20,100,60)`. So
`versionOf` now ships the CSG at each version — every `level` unioned, every
`solid` taken back out, as closed rings — and a seam is not in it, because
dissolving one is what a union is. The same walk now runs to x = 120 unobstructed.

Rings rather than the runs the drawing uses, and that is the only reason this
is a separate evaluation rather than a read of the bake: a run belongs to one
polygon and can be kept up to date on its own, which is what the editor wants,
while a wall needs two neighbours to mitre against and the ring is where they
are.

**Which side is material comes from the winding.** Every ring ships as `level`,
whatever it was made of. A `solid` has been subtracted by then and is a hole,
and a hole is one because of the way it is wound. `withNormals` reads the
winding and `sideOf` acts on it, so a hole, a pillar and a room pinched in two
by its own erosion are one case rather than three.

**What it costs.** Collision snaps at version boundaries while the walls morph
between them, so during a transition the wall you see is slightly ahead of the
wall that stops you. The transition is short and the gap is a fraction of the
erosion step; the jam build had the same lag between its snaps. The alternative
— rebuilding hulls off the morphing boundary every frame — buys a few hundred
milliseconds of exactness per transition for a per-frame CSG, and was not worth
it.

`scratch/preview.html` draws this: orange is what the player walks into, green
is the outline being drawn, and watching them part and rejoin across a
transition is the whole of the trade.

### 4. The editor's 3D view — *done*

`packages/editor/src/view3d.ts` is a panel holding `renderer(element)`. It
orbits on a drag, zooms on a wheel, frames the level until someone takes hold of
the camera themselves, and is off until asked for, because it costs a WebGL
context.

It draws the CSG at the version on screen, live, and it does not need a bake to
do it. See *4b*.

### 4b. Live, and the jump — *done*

**The jump.** Switching version made the 3D walls lurch, and the 2D canvas did
not. The difference was never in either view: it was the order two fields were
written. A version row committed `currentVersion` on its own, and the clock that
fills in `replay` did not start until the next animation frame, so every view
saw this:

```
v3 —                ← committed by the click
v3 0->3 @0.02       ← one frame later
```

That first line puts anything deriving its instant from both fields at the
destination for a frame, before the walk drags it back to the start. The canvas
survived it because it draws two things — the set at `currentVersion`, which is
*supposed* to snap, and the replay as an overlay over the top — and a one-frame
snap of something that always snaps is invisible. In 3D the walls *are* the
replay.

`switched` now writes both in one update and the clock only advances what it
finds. The same probe reads `v3 0->3 @0.00` as the first line, which is v0's
geometry, which is where a walk from v0 starts.

**Live.** The 3D view used to show nothing until the level was baked, and an
edit invalidates the bake, so it showed nothing for most of the time anyone was
editing. Baking is for *movement*; standing still at one version needs none of
it. The view now draws `runs(live(set, resolveAt(world, currentVersion)))` —
the same incrementally-maintained boundary the 2D canvas draws — and reaches for
the bake only while a transition is playing. Where the span is baked the
transition is the one the player will see; where it is not, the switch snaps,
and the label says so rather than the view going blank.

**The two sources.** `walls.ts` holds what they share: the extrusion — four
vertices and two triangles per consecutive pair, plus the lines — and the
fragment shaders. `still.ts` positions from an attribute, `morph.ts` from the
frame and entry tables. The renderer picks between them:

```ts
show(runs: readonly Point[][]): void   // the boundary, as it stands
load(world: World): void               // the baked spans, held ready
walk(u: number | null): void           // through them, or null to hand back
```

The game calls `load` once and `walk` every frame. The editor calls `show` on
every edit, `load` when the bake changes, and `walk` for the length of a
transition.

**The seam is tested.** The two sources meet at the ends of a span, and anything
that differs there is a flicker in the one place a viewer is looking hardest.
`export.test.ts` holds `outline(bakedSpan(span), 0)` and `…, 1)` against
`truth` — the CSG run outright, which is the path the still source is handed —
over a room eroding, a pillar turning in a wall, and rooms joining. They agree
to single precision, which is the most that can be asked of a `Float32Array`.

**The rebuild is not worth avoiding.** Every edit rebuilds the wall buffers
whole, and the obvious next move is to use the diff `worldset` already hands
back — `apply` returns `Change`, naming the pieces an edit disturbed, which
`live` currently drops on the floor. Measured, it is not worth it. A grid of
overlapping rooms, one polygon nudged, which is the middle of a drag:

```
             boundary            ONE EDIT
  100 polys  177 runs   381 pts   live 0.37ms   runs + rebuild 0.05ms
 1000 polys  1728 runs  3546 pts  live 0.48ms   runs + rebuild 0.45ms
```

The whole rebuild is 0.45ms at a thousand polygons — *less* than the incremental
CSG update that has to happen anyway. Spending the diff would buy back under
half a millisecond and cost a slab allocator over the vertex buffers with a free
list, degenerate triangles or an index rewrite on free, partial uploads through
three's update ranges, and compaction when it fragments. Several hundred lines
and a new class of stale-slot bug, to save less than the work already being done
to know what changed.

The reason it stays cheap is that **the boundary does not grow with the level**.
A thousand overlapping rooms have 3546 boundary points, because the union
collapses every interior wall; it grows with the level's perimeter. The rebuild
would have to get some fifty times bigger before it cost a frame, and at that
point the diff is sitting there waiting.

### 4c. lineOpacity — *built, and it may not be the whole of what you saw*

**What was wrong.** A vertical line is drawn at every point of every outline
run, whether or not there is a corner there. `spanning` is one way to get a
point that is not a corner: both ends of a span must be written over the same
corners or the rings cannot interpolate, so a corner that dies at the far end is
carried the whole way and placed *exactly on the edge between its
ring-neighbours* at the end that lacks it. The shape is unchanged, which is the
point — but it is not a corner there.

**How it is worked out.** Not by asking which points look straight. That reads
the symptom, costs a test per point per frame, and cannot tell a corner that is
*arriving* — genuinely there, momentarily flat — from one that was never there.
The fact wanted is existence, and `spanning` knows it: it computes
`here.has(c.id)` and `there.has(c.id)` and used to throw both away. It now
carries them as `Moving.dead`.

Getting that from a *source* corner to an *output* point crosses erosion and the
CSG, and erosion keeps no provenance — the surviving boundary comes from the
band it subtracts, not from the ring. So `fading` projects twice instead. A dead
corner is exactly collinear in the source ring, so taking it out changes the
projection's *geometry* not at all, only its vertex count:

```
project(source with the dead corners, depth)   → the ring the span uses
project(source without them, depth)            → the same curve, fewer vertices
```

The unmatched vertices are the artifacts, zipped to the removed corners in ring
order. Where the two disagree about ring count or how many are missing, nothing
is claimed and everything draws — which is what happened before.

**What it costs.** Nothing at all unless a polygon's corner set actually changes
across the span, and that is most spans. Measured on six boxes eroding and
turning: 94ms where no corners change, against 94ms before the change; 200ms
where every polygon loses one, which is the worst it can be and is offline
behind a progress bar.

**Then it is plumbing.** `Stretch.opacity` per run point at each end,
`BakedSpan.opacityA` / `opacityB`, `extrude` marking which line vertices are the
vertical rather than the horizontals, and the morph vertex shader lerping the
two into `vOpacity` for the line fragment shader to fade. The still path has no
such vertices and is 1 throughout.

**It was not the whole of it.** The case above is real and tested, and it is
not what was on screen. `world-2026-08-23T20-11-29Z.json` reproduces the
phantom lines and they come from somewhere else entirely — from `erode`:

```
box eroded, convex corners only    4 pts    0 collinear
L eroded, one reflex corner        8 pts    2 collinear
box dilated (negative depth)      12 pts    8 collinear
```

`band` is one quad per edge and one mitred wedge per corner, and where a quad
meets its wedge the boundary carries straight on — so the arrangement leaves a
vertex that is not a corner. Convex corners under erosion skip the wedge
(`turn * depth >= 0`) and come out clean, which is why a plain shrinking box
never showed it. Reflex corners and *any* corner under a negative depth do not.
That world has a dilation of -0.66 on one polygon and an erosion of 59 on
another, and its outline is 8 of 19 points at v0 and 14 of 26 at v1.

### 4d. Where the collinear vertices are dropped — *done*

They are dropped in `chain`, where rings are built, so that a ring never claims
to turn where it does not. `cornersOnly` takes out any vertex whose two edges
are collinear to within the arrangement's own tolerance. Every boolean goes
through it, so `erode`'s band junk is gone from the projections, from the CSG
that reads them, from the outline the editor draws and from the buffers the game
gets. On the world that showed the problem:

```
              before                     after
  still v0    21 pts,  7 of 17 flat      13 pts, 0 of 9 flat
  still v1    28 pts, 12 of 24 flat      14 pts, 0 of 10 flat
  projections 19 pts,  8 flat            11 pts, 0 flat
```

**The exception, and why there has to be one.** A corner `spanning` invented so
that both ends of a span carry the same ring sits exactly on the edge between
its neighbours at the end that does not have it — so `cornersOnly` would take it
out there and nowhere else, and the ring would change length part way through
the span. That is the one event the invention exists to prevent, and letting it
happen costs sixteen stretches per birth and a pop the size of the edit. It was
tried; it is written up above.

So the bake asks for those vertices back, by position, through `keeping`.
`Resolved.keep` carries them and nothing but the bake ever sets it. Two things
make it cheap. A flat corner's edges are parallel, so where it lands on the
eroded boundary is its own position moved along the edge normal by the depth —
no mitre to solve. And it is only flat at *one* instant: everywhere inside the
span it is part way out of the wall and turns like any other corner, so the
projection keeps it without being asked. `invented` is empty at every instant
but two.

**What it costs the cut.** Nothing where the world is straightforward — the
three quiet spans of that world stay at one stretch each. On its busy span, the
one that erodes by 59 units, one track goes from 47 stretches to 59 and the
other from 29 to 28, at the same wall time and the same measured error. Vertices
now appear and disappear where the geometry passes through a straight
configuration, and those are real events; a superset is the direction to err in.

**And `lineOpacity` still earns its place**, at the two instants that matter: the
invented corner is a genuine corner everywhere inside the span and draws its
line, and at the boundary where it lies flat it draws nothing. The still path
does not have the vertex at all there, so the two agree across a transition
rather than flickering.

### 5. The game loop

`main.ts`, `controls.ts`, `ui.ts` and `sound.ts` come across close to unchanged
— they were never coupled to the world format. What changes is that the version
countdown drives a continuous `t` into the renderer instead of a `loadVersion`
call, and that the countdown's mapping to `t` is where easing lives. See
*Easing is a runtime concern* in `versioning.md`.

## Looking at it

`three` is a dependency of `packages/game` now, and of nothing else.

`scratch/preview.html` bakes a world, ships it, and draws it, with the CPU's
outline overlaid on the GPU's walls in green and the collision rings in orange.
It is a bench rather than a page the build knows about — `scratch/` is not an
entry point — and it is how tasks 1 to 3 were checked.

`scratch/editor.html` is the editor opened on a world instead of on nothing,
which the editor itself has no way to be told from a URL. Same mount as
`packages/editor/src/main.ts` and the same `?world=` argument as above.

```
/scratch/preview.html?world=demo          rooms, pillars turning inside walls
/scratch/preview.html?world=<file>.json   a world saved out of the editor

space  pause    o  the CPU outline    c  the collision rings    arrows  step
```

## What is missing, and is nobody's fault yet

**Artefacts.** The new editor has an artefact tool in its toolbar and no
artefacts in its `World`. The game's format keeps the field and the renderer
keeps the meshes, so an authored artefact will light up the moment the editor
can write one; until then every level has none, and the player starts at the
origin rather than at a `start` artefact.

**Paths.** Same story, and nothing in the jam build read them anyway.

**Floor polygons.** `worldset` drops anything that is not `level` or `solid`, so
the bake never sees a `floor` polygon and the morph cannot carry one. They do
resolve into `versions`, so they can be drawn statically per version; morphing
them needs the bake to cut a track for a polygon that takes no part in the CSG,
which is a small job and not this one.
