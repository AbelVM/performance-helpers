[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/constants](../README.md) / DEFAULT\_IDEMPOTENCY\_SWEEP\_BATCH

# Variable: DEFAULT\_IDEMPOTENCY\_SWEEP\_BATCH

> `const` **DEFAULT\_IDEMPOTENCY\_SWEEP\_BATCH**: `32` = `32`

How many idempotency-ledger entries one post may examine while expiring.

The sweep runs on the post path, so its cost has to be bounded by something
other than the size of the ledger — an unbounded scan would make opting in
cost more the longer the process runs, which is the opposite of what the
option is for. A rotating pass over the keys means the ledger drains at a
bounded rate instead of never draining at all.

32 is roughly one cache line's worth of `Map` entries: large enough that a
busy pool clears its ledger in a few posts, small enough to stay invisible
against a `postMessage` that already encodes and transfers.
