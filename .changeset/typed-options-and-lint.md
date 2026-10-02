---
'performance-helpers': patch
---

Fix option and error types the published `.d.ts` was missing, and cut lint warnings 49 → 22.

A TypeScript consumer passing `stepUp`/`stepDown` to `autoScale`, `correlationId` to `postMessage`, or reading `completedTasks`/`protocol` off a `WorkerObj` was rejected by the shipped declarations, because the JSDoc typedefs omitted properties the code actually reads. Those typedefs now declare them, and `startCleanup` and `send` take the option shapes they document instead of a bare `{Object}` — the previous spelling was forced by a `TS8032` limitation that a spelled-out type expression removes rather than works around.

Also fixes `poolRefusal`'s error-code idiom: the `@type` annotation form declares the type rather than casting the initializer, so `const err = new Error(…)` annotated as `Error & {code}` was itself an error. The five sites that used it — including `poolRefusal`, which predates this change — were trading a `TS2339` for a `TS2322`. They now cast the initializer, matching `src/utils/errors.js`.

Lint: `no-unused-vars` in `bench/` and `examples/` is at zero. Four counters that existed only to hold a comment's premise are now assertions that hold it; `BENCH_AUTOSCALE_CACHE_KEYS`, documented in `bench/README.md`, was read but never consumed and is gone from both. Nine `require-atomic-updates` warnings in tests are fixed with `vi.stubGlobal`/`vi.spyOn`, which also stops a failed assertion from leaking a stubbed `Date.now` or a present-but-`undefined` `global.Buffer` into later tests.

No runtime behaviour changes.
