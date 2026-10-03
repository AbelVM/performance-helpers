import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Build the UMD bundle once, before any test runs. Previously each of the
    // ten umd.bundle.*.test.js files shelled out to `npm run build` itself.
    globalSetup: ['./test/globalSetup.js'],
    // Seeds every fast-check property from one place and prints the seed, so a
    // property that fails in CI can be replayed exactly. Eleven files generate
    // properties and none of them pinned a seed, which is why a single
    // `PowerMessageCodec` round-trip failure could not be reproduced. See
    // test/setup/fastcheck.js.
    setupFiles: ['./test/setup/fastcheck.js'],
    exclude: ['node_modules/**', '.kilo/**', 'playwright/**', 'e2e/**'],
    coverage: {
      provider: 'v8',
      exclude: ['dist/**'],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 60,
      },
    },
  },
});
