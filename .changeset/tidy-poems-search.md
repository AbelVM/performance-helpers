---
'performance-helpers': patch
---

Adds an injectable clock to `PowerTTLMap`, completing the set.

`PowerThrottle`, `PowerGCRA`, `PowerSlidingWindow` and `PowerRateLimit` have
accepted a `now` option since 2.0 (PERF-007). `PowerTTLMap` did not, and it is
the one helper where that matters most: expiry is the only behaviour it has
that cannot be observed synchronously, so testing it meant either sleeping and
racing the clock, or dropping the test.

```js
let clock = 0;
const m = new PowerTTLMap({ defaultTTL: 100, now: () => clock });
m.set('k', 1);
clock = 100;
m.get('k'); // 1  — alive AT its TTL
clock = 102;
m.get('k'); // undefined
```

That second boundary is the useful part, and it is a deliberate off-by-one: an
entry is stored as `expiresAt = now + ttl + 1` and read back as
`now > expiresAt`, so it survives exactly at its TTL and lapses immediately
after. `test/invariants.test.js` now pins all three positions, so a later
"simplification" of that `+ 1` fails loudly instead of quietly shortening every
entry by a millisecond.

Five invariants are restored that had to be dropped earlier precisely because
the helper had no clock — they would have needed a wall clock, which is the
flake TEST-008 exists to remove. That is now recorded as done in the plan.

Documentation only beyond the new option; no behaviour changes for existing
callers.
