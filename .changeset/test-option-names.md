---
'performance-helpers': patch
---

test: four classes' tests were passing option names that do not exist

`PowerHistogram`, `PowerThrottle`, `PowerBulkhead` and `PowerCircuit` tests each
passed an option the constructor does not have — `buckets`, `limit`, `size` and
`resetTimeoutMs` respectively. Every one of those assertions passed, and every one
of them was asserting nothing: unknown options were ignored, so the helper
behaved exactly as it would with the option absent.

Some were worse than inert. Three calls passed **both** the real option and a
misspelling of it —

    new PowerThrottle({ capacity: 10, windowMs: 1000, capacity: 10 })

— where `windowMs` is a `PowerSlidingWindow` option. Reading that, the intent looks
unclear: was the test exercising a window, or a throttle with a redundant
capacity? The duplicate `capacity` is now gone and the cross-class `windowMs` with
it, and the assertions around it are unchanged.

This is the same defect class as the `refillInterval` row that shipped in
`guides/powerThrottle.md`, found from the other end: a guide documenting an option
the code does not have, and tests exercising options the code does not have. Both
were invisible because unknown keys were silently ignored.

Three more, in `test/disposal.test.js`, `test/invariants.test.js` and
`test/powerPool.uncovered.test.js`:

- `new PowerBackpressure({ highWaterMark: 2, lowWaterMark: 1, refillRate: 1 })` —
  two invalid names in one call. The source reads `lowWaterMark` and
  `refillAmount` (`powerBackpressure.js:77`); `highWaterMark` is a
  `PowerWebSocketClient` option and `refillRate` a `PowerThrottle` one. Since the
  test only needs a constructed resource-owner, the faithful translation is
  `capacity: 2` with the two real options.
- `{ maxSize: 10, maxWaitMs: 0 }` on `PowerBatch` — `maxWaitMs` is not an option
  at all, and the tests call `flush()` explicitly, so the key was doing nothing.
- `taskQueueEnabled: true` passed to `new PowerPool(...)` — the option is
  `taskQueue`; `taskQueueEnabled` is the public property it sets
  (`powerPool.js:478`). Assigning the property directly, which the same file does
  elsewhere, remains correct.

Found while attempting the corresponding strict-options change, which is not
included here. Every case found is now fixed; the strict-options change itself is
still to land, and is mechanical once these are.
