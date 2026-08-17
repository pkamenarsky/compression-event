# compression event

A doom-style game and its editor.

```
packages/game      the game; src/world.ts is the world both halves share
packages/editor    the editor, built on kontinuum
game.html          the game page
editor.html        the editor page
```

```bash
pnpm install
pnpm dev         # :3000 — /game.html and /editor.html
pnpm build       # both pages into dist/
pnpm typecheck   # tsc over both packages
pnpm test        # vitest
```

## kontinuum

The editor's UI is [kontinuum](../signalui), pulled in with pnpm's `link:`
protocol from the sibling `signalui` checkout — see `packages/editor/package.json`.
It resolves against kontinuum's `dist/`, so after changing kontinuum itself, run
`pnpm build` over there before the change shows up here.
