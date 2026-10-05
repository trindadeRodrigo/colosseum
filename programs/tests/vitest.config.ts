import { defineConfig } from 'vitest/config';

// Run from the repo root with `pnpm test:program`. The root vitest.config.ts does not
// include this folder: it needs the Solana toolchain, which only .github/workflows/program.yml installs.
export default defineConfig({
  test: {
    include: ['*.test.ts'],
    globalSetup: ['./global-setup.ts'],
    testTimeout: 30_000,
  },
});
