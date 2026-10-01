---
'performance-helpers': patch
---

Three small gaps the ergonomics audit left open, all of them cases where the
library accepted something it should have made reachable or refused.

**`PowerSemaphore` exposes its gate's queue bound.** It built a `PowerPermitGate`
that could queue without limit and proxied neither the bound nor whether it had
been reached, so a caller using the class most people reach for could neither cap
the queue nor observe it filling. `queueCapacity` is now an accepted option, with
`get queueCapacity()` and `get isFull()` on the instance:

    const sem = new PowerSemaphore({ limit: 1, queueCapacity: 1 });
    // A third caller is refused with ERR_QUEUE_FULL and `queueCapacity: 1`
    // rather than queued forever behind a bound it cannot see.

**`PowerThrottle` and `PowerSlidingWindow` can be disposed.** These held clock
state and no teardown, so — unlike every other long-lived helper here — they
could not take part in `using` / `await using` or DI teardown. `PowerGCRA` already
had it.

Their `dispose()` is a **state reset, not a cancellation**: none of the three owns
a timer, each refilling lazily from a stored timestamp. A spent bucket is dropped
and recorded history cleared. The rule is now written into `AGENTS.md`, because the
split is not self-evident — for a stateless value type the absence of `dispose()`
is obviously right, so it reads as deliberate everywhere, including where it was
not.

**`Cache.startCleanup` accepts `{intervalMs}`.** It read only `.interval`, so
`intervalMs` — the spelling about fifteen other options in this library use, and
the one a caller reaching for the obvious name would write — was accepted and
silently dropped, in a method whose entire job is reading its options. The cleanup
then ran on the default interval the caller believed they had overridden. `interval`
wins when both are given.

Pinned in `test/powerSemaphore.test.js`, `test/limiterDispose.test.js` and
`test/powerCache.extra.test.js`. The limiter dispose is mutation-checked, and the
`using` test is a parse-time assertion — without the symbol that call site does
not compile, which is the gap being closed.
