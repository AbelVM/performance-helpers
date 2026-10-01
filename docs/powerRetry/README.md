[**performance-helpers**](../README.md)

***

[performance-helpers](../README.md) / powerRetry

# powerRetry

PowerRetry — retry flaky async work with backoff, jitter, a retry budget,
and optional hedged attempts.

Three separate mechanisms live here, and they answer three different
questions:

1. **Backoff + jitter** — *how long to wait* between attempts. Naive
   `2^attempt * random()` still synchronises a fleet, because every client
   draws from the same range at the same moment. `backoff: 'decorrelated'`
   uses the AWS formulation, where each sleep is drawn against the *actual*
   previous sleep rather than a formula.
2. **A retry budget** — *whether to retry at all*. Without one, retries
   multiply load on a dependency that is already failing, which is the
   mechanism behind most retry storms. A budget is a token bucket: every
   request funds it, every retry spends from it.
3. **Hedged attempts** — *whether to attack the tail*. A hedge sends a
   second copy of the first request if the first has not returned in time.
   It raises average load and cuts p99, so it is opt-in.

## Classes

- [PowerRetry](classes/PowerRetry.md)
- [PowerRetryBudget](classes/PowerRetryBudget.md)

## References

### default

Renames and re-exports [PowerRetry](classes/PowerRetry.md)
