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

## Testing

Don't test in the browser when implementing features in order to conserve tokens.
