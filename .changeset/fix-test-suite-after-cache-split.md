---
'performance-helpers': patch
---

Fix the six test files that broke when `powerCache.js` was split into
`src/helpers/cache/`, and resolve a leftover stash conflict in
`powerRealtimeHub.js`.

- **`src/helpers/powerRealtimeHub.js`** — resolved the conflict markers left
  by a `git stash pop` in the `HubOptions` JSDoc, keeping the `RateLimiterLike`
  form that matches the runtime's `tryConsume(1, { context: { topic } })`.
  Corrected an inline comment that still said `{ key: topic }`.
- **`src/helpers/powerBroadcastBus.js`** — replaced the bare `// ignore
decode errors` catch with a real justification (a malformed ack must not
  abort the message loop; the pending entry's own timer fires and marks the
  receiver slow), satisfying GATE-001 without an allowlist entry.
- **Test fixes** — five tests hard-coded `powerCache.d.ts` /
  `src/helpers/powerCache.js` as the source of truth and did not account for
  the new `cache/` subdirectory. They now follow the re-export into
  `src/helpers/cache/` and `types/helpers/cache/`:
  - `test/docsCodeAgreement.test.js` — the per-guide loop reads the cache
    subdirectory when a helper's own source declares nothing.
  - `test/metrics.test.js` — the source sweep recurses into subdirectories,
    so `attach(this, 'cache'` in `cache/core.js` is found.
  - `test/optionsValidation.test.js` — `sourceFiles()` recurses into
    `src/helpers/cache/`.
  - `test/statsNaming.test.js` — `FILES` points at `cache/core.d.ts`,
    `cache/memoizer.d.ts` and `cache/timedCache.d.ts`.
  - `test/types.optionsCoverage.test.js` — the tripwire and the main loop
    recurse into `types/helpers/cache/`.
