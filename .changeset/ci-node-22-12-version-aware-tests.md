---
'performance-helpers': patch
---

Make the test suite pass on Node 22.12 again, without raising the declared floor.

CI runs `npm run test:coverage` on a `['22.12', '24']` matrix and was red on 22.12
with 13 failed suites. The failures were three environment/floor mismatches, not
library bugs, and each is now gated on a capability probe rather than skipped
outright:

- **`using` declarations (9 suites).** Node 22.12 has no `using` syntax, and
  rolldown 1.2.12 — the only transformer in the tree — passes `using` through
  verbatim rather than downlevelling it, so there is no tooling path. The 9
  suites (and 64 usages across 36 files) are rewritten as explicit
  `try { ... } finally { instance.dispose() }` blocks; the behaviour under test
  is identical, and each carries a comment saying why the scope exit is spelled
  out.
- **`Error.isError` cross-realm assertions (errors.realm, powerBulkhead.resetReason,
  powerLogger.isError).** The brand check is absent on 22.12, where the
  `instanceof` fallback is realm-unsafe and a cross-realm error surfaces with its
  class prefix. The assertions are gated with `it.runIf(HAS_IS_ERROR)`, the
  pattern `powerLogger.isError.test.js` already used; the realm-independent
  halves (the `instanceof` premise, `Object.keys` non-enumerability) stay ungated.
- **`PowerCrossLock`.** `node:worker_threads.locks` is absent on 22.12. The suite
  is now `describe.skipIf(!hasCrossWorkerLocks())`, with a separate ungated block
  pinning the `supported` flag and the "no cross-worker lock manager" residual.

Also corrected a false claim in `.github/workflows/ci.yml`: the comment said 22.12
was the floor "because the CommonJS entry point relies on `require(esm)`". It does
not — `dist/performance-helpers.cjs` contains no such call and loads cleanly on
22.12 with 81 exports. The library runs on 22.12; only the _tests_ use Node-24
features, and the comment now says so.

No behaviour change. Verified on both: Node 24 `npm run verify` 11/11 steps and
3012 tests; Node 22.12 `npm run test:coverage` 2977 passed / 35 skipped / 0 failed.
