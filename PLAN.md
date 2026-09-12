# Plan: keys with anchors

Replacing layered versions with one key per object per keyframe, so that edits
feel natural: an upstream edit carries downstream exactly as it was seen, a key
means what it says, and every component of it can be dropped or repeated on its
own.

## The model

### Principles

- **Gestures are rich, keys are plain.** A gesture may use anything transient —
  a selection's centre, a clicked point, snapping. What it writes is a key on
  each object that refers only to that object: its pivot, its corners.
- **Every object has a stored pivot.** Polygons and groups alike: the middle of
  its box when it is made, in its own rest frame, and never derived from the
  geometry again. Adding, deleting or nudging a corner does not move it.
- **Anchors ride displacement, not rotation.** A turn or scale key stores its
  centre as an offset from the pivot as it stood at the start of the key, in
  world axes. So an upstream move carries through a downstream turn unturned
  (move R +50 at v0 and it is +50 at v1 too), and an upstream spin in place
  leaves downstream anchors where they were.
- **State is pivot position, angle, scale.** An object's frame at a keyframe is
  `x ↦ P + R(Θ) · S · (x − pivot)`: angles add, scale factors multiply (always
  along the object's own axes, so they commute), and the pivot position is
  folded key by key.
- **Orbiting as lasting intent is a group's job.** A group's turn applies to
  its members' results, so their upstream moves turn with it.

### Types

```ts
interface Keyframe {
  id: KeyframeId
  name: string
  visible: boolean
}

interface Repeat<A> {
  op: A
  times: number | null            // 1 = once, null = to the end
  skip: Set<KeyframeId>           // steps left out, not counted
}

interface Turn {
  angle: number                   // unwrapped: 720° is two turns
  about: Point                    // offset from the pivot at the start of the key, world axes
}

interface Scale {
  by: { x: number, y: number }    // along the object's own axes
  about: Point                    // as `Turn.about`
}

interface Key {
  turn?: Repeat<Turn>
  move?: Repeat<Point>
  scale?: Repeat<Scale>
  erode?: Repeat<number>
}

interface Rig {
  pivot: Point
  keys: Map<KeyframeId, Key>
  nudges: Map<VertexId, Map<KeyframeId, Repeat<Point>>>    // rest frame
  depths: Map<VertexId, Map<KeyframeId, Repeat<number>>>
}

interface World {
  keyframes: Keyframe[]           // order is the array
  rigs: Map<Id, Rig>
  // polygons, groups, artefacts, paths, start as now; birth/death by KeyframeId
}
```

An absent field does nothing. Dropping one component of a key is deleting its
field.

### Applying a key

In one fixed order, with anchors taken against the pivot position `P` at the
start of the key:

```
scale by `by` about P + scale.about, along the object's axes
turn by `angle` about P + turn.about
move by `move`
Θ += angle,  S *= by,  P = where the pivot went
```

### Combining within a keyframe

Several things can contribute to one component at a keyframe: this keyframe's
own key and the repeats of earlier keys that reach it. They combine oldest
first into one of each:

- moves add; erosion adds
- turns add their angles, and the anchor is solved so that the whole motion is
  exactly the one after the other: `(I − R(θ+φ)) c = b − R(φ)b + R(φ)(a − R(θ)a)`
- turns whose angles cancel leave a move: the remainder goes to `move`
- scale factors multiply, and the scale anchor is solved the same way

A gesture in a keyframe combines into that keyframe's own key, repeat and all:
turning a key that repeats five times changes what repeats. One repeat per
component per key.

### Repeats

The n-th step of a repeat (n unskipped steps after its key) contributes its
`op`, and for a turn the anchor turned with it:

```
aboutₙ = R(angle)ⁿ · about
```

which is exactly what keeps it about one centre: each step's anchor has to ride
every displacement except the ones the repeat itself causes, and that works
out to `offsetₙ = R · offsetₙ₋₁` from the repeat's own numbers alone. So a hand
move in the middle of the span carries the orbit's centre along with the room,
and a spin in place leaves it alone. Scale anchors follow the same rule with
the scale.

Stacked erosion (`d, 2d, 3d…`) is `erode: { op: d, times: null }`.

### Gestures

- **Move**: `move += d`, in the parent frame.
- **Turn**, a lone object or a selection alike: each object gets `turn θ about
  (c − P_k)`, where `c` is the gesture's centre in its parent frame. Nothing
  records that there was a selection.
- **Scale**: `scale by f about (c − P_k)`, in the object's own axes.
- **Erode**: `erode += d`.
- **Nudge, deepen**: into the corner maps, in the rest frame.

### Playback

A key in flight plays each part partway: scale by `by^t`, turn by `t · angle`
about its anchor, move by `t · move`. A turn is an arc about its own anchor, so
a turned selection swings about its centre, and a spin with a drag in the same
keyframe spins while it slides. Nothing is recovered: the anchor is stored.

## Stays / goes

**Stays:** rest geometry (rings, corners, `Vertex.ring`), groups and
membership, sealed/loose, birth and death, the resolved-shape pipeline
(projection, CSG, `contributed`, `resolve.ts`), the bake's stretches, tracks
and events, undo.

**Goes:** `Version`, `Edit`, `Footing`, `Transform`, `EMPTY_TRANSFORM`,
`carried`, `onlyMoved`, `base`/forks, the composed-frame walk in `resolveAt`,
the fixed-point recovery in the bake, old save formats.

## Phases

### 1 — types and evaluator (`rig.ts`, pure, not wired)

- The types above; `combine` for each component; `stateAt(world, id, k)`
  giving `P`, `Θ`, `S`, erosion, corner nudges and depths; cached per rig in a
  `WeakMap`.
- `frameOf(state, pivot)`; `worldFrame(world, id, k)` composing groups.
- Tests:
  - a v0 move carried unturned past a v1 turn about another point
  - a v0 spin in place leaving a v1 turn's anchor where it was
  - corners added and deleted upstream leaving a downstream turn untouched
  - combining two turns about different anchors; cancelling angles
  - a repeated turn orbiting one centre; a skip; a hand move mid-span
  - stacked erosion; per-component drop; nested groups; birth partway

### 2 — the editor onto it (lands with 3)

- `scene.ts`: `resolveAt`, `depths`, `held`, `under`, `groupFrame`, `inward`
  read `stateAt`. `editAt` / `starting` / `withEdit` become `keyAt` /
  `withKey`; a gesture recomputes from the key it started with. Delete
  `carried`.
- `canvas.ts`: `turned` and `squashed` rewritten to the gestures above.
- Pivots: a new polygon takes the middle of its box, a new group the middle of
  its members' at the grouping keyframe.
- Ungroup folds the group into each member at every keyframe; refused where
  that is not a turn, scale and move of the member.
- Unchaining: see *Open*.
- Port `resolve.ts`, paste/stamp, `export.ts`, `view3d.ts`, `save.ts` (new
  format; older refused).
- Tests through a builder (`keyed(world, k, id, { turn, move, … })`), keeping
  the behavioural assertions.

### 3 — bake and game

Per slot in `FRAME_STRIDE` (17 of 24 floats): pivot, the state at the start of
the span (`P`, `Θ`, `S`), the key in flight (angle, turn anchor, move, scale,
scale anchor, anchors in world), holder.

- `linkAt` (`game/src/baked.ts`), `easing` / `pivot` / `moving` / `riding`
  (`bake.ts`), `morph.ts` and the shader, rewritten to *Playback*. The base
  and far-base affines and the fixed point go.
- Tests first: a room spinning in place keeps its size mid-span, a turned
  selection arcs about its centre, 720° plays as two turns, spin plus drag
  spins while sliding.

### 4 — key operations and keyframe count (`keys.ts`)

- Per component, row or column: `drop`, `push` (fold into the next keyframe),
  `pull` (fold the next into this), `split(fraction)`, set `times`, skip.
  All of them are `combine` and its inverse.
- Remove `VERSIONS`. Insert a keyframe = split every key at the next one;
  delete = push, moving births and deaths with it. A repeat's span counts
  steps, so an inserted keyframe inside it adds one.

### 5 — horizontal keyframe view

- Replaces `versionStrip`. Columns are keyframes; rows are objects in their
  group tree (selection-scoped, "all" toggle), expanding into one row per
  component.
- A key is a diamond; a repeat trails a bar whose end sets `times`; clicking a
  step skips it.
- Delete drops, ⌥delete pushes, dragging a key to a neighbour pushes or pulls.
- Row header: hide, lock, solo — flags on the object, saved. Hidden stays in
  the CSG; hidden and locked are not picked.

### 6 — effect stack

- Chamfer, round; applied in `project` after erosion. Which effects an object
  has is one fact about it; their parameters are key fields
  (`Repeat<number>`), so drop, push and repeat apply to them.

### 7 — later

Graph editor; motion path on the canvas; radial picker for overlaps; echo
(stagger) as an operator over several objects.

## Order and risk

- Phases 1–3 are one branch: editor, bake and game change format together.
- Phase 3 is the risk — the frame chain must stay exact at span ends. Its
  tests come first.
- Everything after is additive. Hide/lock is independent and can come first.
- Each phase stops at `pnpm typecheck` and `pnpm test`; the browser by hand.

## Open

1. **Unchaining.** A footing today freezes the whole composed frame. Proposed:
   a key field `stand?: State` that restarts the object's own `P`, `Θ`, `S`,
   erosion and corners from those numbers; freezing a member against its group
   means freezing the group.
2. **Combining turns with different `times`** in one keyframe — resolved for
   now by one repeat per component per key. Revisit if it chafes.
3. **Repeat spans across inserted keyframes** — steps (proposed) or a fixed
   total spread over the span.
