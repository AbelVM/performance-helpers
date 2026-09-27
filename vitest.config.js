import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Build the UMD bundle once, before any test runs. Previously each of the
    // ten umd.bundle.*.test.js files shelled out to `npm run build` itself.
    globalSetup: ['./test/globalSetup.js'],
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
