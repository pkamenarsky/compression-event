/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import { resolve } from 'path'

// Three pages off one server: /game.html, /editor.html and /bench.html.
// `pnpm build` emits all of them into dist/.
export default defineConfig({
  server: {
    host: true, // Expose to all network interfaces

    // 3000 by day; PORT lets a second server come up beside it rather than
    // fight it for the port
    port: Number(process.env.PORT) || 3000,
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      // A module cycle is not a style question here: when the two sides land
      // in different chunks, Rollup emits chunks that import each other, and
      // whichever is evaluated second reads the other's bindings while they
      // are still in the dead zone. That is a blank page at load, and neither
      // `tsc` nor the tests can see it, because neither bundles anything.
      // This is the only place it is visible, so it fails here rather than
      // warning. See the rule in CLAUDE.md for how to keep it quiet.
      onwarn(warning, warn) {
        if (warning.code === 'CIRCULAR_DEPENDENCY' || warning.code === 'CYCLIC_CROSS_CHUNK_REEXPORT') {
          throw new Error(`${warning.code}: ${warning.message}`);
        }

        warn(warning);
      },
      input: {
        game: resolve(__dirname, 'game.html'),
        editor: resolve(__dirname, 'editor.html'),
        bench: resolve(__dirname, 'bench.html'),
      },
    },
  },
  publicDir: 'public',
  test: {
    include: ['packages/*/src/**/*.test.ts'],
  },
})
