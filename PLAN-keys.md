# Plan: keys

One concept where there are now three. A **key** is what a thing does at a
keyframe: a delta over everything it has — where it is, how deep it is eroded,
how far its corners stand — written as one thing, dragged as one thing, and
repeated as one thing. Operations, the ops row, effect repeats and the split
between a keyframe and what is written in it all become this.

Nothing about the playback design changes: a key is a delta, not a place, so a
key written at v1 is carried by every keyframe after it rather than overruled
by them, exactly as an entry is today. What changes is the grain. Today the
editor decides where one operation ends and the next begins, by kind and by a
fold that is exact only sometimes. Under this, the author decides, by saying
"break here", and the editor never merges across that line.

## The model

### A key

```ts
/** Everything a delta changes, in one: the frame's parameters, the amounts,
 * and where the painted point goes. */
interface Delta {
  /** Where `ref` goes, in the axes of whatever holds the thing. */
  move: Point
  /** Added to the frame's angle and skew; multiplied into its scale, along
   * the axes below. */
  angle: number
  skew: number
  scale: { x: number, y: number }
  /** The axes the stretch and the shear were written along: the thing's own
   * angle and lean when the key was made. Read only by repeats — see
   * *Repeats*. */
  along: number
  lean: number
  /** Added to the running totals. */
  erode: number
  round: number
  deform: number
}

interface Key {
  /** Its own, for picking it, for a merge, and for nothing else. */
  id: number
  /** The painted point, in the thing's rest frame: the point the delta is
   * written about. */
  ref: Point
  /** What it does to the thing as a whole. Absent is nothing, which is what a
   * key about single corners alone holds. */
  by?: Delta
  /** Moves of single corners, in the rest frame, and the extra amounts on
   * single corners and edges. Absent is none. */
  corners?: ReadonlyMap<VertexId, Point>
  depths?: ReadonlyMap<VertexId, number>
  rounds?: ReadonlyMap<VertexId, number>
  deforms?: ReadonlyMap<VertexId, number>
  /** How many keyframes it contributes to, from its own: 1 is once, `null` is
   * to the end. */
  times: number | null
  /** Keyframes after its own where the repeat waits, carrying its count on. */
  skip?: ReadonlySet<KeyframeId>
  /** The state outright, instead of a delta: what unchaining writes. */
  stand?: Stand
  /** The gesture that wrote it, where one gesture wrote keys on several
   * things: picked together, dragged together, split together. A hint, as
   * `Entry.gesture` is today. */
  group?: number
}

interface Rig {
  keys: ReadonlyMap<KeyframeId, readonly Key[]>
}
```

`Rig` loses `nudges`, `depths`, `rounds` and `deforms`: a corner's move is in
the key beside the thing's own move, so a gesture that nudges four corners
writes one key, and repeating it repeats all four. A corner never holds a
timeline of its own again.

A key with corners and no `by` is how a corner repeats on its own — what the
migration writes where one corner's repeat differs from its thing's, and what
dragging a corner out of a key makes. Nothing in the type is special about it.
Order among such keys never matters either: a corner's move is in the rest
frame and the thing's delta acts over the rest geometry, so the two commute,
as the amounts do.

### Playing one

`ref` is a painted point, as it is now: a point of the thing in its rest
frame, put where the thing's middle was when the key was made, and from then
on just a point of the thing. Playing a key over a frame `F`:

```
p  = F(ref)                           where the painted point is now
F' = angle += by.angle
     skew  += by.skew
     scale *= by.scale                along the thing's own axes
     t      chosen so that F'(ref) = p + by.move
```

and the amounts add. That is the whole of it. There is no anchor and no slide
in the data: a turn about a far-off centre is an angle and a move of the
painted point, and the centre is implied by the pair. `Move`, `Turn`, `Scale`
and `Skew` collapse into this, and with them every per-kind branch in the
walk, the step, the fold and the unroll.

### Repeats

A repeat takes the same delta again at each keyframe, adjusted so that it acts
about the same centre as the first. As now, that comes to riding every
displacement of `ref` except the ones the repeat itself causes, and with the
delta written as above it is one rule instead of three:

```
moveₙ = Lⁿ · move      L = R(angle) · K(skew) · S(scale), in the axes `along`/`lean`
```

`L` is the delta's linear part frozen in the axes it was written along, which
is why `along` and `lean` are stored: read live, a repeated stretch would
change direction as the thing turned. For a turn this is today's
`aboutₙ = R(angle)ⁿ · about`, and for a stretch today's `shiftₙ = Mⁿ · shift`.
The amounts add once per step, and a corner's move is in the rest frame and so
repeats unchanged.

Stacking is two keys in one column, each with its own tail — an orbit and a
spin at once, which nothing that folds per kind can express.

### Where the hand is

The place being edited is a keyframe **and a key in it**: not a column alone.

- Standing at the end of a column, gestures land in the column's **open key** —
  one that exists because something is written in it, never stored empty. A
  gesture recomputes from the world it started in and writes the cumulative
  delta, as it does today, so a drag leaves one key however long it goes on,
  and the next drag adds to the same one.
- **Break here** closes the open key. The next gesture starts another. This is
  the only thing that decides grain, and it is the author's.
- **Split the last gesture** takes the gesture just made out of the open key
  into a key of its own, after the fact. The editor knows what the hand did
  even though the key has absorbed it; nothing about this is stored. This is
  the answer to "repeat that last move, not the four before it".
- **Clicking a key** stands on it: the canvas draws the thing as that key
  leaves it, and a gesture adjusts *that* key's delta rather than appending.
  So there is no separate gesture for editing an entry — `editedAt` and
  `refolded` go, and standing on a key is what they were for.

### Dragging one

- **Along the columns** — pull and push. The key leaves its column, composing
  into the neighbouring column's keys, and the column it left becomes a no-op
  for that thing. Deltas compose exactly, so the picture at every other
  keyframe is unchanged.
- **By the tail** — repeat to that column, as `timeline.ts` does now. Clicking
  a dot on the lane makes it a wait; dragging the end back ends the repeat.

Selecting several things and breaking, splitting or dragging does it to each,
by `group`.

## Stays / goes

Stays: the frame and its parameters; painted refs; deltas carrying downstream;
the order of contributions at a keyframe (repeats from earlier keyframes,
oldest first, then the column's own keys in order); stands; the unroll on
ungroup, resolve and paste; the timeline's lanes.

Goes: `Op` as a union of eight kinds, and every branch on it; `Entry`;
`merged`; `appending`; `refolded`; `around`; `editedAt`; `Rig`'s four corner
maps and `cornermaps.ts`'s reason for being; the ops row's per-kind icons; the
`'order'` reason in `Unrolled`; the effects pane's separate idea of a repeat.

## Phases

### 1 — the type and the evaluator

`Key`, `Delta`, playing one, the step rule, `stateAt`, in `rig.ts`, pure and
unwired. Tested against today's semantics: a converter from `Entry` to `Key`,
then every existing rig test replayed through both and compared, state by
state, keyframe by keyframe. Where the two disagree the converter is wrong,
because every entry is a key that holds one channel.

### 2 — the file

The shape a 24 keeps, and the way in from everything older. A key is nearly
JSON as it stands — its delta is numbers and points — so only its maps, its
set and its stand are written out, and a delta is read field by field over the
one that does nothing, so a file saved before a field existed reads as not
doing it. Entries become keys one for one; a corner's own writing is gathered
into keys of its own, one per repeat at a keyframe.

Held to by: a rig of keys through `JSON.parse(JSON.stringify(…))` and back
whole; a rig of entries read through a file as keys playing what the entries
play; and every world in `scratch/` a current format can open, read both ways
and compared thing by thing, keyframe by keyframe. Eight corner entries across
those files gather into two keys.

`FORMAT` stays 23 until the world itself holds keys, since nothing can write a
24 before then; the golden baseline is re-baked with the wiring, for the same
reason.

### 3 — the editor onto the keys

The switch, in four commits, each of them green. What makes it possible to
take in pieces is that a rig of entries converts to keys and nothing has to
convert back: the readers move over first, reading keys made from the entries
that are still stored, and the writers follow.

**3a — the states come off the keys.** The key model moves into `rig.ts`,
because the walk needs the keyframes, the corner lives and the repeat counting,
and a file that reads `rig.ts` while `rig.ts` reads it is the cycle the rule in
`CLAUDE.md` is about. `stateAt` walks keys, converted from the stored entries
once per rig and cached against it, as the entry walk is. The entry walk stays
for `playedAt` and `sourcesAt`, whose callers have not moved yet. Both walks
run over the same rigs and the existing tests hold them to each other.

**3b — the bake reads keys.** In two, because the operations are not only the
editor's: the shipped level carries a table of them, and both the game's CPU
replay (`playedAt` in `baked.ts`) and the shader (`played` in `morph.ts`) play
that table part way, exactly as `played` does here.

*3b-i.* `playingAt` gives a keyframe's contributions — each a key's delta,
stepped for its repeat, about the point it acts about — and the bake takes its
flights from there instead of from `playedAt`. What a flight holds is still
operations: `opsOf` gives a delta back as the operation it came from, numbers
and all, so nothing the game sees moves and the golden baseline stands. What
changes is only where the bake reads from, which is what lets the entry walk go.

*3b-ii, before 3d.* The table holds deltas: one kind and the stand, instead of
five kinds. Both replays follow, and the golden is re-baked there, because a
delta plays as **one motion** — the painted point round the point the delta
leaves still — where a table of single operations can only play it as its
parts. They agree at every keyframe and differ in between, which is to say:
**folding two gestures into one key changes the motion between the keyframes,
not the keyframes.** That is what a key means, and the shipped table has to be
able to say it before a gesture can make one.

**3c — the world holds keys.** `World.rigs` becomes `Map<Id, KeyRig>`, the
converter runs at load, and `FORMAT` becomes 24. Every writer moves in this
commit, because there is no way back from a key to an entry once one holds two
channels: the gestures (`appended` becomes the open key absorbing the
gesture), the corner writes (`nudged`, `deepened`, `cornerRounded`,
`edgeDeformed`), unchaining (`handed`), and `keys.ts`.

Pull and push are a splice, not a fold: the key leaves its column's list and
goes on the end of the column before, or the front of the column after. The
keys either side are untouched, the order they play in is the order they were
already in, and there is nothing to solve. Folding happens in one place only —
a gesture absorbed into the open key — and there it has the frame to hand,
which it needs where the two painted points differ.

**3d — break and split.** The two that are new: closing the open key, and
taking the last gesture out of it into one of its own. Everything else in the
editing surface is a key where there was an entry.

What is not in this phase: the view still draws a key per icon as it drew an
entry per icon, which is phase 4, and the group fold, the copy and the unroll
still compare operations, which is phase 5. Those keep `Op`, `Entry` and the
entry walk alive until then; the walk is deleted with them.

### 4 — the view

The columns stay as they are: keyframes across, things down, a handful of
icons side by side in a column in play order, widening for more, with a lane
under the row for each repeat. What changes is what an icon is — one diamond
per key rather than one per operation — with a glyph for each channel it holds
and a count where a gesture repeated itself into it. The inspector reads the
state at the key stood on. The ops row's per-kind icons go.

A corner's row in the point tool stops being a timeline and becomes a
projection: a key that names corners puts a dot in the row of each, in its own
column, and clicking one picks the key. Hovering a key lights the corners it
touches on the canvas. Dragging one corner's dot down to a lane of its own
takes that corner out into a key of its own — the same split as taking the
last gesture out, by corner instead of by time.

### 5 — the rest

Group fold and ungroup, copy and paste, resolve, and the effects pane: an
amount-only key is what the pane writes, and a repeatable transform is a key
with a tail, so the pane stops having a second idea of what a repeat is.

## Known and accepted

- **Grain is the author's, and permanent.** Two drags that would fold today
  stay two keys unless a break is missing between them. Files get longer; the
  view folds them for display, the data does not.
- **A fold changes the way, not the ends.** Two gestures folded into one key
  land where the two landed, and go there as one motion rather than as one
  after the other. Nothing a keyframe shows moves; what the game draws between
  two keyframes does.
- **A key's axes are frozen.** A stretch repeated after something upstream
  turns the thing goes on stretching along the axes it was written along.
  Same as today, now said in one place.
- **Push and pull still reorder against repeats.** A key pushed into a column
  lands after the steps that repeats from earlier columns take there — exact
  where those are moves and amounts, and a change where they turn or stretch.
  The gesture says so, as it does now.
- **Standing on a key in an earlier column scrubs.** The canvas shows a moment
  that is not a keyframe. Ghosts are of the keyframes, as now.

## Open

- Does a key ever move between things, or only between columns?
- Corner births and deaths: they are the thing's, not a key's, and stay where
  they are — worth checking against pull and push.
