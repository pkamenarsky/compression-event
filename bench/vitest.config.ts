/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// Its own config so that `pnpm test` does not pick these up: they take a minute
// and they measure rather than assert.
export default defineConfig({
  test: {
    include: ['bench/**/*.bench.ts'],
    testTimeout: 1_200_000,
  },
});
