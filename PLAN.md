# Plan: timelines of operations

Replacing layered versions with an ordered list of operations per object per
keyframe, so that edits feel natural: an upstream edit carries downstream
exactly as it was seen, an operation means what it says, and every one of them
can be dropped, moved between keyframes or repeated on its own.

## The model

### Principles

- **Gestures are rich, operations are plain.** A gesture may use anything
  transient — a selection's centre, a clicked point, snapping. What it writes is
  operations on each object that refer only to that object.
- **An object's state is its frame.** `F(x) = t + R(Θ) · S · x` over its rest
  geometry: a translation, an angle, and a scale along its own axes. Angles
  add and scale factors multiply (along the object's axes, so they commute).
  There is no pivot on the object.
- **Each turn and scale carries a painted point.** `ref`, in the object's rest
  frame. The gesture paints it where the object's middle is when the operation
  is written; from then on it is just a point of the object, going wherever the
  object takes it, and whether it is still the middle never comes into it.
- **Everything else is in world axes.** A turn's anchor is `F(ref) + about`; a
  scale's slide is `shift`. Neither turns when the object turns upstream. So:
  - an upstream move carries through a downstream turn unturned (move R +50 at
    v0 and it is +50 at v1 too)
  - an upstream spin in place leaves downstream turns and scales where they
    were
  - adding, deleting or nudging a corner upstream changes nothing downstream,
    since `ref` is stored
  - a group that loses most of its members at v1 references the one left from
    v1 on, because that is its middle when the later operations are written
  - reshaping an object after an operation was made behaves as if it had always
    had that shape: the operation still acts about the same point of it
- **Groups are global.** A group has no birth and no death: it is one fact over
  every keyframe, there wherever anything it holds is, and its timeline plays
  from the first keyframe. Deleting a group writes deaths onto what it holds.
- **Nothing is ever solved for or rewritten after an edit.** No re-centring,
  no `carried`, no combined anchors. Every anchor is a point a gesture used.
- **Orbiting as lasting intent is a group's job.** A group's turn applies to
  its members' results, so their upstream moves turn with it.

### Types

```ts
interface Keyframe {
  id: KeyframeId
  name: string
  visible: boolean
}

type Op =
  | { kind: 'move', by: Point }
  | { kind: 'turn', angle: number, ref: Point, about: Point }
  | { kind: 'scale', by: { x: number, y: number }, ref: Point, shift: Point, along: number }
  | { kind: 'erode', by: number }
  | { kind: 'stand', frame: Frame, erosion: number, corners: Map<VertexId, Point>, depths: Map<VertexId, number> }

interface Entry {
  op: Op
  times: number | null            // 1 = once, null = to the end
  skip: Set<KeyframeId>           // steps left out, not counted
}

interface Frame {
  t: Point
  angle: number
  scale: { x: number, y: number }
}

interface Rig {
  keys: Map<KeyframeId, Entry[]>
  nudges: Map<VertexId, Map<KeyframeId, Entry>>   // move ops, rest frame
  depths: Map<VertexId, Map<KeyframeId, Entry>>   // erode ops
}

interface World {
  keyframes: Keyframe[]           // order is the array
  rigs: Map<Id, Rig>
  // polygons, groups, artefacts, paths, start as now; birth/death by KeyframeId
}
```

- `turn.angle` is unwrapped: 720° is two turns.
- `scale.by` is along the object's own axes; `along` is the angle those axes
  had in the parent frame when it was written, read only by repeats.
- Anchors, moves and shifts are in the object's parent frame — the group
  holding it, or the world.

### Applying an operation

Each against `F`, the frame at the start of *that operation*:

```
move   F ↦ T(by) ∘ F
turn   a = F(ref) + about;  turn by `angle` about a
scale  p = F(ref);  stretch by `by` about p along the object's axes;  then T(shift)
erode  erosion += by
```

A turn about `F(ref) + about` is the same thing as a spin about `F(ref)`
followed by the fixed slide `about − R·about`, which is why an upstream spin
leaves it alone. A scale is stored in that second form outright: stored as an
anchor instead, its slide would be `(I − R·D·R⁻¹)(anchor − p)`, which depends on
the object's orientation, and an upstream spin in place would move the room
downstream. The stretch keeps the frame a translation, an angle and a scale
along the object's axes (`t ↦ p + R·D·R⁻¹·(t − p)`, `S ↦ D·S`), so there is
never a shear to refuse.

### Order

At keyframe k, the contributions are the steps of repeats begun at earlier
keyframes, oldest first, then k's own entries in list order. Each is applied in
turn; nothing is ever combined into anything else.

A gesture appends to k's list. It merges into the last entry only when that is
exact and trivial:

- two moves, or two erosions, with the same `times`: they add
- two turns with the same `ref` and `times`, where the second's `about` is the
  first's turned by the first's angle (which is where the painted point went,
  and what a repeated gesture about one centre writes): angles add, `about`
  stays the first's, and an entry whose angle comes back to 0 goes
- two scales with the same `ref`, `along` and `times`: factors multiply, and
  the slides compose

An operation that does nothing is not written, and a merge that comes back to
nothing goes. A drag recomputes from the list it started with, so a gesture is
one entry, not one per frame.

### Repeats

The n-th step (n unskipped steps after its entry) contributes its op again,
adjusted so that it acts about the same centre every time:

```
turn   aboutₙ = R(angle)ⁿ · about
scale  shiftₙ = Mⁿ · shift        M = the stretch `by` in the axes `along`
```

Each step has to ride every displacement of `ref` except the ones the repeat
itself causes, and that works out to these, from the entry's own numbers alone.
So a hand move in the middle of the span carries the centre along with the
room, and a spin in place leaves it alone.

Stacked erosion (`d, 2d, 3d…`) is `{ op: { kind: 'erode', by: d }, times: null }`.

### Gestures

`ref` is the middle of the object's resolved box at that keyframe, taken back
through the frame into the rest frame. `c` is the gesture's centre in the
parent frame. Nothing records that there was a selection.

- **Move**: `move by d`.
- **Turn**, a lone object or a selection alike: `turn θ, about = c − F(ref)`.
- **Scale** by `D` along the object's axes about `c`: `by = D`, `along = Θ`,
  `shift = (I − R·D·R⁻¹)(c − F(ref))` — exactly where scaling about `c` would
  have slid it, written down as a slide.
- **Erode**: `erode by d`.
- **Nudge, deepen**: into the corner maps, in the rest frame.

### Playback

A keyframe in flight plays all its contributions at once, each `t` of the way,
composed in list order — each acts on what the ones before it have done so
far: a move by `t · by`, a turn by
`t · angle` about its own anchor, a scale by `by^t` about its painted point
with its slide eased to match, an erosion by `t · by`. A turn is an arc about
its own anchor, so a turned selection swings about its centre, and a spin with a
drag in the same keyframe spins while it slides. Nothing is recovered: the
anchors are stored.

### Stands (unchaining)

A stand is the state the keyframe's own list is played over — the keyframe
before, plus the steps repeats take there — written at the head of that list,
so unchaining moves nothing. Nothing written before it reaches past it except
repeats still running, which keep stepping: they are what the object is doing,
and stopping them would change what is on screen. Corner nudges written at the
stand's own keyframe play over it. Unchaining a group unchains everything
under it; a member unchained alone still rides its group. Rechaining takes the
stand out. A pasted object begins with a stand at its birth, which is not an
unchaining.

## Stays / goes

**Stays:** rest geometry (rings, corners, `Vertex.ring`), groups and
membership, sealed/loose, birth and death, the resolved-shape pipeline
(projection, CSG, `contributed`, `resolve.ts`), the bake's stretches, tracks
and events, undo.

**Goes:** `Version`, `Edit`, `Footing`, `Transform`, `EMPTY_TRANSFORM`,
`carried`, `onlyMoved`, `base`/forks, the composed-frame walk in `resolveAt`,
the fixed-point recovery in the bake, old save formats.

## Phases

Done on branch `timelines`: 1, 2, 3 and 3½, and groups made global. Next: 4.

### 1 — types and evaluator (`rig.ts`, pure, not wired) — done

- The types above; applying an op; the order; `stateAt(world, id, k)` giving
  the frame, erosion, corner nudges and depths; cached per rig in a `WeakMap`.
- `worldFrame(world, id, k)` composing groups.
- Tests:
  - a v0 move carried unturned past a v1 turn about another point
  - a v0 spin in place leaving a v1 turn, and a v1 non-uniform selection
    scale, exactly where they were
  - corners added and deleted upstream leaving a downstream turn untouched
  - a group down to one member at v1: a v0 turn of the whole group, and the
    member's v2 spin in place still in place
  - a scale along the object's axes after a turn: no shear
  - turns about different anchors in one keyframe kept apart; same-anchor
    turns merging; an entry whose angle comes back to 0 going
  - a repeated turn orbiting one centre; a repeated scale spreading from one
    centre; a skip; a hand move mid-span
  - stacked erosion; dropping one entry; nested groups; birth partway

### 2 — the editor onto it (lands with 3) — done

- `scene.ts`: `resolveAt`, `depths`, `held`, `under`, `groupFrame`, `inward`
  read `stateAt`. `editAt` / `starting` / `withEdit` become reading and
  appending entries; a gesture recomputes from the list it started with.
  Delete `carried`.
- `canvas.ts`: `turned` and `squashed` rewritten to the gestures above.
- Ungroup folds the group into each member at every keyframe, unrolling
  repeats into single entries; refused where that is not a turn, scale and
  move of the member (a group's non-uniform scale over a member turned against
  it — until 3½, which made that a skew).
- Unchaining: stands, see *Stands*.
- Port `resolve.ts`, paste/stamp, `export.ts`, `view3d.ts`, `save.ts` (new
  format; older refused).
- Tests through a builder (`keyed(world, k, id, [turn(…), move(…)])`), keeping
  the behavioural assertions.

### 3 — bake and game — done

A slot holds the frame at the start of the span and a short list of ops in
flight with their anchors placed in the parent frame. `FRAME_STRIDE` gives
way to a frame plus a run of op records (kind, angle or factors, anchor or
painted point, move or shift); the stride and how the shader walks a run are
decided here, and it is the one place the list costs something per vertex.

- `linkAt` (`game/src/baked.ts`), `easing` / `pivot` / `moving` / `riding`
  (`bake.ts`), `morph.ts` and the shader, rewritten to *Playback*. The base
  and far-base affines and the fixed point go.
- Tests first: a room spinning in place keeps its size mid-span, a turned
  selection arcs about its centre, 720° plays as two turns, spin plus drag
  spins while sliding, a selection scale slides the room with it.

The slot is 8 floats (`t`, angle, scale, parent, first op, op count) and the
operations a table of their own, 8 floats each; the shader's loop is built to
the longest run in the span, as the chain walk is built to its depth. The
packed bake is layout 2.

### 3½ — skew in the frame — done

A group squashed across a member turned against it shears the member in the
world, and the shear exists nowhere but in the nesting: no frame can hold it.
So ungroup refuses, copying a member out of its group and the 19→20 converter
approximate with the nearest frame, and a turn inside a squashed group is not
a turn seen from outside. Forbidding the configurations instead would mean
policing every edit by its consequences downstream, and would forbid squashing
a group of turned rooms.

Done as written, with two additions. A scale carries `lean`, the skew its
axes had when written, beside `along`, so that a repeat's `M` is exact on a
skewed thing too. And a 20 file still opens, every skew nought; its bake is
left behind. The fold says anything not otherwise expressible as a turn, a
skew and a stretch about the one point, then a move (`across` in `scene.ts`).

- `Frame` gains a skew: `F(x) = t + R(Θ) · K(k) · S · x` with
  `K = [[1, k], [0, 1]]` — every affine that does not mirror. The stretch of a
  scale applies before the skew (`S ↦ D · S`), so scaling along the object's
  own axes stays well defined; turns and moves are unchanged.
- `framed` decomposes any non-mirroring affine exactly; `nearest` goes.
- The fold (`outward`, `inward1`) writes skew where a member turned inside a
  squashed group, or a squash over a turned member, needs it, and ungroup no
  longer refuses. Copy/paste carries frames exactly.
- An op `{ kind: 'skew', by: number, ref: Point, shift: Point }` for the fold
  to write, playing by `t · by` about its painted point; no gesture yet.
- The frame table slot grows from 8 floats to 12 (skew, and padding); the
  shader's `Pose` and `played`, `baked.ts`'s reader, `packed.ts` (layout 3),
  the save format (21) and the converter learn skew.
- Tests: ungrouping a squashed group of turned rooms leaves them where they
  were at every keyframe; a turn inside a squashed group and the same after
  ungrouping agree at both ends of the span; copying a sheared member out and
  pasting it lands where it was seen.

### 4 — moving operations and keyframe count (`keys.ts`)

- `drop` an entry or all of one kind at a keyframe; `push` (to the front of
  the next keyframe) and `pull` (the next keyframe's to the end of this one)
  move entries whole, with nothing recomputed; `split(fraction)`; set
  `times`; skip.
- A split turn is two halves about the same anchor: the second half's
  `about` is `R(θ/2) · about`, which puts it on the same point now and after
  any later edit. A split scale is the same with `M^½`.
- Remove `VERSIONS`. Insert a keyframe = split every entry at the next one;
  delete = push, moving births and deaths with it and clearing `skip`s that
  name it. A repeat's span counts steps, so an inserted keyframe inside it
  adds one.

### 5 — horizontal keyframe view

- Replaces `versionStrip`. Columns are keyframes; rows are objects in their
  group tree (selection-scoped, "all" toggle), expanding into one row per kind
  of op.
- A cell holding one entry is a diamond; several are a stack with a count,
  opened to pick one. A repeat trails a bar whose end sets `times`; clicking a
  step skips it. A repeating scale shows where it is heading, since `byⁿ`
  runs away quickly.
- Delete drops, ⌥delete pushes, dragging an entry to a neighbour pushes or
  pulls.
- Row header: hide, lock, solo — flags on the object, saved. Hidden stays in
  the CSG; hidden and locked are not picked.

### 6 — effect stack

- Chamfer, round; applied in `project` after erosion. Which effects an object
  has is one fact about it; their parameters are ops like erosion, so drop,
  push and repeat apply to them.

### 7 — later

Graph editor; motion path on the canvas; radial picker for overlaps; echo
(stagger) as an operator over several objects.

## Order and risk

- Phases 1–3 are one branch: editor, bake and game change format together.
- Phase 3 is the risk — the frame chain must stay exact at span ends, and a
  list of ops per slot is new to the shader. Its tests come first.
- Everything after is additive. Hide/lock is independent and can come first.
- Each phase stops at `pnpm typecheck` and `pnpm test`; the browser by hand.

## Known and accepted

- **Upstream moves are not turned by a downstream orbit.** Chosen: a v0 +50 is
  +50 at v1. Groups are for the other reading.
- **Push and pull reorder against repeats.** A pushed entry lands after the
  steps that repeats from earlier keyframes contribute at its new keyframe. It
  is exact when those steps are moves and erosions; where they turn or scale
  too, the order changes and the result with it, and the gesture should say
  so.
- **A fold's general map plays by its own path.** Where ungrouping turns a
  turn inside a squashed group, or a squash across a turned member, into a
  turn, a skew and a stretch of the member, the two ends are exact and the
  way between them is not the group's ellipse.
- **A copy's later operations are lifted by its holders' frame at the copy
  keyframe.** A turn inside a squashed holder is not a turn outside it, and
  without the member's frame to aim at it comes across as written.
- **A room drawn into a group after the group's rooms were deleted stays.**
  Deleting a group writes deaths onto what it holds at the time; the group has
  no death of its own to hand on.
- **Files before 20 do not open.** The converter (`pnpm convert`) takes
  formats 18 and 19 and writes 21.

## Open

1. **Repeat spans across inserted keyframes** — steps (proposed) or a fixed
   total spread over the span.
