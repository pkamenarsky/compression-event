/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import { resolve } from 'path'

// Two pages off one server: /game.html and /editor.html. `pnpm build` emits
// both into dist/.
export default defineConfig({
  server: {
    host: true, // Expose to all network interfaces
    port: 3000,
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
