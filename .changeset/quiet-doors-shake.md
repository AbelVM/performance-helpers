---
'performance-helpers': minor
---

Ten constructors now publish a real options type instead of a bare `Object`.

`PowerDeadline`, `PowerPermitGate`, `PowerBackpressure`, `PowerHistogram`,
`PowerScheduler`, `PowerSubscriberSet`, `PowerTTLMap`, `PowerRateLimit`,
`PowerMemoizer`/`PowerTimedCache` and `WorkerAgnostic` were typed as
`@param {Object} [options]`, so the published `.d.ts` checked nothing about what
you passed. They now accept named options types, and two errors surface:

- `PowerScheduler`'s options type omitted `scheduling: 'yield'`, which the
  constructor has always accepted. It is now declared.
- `PowerRateLimit`'s limiter parameter was emitted as a structural blob with
  every member and its comment repeated twice; it is now the named
  `RateLimiterLike`, and that type gained the optional `reset()` member the
  composer's `reset()` calls.

If you were passing an option these helpers do not read — `timeout` on
`PowerDeadline`, for instance, which bounds with `attemptTimeout` and
`totalTimeout` — that call is now a compile error. Nothing that worked
correctly changes: the new types only reject options that were being silently
ignored.
