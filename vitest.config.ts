import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Tests start real worker processes; give them headroom on slow CI machines.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
