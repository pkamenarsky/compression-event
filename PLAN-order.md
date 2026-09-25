# Plan: effects are a list, laid in order, by one pipeline

# What this is for

The order a fold lays its effects in — erode, round, deform — was fixed so
that the laws in `PLAN-effect.md` could hold. They now hold for any order: the
last leak was a scope folding its union whole, so a deform laid first could join
two islands that its resolution keeps apart, and the round after it opened them
as one. A scope now folds each island of what it was handed on its own, which is
what it resolves to (`foldEach` in `effect.ts`). With that, the order is the
author's to choose.

`effect-order` surfaced it the obvious way — `Effects.order`, a list beside a
record that can hold each kind only once, threaded through the fold, the memo
keys, the bake and the resolve. It works, and it is the wrong shape: an order is
a second fact that means something only alongside the first, and every place
that carries `Effects` has to carry it too.

So: **a thing's effects are a list, laid first to last.** A polygon and a
sealed scope each have one. The order is the list, the same kind may appear
twice, and there is no `ORDER`, no `Effects.order` and no `inOrder`.

And: **one pipeline lays a list, for polygons and scopes alike.** Today
`folding` (a polygon's fold, `scene/core.ts`) and `foldedBy` (a scope's,
`scene/reading.ts`) share the step functions but each builds its own steps, from
its own inputs, memo keys and option decoding. Most of what `folding` has that
`foldedBy` does not is per-corner and per-edge effects — a depth per corner, a
deform's options per edge, a facet count per corner reduced to the finest —
and those go first (below). What is left of the two is how each builds its
input and its memo key. The effects are one function.

# The design

## A list of layers

```ts
type Layer = { id: LayerId, off?: boolean } & (
  | { kind: 'erode' }
  | { kind: 'round', precision: number, tension: number, chamfer: boolean, facets?: Facets, facetsAt?: number }
  | { kind: 'deform', spacing: number, pattern: Pattern, seed: number, sides: Sides, jitter: number, falloff?: number, offset?: boolean }
)

// World.effects: ReadonlyMap<Id, readonly Layer[]>, for polygons and groups
```

`World.effects` keeps its place and its key, and its value becomes a list. A group
may have one only when it is sealed, as today: an effect is a statement about
a union.

**A layer has an id**, from the world's one counter, and its amount over time
is the rig under that id — erosion, bevel or amplitude, by the layer's kind.
Reordering moves layers and keeps their ids, so each keeps its timeline. Two
rounds are two layers with two timelines.

A list on one scope is the same as its layers on nested scopes, one each.
That is written down as a property (step 4), and it is what lets an author
say in one place what nesting would say across several.

**The laws hold, with no exceptions.** Not a property excused where a step
pinches an island, not law 1 excused where a wall is laid across two rings
(`laidAcross`): a configuration a law does not hold on is a bug in the
drawing, never a case the law is let off. Where a law and a construction
disagree, the construction changes.

## One pipeline

```ts
/** A shape through its layers, first to last, each island on its own. */
export function effected(it: Drawn, layers: readonly Layer[], amounts: readonly number[]): Drawn
```

In `effect.ts`, beside the steps it lays. Each layer is turned into its step
(`eroding`, `roundingAcross`, `deforming`) and the steps are folded over each
polygon of `it` with `foldEach`. An `off` layer and a layer at nought are
skipped, except that a deform at nought is still laid where `holding()` says
(see `hold.ts`), as today.

- `folding` is the polygon's clean-up — `sliced`, `identify`,
  `combineIdentified` — and then `effected`.
- `foldedBy` is the union and then `effected`.

Each keeps its own memo: the polygon's is keyed by its source ring and its
effects, the scope's by content. Both keys are built from the list the same
way, by one function, so they cannot say different things about it.

What this buys is the reason for most of the law bugs so far: a polygon's fold
and a scope's fold disagreeing about the same effects, the flat tooth being the
one that kept coming back. With one pipeline, the polygon's fold and the scope's
can differ only in their input.

## No per-corner or per-edge effects

Everything an effect says about less than its whole ring goes. At the corners,
that is a corner's own depth and a corner's own bevel (already dropped from the
fold, see `folding`). At the edges, it is an edge's own amplitude, an edge's own
deform options, an edge switched on or off apart from its polygon, and an edge
inheriting its polygon's options again. An effect is one amount over its whole
ring, and one set of options.

They are rarely used, and they cost far more than they are used: a second
keying of every amount, a second set of pickers and panes in the editor, and
most of the reason the bake has to talk about single corners. They are also
what keeps the two folds apart: `folding` reads them, `foldedBy` has none, and
that difference is most of why there are two pipelines. Without them, an effect
is a `Layer` and a number over time.

An author who wants one wall deformed and the rest straight splits the room, or
puts the wall's room in a scope of its own. That is the one thing lost, and
nesting says it.

What goes:

- **Types and the rig.** `World.cornerEffects`, and the rig's `depths`, `rounds`
  and `deforms` maps with their `Entry<Amount<…>>` entries (`rig.ts`), with
  `amounted` and `edgeDeformed`. `CORNER_MAPS` comes down to `nudges`, and
  `AMOUNTS`' `each` column goes. A key's `depths`, `rounds` and `deforms` go
  (`keys.ts`); its `corners` stay, a nudge being geometry and not an effect.
- **The walk and the state.** `State` and `Stand` lose `depths`, `bevels` and
  `amplitudes`, and `stateAt` loses the per-corner half of each amount.
- **The effect pipeline.** `Amount` becomes a number: `amountOf` and `asks` lose
  their map case, and `effect.ts` loses what reads an amount per identity, which
  the erosion's swept band and the deform's runs both do. `folding` loses `at`,
  `index`, `mine`, `effectingFrom` and the per-polygon deform options, and
  `offsetOf` loses the depths. `roundingOf` comes down to the one facet count a
  ring has. `erodeAt` and `erodeRingsAt` in `geometry.ts` go if nothing else
  reads them.
- **The bake.** `Resolved.depths`, `depthsOf`, and the per-corner depths
  `straightened` and `flat` lerp (`bake.ts`).
- **The editor.** `cornersAmounted`, and every edge effect in `effects.ts`:
  `edgeDeform`, `edgeDeforming`, `ownDeform`, `edgesSwitched`, `edgesOptioned`
  and `edgesInheriting`. The inspector's *Deform edges*, its `ownEdge` field and
  *as the polygon* link, and the per-corner rows it shows under a corner pick
  (`inspector.ts`). The canvas's amount gestures under the corner and edge tools
  (`cornersFor`, the `cornersAmounted` call in `canvas/index.ts`), and whatever
  `canvas/draw.ts` draws for a corner's own depth. The corner tools stay, for
  moving corners.
- **Save.** `cornerEffects`, and the key and op fields `depths`, `rounds` and
  `deforms` (`save.ts`), dropped on load by a conversion step.
- **Tests.** The per-corner and per-edge cases in `effects.test.ts`,
  `rig.test.ts`, `keys.test.ts`, `key.test.ts`, `bake.test.ts`, `save.test.ts`,
  `resolve.test.ts` and `scene.test.ts` go with what they test.

What a file with per-corner or per-edge effects converts to: each polygon keeps
its own amount and options, and the extras on single corners and edges are
dropped. The drawing changes where they were used, which is why this conversion
loses something, and it is written down as one.

## Resolving

A resolve does what it does today with a list in place of a record. Each new
polygon gets the scope's list, with **fresh layer ids**, and the scope's
amounts written onto those ids' rigs as the entries `resolveGroup` already
writes (`resolve.ts`, where it walks `standing`). A copy per polygon, because
an amount's timeline is its layer's, and two polygons sharing a layer would
share an edit to it.

Law 3 still has to be kept by the resolve, not by construction: the copy has to
say what the fold said. With one pipeline that comes down to three things — the
list, the amounts and the names — and not to two folds agreeing about what the
same effects do.

## The bake

`Standing.effects` and `Cast.shapes` carry a list and one amount per layer,
instead of an `Effects` and three amounts. The memo is per polygon and per
scope, as today.

# The plan

Each step ends with `pnpm typecheck`, `pnpm test` and `pnpm build` green, and
with the law sweep (`LAW_SEED` 1–30) no worse than where the step started. The
starting sweep is `effect-fold` after `law1-walls`: seed 20 red, on "nor does
resolving a scope inside it", which is not this plan's.

**0. Remove the per-corner and per-edge effects.** Everything listed under *No
per-corner or per-edge effects*, with its conversion step and a save version
bump. On today's design, from `effect-fold` with the island fold (`foldEach`,
46ee4af) — and without `effect-order`'s `Effects.order`, which goes. It is a
deletion that stands on its own, and it is what makes step 1 small. The law
sweep must not move, since the laws never generate per-corner or per-edge
amounts.

**1. One pipeline.** `effected` in `effect.ts`, and `folding` and `foldedBy`
through it, still reading today's `Effects` record in the fixed order. One
function builds both memo keys' effect part. No behaviour changes: the laws, the
baseline and the bake tests say so. This is the step that shows whether
anything besides per-corner effects kept the two folds apart; if something did,
it is written down here and resolved before step 2.

**2. `Layer[]`.** `World.effects` holds lists, layers have ids and their amounts
move to the layers' rigs, and `effected` lays the list in its order. `Effects`
is read nowhere. Every reader of it — `groupEffects`, `effectedAt`, `shapeKey`,
`folding`, the resolve, the bake — is found here, because the type is gone.

**3. Save format, and the conversion.** A version bump in `save.ts` and a step
in `convert.ts`: each thing's `Effects` becomes its list in the order it was
folded (erode, round, deform), each layer with a new id, and its amounts move
from the thing's rig to the layers'. The golden files are reconverted, and
`baseline.test.ts` says the drawing did not move.

**4. The laws over lists.** `arbKit` becomes a list of zero to three layers in
any order, the same kind allowed twice, on polygons as well as scopes. Law 3's
"an effect on a scope" is one layer added to the end of its list. A new
property: a list on a scope draws what its layers on nested scopes draw, one
each. `effects.test.ts`'s *a scope inside a scope* is rewritten to what law 3
says (see `PLAN-effect.md`).

   *Done.* The two reds it first found were one cause: a list's leading
   erosions were added up into one depth, and the mitred offset is not
   additive — a wall that runs out of room part way down (here a 0.53 wall
   between an arc and a straight, gone at depth 2.05) takes its band with it,
   and a mitre held at its limit is held from where it starts. So
   `[erode 2, erode 1]` on a scope drew erode 3 while its layers on nested
   scopes drew 2 and then 1, and law 3's scope `[erode 1, erode 1]` drew 2
   while the resolution laid the two after a deform, one by one. Fixed by
   making `depthOf` the first erosion only; every layer after it is a step of
   the fold, erosions included. Making the offset additive instead would be a
   straight skeleton, and would still not agree with the mitre limit.

   *Islands, still red.* The sweep's seed is random unless `LAW_SEED` is set,
   and across seeds the nesting property is red most of the time: a scope
   `[erode 5, deform 1]` whose erosion pinches its union into four lays the
   deform across all four, while the same list taken apart deforms each
   alone. The cause is the resolve making one polygon per island, and
   `foldEach` taking the islands once, before any step, to match it — which
   is also what `laidAcross` excuses law 1 for. The fix is step 4a.

**4a. A scope resolves to one polygon.** Every ring of the union — each
outline and its holes — in one polygon carrying the scope's list, rings
without the scope's effects on them. Its fold is then the scope's fold over
the same shape, whatever the list does to the islands. `foldEach` stops
taking islands and lays each step on the whole shape (`eroding` still offsets
polygon by polygon inside itself), so a nesting is the same steps with a
union between them. `laidAcross` and law 1's excuse for it go.

   *Done, still red.* One polygon a side of the set (level, floor), all its
   outlines and their holes. The shrunk nesting case above passes. What the
   excuse was covering is now in view, and is not islands: a scope `[deform
   1]` over a room (0,0,120,120) and a scope `[deform 1]` over rooms
   (0,120,160,80) and (0,60,160,80) `[deform 1]` — one island — lays the left
   wall's teeth at another phase from its resolution. A wall cut by the
   arrangement reads as one line in the scope and not in the polygon it
   resolves to (`linesIn`, `Vertex.crossing`). *Fixed:* not the lines at
   all — the scope's ring passes (0,120) twice as two corners, and
   `boundaryRuns` names both by the lower index (`settled`), so the resolve
   gave the piece below the wrong corner's name. The resolve now names a
   point by the vertex the walk came through (`Whither.walked`).

   Then seed 4's other three, and two causes. Law 1 (*nor does resolving a
   scope inside it*) and law 3 (*a list of them*) were one name laid twice:
   a tooth was `tooth(run, j)`, so a second deform along a wall named its
   tooth 0 as the first deform's tooth 0 ten units off, and the deform after
   read the two as pieces of one wall with a cut between. A tooth is now one
   `generation` deeper than any name on the shape in front of it. Law 2
   (*sealing ... lays nothing*) was `cornersOnly`: a round's corner came out
   of the arrangement as two points 2e-6 apart, each flat against the other,
   and both went at once, a chord cut across the corner. A point is now
   measured against the last one kept. That also took law 3's *a deform* on
   seed 2 (the tooth 0.04 off). Seeds 2 to 4 are green.

   Nesting on seeds 1 and 5 was three ways a drawing and its resolution
   read one outline differently, each a point that does not turn. A tooth
   leaned by the joints either side of its facet, and a flat point is a
   joint leaning nowhere: a tooth rides a run's corners only now (`bent`).
   `cornersOnly` measured a turn off the whole arrangement's extent, so a
   ring resolved beside a far room dropped a hair corner the same ring eroded
   alone kept: it measures off the ring's own now. And a flat point started a
   deform's run unless the ring was held: `flatAt` asks `cornersOf`, the
   resolve's own question, always. Seeds 1 to 5 are green.

   Nesting on seeds 6, 9 and 10 was the erosion's turn at the same thing: it
   swept a band quad and spoke from every point, flat or not, and beside a
   step a hair across a flat point moved the eroded outline by 0.04. It
   sweeps `cornersOf`'s corners now, holding what the arrangement holds.
   Every law is green on seeds 1 to 10. Shrink with `LAW_NEST`, `LAW_THREE`
   or `LAW_TWO` and `LAW_SHRINK`.

**5. The bake.** `Standing` and `Cast` as above. The perf tests say whether a
list costs anything over a record.

**6. The editor.** The inspector lists a thing's layers, first to last, each
with its options, an on/off tick and a way to move it up or down. "Add an
effect" appends a layer. The timeline shows one amount row per layer, under the
layer's name.

**7. Delete what is left.** `Effects`, `Options`' three-in-one shape,
`REMEMBERED`'s shape if it no longer fits, and anything still reading a fixed
order.

# Open questions

- **Which slot a scope's list applies to.** A sealed scope's output is one shape
  per slot — level, solid, floor. Today its effects apply to the one that is its
  outermost kind. Read `outermostSlot` before step 2 and write down what it
  does; nothing here should change it.
- **What a long list costs.** Each layer ends in a resample, and the resamples
  are what the bake's linearity is proved for (see `PLAN-effect`'s step 1).
  More layers should change nothing there, but the linearity test should say so
  over a list.
- **Where a remembered option comes from.** `REMEMBERED` holds one set of
  options per kind, which is what a new layer starts with. With two rounds on a
  thing, "the last round's options" is still one answer, but whether that is
  the one an author wants is a question for the editor.

# Later, if the resolve keeps breaking law 3

The further step is **effects on scopes only**. A polygon has no list, and a
room with effects is a room in a sealed scope that holds them. A resolve then
never moves an effect: it resolves what is under the scope and leaves the list
where it was, so law 3 holds by construction, and the copy in *Resolving* goes.

It costs a scope around every room that has effects, in the hierarchy, in
selection and in the conversion, and an extra fold per wrapped room. And it has
a precondition that has to be proved first: **the names survive a resolve.** A
deform's pattern and a round's arcs are laid by run and corner names, and a
resolve that makes new polygons mints new `corner(member, vertex)` names. The
scope above then lays a different pattern, the teeth move, and law 1 is red. So
a resolved polygon has to carry the names its points had in the union —
which `identify(cut, member, was)` is already for. The proof is a test: a scope
deforms a union of two members, one member is resolved, and the teeth do not
move, with nothing copied across.

Worth doing only if, after step 4, the laws keep going red in the copy.
