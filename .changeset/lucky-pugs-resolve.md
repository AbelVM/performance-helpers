---
'performance-helpers': patch
---

Fixes `WorkerAgnostic` silently ignoring a bundle-relative worker path in the
browser.

**The symptom:** in a browser, `new WorkerAgnostic('./workers/task.js')` passed
the string straight to `new Worker(...)`, which the browser resolves against the
**document** base URL rather than the bundle that named it. The worker 404s as
soon as the app is served from a subpath — and a 404 from a worker constructor is
indistinguishable from a typo in the path, so the failure reads as your string
being wrong rather than as a resolution base being wrong.

**The cause:** `resolveWorker` had a fast path returning
`new GlobalWorker(workerSource, options)` for _any_ string source, placed above
the environment check. A browser always has a global `Worker`, so every string
source took that branch. The URL resolution below it —
`createWebWorkerFromString`, which prefers `document.currentScript.src` and falls
back to `location.href` — was therefore **dead code in a real browser**: present,
commented, and never executed by anything.

`browser` and `webworker` now go through that resolution. `node` and `unknown`
keep the fast path, which is what it is for: a runtime aliasing `worker_threads`
to `Worker` (the bench harness does) has no browser base URL to resolve against,
and routing it through the browser helper would look for a `document` that is not
there.

Also in this release:

- `test/WorkerAgnostic.browser.test.js` covers the path, including the two
  fallbacks (no `currentScript` → `location.href`; no base URL at all → the raw
  string) and the `new URL()` rejection fallback.
- `WorkerAgnostic.js` branch coverage 73.42% → **83.44%** (statements 77.3% →
  86.52%, lines 81.35% → 89.83%), closing TEST-003's `WorkerAgnostic` target.
  **The uncovered lines were not merely a metric — they were the only place this
  bug could be seen.** Lines 47–65 and 91 stay uncovered because they run only in
  pure ESM, where `require` is genuinely absent; vitest injects `require` into the
  module _scope_, so stubbing the global does not reach them (verified, not
  assumed). Their _behaviour_ is tested in a real ESM subprocess by
  `test/WorkerAgnostic.pureEsm.test.js`. Behaviour versus coverage is the
  distinction that matters here: one is a contract, the other is a number.
- `test/reviewTable.test.js` no longer asserts a tally of how many plan rows cite
  a section reference. `review.md` is gitignored, so the count describes nothing
  in CI (the suite skips) and had to be retuned in the same commit as every row
  that was closed. The stronger form — "every row cites a section" — is false:
  60 of 107 rows do not, and they are not malformed. A test whose expected value
  is "whatever the untracked file currently says" is not a test.
