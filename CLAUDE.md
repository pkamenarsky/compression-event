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

Otherwise: 2-space indent, single quotes, semicolons on statements, trailing
commas in multi-line literals, and calls left on one line where they fit.

There is no formatter, deliberately. Neither prettier nor dprint can express
this style: `semi` is a single switch covering statements and interface members
alike, `} else {` is forced, and a call with more than one function argument is
always exploded onto separate lines regardless of width. Adopting one would
rewrite ~1000 lines to a style nobody here chose, so these conventions are kept
by hand. Do not add a formatter config.
