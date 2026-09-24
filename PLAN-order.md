# Plan: a scope's effects are a list, laid in order

# What this is for

The order a fold lays its effects in — erode, round, deform — was fixed so
that the laws in `PLAN-effect.md` could hold. They now hold for any order: the
last leak was a scope folding its union whole, so a deform laid first could join
two islands that its resolution keeps apart, and the round after it opened them
as one. A scope now folds each island of what it was handed on its own, which is
what it resolves to (`foldEach` in `effect.ts`). With that, the order is the
author's to choose.

`effect-order` surfaced it the obvious way — `Effects.order`, a list on every
thing that has effects, threaded through the fold, the memo keys, the bake and
the resolve. It works, and it is the wrong shape. An order is a second fact
about a thing that only means something alongside the first, it has to be
carried by every place that carries `Effects`, and it sits beside a record that
can hold each kind only once.

The laws say what an effect is: law 3 makes an effect on a scope an effect on
its resolution, so each effect is one layer of a fold, and a scope that rounds
sealed inside one that deforms *is* a round and then a deform. That suggests
one effect per scope, with order as nesting. It is sound, and it is bad to use:
an author reads a room's effects by drilling down through empty groups and
collecting one from each.

So: **a scope's effects are a list, laid in list order.** A list of layers on
one scope is by law 3 the same as the same layers on nested scopes, so it costs
the laws nothing, and it keeps a thing's effects in one place. The order is the
list. There is no `ORDER`, no `Effects.order`, no `inOrder`, and nothing that
reads one.

# The design

## A scope, and its list of effects

```ts
interface Group {
  members: Id[]
  sealed: boolean
  birth?: KeyframeId
  /** What this scope does to its union, first to last. Only a sealed scope
   * has any: an effect is a statement about a union. Absent is none. */
  effects?: Layer[]
}

type Layer = { id: LayerId, off?: boolean } & (
  | { kind: 'erode' }
  | { kind: 'round', precision: number, tension: number, chamfer: boolean }
  | { kind: 'deform', spacing: number, pattern: Pattern, seed: number, sides: Sides, jitter: number, falloff?: number, offset?: boolean }
)
```

A field on `Group`, not a node of its own. An effect node would need everything
a sealed group already has: members, a birth, a row in the timeline, flags,
selection, the hierarchy, moving together, and sealing's clipping of solids and
floors.

**A layer has an id**, from the world's one counter, and its amount over time is
the rig under that id. Reordering the list moves layers and keeps their ids, so
each keeps its timeline. The same kind twice (two rounds) is two layers, which
is what law 3 already says it means. Nesting still works and means the same
thing: a scope inside a scope lays the inner list, then the outer.

## Polygons have no effects

A polygon's effects become a scope around it, holding them as its list. A sealed scope holding one polygon
resolves to that polygon, so by law 1 and law 3 an effect on the polygon and an
effect on a scope around it are one thing, and there is no reason to keep two
ways of saying it. What a polygon's fold does comes down to its clean-up —
`sliced`, `identify`, `combineIdentified` — and the effect pipeline has one
entry, `foldedBy`.

This is a rename only because the per-corner and per-edge effects are gone first (below). A
polygon's effects are then one amount and one set of options each, and they go
to the scope's list unchanged, in the order they were folded.

## No per-corner or per-edge effects

Everything an effect says about less than its whole ring goes. At the corners,
that is a corner's own depth and a corner's own bevel (already dropped from the
fold, see `folding`). At the edges, it is an edge's own amplitude, an edge's own
deform options, an edge switched on or off apart from its polygon, and an edge
inheriting its polygon's options again. An effect is one amount over its whole
ring, and one set of options.

They are rarely used, and they cost far more than they are used: a second
keying of every amount, a second set of pickers and panes in the editor, and
most of the reason the bake and the resolve have to talk about single corners.
They are also what would make this plan hard. Kept, they would have to move to
the scope that lays their effect and be keyed by corners a level down. Without
them, an effect is a `Layer` and a number over time.

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
  `offsetOf` loses the depths. `erodeAt` and `erodeRingsAt` in `geometry.ts` go
  if nothing else reads them.
- **The bake.** `Resolved.depths`, `depthsOf`, and the per-corner depths
  `straightened` and `flat` lerp (`bake.ts`).
- **The resolve.** Whatever `publishing` writes per corner or per edge: per-edge
  options, `anchor`, `reach`, `key`. Most of that goes in step 6 anyway. This
  takes it sooner.
- **The editor.** `cornersAmounted`, and every edge effect in `effects.ts`:
  `edgeDeform`, `edgeDeforming`, `ownDeform`, `edgesSwitched`, `edgesOptioned`
  and `edgesInheriting`. The inspector's *Deform edges*, its `ownEdge` field and
  *as the polygon* link, and the per-corner rows it shows under a corner pick
  (`inspector.ts`). The canvas's
  amount gestures under the corner and edge tools (`cornersFor`, the
  `cornersAmounted` call in `canvas/index.ts`), and whatever `canvas/draw.ts`
  draws for a corner's own depth. The corner tools stay, for moving corners.
- **Save.** `cornerEffects`, and the key and op fields `depths`, `rounds` and
  `deforms` (`save.ts`), dropped on load by a conversion step.
- **Tests.** The per-corner cases in `effects.test.ts`, `rig.test.ts`,
  `keys.test.ts`, `key.test.ts`, `bake.test.ts`, `save.test.ts`,
  `resolve.test.ts` and `scene.test.ts` go with what they test.

What a file with per-corner or per-edge effects converts to: each polygon keeps
its own amount and options, and the extras on single corners and edges are
dropped. The drawing changes
where they were used, which is why this conversion loses something, and it is
written down as one.

## A fold is a scope's layers, in order

`foldedBy` takes the scope's list of layers and one amount per layer, and its
memo key is those, in order. Scopes fold from the innermost outwards, each
scope's input being its members' outputs. Two rules carry over from what the
laws taught:

- **The islands are the ones a scope is handed.** A scope folds each polygon of
  its input on its own and lays the parts side by side (`foldEach`). Rings two
  members' outputs laid over each other stay two, and are unioned only where
  they are drawn. This is not a special case of anything. It is what resolving
  does.
- **A scope of one member does not union it.** Its input is that member's
  output as it came. So a scope wrapping one room costs its layers and no
  arrangement, and a list is the same as the nesting it stands for.

## Resolving

Resolving a sealed scope with no effects is what it is today: its union, one
polygon per island. Resolving one with effects **resolves what is under it and
keeps the effects**. The scope stays, holding the polygons its members resolved
to. An effect is never moved onto a polygon, because a polygon cannot hold one.

That deletes most of `publishing` in `resolve.ts`: the amounts written into the
new polygons' rigs, the anchor, reach and key a resolve writes so that a run
laid by a polygon matches the one the scope laid, and the facet fade it hands
on. All of it existed because an effect changed hands in a resolve, and now
none does.

What does not go away is **names**. A deform's pattern and a round's arcs are
laid by run and corner names, and a resolve that makes new polygons mints new
`corner(member, vertex)` names. The scope above then lays a different pattern:
the teeth move, and law 1 is red. So a resolved polygon has to carry the names
its points had in the union — which `identify(cut, member, was)` is already for,
and is where the per-corner amounts are keyed too. This is the one real piece of
work in the resolve, and the part to prove first (step 0).

## The bake

`Standing.effects` and `Cast.shapes` carry a scope's layers and one amount per
layer, instead of an `Effects` and three amounts. A span's fold is its scopes'
folds, each memoised on its own, as today.

# The plan

Each step ends with `pnpm typecheck`, `pnpm test` and `pnpm build` green, and
with the law sweep (`LAW_SEED` 1–30) no worse than where the step started. That
sweep's baseline is whatever `law1-walls` leaves: its two default-order cases,
from seeds 19 and 27, are not this plan's.

**0. Prove the names survive a resolve.** Before anything else, because the
whole design stands on it: a test in which
a scope deforms a union of two members, one member is resolved, and the teeth do
not move. It goes green today only because `publishing` writes `key`, `anchor`
and `reach`. Make it green with the names alone — the resolved polygon carries
the union's names — with `publishing`'s deform half switched off. If this cannot
be done, the design is wrong and stops here.

**1. Start from `effect-fold` with `foldEach`.** Keep the island fold (46ee4af),
and drop `effect-order`'s WIP commit: `Effects.order`, `ORDER`, `inOrder`,
`orderKey` and the laws' random orders. The law generator's orders are replaced
in step 7 by the lists that say the same thing.

**2. Remove the per-corner and per-edge effects.** Everything listed under *No
per-corner or per-edge effects*, with its conversion step and a save version bump. It goes early
because it is a deletion that stands on its own, on today's design, and every
step after it is smaller for it: no per-corner or per-edge amounts to move to scopes (4), no
per-corner reads in the fold (5) or the resolve (6), and no corner-edit routing
in the editor (9). The law sweep must not move, since the laws never generate
per-corner or per-edge amounts.

**3. `Layer`, and `Group.effects`.** The types, and `Effects` read as a list of
layers everywhere it is read (`groupEffects`, `effectedAt`, `shapeKey`,
`folding`). No behaviour changes: a thing with three effects folds as a list of
three in the old order, computed on the fly. This is the step that finds every
reader of `Effects`.

**4. Save format, and the conversion.** A version bump in `save.ts` and a step in
`convert.ts`: each group's `Effects` becomes its list, in the order it was
folded (erode, round, deform), each layer with a new id. Its amounts move from
the group's rig to the layers'. A polygon with effects is wrapped in a new
sealed scope holding them the same way. A polygon with effects inside a loose group gets its
scope inside that group, in its place. The golden files are reconverted, and
`baseline.test.ts` says the drawing did not move.

**5. Polygons lose `Effects`.** The polygon fold is its clean-up and nothing else.
`folding`'s effect half goes, with `roundingOf`.

**6. Resolve keeps the effects.** `resolveGroup` on a scope with effects
resolves its members and leaves the scope, its list untouched. `publishing` loses the amounts and
the facet fade.

**7. The laws over lists.** `arbKit` becomes a list of zero to three layers in
any order, the same kind allowed twice. Law 3's "an effect on a scope" is one
layer added to the end of the list. A new property says a list draws what the
same layers on nested scopes draw.
`effects.test.ts`'s *a scope inside a scope* is rewritten to what law 3 says (see
`PLAN-effect.md`).

**8. The bake, a list per scope.** `Standing` and `Cast` as above. The perf
tests say whether folding the layers of a wrapped room as a scope costs more
than folding them on the polygon did.

**9. The editor.** The inspector lists a scope's layers, first to last, each
with its options, an on/off tick and a way to move it up or down. "Add an
effect" appends a layer, and on a selection that is not a sealed scope it first
wraps the selection in one. A room's effects are read on its scope's row. The
timeline shows one amount row per layer.

**10. Delete what is left.** `Effects`, `Options`' three-in-one shape, and
whatever of `publishing` survived step 6.

# Open questions

- **Which slot an effect applies to.** A sealed scope's output is one shape per
  slot — level, solid, floor. Today a scope's effects apply to the one that is
  its outermost kind, and a scope around a lone solid or floor has to do the
  same. Read `outermostSlot` before step 3 and write down what it does.
- **A room with effects is a room in a scope.** Every room that had effects
  gains a scope row in the hierarchy. The hierarchy may want to draw a scope of
  one room as that room's row with its layers, which is only a view.
- **What a long list costs in the fold.** Each layer ends in a resample, and
  the resamples are what the bake's linearity is proved for (see
  `PLAN-effect`'s step 1). More layers should change nothing there, but the
  linearity test should say so over a list.

# If this is too much

The smaller change keeps **polygons' own lists**: `Polygon.effects` becomes a
list too, and polygons are not wrapped. No room gains a scope, and
`publishing` stays as it is, since an effect can still change hands in a
resolve. It leaves two places an effect can live, and the polygon fold keeps
its own copy of the pipeline for the laws to keep agreeing with.
