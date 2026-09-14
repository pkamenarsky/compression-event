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
  skip?: Set<KeyframeId>          // keyframes it waits over, not counted
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

The n-th step (n unskipped keyframes after its entry) contributes its op again,
adjusted so that it acts about the same centre every time:

```
turn   aboutₙ = R(angle)ⁿ · about
scale  shiftₙ = Mⁿ · shift        M = the stretch `by` in the axes `along`
skew   shiftₙ = Xⁿ · shift        X = the shear `by` along `along`
```

Each step has to ride every displacement of `ref` except the ones the repeat
itself causes, and that works out to these, from the entry's own numbers alone.
So a hand move in the middle of the span carries the centre along with the
room, and a spin in place leaves it alone.

Stacked erosion (`d, 2d, 3d…`) is `{ op: { kind: 'erode', by: d }, times: null }`.

A step of a step is a step: the n-th step of the m-th step is the (m + n)-th.
So a repeat can be cut anywhere into two exactly, the second an entry of its
own whose op is the step it starts on — which is how a copy carries a repeat
already running, and how a fold keeps one begun before the thing was born.

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

Done, and merged: 1, 2, 3, 3½, 4 and 5, and groups made global. Next: 6.

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
    centre; a hand move mid-span
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

Done as written, with these on top:

- A scale carries `lean`, the skew its axes had when written, beside `along`,
  and a skew carries `along`, so that repeats of either are exact on a skewed
  thing.
- A 20 file still opens, every skew nought; its bake is left behind.
- Ungroup, copying out of a group and pasting into one are one fold (`carried`
  in `scene.ts`). What it cannot say as one operation it says as a turn, a
  skew and a stretch about one point, then a move (`across`). It keeps a
  repeat wherever each step carries to the carried entry's own step, and
  unrolls and reports the rest.

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

### 4 — moving operations and keyframe count (`keys.ts`) — done

- `drop` an entry or all of one kind at a keyframe; `push` (to the front of
  the next keyframe) and `pull` (the next keyframe's to the end of this one)
  move entries whole, with nothing recomputed; `split(fraction)`; set
  `times`.
- A split turn is two halves about the same anchor: the second half's
  `about` is `R(θ/2) · about`, which puts it on the same point now and after
  any later edit. A split scale is the same with `M^½`.
- Remove `VERSIONS`. Insert a keyframe = split every entry at the next one;
  delete = push, moving births and deaths with it. A repeat's span counts steps, so an inserted keyframe inside it
  adds one.

Done, differently in two places: there is no `split`, and an inserted
keyframe is a no-op rather than half of the next.

- `drop`, `push`, `pull` and `timed`, as above. A stand does not push, pull
  or repeat; a push lands behind a stand at the head of the next list, and
  nothing is pulled to before the thing's birth.
- **Skips are back.** An entry may name keyframes after its own where it
  takes no step; they are not counted. Insert writes the new keyframe into
  the skips of every repeat still running across it, corner entries
  included, so it is the keyframe before over again and nothing after it
  moves. What happens there is brought in by pushing, pulling or gestures.
- A skip names its keyframe, not an offset: a paste keeps it where the
  pasted entry still reaches it and drops it elsewhere. The fold keeps it on
  the repeats it keeps. Push drops a skip of the keyframe the entry now
  starts at; merging needs equal skips.
- Delete hands the entries to the front of the next list. A repeat that
  stepped at the deleted keyframe (or, written there, at the next) takes a
  step fewer, so it ends where it ended; the deleted keyframe leaves every
  skip. A life left empty goes, corners included. Deleting the last keyframe
  drops its writing, lets what died there live and drops what was born
  there. Refused for the only keyframe, and where a corner would end with
  two differing entries at one keyframe.
- Keyframes named `v<n>` are renamed to their place. The strip sizes to the
  count and has insert (after the one on screen) and delete buttons; undo past
  either lands on the keyframe in its place. Skips save as an optional list,
  so the format stays 21.

### 5 — horizontal keyframe view — done

- Replaces `versionStrip`. Columns are keyframes; rows are objects in their
  group tree (what is picked), expanding into one row per kind
  of op.
- A cell holding one entry is a diamond; several are a stack with a count,
  opened to pick one. A repeat trails a bar whose end sets `times`, with a
  gap at each keyframe it skips; clicking a gap or a step toggles it. A repeating scale shows where it is heading, since `byⁿ`
  runs away quickly.
- Delete drops, ⌥delete pushes, dragging an entry to a neighbour pushes or
  pulls.
- Row header: hide, lock, solo — flags on the object, saved. Hidden stays in
  the CSG; hidden and locked are not picked.

Done (`timeline.ts`, over the rows `track.ts` works out), with these on top:

- Across the whole bottom, the status line sitting on it; the bake and 3D
  buttons, and the 3D panel, move to the top right. The keyframe headers keep
  the ghost eyes, the unchain mark and insert/delete, and the arrows that
  walk the keyframes are ← and → now. The headings stick to the top and the
  labels to the left while the rest scrolls both ways.
- No kind rows, stacks or disclosure: a thing is one row, its members under
  it, with an icon per entry side by side in play order. A column fits five
  and widens for more. Each repeat hangs under its row in a lane of its own,
  a line down from its icon and along to where it stops; the rightmost
  icon's lane is the nearest, so no line crosses another.
- A double click on an icon edits that entry by the gesture its kind is
  written by (`editing` in `canvas.ts`): the same readings of the hand and
  the same operation, about the entry's own centre and against the thing as
  the entry leaves it (`editedAt`), folded into it exactly (`refolded`, by
  `merged`). It stays one entry and keeps repeating; what comes after it
  still acts where it did. Started from the keyframes, it reads the hand
  once the cursor is over the canvas; a click keeps it, Escape or a press
  elsewhere puts it back. One thing at a time: an entry a selection wrote is
  edited for that thing alone.
- Stands are not shown. Taking one out moves the thing to wherever upstream
  says, which is Cmd+Shift+U's question rather than an entry's.
- The picked entry has an arrow in the slot after its icon, drawn unlike
  any entry: dragged to a keyframe, the entry repeats to there — to its own
  is once, to the last is to the end. A lane's end drags the same way.
  `skipToggled` in
  `keys.ts` turns a step into a wait and back, keeping where the repeat
  stops: `times` goes down or up by one with it.
- The flags are `World.flags`, a map by id, saved as an optional list, so the
  format stays 21. A group's hidden or locked is its members'; a solo keeps
  what holds and what is held by the soloed thing. Locked is out of reach the
  way a thing outside the open group is, so it draws dimmed.
- A right click on the canvas lists everything under it, in its groups,
  locked and hidden included (`beneath` in `track.ts`, `picker.ts`): each
  with its switches, and picked by its name where it can be. That is how a
  locked thing is got back without finding its row.
- A polygon's corners have rows under its own, holding their nudges and
  depths (`cornerCellsOf`).

### 6 — effect stack

Round and deform, after erosion: `erode → round → deform`, in that order
always. Chamfer is a round of one segment, so its cut follows the radius
(`r·tan(θ/2)` along each edge) rather than being a length of its own.

#### Effects are facts, amounts are ops

An effect is not a pass. Nothing is ever rounded twice or deformed twice:
which effects a thing has, and how, is one fact about it, over every
keyframe, as its shape is; how much is an op, like erosion.

```ts
interface Effects {
  round?: { segments: number, verticals: boolean }
  deform?: { count: number, pattern: 'zigzag' | 'sine' | 'noise', seed: number, sides: 'in' | 'out' | 'both' }
}

// World
effects: Map<Id, Effects>                        // a polygon or a group
cornerEffects: Map<VertexId, Partial<Effects>>   // a corner's own, over its thing's

type Op =
  | …
  | { kind: 'round', by: number }    // radius
  | { kind: 'deform', by: number }   // amplitude

interface Rig {
  …
  rounds: Map<VertexId, Map<KeyframeId, Entry<Round>>>    // per corner
  deforms: Map<VertexId, Map<KeyframeId, Entry<Deform>>>  // per edge, by the corner it starts at
}
```

- `State` gains `radius` and `amplitude`, summed like `erosion`, and per
  corner and per edge maps summed like `depths`: a corner's radius is its
  thing's plus its own. A stand records them.
- Two of either at one keyframe add, and adjacent ones merge as erosions do.
  They commute with the frame ops, so their place in a list does not matter.
  That is the whole answer to applying an effect twice.
- Drop, push, pull, repeat, copy and paste need nothing new. A repeat grows
  the amount: `r, 2r, 3r…`.
- A count, a pattern or a seed does not change over time. What would want one
  that does is a second effect, not an option changing under the timeline.
- A group's effects apply to its union, which is how the joins between rooms
  are rounded. A union has no corner ids, so a group has no per-corner
  amounts.

#### Geometry

- `rounded`: each corner of the eroded shape becomes `segments + 1` points on
  the arc tangent to its two edges, the tangent length clamped to half of
  each edge less what the neighbour takes. Holes too.
- An arc's points stand verticals by default, so a round is faceted;
  `round.verticals` off leaves only the tangent points standing them, and
  the round reads smooth. An option of the round like any other, in the
  pane.
- `deformed`: each edge gets `count` points between its ends, pushed along
  its normal by `amplitude · pattern(s)`. The pattern is nought at both ends,
  so a deform never moves a corner or a tangent point.
- Deform belongs to source edges, and a flat source corner splits a straight
  run into two of them — but `cornersOnly` has taken it out of the eroded
  shape. Flat corners' images are put back into the eroded edge before
  deforming; an eroded edge is matched to its source edge by lying on that
  edge's offset line.
- **`imaged`**: where one named feature — corner `i`, or edge `j` — lands
  after erode, round and deform: a run of points, not one. The projection is
  built by the same construction, and `invented` and `fading` ask it instead
  of `mitred`, so the two cannot disagree. It is also how an eroded vertex
  finds the source corner whose radius it takes.
- In the thing's own frame an eroded corner is `corner + d·mitre`, a tangent
  point that plus a multiple of `r` along a fixed edge direction, an arc
  point `centre(r) + r·dirₖ`, a deform point linear in the amplitude. So
  the bake's lerp between stretch ends is exact wherever only the amounts
  move, and `projection` divides radius and amplitude by `s` under a
  similarity, as it does depths.

#### The bake, and the flat-corner machinery

`spanning` writes both ends of a span over one list of corners, and marks a
corner `dead` at an end where it is missing or flat. `invented` puts a dead
corner's image back at `t = 0, 1` (`keep`), since the arrangement drops a
flat point and the ring would change length; `fading` finds the image at
every instant to fade the corner's vertical. Both take the image from
`mitred`, erosion's own construction.

With effects that stops being true:

1. A rounded corner's image is `segments + 1` points. Mid-span the mitred
   point is not a vertex, `fading` finds nothing, and an arriving corner's
   verticals pop in whole.
2. At the flat end the run collapses: the tangent length `r·tan(θ/2)` is
   nought at `θ = 0`, all the points land on one, and `keeping` cannot insert
   coincident points. The ring changes length at the span's end.
3. A deform at amplitude nought is flat, and `cornersOnly` drops it.

So:

- **`dead` is per slot, not per corner**: a corner's arc points, an edge's
  deform points. A slot is dead at an end where it is flat there — its corner
  missing or flat, or its deform at nought. `invented` and `fading` walk
  slots, and ask `imaged` where they are.
- **A degenerate end is seeded, never collapsed.** Where a feature's points
  would coincide at one end, they are laid along the flat line at `SEED` of
  their spacing at the other end, as `budding` does a birth. Points on a line
  are that line exactly, they are distinct, so `keeping` takes them, and the
  fade starts from them. A radius of nought at one end and more at the other
  is seeded too: the tiny arc does turn, and the arrangement keeps it unasked.
- A span whose amounts go from something to nought is the same read backwards.
- The counts never change, so a ring's length across a span never depends on
  the options.
- Just after a flat end an arc's points are nearer than the snap, so the
  arrangement welds them and the cut finds an event there by measuring. An
  invented corner is nearer its line than the snap at the same instants, so
  this is not new.
- `moves()` and `export.ts` leave the new kinds out: they are not in the
  frame table. The game does not change — it gets points, and lerps them.
- It costs: a round multiplies a corner by `segments + 1`, a deform an edge
  by `count + 1`, and the bake and the buffers grow with them.

#### Editing

- **The gesture** reads two numbers off one drag, as `ngoning` does: sideways
  is the amount, and it writes an entry; upward is the count, and it sets the
  thing's option, at every keyframe, with a label by the cursor. With corners
  picked it writes their entries instead, as deepening does. The first
  gesture on a thing without the effect gives it the remembered options.
- **The options pane** sits on the left, under the tool buttons, and blends
  in while a thing with effects is picked, or an effect entry is picked in
  the timeline — which is why the timeline's pick moves out of `timeline.ts`'s
  local state. It edits the thing's `Effects`, or a picked corner's own,
  whichever entry led there, and removes an effect, which drops its entries.
  Patterns first: zigzag, sine, seeded noise.
- Icons for both kinds in the thing's row and in the corner rows (`track.ts`),
  and double-click editing through `editing`.
- Picking edges is not a thing yet, so per-edge deform waits for it; per-corner
  round rides the corner selection there is.
- `resolve.ts` carries a group's effects and amounts onto the rings it makes,
  as it does the group's depth.
- Save format 22; 21 still opens.

#### Order

1. `rig.ts`: the op kinds, `rounds` and `deforms`, `State`, merge, repeat,
   stands. Tests.
2. `geometry.ts`: `rounded`, `deformed`, `imaged`, seeding. Tests: counts and
   order stable, linear in the amounts, clamping, a clockwise ring, and the
   projection agreeing with `imaged` at every feature.
3. `scene.ts`: `project` runs the three, `Effects` on the world, groups.
4. `bake.ts`: slots in `spanning`, `invented`, `fading`; seeding. Tests: a
   radius growing from nought, a corner arriving into a rounded ring, a
   deform starting from nought fading its verticals in, a turning room at a
   fixed radius costing no stretches.
5. The gestures, the options pane, the icons.
6. The save format.

Done: 1–4, on the branch `effect-stack`, with these on top:

- A stand carries `radius`, `amplitude`, `radii` and `amplitudes` outright,
  and the corner maps are listed once (`CORNER_MAPS` in `rig.ts`), so keys,
  undo's gesture stamp, delete and rebirth take all four alike. A copy
  carries the effects, the corners' own options and their entries.
- A one-way deform lifts the pattern off the line, `(1 + v) / 2`, rather than
  folding it onto it: folded, a zigzag out is a flat step.
- `imaged` is the construction and `project` simplifies what it builds;
  `imagesOf` in `scene.ts` is the same taken in world units, which `invented`
  and `fading` ask. A group's union is rounded and deformed alike everywhere
  (`effected`), its edges' noise keyed by their place.
- A group's amounts, and a polygon's own for what the erosion made, have no
  slots, so an end at nought is seeded for them too, deform included.
- A corner arriving into a rounded ring costs stretches: an arc whose corner
  turns is not a lerp of its ends. It never jumps.
- Not yet: a flat corner with both a round and a deform on its two edges is
  not flat in the projection, so its seeded arc finds no edge to land on and
  the ring is shorter at that end.
- Icons and labels for the two kinds are in, since the timeline's table of
  them has to be whole; the rest of 5 is not. Nothing saves effects yet (6):
  a file opens with none.

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
- **A copy goes on doing what was seen.** Copying something out of a group
  folds its holders into it, as ungrouping would, so their later motion comes
  with it. Pasting into a group is the fold the other way: at each keyframe
  the copy does what was copied, and then what the group does.
- **A fold keeps a repeat only where it is one on the other side.** Where the
  frame it is carried through changes shape over the span, where it is a turn
  across a squash, or behind one taken apart, it becomes one entry per
  keyframe, stopping at the last keyframe there is. Ungroup, resolve and
  paste say so on the status line.
- **A room drawn into a group after the group's rooms were deleted stays.**
  Deleting a group writes deaths onto what it holds at the time; the group has
  no death of its own to hand on.
- **Deleting a keyframe inside a repeat takes a step out of it.** It ends at
  the keyframe it ended at, one step short.
- **Files before 20 do not open.** The converter (`pnpm convert`) takes
  formats 18 and 19 and writes 21.

## Open

Nothing. (Repeat spans across inserted keyframes: skipped, so an insert is a no-op.)
