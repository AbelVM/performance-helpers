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

Found while attempting the corresponding strict-options change, which is not
included here. Four of the nine cases are fixed in this patch; the remainder need
per-test judgement about what each was trying to exercise and are tracked
separately.
