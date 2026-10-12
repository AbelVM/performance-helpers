---
'performance-helpers': patch
---

### Added

`PowerPool.close({ force, timeout })` — graceful shutdown as a single entry point.

```js
await pool.close(); // wait for in-flight work, then terminate
await pool.close({ timeout: 5000 }); // wait at most 5 s, then terminate anyway
await pool.close({ force: true }); // terminate now, abandoning the work
```

The `shutdown()` / `drain()` / `[Symbol.asyncDispose]` model is defensible and stays
exactly as it is — this composes it rather than replacing it. What it adds is the one
call a caller reaching for "shut this down properly" actually wants, which is _both_
halves in the right order. Getting the order wrong is the failure this prevents:
`shutdown()` alone abandons in-flight work, and `drain()` alone leaves the workers
running — and the result is silent, because the pool looks closed and the last few
tasks are gone.

Three things to know:

- **`force` and `timeout` are mutually exclusive.** A forced close has nothing to wait
  for, so passing both is a contradiction rather than a precedence rule, and it throws
  a `TypeError` rather than silently preferring one.
- **A drain that cannot finish does not block the close.** A timeout, an abort or too
  many waiters is logged and the pool terminates anyway — a close that refuses to
  finish because the drain timed out is worse than one that terminates.
- **It resolves with the final `getStats()` snapshot**, the same shape `drain()`
  resolves with, so a caller can log the closing state without a second call.
