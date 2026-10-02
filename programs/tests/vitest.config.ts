import { defineConfig } from 'vitest/config';

// Run from the repo root with `pnpm test:program`. The root vitest.config.ts does not
// include this folder: CI has no Solana toolchain until the program workflow exists.
export default defineConfig({
  test: {
    include: ['*.test.ts'],
    globalSetup: ['./global-setup.ts'],
    testTimeout: 30_000,
  },
});
