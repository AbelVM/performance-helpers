[**performance-helpers**](../README.md)

---

[performance-helpers](../README.md) / powerGCRA

# powerGCRA

Generic Cell Rate Algorithm (GCRA) rate limiter.

GCRA is the cell-based scheduler recommended by the ATM Forum and shipped by
`golang.org/x/time/rate`, Redis's `redis-cell` module and the `redis-gcra`
Node port. It shapes traffic identically to a token bucket but keeps its
entire state in **one integer** - the theoretical arrival time (TAT) - so it
is O(1) per call with no accumulator and no rounding drift.

```
// on accept:
tat = max(now, tat) + emissionInterval
accept  iff  now >= tat - delayVariation      (i.e. tat <= now + burst)
retryAfter = (tat - burst) - now              exact, not an estimate
```

The exact `retryAfter()` is the practical win over PowerThrottle: a
caller can hand it straight to `retryAfter`/`retry-After` instead of
guessing, and it composes cleanly with `PowerDeadline` and `PowerRetry`.

This module is **additive** - it does not replace or change
`PowerThrottle`, whose token accounting remains the default elsewhere.

## Classes

- [PowerGCRA](classes/PowerGCRA.md)

## Interfaces

- [PowerGCRAOptions](interfaces/PowerGCRAOptions.md)

## References

### default

Renames and re-exports [PowerGCRA](classes/PowerGCRA.md)
