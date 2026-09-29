---
'performance-helpers': patch
---

Adds runnable examples, one per helper family.

`examples/` contains nine short scripts — cache, ratelimit, resilience, pool,
batch, backpressure, observability, realtime, codec — plus a runner:

```sh
npm run example              # list them
npm run example cache        # run one
npm run example -- --all     # run every one
```

They are executed by `test/examples.test.js` on every `npm test`, so they
cannot drift from the API. This is the point: every example in the directory
was wrong the first time it ran, and none of the mistakes were visible by
reading the code. Three library traps are now documented where a reader meets
them:

- A Node ESM worker silently ignores `self.onmessage` — and
  `globalThis.onmessage`. Nothing throws; the handler is simply never called
  and every reply times out. Use `parentPort`.
- `PowerPool` accepts a worker factory or a string, not a `URL` object, while
  Node's `Worker` rejects a `file://` string. Only an absolute path satisfies
  both.
- With `batch: true` (the default) `PowerRealtimeHub` delivers **an array** of
  messages per frame. A client expecting one message per frame reads
  `undefined` from every field, which looks like a slow-consumer problem and
  is not one.

One deliberate behaviour worth knowing, which the examples show rather than
hide: the library `unref()`s its timers, so neither `PowerBackpressure`'s
refill nor `PowerRealtimeHub`'s flush will hold a Node process open. That is
right for a library — a rate limiter should not keep a finished CLI alive — but
it means a script whose only remaining work is a pending refill will exit
instead of waiting.

Documentation only. No API change.
