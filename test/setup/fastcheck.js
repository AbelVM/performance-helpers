/**
 * Apply the run's fast-check seed to every property in this worker.
 *
 * The seed itself is chosen once per run in `test/globalSetup.js`, which also
 * prints it — a seed nobody can see is no use for reproducing a failure. This
 * file only applies it, because `configureGlobal` is per-process and vitest runs
 * the suite across several workers.
 *
 * `endOnFailure` stops at the first counterexample rather than pressing on, which
 * is what makes the announced seed point at *a* failing case. `verbose: 2` is
 * what has fast-check print the shrunk counterexample and the path to it.
 *
 * Replay a CI failure with:
 *
 *     FAST_CHECK_SEED=<n> npx vitest run test/powerMessageCodec.test.js
 */
import fc from 'fast-check';

const seed = Number(process.env.FAST_CHECK_SEED);

if (!Number.isFinite(seed))
  throw new Error(
    `fast-check seed is not a number: ${process.env.FAST_CHECK_SEED}. globalSetup.js sets it; if this ran without that, configureGlobal would silently fall back to a fresh random seed and the failure would be unreproducible again.`
  );

fc.configureGlobal({ seed, endOnFailure: true, verbose: 2 });
