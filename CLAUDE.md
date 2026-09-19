# compression-event

## Style

**A single parameter takes no parens.** Only when it is untyped: an annotation, a
default or a destructuring pattern still needs them.

```ts
todos.filter(t => !t.done)          // not (t) => !t.done
update(s => ({ ...s, draft: '' }))  // not (s) => ({ ... })

(e: Event) => setDraft(e.target)    // keeps its parens: annotated
(_index, todo) => row(todo)         // keeps them: two parameters
```

**`else` goes on its own line**, and interface members carry no separator:

```ts
interface Reactive {
  register: () => void
  unregister: () => void
}

if (cache.has(t)) {
  u = cache.get(t)!;
}
else {
  u = mapFn(t);
}
```

**An endless loop is `while (true)`**, never `for (;;)`.

```ts
while (true) {
  const e = yield* input.keyDown;
  ...
}
```

Otherwise: 2-space indent, single quotes, semicolons on statements, trailing
commas in multi-line literals, and calls left on one line where they fit.

There is no formatter, deliberately. Neither prettier nor dprint can express
this style: `semi` is a single switch covering statements and interface members
alike, `} else {` is forced, and a call with more than one function argument is
always exploded onto separate lines regardless of width. Adopting one would
rewrite ~1000 lines to a style nobody here chose, so these conventions are kept
by hand. Do not add a formatter config.

## UI

**`dynamic` is for a change of structure, and nothing else.** It throws away
the DOM under it and makes it again, and with it whatever the browser was
holding there: focus, a half-typed number, an open select, a scroll position,
a hover. So reach for it only where the shape of the tree itself changes — a
list gaining or losing items that cannot be kept by key, one kind of node
becoming another — or where doing without it would make the code dramatically
more complex. Everything else is made once and moved by values:

- split the state with `object` (fields compare by identity, so keep them
  plain values) and hand each control the `Value` it reads;
- pass functions as attributes, styles and `text`, which update in place;
- use `show` for a piece that comes and goes, and `ordered` for a list, keyed
  so an item keeps its DOM;
- keep what only highlights (the current keyframe, a hover) out of any model a
  `dynamic` is rebuilt from.

```ts
text(() => status() ?? '')                        // not dynamic(status, s => text(s))
object(model, m => number(m.spacing, ...))        // not dynamic(() => JSON.stringify(model()), ...)
```

## Modules

**A member never imports its own barrel.** Where a directory has an
`index.ts` that puts the pieces back together — `scene/`, and any other — that
file is a door: the outside reads `./scene`, and nothing inside `scene/` ever
does. A piece reads its siblings by name, `./core` and `./reading`, and the
core reads none of them.

The reason is not tidiness. A member that imports the barrel while the barrel
re-exports the member is a cycle, and a cycle survives being one file only
until the bundler decides the two sides belong in different chunks — which it
decides from which entry points reach them, not from anything visible in the
source. Then the emitted chunks import each other, whichever is evaluated
second reads the other's bindings while they are still in the dead zone, and
the page is blank at load. `tsc` and the tests bundle nothing and so can see
none of it.

So put the door in its own file and leave the bulk in `core.ts` beside it.
Where two pieces both need something and neither should read the other, the
answer is a third file that reads neither — `canvas/metrics.ts` and
`cornermaps.ts` are that, and each says so at the top.

**`import type` is not the same edge.** A type-only import is erased, so it
cannot make a runtime cycle; most of this repo's apparent cycles are these and
are harmless. When a file needs only the type, say `import type` — it is worth
the four characters, because it is the difference between an edge that can
break the build and one that cannot.

**`pnpm build` is the only thing that checks this**, and it fails rather than
warns — see `onwarn` in `vite.config.ts`. If it reports `CIRCULAR_DEPENDENCY`,
do not silence it: break the cycle, usually by moving the shared thing into a
leaf or by making one side's import type-only.

## Testing

Don't test in the browser when implementing features in order to conserve tokens.

## Committing

Commit after each self-contained change.
