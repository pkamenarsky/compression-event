# Plan: one effect per scope, and order is nesting

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
carried by every place that carries `Effects`, and it says with a list what the
tree already says with nesting: a scope that rounds, sealed inside one that
deforms, *is* a round and then a deform. The laws are the proof of that — law 3
says an effect on a scope is an effect on its resolution, so an effect is
exactly one layer of a fold, and layers are what scopes are.

So: **a scope has at most one effect, and the order of effects is the order of
the scopes.** There is no `ORDER`, no `Effects.order`, no `inOrder`, and
nothing that reads one.

# The design

## A scope, with one effect or none

```ts
interface Group {
  members: Id[]
  sealed: boolean
  birth?: KeyframeId
  /** The one thing this scope does to its union, or nothing. Only a sealed
   * scope has one: an effect is a statement about a union. */
  effect?: Layer
}

type Layer =
  | { kind: 'erode', off?: boolean }
  | { kind: 'round', off?: boolean, precision: number, tension: number, chamfer: boolean }
  | { kind: 'deform', off?: boolean, spacing: number, pattern: Pattern, seed: number, sides: Sides, jitter: number, falloff?: number, offset?: boolean }
```

A field on `Group` rather than a union type `Group | Effect`. What an effect
node would need is everything a sealed group already has: members, a birth, a
row in the timeline, flags, selection, hierarchy, moving together, sealing's
clipping of solids and floors. A second kind of node would repeat all of it and
teach every one of those places a second case. A sealed group with no effect is
the node that does nothing but union, and one with an effect is the effect
node. It is still a union type in every sense that matters. It just has one tag.

Stacking effects is nesting: *round then deform* is a deforming scope whose one
member is a rounding scope. Reordering is moving a scope up or down the chain.
The same kind twice — two rounds — is two scopes, which is what law 3 already
says it means.

## Polygons have no effects

A polygon's effects become scopes around it. A sealed scope holding one polygon
resolves to that polygon, so by law 1 and law 3 an effect on the polygon and an
effect on a scope around it are one thing, and there is no reason to keep two
ways of saying it. What a polygon's fold does comes down to its clean-up —
`sliced`, `identify`, `combineIdentified` — and the effect pipeline has one
entry, `foldedBy`.

This is a rename only because the per-corner and per-edge effects are gone first (below). A
polygon's effects are then one amount and one set of options each, and they go
to a scope unchanged.

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
the scope that lays their effect and be keyed by corners two levels down, and
the editor would have to decide which scope a corner edit goes to. Without
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

## A fold is one step per scope

`foldedBy` takes one `Layer` and one amount, not three, and its memo key is that
layer's options. A chain folds from the innermost outwards, each scope's input
being its members' outputs. Two rules carry over from what the laws taught:

- **The islands are the ones a scope is handed.** A scope folds each polygon of
  its input on its own and lays the parts side by side (`foldEach`). Rings two
  members' outputs laid over each other stay two, and are unioned only where
  they are drawn. This is not a special case of anything. It is what resolving
  does.
- **A scope of one member does not union it.** Its input is that member's
  output as it came, so a chain of single-member scopes costs one fold per
  scope and no arrangement between them.

## Resolving

Resolving a sealed scope with no effect is what it is today: its union, one
polygon per island. Resolving one with an effect **resolves what is under it and
keeps the effect**. The scope stays, holding the polygons its members resolved
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
work in the resolve, and the part to prove first (step 2).

## The bake

`Standing.effects` and `Cast.shapes` carry one layer and its amount per scope
instead of an `Effects` and three amounts. A span's fold is the chain of its
scopes' folds, each memoised on its own. That is finer than today's memo, so a
chain that one keyframe changes only at its top reuses everything under it.

# The plan

Each step ends with `pnpm typecheck`, `pnpm test` and `pnpm build` green, and
with the law sweep (`LAW_SEED` 1–30) no worse than where the step started. That
sweep's baseline is whatever `law1-walls` leaves: its two default-order cases,
from seeds 19 and 27, are not this plan's.

**0. Start from `effect-fold` with `foldEach`.** Keep the island fold (46ee4af),
and drop `effect-order`'s WIP commit: `Effects.order`, `ORDER`, `inOrder`,
`orderKey` and the laws' random orders. The law generator's orders are replaced
in step 7 by the chain that says the same thing.

**1. Remove the per-corner and per-edge effects.** Everything listed under *No
per-corner or per-edge effects*, with its conversion step and a save version bump. It goes first
because it is a deletion that stands on its own, on today's design, and every
step after it is smaller for it: no per-corner or per-edge amounts to move to scopes (4), no
per-corner reads in the fold (5) or the resolve (6), and no corner-edit routing
in the editor (9). The law sweep must not move, since the laws never generate
per-corner or per-edge amounts.

**2. Prove the names survive a resolve.** Before anything moves: a test in which
a scope deforms a union of two members, one member is resolved, and the teeth do
not move. It goes green today only because `publishing` writes `key`, `anchor`
and `reach`. Make it green with the names alone — the resolved polygon carries
the union's names — with `publishing`'s deform half switched off. If this cannot
be done, the design is wrong and stops here.

**3. `Layer`, and `Group.effect`.** The types, and `Effects` read as a chain of
layers everywhere it is read (`groupEffects`, `effectedAt`, `shapeKey`,
`folding`). No behaviour changes: a thing with three effects folds as three
nested layers in the old order, computed on the fly. This is the step that finds
every reader of `Effects`.

**4. Save format, and the conversion.** A version bump in `save.ts` and a step in
`convert.ts`: each thing's `Effects` becomes a chain of sealed scopes around it
in the order it was folded (erode innermost, then round, then deform). Its
amounts move from its rig to theirs. A polygon with effects inside a loose group gets its
scopes inside that group, in its place. The golden files are reconverted, and
`baseline.test.ts` says the drawing did not move.

**5. Polygons lose `Effects`.** The polygon fold is its clean-up and nothing else.
`folding`'s effect half goes, with `roundingOf`.

**6. Resolve keeps the effect.** `resolveGroup` on a scope with an effect
resolves its members and leaves the scope. `publishing` loses the amounts and
the facet fade.

**7. The laws over chains.** `arbKit` becomes a chain of zero to three layers in
any order, each a scope. Law 3's "an effect on a scope" is one layer.
`effects.test.ts`'s *a scope inside a scope* is rewritten to what law 3 says (see
`PLAN-effect.md`).

**8. The bake, one layer per scope.** `Standing` and `Cast` as above, and the
memo per scope. The perf tests say whether the finer memo pays for the extra
stages.

**9. The editor.** The inspector shows a scope's one effect, and "add an effect"
on a selection wraps it in a new sealed scope with that effect. The hierarchy
shows the chain, and reordering is moving a scope past its neighbour — swapping
two single-member scopes' layers, which keeps their ids and their timelines.

**10. Delete what is left.** `Effects`, `Options`' three-in-one shape, and
whatever of `publishing` survived step 6.

# Open questions

- **Which slot an effect applies to.** A sealed scope's output is one shape per
  slot — level, solid, floor. Today a scope's effects apply to the one that is
  its outermost kind, and a scope around a lone solid or floor has to do the
  same. Read `outermostSlot` before step 3 and write down what it does.
- **What a chain costs in the hierarchy.** Three effects on every room is three
  scopes on every room. The hierarchy may want to draw a chain of single-member
  effect scopes as one row with its layers listed, which is only a view.
- **What a single-member chain costs in the fold.** Each stage is a resample,
  and the resamples are what the bake's linearity is proved for (see
  `PLAN-effect`'s step 1). More stages should change nothing there, but the
  linearity test should say so over a chain.

# If this is too much

The smaller change is an **ordered list per node**: `Group.effects` and
`Polygon.effects` become a list of layers, each with its own amount in the rig,
folded in list order. It keeps polygons' effects and `publishing` as they are, and it lets the same kind appear twice. It
buys the order without the restructure, and it leaves two ways of saying one
thing — a list on a node, and nesting — for the laws to keep agreeing.
