/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import { resolve } from 'path'

// Two pages off one server: /game.html and /editor.html. `pnpm build` emits
// both into dist/.
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
      input: {
        game: resolve(__dirname, 'game.html'),
        editor: resolve(__dirname, 'editor.html'),
      },
    },
  },
  publicDir: 'public',
  test: {
    include: ['packages/*/src/**/*.test.ts'],
  },
})
