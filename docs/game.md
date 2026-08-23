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

### 4. The editor's 3D view

A panel in the editor holding a `renderer(element)`, fed from the live `Bake`
through the exporter, following `currentVersion` and the replay scrubber that
`replayed` already drives. The editor depends on the game package already, so
this is wiring rather than design.

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
