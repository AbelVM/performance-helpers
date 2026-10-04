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
      // **The library, and only the library** (GATE-015).
      //
      // This used to list no `include`, so v8 reported every file it saw: the
      // benchmark harness (`bench/baseline.js`, 50.78 % lines), the dev scripts
      // (`scripts/review-row.mjs`, 38.77 %) and the test helper
      // (`test/helpers/umdBundle.js`) all sat inside the thresholds. So the
      // headline number was an average over code that is not shipped and is not
      // held to a threshold by anyone — "All files 89.15 %" said nothing about
      // the library, and a reader had no way to know that from the number.
      //
      // Narrowing the include makes the gate *easier*, not harder, which is why
      // it was safe to do without re-baselining the thresholds: nothing that
      // passes today stops passing. The thresholds are unchanged on purpose. They
      // are a floor, and raising them is a separate decision from measuring
      // honestly against them.
      include: ['src/**'],
      exclude: ['dist/**'],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 60,
      },
    },
    // **`WorkerAgnostic.js` lines 47-65 are uncovered, not excluded.** They call
    // `new Function` to load an ESM worker, which needs a real pure-ESM process,
    // and no amount of vitest coverage will collect them —
    // `vi.stubGlobal('require')` does not work because vitest injects `require`
    // into the module *scope*, not the global. `test/workerAgnostic.esm.test.js`
    // exercises the behaviour in a real subprocess instead.
    //
    // Recorded here because the next person will look for an exclusion in this
    // file, find none, and conclude the lines are untested rather than
    // untestable-in-this-runner. They are the former only in the sense that no
    // vitest assertion covers them; `AGENTS.md` documents the same split. Do not
    // "fix" the gap with `coverage.exclude` — that would delete the number
    // instead of explaining it.
  },
});
