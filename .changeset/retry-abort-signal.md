---
'performance-helpers': minor
---

**`PowerRetry.run` now takes a `signal`, and the wait between attempts is
interruptible.** `PowerRetry.run` previously could not be cancelled at all.

```javascript
const controller = new AbortController();
const run = PowerRetry.run(fetchFn, { signal: controller.signal });

controller.abort(); // rejects at once, even mid-backoff
```

`attemptTimeout` already bounded a slow _attempt_; nothing bounded a slow _gap_.
The backoff sleep was `await new Promise((r) => setTimeout(r, delay))`, so a
caller who abandoned a request still waited the delay out — up to `maxDelay`,
which is 30 s at the default. Measured: an abort during a 5000 ms backoff
rejects in **81 ms** instead of running to completion. A promise that settles 30 s
after everyone stopped listening is not a slow success, it is a leaked one.

Rejections carry `code: 'EABORT'` and the signal's `reason` — the same shape
`PowerDeadline` already uses, so one `err.code` check covers both helpers rather
than teaching a caller two conventions. An already-aborted signal rejects
**without running an attempt**, and an abort landing between attempts stops the
next one rather than buying it.

A `signal` passed to the constructor is a default for every `run` on that
instance, and is deliberately **not** stored in the reusable options:
`_options` is spread into every call and an `AbortSignal` is one-shot, so a
stored one would leave the instance holding an aborted signal after its first use
and make every later `run` reject for a reason the caller did not cause on that
call. Once aborted, later runs on that instance reject without doing work.

Minor rather than patch: it adds a published option, and `p-retry` and `p-limit`
both already take one, so this was a capability gap rather than a defect. With no
`signal` the sleep takes the original `setTimeout` path and allocates no listener.

11 tests, 4 mutants caught — including reverting the sleep to the uninterruptible
form, dropping the pre-attempt check, forgetting to remove the abort listener, and
storing the constructor `signal` in `_options`.
